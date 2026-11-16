import { describe, test, expect } from "bun:test";
import { drain } from "./helpers";
import {
    azureStore,
    ObjectNotFoundError,
    ObjectChangedError,
    StoreUnavailableError,
    type AzureStoreOptions,
} from "../azure";

// ─── Mock Azure Container Client ────────────────────────────────────────────

const CONTENT = Buffer.from("0123456789abcdefghij"); // 20 bytes
const LAST_MODIFIED = new Date("2025-06-28T12:00:00Z");
const ETAG = '"0x8DAZURE"';

/**
 * The container-client surface the adapter consumes, and the SAS option bag it
 * signs with, both read off the adapter's own option type. Deriving them binds
 * the double to the contract: a change to either shape fails this file at
 * compile time instead of leaving the mock satisfying a contract nobody has.
 */
type AzureContainerClient = AzureStoreOptions["containerClient"];
type AzureSasOptions = Parameters<ReturnType<AzureContainerClient["getBlobClient"]>["generateSasUrl"]>[0];

interface MockAzureOpts {
    missing?: boolean;
    /** Reject download with a 412 (ifMatch condition failed). */
    conditionFails?: boolean;
    /** Record download calls. */
    calls?: Array<{ offset?: number; count?: number; ifMatch?: string }>;
    /** Omit contentLength from responses (degenerate SDK response). */
    noLength?: boolean;
    /** Return a garbage contentRange string on ranged downloads. */
    badContentRange?: boolean;
    /** Browser environment: body arrives as blobBody, not readableStreamBody. */
    blobBody?: boolean;
    /** Response with neither readableStreamBody nor blobBody. */
    noBody?: boolean;
    /** Throw a 503 ServerBusy throttle on getProperties / download. */
    throttled?: boolean;
    /** Throw a plain Error (no statusCode, not a RestError) on both operations. */
    genericError?: boolean;
    /** Reject download with a RestError carrying 412 in the message but NO statusCode. */
    conditionFailsNoStatus?: boolean;
    /** Throw a 503 ServerBusy whose message text also contains "412" (collision bait). */
    throttledMessage412?: boolean;
    /** Throw a 503 ServerBusy carrying a Retry-After: 30 response header. */
    throttledRetryAfter?: boolean;
    /** Throw an OperationTimedOut RestError (HTTP 500 + code), a retryable transient. */
    opTimedOut?: boolean;
    /** Invoked when the download's readableStreamBody is destroyed. */
    onDestroy?: () => void;
    /** Record generateSasUrl option objects. */
    sasCalls?: AzureSasOptions[];
    /** generateSasUrl throws (client not constructed with a shared-key credential). */
    sasError?: Error;
    /** Runs inside generateSasUrl, before it answers. */
    onSign?: () => void;
    /** Counts getBlobClient calls: no SDK client is built for a refused key. */
    clientRequests?: { count: number };
    /** The abortSignal each getProperties / download call received. */
    signals?: { props: Array<AbortSignal | undefined>; download: Array<AbortSignal | undefined> };
    /** Throw this exact value from both getProperties and download. */
    throwError?: unknown;
    /** Advertise the full length but end the body one byte early (a graceful short read). */
    shortBody?: boolean;
    /** The stored Content-Encoding the download reports. */
    contentEncoding?: string;
    /** A download body stream without a destroy() method. */
    noDestroy?: boolean;
}

/** The SDK's refusal when the client holds no shared-key credential. */
const NO_SHARED_KEY = "Can only generate the SAS when the client is initialized with a shared key credential";

function restError(statusCode: number): Error {
    const err = new Error(`azure rest error ${statusCode}`);
    err.name = "RestError";
    (err as unknown as { statusCode: number }).statusCode = statusCode;
    return err;
}

/** A RestError with a status only in the message (no numeric statusCode field). */
function restErrorMessageOnly(message: string): Error {
    const err = new Error(message);
    err.name = "RestError";
    return err;
}

