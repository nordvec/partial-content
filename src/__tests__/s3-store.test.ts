import { describe, test, expect, mock, beforeEach } from "bun:test";
import { s3Store, ObjectChangedError, StoreUnavailableError } from "../s3";
import { nodeStreamToWeb } from "../object-store";
import { OPEN_ENDED } from "../index";
import type { ObjectStore } from "../index";

// ─── Mock S3Client ──────────────────────────────────────────────────────────

/**
 * Minimal S3Client mock that captures commands and returns controlled responses.
 */
function createMockS3Client(responses: {
    head?: Partial<{
        ContentLength: number;
        ETag: string;
        LastModified: Date;
    }>;
    get?: Partial<{
        Body: ReadableStream<Uint8Array>;
        ContentLength: number;
        ContentRange: string;
        ETag: string;
        LastModified: Date;
        ChecksumSHA256: string;
    }>;
}) {
    const sentCommands: Array<{ name: string; input: unknown }> = [];

    const client = {
        send: mock(async (command: { constructor: { name: string }; input: unknown }) => {
            sentCommands.push({ name: command.constructor.name, input: command.input });

            if (command.constructor.name === "HeadObjectCommand") {
                return {
                    ContentLength: 10000,
                    ETag: '"abc123"',
                    LastModified: new Date("2025-06-28T12:00:00Z"),
                    ...responses.head,
                };
            }

            if (command.constructor.name === "GetObjectCommand") {
                return {
                    Body: new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new Uint8Array([1, 2, 3]));
                            controller.close();
                        },
                    }),
                    ContentLength: 10000,
                    ETag: '"abc123"',
                    LastModified: new Date("2025-06-28T12:00:00Z"),
                    ...responses.get,
                };
            }

            throw new Error(`Unexpected command: ${command.constructor.name}`);
        }),
    };

    return { client: client as unknown as import("@aws-sdk/client-s3").S3Client, sentCommands };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("s3Store", () => {
    test("headObject returns correct metadata", async () => {
        const { client } = createMockS3Client({
            head: {
                ContentLength: 5000,
                ETag: '"hash123"',
                LastModified: new Date("2025-06-28T12:00:00Z"),
            },
        });

        const store = s3Store({ client, bucket: "documents" });
        const meta = await store.headObject("reports/q4.pdf");

        expect(meta.contentLength).toBe(5000);
        expect(meta.etag).toBe('"hash123"');
        expect(meta.lastModified).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
    });

    test("headObject sends HeadObjectCommand with correct bucket and key", async () => {
        const { client, sentCommands } = createMockS3Client({});
        const store = s3Store({ client, bucket: "my-bucket" });

        await store.headObject("path/to/file.pdf");

        expect(sentCommands).toHaveLength(1);
        expect(sentCommands[0].name).toBe("HeadObjectCommand");
        expect(sentCommands[0].input).toMatchObject({
            Bucket: "my-bucket",
            Key: "path/to/file.pdf",
        });
    });

    test("getObject without range sends no Range header", async () => {
        const { client, sentCommands } = createMockS3Client({});
        const store = s3Store({ client, bucket: "docs" });

        const result = await store.getObject("file.pdf");

        expect(sentCommands[0].name).toBe("GetObjectCommand");
        expect((sentCommands[0].input as Record<string, unknown>).Range).toBeUndefined();
        expect(result.contentLength).toBe(10000);
        expect(result.totalSize).toBe(10000);
        expect(result.body).toBeInstanceOf(ReadableStream);
    });

    test("getObject with range sends bytes=start-end header", async () => {
        const { client, sentCommands } = createMockS3Client({
            get: {
                ContentLength: 500,
                ContentRange: "bytes 0-499/10000",
            },
        });
        const store = s3Store({ client, bucket: "docs" });

        const result = await store.getObject("file.pdf", { range: { start: 0, end: 499 } });

        expect((sentCommands[0].input as Record<string, unknown>).Range).toBe("bytes=0-499");
        expect(result.contentLength).toBe(500);
        expect(result.range).toEqual({ start: 0, end: 499 });
    });

    test("getObject with an OPEN_ENDED range emits the bare open form on the wire", async () => {
        // The fast path hands adapters `end: OPEN_ENDED`; the wire form MUST
        // be `bytes=500-`, never a literal 16-digit last-byte-pos that a
        // strict proxy or backend may reject.
        const { client, sentCommands } = createMockS3Client({
            get: {
                ContentLength: 9500,
                ContentRange: "bytes 500-9999/10000",
            },
        });
        const store = s3Store({ client, bucket: "docs" });

        const result = await store.getObject("file.pdf", { range: { start: 500, end: OPEN_ENDED } });

        expect((sentCommands[0].input as Record<string, unknown>).Range).toBe("bytes=500-");
        expect(result.range).toEqual({ start: 500, end: 9999 });
        expect(result.totalSize).toBe(10000);
    });

    test("getObject parses totalSize from ContentRange when available", async () => {
        const { client } = createMockS3Client({
            get: {
                ContentLength: 500,
                ContentRange: "bytes 0-499/25000",
            },
        });
        const store = s3Store({ client, bucket: "docs" });

        const result = await store.getObject("file.pdf", { range: { start: 0, end: 499 } });

        expect(result.totalSize).toBe(25000);
    });

    test("supportsRange is true", () => {
        const { client } = createMockS3Client({});
        const store = s3Store({ client, bucket: "docs" });

        expect(store.supportsRange).toBe(true);
    });

    test("createSignedUrl returns ok result", async () => {
        // Note: getSignedUrl is an external function from @aws-sdk/s3-request-presigner
        // which we cannot easily mock in this test. We verify the API shape instead.
        const store = s3Store({
            client: createMockS3Client({}).client,
            bucket: "docs",
        });

        expect(store.createSignedUrl).toBeDefined();
    });

    test("getObject forwards ifMatch as the S3 IfMatch condition", async () => {
        const { client, sentCommands } = createMockS3Client({});
        const store = s3Store({ client, bucket: "documents" });
        await store.getObject("reports/q4.pdf", { ifMatch: '"abc123"' });

        const get = sentCommands.find((c) => c.name === "GetObjectCommand");
        expect((get?.input as { IfMatch?: string }).IfMatch).toBe('"abc123"');
    });

    test("412 PreconditionFailed maps to ObjectChangedError", async () => {
        const { client } = createMockS3Client({});
        (client as unknown as { send: (c: unknown) => Promise<unknown> }).send = async () => {
            const err = new Error("At least one of the pre-conditions you specified did not hold");
            err.name = "PreconditionFailed";
            (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 412 };
            throw err;
        };
        const store = s3Store({ client, bucket: "documents" });

        await expect(
            store.getObject("reports/q4.pdf", { ifMatch: '"stale"' }),
        ).rejects.toBeInstanceOf(ObjectChangedError);
    });

    test("503 SlowDown on GET maps to StoreUnavailableError (retryable, not 502)", async () => {
        const { client } = createMockS3Client({});
        (client as unknown as { send: (c: unknown) => Promise<unknown> }).send = async () => {
            const err = new Error("Please reduce your request rate.");
            err.name = "SlowDown";
            (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 503 };
            throw err;
        };
        const store = s3Store({ client, bucket: "documents" });

        await expect(store.getObject("reports/q4.pdf")).rejects.toBeInstanceOf(StoreUnavailableError);
    });

    test("SDK $retryable.throttling on HEAD maps to StoreUnavailableError", async () => {
        const { client } = createMockS3Client({});
        (client as unknown as { send: (c: unknown) => Promise<unknown> }).send = async () => {
            throw Object.assign(new Error("throttled"), { $retryable: { throttling: true } });
        };
        const store = s3Store({ client, bucket: "documents" });

        await expect(store.headObject("reports/q4.pdf")).rejects.toBeInstanceOf(StoreUnavailableError);
    });
});

