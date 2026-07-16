import { describe, test, expect } from "bun:test";
import { gcsStore, ObjectNotFoundError, ObjectChangedError, StoreUnavailableError } from "../gcs";

// ─── Mock GCS Storage ───────────────────────────────────────────────────────

const CONTENT = Buffer.from("0123456789abcdefghij"); // 20 bytes
const ETAG = "CKih16GY0v8CEAE=";
const GENERATION = "1719576000000000";
/** Raw base64 of a 32-byte SHA-256: the only digest shape the adapter trusts. */
const DIGEST = Buffer.alloc(32, 7).toString("base64");
const SIGNED_URL = "https://storage.example/doc?X-Goog-Signature=abc";

interface MockGcsOpts {
    missing?: boolean;
    /** getMetadata throws a NON-404 error (auth failure, 500). */
    metadataError?: Error;
    /** Record stream destroy() calls. */
    destroyed?: { count: number };
    /** Record which generation each read stream was pinned to. */
    reads?: Array<{ generation?: string | number; start?: number; end?: number }>;
    /** Count of getMetadata round trips. */
    metadataCalls?: { count: number };
    /** Custom metadata returned by getMetadata (the x-goog-meta-* namespace). */
    customMetadata?: Record<string, string>;
    /** Record getSignedUrl configs. */
    signCalls?: Array<Record<string, unknown>>;
    /** getSignedUrl rejects (missing signing credentials, IAM denial). */
    signError?: Error;
}

async function* iterate(buf: Buffer): AsyncGenerator<Buffer> {
    yield buf;
}

function mockStorage(opts: MockGcsOpts = {}) {
    return {
        bucket(_name: string) {
            return {
                file(_key: string, fileOpts?: { generation?: string | number }) {
                    return {
                        async getMetadata() {
                            if (opts.metadataCalls) opts.metadataCalls.count++;
                            if (opts.metadataError) throw opts.metadataError;
                            if (opts.missing) {
                                throw Object.assign(new Error("No such object"), { code: 404 });
                            }
                            return [{
                                size: String(CONTENT.length),
                                etag: ETAG,
                                generation: GENERATION,
                                updated: "2025-06-28T12:00:00.000Z",
                                metadata: opts.customMetadata,
                            }] as [{
                                size: string; etag: string; generation: string;
                                updated: string; metadata?: Record<string, string>;
                            }];
                        },
                        async getSignedUrl(config: Record<string, unknown>) {
                            opts.signCalls?.push(config);
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
                            return Object.assign(iterate(slice), {
                                destroy() {
                                    if (opts.destroyed) opts.destroyed.count++;
                                },
                            }) as unknown as NodeJS.ReadableStream & AsyncIterable<Buffer>;
                        },
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

describe("gcsStore: headObject", () => {
    test("maps metadata (string size) to ObjectMetadata", async () => {
        const store = gcsStore({ storage: mockStorage(), bucket: "b" });
        const meta = await store.headObject("doc.pdf");

        expect(meta.contentLength).toBe(20);
        expect(meta.etag).toBe(ETAG);
        expect(meta.lastModified).toBe(new Date("2025-06-28T12:00:00.000Z").toUTCString());
    });

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
        const reads: unknown[] = [];
        const store = gcsStore({ storage: mockStorage({ reads }), bucket: "b" });

        await expect(
            store.getObject("doc.pdf", { ifMatch: "stale-etag" }),
        ).rejects.toBeInstanceOf(ObjectChangedError);
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
        await expect(
            store.getObject("doc.pdf", { ifMatch: "different-etag", pin: meta.pin }),
        ).rejects.toBeInstanceOf(ObjectChangedError);
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
        await expect(
            store.getObject("doc.pdf", { ifMatch: "stale-etag", pin: etaglessPin }),
        ).rejects.toBeInstanceOf(ObjectChangedError);
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

        await result.body.cancel();
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
        await result.body.cancel();
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
        await result.body.cancel();
    });

    test("invalid digest values yield undefined, never an error", async () => {
        // Hex, truncated base64, a composite multipart-style value, and a
        // wrong-length string must all be discarded: only the raw base64 of
        // a 32-byte SHA-256 is a valid Repr-Digest payload.
        const invalid = [
            "deadbeef",
            DIGEST.slice(0, 20),
            `${DIGEST}-2`,
            "not a digest at all",
        ];
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
        const signCalls: Array<Record<string, unknown>> = [];
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
        const signCalls: Array<Record<string, unknown>> = [];
        const store = gcsStore({ storage: mockStorage({ signCalls }), bucket: "b" });

        const result = await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 });

        expect(result.ok).toBe(true);
        // A signed URL bypasses the serve route's security headers; the redirect
        // target must never render a stored HTML/SVG polyglot inline.
        expect(signCalls[0]?.responseType).toBe("application/octet-stream");
        expect(String(signCalls[0]?.responseDisposition)).toContain("attachment");
    });

    test("a hostile filename never reaches the signed disposition unsanitized", async () => {
        const signCalls: Array<Record<string, unknown>> = [];
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
        const signCalls: Array<Record<string, unknown>> = [];
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
        const signCalls: Array<Record<string, unknown>> = [];
        const store = gcsStore({ storage: mockStorage({ signCalls }), bucket: "b" });

        await store.createSignedUrl!("doc.pdf", {
            expiresInSeconds: 60,
            cacheControl: "private, no-cache",
        });

        // The exact signing config: no faked cache-control parameter, and no
        // accidental passthrough of unsupported options.
        expect(Object.keys(signCalls[0] ?? {}).sort()).toEqual([
            "action", "expires", "responseDisposition", "responseType", "version",
        ]);
    });

    test("signer failure returns ok: false with the message (never throws)", async () => {
        const store = gcsStore({
            storage: mockStorage({ signError: new Error("no signing credentials") }),
            bucket: "b",
        });

        const result = await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 });
        expect(result).toEqual({ ok: false, error: "no signing credentials" });
    });
});
