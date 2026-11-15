import { describe, test, expect, spyOn } from "bun:test";
import { gcsStore, ObjectNotFoundError, ObjectChangedError, StoreUnavailableError, type GcsStoreOptions } from "../gcs";
import { asStream } from "./helpers";
import type { ObjectStream } from "../index";

// ─── Mock GCS Storage ───────────────────────────────────────────────────────

const CONTENT = Buffer.from("0123456789abcdefghij"); // 20 bytes
const ETAG = "CKih16GY0v8CEAE=";
const GENERATION = "1719576000000000";
/** Raw base64 of a 32-byte SHA-256: the only digest shape the adapter trusts. */
const DIGEST = Buffer.alloc(32, 7).toString("base64");
const SIGNED_URL = "https://storage.example/doc?X-Goog-Signature=abc";

/**
 * The storage surface the adapter consumes and the signing config it builds,
 * both read off the adapter's own option type. Deriving them binds the double
 * to the contract: a change to either shape fails this file at compile time
 * instead of leaving the mock satisfying a contract nobody has.
 */
type GcsStorage = GcsStoreOptions["storage"];
type GcsSignedUrlConfig = Parameters<ReturnType<ReturnType<GcsStorage["bucket"]>["file"]>["getSignedUrl"]>[0];

/** One recorded createReadStream call, with the generation it was pinned to. */
interface GcsReadCall {
    generation?: string | number;
    start?: number;
    end?: number;
}

/** One recorded bucket.file() call: the name and whether a generation pin was passed. */
interface GcsFileCall {
    key: string;
    pinned: boolean;
}

interface MockGcsOpts {
    /** Record every bucket.file() call, i.e. every time the backend is reached for an object. */
    fileCalls?: GcsFileCall[];
    /** The Content-Encoding getMetadata reports. */
    contentEncoding?: string;
    /** The read stream has no destroy() method. */
    noDestroy?: boolean;
    missing?: boolean;
    /** getMetadata throws a NON-404 error (auth failure, 500). */
    metadataError?: Error;
    /** Record stream destroy() calls. */
    destroyed?: { count: number };
    /** Record which generation each read stream was pinned to. */
    reads?: GcsReadCall[];
    /** Count of getMetadata round trips. */
    metadataCalls?: { count: number };
    /** Custom metadata returned by getMetadata (the x-goog-meta-* namespace). */
    customMetadata?: Record<string, string>;
    /** Record getSignedUrl configs. */
    signCalls?: GcsSignedUrlConfig[];
    /** getSignedUrl rejects (missing signing credentials, IAM denial). */
    signError?: Error;
    /** The size getMetadata reports in place of the real one; `{}` reports none. */
    reportedSize?: { size?: string | number };
    /** The read stream fails on its first chunk, as the SDK does once the response is an error. */
    streamError?: Error;
    /** The read stream yields nothing until destroyed. */
    streamHangs?: boolean;
    /** Called as each read stream is opened. */
    onStreamOpen?: () => void;
    /** Runs inside getSignedUrl, before it answers. */
    onSign?: () => void;
    /** getMetadata reports no generation (emulators), so reads are not pinned. */
    noGeneration?: boolean;
}

async function* iterate(buf: Buffer, opts: MockGcsOpts, destroyed: Promise<void>): AsyncGenerator<Buffer> {
    if (opts.streamHangs) {
        await destroyed;
        throw Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" });
    }
    if (opts.streamError) throw opts.streamError;
    yield buf;
}

function mockStorage(opts: MockGcsOpts = {}): GcsStorage {
    return {
        bucket(_name: string) {
            return {
                file(key: string, fileOpts?: { generation?: string | number }) {
                    opts.fileCalls?.push({ key, pinned: fileOpts !== undefined });
                    return {
                        async getMetadata() {
                            if (opts.metadataCalls) opts.metadataCalls.count++;
                            if (opts.metadataError) throw opts.metadataError;
                            if (opts.missing) {
                                throw Object.assign(new Error("No such object"), { code: 404 });
                            }
                            return [
                                {
                                    ...(opts.reportedSize ?? { size: String(CONTENT.length) }),
                                    etag: ETAG,
                                    generation: opts.noGeneration ? undefined : GENERATION,
                                    updated: "2025-06-28T12:00:00.000Z",
                                    metadata: opts.customMetadata,
                                    contentEncoding: opts.contentEncoding,
                                },
                            ] as [
                                {
                                    size: string;
                                    etag: string;
                                    generation?: string;
                                    updated: string;
                                    metadata?: Record<string, string>;
                                    contentEncoding?: string;
                                },
                            ];
                        },
                        async getSignedUrl(config: GcsSignedUrlConfig) {
                            opts.signCalls?.push(config);
                            opts.onSign?.();
                            if (opts.signError) throw opts.signError;
                            return [SIGNED_URL] as [string];
                        },
                        createReadStream(streamOpts?: { start?: number; end?: number }) {
                            opts.reads?.push({
                                generation: fileOpts?.generation,
                                start: streamOpts?.start,
                                end: streamOpts?.end,
                            });
                            const start = streamOpts?.start ?? 0;
                            const end = streamOpts?.end ?? CONTENT.length - 1;
                            const slice = Buffer.from(CONTENT.subarray(start, end + 1));
                            opts.onStreamOpen?.();
                            const { promise: destroyed, resolve: markDestroyed } = Promise.withResolvers<void>();
                            const stream = iterate(slice, opts, destroyed);
                            if (opts.noDestroy)
                                return stream as unknown as NodeJS.ReadableStream & AsyncIterable<Buffer>;
                            return Object.assign(stream, {
                                destroy() {
                                    if (opts.destroyed) opts.destroyed.count++;
                                    markDestroyed();
                                },
                            }) as unknown as NodeJS.ReadableStream & AsyncIterable<Buffer>;
                        },
                    };
                },
            };
        },
    };
}

