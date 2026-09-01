import { describe, test, expect, mock } from "bun:test";
import {
    s3UploadStore,
    StoreUnavailableError,
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadDigestMismatchError,
} from "../s3";

const MiB = 1024 * 1024;
const NOW = 1_700_000_000_000;
const DIGEST = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const OTHER_DIGEST = "57DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

// ─── Mock S3Client ──────────────────────────────────────────────────────────

interface SentCommand {
    name: string;
    input: Record<string, unknown>;
}

type CommandHandler = (input: Record<string, unknown>) => unknown;

function s3Error(name: string, status: number): Error {
    const err = new Error(name);
    err.name = name;
    (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: status };
    return err;
}

const notFound = (name = "NoSuchKey") => s3Error(name, 404);

/**
 * Minimal S3Client mock: `send` records every command and dispatches to a
 * per-command-name handler returning a canned response (same pattern as the
 * read-adapter suite, generalized to the multipart command set).
 */
function createMockClient(handlers: Record<string, CommandHandler>) {
    const sent: SentCommand[] = [];
    const client = {
        send: mock(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
            const name = command.constructor.name;
            sent.push({ name, input: command.input });
            const handler = handlers[name];
            if (!handler) throw new Error(`Unexpected command: ${name}`);
            return handler(command.input);
        }),
    };
    return { client: client as unknown as import("@aws-sdk/client-s3").S3Client, sent };
}

/** GetObject handler routing on sidecar suffix (.info / .part / final key). */
function routeGetObject(routes: {
    info?: CommandHandler;
    part?: CommandHandler;
    other?: CommandHandler;
}): CommandHandler {
    return (input) => {
        const key = String(input.Key);
        if (key.endsWith(".info")) {
            if (!routes.info) throw notFound();
            return routes.info(input);
        }
        if (key.endsWith(".part")) {
            if (!routes.part) throw notFound();
            return routes.part(input);
        }
        if (!routes.other) throw notFound("NotFound");
        return routes.other(input);
    };
}

/**
 * A sidecar body. `key` and `uploadId` are what the store addresses the backend
 * with -- the token carries neither -- so they default to what
 * `createStoreWithUpload` creates; a test wanting another destination overrides
 * them explicitly.
 */
function infoResponse(record: Record<string, unknown>) {
    return {
        Body: new TextEncoder().encode(JSON.stringify({
            key: "docs/file.bin",
            uploadId: "mp-1",
            ...record,
        })),
    };
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

/**
 * Build a store and a real token via createUpload (proving the round trip in
 * every test), then reset the command log so assertions target only the
 * operation under test.
 */
async function createStoreWithUpload(
    handlers: Record<string, CommandHandler>,
    opts?: {
        storeOpts?: Partial<Parameters<typeof s3UploadStore>[0]>;
        key?: string;
        length?: number;
        metadata?: Record<string, string>;
    },
) {
    const { client, sent } = createMockClient({
        CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
        PutObjectCommand: () => ({}),
        ...handlers,
    });
    const store = s3UploadStore({ client, bucket: "b", ...opts?.storeOpts });
    const { uploadToken } = await store.createUpload({
        key: opts?.key ?? "docs/file.bin",
        now: NOW,
        ...(opts?.length !== undefined ? { length: opts.length } : {}),
        ...(opts?.metadata !== undefined ? { metadata: opts.metadata } : {}),
    });
    sent.length = 0;
    return { store, sent, uploadToken };
}

// ─── Creation + token round trip ────────────────────────────────────────────

describe("s3UploadStore: creation and token round trip", () => {
    test("createUpload starts a multipart upload and records creation facts in the .info sidecar", async () => {
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-123" }),
            PutObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "docs" });

        const { uploadToken } = await store.createUpload({
            key: "reports/q4.pdf",
            length: 10,
            metadata: { filename: "q4.pdf" },
            now: NOW,
        });

        // The token is the resource id and nothing else: the destination key
        // and the multipart id live in the sidecar, so a client never learns
        // the key it publishes under and can never name one.
        expect(uploadToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(uploadToken).not.toContain("q4");
        expect(sent[0].name).toBe("CreateMultipartUploadCommand");
        expect(sent[0].input).toMatchObject({ Bucket: "docs", Key: "reports/q4.pdf" });
        // checksums are opt-in; the default sends no checksum parameters
        expect(sent[0].input.ChecksumAlgorithm).toBeUndefined();
        expect(sent[0].input.ChecksumType).toBeUndefined();

        expect(sent[1].name).toBe("PutObjectCommand");
        expect(String(sent[1].input.Key)).toBe(`.uploads/${uploadToken}.info`);
        const record = JSON.parse(String(sent[1].input.Body)) as Record<string, unknown>;
        expect(record).toEqual({
            key: "reports/q4.pdf",
            uploadId: "mp-123",
            length: 10,
            metadata: { filename: "q4.pdf" },
            createdAt: NOW,
        });
    });

    test("the returned token decodes back to the key and UploadId on later calls", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW, length: 10 }) }),
            ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
            HeadObjectCommand: () => { throw notFound("NotFound"); },
        });

        const state = await store.getUploadState(uploadToken);

        const listParts = sent.find((c) => c.name === "ListPartsCommand");
        expect(listParts?.input).toMatchObject({ Key: "docs/file.bin", UploadId: "mp-1" });
        expect(state.offset).toBe(0);
        expect(state.length).toBe(10);
        expect(state.createdAt).toBe(NOW);
        expect(state.isComplete).toBe(false);
        expect(state.isInvalidated).toBe(false);
    });

    test("a failed .info write reaps the multipart upload instead of leaking it", async () => {
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-9" }),
            PutObjectCommand: () => { throw s3Error("InternalError", 500); },
            AbortMultipartUploadCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b" });

        await expect(store.createUpload({ key: "k.bin", now: NOW })).rejects.toThrow("InternalError");
        const abort = sent.find((c) => c.name === "AbortMultipartUploadCommand");
        expect(abort?.input).toMatchObject({ Key: "k.bin", UploadId: "mp-9" });
    });

    test("uploadPrefix is normalized with a trailing slash", async () => {
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
            PutObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b", uploadPrefix: "stash" });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });

        const put = sent.find((c) => c.name === "PutObjectCommand");
        expect(String(put?.input.Key)).toBe(`stash/${uploadToken}.info`);
    });
});

// ─── Offset derivation ──────────────────────────────────────────────────────

