import { describe, test, expect } from "bun:test";
import { azureStore, ObjectNotFoundError, ObjectChangedError, StoreUnavailableError } from "../azure";

// ─── Mock Azure Container Client ────────────────────────────────────────────

const CONTENT = Buffer.from("0123456789abcdefghij"); // 20 bytes
const LAST_MODIFIED = new Date("2025-06-28T12:00:00Z");
const ETAG = '"0x8DAZURE"';

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
}

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

function mockContainer(opts: MockAzureOpts = {}) {
    return {
        getBlobClient(_name: string) {
            return {
                async getProperties() {
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
                    options?: { conditions?: { ifMatch?: string } },
                ) {
                    opts.calls?.push({ offset, count, ifMatch: options?.conditions?.ifMatch });
                    if (opts.missing) throw restError(404);
                    if (opts.throttled) throw restError(503);
                    if (opts.genericError) throw new Error("azure generic failure");
                    if (opts.conditionFails && options?.conditions?.ifMatch) throw restError(412);
                    if (opts.conditionFailsNoStatus && options?.conditions?.ifMatch) {
                        throw restErrorMessageOnly("The condition specified using HTTP conditional header(s) is not met: ConditionNotMet");
                    }

                    const isRanged = count !== undefined;
                    const end = isRanged ? Math.min(offset! + count - 1, CONTENT.length - 1) : CONTENT.length - 1;
                    const slice = CONTENT.subarray(offset ?? 0, end + 1);
                    const nodeStream = Object.assign(iterate(Buffer.from(slice)), {
                        destroy() { opts.onDestroy?.(); },
                    });
                    return {
                        readableStreamBody: opts.blobBody || opts.noBody
                            ? undefined
                            : nodeStream as unknown as NodeJS.ReadableStream & AsyncIterable<Buffer>,
                        blobBody: opts.blobBody
                            ? Promise.resolve(new Blob([Uint8Array.from(slice)]))
                            : undefined,
                        contentLength: opts.noLength ? undefined : slice.length,
                        contentRange: isRanged
                            ? (opts.badContentRange ? "bytes garbage" : `bytes ${offset}-${end}/${CONTENT.length}`)
                            : undefined,
                        etag: ETAG,
                        lastModified: LAST_MODIFIED,
                    };
                },
            };
        },
    };
}

async function drain(body: ReadableStream<Uint8Array> | Uint8Array): Promise<string> {
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("azureStore: headObject", () => {
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
        await expect(
            store.getObject("doc.pdf", { ifMatch: ETAG }),
        ).rejects.toBeInstanceOf(ObjectChangedError);
    });

    test("412 with no numeric statusCode (message-only RestError) still maps to ObjectChangedError", async () => {
        const store = azureStore({ containerClient: mockContainer({ conditionFailsNoStatus: true }) });
        await expect(
            store.getObject("doc.pdf", { ifMatch: ETAG }),
        ).rejects.toBeInstanceOf(ObjectChangedError);
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
        await expect(
            store.getObject("doc.pdf", { range: { start: 5, end: 9 } }),
        ).rejects.toThrow(/unparseable Content-Range/);
    });

    test("unparseable Content-Range destroys the live download socket before throwing", async () => {
        let destroyed = false;
        const store = azureStore({
            containerClient: mockContainer({ badContentRange: true, onDestroy: () => { destroyed = true; } }),
        });
        await expect(
            store.getObject("doc.pdf", { range: { start: 5, end: 9 } }),
        ).rejects.toThrow(/unparseable Content-Range/);
        expect(destroyed).toBe(true);
    });

    test("missing contentLength on download destroys the live socket before throwing", async () => {
        let destroyed = false;
        const store = azureStore({
            containerClient: mockContainer({ noLength: true, onDestroy: () => { destroyed = true; } }),
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
