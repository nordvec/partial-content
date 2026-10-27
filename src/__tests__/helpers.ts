import { expect } from "bun:test";
import { createHash } from "node:crypto";
import type { ObjectStream } from "../object-store";
import type { CompleteUploadOptions, CompletedUpload } from "../upload-store";
import {
    isUploadDigestMismatchError,
    isUploadNotFoundError,
    UploadNotFoundError,
    type ResumableWriteStore,
    type UploadDigestMismatchError,
} from "../upload-store";

/** Base64 SHA-256 of `data`, the form `expectedDigest` and `digest` carry. */
export function sha256b64(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("base64");
}

/** Read a body of either arm to the end, as UTF-8. */
export async function drain(body: ReadableStream<Uint8Array> | Uint8Array): Promise<string> {
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * Complete an upload holding `appended` against a digest of other bytes, and
 * return the mismatch it must throw.
 *
 * The caught value is typed `unknown` and reaches its fields only through
 * `isUploadDigestMismatchError`, so the matcher losing its type predicate
 * fails typecheck:tests here rather than passing silently.
 */
export async function completeWithWrongDigest(
    store: ResumableWriteStore,
    uploadToken: string,
    appended: string,
): Promise<UploadDigestMismatchError> {
    const wrong = sha256b64(`${appended} tampered`);
    const err = await store
        .completeUpload(uploadToken, {
            expectedDigests: { "sha-256": wrong },
            expectedLength: new TextEncoder().encode(appended).byteLength,
            now: 2,
        })
        .catch((e: unknown) => e);
    if (!isUploadDigestMismatchError(err)) throw new Error("completion did not throw a digest mismatch");
    expect(err.expectedDigest).toBe(wrong);
    expect(err.actualDigest).toBe(sha256b64(appended));
    return err;
}

/**
 * Create an upload on `key` and append three bytes at `now`, completing it
 * when `complete` is set. Returns the upload token.
 */
export async function threeByteUpload(
    store: ResumableWriteStore,
    key: string,
    now: number,
    { complete }: { complete: boolean },
): Promise<string> {
    const { uploadToken } = await store.createUpload({ key, now });
    await store.appendChunk(uploadToken, 0, new Uint8Array([1, 2, 3]), { now });
    if (complete) await store.completeUpload(uploadToken, { expectedLength: 3, now });
    return uploadToken;
}

/**
 * Narrow a body to its streaming arm.
 *
 * `ObjectStream["body"]` is a union because the contract admits both, and
 * `memory` and `fs` genuinely return bytes on some paths. The adapters that
 * front a network backend can only ever produce the stream, so a test against
 * one of those would otherwise narrow the union at every call site.
 *
 * Throws rather than casting: if an adapter ever starts returning bytes, the
 * test that assumed otherwise should say so out loud instead of failing later
 * on a missing method.
 */
export function asStream(body: ObjectStream["body"]): ReadableStream<Uint8Array<ArrayBuffer>> {
    if (body instanceof Uint8Array) throw new Error("expected a streaming body, got bytes");
    return body;
}

/**
 * An upload body whose first pull runs `beforeFirstChunk`, then yields the
 * chunks. A zero high-water mark keeps the runtime from pulling at
 * construction, so the callback runs when the store first reads the body,
 * after it has read its own record, which is the ordering a stolen lock
 * produces: the holder's snapshot is taken, then the world moves under it.
 */
export function interleavedStream(
    beforeFirstChunk: () => Promise<void>,
    ...chunks: Uint8Array[]
): ReadableStream<Uint8Array> {
    let started = false;
    return new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                if (!started) {
                    started = true;
                    await beforeFirstChunk();
                }
                const next = chunks.shift();
                if (next === undefined) controller.close();
                else controller.enqueue(next);
            },
        },
        { highWaterMark: 0 },
    );
}

/** Text chunks delivered one per pull, then `end` settles the stream. */
function textStream(
    chunks: readonly string[],
    end: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
            else end(controller);
        },
    });
}

/** A well-behaved stream delivering the given chunks, then closing. */
export function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    return textStream(chunks, (controller) => controller.close());
}

/** Delivers the chunks, then errors: a client that vanished mid-request. */
export function tornStream(...chunks: string[]): ReadableStream<Uint8Array> {
    return textStream(chunks, (controller) => controller.error(new Error("connection reset")));
}

/**
 * The durable length a completion is sealed at, read the way the orchestrator
 * learns it: from the store's own state. An adapter test that is not about the
 * seal completes at whatever is durable; one that is passes a literal instead.
 * A token the store does not know seals at 0, so the completion itself raises
 * the refusal the test asserts.
 */
async function durableLength(store: Pick<ResumableWriteStore, "getUploadState">, uploadToken: string): Promise<number> {
    try {
        return (await store.getUploadState(uploadToken)).offset;
    } catch (err) {
        if (isUploadNotFoundError(err)) return 0;
        throw err;
    }
}

/** Garbage tokens answer UploadNotFoundError on every token-taking read and write, never a parse crash. */
export async function expectGarbageTokensNotFound(store: ResumableWriteStore, now: number): Promise<void> {
    await expect(store.getUploadState("!!!not-base64!!!")).rejects.toBeInstanceOf(UploadNotFoundError);
    await expect(store.appendChunk("AAAA", 0, new Uint8Array([1]), { now })).rejects.toBeInstanceOf(
        UploadNotFoundError,
    );
    await expect(store.completeUpload("e30", { expectedLength: 0, now })).rejects.toBeInstanceOf(UploadNotFoundError);
}

/** Completes at the store's durable length (see {@link durableLength}). */
export async function completeDurable(
    store: Pick<ResumableWriteStore, "getUploadState" | "completeUpload">,
    uploadToken: string,
    opts: Omit<CompleteUploadOptions, "expectedLength">,
): Promise<CompletedUpload> {
    return store.completeUpload(uploadToken, { ...opts, expectedLength: await durableLength(store, uploadToken) });
}

/** Creates an upload of `data` at `key`, completes it at its length, and returns its token. */
export async function publishedUpload(
    store: ResumableWriteStore,
    key: string,
    data: Uint8Array,
    now: number,
): Promise<string> {
    const { uploadToken } = await store.createUpload({ key, now });
    await store.appendChunk(uploadToken, 0, data, { now });
    await store.completeUpload(uploadToken, { expectedLength: data.byteLength, now });
    return uploadToken;
}