describe("s3UploadStore: offset derivation", () => {
    test("offset = paginated ListParts sum + the .part sidecar's HEAD size", async () => {
        let listCalls = 0;
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => {
                listCalls += 1;
                if (listCalls === 1) {
                    return {
                        Parts: [{ PartNumber: 1, Size: 5 * MiB, ETag: '"e1"' }],
                        IsTruncated: true,
                        NextPartNumberMarker: "1",
                    };
                }
                return { Parts: [{ PartNumber: 2, Size: 5 * MiB, ETag: '"e2"' }], IsTruncated: false };
            },
            HeadObjectCommand: (input) => {
                if (String(input.Key).endsWith(".part")) return { ContentLength: 2 * MiB };
                throw notFound("NotFound");
            },
        });

        const state = await store.getUploadState(uploadToken);

        expect(state.offset).toBe(12 * MiB);
        expect(listCalls).toBe(2);
        const secondList = sent.filter((c) => c.name === "ListPartsCommand")[1];
        expect(secondList.input.PartNumberMarker).toBe("1");
    });

    test("state carries the recorded creation facts through (length, metadata, lastAppendAt)", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({
                    createdAt: NOW,
                    length: 99,
                    lastAppendAt: NOW + 7,
                    metadata: { filename: "a.bin" },
                }),
            }),
            ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
            HeadObjectCommand: () => { throw notFound("NotFound"); },
        });

        const state = await store.getUploadState(uploadToken);

        expect(state.length).toBe(99);
        expect(state.lastAppendAt).toBe(NOW + 7);
        expect(state.metadata).toEqual({ filename: "a.bin" });
    });

    test("a ListParts page missing part number/size fails loudly instead of miscounting", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => ({ Parts: [{ PartNumber: 1 }], IsTruncated: false }),
        });

        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/without number\/size/);
    });

    test("a truncated ListParts page without a continuation marker fails loudly", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => ({ Parts: [{ PartNumber: 1, Size: 4, ETag: '"e"' }], IsTruncated: true }),
        });

        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/NextPartNumberMarker/);
    });

    test("an absent .part sidecar contributes zero", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => ({ Parts: [{ PartNumber: 1, Size: 7, ETag: '"e"' }], IsTruncated: false }),
            HeadObjectCommand: () => { throw notFound("NotFound"); },
        });

        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(7);
    });
});

// ─── Append buffering ───────────────────────────────────────────────────────