describe("nodeStreamToWeb", () => {
    test("converts async iterable to ReadableStream", async () => {
        async function* generate() {
            yield new Uint8Array([1, 2, 3]);
            yield new Uint8Array([4, 5, 6]);
        }

        const stream = nodeStreamToWeb(generate());
        const reader = stream.getReader();

        const chunk1 = await reader.read();
        expect(chunk1.done).toBe(false);
        expect(chunk1.value).toEqual(new Uint8Array([1, 2, 3]));

        const chunk2 = await reader.read();
        expect(chunk2.done).toBe(false);
        expect(chunk2.value).toEqual(new Uint8Array([4, 5, 6]));

        const end = await reader.read();
        expect(end.done).toBe(true);
    });

    test("mid-iteration error destroys underlying node stream and errors the web stream", async () => {
        const destroyed = { called: false };
        async function* generate(): AsyncGenerator<Uint8Array> {
            yield new Uint8Array([1]);
            throw new Error("backend read failed");
        }

        const stream = nodeStreamToWeb(generate(), {
            destroy: () => { destroyed.called = true; },
        });
        const reader = stream.getReader();

        const first = await reader.read();
        expect(first.value).toEqual(new Uint8Array([1]));

        await expect(reader.read()).rejects.toThrow("backend read failed");
        // One macrotask so the rejected pull's cleanup has run.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(destroyed.called).toBe(true);
    });

    test("expectedBytes: a short (truncated) stream errors instead of closing", async () => {
        async function* gen(): AsyncGenerator<Uint8Array> {
            yield new Uint8Array([1, 2, 3]); // 3 bytes, but 10 promised
        }
        const stream = nodeStreamToWeb(gen(), { expectedBytes: 10 });
        const reader = stream.getReader();

        const first = await reader.read();
        expect(first.value).toEqual(new Uint8Array([1, 2, 3]));
        // The graceful end under-ran the promised length -> the body errors
        // rather than closing short under a committed Content-Length.
        await expect(reader.read()).rejects.toThrow(/expected 10/);
    });

    test("expectedBytes: an exact-length stream closes normally", async () => {
        async function* gen(): AsyncGenerator<Uint8Array> {
            yield new Uint8Array([1, 2, 3, 4, 5]);
        }
        const stream = nodeStreamToWeb(gen(), { expectedBytes: 5 });
        const chunks: Uint8Array[] = [];
        const reader = stream.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    });

    test("cancel destroys underlying node stream", async () => {
        const destroyed = { called: false };
        async function* generate(): AsyncGenerator<Uint8Array> {
            yield new Uint8Array([1]);
            // Should never reach here if cancelled
            yield new Uint8Array([2]);
        }

        const stream = nodeStreamToWeb(generate(), {
            destroy: () => { destroyed.called = true; },
        });

        await stream.cancel("test cancel");
        expect(destroyed.called).toBe(true);
    });
});