/**
 * The streaming half of an {@link ObjectStream} body. This adapter opens a
 * read stream for every object, so a byte body means the adapter stopped
 * streaming and the surrounding assertion is measuring the wrong thing.
 */
async function drain(body: ObjectStream["body"]): Promise<string> {
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("gcsStore: headObject", () => {
    test("maps metadata (string size) to ObjectMetadata", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        const meta = await store.headObject("doc.pdf");

        expect(meta.contentLength).toBe(20);
        expect(meta.etag).toBe(ETAG);
        expect(meta.lastModified).toBe(new Date("2025-06-28T12:00:00.000Z").toUTCString());
    });

    for (const [label, reportedSize] of [
        ["no size", {}],
        ["a size that is not a decimal count", { size: "20abc" }],
    ] as const) {
        test(`metadata with ${label} fails the read rather than sizing the body from it`, async () => {
            const store = gcsStore({ storage: mockStorage({ reportedSize }), bucket: "b" });
            await expect(store.headObject("doc.pdf")).rejects.toThrow(/without a usable size/);
            await expect(store.getObject("doc.pdf")).rejects.toThrow(/without a usable size/);
        });
    }

    test("throws ObjectNotFoundError on 404", async () => {
        const store = gcsStore({ storage: mockStorage({ missing: true }), bucket: "b" });
        await expect(store.headObject("gone.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("throws StoreUnavailableError on a 503 throttle (retryable, not 502)", async () => {
        const store = gcsStore({
            storage: mockStorage({ metadataError: Object.assign(new Error("backend unavailable"), { code: 503 }) }),
            bucket: "b",
        });
        await expect(store.headObject("busy.pdf")).rejects.toBeInstanceOf(StoreUnavailableError);
    });
});

describe("gcsStore: getObject", () => {
    test("streams the full object and pins the read to the measured generation", async () => {
        const reads: Array<{ generation?: string | number }> = [];
        const store = gcsStore({ storage: mockStorage({ reads }), bucket: "b" });
        const result = await store.getObject("doc.pdf");

        expect(await drain(result.body)).toBe("0123456789abcdefghij");
        expect(result.totalSize).toBe(20);
        // The stream must come from the exact generation getMetadata measured.
        expect(reads[0]?.generation).toBe(GENERATION);
    });

    test("ranged read fabricates a consistent Content-Range from pinned metadata", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        const result = await store.getObject("doc.pdf", { range: { start: 5, end: 9 } });

        expect(await drain(result.body)).toBe("56789");
        expect(result.range).toEqual({ start: 5, end: 9 });
        expect(result.contentLength).toBe(5);
    });

    test("ifMatch mismatch throws ObjectChangedError before any streaming", async () => {
        const reads: GcsReadCall[] = [];
        const store = gcsStore({ storage: mockStorage({ reads }), bucket: "b" });

        await expect(store.getObject("doc.pdf", { ifMatch: "stale-etag" })).rejects.toBeInstanceOf(ObjectChangedError);
        expect(reads).toHaveLength(0); // no stream was opened
    });

    test("matching ifMatch proceeds normally", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        const result = await store.getObject("doc.pdf", { ifMatch: ETAG });
        expect(await drain(result.body)).toBe("0123456789abcdefghij");
    });

    test("throws ObjectNotFoundError on 404", async () => {
        const store = gcsStore({ storage: mockStorage({ missing: true }), bucket: "b" });
        await expect(store.getObject("gone.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });
});

describe("gcsStore: pin round-trip (single backend read)", () => {
    test("headObject issues a pin when a generation is present", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        const meta = await store.headObject("doc.pdf");
        expect(meta.pin).toBeString();
    });

    test("getObject with a pin skips getMetadata entirely and streams the pinned generation", async () => {
        const reads: Array<{ generation?: string | number }> = [];
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ reads, metadataCalls }), bucket: "b" });

        const meta = await store.headObject("doc.pdf");
        expect(metadataCalls.count).toBe(1);

        const result = await store.getObject("doc.pdf", {
            range: { start: 5, end: 9 },
            ifMatch: meta.etag,
            pin: meta.pin,
        });

        expect(await drain(result.body)).toBe("56789");
        expect(result.range).toEqual({ start: 5, end: 9 });
        expect(result.totalSize).toBe(20);
        expect(result.etag).toBe(ETAG);
        // The whole HEAD->GET pair cost exactly one metadata round trip.
        expect(metadataCalls.count).toBe(1);
        expect(reads[0]?.generation).toBe(GENERATION);
    });

    test("pin whose etag disagrees with ifMatch is ignored (metadata path revalidates)", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ metadataCalls }), bucket: "b" });
        const meta = await store.headObject("doc.pdf");

        // Caller mixes a pin from one representation with a different
        // validator: the adapter must not trust it.
        await expect(store.getObject("doc.pdf", { ifMatch: "different-etag", pin: meta.pin })).rejects.toBeInstanceOf(
            ObjectChangedError,
        );
        expect(metadataCalls.count).toBe(2); // HEAD + revalidation
    });

    test("corrupt or foreign pin tokens fall back to the metadata path", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ metadataCalls }), bucket: "b" });

        for (const pin of ["not-json", "{}", '{"generation":1}', '"str"']) {
            const result = await store.getObject("doc.pdf", { pin });
            expect(await drain(result.body)).toBe("0123456789abcdefghij");
        }
        expect(metadataCalls.count).toBe(4); // every bad pin revalidated
    });

    test("a pin with a non-string/number generation is rejected (never indexes an arbitrary version)", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ metadataCalls }), bucket: "b" });

        // Structurally valid JSON, hostile `generation`: an object/array/null/
        // empty string must not flow into bucket.file(key, { generation }).
        const hostilePins = [
            JSON.stringify({ generation: {}, size: 20 }),
            JSON.stringify({ generation: [], size: 20 }),
            JSON.stringify({ generation: null, size: 20 }),
            JSON.stringify({ generation: "", size: 20 }),
        ];
        for (const pin of hostilePins) {
            const result = await store.getObject("doc.pdf", { pin });
            expect(await drain(result.body)).toBe("0123456789abcdefghij");
        }
        expect(metadataCalls.count).toBe(hostilePins.length); // each revalidated from scratch
    });

    test("forged pins with dishonest byte accounting or non-string validators revalidate from scratch", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ metadataCalls }), bucket: "b" });

        // Each token is structurally valid JSON with a real generation, but
        // carries a field that must never flow downstream: a negative or
        // fractional size would corrupt range clamping and wire framing, and
        // a non-string etag/lastModified would surface as a malformed
        // response header.
        const forgedPins = [
            JSON.stringify({ generation: GENERATION, size: -5 }),
            JSON.stringify({ generation: GENERATION, size: 10.5 }),
            JSON.stringify({ generation: GENERATION, size: 20, etag: 123 }),
            JSON.stringify({ generation: GENERATION, size: 20, lastModified: 42 }),
        ];
        for (const pin of forgedPins) {
            const result = await store.getObject("doc.pdf", { pin });
            expect(await drain(result.body)).toBe("0123456789abcdefghij");
            expect(result.totalSize).toBe(20); // the measured size, not the forged one
        }
        expect(metadataCalls.count).toBe(forgedPins.length); // each revalidated
    });

    test("an ifMatch is never satisfied by a pin that lacks the validator (revalidates, catches a stale read)", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ metadataCalls }), bucket: "b" });

        // A pin carrying generation + size but NO etag must not silently
        // satisfy an ifMatch: it falls to the metadata path, which enforces
        // the precondition and rejects a stale validator.
        const etaglessPin = JSON.stringify({ generation: GENERATION, size: CONTENT.length });
        await expect(store.getObject("doc.pdf", { ifMatch: "stale-etag", pin: etaglessPin })).rejects.toBeInstanceOf(
            ObjectChangedError,
        );
    });
});