describe("s3UploadStore: appendChunk", () => {
    test("a 12 MiB body at the 5 MiB floor becomes two full parts plus a 2 MiB tail sidecar", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
            UploadPartCommand: () => ({ ETag: '"p"' }),
        });

        const body = new Uint8Array(12 * MiB);
        for (let i = 0; i < body.length; i++) body[i] = i % 251;

        const result = await store.appendChunk(uploadToken, 0, body, { now: NOW + 5 });

        expect(result.bytesWritten).toBe(12 * MiB);
        const parts = sent.filter((c) => c.name === "UploadPartCommand");
        expect(parts).toHaveLength(2);
        expect(parts[0].input.PartNumber).toBe(1);
        expect(parts[1].input.PartNumber).toBe(2);
        for (const [index, part] of parts.entries()) {
            const partBody = part.input.Body as Uint8Array;
            expect(partBody.byteLength).toBe(5 * MiB);
            expect(Buffer.compare(
                Buffer.from(partBody),
                Buffer.from(body.subarray(index * 5 * MiB, (index + 1) * 5 * MiB)),
            )).toBe(0);
        }

        const tailPut = sent.find(
            (c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"),
        );
        const tailBody = tailPut?.input.Body as Uint8Array;
        expect(tailBody.byteLength).toBe(2 * MiB);
        expect(Buffer.compare(Buffer.from(tailBody), Buffer.from(body.subarray(10 * MiB)))).toBe(0);

        // the append is recorded on the metadata sidecar
        const infoPut = sent.find(
            (c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"),
        );
        expect(JSON.parse(String(infoPut?.input.Body)).lastAppendAt).toBe(NOW + 5);
    });

    test("an existing tail is downloaded, deleted, prepended, and part numbering continues", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({
                    info: () => infoResponse({ createdAt: NOW }),
                    part: () => ({ Body: bytesOf("abc") }),
                }),
                ListPartsCommand: () => ({
                    Parts: [
                        { PartNumber: 1, Size: 8, ETag: '"e1"' },
                        { PartNumber: 2, Size: 8, ETag: '"e2"' },
                    ],
                    IsTruncated: false,
                }),
                UploadPartCommand: () => ({ ETag: '"e3"' }),
                DeleteObjectCommand: () => ({}),
            },
            { storeOpts: { minPartSize: 8 } },
        );

        // durable offset: 16 committed + 3 tail = 19
        const result = await store.appendChunk(uploadToken, 19, bytesOf("defghijkl"), { now: NOW });

        // only the 9 incoming bytes count; the prepended tail was already durable
        expect(result.bytesWritten).toBe(9);

        const deleteIndex = sent.findIndex(
            (c) => c.name === "DeleteObjectCommand" && String(c.input.Key).endsWith(".part"),
        );
        const partIndex = sent.findIndex((c) => c.name === "UploadPartCommand");
        expect(deleteIndex).toBeGreaterThan(-1);
        expect(deleteIndex).toBeLessThan(partIndex);

        const uploadPart = sent[partIndex];
        expect(uploadPart.input.PartNumber).toBe(3);
        expect(new TextDecoder().decode(uploadPart.input.Body as Uint8Array)).toBe("abcdefgh");

        const newTail = sent.find(
            (c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"),
        );
        expect(new TextDecoder().decode(newTail?.input.Body as Uint8Array)).toBe("ijkl");
    });

    test("a claimed offset that disagrees with derived state throws UploadOffsetConflictError before any write", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({
                    info: () => infoResponse({ createdAt: NOW }),
                    part: () => ({ Body: bytesOf("abc") }),
                }),
                ListPartsCommand: () => ({
                    Parts: [
                        { PartNumber: 1, Size: 8, ETag: '"e1"' },
                        { PartNumber: 2, Size: 8, ETag: '"e2"' },
                    ],
                    IsTruncated: false,
                }),
            },
            { storeOpts: { minPartSize: 8 } },
        );

        const err = await store.appendChunk(uploadToken, 10, bytesOf("x"), { now: NOW }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(19);
        expect(sent.some((c) => c.name === "UploadPartCommand" || c.name === "DeleteObjectCommand")).toBe(false);
    });

    test("crossing maxBytes durably invalidates before throwing, and the flag is readable afterwards", async () => {
        let storedInfo: string | undefined = JSON.stringify({ createdAt: NOW });
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({
                    info: () => {
                        if (storedInfo === undefined) throw notFound();
                        return { Body: new TextEncoder().encode(storedInfo) };
                    },
                }),
                PutObjectCommand: (input) => {
                    if (String(input.Key).endsWith(".info")) storedInfo = String(input.Body);
                    return {};
                },
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
                HeadObjectCommand: () => { throw notFound("NotFound"); },
            },
            { storeOpts: { minPartSize: 8 } },
        );

        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(3));
                controller.enqueue(new Uint8Array(3)); // cumulative 6 > maxBytes 4
                controller.close();
            },
        });

        await expect(
            store.appendChunk(uploadToken, 0, body, { maxBytes: 4, maxBytesFatal: true, now: NOW }),
        ).rejects.toThrow(/invalidated/);

        expect(sent.filter((c) => c.name === "UploadPartCommand")).toHaveLength(0);
        expect(JSON.parse(storedInfo!).invalidated).toBe(true);

        const state = await store.getUploadState(uploadToken);
        expect(state.isInvalidated).toBe(true);
    });

    test("a stale holder's sidecar write cannot un-invalidate the resource", async () => {
        // Sidecar writes are read-modify-writes with no precondition, and the
        // snapshot an append holds is read before the body streams. A holder
        // whose lock was stolen would otherwise write back a record from
        // before the invalidation, and `invalidated` lives only here: nothing
        // recomputes it, so the resurrection is permanent and silent.
        let storedInfo = JSON.stringify({
            key: "docs/file.bin",
            uploadId: "mp-1",
            createdAt: NOW,
        });
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({
                    info: () => ({ Body: new TextEncoder().encode(storedInfo) }),
                }),
                PutObjectCommand: (input) => {
                    if (String(input.Key).endsWith(".info")) storedInfo = String(input.Body);
                    return {};
                },
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
                HeadObjectCommand: () => { throw notFound("NotFound"); },
                UploadPartCommand: () => ({ ETag: '"e"' }),
            },
            { storeOpts: { minPartSize: 8 } },
        );

        // Enqueued lazily, so the flip lands AFTER appendChunk's pre-stream
        // read has taken its snapshot: that snapshot is the stale one, and it
        // is what the sidecar write at the end would otherwise be built from.
        let pulls = 0;
        const stalebody = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pulls++ === 0) {
                    controller.enqueue(new Uint8Array(4));
                    // A newer holder invalidates the resource while this body
                    // is still streaming: the window the lock cannot cover.
                    storedInfo = JSON.stringify({
                        key: "docs/file.bin",
                        uploadId: "mp-1",
                        createdAt: NOW,
                        invalidated: true,
                    });
                    return;
                }
                controller.close();
            },
        });

        await store.appendChunk(uploadToken, 0, stalebody, { now: NOW });

        expect(JSON.parse(storedInfo).invalidated).toBe(true);
        expect((await store.getUploadState(uploadToken)).isInvalidated).toBe(true);
    });

    test("crossing S3's 10,000-part limit fails loudly, naming the minPartSize knob, before completion", async () => {
        // One committed part already sits at the ceiling; the next flush would
        // be part 10,001, which S3 rejects opaquely at completion. The store
        // must surface it here instead, with the liftable cause.
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({
                    Parts: [{ PartNumber: 10_000, Size: 8, ETag: '"e"' }],
                    IsTruncated: false,
                }),
                UploadPartCommand: () => ({ ETag: '"p"' }),
                HeadObjectCommand: () => { throw notFound("NotFound"); },
            },
            { storeOpts: { minPartSize: 8 } },
        );

        // Offset 8 matches the one committed part; 8 more bytes flush one part.
        const err = await store
            .appendChunk(uploadToken, 8, new Uint8Array(8), { now: NOW })
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/10,?000-part limit/);
        expect((err as Error).message).toMatch(/minPartSize/);
        // The crossing part was never uploaded.
        expect(sent.filter((c) => c.name === "UploadPartCommand")).toHaveLength(0);
    });

    test("a body ending exactly at maxBytes is accepted", async () => {
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
            },
            { storeOpts: { minPartSize: 8 } },
        );

        const result = await store.appendChunk(uploadToken, 0, new Uint8Array(4), { maxBytes: 4, maxBytesFatal: true, now: NOW });
        expect(result.bytesWritten).toBe(4);
    });

    test("an aborted signal stops reading, parks the received prefix durably, and reports it truthfully", async () => {
        const cancelled = { called: false };
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
            },
            { storeOpts: { minPartSize: 8 } },
        );

        const controller = new AbortController();
        controller.abort();
        const body = new ReadableStream<Uint8Array>({
            start(streamController) {
                streamController.enqueue(bytesOf("hello"));
                streamController.enqueue(bytesOf("world"));
            },
            cancel() {
                cancelled.called = true;
            },
        });

        const result = await store.appendChunk(uploadToken, 0, body, { now: NOW, signal: controller.signal });

        // only the first chunk was pulled before the abort check tripped
        expect(result.bytesWritten).toBe(5);
        const tailPut = sent.find(
            (c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"),
        );
        expect(new TextDecoder().decode(tailPut?.input.Body as Uint8Array)).toBe("hello");
        expect(cancelled.called).toBe(true);
    });

    test("a signal that trips mid-chunk still lands the whole accepted chunk, and the tail stays sub-minimum", async () => {
        // The stolen-lock ceiling is a bound on BYTES, not on backend calls:
        // the store stops pulling from the body at the chunk boundary, and
        // whatever it had already accepted becomes durable. Stopping part-way
        // through the shaping would make exactly the same bytes durable in a
        // worse arrangement, since the remainder is parked in the tail sidecar
        // whose own contract is that it holds LESS than one part.
        const controller = new AbortController();
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
                PutObjectCommand: () => ({}),
                UploadPartCommand: () => {
                    // The watchdog fires while the first part is in flight.
                    controller.abort();
                    return { ETag: '"e"' };
                },
            },
            { storeOpts: { minPartSize: 8 } },
        );

        // One chunk of four parts plus a remainder.
        const result = await store.appendChunk(uploadToken, 0, new Uint8Array(35), {
            now: NOW,
            signal: controller.signal,
        });

        expect(result.bytesWritten).toBe(35);
        expect(sent.filter((c) => c.name === "UploadPartCommand")).toHaveLength(4);
        const tailPut = sent.find(
            (c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"),
        );
        expect((tailPut?.input.Body as Uint8Array).length).toBe(3);
    });

    test("a torn body keeps the received prefix instead of surfacing as a storage fault", async () => {
        // The client vanished mid-request. Storage never failed, so reporting
        // this as a backend error hands the caller a 502 for something the
        // backend never saw, and throws away a truthful durable offset the
        // client could have resumed from.
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
            },
            { storeOpts: { minPartSize: 8 } },
        );
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytesOf("hello"));
            },
            pull(controller) {
                controller.error(new Error("connection reset"));
            },
        });

        const result = await store.appendChunk(uploadToken, 0, body, {
            now: NOW, maxBytesFatal: true,
        });

        expect(result.bytesWritten).toBe(5);
        const tailPut = sent.find(
            (c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"),
        );
        expect(new TextDecoder().decode(tailPut?.input.Body as Uint8Array)).toBe("hello");
    });

    test("a backend failure during a flush still propagates", async () => {
        // The other half of the split: separating body reads from flushes must
        // not swallow a real storage failure into a truncated-but-fine answer.
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
                UploadPartCommand: () => { throw s3Error("InternalError", 500); },
            },
            { storeOpts: { minPartSize: 4 } },
        );

        await expect(store.appendChunk(uploadToken, 0, new Uint8Array(16), {
            now: NOW, maxBytesFatal: true,
        })).rejects.toThrow("InternalError");
    });

    test("appending to an invalidated resource is refused without touching the multipart upload", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW, invalidated: true }),
            }),
        });

        await expect(
            store.appendChunk(uploadToken, 0, bytesOf("x"), { now: NOW }),
        ).rejects.toThrow(/invalidated/);
        expect(sent.some((c) => c.name === "ListPartsCommand" || c.name === "UploadPartCommand")).toBe(false);
    });

    test("appending to a reaped resource throws UploadNotFoundError", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({}),
        });

        await expect(
            store.appendChunk(uploadToken, 0, bytesOf("x"), { now: NOW }),
        ).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a gone multipart upload surfaces as UploadNotFoundError", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => { throw notFound("NoSuchUpload"); },
        });

        await expect(
            store.appendChunk(uploadToken, 0, bytesOf("x"), { now: NOW }),
        ).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

