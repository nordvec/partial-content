import { describe, test, expect, mock } from "bun:test";
import { checkResumableWriteStore } from "../conformance";
import { parkedBody } from "../parked-body";
import { isCorruptUploadState } from "../upload-internals";
import {
    s3UploadStore,
    StoreUnavailableError,
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadDestinationConflictError,
    UploadDigestMismatchError,
    UploadAppendBoundError,
    s3Store,
    ObjectNotFoundError,
} from "../s3";
import { createUploadOrchestrator } from "../upload-orchestrator";
import type { S3Client } from "@aws-sdk/client-s3";
import { completeDurable } from "./helpers";

const MiB = 1024 * 1024;
const NOW = 1_700_000_000_000;
/** A seal at 42 bytes over a key that was empty when it was written. */
const SEALED_42 = { length: 42, destination: null };
const DIGEST = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

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
 * How the mock answers the store's one-time conditional-write probes: the
 * sidecar probe (a create-only empty PutObject twice, then a delete) and the
 * publish probe (an empty multipart canary committed under If-None-Match: *,
 * then a second one committed over it under If-None-Match: * and under
 * If-Match on a tag nothing carries, then an abort and a delete). Both name
 * a `.part` key. `honoured` refuses the second create and both conditional
 * commits over the canary with a 412, `ignored` accepts them, and either way
 * the probes stay out of `sent`; `passthrough` hands them to the handlers
 * like any other command.
 */
type CasProbeAnswer = "honoured" | "ignored" | "passthrough";

const CANARY_COMMANDS = new Set([
    "CreateMultipartUploadCommand",
    "UploadPartCommand",
    "CompleteMultipartUploadCommand",
    "AbortMultipartUploadCommand",
]);

const NOT_A_PROBE = Symbol("not a probe");

/**
 * Minimal S3Client mock: `send` records every command and dispatches to a
 * per-command-name handler returning a canned response (same pattern as the
 * read-adapter suite, generalized to the multipart command set).
 */
function createMockClient(handlers: Record<string, CommandHandler>, casProbe: CasProbeAnswer = "honoured") {
    const sent: SentCommand[] = [];
    const canaries = new Set<string>();
    /** A conditional create of a canary: refused when it exists and the bucket honours the condition. */
    const createCanary = <T>(key: string, answer: T): T => {
        if (canaries.has(key) && casProbe === "honoured") throw s3Error("PreconditionFailed", 412);
        canaries.add(key);
        return answer;
    };
    /** The answer to a probe command, or NOT_A_PROBE for a command the handlers answer. */
    const answerProbe = (name: string, input: Record<string, unknown>): unknown => {
        const key = String(input.Key);
        if (name === "PutObjectCommand" && input.Body === "" && input.IfNoneMatch === "*") return createCanary(key, {});
        if (name === "DeleteObjectCommand" && canaries.delete(key)) return {};
        // The store sends multipart commands to a `.part` name only for the publish probe.
        if (!CANARY_COMMANDS.has(name) || !key.endsWith(".part")) return NOT_A_PROBE;
        if (name === "CreateMultipartUploadCommand") return { UploadId: `canary-${canaries.size}` };
        if (name === "UploadPartCommand") return { ETag: '"canary-part"' };
        if (name === "CompleteMultipartUploadCommand") return createCanary(key, { ETag: '"canary"' });
        return {};
    };
    const client = {
        send: mock(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
            const name = command.constructor.name;
            if (casProbe !== "passthrough") {
                const probed = answerProbe(name, command.input);
                if (probed !== NOT_A_PROBE) return probed;
            }
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

/** A client backed by an in-memory object map, so what the upload store writes can be read back. */
function objectBackedClient() {
    const objects = new Map<string, Uint8Array>();
    return createMockClient({
        CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
        PutObjectCommand: (input) => {
            const body = input.Body;
            objects.set(String(input.Key), typeof body === "string" ? bytesOf(body) : (body as Uint8Array));
            return { ETag: `"e${objects.size}"` };
        },
        GetObjectCommand: (input) => {
            const body = objects.get(String(input.Key));
            if (!body) throw notFound();
            return { Body: body, ETag: '"e1"', ContentLength: body.length };
        },
        HeadObjectCommand: (input) => {
            const body = objects.get(String(input.Key));
            if (!body) throw notFound("NotFound");
            return { ContentLength: body.length, ETag: '"e1"' };
        },
        ListPartsCommand: () => ({ Parts: [] }),
    });
}

/**
 * A sidecar body. `key` and `uploadId` are what the store addresses the backend
 * with -- the token carries neither -- so they default to what
 * `createStoreWithUpload` creates; a test wanting another destination overrides
 * them explicitly.
 */
function infoResponse(record: Record<string, unknown>) {
    return {
        Body: new TextEncoder().encode(
            JSON.stringify({
                key: "docs/file.bin",
                uploadId: "mp-1",
                ...record,
            }),
        ),
    };
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

const emptyParts: CommandHandler = () => ({ Parts: [], IsTruncated: false });

const headMissing: CommandHandler = () => {
    throw notFound("NotFound");
};

/** The multipart upload no longer exists. */
const goneMultipart: CommandHandler = () => {
    throw notFound("NoSuchUpload");
};

/** A destination object published by the upload whose publication id is "pub-id". */
const publishedObject = (etag: string) => ({
    ContentLength: 42,
    ETag: etag,
    LastModified: new Date(NOW),
    Metadata: { "upload-publication": "pub-id" },
});

/** A sidecar sealed at 42 bytes with a publication id. */
const sealedInfo = () => infoResponse({ createdAt: NOW, publicationId: "pub-id", completing: SEALED_42 });

/** HEAD answers head for the destination key and not-found for every other key. */
const headDestination =
    (head: Record<string, unknown>): CommandHandler =>
    (input) => {
        if (String(input.Key) === "docs/file.bin") return head;
        throw notFound("NotFound");
    };

/** One full 5 MiB part already committed. */
const onePart: CommandHandler = () => ({
    Parts: [{ PartNumber: 1, Size: 5 * MiB, ETag: '"e1"' }],
    IsTruncated: false,
});

/** What completing an upload with a tail sidecar sends beyond the listing and the sidecars. */
const tailCompletion = {
    ListPartsCommand: onePart,
    UploadPartCommand: () => ({ ETag: '"tail-etag"' }),
    DeleteObjectCommand: () => ({}),
    CompleteMultipartUploadCommand: () => ({ ETag: '"final"' }),
};

/** What an append over an empty multipart upload sends beyond the sidecars. */
const appendHandlers = {
    ListPartsCommand: () => ({ Parts: [] }),
    UploadPartCommand: () => ({ ETag: '"p1"' }),
    HeadObjectCommand: () => {
        throw notFound();
    },
    DeleteObjectCommand: () => ({}),
};

/** Two full 8-byte parts committed, with a 3-byte tail sidecar. */
const twoPartsAndTail = {
    GetObjectCommand: routeGetObject({
        info: () => infoResponse({ createdAt: NOW }),
        part: () => ({ Body: bytesOf("abc") }),
    }),
    ListPartsCommand: (): unknown => ({
        Parts: [
            { PartNumber: 1, Size: 8, ETag: '"e1"' },
            { PartNumber: 2, Size: 8, ETag: '"e2"' },
        ],
        IsTruncated: false,
    }),
};

/**
 * A `.info` sidecar held in memory: GET serves its current text and a `.info`
 * PutObject replaces it, with the empty-parts and missing-head answers a
 * sidecar-only upload needs.
 */
function memorySidecar(initial: Record<string, unknown>) {
    const sidecar = {
        text: JSON.stringify(initial),
        get record() {
            return JSON.parse(this.text) as Record<string, unknown>;
        },
    };
    const handlers = {
        GetObjectCommand: routeGetObject({ info: () => ({ Body: bytesOf(sidecar.text) }) }),
        PutObjectCommand: (input: Record<string, unknown>) => {
            if (String(input.Key).endsWith(".info")) sidecar.text = String(input.Body);
            return {};
        },
        ListPartsCommand: emptyParts,
        HeadObjectCommand: headMissing,
    };
    return { sidecar, handlers };
}

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
        // The destination is empty unless a test says otherwise: a completion
        // HEADs it when it seals.
        HeadObjectCommand: headMissing,
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
        // The publication id is minted per upload, set on the multipart upload
        // (so the published object carries it), and recorded beside it.
        const publicationId = (sent[0].input.Metadata as Record<string, string>)["upload-publication"];
        expect(publicationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(publicationId).not.toBe(uploadToken);
        expect(record).toEqual({
            key: "reports/q4.pdf",
            uploadId: "mp-123",
            publicationId,
            length: 10,
            metadata: { filename: "q4.pdf" },
            createdAt: NOW,
            // The part size every part is cut at, fixed for the upload.
            partSize: 5 * 1024 * 1024,
        });
    });

    test("the returned token decodes back to the key and UploadId on later calls", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW, length: 10 }) }),
            ListPartsCommand: emptyParts,
            HeadObjectCommand: headMissing,
        });

        const state = await store.getUploadState(uploadToken);

        const listParts = sent.find((c) => c.name === "ListPartsCommand");
        expect(listParts?.input).toMatchObject({ Key: "docs/file.bin", UploadId: "mp-1" });
        expect(state.offset).toBe(0);
        expect(state.length).toBe(10);
        expect(state.createdAt).toBe(NOW);
        expect(state.status === "complete").toBe(false);
        expect(state.status === "invalidated").toBe(false);
    });

    test("a failed .info write reaps the multipart upload instead of leaking it", async () => {
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-9" }),
            PutObjectCommand: () => {
                throw s3Error("InternalError", 500);
            },
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

    test("state carries the recorded creation facts through (length, metadata)", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () =>
                    infoResponse({
                        createdAt: NOW,
                        length: 99,
                        metadata: { filename: "a.bin" },
                    }),
            }),
            ListPartsCommand: emptyParts,
            HeadObjectCommand: headMissing,
        });

        const state = await store.getUploadState(uploadToken);

        expect(state.length).toBe(99);
        expect(state.lastAppendAt).toBeUndefined();
        expect(state.metadata).toEqual({ filename: "a.bin" });
    });

    test("the last append time is the newest part's or the tail's last write, whichever is later", async () => {
        // A 4.x sidecar's recorded time is not consulted: the sidecar records
        // state changes, so only what an append wrote dates the append.
        const tailWrite = (lastModified: number) => () => ({
            ContentLength: 3,
            LastModified: new Date(lastModified),
            Metadata: { "tail-offset": "8" },
        });
        const stateWith = async (tailLastModified: number) => {
            const { store, uploadToken } = await createStoreWithUpload({
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW, lastAppendAt: NOW }) }),
                ListPartsCommand: () => ({
                    Parts: [
                        { PartNumber: 1, Size: 4, ETag: '"a"', LastModified: new Date(NOW + 20) },
                        { PartNumber: 2, Size: 4, ETag: '"b"', LastModified: new Date(NOW + 10) },
                    ],
                }),
                HeadObjectCommand: tailWrite(tailLastModified),
            });
            return store.getUploadState(uploadToken);
        };

        expect((await stateWith(NOW + 5)).lastAppendAt).toBe(NOW + 20);
        expect((await stateWith(NOW + 30)).lastAppendAt).toBe(NOW + 30);
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

        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/continuation marker/);
    });

    test("an absent .part sidecar contributes zero", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => ({ Parts: [{ PartNumber: 1, Size: 7, ETag: '"e"' }], IsTruncated: false }),
            HeadObjectCommand: headMissing,
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
            ListPartsCommand: emptyParts,
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
            expect(
                Buffer.compare(
                    Buffer.from(partBody),
                    Buffer.from(body.subarray(index * 5 * MiB, (index + 1) * 5 * MiB)),
                ),
            ).toBe(0);
        }

        const tailPut = sent.find((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"));
        const tailBody = tailPut?.input.Body as Uint8Array;
        expect(tailBody.byteLength).toBe(2 * MiB);
        expect(Buffer.compare(Buffer.from(tailBody), Buffer.from(body.subarray(10 * MiB)))).toBe(0);

        // An append that changes no recorded fact leaves the metadata sidecar alone.
        expect(sent.some((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"))).toBe(false);
    });

    test("an existing tail is downloaded, deleted, prepended, and part numbering continues", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                ...twoPartsAndTail,
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

        const newTail = sent.find((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"));
        expect(new TextDecoder().decode(newTail?.input.Body as Uint8Array)).toBe("ijkl");
    });

    test("a claimed offset that disagrees with derived state throws UploadOffsetConflictError before any write", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                ...twoPartsAndTail,
            },
            { storeOpts: { minPartSize: 8 } },
        );

        const err = await store.appendChunk(uploadToken, 10, bytesOf("x"), { now: NOW }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(19);
        expect(sent.some((c) => c.name === "UploadPartCommand" || c.name === "DeleteObjectCommand")).toBe(false);
    });

    test("crossing maxBytes durably invalidates before throwing, and the flag is readable afterwards", async () => {
        const { sidecar, handlers } = memorySidecar({ createdAt: NOW });
        const { store, sent, uploadToken } = await createStoreWithUpload(handlers, { storeOpts: { minPartSize: 8 } });

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
        expect(sidecar.record.invalidated).toBe(true);

        const state = await store.getUploadState(uploadToken);
        expect(state.status === "invalidated").toBe(true);
    });

    test("a stale holder's sidecar write cannot un-invalidate the resource", async () => {
        // Sidecar writes are read-modify-writes with no precondition, and the
        // snapshot an append holds is read before the body streams. A holder
        // whose lock was stolen would otherwise write back a record from
        // before the invalidation, and `invalidated` lives only here: nothing
        // recomputes it, so the resurrection is permanent and silent.
        const { sidecar, handlers } = memorySidecar({ key: "docs/file.bin", uploadId: "mp-1", createdAt: NOW });
        const { store, uploadToken } = await createStoreWithUpload(
            { ...handlers, UploadPartCommand: () => ({ ETag: '"e"' }) },
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
                    sidecar.text = JSON.stringify({
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

        expect(sidecar.record.invalidated).toBe(true);
        expect((await store.getUploadState(uploadToken)).status === "invalidated").toBe(true);
    });

    test("a deferred-length append at S3's 10,000-part limit is a non-fatal bound, before any upload", async () => {
        // One committed part already sits at the ceiling; the next flush would
        // be part 10,001, which S3 rejects opaquely at completion. The store
        // refuses the bytes here instead, and the upload stays completable.
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({
                    Parts: [{ PartNumber: 10_000, Size: 8, ETag: '"e"' }],
                    IsTruncated: false,
                }),
                UploadPartCommand: () => ({ ETag: '"p"' }),
                HeadObjectCommand: headMissing,
            },
            { storeOpts: { minPartSize: 8 } },
        );

        // Offset 8 matches the one committed part; 8 more bytes flush one part.
        const err = await store.appendChunk(uploadToken, 8, new Uint8Array(8), { now: NOW }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UploadAppendBoundError);
        expect((err as UploadAppendBoundError).durableOffset).toBe(8);
        // The crossing part was never uploaded.
        expect(sent.filter((c) => c.name === "UploadPartCommand")).toHaveLength(0);
    });

    test("a body ending exactly at maxBytes is accepted", async () => {
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: emptyParts,
            },
            { storeOpts: { minPartSize: 8 } },
        );

        const result = await store.appendChunk(uploadToken, 0, new Uint8Array(4), {
            maxBytes: 4,
            maxBytesFatal: true,
            now: NOW,
        });
        expect(result.bytesWritten).toBe(4);
    });

    test("a signal already aborted at the door writes nothing, cancels the body, and says it yielded", async () => {
        const cancelled = { called: false };
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: emptyParts,
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

        // The yield was asked for before a byte was read, so nothing was
        // received and nothing is parked: the answer is an interruption with
        // an offset the client can resume from, not a failure to classify.
        expect(result).toEqual({ bytesWritten: 0, interrupted: true });
        const tailPut = sent.find((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"));
        expect(tailPut).toBeUndefined();
        // The body still belongs to someone: leaving it open holds the
        // connection reading until the runtime happens to notice.
        expect(cancelled.called).toBe(true);
    });

    test("with a releaseBody handle, every refusal releases through it, never a second mechanism", async () => {
        for (const [info, offset, signal] of [
            [undefined, 0, undefined],
            [{ createdAt: NOW, invalidated: true }, 0, undefined],
            [{ createdAt: NOW }, 5, undefined],
            [{ createdAt: NOW }, 0, AbortSignal.abort()],
        ] as const) {
            let released = 0;
            let cancelled = false;
            const { store, uploadToken } = await createStoreWithUpload(
                {
                    GetObjectCommand: routeGetObject(info === undefined ? {} : { info: () => infoResponse(info) }),
                    ListPartsCommand: emptyParts,
                },
                { storeOpts: { minPartSize: 8 } },
            );
            const body = new ReadableStream<Uint8Array>({
                pull: (controller) => controller.enqueue(bytesOf("hello")),
                cancel: () => {
                    cancelled = true;
                },
            });
            await store
                .appendChunk(uploadToken, offset, body, {
                    now: NOW,
                    ...(signal ? { signal } : {}),
                    releaseBody: async () => void released++,
                })
                .catch(() => undefined);
            expect(released).toBeGreaterThan(0);
            expect(cancelled).toBe(false);
        }
    });

    test("an append refused before its body is read cancels the body", async () => {
        // Not found, invalidated, or an offset conflict: each refuses before
        // the first byte, and the stream must not stay open until something
        // else happens to release it.
        for (const [info, offset] of [
            [undefined, 0],
            [{ createdAt: NOW, invalidated: true }, 0],
            [{ createdAt: NOW }, 5],
        ] as const) {
            const cancelled = { called: false };
            const { store, uploadToken } = await createStoreWithUpload(
                {
                    GetObjectCommand: routeGetObject(info === undefined ? {} : { info: () => infoResponse(info) }),
                    ListPartsCommand: emptyParts,
                },
                { storeOpts: { minPartSize: 8 } },
            );
            const body = new ReadableStream<Uint8Array>({
                start(streamController) {
                    streamController.enqueue(bytesOf("hello"));
                },
                cancel() {
                    cancelled.called = true;
                },
            });

            await expect(store.appendChunk(uploadToken, offset, body, { now: NOW })).rejects.toBeInstanceOf(Error);
            expect(cancelled.called).toBe(true);
        }
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
                ListPartsCommand: emptyParts,
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
        const tailPut = sent.find((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"));
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
                ListPartsCommand: emptyParts,
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
            now: NOW,
            maxBytesFatal: true,
        });

        expect(result.bytesWritten).toBe(5);
        const tailPut = sent.find((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"));
        expect(new TextDecoder().decode(tailPut?.input.Body as Uint8Array)).toBe("hello");
    });

    test("a backend failure during a flush still propagates", async () => {
        // The other half of the split: separating body reads from flushes must
        // not swallow a real storage failure into a truncated-but-fine answer.
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: emptyParts,
                UploadPartCommand: () => {
                    throw s3Error("InternalError", 500);
                },
            },
            { storeOpts: { minPartSize: 4 } },
        );

        await expect(
            store.appendChunk(uploadToken, 0, new Uint8Array(16), {
                now: NOW,
                maxBytesFatal: true,
            }),
        ).rejects.toThrow("InternalError");
    });

    test("appending to an invalidated resource is refused without touching the multipart upload", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW, invalidated: true }),
            }),
        });

        await expect(store.appendChunk(uploadToken, 0, bytesOf("x"), { now: NOW })).rejects.toThrow(/invalidated/);
        expect(sent.some((c) => c.name === "ListPartsCommand" || c.name === "UploadPartCommand")).toBe(false);
    });

    test("appending to a reaped resource throws UploadNotFoundError", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({}),
        });

        await expect(store.appendChunk(uploadToken, 0, bytesOf("x"), { now: NOW })).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
    });

    test("a gone multipart upload surfaces as UploadNotFoundError", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: goneMultipart,
        });

        await expect(store.appendChunk(uploadToken, 0, bytesOf("x"), { now: NOW })).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
    });
});