describe("gcsStore: a read stream that fails before its first byte", () => {
    const gone = () => Object.assign(new Error("No such object"), { code: 404 });

    test("a pinned generation deleted after HEAD rejects with ObjectChangedError, not a broken body", async () => {
        const destroyed = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ streamError: gone(), destroyed }), bucket: "b" });
        const meta = await store.headObject("doc.pdf");

        await expect(store.getObject("doc.pdf", { pin: meta.pin })).rejects.toBeInstanceOf(ObjectChangedError);
        expect(destroyed.count).toBe(1);
    });

    test("the generation just measured, deleted before the stream opens, rejects with ObjectChangedError", async () => {
        const store = gcsStore({ storage: mockStorage({ streamError: gone() }), bucket: "b" });
        await expect(store.getObject("doc.pdf", { range: { start: 0, end: 4 } })).rejects.toBeInstanceOf(
            ObjectChangedError,
        );
    });

    test("a 412 on a pinned generation rejects with ObjectChangedError", async () => {
        const store = gcsStore({
            storage: mockStorage({ streamError: Object.assign(new Error("precondition"), { code: 412 }) }),
            bucket: "b",
        });
        await expect(store.getObject("doc.pdf")).rejects.toBeInstanceOf(ObjectChangedError);
    });

    test("an unpinned read of an object deleted after the metadata read rejects with ObjectNotFoundError", async () => {
        const store = gcsStore({ storage: mockStorage({ streamError: gone(), noGeneration: true }), bucket: "b" });
        await expect(store.getObject("doc.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("a throttle on the stream rejects with StoreUnavailableError", async () => {
        const store = gcsStore({
            storage: mockStorage({ streamError: Object.assign(new Error("slow down"), { code: 429 }) }),
            bucket: "b",
        });
        await expect(store.getObject("doc.pdf")).rejects.toBeInstanceOf(StoreUnavailableError);
    });

    test("an unclassified stream error propagates untouched and releases the stream", async () => {
        const destroyed = { count: 0 };
        const store = gcsStore({
            storage: mockStorage({ streamError: new Error("connection reset"), destroyed }),
            bucket: "b",
        });
        await expect(store.getObject("doc.pdf")).rejects.toThrow("connection reset");
        expect(destroyed.count).toBe(1);
    });

    test("an abort while waiting for the first byte rejects with the abort reason and destroys the stream", async () => {
        const destroyed = { count: 0 };
        const { promise: opened, resolve: markOpened } = Promise.withResolvers<void>();
        const store = gcsStore({
            storage: mockStorage({ streamHangs: true, destroyed, onStreamOpen: markOpened }),
            bucket: "b",
        });
        const controller = new AbortController();
        const pending = store.getObject("doc.pdf", { signal: controller.signal });
        await opened;
        // The adapter is now parked on the first chunk.
        await Promise.resolve();
        controller.abort(new Error("client went away"));

        await expect(pending).rejects.toThrow("client went away");
        expect(destroyed.count).toBeGreaterThanOrEqual(1);
    });

    test("an abort before the stream opens rejects without waiting on it", async () => {
        const destroyed = { count: 0 };
        const controller = new AbortController();
        const store = gcsStore({
            storage: mockStorage({
                streamHangs: true,
                destroyed,
                onStreamOpen: () => controller.abort(new Error("gone early")),
            }),
            bucket: "b",
        });

        await expect(store.getObject("doc.pdf", { signal: controller.signal })).rejects.toThrow("gone early");
        expect(destroyed.count).toBe(1);
    });

    test("the first chunk is delivered in the body, once", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        const result = await store.getObject("doc.pdf", { range: { start: 2, end: 6 } });
        expect(await drain(result.body)).toBe("23456");
    });
});