// ─── Deferred length ────────────────────────────────────────────────────────

describe("s3UploadStore: deferred-length declaration on append", () => {
    test("a length first declared on an append is written to .info and reported next", async () => {
        let storedInfo = JSON.stringify({ createdAt: NOW });
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({
                    info: () => ({ Body: new TextEncoder().encode(storedInfo) }),
                }),
                PutObjectCommand: (input) => {
                    if (String(input.Key).endsWith(".info")) storedInfo = String(input.Body);
                    return {};
                },
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
                HeadObjectCommand: () => { throw notFound("NotFound"); },
            },
            { storeOpts: { minPartSize: 8 } },
        );

        // Created without a length; the sub-part-size body parks a tail sidecar.
        await store.appendChunk(uploadToken, 0, bytesOf("abc"), { length: 12, now: NOW + 1 });
        expect(JSON.parse(storedInfo).length).toBe(12);

        const state = await store.getUploadState(uploadToken);
        expect(state.length).toBe(12);
    });

    test("a length already recorded at creation is never overwritten by an append", async () => {
        let storedInfo = JSON.stringify({ createdAt: NOW, length: 5 });
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({
                    info: () => ({ Body: new TextEncoder().encode(storedInfo) }),
                }),
                PutObjectCommand: (input) => {
                    if (String(input.Key).endsWith(".info")) storedInfo = String(input.Body);
                    return {};
                },
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
                HeadObjectCommand: () => { throw notFound("NotFound"); },
            },
            { storeOpts: { minPartSize: 8 }, length: 5 },
        );

        await store.appendChunk(uploadToken, 0, bytesOf("abc"), { length: 42, now: NOW + 1 });
        expect(JSON.parse(storedInfo).length).toBe(5);
    });
});

// ─── Completion ─────────────────────────────────────────────────────────────

describe("s3UploadStore: completeUpload", () => {
    test("lifts the tail sidecar as the size-exempt final part, reaps it, and marks the metadata sidecar", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW }),
                part: () => ({ Body: bytesOf("xyz") }),
            }),
            ListPartsCommand: () => ({
                Parts: [{ PartNumber: 1, Size: 5 * MiB, ETag: '"e1"' }],
                IsTruncated: false,
            }),
            UploadPartCommand: () => ({ ETag: '"tail-etag"' }),
            DeleteObjectCommand: () => ({}),
            CompleteMultipartUploadCommand: () => ({ ETag: '"final"' }),
        });

        const result = await store.completeUpload(uploadToken, { now: NOW });

        expect(result.etag).toBe('"final"');
        expect(result.digest).toBeUndefined();

        const uploadPart = sent.find((c) => c.name === "UploadPartCommand");
        expect(uploadPart?.input.PartNumber).toBe(2);
        expect(new TextDecoder().decode(uploadPart?.input.Body as Uint8Array)).toBe("xyz");

        // The tail sidecar is deleted BEFORE its bytes are rewritten into a
        // part, the same ordering appendChunk uses. Asserting only that the
        // delete precedes the COMPLETION is too weak to catch the inversion:
        // committing the part first leaves a window where the tail is both a
        // committed part and a live sidecar, and the derived offset counts it
        // twice - a permanent RangeError under a declared length, and under a
        // deferred one a client that resumes above its real progress while the
        // published object carries those bytes twice. Losing the tail in the
        // reverse window only costs a re-send.
        const deletePartIndex = sent.findIndex(
            (c) => c.name === "DeleteObjectCommand" && String(c.input.Key).endsWith(".part"),
        );
        const uploadPartIndex = sent.findIndex((c) => c.name === "UploadPartCommand");
        const completeIndex = sent.findIndex((c) => c.name === "CompleteMultipartUploadCommand");
        expect(deletePartIndex).toBeGreaterThan(-1);
        expect(deletePartIndex).toBeLessThan(uploadPartIndex);
        expect(uploadPartIndex).toBeLessThan(completeIndex);

        const complete = sent[completeIndex];
        expect((complete.input.MultipartUpload as { Parts: unknown[] }).Parts).toEqual([
            { PartNumber: 1, ETag: '"e1"' },
            { PartNumber: 2, ETag: '"tail-etag"' },
        ]);

        // The metadata sidecar is MARKED after publication, not reaped: it is
        // the only record that this token named this key, and a retried
        // completion or a late probe needs it to answer from the published
        // object rather than from a key the caller supplied.
        const markInfoIndex = sent.findIndex(
            (c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"),
        );
        expect(markInfoIndex).toBeGreaterThan(completeIndex);
        expect(JSON.parse(String(sent[markInfoIndex].input.Body)) as { completed?: boolean })
            .toMatchObject({ completed: true });
    });

    test("a zero-byte upload commits one empty part before completing", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
            UploadPartCommand: () => ({ ETag: '"empty"' }),
            DeleteObjectCommand: () => ({}),
            CompleteMultipartUploadCommand: () => ({ ETag: '"final"' }),
        });

        const result = await store.completeUpload(uploadToken, { now: NOW });

        expect(result.etag).toBe('"final"');
        const uploadPart = sent.find((c) => c.name === "UploadPartCommand");
        expect(uploadPart?.input.PartNumber).toBe(1);
        expect((uploadPart?.input.Body as Uint8Array).byteLength).toBe(0);

        const complete = sent.find((c) => c.name === "CompleteMultipartUploadCommand");
        expect((complete?.input.MultipartUpload as { Parts: unknown[] }).Parts).toEqual([
            { PartNumber: 1, ETag: '"empty"' },
        ]);
    });

    test("completing an invalidated resource is refused", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW, invalidated: true }),
            }),
        });

        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow(/invalidated/);
    });

    test("a completion retried against the completed marker answers from the published object alone", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW, completed: true }),
            }),
            HeadObjectCommand: (input) => {
                if (String(input.Key) === "docs/file.bin") return { ContentLength: 42, ETag: '"pub"' };
                throw notFound("NotFound");
            },
        });

        const result = await store.completeUpload(uploadToken, { now: NOW });

        expect(result.etag).toBe('"pub"');
        expect(sent.some((c) => c.name === "CompleteMultipartUploadCommand")).toBe(false);
    });

    test("a completion with no sidecar answers 404 rather than reporting a backend object", async () => {
        // The key is carried in the client-supplied token and the sidecar is
        // named after the whole token, so the sidecar's existence is the only
        // proof the server minted this key. Answering from the backend without
        // it would report an arbitrary object's ETag as this upload's, and
        // would make the probe an existence oracle over the bucket.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({}),
            HeadObjectCommand: () => ({ ContentLength: 42, ETag: '"someone-elses"' }),
        });

        await expect(store.completeUpload(uploadToken, { now: NOW }))
            .rejects.toBeInstanceOf(UploadNotFoundError);
        expect(sent.some((c) => c.name === "HeadObjectCommand")).toBe(false);
    });

    test("completing a resource that never existed throws UploadNotFoundError", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({}),
            HeadObjectCommand: () => { throw notFound("NotFound"); },
        });

        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a completion retried after the multipart is gone answers idempotently from the published object", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => { throw notFound("NoSuchUpload"); },
            HeadObjectCommand: (input) => {
                if (String(input.Key) === "docs/file.bin") {
                    return { ContentLength: 42, ETag: '"pub"', LastModified: new Date(NOW) };
                }
                throw notFound("NotFound");
            },
            DeleteObjectCommand: () => ({}),
        });

        const result = await store.completeUpload(uploadToken, { now: NOW });

        expect(result.etag).toBe('"pub"');
        expect(sent.some((c) => c.name === "CompleteMultipartUploadCommand")).toBe(false);
        // the crashed completion's leftover sidecars are reaped
        expect(sent.filter((c) => c.name === "DeleteObjectCommand")).toHaveLength(2);
    });
});