// ─── Deferred length ────────────────────────────────────────────────────────

describe("s3UploadStore: deferred-length declaration on append", () => {
    test("a length first declared on an append is written to .info and reported next", async () => {
        const { sidecar, handlers } = memorySidecar({ createdAt: NOW });
        const { store, uploadToken } = await createStoreWithUpload(handlers, { storeOpts: { minPartSize: 8 } });

        // Created without a length; the sub-part-size body parks a tail sidecar.
        await store.appendChunk(uploadToken, 0, bytesOf("abc"), { length: 12, now: NOW + 1 });
        expect(sidecar.record.length).toBe(12);

        const state = await store.getUploadState(uploadToken);
        expect(state.length).toBe(12);
    });

    test("a length already recorded at creation is never overwritten by an append", async () => {
        const { sidecar, handlers } = memorySidecar({ createdAt: NOW, length: 5 });
        const { store, uploadToken } = await createStoreWithUpload(handlers, {
            storeOpts: { minPartSize: 8 },
            length: 5,
        });

        await store.appendChunk(uploadToken, 0, bytesOf("abc"), { length: 42, now: NOW + 1 });
        expect(sidecar.record.length).toBe(5);
    });
});

// ─── Completion ─────────────────────────────────────────────────────────────

describe("s3UploadStore: completeUpload", () => {
    test("a part list that does not add up to the declared length refuses to publish", async () => {
        // Two completions racing each other reach the commit from separate
        // listings, and the loser's list can be short by the tail the winner
        // already lifted into a part. Committing it publishes a TRUNCATED object
        // over the complete one under a success answer, which no caller can
        // detect afterwards. S3 cannot make this check: it was never told what
        // the total should be.
        const { sidecar, handlers } = memorySidecar({
            key: "docs/file.bin",
            uploadId: "mp-1",
            createdAt: NOW,
            length: 5 * MiB + 3,
        });
        const { store, sent, uploadToken } = await createStoreWithUpload({
            ...handlers,
            ListPartsCommand: () => ({
                Parts: [{ PartNumber: 1, Size: 5 * MiB, ETag: '"e1"' }],
                IsTruncated: false,
            }),
            CompleteMultipartUploadCommand: () => ({ ETag: '"final"' }),
        });

        const err = await store
            .completeUpload(uploadToken, { expectedLength: 5 * MiB + 3, now: NOW })
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(5 * MiB);
        expect(sent.some((c) => c.name === "CompleteMultipartUploadCommand")).toBe(false);
        // Sealed before the snapshot, and lifted once the snapshot refused, so
        // the upload stays resumable.
        const infoWrites = sent.filter((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"));
        expect(infoWrites.map((c) => (JSON.parse(String(c.input.Body)) as Record<string, unknown>).completing)).toEqual(
            [{ length: 5 * MiB + 3, destination: null }, undefined],
        );
        expect(sidecar.record.completing).toBeUndefined();
    });

    test("a part list that adds up to the declared length publishes", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW, length: 5 * MiB + 3 }),
                part: () => ({ Body: bytesOf("xyz") }),
            }),
            ...tailCompletion,
        });

        expect((await store.completeUpload(uploadToken, { expectedLength: 5 * MiB + 3, now: NOW })).etag).toBe(
            '"final"',
        );
    });

    test("lifts the tail sidecar as the size-exempt final part, reaps it, and marks the metadata sidecar", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW }),
                part: () => ({ Body: bytesOf("xyz") }),
            }),
            ...tailCompletion,
        });

        const result = await store.completeUpload(uploadToken, { expectedLength: 5 * MiB + 3, now: NOW });

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
        const infoWrites = sent
            .map((c, index) => ({ c, index }))
            .filter(({ c }) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"));
        expect(infoWrites).toHaveLength(2);
        // The seal is on record BEFORE the snapshot is taken: the parts are
        // listed only once appends are fenced, with the destination it found.
        const [sealed, marked] = infoWrites as [(typeof infoWrites)[number], (typeof infoWrites)[number]];
        const listIndex = sent.findIndex((c) => c.name === "ListPartsCommand");
        expect(sealed.index).toBeLessThan(listIndex);
        expect(JSON.parse(String(sealed.c.input.Body)) as Record<string, unknown>).toMatchObject({
            completing: { length: 5 * MiB + 3, destination: null },
        });
        // The key was empty at the seal, so the publish may not land over anything.
        expect(complete.input.IfNoneMatch).toBe("*");
        expect(complete.input.IfMatch).toBeUndefined();
        expect(marked.index).toBeGreaterThan(completeIndex);
        const record = JSON.parse(String(marked.c.input.Body)) as Record<string, unknown>;
        expect(record).toMatchObject({ completed: true, publishedEtag: '"final"' });
    });

    test("a seal that cannot be written stops the completion before its snapshot", async () => {
        // Without the seal appends are not fenced, so no snapshot is a plan
        // that holds every acknowledged byte, and the destination the publish
        // is pinned to is not on record. Nothing is listed or committed.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => ({ Parts: [{ PartNumber: 1, Size: 4, ETag: '"e1"' }], IsTruncated: false }),
            PutObjectCommand: (input) => {
                if (String(input.Key).endsWith(".info") && input.IfNoneMatch === undefined) {
                    throw s3Error("InternalError", 500);
                }
                return {};
            },
            CompleteMultipartUploadCommand: () => ({ ETag: '"final"' }),
        });

        await expect(store.completeUpload(uploadToken, { expectedLength: 4, now: NOW })).rejects.toThrow(
            "InternalError",
        );
        expect(sent.some((c) => c.name === "ListPartsCommand")).toBe(false);
        expect(sent.some((c) => c.name === "CompleteMultipartUploadCommand")).toBe(false);
    });

    test("a zero-byte upload commits one empty part before completing", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: emptyParts,
            UploadPartCommand: () => ({ ETag: '"empty"' }),
            DeleteObjectCommand: () => ({}),
            CompleteMultipartUploadCommand: () => ({ ETag: '"final"' }),
        });

        const result = await store.completeUpload(uploadToken, { expectedLength: 0, now: NOW });

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

        await expect(store.completeUpload(uploadToken, { expectedLength: 0, now: NOW })).rejects.toThrow(/invalidated/);
    });

    test("a completion retried against the completed marker answers from the published object alone", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW, completed: true, publishedEtag: '"pub"' }),
            }),
            HeadObjectCommand: headDestination({ ContentLength: 42, ETag: '"pub"' }),
        });

        const result = await completeDurable(store, uploadToken, { now: NOW });

        expect(result.etag).toBe('"pub"');
        expect(sent.some((c) => c.name === "CompleteMultipartUploadCommand")).toBe(false);
    });

    test("a published ETag the HEAD spells differently from the commit is still this upload's object", async () => {
        // One S3-compatible call quotes the tag and another returns it bare
        // (or weak-prefixed, or in other case): the same entity tag, which
        // must not turn every completed upload into a 404.
        for (const [recorded, headed] of [
            ['"abc-2"', "abc-2"],
            ["abc-2", '"abc-2"'],
            ['"ABC-2"', 'W/"abc-2"'],
        ] as const) {
            const { store, uploadToken } = await createStoreWithUpload({
                GetObjectCommand: routeGetObject({
                    info: () => infoResponse({ createdAt: NOW, completed: true, publishedEtag: recorded }),
                }),
                HeadObjectCommand: () => ({ ContentLength: 42, ETag: headed }),
            });

            const state = await store.getUploadState(uploadToken);
            expect(state.status).toBe("complete");
            expect(state.offset).toBe(42);
        }
    });

    test("a pre-seal publish record adopts no object, however well its shape matches", async () => {
        // A record a build without the publication id wrote before its commit
        // says only what the commit would produce: a size and a part count. A
        // third party's object of that size, with a matching `-N` suffix or
        // none, is indistinguishable by shape, so nothing is adopted and the
        // conflict is reported instead of attested.
        for (const etag of ['"pub-3"', "pub-3", '"no-suffix"']) {
            const { store, sent, uploadToken } = await createStoreWithUpload({
                GetObjectCommand: routeGetObject({
                    info: () => infoResponse({ createdAt: NOW, publishing: { size: 42, parts: 3 } }),
                }),
                ListPartsCommand: goneMultipart,
                HeadObjectCommand: () => ({ ContentLength: 42, ETag: etag }),
                PutObjectCommand: () => ({}),
            });

            await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadDestinationConflictError);
            await expect(store.completeUpload(uploadToken, { expectedLength: 42, now: NOW })).rejects.toBeInstanceOf(
                UploadDestinationConflictError,
            );
            // Never promoted to completed, and the object at the key is untouched.
            expect(
                sent.some(
                    (c) =>
                        c.name === "PutObjectCommand" &&
                        (JSON.parse(String(c.input.Body)) as Record<string, unknown>).completed === true,
                ),
            ).toBe(false);
            expect(sent.some((c) => c.name === "DeleteObjectCommand")).toBe(false);
        }
    });

    test("a completed record whose ETag the object no longer carries names an object that is not ours", async () => {
        // The upload did publish, and something replaced the object since. The
        // replacement is not what this token's bytes became, and answering its
        // ETag would hand the token holder another writer's object.
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW, completed: true, publishedEtag: '"pub"' }),
            }),
            HeadObjectCommand: () => ({ ContentLength: 42, ETag: '"replaced"' }),
        });

        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
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

        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(sent.some((c) => c.name === "HeadObjectCommand")).toBe(false);
    });

    test("completing a resource that never existed throws UploadNotFoundError", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({}),
            HeadObjectCommand: headMissing,
        });

        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a completion retried after the multipart is gone adopts the object carrying its publication id", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: sealedInfo,
            }),
            ListPartsCommand: goneMultipart,
            HeadObjectCommand: headDestination(publishedObject('"pub-3"')),
            DeleteObjectCommand: () => ({}),
        });

        const result = await store.completeUpload(uploadToken, { expectedLength: 42, now: NOW });

        expect(result.etag).toBe('"pub-3"');
        expect(sent.some((c) => c.name === "CompleteMultipartUploadCommand")).toBe(false);
        // The tail sidecar is reaped; the record is promoted to completed, since
        // a late probe still needs it to answer.
        expect(sent.filter((c) => c.name === "DeleteObjectCommand").map((c) => String(c.input.Key))).toEqual([
            `.uploads/${uploadToken}.part`,
        ]);
        const promoted = sent.find((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"));
        expect(JSON.parse(String(promoted?.input.Body)) as Record<string, unknown>).toMatchObject({
            completed: true,
            publishedEtag: '"pub-3"',
        });
    });

    for (const [what, head] of [
        ["no publication id and no multipart suffix", { ContentLength: 42, ETag: '"plain"' }],
        [
            "the sealed size and part count but another id",
            {
                ContentLength: 42,
                ETag: '"pub-3"',
                Metadata: { "upload-publication": "someone-else" },
            },
        ],
    ] as const) {
        test(`a sealed upload whose multipart is gone does not adopt a same-shape object with ${what}`, async () => {
            // The publish response was lost, then a third party wrote the key
            // with an object of exactly the sealed shape. Identity, not shape,
            // decides: the object is someone's data, reported as a conflict.
            const { store, sent, uploadToken } = await createStoreWithUpload({
                GetObjectCommand: routeGetObject({
                    info: sealedInfo,
                }),
                ListPartsCommand: goneMultipart,
                HeadObjectCommand: () => head,
            });

            await expect(store.completeUpload(uploadToken, { expectedLength: 42, now: NOW })).rejects.toBeInstanceOf(
                UploadDestinationConflictError,
            );
            await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadDestinationConflictError);
            expect(sent.some((c) => c.name === "PutObjectCommand")).toBe(false);
            expect(sent.some((c) => c.name === "DeleteObjectCommand")).toBe(false);
        });
    }

    test("a sealed upload whose multipart is gone, with the object the seal recorded unchanged, published nothing", async () => {
        // The seal found an object at the key and recorded its ETag; a
        // lifecycle rule then aborted the multipart upload. The key was never
        // touched, so there is no conflict to report, only a vanished upload.
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () =>
                    infoResponse({
                        createdAt: NOW,
                        publicationId: "pub-id",
                        completing: { length: 42, destination: '"before"' },
                    }),
            }),
            ListPartsCommand: goneMultipart,
            HeadObjectCommand: () => ({ ContentLength: 7, ETag: "before" }),
        });

        await expect(store.completeUpload(uploadToken, { expectedLength: 42, now: NOW })).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a gone multipart with no publish record is an aborted upload, whatever sits at the key", async () => {
        // A replace flow creates the upload over a key that already holds an
        // object, and a lifecycle rule can abort the multipart upload under
        // the live sidecar. Nothing then says this upload published anything,
        // and the object at the key is the one that was there before.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: goneMultipart,
            HeadObjectCommand: () => ({ ContentLength: 42, ETag: '"the-previous-object"' }),
        });

        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(sent.some((c) => c.name === "DeleteObjectCommand")).toBe(false);
    });
});