describe("gcsStore: failure propagation and cleanup", () => {
    test("non-404 metadata errors are rethrown untouched (never masked as not-found)", async () => {
        const authError = Object.assign(new Error("invalid credentials"), { code: 401 });
        const store = gcsStore({ storage: mockStorage({ metadataError: authError }), bucket: "b" });

        await expect(store.headObject("doc.pdf")).rejects.toThrow("invalid credentials");
        await expect(store.getObject("doc.pdf")).rejects.toThrow("invalid credentials");
    });

    test("an unclassified error with no `code` is never masked as throttled/not-found", async () => {
        // A code-less error reaches the terminal `return false` of both the
        // not-found and throttle classifiers; it must propagate untouched, not
        // be misreported as a retryable 503 or a 404.
        const store = gcsStore({ storage: mockStorage({ metadataError: new Error("connection reset") }), bucket: "b" });

        await expect(store.headObject("doc.pdf")).rejects.toThrow("connection reset");
        await expect(store.getObject("doc.pdf")).rejects.toThrow("connection reset");
    });

    test("cancelling the web stream destroys the underlying GCS stream", async () => {
        const destroyed = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ destroyed }), bucket: "b" });
        const result = await store.getObject("doc.pdf");

        await asStream(result.body).cancel();
        expect(destroyed.count).toBe(1);
    });
});

describe("gcsStore: digestMetadataKey", () => {
    test("headObject and getObject surface a valid custom-metadata SHA-256 as digest", async () => {
        const store = gcsStore({
            storage: mockStorage({ customMetadata: { sha256: DIGEST } }),
            bucket: "b",
            digestMetadataKey: "sha256",
        });

        const meta = await store.headObject("doc.pdf");
        expect(meta.digest).toBe(DIGEST);

        const result = await store.getObject("doc.pdf", { range: { start: 5, end: 9 } });
        // Custom-metadata digests name the WHOLE representation, so a ranged
        // read keeps it (Repr-Digest is valid on 206 responses).
        expect(result.digest).toBe(DIGEST);
        await asStream(result.body).cancel();
    });

    test("the pin round-trip carries the digest without a second metadata read", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({
            storage: mockStorage({ customMetadata: { sha256: DIGEST }, metadataCalls }),
            bucket: "b",
            digestMetadataKey: "sha256",
        });

        const meta = await store.headObject("doc.pdf");
        const result = await store.getObject("doc.pdf", { ifMatch: meta.etag, pin: meta.pin });
        expect(result.digest).toBe(DIGEST);
        expect(metadataCalls.count).toBe(1); // HEAD only; the pin skipped the re-fetch
        await asStream(result.body).cancel();
    });

    test("invalid digest values yield undefined, never an error", async () => {
        // Hex, truncated base64, a composite multipart-style value, and a
        // wrong-length string must all be discarded: only the raw base64 of
        // a 32-byte SHA-256 is a valid Repr-Digest payload.
        const invalid = ["deadbeef", DIGEST.slice(0, 20), `${DIGEST}-2`, "not a digest at all"];
        for (const value of invalid) {
            const store = gcsStore({
                storage: mockStorage({ customMetadata: { sha256: value } }),
                bucket: "b",
                digestMetadataKey: "sha256",
            });
            const meta = await store.headObject("doc.pdf");
            expect(meta.digest).toBeUndefined();
        }
    });

    test("an absent key or an unset option yields undefined", async () => {
        // Key configured but not present on the object.
        const keyed = gcsStore({
            storage: mockStorage({ customMetadata: { other: "x" } }),
            bucket: "b",
            digestMetadataKey: "sha256",
        });
        expect((await keyed.headObject("doc.pdf")).digest).toBeUndefined();

        // Value present but the option was never set: never read implicitly.
        const unkeyed = gcsStore({
            storage: mockStorage({ customMetadata: { sha256: DIGEST } }),
            bucket: "b",
        });
        expect((await unkeyed.headObject("doc.pdf")).digest).toBeUndefined();
    });
});