// ─── Abort + sweep ──────────────────────────────────────────────────────────

describe("s3UploadStore: abortUpload", () => {
    test("is idempotent across a gone multipart upload and missing sidecars", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            AbortMultipartUploadCommand: () => { throw notFound("NoSuchUpload"); },
            DeleteObjectCommand: () => { throw notFound(); },
        });

        await store.abortUpload(uploadToken);
        await store.abortUpload(uploadToken);

        const deletes = sent.filter((c) => c.name === "DeleteObjectCommand");
        expect(deletes.map((c) => String(c.input.Key)).sort()).toEqual([
            `.uploads/${uploadToken}.info`,
            `.uploads/${uploadToken}.info`,
            `.uploads/${uploadToken}.part`,
            `.uploads/${uploadToken}.part`,
        ]);
    });

    test("a real backend failure still propagates", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            AbortMultipartUploadCommand: () => { throw s3Error("InternalError", 500); },
        });

        await expect(store.abortUpload(uploadToken)).rejects.toThrow("InternalError");
    });

    test("a token this store never minted deletes nothing", async () => {
        // The token is a suffix of the object key, so an abort that skipped the
        // shape check could address `<prefix><anything>.info` and `.part` and
        // reap the foreign objects the sweep deliberately leaves alone. It is a
        // no-op instead, because abort is idempotent for an unknown token and a
        // token that cannot be one is a stronger case of unknown.
        const { store, sent } = await createStoreWithUpload({
            DeleteObjectCommand: () => ({}),
            AbortMultipartUploadCommand: () => ({}),
        });

        await store.abortUpload("../../etc/passwd");
        await store.abortUpload("someone-elses-object");

        expect(sent).toHaveLength(0);
    });

    test("aborting a COMPLETED upload deletes only bookkeeping, never the published object", async () => {
        // Store contract: the object at the key is live data once completion
        // returns, and abort is idempotent, so an abort that reached the key
        // would destroy production data on a replayed or retried DELETE.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW }),
                part: () => ({ Body: bytesOf("xyz") }),
            }),
            ListPartsCommand: () => ({
                Parts: [{ PartNumber: 1, Size: 5 * MiB, ETag: '"e1"' }],
                IsTruncated: false,
            }),
            UploadPartCommand: () => ({ ETag: '"tail-etag"' }),
            DeleteObjectCommand: () => ({}),
            CompleteMultipartUploadCommand: () => ({ ETag: '"final"' }),
            AbortMultipartUploadCommand: () => { throw notFound("NoSuchUpload"); },
        });
        await store.completeUpload(uploadToken, { now: NOW });
        const deletesBefore = sent.filter((c) => c.name === "DeleteObjectCommand").length;

        await store.abortUpload(uploadToken);
        await store.abortUpload(uploadToken);

        const abortDeletes = sent
            .filter((c) => c.name === "DeleteObjectCommand")
            .slice(deletesBefore)
            .map((c) => String(c.input.Key));
        expect(abortDeletes.length).toBeGreaterThan(0);
        expect(abortDeletes.every((k) => k.startsWith(".uploads/"))).toBe(true);
        expect(abortDeletes).not.toContain("docs/file.bin");
    });
});