// ─── Abort + sweep ──────────────────────────────────────────────────────────

describe("s3UploadStore: abortUpload", () => {
    test("is idempotent across a gone multipart upload and missing sidecars", async () => {
        let sidecarPresent = true;
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => {
                    if (!sidecarPresent) throw notFound();
                    return infoResponse({ createdAt: NOW });
                },
            }),
            AbortMultipartUploadCommand: () => {
                throw notFound("NoSuchUpload");
            },
            DeleteObjectCommand: (input) => {
                if (String(input.Key).endsWith(".info")) sidecarPresent = false;
                throw notFound();
            },
        });

        await store.abortUpload(uploadToken);
        await store.abortUpload(uploadToken);

        const deletes = sent.filter((c) => c.name === "DeleteObjectCommand");
        expect(deletes.map((c) => String(c.input.Key)).toSorted()).toEqual([
            `.uploads/${uploadToken}.info`,
            `.uploads/${uploadToken}.info`,
            `.uploads/${uploadToken}.part`,
            `.uploads/${uploadToken}.part`,
        ]);
    });

    test("a real backend failure still propagates", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            AbortMultipartUploadCommand: () => {
                throw s3Error("InternalError", 500);
            },
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
            ...tailCompletion,
            AbortMultipartUploadCommand: () => {
                throw notFound("NoSuchUpload");
            },
        });
        await store.completeUpload(uploadToken, { expectedLength: 5 * MiB + 3, now: NOW });
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
            ListPartsCommand: () => ({ Parts: [] }),
            AbortMultipartUploadCommand: () => ({}),
            DeleteObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b" });
        ({ uploadToken: oldToken } = await store.createUpload({ key: "old.bin", now: NOW - 100_000 }));
        ({ uploadToken: newToken } = await store.createUpload({ key: "new.bin", now: NOW }));
        sent.length = 0;

        const result = await store.sweepExpired!({ idleSinceMs: NOW - 50_000 });

        expect(result.removed).toBe(1);
        const aborts = sent.filter((c) => c.name === "AbortMultipartUploadCommand");
        expect(aborts).toHaveLength(1);
        expect(aborts[0].input).toMatchObject({ Key: "old.bin", UploadId: "mp-old" });
        const list = sent.find((c) => c.name === "ListObjectsV2Command");
        expect(list?.input.Prefix).toBe(".uploads/");
    });

    test("the lifetime cutoff reads the sidecar idleness could not answer from", async () => {
        // The listing carries the sidecar's last write, so a resource written
        // to a moment ago is never idle. Its creation time lives INSIDE the
        // sidecar, which is why the lifetime cutoff costs one read, and only
        // on what idleness did not condemn.
        let token = "";
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
            PutObjectCommand: () => ({}),
            ListObjectsV2Command: () => ({
                Contents: [{ Key: `.uploads/${token}.info`, LastModified: new Date(NOW) }],
                IsTruncated: false,
            }),
            GetObjectCommand: () => infoResponse({ key: "k.bin", uploadId: "mp-1", createdAt: NOW - 900_000 }),
            AbortMultipartUploadCommand: () => ({}),
            DeleteObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b" });
        ({ uploadToken: token } = await store.createUpload({ key: "k.bin", now: NOW - 900_000 }));
        sent.length = 0;

        expect((await store.sweepExpired!({ idleSinceMs: NOW - 1 })).removed).toBe(0);
        const result = await store.sweepExpired!({
            idleSinceMs: NOW - 1,
            createdBeforeMs: NOW - 100_000,
        });
        expect(result.removed).toBe(1);
        expect(sent.filter((c) => c.name === "AbortMultipartUploadCommand")).toHaveLength(1);
    });

    test("an upload whose sidecar and tail are old is spared while its newest part is younger than the cutoff", async () => {
        // No append writes the sidecar, so its last write is creation (or the
        // last state change). An upload receiving whole parts and no tail
        // shows activity only in its part listing.
        let token = "";
        let partWrittenAt = NOW;
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
            PutObjectCommand: () => ({}),
            ListObjectsV2Command: () => ({
                Contents: [
                    { Key: `.uploads/${token}.info`, LastModified: new Date(NOW - 900_000) },
                    { Key: `.uploads/${token}.part`, LastModified: new Date(NOW - 800_000) },
                ],
                IsTruncated: false,
            }),
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ key: "k.bin", uploadId: "mp-1", createdAt: NOW - 900_000 }),
            }),
            ListPartsCommand: () => ({
                Parts: [
                    { PartNumber: 1, Size: 8, ETag: '"e1"', LastModified: new Date(NOW - 850_000) },
                    { PartNumber: 2, Size: 8, ETag: '"e2"', LastModified: new Date(partWrittenAt) },
                ],
            }),
            AbortMultipartUploadCommand: () => ({}),
            DeleteObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b" });
        ({ uploadToken: token } = await store.createUpload({ key: "k.bin", now: NOW - 900_000 }));
        sent.length = 0;

        expect(await store.sweepExpired({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 0, failed: 0 });
        expect(sent.some((c) => c.name === "AbortMultipartUploadCommand")).toBe(false);

        partWrittenAt = NOW - 20_000;
        expect(await store.sweepExpired({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 0 });
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

        const result = await store.sweepExpired!({ idleSinceMs: NOW });

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
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ key: "k.bin", createdAt: NOW - 10 }) }),
            ListPartsCommand: () => ({ Parts: [] }),
            AbortMultipartUploadCommand: () => ({}),
            DeleteObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b" });
        ({ uploadToken: token } = await store.createUpload({ key: "k.bin", now: NOW - 10 }));
        sent.length = 0;

        const result = await store.sweepExpired!({ idleSinceMs: NOW });

        expect(result.removed).toBe(1);
        const secondList = sent.filter((c) => c.name === "ListObjectsV2Command")[1];
        expect(secondList.input.ContinuationToken).toBe("page-2");
    });

    test("a truncated listing with no way to continue is refused, never read as the end", async () => {
        // Stopping there would report a pass over the bucket that never saw the
        // rest of it.
        const { client } = createMockClient({
            ListObjectsV2Command: () => ({ Contents: [], IsTruncated: true }),
        });
        const store = s3UploadStore({ client, bucket: "b" });
        await expect(store.sweepExpired!({ idleSinceMs: NOW })).rejects.toThrow(
            "a truncated listing carried no continuation marker",
        );
    });

    test("a sidecar whose creation time cannot be read is judged on idleness alone", async () => {
        // The lifetime cutoff lives inside the sidecar, so an unreadable one
        // cannot condemn a resource still in use; idleness still reclaims it.
        let token = "";
        const { client } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
            PutObjectCommand: () => ({}),
            ListObjectsV2Command: () => ({
                Contents: [{ Key: `.uploads/${token}.info`, LastModified: new Date(NOW) }],
                IsTruncated: false,
            }),
            GetObjectCommand: () => ({ Body: bytesOf("not a sidecar") }),
            DeleteObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b" });
        ({ uploadToken: token } = await store.createUpload({ key: "k.bin", now: NOW }));

        // Not idle, so only the lifetime cutoff could condemn it, and it cannot be read.
        expect(await store.sweepExpired!({ idleSinceMs: NOW - 1, createdBeforeMs: NOW + 1 })).toEqual({
            removed: 0,
            failed: 0,
        });
        expect(await store.sweepExpired!({ idleSinceMs: NOW + 1 })).toEqual({ removed: 1, failed: 0 });
    });

    test("a resource that cannot be reclaimed is counted, never allowed to end the scan", async () => {
        // A denied delete on one sidecar must not cost the resources behind it
        // in the listing: a scheduled sweep would then reclaim nothing for as
        // long as that one resource stayed unreclaimable, and would report
        // success by not throwing, which is a retention control that has
        // stopped working while still looking scheduled.
        let firstToken = "";
        let secondToken = "";
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: (input) => ({
                UploadId: String(input.Key) === "first.bin" ? "mp-first" : "mp-second",
            }),
            PutObjectCommand: () => ({}),
            ListObjectsV2Command: () => ({
                Contents: [
                    { Key: `.uploads/${firstToken}.info`, LastModified: new Date(NOW - 100_000) },
                    { Key: `.uploads/${secondToken}.info`, LastModified: new Date(NOW - 100_000) },
                ],
                IsTruncated: false,
            }),
            GetObjectCommand: (input) =>
                String(input.Key) === `.uploads/${firstToken}.info`
                    ? infoResponse({ key: "first.bin", uploadId: "mp-first", createdAt: NOW - 100_000 })
                    : infoResponse({ key: "second.bin", uploadId: "mp-second", createdAt: NOW - 100_000 }),
            ListPartsCommand: () => ({ Parts: [] }),
            AbortMultipartUploadCommand: () => ({}),
            DeleteObjectCommand: (input) => {
                if (String(input.Key) === `.uploads/${firstToken}.info`) throw s3Error("AccessDenied", 403);
                return {};
            },
        });
        const store = s3UploadStore({ client, bucket: "b" });
        ({ uploadToken: firstToken } = await store.createUpload({ key: "first.bin", now: NOW - 100_000 }));
        ({ uploadToken: secondToken } = await store.createUpload({ key: "second.bin", now: NOW - 100_000 }));
        sent.length = 0;

        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 1 });
        // The scan reached the resource behind the one it could not finish.
        const aborts = sent.filter((c) => c.name === "AbortMultipartUploadCommand");
        expect(aborts.map((c) => c.input.UploadId)).toEqual(["mp-first", "mp-second"]);
    });

    /**
     * Every other path to a parked tail starts from the sidecar that names it,
     * so a tail outliving its sidecar is reachable by nothing and would sit in
     * the bucket for good. The sweep judges such a tail on its own last write.
     */
    function tailOnlyListing(tailKey: () => string, lastModified: number, infoExists: boolean) {
        return createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
            PutObjectCommand: () => ({}),
            ListObjectsV2Command: () => ({
                Contents: [{ Key: tailKey(), LastModified: new Date(lastModified) }],
                IsTruncated: false,
            }),
            GetObjectCommand: () => {
                if (!infoExists) throw notFound();
                return infoResponse({ key: "k.bin", uploadId: "mp-1", createdAt: NOW - 900_000 });
            },
            DeleteObjectCommand: () => ({}),
        });
    }

    /** A sweep over a bucket whose only listed row is one long-idle parked tail. */
    async function sweepOverLoneTail(infoExists: boolean) {
        let token = "";
        const { client, sent } = tailOnlyListing(() => `.uploads/${token}.part`, NOW - 100_000, infoExists);
        const store = s3UploadStore({ client, bucket: "b" });
        ({ uploadToken: token } = await store.createUpload({ key: "k.bin", now: NOW - 900_000 }));
        sent.length = 0;

        return { result: await store.sweepExpired!({ idleSinceMs: NOW - 10_000 }), sent, token };
    }

    test("a parked tail whose sidecar is gone is reclaimed on its own last write", async () => {
        const { result, sent, token } = await sweepOverLoneTail(false);

        expect(result).toEqual({ removed: 1, failed: 0 });
        const deletes = sent.filter((c) => c.name === "DeleteObjectCommand");
        expect(deletes.map((c) => c.input.Key)).toEqual([`.uploads/${token}.part`]);
    });

    test("a parked tail is left alone while its sidecar still answers for it", async () => {
        // The sidecar's own row in the listing decides that resource's fate; a
        // tail deleted off its own age would cut the bytes out from under a
        // holder whose sidecar the cutoff had not yet condemned.
        const { result, sent } = await sweepOverLoneTail(true);

        expect(result).toEqual({ removed: 0, failed: 0 });
        expect(sent.some((c) => c.name === "DeleteObjectCommand")).toBe(false);
    });
});

// ─── Post-completion disambiguation ─────────────────────────────────────────