describe("gcsStore: createSignedUrl", () => {
    test("returns ok with a V4 read URL and forwards the sanitized disposition", async () => {
        const signCalls: GcsSignedUrlConfig[] = [];
        const store = gcsStore({ storage: mockStorage({ signCalls }), bucket: "b" });

        const result = await store.createSignedUrl!("doc.pdf", {
            expiresInSeconds: 120,
            downloadFilename: "Quarterly Report.pdf",
        });

        expect(result).toEqual({ ok: true, url: SIGNED_URL });
        expect(signCalls[0]?.version).toBe("v4");
        expect(signCalls[0]?.action).toBe("read");
        expect(String(signCalls[0]?.responseDisposition)).toContain("attachment");
        expect(String(signCalls[0]?.responseDisposition)).toContain("Quarterly Report.pdf");
        // Inert content type prevents an inline polyglot rendering off the redirect target.
        expect(signCalls[0]?.responseType).toBe("application/octet-stream");
    });

    test("forces attachment + inert content type even without a downloadFilename", async () => {
        const signCalls: GcsSignedUrlConfig[] = [];
        const store = gcsStore({ storage: mockStorage({ signCalls }), bucket: "b" });

        const result = await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 });

        expect(result.ok).toBe(true);
        // A signed URL bypasses the serve route's security headers; the redirect
        // target must never render a stored HTML/SVG polyglot inline.
        expect(signCalls[0]?.responseType).toBe("application/octet-stream");
        expect(String(signCalls[0]?.responseDisposition)).toContain("attachment");
    });

    test("a hostile filename never reaches the signed disposition unsanitized", async () => {
        const signCalls: GcsSignedUrlConfig[] = [];
        const store = gcsStore({ storage: mockStorage({ signCalls }), bucket: "b" });

        await store.createSignedUrl!("doc.pdf", {
            expiresInSeconds: 60,
            downloadFilename: 'evil\r\nContent-Type: text/html;.."\\..pdf',
        });

        const disposition = String(signCalls[0]?.responseDisposition);
        expect(disposition).not.toMatch(/[\r\n]/);
        expect(disposition).toContain("attachment");
    });

    test("expiry is expiresInSeconds from now", async () => {
        const signCalls: GcsSignedUrlConfig[] = [];
        const store = gcsStore({ storage: mockStorage({ signCalls }), bucket: "b" });

        const before = Date.now();
        await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 120 });
        const after = Date.now();

        const expires = signCalls[0]?.expires as Date;
        expect(expires).toBeInstanceOf(Date);
        expect(expires.getTime()).toBeGreaterThanOrEqual(before + 120_000);
        expect(expires.getTime()).toBeLessThanOrEqual(after + 120_000);
    });

    test("cacheControl is never forwarded (GCS has no response-cache-control override)", async () => {
        const signCalls: GcsSignedUrlConfig[] = [];
        const store = gcsStore({ storage: mockStorage({ signCalls }), bucket: "b" });

        await store.createSignedUrl!("doc.pdf", {
            expiresInSeconds: 60,
            cacheControl: "private, no-cache",
        });

        // The exact signing config: no faked cache-control parameter, and no
        // accidental passthrough of unsupported options.
        expect(Object.keys(signCalls[0] ?? {}).toSorted()).toEqual([
            "action",
            "expires",
            "responseDisposition",
            "responseType",
            "version",
        ]);
    });

    test("credentials with no client_email decline with ok: false and the SDK's error as cause", async () => {
        // The SDK's refusal when the credential cannot sign at all (user
        // credentials, an API key): the caller streams instead.
        const signError = Object.assign(new Error("Cannot sign data without `client_email`."), {
            name: "SigningError",
        });
        const store = gcsStore({ storage: mockStorage({ signError }), bucket: "b" });

        const result = await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 });
        expect(result).toMatchObject({
            ok: false,
            code: "no-credential",
            error: "Cannot sign data without `client_email`.",
        });
        expect("cause" in result && result.cause).toBe(signError);
    });

    test("a signer failure with a signing credential throws, never declines", async () => {
        const signError = Object.assign(new Error("Permission 'iam.serviceAccounts.signBlob' denied"), {
            name: "SigningError",
        });
        const store = gcsStore({ storage: mockStorage({ signError }), bucket: "b" });

        await expect(store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 })).rejects.toBe(signError);
    });

    test("an aborted signal rejects with its reason before anything is signed", async () => {
        const signCalls: GcsSignedUrlConfig[] = [];
        const store = gcsStore({ storage: mockStorage({ signCalls }), bucket: "b" });
        const reason = new Error("client went away");
        const signOpts = { expiresInSeconds: 60, signal: AbortSignal.abort(reason) };

        await expect(store.createSignedUrl!("doc.pdf", signOpts)).rejects.toBe(reason);
        expect(signCalls).toHaveLength(0);
    });

    test("an abort while signing rejects with its reason, never a URL", async () => {
        const controller = new AbortController();
        const reason = new Error("client went away");
        const store = gcsStore({ storage: mockStorage({ onSign: () => controller.abort(reason) }), bucket: "b" });
        const signOpts = { expiresInSeconds: 60, signal: controller.signal };

        await expect(store.createSignedUrl!("doc.pdf", signOpts)).rejects.toBe(reason);
    });
});