describe("s3UploadStore: sweepExpired", () => {
    test("aborts only idle .info resources and skips foreign objects", async () => {
        let oldToken = "";
        let newToken = "";
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: (input) => ({
                UploadId: String(input.Key) === "old.bin" ? "mp-old" : "mp-new",
            }),
            PutObjectCommand: () => ({}),
            ListObjectsV2Command: () => ({
                Contents: [
                    { Key: `.uploads/${oldToken}.info`, LastModified: new Date(NOW - 100_000) },
                    { Key: `.uploads/${newToken}.info`, LastModified: new Date(NOW) },
                    { Key: ".uploads/stray.txt", LastModified: new Date(0) },
                    // decodes to no upload: skipped, not fatal
                    { Key: ".uploads/garbage.info", LastModified: new Date(0) },
                ],
                IsTruncated: false,
            }),
            // The multipart an abort discards is named by the sidecar, never by
            // the token, so the sweep has to read one per resource it reaps.
            GetObjectCommand: (input) => {
                const key = String(input.Key);
                if (key === `.uploads/${oldToken}.info`) {
                    return infoResponse({ key: "old.bin", uploadId: "mp-old", createdAt: NOW - 100_000 });
                }
                if (key === `.uploads/${newToken}.info`) {
                    return infoResponse({ key: "new.bin", uploadId: "mp-new", createdAt: NOW });
                }
                throw notFound();
            },
            AbortMultipartUploadCommand: () => ({}),
            DeleteObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b" });
        ({ uploadToken: oldToken } = await store.createUpload({ key: "old.bin", now: NOW - 100_000 }));
        ({ uploadToken: newToken } = await store.createUpload({ key: "new.bin", now: NOW }));
        sent.length = 0;

        const result = await store.sweepExpired!(NOW - 50_000);

        expect(result.removed).toBe(1);
        const aborts = sent.filter((c) => c.name === "AbortMultipartUploadCommand");
        expect(aborts).toHaveLength(1);
        expect(aborts[0].input).toMatchObject({ Key: "old.bin", UploadId: "mp-old" });
        const list = sent.find((c) => c.name === "ListObjectsV2Command");
        expect(list?.input.Prefix).toBe(".uploads/");
    });

    test("a resource whose last activity sits exactly at the cutoff is kept", async () => {
        let token = "";
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
            PutObjectCommand: () => ({}),
            ListObjectsV2Command: () => ({
                Contents: [{ Key: `.uploads/${token}.info`, LastModified: new Date(NOW) }],
                IsTruncated: false,
            }),
        });
        const store = s3UploadStore({ client, bucket: "b" });
        ({ uploadToken: token } = await store.createUpload({ key: "k.bin", now: NOW }));
        sent.length = 0;

        const result = await store.sweepExpired!(NOW);

        expect(result.removed).toBe(0);
        expect(sent.some((c) => c.name === "AbortMultipartUploadCommand")).toBe(false);
    });

    test("paginates the listing via the continuation token", async () => {
        let token = "";
        let listCalls = 0;
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
            PutObjectCommand: () => ({}),
            ListObjectsV2Command: () => {
                listCalls += 1;
                if (listCalls === 1) {
                    return { Contents: [], IsTruncated: true, NextContinuationToken: "page-2" };
                }
                return {
                    Contents: [{ Key: `.uploads/${token}.info`, LastModified: new Date(NOW - 10) }],
                    IsTruncated: false,
                };
            },
            AbortMultipartUploadCommand: () => ({}),
            DeleteObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b" });
        ({ uploadToken: token } = await store.createUpload({ key: "k.bin", now: NOW - 10 }));
        sent.length = 0;

        const result = await store.sweepExpired!(NOW);

        expect(result.removed).toBe(1);
        const secondList = sent.filter((c) => c.name === "ListObjectsV2Command")[1];
        expect(secondList.input.ContinuationToken).toBe("page-2");
    });
});

// ─── Post-completion disambiguation ─────────────────────────────────────────

describe("s3UploadStore: gone-multipart disambiguation", () => {
    for (const errorName of ["NoSuchUpload", "NoSuchKey"]) {
        test(`ListParts ${errorName} with a published final object reads as completed state`, async () => {
            const { store, uploadToken } = await createStoreWithUpload({
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => { throw notFound(errorName); },
                HeadObjectCommand: (input) => {
                    if (String(input.Key) === "docs/file.bin") {
                        return { ContentLength: 42, ETag: '"pub"', LastModified: new Date(NOW) };
                    }
                    throw notFound("NotFound");
                },
            });

            const state = await store.getUploadState(uploadToken);

            expect(state.isComplete).toBe(true);
            expect(state.offset).toBe(42);
            expect(state.length).toBe(42);
            expect(state.createdAt).toBe(NOW);
            expect(state.isInvalidated).toBe(false);
        });
    }

    test("a completed marker with a published final object answers completed state", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW, completed: true }),
            }),
            HeadObjectCommand: (input) => {
                if (String(input.Key) === "docs/file.bin") {
                    return { ContentLength: 7, ETag: '"pub"', LastModified: new Date(NOW + 1) };
                }
                throw notFound("NotFound");
            },
        });

        const state = await store.getUploadState(uploadToken);

        expect(state.isComplete).toBe(true);
        expect(state.offset).toBe(7);
    });

    test("a reaped .info answers 404 and never probes the token's key", async () => {
        // Once the bookkeeping is gone nothing proves this token named this
        // key, so the published object is not this upload's to report. A probe
        // here would answer for any key a caller named: existence, exact size
        // and last-modified across the whole bucket, read with the
        // application's own credentials.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({}),
            HeadObjectCommand: () => ({ ContentLength: 7, ETag: '"someone-elses"' }),
        });

        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(sent.some((c) => c.name === "HeadObjectCommand")).toBe(false);
    });

    test("no .info and no published object means the upload never existed", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({}),
            HeadObjectCommand: () => { throw notFound("NotFound"); },
        });

        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test(".info present but multipart and final object both gone means externally aborted", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => { throw notFound("NoSuchUpload"); },
            HeadObjectCommand: () => { throw notFound("NotFound"); },
        });

        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a malformed token is an unknown upload and touches no backend", async () => {
        const { client, sent } = createMockClient({});
        const store = s3UploadStore({ client, bucket: "b" });

        await expect(store.getUploadState("!!!not-a-token!!!")).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(sent).toHaveLength(0);
    });

    test("a well-formed token with empty key or uploadId is an unknown upload", async () => {
        const { client, sent } = createMockClient({});
        const store = s3UploadStore({ client, bucket: "b" });
        const craft = (payload: Record<string, unknown>) =>
            btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

        await expect(store.getUploadState(craft({ key: "", uploadId: "u" })))
            .rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.getUploadState(craft({ key: "k", uploadId: "" })))
            .rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.getUploadState(craft({ key: "k" })))
            .rejects.toBeInstanceOf(UploadNotFoundError);
        expect(sent).toHaveLength(0);
    });

    test("a corrupt metadata sidecar fails loudly instead of reading as not-found", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => ({ Body: bytesOf("{not json") }) }),
        });

        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/unparseable JSON/);
    });

    test("a metadata sidecar without a numeric createdAt fails loudly", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ length: 5 }) }),
        });

        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/numeric createdAt/);
    });

    // The sidecar is the ONLY source of the destination now that the token
    // carries none, so a record that cannot address the backend has to be
    // refused rather than half-used with a guessed or absent key.
    const unaddressable: Array<[string, string]> = [
        ["no key", JSON.stringify({ uploadId: "mp-1", createdAt: NOW })],
        ["an empty key", JSON.stringify({ key: "", uploadId: "mp-1", createdAt: NOW })],
        ["a non-string key", JSON.stringify({ key: 7, uploadId: "mp-1", createdAt: NOW })],
        ["no uploadId", JSON.stringify({ key: "docs/file.bin", createdAt: NOW })],
        ["an empty uploadId", JSON.stringify({ key: "docs/file.bin", uploadId: "", createdAt: NOW })],
        ["a non-string uploadId", JSON.stringify({ key: "docs/file.bin", uploadId: 7, createdAt: NOW })],
    ];
    for (const [label, body] of unaddressable) {
        test(`a metadata sidecar with ${label} fails loudly`, async () => {
            const { store, sent, uploadToken } = await createStoreWithUpload({
                GetObjectCommand: routeGetObject({ info: () => ({ Body: bytesOf(body) }) }),
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
                HeadObjectCommand: () => ({ ContentLength: 1, ETag: '"x"' }),
            });

            await expect(store.getUploadState(uploadToken)).rejects.toThrow(/key\/uploadId/);
            // Refused before the record is used to name anything.
            expect(sent.some((c) => c.name === "ListPartsCommand")).toBe(false);
            expect(sent.some((c) => c.name === "HeadObjectCommand")).toBe(false);
        });
    }

    test("a sidecar that is valid JSON but not an object fails loudly", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => ({ Body: bytesOf("null") }) }),
        });

        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/numeric createdAt/);
    });

    test("a sidecar whose createdAt is non-finite fails loudly", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            // Infinity has no JSON literal, so it arrives as the string 1e999.
            GetObjectCommand: routeGetObject({
                info: () => ({ Body: bytesOf('{"key":"docs/file.bin","uploadId":"mp-1","createdAt":1e999}') }),
            }),
        });

        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/numeric createdAt/);
    });
});