/** A RestError with a numeric statusCode, a custom message, and optional Retry-After header. */
function restErrorWith(statusCode: number, message: string, retryAfter?: string): Error {
    const err = new Error(message);
    err.name = "RestError";
    (err as unknown as { statusCode: number }).statusCode = statusCode;
    if (retryAfter !== undefined) {
        (err as unknown as { response: { headers: { get(n: string): string | undefined } } }).response = {
            headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter : undefined) },
        };
    }
    return err;
}

/** A RestError carrying an `x-ms-error-code` (the `.code` property) with its real HTTP status. */
function restErrorWithCode(statusCode: number, code: string): Error {
    const err = new Error(`azure rest error ${code}`);
    err.name = "RestError";
    (err as unknown as { statusCode: number; code: string }).statusCode = statusCode;
    (err as unknown as { code: string }).code = code;
    return err;
}

async function* iterate(buf: Buffer): AsyncGenerator<Buffer> {
    yield buf;
}

/** Throws `value` untouched: the throttle classifier is tested against thrown values that are not Errors. */
function throwRaw(value: unknown): never {
    // oxlint-disable-next-line typescript/only-throw-error -- a non-Error throw is the subject of the classification tests
    throw value;
}

function mockContainer(opts: MockAzureOpts = {}): AzureContainerClient {
    return {
        getBlobClient(_name: string) {
            if (opts.clientRequests) opts.clientRequests.count += 1;
            return {
                async getProperties(options?: { abortSignal?: AbortSignal }) {
                    opts.signals?.props.push(options?.abortSignal);
                    if (opts.throwError !== undefined) throwRaw(opts.throwError);
                    if (opts.missing) throw restError(404);
                    if (opts.throttled) throw restError(503);
                    if (opts.throttledMessage412) throw restErrorWith(503, "ServerBusy req-id 41200-2b3c ...");
                    if (opts.throttledRetryAfter) throw restErrorWith(503, "ServerBusy", "30");
                    if (opts.opTimedOut) throw restErrorWithCode(500, "OperationTimedOut");
                    if (opts.genericError) throw new Error("azure generic failure");
                    return {
                        contentLength: opts.noLength ? undefined : CONTENT.length,
                        etag: ETAG,
                        lastModified: LAST_MODIFIED,
                    };
                },
                async download(
                    offset?: number,
                    count?: number,
                    options?: { conditions?: { ifMatch?: string }; abortSignal?: AbortSignal },
                ) {
                    opts.calls?.push({ offset, count, ifMatch: options?.conditions?.ifMatch });
                    opts.signals?.download.push(options?.abortSignal);
                    if (opts.throwError !== undefined) throwRaw(opts.throwError);
                    if (opts.missing) throw restError(404);
                    if (opts.throttled) throw restError(503);
                    if (opts.genericError) throw new Error("azure generic failure");
                    if (opts.conditionFails && options?.conditions?.ifMatch) throw restError(412);
                    if (opts.conditionFailsNoStatus && options?.conditions?.ifMatch) {
                        throw restErrorMessageOnly(
                            "The condition specified using HTTP conditional header(s) is not met: ConditionNotMet",
                        );
                    }

                    // Azure answers 206 + Content-Range for ANY ranged download,
                    // including offset-only (open-ended) reads.
                    const isRanged = count !== undefined || (offset !== undefined && offset > 0);
                    const end =
                        count !== undefined ? Math.min(offset! + count - 1, CONTENT.length - 1) : CONTENT.length - 1;
                    const slice = CONTENT.subarray(offset ?? 0, end + 1);
                    const served = opts.shortBody ? slice.subarray(0, slice.length - 1) : slice;
                    const nodeStream = Object.assign(
                        iterate(Buffer.from(served)),
                        opts.noDestroy
                            ? {}
                            : {
                                  destroy() {
                                      opts.onDestroy?.();
                                  },
                              },
                    );
                    return {
                        readableStreamBody:
                            opts.blobBody || opts.noBody
                                ? undefined
                                : (nodeStream as unknown as NodeJS.ReadableStream & AsyncIterable<Buffer>),
                        blobBody: opts.blobBody ? Promise.resolve(new Blob([Uint8Array.from(served)])) : undefined,
                        contentLength: opts.noLength ? undefined : slice.length,
                        contentRange: isRanged
                            ? opts.badContentRange
                                ? "bytes garbage"
                                : `bytes ${offset}-${end}/${CONTENT.length}`
                            : undefined,
                        contentEncoding: opts.contentEncoding,
                        etag: ETAG,
                        lastModified: LAST_MODIFIED,
                    };
                },
                async generateSasUrl(options: AzureSasOptions) {
                    opts.sasCalls?.push(options);
                    opts.onSign?.();
                    if (opts.sasError) throw opts.sasError;
                    return "https://account.blob.example/documents/doc.pdf?sv=2025&sig=abc";
                },
            };
        },
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("azureStore: headObject", () => {
    test("declares that its reads are pinned to the validated version", () => {
        // download() sends conditions.ifMatch, so the orchestrator may skip its own pinning.
        expect(azureStore({ containerClient: mockContainer() }).pinsReads).toBe(true);
    });

    test("maps blob properties to ObjectMetadata", async () => {
        const store = azureStore({ containerClient: mockContainer() });
        const meta = await store.headObject("doc.pdf");

        expect(meta.contentLength).toBe(20);
        expect(meta.etag).toBe(ETAG);
        expect(meta.lastModified).toBe(LAST_MODIFIED.toUTCString());
    });

    test("throws ObjectNotFoundError on 404", async () => {
        const store = azureStore({ containerClient: mockContainer({ missing: true }) });
        await expect(store.headObject("gone.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("503 ServerBusy maps to StoreUnavailableError (retryable, not 502)", async () => {
        const store = azureStore({ containerClient: mockContainer({ throttled: true }) });
        await expect(store.headObject("busy.pdf")).rejects.toBeInstanceOf(StoreUnavailableError);
    });

    test("503 whose message contains '412' is still a throttle, never ObjectChangedError", async () => {
        // A numeric statusCode is authoritative: the 412 message substring must
        // not fall through and misclassify a throttle as a precondition failure.
        const store = azureStore({ containerClient: mockContainer({ throttledMessage412: true }) });
        await expect(store.headObject("busy.pdf")).rejects.toBeInstanceOf(StoreUnavailableError);
    });

    test("OperationTimedOut (HTTP 500) is a retryable transient, not a 502", async () => {
        // Azure's OperationTimedOut carries statusCode 500, so a numeric-status-
        // first rule would demote it to a non-retryable 502. It must classify by
        // code as a throttle -> StoreUnavailableError (503).
        const store = azureStore({ containerClient: mockContainer({ opTimedOut: true }) });
        await expect(store.headObject("slow.pdf")).rejects.toBeInstanceOf(StoreUnavailableError);
    });

    test("throttle surfaces the backend's Retry-After as retryAfterSeconds", async () => {
        const store = azureStore({ containerClient: mockContainer({ throttledRetryAfter: true }) });
        try {
            await store.headObject("busy.pdf");
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(StoreUnavailableError);
            expect((err as StoreUnavailableError).retryAfterSeconds).toBe(30);
        }
    });

    test("an unclassified error is never masked as throttled/not-found/changed", async () => {
        // A plain Error (no statusCode, not a RestError) reaches the terminal
        // `return false` of every classifier; it must propagate untouched.
        const store = azureStore({ containerClient: mockContainer({ genericError: true }) });
        await expect(store.headObject("doc.pdf")).rejects.toThrow("azure generic failure");
        await expect(store.getObject("doc.pdf")).rejects.toThrow("azure generic failure");
    });
});

describe("azureStore: getObject (single round trip)", () => {
    test("full download: contentLength IS the total, no getProperties needed", async () => {
        const calls: Array<{ offset?: number; count?: number }> = [];
        const store = azureStore({ containerClient: mockContainer({ calls }) });
        const result = await store.getObject("doc.pdf");

        expect(await drain(result.body)).toBe("0123456789abcdefghij");
        expect(result.totalSize).toBe(20);
        expect(result.contentLength).toBe(20);
        expect(result.range).toBeUndefined();
        expect(calls).toHaveLength(1); // exactly one backend call
    });

    test("ranged download: total size parsed from the response Content-Range", async () => {
        const store = azureStore({ containerClient: mockContainer() });
        const result = await store.getObject("doc.pdf", { range: { start: 5, end: 9 } });

        expect(await drain(result.body)).toBe("56789");
        expect(result.range).toEqual({ start: 5, end: 9 });
        expect(result.totalSize).toBe(20);
        expect(result.contentLength).toBe(5);
    });

    test("ifMatch is forwarded as an Azure access condition", async () => {
        const calls: Array<{ ifMatch?: string }> = [];
        const store = azureStore({ containerClient: mockContainer({ calls }) });
        await store.getObject("doc.pdf", { ifMatch: ETAG });

        expect(calls[0]?.ifMatch).toBe(ETAG);
    });

    test("412 ConditionNotMet maps to ObjectChangedError", async () => {
        const store = azureStore({ containerClient: mockContainer({ conditionFails: true }) });
        await expect(store.getObject("doc.pdf", { ifMatch: ETAG })).rejects.toBeInstanceOf(ObjectChangedError);
    });

    test("412 with no numeric statusCode (message-only RestError) still maps to ObjectChangedError", async () => {
        const store = azureStore({ containerClient: mockContainer({ conditionFailsNoStatus: true }) });
        await expect(store.getObject("doc.pdf", { ifMatch: ETAG })).rejects.toBeInstanceOf(ObjectChangedError);
    });

    test("throws ObjectNotFoundError on 404", async () => {
        const store = azureStore({ containerClient: mockContainer({ missing: true }) });
        await expect(store.getObject("gone.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });
});

describe("azureStore: degenerate SDK responses", () => {
    test("headObject with no contentLength fails loudly", async () => {
        const store = azureStore({ containerClient: mockContainer({ noLength: true }) });
        await expect(store.headObject("doc.pdf")).rejects.toThrow(/no contentLength/);
    });

    test("getObject with no contentLength fails loudly", async () => {
        const store = azureStore({ containerClient: mockContainer({ noLength: true }) });
        await expect(store.getObject("doc.pdf")).rejects.toThrow(/no contentLength/);
    });

    test("unparseable Content-Range fails loudly (byte accounting untrustworthy)", async () => {
        const store = azureStore({ containerClient: mockContainer({ badContentRange: true }) });
        await expect(store.getObject("doc.pdf", { range: { start: 5, end: 9 } })).rejects.toThrow(
            /unparseable Content-Range/,
        );
    });

    test("unparseable Content-Range destroys the live download socket before throwing", async () => {
        let destroyed = false;
        const store = azureStore({
            containerClient: mockContainer({
                badContentRange: true,
                onDestroy: () => {
                    destroyed = true;
                },
            }),
        });
        await expect(store.getObject("doc.pdf", { range: { start: 5, end: 9 } })).rejects.toThrow(
            /unparseable Content-Range/,
        );
        expect(destroyed).toBe(true);
    });

    test("missing contentLength on download destroys the live socket before throwing", async () => {
        let destroyed = false;
        const store = azureStore({
            containerClient: mockContainer({
                noLength: true,
                onDestroy: () => {
                    destroyed = true;
                },
            }),
        });
        await expect(store.getObject("doc.pdf")).rejects.toThrow(/no contentLength/);
        expect(destroyed).toBe(true);
    });

    test("browser environment: blobBody is converted to a web stream", async () => {
        const store = azureStore({ containerClient: mockContainer({ blobBody: true }) });
        const result = await store.getObject("doc.pdf", { range: { start: 5, end: 9 } });

        expect(await drain(result.body)).toBe("56789");
        expect(result.range).toEqual({ start: 5, end: 9 });
    });

    test("response with no body at all fails loudly", async () => {
        const store = azureStore({ containerClient: mockContainer({ noBody: true }) });
        await expect(store.getObject("doc.pdf")).rejects.toThrow(/no body/);
    });
});

describe("azureStore: createSignedUrl", () => {
    test("returns ok with a SAS URL: read-only permissions and a sanitized disposition", async () => {
        const sasCalls: AzureSasOptions[] = [];
        const store = azureStore({ containerClient: mockContainer({ sasCalls }) });

        const result = await store.createSignedUrl!("doc.pdf", {
            expiresInSeconds: 120,
            downloadFilename: "Quarterly Report.pdf",
        });

        expect(result).toEqual({
            ok: true,
            url: "https://account.blob.example/documents/doc.pdf?sv=2025&sig=abc",
        });
        // A signed download URL must never grant write/delete: the permission
        // set stringifies to exactly "r" for the SDK's parse-validate step.
        expect(String(sasCalls[0]?.permissions)).toBe("r");
        expect(String(sasCalls[0]?.contentDisposition)).toContain("attachment");
        expect(String(sasCalls[0]?.contentDisposition)).toContain("Quarterly Report.pdf");
        // Inert content type prevents an inline polyglot rendering off the redirect target.
        expect(sasCalls[0]?.contentType).toBe("application/octet-stream");
    });

    test("forces attachment + inert content type even without a downloadFilename", async () => {
        const sasCalls: AzureSasOptions[] = [];
        const store = azureStore({ containerClient: mockContainer({ sasCalls }) });

        const result = await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 });

        expect(result.ok).toBe(true);
        expect(sasCalls[0]?.contentType).toBe("application/octet-stream");
        expect(String(sasCalls[0]?.contentDisposition)).toContain("attachment");
    });

    test("a hostile filename never reaches the SAS disposition unsanitized", async () => {
        const sasCalls: AzureSasOptions[] = [];
        const store = azureStore({ containerClient: mockContainer({ sasCalls }) });

        await store.createSignedUrl!("doc.pdf", {
            expiresInSeconds: 60,
            downloadFilename: 'evil\r\nContent-Type: text/html;.."\\..pdf',
        });

        const disposition = String(sasCalls[0]?.contentDisposition);
        expect(disposition).not.toMatch(/[\r\n]/);
        expect(disposition).toContain("attachment");
    });

    test("expiresOn is expiresInSeconds from now", async () => {
        const sasCalls: AzureSasOptions[] = [];
        const store = azureStore({ containerClient: mockContainer({ sasCalls }) });

        const before = Date.now();
        await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 120 });
        const after = Date.now();

        const expiresOn = sasCalls[0]?.expiresOn as Date;
        expect(expiresOn).toBeInstanceOf(Date);
        expect(expiresOn.getTime()).toBeGreaterThanOrEqual(before + 120_000);
        expect(expiresOn.getTime()).toBeLessThanOrEqual(after + 120_000);
    });

    test("cacheControl override rides the SAS, absent when unset", async () => {
        const sasCalls: AzureSasOptions[] = [];
        const store = azureStore({ containerClient: mockContainer({ sasCalls }) });

        await store.createSignedUrl!("doc.pdf", {
            expiresInSeconds: 60,
            cacheControl: "private, no-cache",
        });
        expect(sasCalls[0]?.cacheControl).toBe("private, no-cache");

        await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 });
        expect("cacheControl" in (sasCalls[1] ?? {})).toBe(false);
    });

    test("a client without a shared-key credential declines with ok: false and the SDK's error as cause", async () => {
        // Declining means "this store cannot sign here": the caller streams instead.
        const sasError = new RangeError(NO_SHARED_KEY);
        const store = azureStore({ containerClient: mockContainer({ sasError }) });

        const result = await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 });
        expect(result).toMatchObject({ ok: false, code: "no-credential", error: NO_SHARED_KEY });
        expect("cause" in result && result.cause).toBe(sasError);
    });

    test("a signer failure on a client that can sign throws, never declines", async () => {
        const store = azureStore({ containerClient: mockContainer({ sasError: new Error("key vault unreachable") }) });
        await expect(store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 })).rejects.toThrow(
            "key vault unreachable",
        );
    });

    test("a RangeError other than the missing-credential refusal throws", async () => {
        const store = azureStore({
            containerClient: mockContainer({ sasError: new RangeError("Must provide 'permissions' and 'expiresOn'") }),
        });
        await expect(store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 })).rejects.toBeInstanceOf(RangeError);
    });

    test("a RangeError whose message is not a string throws, even one that stringifies to the refusal", async () => {
        const sasError = new RangeError();
        Object.defineProperty(sasError, "message", { value: { toString: () => NO_SHARED_KEY } });
        const store = azureStore({ containerClient: mockContainer({ sasError }) });
        await expect(store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 })).rejects.toBe(sasError);
    });

    test("an aborted signal rejects with its reason before anything is signed", async () => {
        const sasCalls: AzureSasOptions[] = [];
        const store = azureStore({ containerClient: mockContainer({ sasCalls }) });
        const reason = new Error("client went away");

        const signOpts = { expiresInSeconds: 60, signal: AbortSignal.abort(reason) };

        await expect(store.createSignedUrl!("doc.pdf", signOpts)).rejects.toBe(reason);
        expect(sasCalls).toHaveLength(0);
    });

    test("an abort while signing rejects with its reason, never a URL", async () => {
        const controller = new AbortController();
        const reason = new Error("client went away");
        const store = azureStore({ containerClient: mockContainer({ onSign: () => controller.abort(reason) }) });

        const signOpts = { expiresInSeconds: 60, signal: controller.signal };

        await expect(store.createSignedUrl!("doc.pdf", signOpts)).rejects.toBe(reason);
    });
});