describe("s3UploadStore: gone-multipart disambiguation", () => {
    for (const errorName of ["NoSuchUpload", "NoSuchKey"]) {
        test(`ListParts ${errorName} with this upload's publication at the key reads as completed state`, async () => {
            const { store, uploadToken } = await createStoreWithUpload({
                GetObjectCommand: routeGetObject({
                    info: sealedInfo,
                }),
                ListPartsCommand: () => {
                    throw notFound(errorName);
                },
                HeadObjectCommand: headDestination(publishedObject('"pub"')),
            });

            const state = await store.getUploadState(uploadToken);

            expect(state.status === "complete").toBe(true);
            expect(state.offset).toBe(42);
            expect(state.length).toBe(42);
            expect(state.createdAt).toBe(NOW);
            expect(state.status === "invalidated").toBe(false);
        });
    }

    /**
     * A store whose sidecar holds a completed record carrying no published
     * ETag, over an object of `published` bytes at the destination key.
     */
    const unstampedCompletion = async (record: Record<string, unknown>, published: number) =>
        await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => infoResponse({ createdAt: NOW, completed: true, ...record }),
            }),
            HeadObjectCommand: (input) => {
                if (String(input.Key) !== "docs/file.bin") throw notFound("NotFound");
                return { ContentLength: published, ETag: '"pub"', LastModified: new Date(NOW + 1) };
            },
        });

    test("an unstamped completed record refuses an object that is not the length it fixed", async () => {
        // Completion is terminal, so nothing later stamps this record with the
        // ETag: without a second fact it would attribute whatever sits at the
        // key for as long as the record lives. The length the record already
        // fixed is that fact, and a completed upload's object holds it exactly.
        const { store, uploadToken } = await unstampedCompletion({ length: 42 }, 7);

        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("an unstamped completed record answers from an object of the length it fixed", async () => {
        const { store, uploadToken } = await unstampedCompletion({ length: 42 }, 42);

        const state = await store.getUploadState(uploadToken);

        expect(state.status === "complete").toBe(true);
        expect(state.offset).toBe(42);
    });

    test("a completed marker that fixed no length answers completed state for the skew window", async () => {
        // A record written by a build that did not stamp the ETag, for an
        // upload whose total was never fixed: the commit did run for this
        // token at this key, and the key's existence is all there is to go on
        // until the sweep reaps the record.
        const { store, uploadToken } = await unstampedCompletion({}, 7);

        const state = await store.getUploadState(uploadToken);

        expect(state.status === "complete").toBe(true);
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
            HeadObjectCommand: headMissing,
        });

        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test(".info present but multipart and final object both gone means externally aborted", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: goneMultipart,
            HeadObjectCommand: headMissing,
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

        await expect(store.getUploadState(craft({ key: "", uploadId: "u" }))).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
        await expect(store.getUploadState(craft({ key: "k", uploadId: "" }))).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
        await expect(store.getUploadState(craft({ key: "k" }))).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(sent).toHaveLength(0);
    });

    /**
     * Damaged bookkeeping answers the not-found every adapter shares, with a
     * cause that names the damage and carries nothing read from the record.
     */
    async function expectCorrupt(pending: Promise<unknown>): Promise<void> {
        const err = await pending.then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(isCorruptUploadState(err)).toBe(true);
        const cause = (err as Error).cause as Error;
        expect(cause.name).toBe("UploadStateCorruptError");
        expect(`${cause.message}${cause.stack ?? ""}${(err as Error).message}`).not.toContain("docs/");
    }

    test("a torn metadata sidecar is a corrupt not-found whose cause quotes nothing of it", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => ({ Body: bytesOf('{"key":"docs/tax-return.pdf",') }) }),
        });

        await expectCorrupt(store.getUploadState(uploadToken));
    });

    test("a metadata sidecar without a numeric createdAt is a corrupt not-found", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ length: 5 }) }),
        });

        await expectCorrupt(store.getUploadState(uploadToken));
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
        test(`a metadata sidecar with ${label} is a corrupt not-found`, async () => {
            const { store, sent, uploadToken } = await createStoreWithUpload({
                GetObjectCommand: routeGetObject({ info: () => ({ Body: bytesOf(body) }) }),
                ListPartsCommand: emptyParts,
                HeadObjectCommand: () => ({ ContentLength: 1, ETag: '"x"' }),
            });

            await expectCorrupt(store.getUploadState(uploadToken));
            // Refused before the record is used to name anything.
            expect(sent.some((c) => c.name === "ListPartsCommand")).toBe(false);
            expect(sent.some((c) => c.name === "HeadObjectCommand")).toBe(false);
        });
    }

    test("a sidecar that is valid JSON but not an object is a corrupt not-found", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => ({ Body: bytesOf("null") }) }),
        });

        await expectCorrupt(store.getUploadState(uploadToken));
    });

    test("a sidecar whose createdAt is non-finite is a corrupt not-found", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            // Infinity has no JSON literal, so it arrives as the string 1e999.
            GetObjectCommand: routeGetObject({
                info: () => ({ Body: bytesOf('{"key":"docs/file.bin","uploadId":"mp-1","createdAt":1e999}') }),
            }),
        });

        await expectCorrupt(store.getUploadState(uploadToken));
    });

    // A bad optional field is corruption, not absence: it must be refused
    // before mergeInfo's read-modify-write can launder it back to storage.
    const badOptionalField: Array<[string, Record<string, unknown>]> = [
        ["a string length", { length: "10" }],
        ["a negative length", { length: -1 }],
        ["a non-finite length", { length: Number.POSITIVE_INFINITY }],
        ["a non-boolean invalidated", { invalidated: "true" }],
        ["a non-boolean completed", { completed: 1 }],
        ["a non-string publishedEtag", { publishedEtag: 7 }],
        ["a publishing record without integer parts", { publishing: { size: 3, parts: 1.5 } }],
        ["an array metadata", { metadata: ["a", "b"] }],
        ["a null-valued metadata entry", { metadata: { a: null } }],
        ["a non-string-valued metadata entry", { metadata: { a: 1 } }],
    ];
    for (const [label, overrides] of badOptionalField) {
        test(`a metadata sidecar with ${label} is a corrupt not-found`, async () => {
            const { store, uploadToken } = await createStoreWithUpload({
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW, ...overrides }) }),
            });

            await expectCorrupt(store.getUploadState(uploadToken));
        });
    }
});

// ─── SDK body shapes ────────────────────────────────────────────────────────

describe("s3UploadStore: sidecar body shapes", () => {
    test("an SDK mixin body is read through its web stream", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => ({
                    Body: {
                        transformToWebStream: () =>
                            new Response(
                                new TextEncoder().encode(
                                    JSON.stringify({
                                        key: "docs/file.bin",
                                        uploadId: "mp-1",
                                        createdAt: NOW,
                                        length: 3,
                                    }),
                                ),
                            ).body,
                    },
                }),
            }),
            ListPartsCommand: emptyParts,
            HeadObjectCommand: headMissing,
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
            ListPartsCommand: emptyParts,
            HeadObjectCommand: headMissing,
        });

        const state = await store.getUploadState(uploadToken);
        expect(state.length).toBe(8);
    });

    test("a sidecar body of no readable shape fails loudly", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => ({ Body: 42 }) }),
        });

        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(TypeError);
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
                ListPartsCommand: emptyParts,
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

        const result = await store.completeUpload(uploadToken, { expectedLength: 4, now: NOW });

        const complete = sent.find((c) => c.name === "CompleteMultipartUploadCommand");
        expect(complete?.input.ChecksumType).toBeUndefined();
        expect(complete?.input.ChecksumSHA256).toBeUndefined();
        expect(
            (complete?.input.MultipartUpload as { Parts: Array<Record<string, unknown>> }).Parts[0].ChecksumSHA256,
        ).toBe("cGFydDE=");
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
                CompleteMultipartUploadCommand: () => {
                    throw s3Error("BadDigest", 400);
                },
            },
            { storeOpts: { checksums: true } },
        );

        const err = await store.completeUpload(uploadToken, { expectedLength: 4, now: NOW }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(UploadDigestMismatchError);
    });

    test("expectedDigests is a loud caller bug before any command, checksums on or off", async () => {
        for (const checksums of [false, true]) {
            const { store, sent, uploadToken } = await createStoreWithUpload({}, { storeOpts: { checksums } });

            await expect(
                store.completeUpload(uploadToken, {
                    expectedLength: 0,
                    expectedDigests: { "sha-256": DIGEST },
                    now: NOW,
                }),
            ).rejects.toThrow(/digestOnComplete is false/);
            expect(sent).toHaveLength(0);
        }
    });
});

// ─── Error classification ───────────────────────────────────────────────────

describe("s3UploadStore: throttle classification", () => {
    test("a SlowDown during state derivation maps to StoreUnavailableError", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => {
                throw s3Error("SlowDown", 503);
            },
        });

        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(StoreUnavailableError);
    });

    test("a throttled part upload during append maps to StoreUnavailableError", async () => {
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: emptyParts,
                UploadPartCommand: () => {
                    throw s3Error("SlowDown", 503);
                },
            },
            { storeOpts: { minPartSize: 4 } },
        );

        await expect(store.appendChunk(uploadToken, 0, bytesOf("abcdef"), { now: NOW })).rejects.toBeInstanceOf(
            StoreUnavailableError,
        );
    });

    test("a failed state read names the upload, never the destination key it was still resolving", async () => {
        // A caller holds a token and calls this to LEARN the key, so an error
        // that names the key hands it an identifier it cannot match or redact,
        // and a key commonly embeds a filename.
        const KEY = "clients/acme/severance-agreement.pdf";
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW, key: KEY }) }),
                ListPartsCommand: () => {
                    throw s3Error("SlowDown", 503);
                },
            },
            { key: KEY },
        );

        const err = (await store.getUploadState(uploadToken).catch((e: unknown) => e)) as StoreUnavailableError;
        expect(err).toBeInstanceOf(StoreUnavailableError);
        expect(err.message).not.toContain(KEY);
        expect(err.message).not.toContain("severance-agreement.pdf");
        expect(err.key).not.toContain(KEY);
        expect(err.key).toContain(uploadToken);
    });

    test("a state read that succeeds still answers with the destination key", async () => {
        // The redaction is confined to the failure path: the key is what a
        // successful read exists to return.
        const KEY = "clients/acme/severance-agreement.pdf";
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW, key: KEY }) }),
                ListPartsCommand: emptyParts,
                HeadObjectCommand: () => {
                    throw s3Error("NotFound", 404);
                },
            },
            { key: KEY },
        );

        expect((await store.getUploadState(uploadToken)).key).toBe(KEY);
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
     * These drive that through an append that declares the length (the one
     * append that writes the sidecar) with a sidecar that stamps no ETag, so
     * the merge cannot pin its snapshot and reads again, and that CHANGES
     * between the caller's snapshot and the merge's own read.
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
        const put = sent.filter((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info")).at(-1);
        if (!put) throw new Error("no .info write");
        return JSON.parse(String(put.input.Body)) as Record<string, unknown>;
    }

    test("an invalidation landing mid-append is not cleared by the append's write-back", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: shiftingInfo({ createdAt: NOW }, { createdAt: NOW, invalidated: true }),
            }),
            ...appendHandlers,
        });

        await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 5 });

        // Written from the FRESH read, not from the snapshot the append opened with.
        expect(writtenInfo(sent).invalidated).toBe(true);
    });

    test("a completion landing mid-append is not cleared either: the append is refused", async () => {
        // The merge's fresh read finds the upload completed. Writing the
        // declared length back would be the clearing write; the append is
        // refused instead and no sidecar is written at all.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: shiftingInfo({ createdAt: NOW }, { createdAt: NOW, completed: true }),
            }),
            ...appendHandlers,
        });

        await expect(
            store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 5 }),
        ).rejects.toBeInstanceOf(UploadNotFoundError);

        expect(sent.some((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"))).toBe(false);
    });

    test("a length already recorded by the winner survives the loser's write-back", async () => {
        // Creation facts and a recorded length are write-once by contract, so
        // the fresh copy either equals the caller's or is the one that won.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: shiftingInfo({ createdAt: NOW }, { createdAt: NOW, length: 99 }),
            }),
            ...appendHandlers,
        });

        // This append declares 50; the sidecar already records 99, so the
        // recorded one stands and the late declaration does not overwrite it.
        await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 50 });

        expect(writtenInfo(sent).length).toBe(99);
    });

    test("a published ETag the winner recorded survives a promotion that read none", async () => {
        // The probe matched the object by its publication id, on a backend
        // whose HEAD stamps no ETag; meanwhile the completion recorded the
        // ETag its commit returned. The promotion must not erase it.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: shiftingInfo(
                    { createdAt: NOW, publicationId: "pub-id", completing: { length: 5, destination: null } },
                    { createdAt: NOW, completed: true, publishedEtag: '"won-1"' },
                ),
            }),
            ListPartsCommand: () => {
                throw s3Error("NoSuchUpload", 404);
            },
            HeadObjectCommand: (input) => {
                if (String(input.Key).endsWith(".part")) throw notFound("NotFound");
                return { ContentLength: 5, Metadata: { "upload-publication": "pub-id" } };
            },
        });

        expect((await store.getUploadState(uploadToken)).status).toBe("complete");

        expect(writtenInfo(sent).publishedEtag).toBe('"won-1"');
    });

    test("an unchanged sidecar still records the declared length, so the merge is not inert", async () => {
        // The positive half: without it, a merge mutated to write nothing at all
        // passes every case above.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ...appendHandlers,
        });

        await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 5 });

        const written = writtenInfo(sent);
        expect(written.length).toBe(5);
        expect(written.invalidated).toBeUndefined();
        expect(written.completed).toBeUndefined();
    });

    test("a sidecar read that fails fails the merge rather than writing the snapshot", async () => {
        // The snapshot is not a base: it predates the body, so writing it back
        // would clear, unconditionally, whatever a live holder recorded since.
        // That is the exact loss the fresh read exists to stop, so a read the
        // merge cannot make fails the append instead.
        let calls = 0;
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: () => {
                    calls += 1;
                    if (calls > 1) throw s3Error("ServiceUnavailable", 503);
                    return infoResponse({ createdAt: NOW });
                },
            }),
            ...appendHandlers,
        });

        const infoWrites = () =>
            sent.filter((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info")).length;
        const beforeAppend = infoWrites();

        await expect(
            store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 5 }),
        ).rejects.toBeInstanceOf(StoreUnavailableError);

        // Nothing was written back, so an invalidation landing in that window survives.
        expect(infoWrites()).toBe(beforeAppend);
    });
});