// ─── SDK body shapes ────────────────────────────────────────────────────────

describe("s3UploadStore: sidecar body shapes", () => {
    test("an SDK mixin body (transformToByteArray) is read", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => ({
                    Body: {
                        transformToByteArray: async () => new TextEncoder().encode(
                            JSON.stringify({ key: "docs/file.bin", uploadId: "mp-1", createdAt: NOW, length: 3 }),
                        ),
                    },
                }),
            }),
            ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
            HeadObjectCommand: () => { throw notFound("NotFound"); },
        });

        const state = await store.getUploadState(uploadToken);
        expect(state.length).toBe(3);
    });

    test("an async-iterable (Node Readable) body is collected across chunks", async () => {
        const json = JSON.stringify({ key: "docs/file.bin", uploadId: "mp-1", createdAt: NOW, length: 8 });
        async function* iterate(): AsyncGenerator<Uint8Array> {
            yield bytesOf(json.slice(0, 5));
            yield bytesOf(json.slice(5));
        }
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => ({ Body: iterate() }) }),
            ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
            HeadObjectCommand: () => { throw notFound("NotFound"); },
        });

        const state = await store.getUploadState(uploadToken);
        expect(state.length).toBe(8);
    });

    test("a missing sidecar body shape fails loudly", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => ({ Body: 42 }) }),
        });

        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/unsupported response body shape/);
    });
});

// ─── Checksums opt-in ───────────────────────────────────────────────────────

describe("s3UploadStore: checksums opt-in (per-part transport integrity)", () => {
    test("createUpload carries ChecksumAlgorithm SHA256 with the COMPOSITE type", async () => {
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
            PutObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b", checksums: true });
        await store.createUpload({ key: "k.bin", now: NOW });

        expect(sent[0].input.ChecksumAlgorithm).toBe("SHA256");
        // COMPOSITE, never FULL_OBJECT: multipart SHA-256 is composite-only,
        // so a full-object type would be rejected at creation.
        expect(sent[0].input.ChecksumType).toBe("COMPOSITE");
    });

    test("appendChunk part uploads carry ChecksumAlgorithm SHA256", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
                UploadPartCommand: () => ({ ETag: '"p"' }),
            },
            { storeOpts: { minPartSize: 4, checksums: true } },
        );

        await store.appendChunk(uploadToken, 0, bytesOf("abcdef"), { now: NOW });

        const part = sent.find((c) => c.name === "UploadPartCommand");
        expect(part?.input.ChecksumAlgorithm).toBe("SHA256");
    });

    test("completion restates per-part checksums but asserts no whole-object digest", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({
                    Parts: [{ PartNumber: 1, Size: 4, ETag: '"p1"', ChecksumSHA256: "cGFydDE=" }],
                    IsTruncated: false,
                }),
                DeleteObjectCommand: () => ({}),
                CompleteMultipartUploadCommand: () => ({ ETag: '"fin"' }),
            },
            { storeOpts: { checksums: true } },
        );

        const result = await store.completeUpload(uploadToken, { now: NOW });

        const complete = sent.find((c) => c.name === "CompleteMultipartUploadCommand");
        expect(complete?.input.ChecksumType).toBeUndefined();
        expect(complete?.input.ChecksumSHA256).toBeUndefined();
        expect((complete?.input.MultipartUpload as { Parts: Array<Record<string, unknown>> }).Parts[0].ChecksumSHA256)
            .toBe("cGFydDE=");
        expect(result.etag).toBe('"fin"');
        expect(result.digest).toBeUndefined();
    });

    test("a checksum-shaped completion failure propagates raw (no digest was asserted)", async () => {
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({
                    Parts: [{ PartNumber: 1, Size: 4, ETag: '"p1"' }],
                    IsTruncated: false,
                }),
                CompleteMultipartUploadCommand: () => { throw s3Error("BadDigest", 400); },
            },
            { storeOpts: { checksums: true } },
        );

        const err = await store.completeUpload(uploadToken, { now: NOW }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(UploadDigestMismatchError);
    });

    test("expectedDigest is a loud caller bug before any command, checksums on or off", async () => {
        for (const checksums of [false, true]) {
            const { store, sent, uploadToken } = await createStoreWithUpload({}, { storeOpts: { checksums } });

            await expect(
                store.completeUpload(uploadToken, { expectedDigest: DIGEST, now: NOW }),
            ).rejects.toThrow(/composite/);
            expect(sent).toHaveLength(0);
        }
    });
});