// ─── Repr-Digest whole-object safety ────────────────────────────────────────

const WHOLE_OBJECT_SHA256 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="; // 43 base64 chars + pad

describe("s3Store: Repr-Digest is whole-object only", () => {
    test("a full 200 carries the checksum as digest", async () => {
        const { client } = createMockS3Client({
            get: { ChecksumSHA256: WHOLE_OBJECT_SHA256 },
        });
        const store = s3Store({ client, bucket: "docs" });
        const result = await store.getObject("file.pdf");
        expect(result.digest).toBe(WHOLE_OBJECT_SHA256);
    });

    test("a 206 ranged response suppresses the checksum (may be range-scoped)", async () => {
        const { client } = createMockS3Client({
            get: {
                ContentLength: 500,
                ContentRange: "bytes 0-499/10000",
                ChecksumSHA256: WHOLE_OBJECT_SHA256,
            },
        });
        const store = s3Store({ client, bucket: "docs" });
        const result = await store.getObject("file.pdf", { range: { start: 0, end: 499 } });
        // Repr-Digest MUST hash the full representation; a checksum on a 206 is
        // not provably whole-object on a non-conforming backend, so it is dropped.
        expect(result.digest).toBeUndefined();
    });
});

// ─── Degenerate response symmetry ───────────────────────────────────────────

describe("s3Store: null ContentLength on GET", () => {
    test("throws (symmetric with headObject) instead of fabricating a zero-length body", async () => {
        // A live body with no ContentLength would otherwise commit
        // `Content-Length: 0` over real bytes. headObject already throws here.
        const { client } = createMockS3Client({
            get: {
                Body: new ReadableStream<Uint8Array>({
                    start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); },
                }),
                ContentLength: undefined,
            },
        });
        const store = s3Store({ client, bucket: "docs" });
        await expect(store.getObject("file.pdf")).rejects.toThrow(/no ContentLength/);
    });
});

// ─── Committed-length guard on the web-stream branches ──────────────────────

describe("s3Store: committed-length guard", () => {
    test("a web-stream Body that ends short of ContentLength errors the stream", async () => {
        const client = createMockS3Client({
            get: {
                // Body delivers 3 bytes but the SDK reports 10: a torn body that
                // ended cleanly-but-short must error, not under-run the response.
                Body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array([1, 2, 3]));
                        controller.close();
                    },
                }),
                ContentLength: 10,
            },
        });
        const store = s3Store({ client: client.client, bucket: "b" });
        const result = await store.getObject("doc");
        const chunks: Uint8Array[] = [];
        await expect((async () => {
            for await (const c of result.body) chunks.push(c);
        })()).rejects.toThrow(/expected 10/);
    });
});

// ─── Body-shape fallbacks (toWebStream branches) ────────────────────────────