describe("the sidecar write is conditional on the version it read", () => {
    /**
     * The merge's re-read shrinks the stolen-lock window to one round trip;
     * the conditional write closes it. Every sidecar write after creation
     * carries `If-Match` with the ETag the merge's own read returned, so a
     * record that changed in between is refused by the backend, re-read and
     * retried, and a write that keeps losing fails rather than landing.
     * Creation pins to absence with `If-None-Match: *`.
     */

    /** A `.info` GET answering a sequence of (record, ETag) versions, the last one repeating. */
    function versionedInfo(...versions: Array<{ record: Record<string, unknown>; etag: string }>) {
        let calls = 0;
        return () => {
            const v = versions[Math.min(calls, versions.length - 1)]!;
            calls += 1;
            return { ...infoResponse(v.record), ETag: v.etag };
        };
    }

    /** Every `.info` PutObject in order, with the precondition it carried. */
    function infoPuts(sent: SentCommand[]) {
        return sent
            .filter((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"))
            .map((c) => ({
                ifMatch: c.input.IfMatch as string | undefined,
                ifNoneMatch: c.input.IfNoneMatch as string | undefined,
                record: JSON.parse(String(c.input.Body)) as Record<string, unknown>,
            }));
    }

    test("creation writes the sidecar with If-None-Match: *", async () => {
        const { client, sent } = createMockClient({
            CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
            PutObjectCommand: () => ({}),
        });
        const store = s3UploadStore({ client, bucket: "b" });

        await store.createUpload({ key: "docs/file.bin", now: NOW });

        const [creation] = infoPuts(sent);
        expect(creation?.ifNoneMatch).toBe("*");
        expect(creation?.ifMatch).toBeUndefined();
    });

    test("a declaring append pins its write to the ETag its own read returned, without re-reading", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: versionedInfo({ record: { createdAt: NOW }, etag: '"v1"' }),
            }),
            ...appendHandlers,
        });

        await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 5 });

        const puts = infoPuts(sent);
        expect(puts).toHaveLength(1);
        expect(puts[0]?.ifMatch).toBe('"v1"');
        expect(puts[0]?.ifNoneMatch).toBeUndefined();
        // One read before the write, the one the write is pinned to; the only
        // later read is the completion fence, after the bytes are durable.
        const isInfo = (c: SentCommand) => String(c.input.Key).endsWith(".info");
        const putAt = sent.findIndex((c) => c.name === "PutObjectCommand" && isInfo(c));
        const infoGets = sent
            .map((c, i) => [c, i] as const)
            .filter(([c]) => c.name === "GetObjectCommand" && isInfo(c));
        expect(infoGets.filter(([, i]) => i < putAt)).toHaveLength(1);
        expect(infoGets.filter(([, i]) => i > putAt)).toHaveLength(1);
    });

    test("a 412 re-reads and retries against the record that won", async () => {
        // The stolen-lock case: between this holder's read and its write the
        // new holder invalidated the upload. The backend refuses the stale
        // write; the retry is computed from the winner's record, pinned to
        // the winner's version, and keeps the winner's terminal flag.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: versionedInfo(
                    { record: { createdAt: NOW }, etag: '"v1"' },
                    { record: { createdAt: NOW, invalidated: true }, etag: '"v2"' },
                ),
            }),
            PutObjectCommand: (input) => {
                if (input.IfMatch === '"v1"') throw s3Error("PreconditionFailed", 412);
                return {};
            },
            ...appendHandlers,
        });

        await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 5 });

        const puts = infoPuts(sent);
        expect(puts.map((p) => p.ifMatch)).toEqual(['"v1"', '"v2"']);
        expect(puts[1]?.record.invalidated).toBe(true);
        expect(puts[1]?.record.length).toBe(5);
    });

    test("a write that keeps losing fails after three attempts instead of landing", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: versionedInfo({ record: { createdAt: NOW }, etag: '"v1"' }),
            }),
            PutObjectCommand: (input) => {
                if (typeof input.IfMatch === "string") throw s3Error("PreconditionFailed", 412);
                return {};
            },
            ...appendHandlers,
        });

        const err: unknown = await store
            .appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 5 })
            .then(
                () => undefined,
                (e: unknown) => e,
            );
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/changed under 3 consecutive merges/);
        // The token is a bearer credential and the sidecar's name embeds it.
        expect((err as Error).message).not.toContain(uploadToken);
        expect(infoPuts(sent)).toHaveLength(3);
    });

    test("a 412 on an unconditional write is not retried", async () => {
        // Only a write the merge pinned can lose its precondition; a 412 from a
        // write that carried none is the backend's failure and propagates as is.
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            PutObjectCommand: (input) => {
                if (input.IfNoneMatch === "*" || !String(input.Key).endsWith(".info")) return {};
                throw s3Error("PreconditionFailed", 412);
            },
            ...appendHandlers,
        });

        await expect(store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 5 })).rejects.toThrow(
            "PreconditionFailed",
        );
        expect(infoPuts(sent)).toHaveLength(1);
    });

    /** The two ways a merge has no version to pin to; both write unconditionally. */
    const unpinned: Array<[string, CommandHandler, { sidecarCas?: boolean }]> = [
        ["a read that returns no ETag", () => infoResponse({ createdAt: NOW }), {}],
        [
            "sidecarCas: false, even with a version",
            versionedInfo({ record: { createdAt: NOW }, etag: '"v1"' }),
            { sidecarCas: false },
        ],
    ];
    for (const [label, info, storeOpts] of unpinned) {
        test(`${label} leaves the write unconditional`, async () => {
            const { store, sent, uploadToken } = await createStoreWithUpload(
                { GetObjectCommand: routeGetObject({ info }), ...appendHandlers },
                { storeOpts },
            );

            await store.appendChunk(uploadToken, 0, bytesOf("hello"), { now: NOW + 5, length: 5 });

            const [put] = infoPuts(sent);
            expect(put?.ifMatch).toBeUndefined();
            expect(put?.ifNoneMatch).toBeUndefined();
        });
    }

    /** A backend whose PutObject answers 501 to everything. */
    function storeOnA501Backend(storeOpts: { sidecarCas?: boolean }) {
        const { client, sent } = createMockClient(
            {
                CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
                PutObjectCommand: () => {
                    throw s3Error("NotImplemented", 501);
                },
                AbortMultipartUploadCommand: () => ({}),
                DeleteObjectCommand: () => ({}),
            },
            "passthrough",
        );
        return { sent, store: s3UploadStore({ client, bucket: "b", ...storeOpts }) };
    }

    test("a backend answering NotImplemented fails the write naming the option, and reaps the multipart upload", async () => {
        // Loud, not degraded in place: a protection that switches itself off
        // is one the operator believes they have.
        const { store, sent } = storeOnA501Backend({});

        await expect(store.createUpload({ key: "docs/file.bin", now: NOW })).rejects.toThrow(/sidecarCas: false/);
        expect(sent.some((c) => c.name === "AbortMultipartUploadCommand")).toBe(true);
    });

    /** A store over a bucket that answers the conditional-write probe as `casProbe` says. */
    function storeAnsweringProbe(casProbe: CasProbeAnswer, handlers: Record<string, CommandHandler> = {}) {
        const { client, sent } = createMockClient(
            {
                CreateMultipartUploadCommand: () => ({ UploadId: "mp-1" }),
                PutObjectCommand: () => ({}),
                AbortMultipartUploadCommand: () => ({}),
                DeleteObjectCommand: () => ({}),
                ...handlers,
            },
            casProbe,
        );
        return { sent, store: s3UploadStore({ client, bucket: "b" }) };
    }

    test("a backend that accepts a create-only write over an existing object is refused, naming the option", async () => {
        // Such a backend drops the precondition and lands every write: a
        // stolen-lock holder's stale record would overwrite the winner's
        // while the store believed itself protected.
        const { store, sent } = storeAnsweringProbe("ignored");

        await expect(store.createUpload({ key: "docs/file.bin", now: NOW })).rejects.toThrow(/sidecarCas: false/);
        expect(infoPuts(sent)).toEqual([]);
        // The verdict is kept: the next write is refused without asking again.
        await expect(store.createUpload({ key: "docs/file.bin", now: NOW })).rejects.toThrow(/sidecarCas: false/);
    });

    test("the probe asks once per store, with a canary it deletes, and a backend that honours it is trusted", async () => {
        const canaryWrites: string[] = [];
        const { store } = storeAnsweringProbe("passthrough", {
            PutObjectCommand: (input) => {
                if (input.Body !== "") return {};
                const key = String(input.Key);
                expect(input.IfNoneMatch).toBe("*");
                if (canaryWrites.includes(key)) {
                    canaryWrites.push(key);
                    throw s3Error("PreconditionFailed", 412);
                }
                canaryWrites.push(key);
                return {};
            },
            DeleteObjectCommand: (input) => {
                canaryWrites.push(`deleted ${String(input.Key)}`);
                return {};
            },
        });

        await store.createUpload({ key: "a.bin", now: NOW });
        await store.createUpload({ key: "b.bin", now: NOW });

        expect(canaryWrites).toHaveLength(3);
        const [canary] = canaryWrites;
        expect(canary).toMatch(/^\.uploads\/[0-9a-f-]{36}\.part$/);
        expect(canaryWrites).toEqual([canary, canary, `deleted ${canary}`]);
    });

    test("a probe that fails for any other reason decides nothing and is asked again", async () => {
        let throttle = true;
        const { store } = storeAnsweringProbe("passthrough", {
            PutObjectCommand: (input) => {
                if (input.Body === "" && throttle) throw s3Error("InternalError", 500);
                return {};
            },
        });

        await expect(store.createUpload({ key: "a.bin", now: NOW })).rejects.toThrow("InternalError");
        throttle = false;
        // Asked again: both canary creates succeed now, so the backend
        // ignores the precondition, which is a verdict rather than a fault.
        await expect(store.createUpload({ key: "a.bin", now: NOW })).rejects.toThrow(/sidecarCas: false/);
    });

    test("a 501 on an unconditional write is the backend's failure, not a conditional-write one", async () => {
        const { store } = storeOnA501Backend({ sidecarCas: false });

        await expect(store.createUpload({ key: "docs/file.bin", now: NOW })).rejects.toThrow("NotImplemented");
    });
});

// ─── Stateful bucket (the whole multipart lifecycle, not canned answers) ────

/**
 * The store's part floor and the fake's completion rule at once, so the two
 * agree on which parts are legal. Scaled down from S3's 5 MiB so a handful of
 * bytes still crosses several part boundaries.
 */
const CONFORMANCE_PART_SIZE = 4;

/** Small enough that every multi-part listing pages, exercising the marker. */
const CONFORMANCE_PARTS_PAGE = 2;

interface FakeS3Object {
    content: Uint8Array;
    etag: string;
    lastModified: Date;
    metadata?: Record<string, string>;
}

interface FakeMultipartUpload {
    key: string;
    /** User metadata from CreateMultipartUpload, which the completed object carries. */
    metadata?: Record<string, string>;
    parts: Map<number, { etag: string; content: Uint8Array }>;
    /** When the upload was created, as ListMultipartUploads reports it. */
    initiated: Date;
}

interface StatefulBucketOptions {
    /** ListParts page size. Defaults to one page holding everything. */
    partsPageSize?: number;
    /** Floor every part but the last must meet, the rule S3 applies at completion. */
    minPartSize?: number;
    /** ListMultipartUploads page size. Defaults to one page holding everything. */
    uploadsPageSize?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(input: Record<string, unknown>, field: string): string {
    const value = input[field];
    if (typeof value !== "string" || value === "") {
        throw new Error(`mock S3: ${field} must be a non-empty string`);
    }
    return value;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
    const value = input[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`mock S3: ${field} must be a string when present`);
    return value;
}

function requireInteger(input: Record<string, unknown>, field: string): number {
    const value = input[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`mock S3: ${field} must be an integer`);
    }
    return value;
}

/** User metadata on a PutObject, when the command carries any. */
function optionalMetadata(input: Record<string, unknown>): Record<string, string> | undefined {
    const value = input.Metadata;
    if (value === undefined) return undefined;
    if (!isRecord(value) || Object.values(value).some((v) => typeof v !== "string")) {
        throw new Error("mock S3: Metadata must be a string-valued record when present");
    }
    return value as Record<string, string>;
}

/** The two body shapes the store sends: a JSON sidecar string, and part bytes. */
function requireBody(value: unknown): Uint8Array {
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return value.slice();
    throw new Error(`mock S3: unsupported Body shape ${typeof value}`);
}

/** The part list a completion asserts, in the order it asserts it. */
function requireListedParts(input: Record<string, unknown>): Array<{ partNumber: number; etag: string | undefined }> {
    const multipart = input.MultipartUpload;
    if (!isRecord(multipart) || !Array.isArray(multipart.Parts)) {
        throw new Error("mock S3: CompleteMultipartUpload carried no MultipartUpload.Parts");
    }
    const listed: unknown[] = multipart.Parts;
    return listed.map((part) => {
        if (!isRecord(part)) throw new Error("mock S3: a listed part is not an object");
        return { partNumber: requireInteger(part, "PartNumber"), etag: optionalString(part, "ETag") };
    });
}

function concatBytes(pieces: Uint8Array[]): Uint8Array {
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
        out.set(piece, offset);
        offset += piece.length;
    }
    return out;
}

/**
 * A bucket that remembers, rather than a per-command answer decided in
 * advance: objects and multipart uploads are real state, so every command sees
 * what the ones before it did. The conformance harness needs exactly that,
 * since each obligation it checks is about durable state surviving into a
 * later call, and a canned handler answers the same thing either way.
 */
function statefulS3Bucket(opts: StatefulBucketOptions = {}) {
    const objects = new Map<string, FakeS3Object>();
    const multiparts = new Map<string, FakeMultipartUpload>();
    const minPartSize = opts.minPartSize ?? 5 * MiB;
    let etagSeq = 0;
    let uploadSeq = 0;

    const nextEtag = (): string => {
        etagSeq += 1;
        return `"etag-${etagSeq}"`;
    };

    const put = (key: string, content: Uint8Array, etag = nextEtag(), metadata?: Record<string, string>) => {
        const object: FakeS3Object = {
            content,
            etag,
            lastModified: new Date(NOW),
            ...(metadata !== undefined ? { metadata } : {}),
        };
        objects.set(key, object);
        return object;
    };

    /**
     * An upload id the bucket does not hold names nothing, whether it was
     * completed, aborted, or never created. S3 answers all three alike, and
     * the store's gone-multipart disambiguation runs off that answer.
     */
    const openMultipart = (key: string, uploadId: string): FakeMultipartUpload => {
        const upload = multiparts.get(uploadId);
        if (upload === undefined || upload.key !== key) throw s3Error("NoSuchUpload", 404);
        return upload;
    };

    const handlers: Record<string, CommandHandler> = {
        CreateMultipartUploadCommand: (input) => {
            uploadSeq += 1;
            const uploadId = `mpu-${uploadSeq}`;
            const metadata = optionalMetadata(input);
            multiparts.set(uploadId, {
                key: requireString(input, "Key"),
                parts: new Map(),
                initiated: new Date(NOW),
                ...(metadata !== undefined ? { metadata } : {}),
            });
            return { UploadId: uploadId };
        },

        ListMultipartUploadsCommand: (input) => {
            const prefix = optionalString(input, "Prefix") ?? "";
            const all = [...multiparts.entries()]
                .filter(([, upload]) => upload.key.startsWith(prefix))
                .map(([uploadId, upload]) => ({ Key: upload.key, UploadId: uploadId, Initiated: upload.initiated }))
                .toSorted((a, b) =>
                    a.Key === b.Key ? a.UploadId.localeCompare(b.UploadId) : a.Key.localeCompare(b.Key),
                );
            // Resume strictly after the (key, upload id) marker pair, as S3 pages.
            const keyMarker = optionalString(input, "KeyMarker");
            const idMarker = optionalString(input, "UploadIdMarker") ?? "";
            const remaining =
                keyMarker === undefined
                    ? all
                    : all.filter((u) => u.Key > keyMarker || (u.Key === keyMarker && u.UploadId > idMarker));
            const pageSize = opts.uploadsPageSize ?? Math.max(remaining.length, 1);
            const page = remaining.slice(0, pageSize);
            const truncated = page.length < remaining.length;
            const last = page.at(-1);
            return {
                Uploads: page,
                IsTruncated: truncated,
                ...(truncated && last !== undefined
                    ? { NextKeyMarker: last.Key, NextUploadIdMarker: last.UploadId }
                    : {}),
            };
        },

        UploadPartCommand: (input) => {
            const upload = openMultipart(requireString(input, "Key"), requireString(input, "UploadId"));
            const partNumber = requireInteger(input, "PartNumber");
            if (partNumber < 1 || partNumber > 10_000) throw s3Error("InvalidArgument", 400);
            const etag = nextEtag();
            upload.parts.set(partNumber, { etag, content: requireBody(input.Body) });
            return { ETag: etag };
        },

        ListPartsCommand: (input) => {
            const upload = openMultipart(requireString(input, "Key"), requireString(input, "UploadId"));
            const marker = optionalString(input, "PartNumberMarker");
            const after = marker === undefined ? 0 : Number(marker);
            const remaining = [...upload.parts.entries()]
                .toSorted((a, b) => a[0] - b[0])
                .filter(([partNumber]) => partNumber > after);
            const pageSize = opts.partsPageSize ?? Math.max(remaining.length, 1);
            const page = remaining.slice(0, pageSize);
            const truncated = page.length < remaining.length;
            return {
                Parts: page.map(([partNumber, part]) => ({
                    PartNumber: partNumber,
                    Size: part.content.length,
                    ETag: part.etag,
                })),
                IsTruncated: truncated,
                ...(truncated ? { NextPartNumberMarker: String(page[page.length - 1]![0]) } : {}),
            };
        },

        CompleteMultipartUploadCommand: (input) => {
            const key = requireString(input, "Key");
            const uploadId = requireString(input, "UploadId");
            const upload = openMultipart(key, uploadId);
            const listed = requireListedParts(input);
            if (listed.length === 0) throw s3Error("InvalidRequest", 400);
            // The preconditions S3 implements on CompleteMultipartUpload, on
            // the object at the key, not on the multipart upload: a refused
            // commit leaves the upload open.
            const current = objects.get(key);
            if (input.IfNoneMatch === "*" && current !== undefined) throw s3Error("PreconditionFailed", 412);
            if (typeof input.IfMatch === "string" && current?.etag !== input.IfMatch) {
                throw s3Error("PreconditionFailed", 412);
            }
            const pieces: Uint8Array[] = [];
            let previousPartNumber = 0;
            for (const [index, entry] of listed.entries()) {
                if (entry.partNumber <= previousPartNumber) throw s3Error("InvalidPartOrder", 400);
                previousPartNumber = entry.partNumber;
                const stored = upload.parts.get(entry.partNumber);
                if (stored === undefined || stored.etag !== entry.etag) throw s3Error("InvalidPart", 400);
                // Only the final part is exempt from the part-size floor.
                if (index < listed.length - 1 && stored.content.length < minPartSize) {
                    throw s3Error("EntityTooSmall", 400);
                }
                pieces.push(stored.content);
            }
            // A multipart ETag carries the part count after a dash, as S3's does.
            const published = put(
                key,
                concatBytes(pieces),
                `${nextEtag().slice(0, -1)}-${listed.length}"`,
                upload.metadata,
            );
            // A completed upload can no longer be listed, resumed or aborted.
            multiparts.delete(uploadId);
            return { ETag: published.etag };
        },

        AbortMultipartUploadCommand: (input) => {
            const uploadId = requireString(input, "UploadId");
            openMultipart(requireString(input, "Key"), uploadId);
            multiparts.delete(uploadId);
            return {};
        },

        PutObjectCommand: (input) => {
            // The two preconditions S3 implements on PutObject: a write pinned
            // to a version it did not read, or to absence over a present key,
            // is refused with 412 instead of landing.
            const key = requireString(input, "Key");
            const current = objects.get(key);
            if (input.IfNoneMatch === "*" && current !== undefined) throw s3Error("PreconditionFailed", 412);
            if (typeof input.IfMatch === "string" && current?.etag !== input.IfMatch) {
                throw s3Error("PreconditionFailed", 412);
            }
            put(key, requireBody(input.Body), undefined, optionalMetadata(input));
            return {};
        },

        GetObjectCommand: (input) => {
            const object = objects.get(requireString(input, "Key"));
            if (object === undefined) throw notFound();
            return {
                Body: object.content,
                ContentLength: object.content.length,
                ETag: object.etag,
                LastModified: object.lastModified,
                ...(object.metadata !== undefined ? { Metadata: object.metadata } : {}),
            };
        },

        HeadObjectCommand: (input) => {
            const object = objects.get(requireString(input, "Key"));
            if (object === undefined) throw notFound("NotFound");
            return {
                ContentLength: object.content.length,
                ETag: object.etag,
                LastModified: object.lastModified,
                ...(object.metadata !== undefined ? { Metadata: object.metadata } : {}),
            };
        },

        ListObjectsV2Command: (input) => {
            const prefix = optionalString(input, "Prefix") ?? "";
            return {
                Contents: [...objects.entries()]
                    .filter(([key]) => key.startsWith(prefix))
                    .map(([key, object]) => ({ Key: key, LastModified: object.lastModified })),
                IsTruncated: false,
            };
        },

        DeleteObjectCommand: (input) => {
            // S3 answers a delete of a key it does not hold with success.
            objects.delete(requireString(input, "Key"));
            return {};
        },
    };

    return { handlers, objects, multiparts };
}

