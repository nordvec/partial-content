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

function infoResponse(record: Record<string, unknown>) {
    return { Body: new TextEncoder().encode(JSON.stringify(record)) };
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

        expect(uploadToken.length).toBeGreaterThan(0);
        expect(sent[0].name).toBe("CreateMultipartUploadCommand");
        expect(sent[0].input).toMatchObject({ Bucket: "docs", Key: "reports/q4.pdf" });
        // checksums are opt-in; the default sends no checksum parameters
        expect(sent[0].input.ChecksumAlgorithm).toBeUndefined();
        expect(sent[0].input.ChecksumType).toBeUndefined();

        expect(sent[1].name).toBe("PutObjectCommand");
        expect(String(sent[1].input.Key)).toBe(`.uploads/${uploadToken}.info`);
        const record = JSON.parse(String(sent[1].input.Body)) as Record<string, unknown>;
        expect(record).toEqual({ length: 10, metadata: { filename: "q4.pdf" }, createdAt: NOW });
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
            store.appendChunk(uploadToken, 0, body, { maxBytes: 4, now: NOW }),
        ).rejects.toThrow(/invalidated/);

        expect(sent.filter((c) => c.name === "UploadPartCommand")).toHaveLength(0);
        expect(JSON.parse(storedInfo!).invalidated).toBe(true);

        const state = await store.getUploadState(uploadToken);
        expect(state.isInvalidated).toBe(true);
    });

    test("a body ending exactly at maxBytes is accepted", async () => {
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({ Parts: [], IsTruncated: false }),
            },
            { storeOpts: { minPartSize: 8 } },
        );

        const result = await store.appendChunk(uploadToken, 0, new Uint8Array(4), { maxBytes: 4, now: NOW });
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
    test("lifts the tail sidecar as the size-exempt final part and reaps the sidecars", async () => {
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

        // the tail sidecar is deleted BEFORE the completion commits, so a
        // failed completion cannot double-count the lifted bytes
        const deletePartIndex = sent.findIndex(
            (c) => c.name === "DeleteObjectCommand" && String(c.input.Key).endsWith(".part"),
        );
        const completeIndex = sent.findIndex((c) => c.name === "CompleteMultipartUploadCommand");
        expect(deletePartIndex).toBeGreaterThan(-1);
        expect(deletePartIndex).toBeLessThan(completeIndex);

        const complete = sent[completeIndex];
        expect((complete.input.MultipartUpload as { Parts: unknown[] }).Parts).toEqual([
            { PartNumber: 1, ETag: '"e1"' },
            { PartNumber: 2, ETag: '"tail-etag"' },
        ]);

        // the metadata sidecar is reaped after publication
        const deleteInfoIndex = sent.findIndex(
            (c) => c.name === "DeleteObjectCommand" && String(c.input.Key).endsWith(".info"),
        );
        expect(deleteInfoIndex).toBeGreaterThan(completeIndex);
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

    test("a completion retried after full cleanup answers from the published object alone", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({}),
            HeadObjectCommand: (input) => {
                if (String(input.Key) === "docs/file.bin") return { ContentLength: 42, ETag: '"pub"' };
                throw notFound("NotFound");
            },
        });

        const result = await store.completeUpload(uploadToken, { now: NOW });

        expect(result.etag).toBe('"pub"');
        expect(sent.some((c) => c.name === "CompleteMultipartUploadCommand")).toBe(false);
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
            AbortMultipartUploadCommand: () => { throw s3Error("InternalError", 500); },
        });

        await expect(store.abortUpload(uploadToken)).rejects.toThrow("InternalError");
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

    test("a reaped .info with a published final object still answers completed state", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({}),
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
        // the published object's LastModified stands in for the reaped createdAt
        expect(state.createdAt).toBe(NOW + 1);
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
});

// ─── SDK body shapes ────────────────────────────────────────────────────────

describe("s3UploadStore: sidecar body shapes", () => {
    test("an SDK mixin body (transformToByteArray) is read", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => ({
                    Body: {
                        transformToByteArray: async () =>
                            new TextEncoder().encode(JSON.stringify({ createdAt: NOW, length: 3 })),
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
        const json = JSON.stringify({ createdAt: NOW, length: 8 });
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