describe("s3Store: SDK body shapes", () => {
    test("SdkStream with transformToWebStream is unwrapped", async () => {
        const bytes = new TextEncoder().encode("sdk-body");
        const client = createMockS3Client({
            get: {
                Body: {
                    transformToWebStream: () => new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(bytes);
                            controller.close();
                        },
                    }),
                } as unknown as ReadableStream<Uint8Array>,
                ContentLength: 8,
            },
        });
        const store = s3Store({ client: client.client, bucket: "b" });
        const result = await store.getObject("doc");

        const chunks: Uint8Array[] = [];
        for await (const c of result.body) chunks.push(c);
        expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("sdk-body");
    });

    test("Node Readable body falls back to nodeStreamToWeb and destroy is wired", async () => {
        let destroyed = 0;
        async function* iterate(): AsyncGenerator<Uint8Array> {
            yield new TextEncoder().encode("node-body");
        }
        const nodeBody = Object.assign(iterate(), {
            destroy() { destroyed++; },
        });
        const client = createMockS3Client({
            get: {
                Body: nodeBody as unknown as ReadableStream<Uint8Array>,
                ContentLength: 9,
            },
        });
        const store = s3Store({ client: client.client, bucket: "b" });
        const result = await store.getObject("doc");
        await result.body.cancel();

        expect(destroyed).toBe(1);
    });
});

// ─── createSignedUrl (presigner mocked at module level) ─────────────────────

describe("s3Store: createSignedUrl", () => {
    test("returns ok with a presigned URL and forwards the disposition", async () => {
        const seen: Array<{ input: Record<string, unknown>; expiresIn?: number }> = [];
        mock.module("@aws-sdk/s3-request-presigner", () => ({
            getSignedUrl: async (
                _client: unknown,
                command: { input: Record<string, unknown> },
                opts?: { expiresIn?: number },
            ) => {
                seen.push({ input: command.input, expiresIn: opts?.expiresIn });
                return "https://bucket.s3.example/doc?signature=abc";
            },
        }));

        const client = createMockS3Client({});
        const store = s3Store({ client: client.client, bucket: "b" });
        const result = await store.createSignedUrl!("doc.pdf", {
            expiresInSeconds: 120,
            downloadFilename: "Quarterly Report.pdf",
        });

        expect(result).toEqual({ ok: true, url: "https://bucket.s3.example/doc?signature=abc" });
        expect(seen[0]?.expiresIn).toBe(120);
        expect(String(seen[0]?.input.ResponseContentDisposition)).toContain("attachment");
        expect(String(seen[0]?.input.ResponseContentDisposition)).toContain("Quarterly Report.pdf");
        // Inert content type prevents an inline polyglot rendering off the redirect target.
        expect(seen[0]?.input.ResponseContentType).toBe("application/octet-stream");
    });

    test("forces attachment + inert content type even without a downloadFilename", async () => {
        const seen: Array<{ input: Record<string, unknown> }> = [];
        mock.module("@aws-sdk/s3-request-presigner", () => ({
            getSignedUrl: async (_client: unknown, command: { input: Record<string, unknown> }) => {
                seen.push({ input: command.input });
                return "https://bucket.s3.example/doc?signature=abc";
            },
        }));

        const client = createMockS3Client({});
        const store = s3Store({ client: client.client, bucket: "b" });
        const result = await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 });

        expect(result.ok).toBe(true);
        // A signed URL bypasses the serve route's security headers; the redirect
        // target must never render a stored HTML/SVG polyglot inline.
        expect(seen[0]?.input.ResponseContentType).toBe("application/octet-stream");
        expect(String(seen[0]?.input.ResponseContentDisposition)).toContain("attachment");
    });

    test("cacheControl override rides the signed response, absent when unset", async () => {
        const seen: Array<{ input: Record<string, unknown> }> = [];
        mock.module("@aws-sdk/s3-request-presigner", () => ({
            getSignedUrl: async (_client: unknown, command: { input: Record<string, unknown> }) => {
                seen.push({ input: command.input });
                return "https://bucket.s3.example/doc?signature=abc";
            },
        }));

        const client = createMockS3Client({});
        const store = s3Store({ client: client.client, bucket: "b" });

        await store.createSignedUrl!("doc.pdf", {
            expiresInSeconds: 60,
            cacheControl: "private, no-cache",
        });
        expect(seen[0]?.input.ResponseCacheControl).toBe("private, no-cache");

        await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 });
        expect("ResponseCacheControl" in (seen[1]?.input ?? {})).toBe(false);
    });

    test("presigner failure returns ok: false with the message (never throws)", async () => {
        mock.module("@aws-sdk/s3-request-presigner", () => ({
            getSignedUrl: async () => { throw new Error("credentials expired"); },
        }));

        const client = createMockS3Client({});
        const store = s3Store({ client: client.client, bucket: "b" });
        const result = await store.createSignedUrl!("doc.pdf", { expiresInSeconds: 60 });

        expect(result).toEqual({ ok: false, error: "credentials expired" });
    });
});