// ─── The contract, asserted rather than declared ────────────────────────────

// ─── The tail is positioned, and a reaped resource stays reaped ─────────────

describe("the parked tail belongs at the offset it was accepted for", () => {
    /**
     * A holder whose lock was stolen while its body streamed parks its
     * remainder after the winner committed a part. Counting that tail after
     * the winner's parts would place bytes at a position the client never sent
     * them for, and the published object would carry them there. The park
     * stamps the offset its bytes belong at and lands only where no tail
     * exists; a derivation counts a tail only when its stamp is the committed
     * sum in front of it.
     */

    test("a park carries the offset its bytes belong at and lands only where no tail exists", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({
                    Parts: [{ PartNumber: 1, Size: 8, ETag: '"e1"' }],
                    IsTruncated: false,
                }),
                UploadPartCommand: () => ({ ETag: '"e2"' }),
                DeleteObjectCommand: () => ({}),
            },
            { storeOpts: { minPartSize: 8 } },
        );

        // 8 committed, 11 incoming: one part flushes, three bytes park at 16.
        await store.appendChunk(uploadToken, 8, bytesOf("abcdefghijk"), { now: NOW });

        const park = sent.find((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"));
        expect(park?.input.Metadata).toEqual({ "tail-offset": "16" });
        expect(park?.input.IfNoneMatch).toBe("*");
        expect(new TextDecoder().decode(park?.input.Body as Uint8Array)).toBe("ijk");
    });

    test("sidecarCas: false parks unconditionally, stamped all the same", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: emptyParts,
            },
            { storeOpts: { minPartSize: 8, sidecarCas: false } },
        );

        await store.appendChunk(uploadToken, 0, bytesOf("abc"), { now: NOW });

        const park = sent.find((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"));
        expect(park?.input.Metadata).toEqual({ "tail-offset": "0" });
        expect(park?.input.IfNoneMatch).toBeUndefined();
    });

    test("a park refused because a tail appeared since the lift is an offset conflict at the winner's offset", async () => {
        const { store, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: emptyParts,
                PutObjectCommand: (input) => {
                    if (String(input.Key).endsWith(".part")) throw s3Error("PreconditionFailed", 412);
                    return {};
                },
                // The winner's tail: five bytes parked at 0.
                HeadObjectCommand: () => ({ ContentLength: 5, ETag: '"w"', Metadata: { "tail-offset": "0" } }),
            },
            { storeOpts: { minPartSize: 8 } },
        );

        const rejection = await store.appendChunk(uploadToken, 0, bytesOf("abc"), { now: NOW }).then(
            () => undefined,
            (err: unknown) => err,
        );
        expect(rejection).toBeInstanceOf(UploadOffsetConflictError);
        expect((rejection as UploadOffsetConflictError).durableOffset).toBe(5);
    });

    test("a state read counts a tail only when its stamp is the committed sum in front of it", async () => {
        let tailMetadata: Record<string, string> | undefined;
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
            ListPartsCommand: () => ({ Parts: [{ PartNumber: 1, Size: 8, ETag: '"e1"' }], IsTruncated: false }),
            HeadObjectCommand: (input) => {
                if (String(input.Key).endsWith(".part")) {
                    return { ContentLength: 3, ...(tailMetadata !== undefined ? { Metadata: tailMetadata } : {}) };
                }
                throw notFound("NotFound");
            },
        });

        tailMetadata = { "tail-offset": "8" };
        expect((await store.getUploadState(uploadToken)).offset).toBe(11);
        // Parked by a holder that saw no committed part: those bytes were
        // accepted at 0, and 8 is where they would be counted.
        tailMetadata = { "tail-offset": "0" };
        expect((await store.getUploadState(uploadToken)).offset).toBe(8);
        // Parked by a build that did not stamp: counted where found.
        tailMetadata = undefined;
        expect((await store.getUploadState(uploadToken)).offset).toBe(11);
        // Parked after a part committed between the listing and the HEAD:
        // those bytes were acknowledged at 16 + 3, and the offset never
        // answers below an acknowledged one.
        tailMetadata = { "tail-offset": "16" };
        expect((await store.getUploadState(uploadToken)).offset).toBe(19);
    });

    test("an append replaces a tail that does not belong, pinned to the version it read", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({
                    info: () => infoResponse({ createdAt: NOW }),
                    part: () => ({ Body: bytesOf("xyz"), ETag: '"stale"', Metadata: { "tail-offset": "0" } }),
                }),
                ListPartsCommand: () => ({ Parts: [{ PartNumber: 1, Size: 8, ETag: '"e1"' }], IsTruncated: false }),
                DeleteObjectCommand: () => ({}),
            },
            { storeOpts: { minPartSize: 8 } },
        );

        // The stale tail is not part of the offset: 8 is the durable offset,
        // and a client claiming 11 is told so.
        await expect(store.appendChunk(uploadToken, 11, bytesOf("ab"), { now: NOW })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );

        sent.length = 0;
        await store.appendChunk(uploadToken, 8, bytesOf("ab"), { now: NOW });
        // Overwritten in place rather than deleted first: a delete followed
        // by a create-only park could remove a tail another holder parked in
        // between, and the pinned write refuses that instead.
        expect(sent.some((c) => c.name === "DeleteObjectCommand")).toBe(false);
        const park = sent.find((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".part"));
        expect(park?.input.Metadata).toEqual({ "tail-offset": "8" });
        expect(park?.input.IfMatch).toBe('"stale"');
        expect(park?.input.IfNoneMatch).toBeUndefined();
        expect(new TextDecoder().decode(park?.input.Body as Uint8Array)).toBe("ab");
    });

    test("an append that sees a tail stamped past its committed sum keeps that tail and reports the conflict", async () => {
        // A tail stamped above the committed sum this append listed was parked
        // by a newer holder, after parts this append's view does not hold. Those
        // bytes were acknowledged; deleting them would lose acked data.
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({
                    info: () => infoResponse({ createdAt: NOW }),
                    part: () => ({ Body: bytesOf("xyz"), Metadata: { "tail-offset": "16" } }),
                }),
                ListPartsCommand: () => ({ Parts: [{ PartNumber: 1, Size: 8, ETag: '"e1"' }], IsTruncated: false }),
                DeleteObjectCommand: () => ({}),
            },
            { storeOpts: { minPartSize: 8 } },
        );
        sent.length = 0;

        const rejection = await store.appendChunk(uploadToken, 8, bytesOf("ab"), { now: NOW }).then(
            () => undefined,
            (err: unknown) => err,
        );
        expect(rejection).toBeInstanceOf(UploadOffsetConflictError);
        expect((rejection as UploadOffsetConflictError).durableOffset).toBe(19);
        expect(sent.some((c) => c.name === "DeleteObjectCommand")).toBe(false);
        expect(sent.some((c) => c.name === "UploadPartCommand" || c.name === "PutObjectCommand")).toBe(false);
    });

    test("a holder whose lock was stolen mid-body cannot advance the offset past the winner's bytes", async () => {
        // Against the stateful bucket, the whole scenario: holder A stalls
        // with 3 bytes buffered from offset 0; B (the new holder after a
        // stolen lock) appends from 0, committing one 8-byte part and parking
        // the rest, or an empty tail when nothing is left. Either way B's park
        // moved the slot A read as empty, so A's park is refused as an offset
        // conflict carrying the offset B reached.
        const backend = statefulS3Bucket({ minPartSize: 8 });
        const { client } = createMockClient(backend.handlers);
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 8 });

        for (const [winnerBytes, expectedOffset] of [
            ["0123456789", 10],
            ["01234567", 8],
        ] as const) {
            const { uploadToken } = await store.createUpload({ key: `k/${winnerBytes.length}.bin`, now: NOW });
            const { body, pulled, release } = parkedBody(bytesOf("abc"));
            const stale = store.appendChunk(uploadToken, 0, body, { now: NOW }).then(
                () => undefined,
                (err: unknown) => err,
            );
            await pulled;
            await store.appendChunk(uploadToken, 0, bytesOf(winnerBytes), { now: NOW });
            release();
            const staleOutcome = await stale;
            expect(staleOutcome).toBeInstanceOf(UploadOffsetConflictError);
            expect((staleOutcome as UploadOffsetConflictError).durableOffset).toBe(expectedOffset);

            expect((await store.getUploadState(uploadToken)).offset).toBe(expectedOffset);
            // The next append from the honest offset lands, and the published
            // object holds the winner's bytes followed by it: never A's.
            await store.appendChunk(uploadToken, expectedOffset, bytesOf("Z"), { now: NOW });
            await completeDurable(store, uploadToken, { now: NOW });
            const published = backend.objects.get(`k/${winnerBytes.length}.bin`)?.content;
            expect(new TextDecoder().decode(published)).toBe(`${winnerBytes}Z`);
        }
    });

    /** An upload with one committed part and an append from 8 held open mid-body while it is aborted. */
    /** `prefix` is appended first; the in-flight append from its end is held mid-body across the reap. */
    async function reapedMidBody(remainder: string, prefix = "abcdefgh") {
        const backend = statefulS3Bucket({ minPartSize: 8 });
        const { client } = createMockClient(backend.handlers);
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 8 });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        if (prefix !== "") await store.appendChunk(uploadToken, 0, bytesOf(prefix), { now: NOW });

        const { body, pulled, release } = parkedBody(bytesOf(remainder));
        const inFlight = store.appendChunk(uploadToken, prefix.length, body, { now: NOW }).then(
            () => undefined,
            (err: unknown) => err,
        );
        await pulled;
        await store.abortUpload(uploadToken);
        release();
        return { backend, store, uploadToken, outcome: await inFlight };
    }

    test("an append whose part lands on a reaped upload reports it gone and writes no sidecar back", async () => {
        const { backend, store, uploadToken, outcome } = await reapedMidBody("ijklmnop");

        expect(outcome).toBeInstanceOf(UploadNotFoundError);
        expect(backend.objects.has(`.uploads/${uploadToken}.info`)).toBe(false);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a tail parked into an upload reaped mid-body is reachable by nothing and the sweep reclaims it", async () => {
        // No sidecar write follows an append, so the reap is invisible to a
        // tail-only one that read an empty slot: its park, pinned to absence,
        // lands where no sidecar answers for it. The upload stays gone, and
        // the tail is judged on its own last write.
        const { backend, store, uploadToken } = await reapedMidBody("ij", "");

        expect(backend.objects.has(`.uploads/${uploadToken}.info`)).toBe(false);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(backend.objects.has(`.uploads/${uploadToken}.part`)).toBe(true);
        expect(await store.sweepExpired({ idleSinceMs: NOW + 1 })).toEqual({ removed: 1, failed: 0 });
        expect(backend.objects.has(`.uploads/${uploadToken}.part`)).toBe(false);
    });

    test("a tail-only append that read a tail and finds the upload reaped reports it gone and parks nothing", async () => {
        // The prefix ends on a part boundary, so it parks an empty tail; the
        // reap removes it, and the in-flight park pinned to it is refused.
        const { backend, uploadToken, outcome } = await reapedMidBody("ij");

        expect(outcome).toBeInstanceOf(UploadNotFoundError);
        expect(backend.objects.has(`.uploads/${uploadToken}.part`)).toBe(false);
    });
});

describe("s3UploadStore: the part size is fixed per upload", () => {
    /**
     * Part N covers [(N - 1) * P, N * P), which is what makes a stale
     * holder's UploadPart(N) a replacement of the same range. A process
     * configured with another minimum must cut the same P, or a rolling
     * deploy splices different ranges into one object.
     */
    const partSizes = (backend: ReturnType<typeof statefulS3Bucket>) =>
        [...backend.multiparts.values()].flatMap((m) =>
            [...m.parts.entries()].toSorted(([a], [b]) => a - b).map(([, p]) => p.content.length),
        );

    test("a process with another minPartSize resuming the upload cuts the part size the record fixed", async () => {
        const backend = statefulS3Bucket({ minPartSize: 8 });
        const { client } = createMockClient(backend.handlers);
        const creator = s3UploadStore({ client, bucket: "b", minPartSize: 8 });
        const { uploadToken } = await creator.createUpload({ key: "k.bin", now: NOW });
        await creator.appendChunk(uploadToken, 0, bytesOf("0123456789"), { now: NOW });

        const resumer = s3UploadStore({ client, bucket: "b", minPartSize: 16 });
        await resumer.appendChunk(uploadToken, 10, bytesOf("abcdefghijklmn"), { now: NOW });

        expect(partSizes(backend)).toEqual([8, 8, 8]);
        expect((await resumer.getUploadState(uploadToken)).offset).toBe(24);
    });

    test("a record written before the part size was persisted is cut at the configured minimum", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload(
            {
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: emptyParts,
                UploadPartCommand: () => ({ ETag: '"e1"' }),
            },
            { storeOpts: { minPartSize: 8 } },
        );

        await store.appendChunk(uploadToken, 0, bytesOf("0123456789"), { now: NOW });

        const uploaded = sent.filter((c) => c.name === "UploadPartCommand");
        expect(uploaded.map((c) => (c.input.Body as Uint8Array).length)).toEqual([8]);
    });

    test("a record holding a malformed part size is corruption, not a fallback", async () => {
        const { store, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW, partSize: 0 }) }),
        });

        const err = await store.getUploadState(uploadToken).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(isCorruptUploadState(err)).toBe(true);
    });
});