// ─── Error classification ───────────────────────────────────────────────────

describe("s3UploadStore: throttle classification", () => {
    test("a SlowDown during state derivation maps to StoreUnavailableError", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => { throw s3Error("SlowDown", 503); },
        });

        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(StoreUnavailableError);
    });

    test("a throttled part upload during append maps to StoreUnavailableError", async () => {
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
                UploadPartCommand: () => { throw s3Error("SlowDown", 503); },
            },
            { storeOpts: { minPartSize: 4 } },
        );

        await expect(
            store.appendChunk(uploadToken, 0, bytesOf("abcdef"), { now: NOW }),
        ).rejects.toBeInstanceOf(StoreUnavailableError);
    });
});

// ─── Capability flags ───────────────────────────────────────────────────────

describe("s3UploadStore: capability flags", () => {
    test("flags are honest for the default configuration", () => {
        const { client } = createMockClient({});
        const store = s3UploadStore({ client, bucket: "b" });

        expect(store.appendGranularity).toBe(5 * MiB);
        expect(store.uniformPartSize).toBe(false);
        expect(store.exactOffsetRecovery).toBe(true);
        expect(store.atomicCompletion).toBe(true);
        expect(store.digestOnComplete).toBe(false);
        expect(store.maxAppendSize).toBeUndefined();
    });

    test("digestOnComplete is false regardless of the checksums option (composite-only)", () => {
        const { client } = createMockClient({});
        expect(s3UploadStore({ client, bucket: "b", checksums: true }).digestOnComplete).toBe(false);
        expect(s3UploadStore({ client, bucket: "b" }).digestOnComplete).toBe(false);
    });

    test("appendGranularity follows a custom minPartSize", () => {
        const { client } = createMockClient({});
        expect(s3UploadStore({ client, bucket: "b", minPartSize: 8 }).appendGranularity).toBe(8);
    });

    test("an invalid minPartSize is rejected at construction", () => {
        const { client } = createMockClient({});
        expect(() => s3UploadStore({ client, bucket: "b", minPartSize: 0 })).toThrow(RangeError);
        expect(() => s3UploadStore({ client, bucket: "b", minPartSize: 1.5 })).toThrow(RangeError);
    });
});

describe("the sidecar merge is monotonic in its terminal flags", () => {
    /**
     * A sidecar write is a read-modify-write with no precondition, and the
     * snapshot an append holds was read before the body streamed, which can be
     * minutes. The lock makes that safe for a live holder and not for one whose
     * lock was stolen: such a holder writes back a record from before the new
     * holder's changes. `invalidated` lives only in the sidecar and nothing
     * recomputes it, so re-writing it away resurrects a terminally dead upload.
     *
     * The merge therefore re-reads and treats both terminal flags as one-way.
     * These drive that through appendChunk with a sidecar that CHANGES between
     * the caller's snapshot and the merge's own read.
     */

    /** A `.info` GET that answers with a different record after the first call. */
    function shiftingInfo(first: Record<string, unknown>, thereafter: Record<string, unknown>) {
        let calls = 0;
        return () => {
            calls += 1;
            return infoResponse(calls === 1 ? first : thereafter);
        };
    }

    /** The record the store wrote back to the `.info` sidecar. */
    function writtenInfo(sent: { name: string; input: Record<string, unknown> }[]) {
        const put = sent.filter(
            (c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"),
        ).at(-1);
        if (!put) throw new Error("no .info write");
        return JSON.parse(String(put.input.Body)) as Record<string, unknown>;
    }

    test("an invalidation landing mid-append is not cleared by the append's write-back", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: shiftingInfo({ createdAt: NOW }, { createdAt: NOW, invalidated: true }),
            }),
            ListPartsCommand: () => ({ Parts: [] }),
            UploadPartCommand: () => ({ ETag: '"p1"' }),
            HeadObjectCommand: () => { throw notFound(); },
            DeleteObjectCommand: () => ({}),
        });

        await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5 });

        // Written from the FRESH read, not from the snapshot the append opened with.
        expect(writtenInfo(sent).invalidated).toBe(true);
    });

    test("a completion landing mid-append is not cleared either", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: shiftingInfo({ createdAt: NOW }, { createdAt: NOW, completed: true }),
            }),
            ListPartsCommand: () => ({ Parts: [] }),
            UploadPartCommand: () => ({ ETag: '"p1"' }),
            HeadObjectCommand: () => { throw notFound(); },
            DeleteObjectCommand: () => ({}),
        });

        await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5 });

        expect(writtenInfo(sent).completed).toBe(true);
    });

    test("a length already recorded by the winner survives the loser's write-back", async () => {
        // Creation facts and a recorded length are write-once by contract, so
        // the fresh copy either equals the caller's or is the one that won.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: shiftingInfo({ createdAt: NOW }, { createdAt: NOW, length: 99 }),
            }),
            ListPartsCommand: () => ({ Parts: [] }),
            UploadPartCommand: () => ({ ETag: '"p1"' }),
            HeadObjectCommand: () => { throw notFound(); },
            DeleteObjectCommand: () => ({}),
        });

        // This append declares 50; the sidecar already records 99, so the
        // recorded one stands and the late declaration does not overwrite it.
        await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 50 });

        expect(writtenInfo(sent).length).toBe(99);
    });

    test("an unchanged sidecar still records the append, so the merge is not inert", async () => {
        // The positive half: without it, a merge mutated to write nothing at all
        // passes every case above.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => ({ Parts: [] }),
            UploadPartCommand: () => ({ ETag: '"p1"' }),
            HeadObjectCommand: () => { throw notFound(); },
            DeleteObjectCommand: () => ({}),
        });

        await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5 });

        const written = writtenInfo(sent);
        expect(written.lastAppendAt).toBe(NOW + 5);
        expect(written.invalidated).toBeUndefined();
        expect(written.completed).toBeUndefined();
    });

    test("a sidecar read that fails leaves the caller's snapshot as the base", async () => {
        // The fallback is no worse than writing from the snapshot unconditionally,
        // which is the floor the merge replaced; the monotonic rules still apply
        // to whatever it holds.
        let calls = 0;
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => {
                    calls += 1;
                    if (calls > 1) throw new Error("sidecar read failed");
                    return infoResponse({ createdAt: NOW });
                },
            }),
            ListPartsCommand: () => ({ Parts: [] }),
            UploadPartCommand: () => ({ ETag: '"p1"' }),
            HeadObjectCommand: () => { throw notFound(); },
            DeleteObjectCommand: () => ({}),
        });

        await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5 });

        expect(writtenInfo(sent).createdAt).toBe(NOW);
    });
});