describe("gcsStore: reserved upload namespace and key policy", () => {
    const RESERVED = ".partial-content-uploads/upload-1/data";

    test("every read refuses a key under the default reserved prefix before the backend or signer is reached", async () => {
        const fileCalls: GcsFileCall[] = [];
        const metadataCalls = { count: 0 };
        const signCalls: GcsSignedUrlConfig[] = [];
        const store = gcsStore({ storage: mockStorage({ fileCalls, metadataCalls, signCalls }), bucket: "b" });

        for (const key of [RESERVED, ".partial-content-uploads"]) {
            await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(store.createSignedUrl!(key, { expiresInSeconds: 60 })).rejects.toBeInstanceOf(
                ObjectNotFoundError,
            );
        }
        expect(fileCalls).toHaveLength(0);
        expect(metadataCalls.count).toBe(0);
        expect(signCalls).toHaveLength(0);
    });

    test("the refusal carries the key on the error, not in the message", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        const err = await store.headObject(RESERVED).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ObjectNotFoundError);
        expect((err as ObjectNotFoundError).key).toBe(RESERVED);
        expect((err as Error).message).toBe("Object not found");
    });

    test("an empty reservedPrefix reserves nothing", async () => {
        const signCalls: GcsSignedUrlConfig[] = [];
        const store = gcsStore({ storage: mockStorage({ signCalls }), bucket: "b", reservedPrefix: "" });

        expect((await store.headObject(RESERVED)).contentLength).toBe(20);
        expect(await drain((await store.getObject(RESERVED)).body)).toBe("0123456789abcdefghij");
        expect(await store.createSignedUrl!(RESERVED, { expiresInSeconds: 60 })).toEqual({ ok: true, url: SIGNED_URL });
        expect(signCalls).toHaveLength(1);
    });

    test("a custom reservedPrefix replaces the default", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b", reservedPrefix: ["private/", "tmp/"] });

        await expect(store.headObject("tmp/x")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.headObject("private/x")).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect((await store.headObject(RESERVED)).contentLength).toBe(20);
    });

    test("the default policy takes a key with an empty segment verbatim, an explicit plain policy refuses it", async () => {
        const fileCalls: GcsFileCall[] = [];
        const verbatim = gcsStore({ storage: mockStorage({ fileCalls }), bucket: "b" });
        expect((await verbatim.headObject("a//b")).contentLength).toBe(20);
        expect(fileCalls.map((c) => c.key)).toEqual(["a//b"]);

        const explicitVerbatim = gcsStore({ storage: mockStorage(), bucket: "b", keys: "verbatim" });
        expect((await explicitVerbatim.headObject("a//b")).contentLength).toBe(20);

        const plainCalls: GcsFileCall[] = [];
        const plain = gcsStore({ storage: mockStorage({ fileCalls: plainCalls }), bucket: "b", keys: "plain" });
        await expect(plain.headObject("a//b")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(plain.getObject("a/./b")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(plain.createSignedUrl!("/a", { expiresInSeconds: 60 })).rejects.toBeInstanceOf(
            ObjectNotFoundError,
        );
        expect(plainCalls).toHaveLength(0);
    });

    test("the store declares range support", () => {
        expect(gcsStore({ storage: mockStorage(), bucket: "b" }).supportsRange).toBe(true);
    });
});