describe("s3UploadStore: write-store conformance", () => {
    test("passes every obligation against a stateful bucket", async () => {
        const backend = statefulS3Bucket({
            minPartSize: CONFORMANCE_PART_SIZE,
            partsPageSize: CONFORMANCE_PARTS_PAGE,
        });
        const { client } = createMockClient(backend.handlers);

        const report = await checkResumableWriteStore(
            // One bucket across both instances, so the restart obligations run
            // instead of skipping: this store derives its offset from the part
            // listing plus the tail sidecar, and it is that derivation which
            // has to survive a process that never saw the append.
            () => s3UploadStore({ client, bucket: "b", minPartSize: CONFORMANCE_PART_SIZE }),
            {
                key: (n) => `conformance/${n}.bin`,
                // The publication obligations are about the object at the
                // destination key, which a write store has no vocabulary to
                // answer: what is readable there mid-upload, what a refused
                // append left behind, and what survives a cancel.
                readObject: (key) => backend.objects.get(key)?.content,
            },
        );

        expect(report.checks.filter((c) => !c.ok && !c.skipped).map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
        // The one obligation this backend cannot be asked about. Multipart
        // SHA-256 checksums are composite (a hash of per-part hashes), so no S3
        // backend verifies a whole-representation digest at completion and the
        // store declares digestOnComplete false. Reported skipped with that
        // reason rather than passed, which is the distinction that matters.
        expect(report.checks.filter((c) => c.skipped).map((c) => ({ name: c.name, detail: c.detail }))).toEqual([
            {
                name: "failed-completion-publishes-nothing",
                detail: "digestOnComplete is false, so this store has no verification step to fail",
            },
        ]);
        expect(report.failed).toBe(0);
        expect(report.ok).toBe(true);
    });
});

// ─── An abort never reports an erasure that did not happen ──────────────────

describe("s3UploadStore: abort with an unreadable or corrupt sidecar", () => {
    /** A stateful bucket whose `.info` reads answer `fault` while it is set. */
    function bucketWithInfoFault() {
        const backend = statefulS3Bucket({ minPartSize: 8 });
        let fault: Error | undefined;
        const { client } = createMockClient({
            ...backend.handlers,
            GetObjectCommand: (input) => {
                if (fault !== undefined && String(input.Key).endsWith(".info")) throw fault;
                return backend.handlers.GetObjectCommand!(input);
            },
        });
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 8 });
        return {
            backend,
            store,
            setFault: (err: Error | undefined) => {
                fault = err;
            },
        };
    }

    test("a 503 on the sidecar read throws and leaves the sidecars and the multipart upload in place", async () => {
        const { backend, store, setFault } = bucketWithInfoFault();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("abc"), { now: NOW });

        setFault(s3Error("ServiceUnavailable", 503));
        await expect(store.abortUpload(uploadToken)).rejects.toBeInstanceOf(StoreUnavailableError);

        expect(backend.objects.has(`.uploads/${uploadToken}.info`)).toBe(true);
        expect(backend.objects.has(`.uploads/${uploadToken}.part`)).toBe(true);
        expect(backend.multiparts.size).toBe(1);

        // Once the backend answers again the same abort erases everything.
        setFault(undefined);
        await store.abortUpload(uploadToken);
        expect(backend.multiparts.size).toBe(0);
        expect([...backend.objects.keys()].filter((k) => k.startsWith(".uploads/"))).toEqual([]);
    });

    test("a sidecar that fails its shape check still names the multipart upload it recorded", async () => {
        const { backend, store } = bucketWithInfoFault();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        const [uploadId] = [...backend.multiparts.keys()];
        backend.objects.set(`.uploads/${uploadToken}.info`, {
            content: bytesOf(JSON.stringify({ key: "k.bin", uploadId, createdAt: "not a number" })),
            etag: '"x"',
            lastModified: new Date(NOW),
        });

        await store.abortUpload(uploadToken);

        expect(backend.multiparts.size).toBe(0);
        expect(backend.objects.has(`.uploads/${uploadToken}.info`)).toBe(false);
    });

    test("a sidecar holding only its key aborts the unclaimed multipart upload at that key, never a live one", async () => {
        const { backend, store } = bucketWithInfoFault();
        const { uploadToken: corrupt } = await store.createUpload({ key: "k.bin", now: NOW });
        const [orphanId] = [...backend.multiparts.keys()];
        const { uploadToken: live } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.createUpload({ key: "k.bin.other", now: NOW });
        backend.objects.set(`.uploads/${corrupt}.info`, {
            content: bytesOf(JSON.stringify({ key: "k.bin" })),
            etag: '"x"',
            lastModified: new Date(NOW),
        });

        await store.abortUpload(corrupt);

        expect(backend.multiparts.has(orphanId!)).toBe(false);
        expect(backend.multiparts.size).toBe(2);
        // The live upload at the same key is untouched and still completes.
        await store.appendChunk(live, 0, bytesOf("abc"), { now: NOW });
        await completeDurable(store, live, { now: NOW });
        expect(new TextDecoder().decode(backend.objects.get("k.bin")?.content)).toBe("abc");
    });

    test("unparseable JSON names nothing, so only the bookkeeping goes", async () => {
        const { backend, store } = bucketWithInfoFault();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        backend.objects.set(`.uploads/${uploadToken}.info`, {
            content: bytesOf("{not json"),
            etag: '"x"',
            lastModified: new Date(NOW),
        });

        await store.abortUpload(uploadToken);

        expect(backend.objects.has(`.uploads/${uploadToken}.info`)).toBe(false);
    });
});

// ─── A multipart upload no sidecar names is still reclaimed ─────────────────

describe("s3UploadStore: sweeping multipart uploads that have no sidecar", () => {
    /**
     * A creation that crashed between CreateMultipartUpload and its sidecar
     * write leaves a multipart upload nothing names. Its parts are billed
     * until something aborts it, and every other path to it starts from a
     * sidecar, so the sweep lists the multipart uploads themselves.
     */
    function sweepFixture(storeOpts: Partial<Parameters<typeof s3UploadStore>[0]> = {}) {
        const backend = statefulS3Bucket({ minPartSize: 8, uploadsPageSize: 1 });
        const { client, sent } = createMockClient(backend.handlers);
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 8, ...storeOpts });
        const orphan = (key: string, initiatedMs: number): string => {
            const { UploadId } = backend.handlers.CreateMultipartUploadCommand!({ Key: key }) as { UploadId: string };
            backend.multiparts.get(UploadId)!.initiated = new Date(initiatedMs);
            return UploadId;
        };
        return { backend, store, sent, orphan };
    }

    test("an old orphan under the scope is aborted and counted; a recent one is kept", async () => {
        const { backend, store, orphan } = sweepFixture({ multipartSweepPrefix: "uploads/" });
        const old = orphan("uploads/old.bin", NOW - 100_000);
        const recent = orphan("uploads/recent.bin", NOW);

        expect(await store.sweepExpired({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 0 });

        expect(backend.multiparts.has(old)).toBe(false);
        expect(backend.multiparts.has(recent)).toBe(true);
    });

    test("the lifetime cutoff alone condemns on Initiated too", async () => {
        const { backend, store, orphan } = sweepFixture({ multipartSweepPrefix: "" });
        const old = orphan("old.bin", NOW - 100_000);

        expect(await store.sweepExpired({ createdBeforeMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 0 });
        expect(backend.multiparts.has(old)).toBe(false);
    });

    test("a live upload whose multipart upload is old but whose sidecar is active is never aborted", async () => {
        const { backend, store } = sweepFixture({ multipartSweepPrefix: "" });
        const { uploadToken } = await store.createUpload({ key: "live.bin", now: NOW });
        for (const upload of backend.multiparts.values()) upload.initiated = new Date(NOW - 100_000);

        expect(await store.sweepExpired({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 0, failed: 0 });

        expect(backend.multiparts.size).toBe(1);
        await store.appendChunk(uploadToken, 0, bytesOf("abc"), { now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });
        expect(new TextDecoder().decode(backend.objects.get("live.bin")?.content)).toBe("abc");
    });

    test("multipart uploads outside the scope are another writer's and are left alone", async () => {
        const { backend, store, orphan } = sweepFixture({ multipartSweepPrefix: "uploads/" });
        const foreign = orphan("elsewhere/big.bin", NOW - 100_000);

        expect(await store.sweepExpired({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 0, failed: 0 });
        expect(backend.multiparts.has(foreign)).toBe(true);
    });

    test("without a scope the pass does not run, so a shared bucket loses nothing", async () => {
        const { backend, store, sent, orphan } = sweepFixture();
        const foreign = orphan("big.bin", NOW - 100_000);

        expect(await store.sweepExpired({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 0, failed: 0 });
        expect(backend.multiparts.has(foreign)).toBe(true);
        expect(sent.some((c) => c.name === "ListMultipartUploadsCommand")).toBe(false);
    });

    test("an unreadable sidecar leaves every candidate in place, counted as failed", async () => {
        const backend = statefulS3Bucket({ minPartSize: 8 });
        let infoFault = false;
        const { client } = createMockClient({
            ...backend.handlers,
            GetObjectCommand: (input) => {
                if (infoFault && String(input.Key).endsWith(".info")) throw s3Error("InternalError", 500);
                return backend.handlers.GetObjectCommand!(input);
            },
        });
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 8, multipartSweepPrefix: "" });
        await store.createUpload({ key: "live.bin", now: NOW });
        for (const upload of backend.multiparts.values()) upload.initiated = new Date(NOW - 100_000);
        infoFault = true;

        // The live upload's sidecar was written at NOW, so the sidecar pass
        // keeps it; the multipart pass cannot prove which upload it names.
        expect(await store.sweepExpired({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 0, failed: 1 });
        expect(backend.multiparts.size).toBe(1);
    });

    test("an abort the backend refuses is counted as failed and the scan goes on", async () => {
        const backend = statefulS3Bucket({ minPartSize: 8 });
        const { client } = createMockClient({
            ...backend.handlers,
            AbortMultipartUploadCommand: (input) => {
                if (input.Key === "a.bin") throw s3Error("AccessDenied", 403);
                return backend.handlers.AbortMultipartUploadCommand!(input);
            },
        });
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 8, multipartSweepPrefix: "" });
        for (const key of ["a.bin", "b.bin"]) {
            const { UploadId } = backend.handlers.CreateMultipartUploadCommand!({ Key: key }) as { UploadId: string };
            backend.multiparts.get(UploadId)!.initiated = new Date(NOW - 100_000);
        }

        expect(await store.sweepExpired({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 1 });
        expect([...backend.multiparts.values()].map((u) => u.key)).toEqual(["a.bin"]);
    });
});

describe("s3UploadStore: an acknowledged offset never decreases", () => {
    /**
     * A parked tail holds bytes an earlier append acknowledged. It may stop
     * counting only at the instant its bytes count somewhere else, so no
     * failure between two writes can lower the offset a probe reports.
     */
    const fixture = (faults: { uploadPart?: () => void } = {}) => {
        const backend = statefulS3Bucket({ minPartSize: 8 });
        const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
        const handlers: Record<string, CommandHandler> = {};
        for (const [name, handler] of Object.entries(backend.handlers)) {
            handlers[name] = (input) => {
                sent.push({ name, input });
                if (name === "UploadPartCommand") faults.uploadPart?.();
                return handler(input);
            };
        }
        const { client } = createMockClient(handlers);
        return { backend, sent, store: s3UploadStore({ client, bucket: "b", minPartSize: 8 }) };
    };
    const tailWrites = (sent: Array<{ name: string; input: Record<string, unknown> }>) =>
        sent.filter(
            (c) =>
                (c.name === "PutObjectCommand" || c.name === "DeleteObjectCommand") &&
                String(c.input.Key).endsWith(".part"),
        );

    test("a part upload that fails after a tail exists leaves the offset at committed plus the tail", async () => {
        let failNext = false;
        const { store } = fixture({
            uploadPart: () => {
                if (failNext) throw s3Error("ServiceUnavailable", 503);
            },
        });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("0123456789"), { now: NOW });
        expect((await store.getUploadState(uploadToken)).offset).toBe(10);

        failNext = true;
        await expect(store.appendChunk(uploadToken, 10, bytesOf("abcdefgh"), { now: NOW })).rejects.toBeInstanceOf(
            StoreUnavailableError,
        );
        expect((await store.getUploadState(uploadToken)).offset).toBe(10);

        failNext = false;
        await store.appendChunk(uploadToken, 10, bytesOf("abcdefgh"), { now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });
    });

    test("an append that fills no part replaces the tail with one write pinned to its version", async () => {
        const { backend, sent, store } = fixture();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("abc"), { now: NOW });
        const parkedEtag = backend.objects.get(`.uploads/${uploadToken}.part`)?.etag;
        sent.length = 0;

        await store.appendChunk(uploadToken, 3, bytesOf("de"), { now: NOW });

        const writes = tailWrites(sent);
        expect(writes.map((c) => c.name)).toEqual(["PutObjectCommand"]);
        expect(writes[0]?.input.IfMatch).toBe(parkedEtag);
        expect((await store.getUploadState(uploadToken)).offset).toBe(5);
    });

    test("an append that carries no byte leaves the tail untouched", async () => {
        const { sent, store } = fixture();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("abc"), { now: NOW });
        sent.length = 0;

        expect(await store.appendChunk(uploadToken, 3, new Uint8Array(0), { now: NOW })).toEqual({
            bytesWritten: 0,
            interrupted: false,
        });
        expect(tailWrites(sent)).toEqual([]);
        expect((await store.getUploadState(uploadToken)).offset).toBe(3);
    });

    test("a completion refused for its length writes nothing and keeps the tail", async () => {
        const { sent, store } = fixture();
        const { uploadToken } = await store.createUpload({ key: "k.bin", length: 20, now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("0123456789"), { now: NOW });
        sent.length = 0;

        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );
        expect(sent.some((c) => c.name === "UploadPartCommand")).toBe(false);
        expect(tailWrites(sent)).toEqual([]);
        expect((await store.getUploadState(uploadToken)).offset).toBe(10);
    });
});

describe("s3UploadStore: S3's 10,000-part ceiling", () => {
    /**
     * S3 assembles at most 10,000 parts. A known length sizes the parts so the
     * whole representation fits; a deferred length cannot, so an append that
     * would need part 10,001 is refused as a non-fatal append bound and the
     * upload stays completable. One-byte minimum parts keep the numbers small.
     */
    const patterned = (n: number, from = 0): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (from + i) % 251);
    const fixture = () => {
        const backend = statefulS3Bucket({ minPartSize: 1 });
        const { client } = createMockClient(backend.handlers);
        return { backend, store: s3UploadStore({ client, bucket: "b", minPartSize: 1 }) };
    };

    test("a length known at creation sizes the parts to fit, and the upload completes", async () => {
        const { backend, store } = fixture();
        const { uploadToken } = await store.createUpload({ key: "k.bin", length: 25_000, now: NOW });
        await store.appendChunk(uploadToken, 0, patterned(25_000), { now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });
        expect(backend.objects.get("k.bin")?.content).toEqual(patterned(25_000));
    });

    test("a length declared after minimum-size parts sizes the remaining parts to fit", async () => {
        const { backend, store } = fixture();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, patterned(9_000), { now: NOW });
        await store.appendChunk(uploadToken, 9_000, patterned(3_000, 9_000), { length: 12_000, now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });
        expect(backend.objects.get("k.bin")?.content).toEqual(patterned(12_000));
    });

    test("a deferred-length append that would need part 10,001 is a non-fatal bound", async () => {
        const { backend, store } = fixture();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, patterned(9_999), { now: NOW });
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(patterned(1, 9_999));
                controller.enqueue(patterned(5, 10_000));
                controller.close();
            },
        });

        const err = await store.appendChunk(uploadToken, 9_999, body, { now: NOW }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UploadAppendBoundError);
        expect((err as UploadAppendBoundError).durableOffset).toBe(10_000);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(10_000);
        expect(state.status).not.toBe("invalidated");
        await completeDurable(store, uploadToken, { now: NOW });
        expect(backend.objects.get("k.bin")?.content).toEqual(patterned(10_000));
    });

    test("a length no 10,000 parts of S3's largest part size can hold is refused at creation", async () => {
        const { backend, store } = fixture();
        await expect(
            store.createUpload({ key: "k.bin", length: 10_000 * 5 * 1024 * MiB + 1, now: NOW }),
        ).rejects.toBeInstanceOf(RangeError);
        expect(backend.multiparts.size).toBe(0);
    });
});