describe("azureStore: open range wire translation", () => {
    test("an open-ended range downloads with offset and NO count", async () => {
        const calls: Array<{ offset?: number; count?: number; ifMatch?: string }> = [];
        const store = azureStore({ containerClient: mockContainer({ calls }) });

        const result = await store.getObject("test.bin", { range: { start: 5, end: undefined } });

        // An open range MUST NOT surface as a count.
        expect(calls[0]?.offset).toBe(5);
        expect(calls[0]?.count).toBeUndefined();
        expect(result.range).toEqual({ start: 5, end: 19 });
        expect(result.contentLength).toBe(15);
    });
});

describe("azureStore: capability flags", () => {
    test("advertises range support and authoritative 206 bounds", () => {
        const store = azureStore({ containerClient: mockContainer() });
        expect(store.supportsRange).toBe(true);
        expect(store.authoritativeRange).toBe(true);
    });
});

describe("azureStore: reserved keys and key policy", () => {
    const RESERVED = ".partial-content-uploads/in-flight/abc";

    test("every read refuses a key under the default reserved prefix before the SDK is touched", async () => {
        const clientRequests = { count: 0 };
        const store = azureStore({ containerClient: mockContainer({ clientRequests }) });

        await expect(store.headObject(RESERVED)).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject(RESERVED)).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject(RESERVED, { range: { start: 0, end: 3 } })).rejects.toBeInstanceOf(
            ObjectNotFoundError,
        );
        await expect(store.createSignedUrl!(RESERVED, { expiresInSeconds: 60 })).rejects.toBeInstanceOf(
            ObjectNotFoundError,
        );
        expect(clientRequests.count).toBe(0);
    });

    test("the reserved prefix's bare name is refused too", async () => {
        const clientRequests = { count: 0 };
        const store = azureStore({ containerClient: mockContainer({ clientRequests }) });
        await expect(store.headObject(".partial-content-uploads")).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(clientRequests.count).toBe(0);
    });

    test("a signed URL is never minted for a reserved key", async () => {
        const sasCalls: AzureSasOptions[] = [];
        const store = azureStore({ containerClient: mockContainer({ sasCalls }) });
        await expect(store.createSignedUrl!(RESERVED, { expiresInSeconds: 60 })).rejects.toBeInstanceOf(
            ObjectNotFoundError,
        );
        expect(sasCalls).toHaveLength(0);
    });

    test("reservedPrefix: '' reserves nothing", async () => {
        const clientRequests = { count: 0 };
        const store = azureStore({ containerClient: mockContainer({ clientRequests }), reservedPrefix: "" });

        expect((await store.headObject(RESERVED)).contentLength).toBe(20);
        expect((await store.getObject(RESERVED)).contentLength).toBe(20);
        expect(clientRequests.count).toBe(2);
    });

    test("a caller-supplied reservedPrefix replaces the default", async () => {
        const store = azureStore({ containerClient: mockContainer(), reservedPrefix: ["private/"] });

        await expect(store.headObject("private/a.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect((await store.headObject(RESERVED)).contentLength).toBe(20);
    });

    test("the default key policy refuses an empty or dot segment before the SDK is touched", async () => {
        const clientRequests = { count: 0 };
        const store = azureStore({ containerClient: mockContainer({ clientRequests }) });

        for (const key of ["a//b", "a/./b", "a/../b"]) {
            await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
        expect(clientRequests.count).toBe(0);
    });

    test("keys: 'verbatim' passes an empty segment through to the SDK", async () => {
        const clientRequests = { count: 0 };
        const store = azureStore({ containerClient: mockContainer({ clientRequests }), keys: "verbatim" });

        expect((await store.headObject("a//b")).contentLength).toBe(20);
        expect(clientRequests.count).toBe(1);
    });

    test("keys: 'verbatim' still refuses a dot segment, the SDK would resolve it", async () => {
        const clientRequests = { count: 0 };
        const store = azureStore({ containerClient: mockContainer({ clientRequests }), keys: "verbatim" });

        for (const key of ["../private/x.pdf", "a/../.partial-content-uploads/x", "a/./b"]) {
            await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
        expect(clientRequests.count).toBe(0);
    });

    test("keys: 'verbatim' still honours the reserved prefix", async () => {
        const store = azureStore({ containerClient: mockContainer(), keys: "verbatim" });
        await expect(store.headObject(RESERVED)).rejects.toBeInstanceOf(ObjectNotFoundError);
    });
});

describe("azureStore: abort signal forwarding", () => {
    const newSignals = () => ({
        props: [] as Array<AbortSignal | undefined>,
        download: [] as Array<AbortSignal | undefined>,
    });

    test("headObject without a signal option still reads", async () => {
        const store = azureStore({ containerClient: mockContainer() });
        expect((await store.headObject("doc.pdf", {})).contentLength).toBe(20);
    });

    test("headObject rejects with the reason of an already-aborted signal", async () => {
        const reason = new Error("client went away");
        const clientRequests = { count: 0 };
        const store = azureStore({ containerClient: mockContainer({ clientRequests }) });
        await expect(store.headObject("doc.pdf", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
        expect(clientRequests.count).toBe(0);
    });

    test("headObject hands its signal to getProperties", async () => {
        const signals = newSignals();
        const store = azureStore({ containerClient: mockContainer({ signals }) });
        const controller = new AbortController();
        await store.headObject("doc.pdf", { signal: controller.signal });
        expect(signals.props).toEqual([controller.signal]);
    });

    test("getObject hands its signal to download", async () => {
        const signals = newSignals();
        const store = azureStore({ containerClient: mockContainer({ signals }) });
        const controller = new AbortController();
        await store.getObject("doc.pdf", { signal: controller.signal });
        expect(signals.download).toEqual([controller.signal]);
    });

    test("aborting after getObject resolves destroys the live body stream", async () => {
        let destroyed = 0;
        const store = azureStore({
            containerClient: mockContainer({
                onDestroy: () => {
                    destroyed += 1;
                },
            }),
        });
        const controller = new AbortController();
        await store.getObject("doc.pdf", { signal: controller.signal });
        expect(destroyed).toBe(0);
        controller.abort();
        expect(destroyed).toBe(1);
    });
});

describe("azureStore: body length accounting", () => {
    test("a body that ends short of the committed length fails the read", async () => {
        const store = azureStore({ containerClient: mockContainer({ shortBody: true }) });
        const result = await store.getObject("doc.pdf");
        await expect(drain(result.body)).rejects.toThrow(/bytes/);
    });

    test("a buffered body that ends short of the committed length fails the read", async () => {
        const store = azureStore({ containerClient: mockContainer({ blobBody: true, shortBody: true }) });
        const result = await store.getObject("doc.pdf");
        await expect(drain(result.body)).rejects.toThrow(/bytes/);
    });
});

describe("azureStore: release of a degenerate download", () => {
    test("a stream without destroy() is tolerated when the length is missing", async () => {
        const store = azureStore({ containerClient: mockContainer({ noLength: true, noDestroy: true }) });
        await expect(store.getObject("doc.pdf")).rejects.toThrow(/no contentLength/);
    });

    test("a buffered response has nothing to destroy when the length is missing", async () => {
        const store = azureStore({ containerClient: mockContainer({ noLength: true, blobBody: true }) });
        await expect(store.getObject("doc.pdf")).rejects.toThrow(/no contentLength/);
    });

    test("a corrupt stored Content-Encoding destroys the live socket and fails the read", async () => {
        let destroyed = false;
        const store = azureStore({
            containerClient: mockContainer({
                contentEncoding: "not-a-coding",
                onDestroy: () => {
                    destroyed = true;
                },
            }),
        });
        await expect(store.getObject("doc.pdf")).rejects.toThrow(/registered coding/);
        expect(destroyed).toBe(true);
    });

    test("a registered stored Content-Encoding is reported on the stream", async () => {
        const store = azureStore({ containerClient: mockContainer({ contentEncoding: "GZIP" }) });
        const result = await store.getObject("doc.pdf");
        expect(result.contentEncoding).toBe("gzip");
    });
});

describe("azureStore: throttle classification", () => {
    async function headError(error: unknown): Promise<unknown> {
        const store = azureStore({ containerClient: mockContainer({ throwError: error }) });
        return store.headObject("doc.pdf").then(
            () => undefined,
            (err: unknown) => err,
        );
    }

    test("code ServerBusy alone throttles, whatever the status", async () => {
        expect(await headError(restErrorWithCode(500, "ServerBusy"))).toBeInstanceOf(StoreUnavailableError);
    });

    test("status 429 alone throttles", async () => {
        expect(await headError(restError(429))).toBeInstanceOf(StoreUnavailableError);
    });

    test("a status-less RestError naming ServerBusy or OperationTimedOut throttles", async () => {
        expect(await headError(restErrorMessageOnly("ServerBusy: try later"))).toBeInstanceOf(StoreUnavailableError);
        expect(await headError(restErrorMessageOnly("OperationTimedOut: slow"))).toBeInstanceOf(StoreUnavailableError);
    });

    test("a status-less RestError with an unrelated message is not a throttle", async () => {
        const err = restErrorMessageOnly("socket hang up");
        expect(await headError(err)).toBe(err);
    });

    test("a plain Error naming ServerBusy is not a throttle", async () => {
        const err = new Error("ServerBusy");
        expect(await headError(err)).toBe(err);
    });

    test("a non-Error value carrying a RestError name and ServerBusy message is not a throttle", async () => {
        const thrown = { name: "RestError", message: "ServerBusy" };
        expect(await headError(thrown)).toBe(thrown);
    });

    test("a numeric status is authoritative over a ServerBusy message", async () => {
        const err = restErrorWith(500, "ServerBusy");
        expect(await headError(err)).toBe(err);
    });

    test("a plain Error with no status and a generic message stays unclassified", async () => {
        const err = new Error("azure generic failure");
        expect(await headError(err)).toBe(err);
    });

    test("a throttle without a Retry-After header carries no retryAfterSeconds", async () => {
        const err = await headError(restError(503));
        expect((err as StoreUnavailableError).retryAfterSeconds).toBeUndefined();
    });

    test("a throwing Retry-After getter still yields the throttle", async () => {
        const err = restError(503);
        (err as unknown as { response: unknown }).response = {
            headers: {
                get() {
                    throw new Error("header access failed");
                },
            },
        };
        const caught = await headError(err);
        expect(caught).toBeInstanceOf(StoreUnavailableError);
        expect((caught as StoreUnavailableError).retryAfterSeconds).toBeUndefined();
    });

    test("a non-function Retry-After getter still yields the throttle", async () => {
        const err = restError(503);
        (err as unknown as { response: unknown }).response = { headers: { get: "retry-after" } };
        const caught = await headError(err);
        expect(caught).toBeInstanceOf(StoreUnavailableError);
        expect((caught as StoreUnavailableError).retryAfterSeconds).toBeUndefined();
    });
});