describe("gcsStore: headObject options and pins", () => {
    test("an options object without a signal reads normally", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        expect((await store.headObject("doc.pdf", {})).contentLength).toBe(20);
    });

    test("an aborted signal rejects with its reason before the backend is reached", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ metadataCalls }), bucket: "b" });
        const reason = new Error("client went away");

        await expect(store.headObject("doc.pdf", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
        await expect(store.getObject("doc.pdf", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
        expect(metadataCalls.count).toBe(0);
    });

    test("an object without a generation yields no pin", async () => {
        const store = gcsStore({ storage: mockStorage({ noGeneration: true }), bucket: "b" });
        expect((await store.headObject("doc.pdf")).pin).toBeUndefined();
    });
});

describe("gcsStore: ranged reads", () => {
    test("a range starting at the object size is a RangeError and opens no stream", async () => {
        const reads: GcsReadCall[] = [];
        const store = gcsStore({ storage: mockStorage({ reads }), bucket: "b" });

        await expect(store.getObject("doc.pdf", { range: { start: 20, end: 25 } })).rejects.toThrow(RangeError);
        await expect(store.getObject("doc.pdf", { range: { start: 20, end: 25 } })).rejects.toThrow(
            /range start is past the 20-byte object/,
        );
        await expect(store.getObject("doc.pdf", { range: { start: 99, end: undefined } })).rejects.toThrow(
            /range start is past the 20-byte object/,
        );
        expect(reads).toHaveLength(0);
    });

    test("the same bound holds on the pinned path", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        const meta = await store.headObject("doc.pdf");
        await expect(store.getObject("doc.pdf", { range: { start: 20, end: 20 }, pin: meta.pin })).rejects.toThrow(
            /range start is past the 20-byte object/,
        );
    });

    test("the last byte is still readable", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        const result = await store.getObject("doc.pdf", { range: { start: 19, end: 19 } });
        expect(await drain(result.body)).toBe("j");
        expect(result.contentLength).toBe(1);
    });

    test("an end past the object is clamped to the last byte in the report and the backend read", async () => {
        const reads: GcsReadCall[] = [];
        const store = gcsStore({ storage: mockStorage({ reads }), bucket: "b" });
        const result = await store.getObject("doc.pdf", { range: { start: 15, end: 100 } });

        expect(result.range).toEqual({ start: 15, end: 19 });
        expect(result.contentLength).toBe(5);
        expect(reads[0]?.end).toBe(19);
        expect(await drain(result.body)).toBe("fghij");
    });

    test("an open-ended range reads to the last byte", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        const result = await store.getObject("doc.pdf", { range: { start: 15, end: undefined } });

        expect(result.range).toEqual({ start: 15, end: 19 });
        expect(result.contentLength).toBe(5);
        expect(await drain(result.body)).toBe("fghij");
    });

    test("the read is generation-pinned only when the object has a generation", async () => {
        const pinnedCalls: GcsFileCall[] = [];
        const pinned = gcsStore({ storage: mockStorage({ fileCalls: pinnedCalls }), bucket: "b" });
        await asStream((await pinned.getObject("doc.pdf")).body).cancel();
        // getMetadata read, then the generation-pinned stream.
        expect(pinnedCalls.map((c) => c.pinned)).toEqual([false, true]);

        const unpinnedCalls: GcsFileCall[] = [];
        const unpinned = gcsStore({
            storage: mockStorage({ fileCalls: unpinnedCalls, noGeneration: true }),
            bucket: "b",
        });
        await asStream((await unpinned.getObject("doc.pdf")).body).cancel();
        expect(unpinnedCalls.map((c) => c.pinned)).toEqual([false, false]);
    });
});

describe("gcsStore: reported sizes", () => {
    test("a zero size and a numeric size are both honest", async () => {
        const zero = gcsStore({ storage: mockStorage({ reportedSize: { size: "0" } }), bucket: "b" });
        expect((await zero.headObject("doc.pdf")).contentLength).toBe(0);

        const numeric = gcsStore({ storage: mockStorage({ reportedSize: { size: 20 } }), bucket: "b" });
        expect((await numeric.headObject("doc.pdf")).contentLength).toBe(20);
    });

    for (const [label, size] of [
        ["an empty string", ""],
        ["a negative number", -1],
        ["a fractional number", 1.5],
        ["NaN", Number.NaN],
    ] as const) {
        test(`${label} is not a usable size`, async () => {
            const store = gcsStore({ storage: mockStorage({ reportedSize: { size } }), bucket: "b" });
            await expect(store.headObject("doc.pdf")).rejects.toThrow(/without a usable size/);
        });
    }
});

describe("gcsStore: digest metadata key edge cases", () => {
    test("an unset or empty option never reads a metadata entry named after it", async () => {
        const unset = gcsStore({
            storage: mockStorage({ customMetadata: { undefined: DIGEST } }),
            bucket: "b",
        });
        expect((await unset.headObject("doc.pdf")).digest).toBeUndefined();

        const empty = gcsStore({
            storage: mockStorage({ customMetadata: { "": DIGEST } }),
            bucket: "b",
            digestMetadataKey: "",
        });
        expect((await empty.headObject("doc.pdf")).digest).toBeUndefined();
    });

    test("an object with no custom metadata at all yields no digest", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b", digestMetadataKey: "sha256" });
        expect((await store.headObject("doc.pdf")).digest).toBeUndefined();
    });
});