describe("s3UploadStore: the sealed completion plan", () => {
    /**
     * A stateful bucket whose publishing commit first runs `between`, the
     * moment after the seal and the snapshot and before the publish lands.
     * The publish probe's canaries never reach it (the mock client answers
     * them), so `between` sees only the upload's own commit.
     */
    function sealedFixture(between: (backend: ReturnType<typeof statefulS3Bucket>) => Promise<void> | void) {
        const backend = statefulS3Bucket({ minPartSize: 8 });
        const complete = backend.handlers.CompleteMultipartUploadCommand;
        if (complete === undefined) throw new Error("stateful bucket has no CompleteMultipartUploadCommand");
        let ran = false;
        const { client, sent } = createMockClient({
            ...backend.handlers,
            CompleteMultipartUploadCommand: async (input) => {
                if (!ran) {
                    ran = true;
                    await between(backend);
                }
                return complete(input);
            },
        });
        return { backend, sent, store: s3UploadStore({ client, bucket: "b", minPartSize: 8 }) };
    }

    test("an append whose write lands after the seal is refused, and its bytes are not in the published object", async () => {
        // The append reads the state before the seal and writes after it: its
        // bytes are durable, but the plan was already fixed at 8. Without the
        // fence the append would be acknowledged and silently left out.
        const held = parkedBody(bytesOf("xyz"));
        const pending: { late?: Promise<unknown> } = {};
        const { backend, store } = sealedFixture(async () => {
            held.release();
            await pending.late;
        });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("01234567"), { now: NOW });

        pending.late = store.appendChunk(uploadToken, 8, held.body, { now: NOW }).then(
            () => undefined,
            (err: unknown) => err,
        );
        await held.pulled;

        await store.completeUpload(uploadToken, { expectedLength: 8, now: NOW });

        const refusal = await pending.late;
        expect(refusal).toBeInstanceOf(UploadOffsetConflictError);
        expect((refusal as UploadOffsetConflictError).durableOffset).toBe(8);
        expect(new TextDecoder().decode(backend.objects.get("k.bin")?.content)).toBe("01234567");
        expect((await store.getUploadState(uploadToken)).status).toBe("complete");
    });

    test("an append arriving once the seal is written is refused before it writes anything", async () => {
        const { sent, store } = sealedFixture(() => undefined);
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("01234567"), { now: NOW });
        await store.completeUpload(uploadToken, { expectedLength: 8, now: NOW });
        sent.length = 0;

        await expect(store.appendChunk(uploadToken, 8, bytesOf("x"), { now: NOW })).rejects.toThrow();
        expect(sent.some((c) => c.name === "UploadPartCommand" || c.name === "PutObjectCommand")).toBe(false);
    });

    for (const [what, preexisting] of [
        ["an empty key", false],
        ["a key whose object changed", true],
    ] as const) {
        test(`a destination written between seal and publish over ${what} is a conflict, and the writer's object stands`, async () => {
            const foreign = bytesOf("someone else's object");
            const { backend, store } = sealedFixture((bucket) => {
                bucket.objects.set("k.bin", { content: foreign, etag: '"foreign"', lastModified: new Date(NOW) });
            });
            if (preexisting) {
                backend.objects.set("k.bin", { content: bytesOf("old"), etag: '"old"', lastModified: new Date(NOW) });
            }
            const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
            await store.appendChunk(uploadToken, 0, bytesOf("01234567"), { now: NOW });

            await expect(store.completeUpload(uploadToken, { expectedLength: 8, now: NOW })).rejects.toBeInstanceOf(
                UploadDestinationConflictError,
            );

            expect(backend.objects.get("k.bin")?.content).toEqual(foreign);
            expect(backend.objects.get("k.bin")?.etag).toBe('"foreign"');
            // Nothing published, so nothing is recorded as completed, and a
            // retry reports the same conflict instead of overwriting.
            await expect(store.completeUpload(uploadToken, { expectedLength: 8, now: NOW })).rejects.toBeInstanceOf(
                UploadDestinationConflictError,
            );
            expect(backend.objects.get("k.bin")?.content).toEqual(foreign);
        });
    }

    test("a publish over an object present at seal time replaces exactly that object", async () => {
        const { backend, sent, store } = sealedFixture(() => undefined);
        backend.objects.set("k.bin", { content: bytesOf("old"), etag: '"old"', lastModified: new Date(NOW) });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("01234567"), { now: NOW });

        await store.completeUpload(uploadToken, { expectedLength: 8, now: NOW });

        const commit = sent.find((c) => c.name === "CompleteMultipartUploadCommand");
        expect(commit?.input.IfMatch).toBe('"old"');
        expect(commit?.input.IfNoneMatch).toBeUndefined();
        expect(new TextDecoder().decode(backend.objects.get("k.bin")?.content)).toBe("01234567");
    });

    test("a completion whose publish response was lost adopts its own object on retry, by publication id", async () => {
        let lose = true;
        const backend = statefulS3Bucket({ minPartSize: 8 });
        const complete = backend.handlers.CompleteMultipartUploadCommand;
        if (complete === undefined) throw new Error("stateful bucket has no CompleteMultipartUploadCommand");
        backend.handlers.CompleteMultipartUploadCommand = (input) => {
            const answer = complete(input);
            if (lose) {
                lose = false;
                throw s3Error("RequestTimeout", 500);
            }
            return answer;
        };
        const { client } = createMockClient(backend.handlers);
        const retrying = s3UploadStore({ client, bucket: "b", minPartSize: 8 });
        const { uploadToken } = await retrying.createUpload({ key: "k.bin", now: NOW });
        await retrying.appendChunk(uploadToken, 0, bytesOf("01234567"), { now: NOW });

        await expect(retrying.completeUpload(uploadToken, { expectedLength: 8, now: NOW })).rejects.toThrow();
        const published = backend.objects.get("k.bin");
        expect(published).toBeDefined();

        const result = await retrying.completeUpload(uploadToken, { expectedLength: 8, now: NOW });

        expect(result.etag).toBe(published?.etag);
        expect((await retrying.getUploadState(uploadToken)).status).toBe("complete");
    });

    test("a lock-free state read adopts nothing and writes nothing; a repairing read promotes", async () => {
        const { store, sent, uploadToken } = await createStoreWithUpload({
            GetObjectCommand: routeGetObject({
                info: sealedInfo,
            }),
            ListPartsCommand: goneMultipart,
            HeadObjectCommand: headDestination({
                ContentLength: 42,
                ETag: '"pub"',
                Metadata: { "upload-publication": "pub-id" },
            }),
            PutObjectCommand: () => ({}),
            DeleteObjectCommand: () => ({}),
        });
        sent.length = 0;

        const unrepaired = await store.getUploadState(uploadToken, { repair: false });

        expect(unrepaired.status).toBe("complete");
        expect(sent.some((c) => c.name === "PutObjectCommand" || c.name === "DeleteObjectCommand")).toBe(false);

        expect((await store.getUploadState(uploadToken)).status).toBe("complete");
        const promotion = sent.find((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"));
        expect(promotion).toBeDefined();
        expect((JSON.parse(String(promotion?.input.Body)) as Record<string, unknown>).completed).toBe(true);
    });

    test("a backend that ignores the publish precondition is refused before anything publishes, naming the option", async () => {
        const commits: Record<string, unknown>[] = [];
        const { client } = createMockClient(
            {
                CreateMultipartUploadCommand: () => ({ UploadId: "mp" }),
                UploadPartCommand: () => ({ ETag: '"p"' }),
                AbortMultipartUploadCommand: () => ({}),
                CompleteMultipartUploadCommand: (input) => {
                    commits.push(input);
                    return { ETag: '"accepted"' };
                },
                PutObjectCommand: (input) => {
                    if (input.Body === "" && input.IfNoneMatch === "*" && String(input.Key).endsWith(".part")) {
                        // Honour the sidecar probe so only the publish probe is in question.
                        const key = String(input.Key);
                        if (commits.some((c) => c.Key === `sidecar:${key}`)) throw s3Error("PreconditionFailed", 412);
                        commits.push({ Key: `sidecar:${key}` });
                    }
                    return {};
                },
                DeleteObjectCommand: () => ({}),
                GetObjectCommand: routeGetObject({ info: () => infoResponse({ createdAt: NOW }) }),
                ListPartsCommand: () => ({ Parts: [{ PartNumber: 1, Size: 3, ETag: '"p"' }] }),
                HeadObjectCommand: () => {
                    throw notFound("NotFound");
                },
            },
            "passthrough",
        );
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 1 });
        const { uploadToken } = await store.createUpload({ key: "docs/file.bin", now: NOW });

        await expect(store.completeUpload(uploadToken, { expectedLength: 3, now: NOW })).rejects.toThrow(
            /publishCas: false/,
        );
        // Only canary commits were sent; the upload's own key never was.
        expect(commits.some((c) => c.Key === "docs/file.bin")).toBe(false);
    });

    test("publishCas: false publishes unconditionally and probes nothing", async () => {
        const backend = statefulS3Bucket({ minPartSize: 8 });
        const { client, sent } = createMockClient(backend.handlers);
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 8, publishCas: false });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("01234567"), { now: NOW });

        await store.completeUpload(uploadToken, { expectedLength: 8, now: NOW });

        const commits = sent.filter((c) => c.name === "CompleteMultipartUploadCommand");
        expect(commits).toHaveLength(1);
        expect(commits[0]?.input.IfNoneMatch).toBeUndefined();
        expect(commits[0]?.input.IfMatch).toBeUndefined();
        expect(new TextDecoder().decode(backend.objects.get("k.bin")?.content)).toBe("01234567");
    });
});

/** A stateful bucket whose every command is also recorded, by name and with its key. */
function recordingBucket(opts: StatefulBucketOptions = {}) {
    const backend = statefulS3Bucket(opts);
    const sent: SentCommand[] = [];
    const handlers: Record<string, CommandHandler> = {};
    for (const [name, handler] of Object.entries(backend.handlers)) {
        handlers[name] = (input) => {
            sent.push({ name, input });
            return handler(input);
        };
    }
    const { client } = createMockClient(handlers);
    return { backend, sent, client };
}

describe("s3UploadStore: round trips per append", () => {
    /**
     * The upload sidecar records facts that change the upload's state (a
     * declared length, an invalidation, a publish), never the passage of an
     * append: idleness is read off the parts and the tail the append wrote.
     */
    test("a PATCH that commits a part and parks a tail sends 5 + N commands and writes no sidecar", async () => {
        const { sent, client } = recordingBucket({ minPartSize: 8 });
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 8 });
        const uploads = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0 });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("0123456789"), { now: NOW });
        sent.length = 0;

        // Through the orchestrator: its state read (sidecar, parts, tail) is
        // handed to the append, which reads nothing again before writing. The
        // 2-byte tail and 10 new bytes commit one 8-byte part and park 4
        // bytes; the one read after is the completion fence on the sidecar.
        const outcome = await uploads.append(uploadToken, {
            offset: 10,
            contentLength: 10,
            body: bytesOf("abcdefghij"),
            complete: false,
        });
        expect(outcome).toMatchObject({ kind: "appended", offset: 20 });

        const parts = sent.filter((c) => c.name === "UploadPartCommand").length;
        expect(parts).toBe(1);
        expect(sent.map((c) => c.name)).toEqual([
            "GetObjectCommand",
            "ListPartsCommand",
            "GetObjectCommand",
            "UploadPartCommand",
            "PutObjectCommand",
            "GetObjectCommand",
        ]);
        expect(String(sent.at(-1)?.input.Key).endsWith(".info")).toBe(true);
        expect(sent).toHaveLength(5 + parts);
        expect(sent.some((c) => c.name === "PutObjectCommand" && String(c.input.Key).endsWith(".info"))).toBe(false);
        expect((await store.getUploadState(uploadToken)).offset).toBe(20);
    });

    test("an append handed a state read a preempting append made stale is refused at the true offset", async () => {
        const { backend, sent, client } = recordingBucket({ minPartSize: 8 });
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 8 });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytesOf("0123456789"), { now: NOW });

        // A reads the state for its append, then a holder that took the lock
        // from it appends 3 bytes, replacing the tail A read.
        const stale = await store.getUploadState(uploadToken, { forAppend: true });
        expect(stale.offset).toBe(10);
        expect(stale.snapshot).toBeDefined();
        await store.appendChunk(uploadToken, 10, bytesOf("abc"), { now: NOW });
        sent.length = 0;

        const rejection = await store
            .appendChunk(uploadToken, stale.offset, bytesOf("XYZ"), { now: NOW, snapshot: stale.snapshot })
            .then(
                () => undefined,
                (err: unknown) => err,
            );
        expect(rejection).toBeInstanceOf(UploadOffsetConflictError);
        expect((rejection as UploadOffsetConflictError).durableOffset).toBe(13);
        // Nothing was read again: the park pinned to the stale tail is what
        // refused, and only then is the true offset read.
        expect(sent.map((c) => c.name)).toEqual(["PutObjectCommand", "ListPartsCommand", "HeadObjectCommand"]);
        expect(sent[0]?.input.IfMatch).toBeDefined();
        // The winner's bytes are what the upload holds.
        await completeDurable(store, uploadToken, { now: NOW });
        expect(new TextDecoder().decode(backend.objects.get("k.bin")?.content)).toBe("0123456789abc");
    });

    test("a snapshot is honoured once, for its own upload; any other is read past", async () => {
        const { sent, client } = recordingBucket({ minPartSize: 8 });
        const store = s3UploadStore({ client, bucket: "b", minPartSize: 8 });
        const first = await store.createUpload({ key: "a.bin", now: NOW });
        const second = await store.createUpload({ key: "b.bin", now: NOW });
        const { snapshot } = await store.getUploadState(first.uploadToken, { forAppend: true });
        // Three state reads (sidecar, parts, tail) plus the completion fence.
        const reads = () => sent.filter((c) => c.name === "GetObjectCommand" || c.name === "ListPartsCommand");

        // Another upload's append reads its own state, and the handle is spent.
        sent.length = 0;
        await store.appendChunk(second.uploadToken, 0, bytesOf("x"), { now: NOW, snapshot });
        expect(reads()).toHaveLength(4);
        sent.length = 0;
        await store.appendChunk(first.uploadToken, 0, bytesOf("y"), { now: NOW, snapshot });
        expect(reads()).toHaveLength(4);

        // A handle this store never minted carries nothing.
        sent.length = 0;
        await store.appendChunk(first.uploadToken, 1, bytesOf("z"), { now: NOW, snapshot: Object.freeze({}) });
        expect(reads()).toHaveLength(4);
    });
});

describe("s3Store's default reservedPrefix covers s3UploadStore's default uploadPrefix", () => {
    test("every bookkeeping object the upload store writes is refused by the read store before any command", async () => {
        const { client, sent } = objectBackedClient();
        const uploads = s3UploadStore({ client, bucket: "b" });
        const { uploadToken } = await uploads.createUpload({ key: "docs/file.bin", length: 100, now: NOW });
        await uploads.appendChunk(uploadToken, 0, bytesOf("short tail"), { now: NOW });
        const written = sent.filter((c) => c.name === "PutObjectCommand").map((c) => String(c.input.Key));
        expect(written.length).toBeGreaterThanOrEqual(2);

        const reads: unknown[] = [];
        const reader = s3Store({
            client: { send: async (command: unknown) => reads.push(command) } as unknown as S3Client,
            bucket: "b",
        });
        for (const key of written) {
            await expect(reader.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(reader.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
        expect(reads).toHaveLength(0);
    });

    test("a custom uploadPrefix fed to reservedPrefix makes the read store refuse every key the upload store wrote", async () => {
        const { client, sent } = objectBackedClient();
        const uploads = s3UploadStore({ client, bucket: "b", uploadPrefix: "staging/inflight" });
        expect(uploads.uploadPrefix).toBe("staging/inflight/");
        expect(s3UploadStore({ client, bucket: "b" }).uploadPrefix).toBe(".uploads/");
        const { uploadToken } = await uploads.createUpload({ key: "docs/file.bin", length: 100, now: NOW });
        await uploads.appendChunk(uploadToken, 0, bytesOf("short tail"), { now: NOW });
        const written = sent.filter((c) => c.name === "PutObjectCommand").map((c) => String(c.input.Key));
        expect(written.length).toBeGreaterThanOrEqual(2);

        const reads: unknown[] = [];
        const reader = s3Store({
            client: { send: async (command: unknown) => reads.push(command) } as unknown as S3Client,
            bucket: "b",
            reservedPrefix: uploads.uploadPrefix,
        });
        for (const key of written) {
            await expect(reader.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
        expect(reads).toHaveLength(0);
    });
});