describe("gcsStore: pin token validation", () => {
    test("a pin with a numeric generation is trusted and pins the read to it", async () => {
        const reads: GcsReadCall[] = [];
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ reads, metadataCalls }), bucket: "b" });

        const result = await store.getObject("doc.pdf", { pin: JSON.stringify({ generation: 12345, size: 20 }) });
        expect(metadataCalls.count).toBe(0);
        expect(reads[0]?.generation).toBe(12345);
        await asStream(result.body).cancel();
    });

    test("a pin for an empty object is trusted without a metadata read", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ metadataCalls }), bucket: "b" });

        const result = await store.getObject("doc.pdf", { pin: JSON.stringify({ generation: GENERATION, size: 0 }) });
        expect(metadataCalls.count).toBe(0);
        expect(result.totalSize).toBe(0);
        await asStream(result.body).cancel();
    });

    test("array and array-like generations revalidate", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ metadataCalls }), bucket: "b" });

        const pins = [
            JSON.stringify({ generation: [1], size: 20 }),
            JSON.stringify({ generation: { length: 3 }, size: 20 }),
        ];
        for (const pin of pins) {
            const result = await store.getObject("doc.pdf", { pin });
            expect(await drain(result.body)).toBe("0123456789abcdefghij");
        }
        expect(metadataCalls.count).toBe(pins.length);
    });

    test("a stored content coding survives the pin round trip without a second metadata read", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ metadataCalls, contentEncoding: "gzip" }), bucket: "b" });

        const meta = await store.headObject("doc.pdf");
        expect(meta.contentEncoding).toBe("gzip");
        const result = await store.getObject("doc.pdf", { ifMatch: meta.etag, pin: meta.pin });
        expect(result.contentEncoding).toBe("gzip");
        expect(metadataCalls.count).toBe(1);
        await asStream(result.body).cancel();
    });

    test("a pin whose content coding is not in normalized form revalidates", async () => {
        const metadataCalls = { count: 0 };
        const store = gcsStore({ storage: mockStorage({ metadataCalls }), bucket: "b" });

        const codings: unknown[] = ["x-gzip", "GZIP", "identity", "not-a-coding", 123];
        for (const contentEncoding of codings) {
            const pin = JSON.stringify({ generation: GENERATION, size: 20, contentEncoding });
            const result = await store.getObject("doc.pdf", { pin });
            expect(result.contentEncoding).toBeUndefined();
            await asStream(result.body).cancel();
        }
        expect(metadataCalls.count).toBe(codings.length);
    });
});

describe("gcsStore: throttle hints", () => {
    const throttle = (retryAfter?: string) =>
        Object.assign(new Error("slow down"), {
            code: 503,
            response: retryAfter === undefined ? undefined : { headers: { "retry-after": retryAfter } },
        });

    test("a delay-seconds Retry-After is echoed on the StoreUnavailableError", async () => {
        const store = gcsStore({ storage: mockStorage({ metadataError: throttle("30") }), bucket: "b" });
        const err = await store.headObject("doc.pdf").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StoreUnavailableError);
        expect((err as StoreUnavailableError).retryAfterSeconds).toBe(30);
    });

    test("an HTTP-date Retry-After is converted to a delay", async () => {
        const date = new Date(Date.now() + 120_000).toUTCString();
        const store = gcsStore({ storage: mockStorage({ metadataError: throttle(date) }), bucket: "b" });
        const err = await store.headObject("doc.pdf").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StoreUnavailableError);
        const seconds = (err as StoreUnavailableError).retryAfterSeconds;
        expect(seconds).toBeGreaterThanOrEqual(100);
        expect(seconds).toBeLessThanOrEqual(120);
    });

    test("a throttle with no usable hint carries no retry delay", async () => {
        for (const error of [throttle(), throttle("soon")]) {
            const store = gcsStore({ storage: mockStorage({ metadataError: error }), bucket: "b" });
            const err = await store.headObject("doc.pdf").catch((e: unknown) => e);
            expect(err).toBeInstanceOf(StoreUnavailableError);
            expect((err as StoreUnavailableError).retryAfterSeconds).toBeUndefined();
        }
    });
});

describe("gcsStore: read stream teardown", () => {
    test("a failing stream without a destroy method still surfaces its own error", async () => {
        const store = gcsStore({
            storage: mockStorage({ streamError: new Error("connection reset"), noDestroy: true }),
            bucket: "b",
        });
        await expect(store.getObject("doc.pdf")).rejects.toThrow("connection reset");
    });

    test("the abort listener used while opening the stream is removed once it is open", async () => {
        const controller = new AbortController();
        const added = spyOn(controller.signal, "addEventListener");
        const removed = spyOn(controller.signal, "removeEventListener");
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });

        const result = await store.getObject("doc.pdf", { signal: controller.signal });
        const openingListener = added.mock.calls[0]?.[1];
        expect(openingListener).toBeFunction();
        expect(removed.mock.calls.some(([type, listener]) => type === "abort" && listener === openingListener)).toBe(
            true,
        );
        await asStream(result.body).cancel();
    });
});
