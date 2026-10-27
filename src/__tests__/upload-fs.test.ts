import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { drain, sha256b64, completeWithWrongDigest, streamOf, tornStream, completeDurable } from "./helpers";
import {
    chmod,
    mkdtemp,
    mkdir,
    open,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    symlink,
    unlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    fsStore,
    fsUploadStore,
    ObjectNotFoundError,
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadOverrunError,
    UploadDigestMismatchError,
} from "../fs";
import { isUploadOffsetConflictError, UploadDestinationConflictError } from "../upload-store";
import { isCorruptUploadState } from "../upload-internals";

const enc = new TextEncoder();

let root: string;
/** Aborted when the test ends, so setup a timed-out test started stops at its next step. */
let teardown: AbortController;
/** Work a test started that teardown must see settle before it removes the root. */
let inFlight: Promise<unknown>[];

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pc-upload-fs-"));
    teardown = new AbortController();
    inFlight = [];
});

afterEach(async () => {
    // A timed-out test leaves its body running; removing the root under a
    // write it still has in progress fails that write outside any test.
    teardown.abort();
    await Promise.allSettled(inFlight);
    await rm(root, { recursive: true, force: true });
});

/** Registers work with teardown, which waits for it before removing the root. */
function tracked<T>(work: Promise<T>): Promise<T> {
    inFlight.push(work);
    return work;
}

/**
 * Deliver `first` cleanly, then abort and offer `late`.
 *
 * This is the shape a lost lease makes: a read that was already in flight when
 * the holder was told to stop resolves afterwards, so the append has a chunk in
 * hand that it is no longer entitled to write. The prefix that landed before
 * the abort is still owed to the caller.
 */
function abortBeforeLateChunk(ac: AbortController, first: string, late: string): ReadableStream<Uint8Array> {
    let pulls = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            pulls += 1;
            if (pulls === 1) {
                controller.enqueue(enc.encode(first));
                return undefined;
            }
            if (pulls > 2) {
                // Bounded on purpose: if the append ever stops refusing the late
                // chunk, this closes instead of producing forever, so the
                // regression shows up as this test failing and not as a hang in
                // whatever runs next.
                controller.close();
                return undefined;
            }
            // The first chunk is given time to land before the lease goes. This
            // fixture is about a read in flight AT the abort, and without the
            // delay it would instead race the write that preceded it, which is a
            // different question and a nondeterministic one.
            return new Promise<void>((resolve) => {
                setTimeout(() => {
                    ac.abort();
                    controller.enqueue(enc.encode(late));
                    resolve();
                }, 25);
            });
        },
    });
}

/**
 * A body that never ends, recording whether the store released it. The caller
 * hands ownership over with the call, so a refusal that never reads it still
 * owes it a cancel; left open, the peer goes on sending into a stream nobody
 * reads.
 */
function heldBody(): { body: ReadableStream<Uint8Array>; wasReleased: () => boolean } {
    let released = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            controller.enqueue(enc.encode("x"));
        },
        cancel() {
            released = true;
        },
    });
    return { body, wasReleased: () => released };
}

/** A file in a token's upload directory (test-side mirror of the layout). */
/** An upload at "k.bin" holding "abc", durable at offset 3. */
async function abcUpload() {
    const store = fsUploadStore({ root });
    const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
    await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
    return { store, uploadToken };
}

/** Completing the 3-byte upload at 
ow is refused because the destination holds a foreign object. */
async function expectDestinationConflict(
    store: ReturnType<typeof fsUploadStore>,
    uploadToken: string,
    now: number,
): Promise<void> {
    await expect(store.completeUpload(uploadToken, { expectedLength: 3, now })).rejects.toBeInstanceOf(
        UploadDestinationConflictError,
    );
}

function uploadFile(token: string, name: string): string {
    return join(root, ".uploads", token, name);
}

/** The workspace holds exactly one upload's directory, and that directory no temp or staged copy. */
async function expectOnlyResource(token: string): Promise<void> {
    expect(await readdir(join(root, ".uploads"))).toEqual([token]);
    const leftovers = (await readdir(join(root, ".uploads", token))).filter(
        (name) => name.endsWith(".tmp") || name === "staged" || name === "displaced",
    );
    expect(leftovers).toEqual([]);
}

/** A record file's fields, parsed. */
async function readRecord(token: string, name: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(uploadFile(token, name), "utf8")) as Record<string, unknown>;
}

/** The identity a seal records for the file at `path` (test-side mirror of the record). */
async function identityOf(path: string): Promise<Record<string, string>> {
    const s = await stat(path, { bigint: true });
    return { dev: `${s.dev}`, ino: `${s.ino}`, size: `${s.size}`, mtimeNs: `${s.mtimeNs}` };
}

/**
 * Seal an upload the way a completer that stopped right after SEAL leaves it:
 * the plan recorded, nothing staged. The test then acts in the window between
 * the seal and the publish, which no store call exposes.
 */
async function sealAs(token: string, length: number, destination: Record<string, string> | null): Promise<void> {
    await writeFile(uploadFile(token, "seal.json"), JSON.stringify({ length, destination }));
}

/** Replace the file at `path` with new content on a new inode, as a third party's write does. */
async function replaceFile(path: string, content: string): Promise<void> {
    await writeFile(`${path}.incoming`, content);
    await rename(`${path}.incoming`, path);
}

/**
 * An upload of `content` at `key` whose publish landed and whose completion
 * record did not: a crash between PUBLISH and RECORD. A completion runs to the
 * end and its record is removed again; the in-flight bytes the record step
 * also removes are never read by recovery, so the state is the crash's.
 */
async function publishedWithoutRecord(
    store: ReturnType<typeof fsUploadStore>,
    key: string,
    content: string,
): Promise<string> {
    const { uploadToken } = await store.createUpload({ key, length: content.length, now: 0 });
    await store.appendChunk(uploadToken, 0, enc.encode(content), { now: 1 });
    await completeDurable(store, uploadToken, { now: 2 });
    await unlink(uploadFile(uploadToken, "complete.json"));
    return uploadToken;
}

describe("fsUploadStore: capability flags", () => {
    test("advertises exact offsets, atomic completion, sha-256, byte-exact appends", () => {
        const store = fsUploadStore({ root });
        expect(store.exactOffsetRecovery).toBe(true);
        expect(store.atomicCompletion).toBe(true);
        expect(store.digestOnComplete).toEqual(["sha-256", "sha-512"]);
        expect(store.appendGranularity).toBeUndefined();
    });
});

describe("fsUploadStore: create / state / append / complete round trip", () => {
    test("full lifecycle publishes atomically and an fsStore over the root serves it", async () => {
        const store = fsUploadStore({ root });

        const { uploadToken } = await store.createUpload({
            key: "docs/q4/report.txt",
            length: 9,
            metadata: { filename: "report.txt" },
            now: 1_000,
        });

        const fresh = await store.getUploadState(uploadToken);
        expect(fresh.offset).toBe(0);
        expect(fresh.length).toBe(9);
        expect(fresh.status === "complete").toBe(false);
        expect(fresh.status === "invalidated").toBe(false);
        expect(fresh.createdAt).toBe(1_000);
        expect(fresh.lastAppendAt).toBeUndefined();
        expect(fresh.metadata).toEqual({ filename: "report.txt" });

        const first = await store.appendChunk(uploadToken, 0, enc.encode("hello"), { now: 2_000 });
        expect(first.bytesWritten).toBe(5);
        const mid = await store.getUploadState(uploadToken);
        expect(mid.offset).toBe(5);
        expect(mid.lastAppendAt).toBe(2_000);

        const second = await store.appendChunk(uploadToken, 5, streamOf("wr", "ld"), { now: 3_000 });
        expect(second.bytesWritten).toBe(4);

        const done = await completeDurable(store, uploadToken, { now: 4_000 });
        expect(done.digest).toBe(sha256b64("hellowrld"));

        const after = await store.getUploadState(uploadToken);
        expect(after.status === "complete").toBe(true);
        expect(after.status === "invalidated").toBe(false);
        expect(after.offset).toBe(9);

        // The read side serves the published object with the SAME validator.
        const reads = fsStore({ root });
        const meta = await reads.headObject("docs/q4/report.txt");
        expect(meta.contentLength).toBe(9);
        expect(meta.etag).toBe(done.etag!);
        expect(await drain((await reads.getObject("docs/q4/report.txt")).body)).toBe("hellowrld");

        // The in-flight bytes and the staged copy are gone from the upload's
        // directory after publish; only its records remain.
        const files = await readdir(join(root, ".uploads", uploadToken));
        expect(files).not.toContain("data");
        expect(files).not.toContain("staged");
        expect(files).toContain("complete.json");
    });

    test("a zero-byte upload completes and serves", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "empty.bin", length: 0, now: 10 });
        const done = await completeDurable(store, uploadToken, { now: 20 });
        expect(done.digest).toBe(sha256b64(""));

        const served = await fsStore({ root }).getObject("empty.bin");
        expect(served.contentLength).toBe(0);
        expect(await drain(served.body)).toBe("");
    });

    test("completing onto an existing object atomically replaces it", async () => {
        await writeFile(join(root, "doc.txt"), "the old content");
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "doc.txt", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("new!"), { now: 1 });
        await completeDurable(store, uploadToken, { now: 2 });
        expect(await drain((await fsStore({ root }).getObject("doc.txt")).body)).toBe("new!");
    });

    test("completion is idempotent: a retry answers the recorded facts", async () => {
        const { store, uploadToken } = await abcUpload();
        const first = await completeDurable(store, uploadToken, { now: 2 });
        const retry = await completeDurable(store, uploadToken, { now: 3 });
        expect(retry.digest).toBe(first.digest!);
        expect(retry.etag).toBe(first.etag!);
    });
});

describe("fsUploadStore: restart simulation (no in-memory state)", () => {
    test("a fresh instance over the same root resumes from the fsynced stat", async () => {
        const writer = fsUploadStore({ root });
        const { uploadToken } = await writer.createUpload({ key: "k.bin", length: 9, now: 0 });
        await writer.appendChunk(uploadToken, 0, enc.encode("abcdef"), { now: 1 });

        // "Restart": a brand-new instance must derive identical durable state.
        const resumed = fsUploadStore({ root });
        const state = await resumed.getUploadState(uploadToken);
        expect(state.offset).toBe(6);
        expect(state.length).toBe(9);
        expect(state.createdAt).toBe(0);
        expect(state.lastAppendAt).toBe(1);

        await resumed.appendChunk(uploadToken, 6, enc.encode("ghi"), { now: 2 });
        const done = await completeDurable(resumed, uploadToken, { now: 3 });
        expect(done.digest).toBe(sha256b64("abcdefghi"));
        expect(await drain((await fsStore({ root }).getObject("k.bin")).body)).toBe("abcdefghi");
    });

    test("a publish that landed before its record is finished by the retry", async () => {
        // The window between PUBLISH and RECORD: the object is live at the key
        // and the upload has a seal and a publication but no completion.
        // Reading that as bytes lost would answer gone for a published upload
        // and the completion would never be re-delivered.
        const uploadToken = await publishedWithoutRecord(fsUploadStore({ root }), "pub/k.bin", "abcdefghi");

        const restarted = fsUploadStore({ root });
        const state = await restarted.getUploadState(uploadToken);
        expect(state).toMatchObject({ offset: 9, status: "complete" });
        const done = await completeDurable(restarted, uploadToken, { now: 3 });
        expect(done.digest).toBe(sha256b64("abcdefghi"));
        expect(done.etag).toBe((await fsStore({ root }).headObject("pub/k.bin")).etag);
        // The record is healed on disk: a later instance answers without a stat of the key.
        expect(await readRecord(uploadToken, "complete.json")).toMatchObject({ completedSize: 9 });
    });

    test("a seal with nothing staged is a completion that stopped at SEAL: the retry completes normally", async () => {
        const writer = fsUploadStore({ root });
        const { uploadToken } = await writer.createUpload({ key: "k.bin", length: 3, now: 0 });
        await writer.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
        await sealAs(uploadToken, 3, null);

        const restarted = fsUploadStore({ root });
        expect(await restarted.getUploadState(uploadToken)).toMatchObject({ offset: 3, status: "incomplete" });
        const done = await completeDurable(restarted, uploadToken, { now: 2 });
        expect(done.digest).toBe(sha256b64("abc"));
        expect(await drain((await fsStore({ root }).getObject("k.bin")).body)).toBe("abc");
    });

    test("a seal over a lost data file and nothing published is bytes lost", async () => {
        const writer = fsUploadStore({ root });
        const { uploadToken } = await writer.createUpload({ key: "k.bin", length: 3, now: 0 });
        await writer.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
        await sealAs(uploadToken, 3, null);
        await unlink(uploadFile(uploadToken, "data"));

        const restarted = fsUploadStore({ root });
        expect(await restarted.getUploadState(uploadToken)).toMatchObject({ offset: 0, status: "invalidated" });
        await expect(completeDurable(restarted, uploadToken, { now: 2 })).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(fsStore({ root }).headObject("k.bin")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("maxBytes invalidation is durable: a fresh instance still refuses", async () => {
        const writer = fsUploadStore({ root });
        const { uploadToken } = await writer.createUpload({ key: "k.bin", now: 0 });
        await expect(
            writer.appendChunk(uploadToken, 0, enc.encode("0123456789"), { maxBytes: 4, maxBytesFatal: true, now: 1 }),
        ).rejects.toBeInstanceOf(UploadOverrunError);

        const restarted = fsUploadStore({ root });
        const state = await restarted.getUploadState(uploadToken);
        expect(state.offset).toBe(4);
        expect(state.status === "invalidated").toBe(true);
        await expect(restarted.appendChunk(uploadToken, 4, enc.encode("x"), { now: 2 })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );
        await expect(completeDurable(restarted, uploadToken, { now: 3 })).rejects.toThrow(/invalidated/);
    });
});

describe("fsUploadStore: deferred-length declaration on append", () => {
    test("a length first declared on an append is fsynced and survives a fresh instance", async () => {
        const writer = fsUploadStore({ root });
        const { uploadToken } = await writer.createUpload({ key: "k.bin", now: 0 });
        expect((await writer.getUploadState(uploadToken)).length).toBeUndefined();

        await writer.appendChunk(uploadToken, 0, enc.encode("hello"), { length: 5, now: 1 });

        // A brand-new instance over the same root proves the length was durably
        // written into the sidecar, not just held in memory.
        const resumed = fsUploadStore({ root });
        const state = await resumed.getUploadState(uploadToken);
        expect(state.length).toBe(5);
        expect(state.offset).toBe(5);
    });

    test("a length already recorded at creation is never overwritten by an append", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", length: 9, now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { length: 42, now: 1 });
        expect((await fsUploadStore({ root }).getUploadState(uploadToken)).length).toBe(9);
    });
});

describe("fsUploadStore: offset conflicts", () => {
    test("a mismatched claimed offset throws with the durable offset and writes nothing", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abcde"), { now: 1 });

        const err = await store.appendChunk(uploadToken, 3, enc.encode("x"), { now: 2 }).catch((e) => e);
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect(isUploadOffsetConflictError(err)).toBe(true);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(5);
        expect((await store.getUploadState(uploadToken)).offset).toBe(5);
    });

    test("appending to a completed upload refuses with the final size", async () => {
        const { store, uploadToken } = await abcUpload();
        await completeDurable(store, uploadToken, { now: 2 });

        const err = await store.appendChunk(uploadToken, 3, enc.encode("x"), { now: 3 }).catch((e) => e);
        expect(isUploadOffsetConflictError(err)).toBe(true);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(3);
    });
});

describe("fsUploadStore: partial-write accounting", () => {
    test("a torn body reports the flushed prefix and a fresh instance agrees", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });

        const partial = await store.appendChunk(uploadToken, 0, tornStream("abc", "def"), { now: 1 });
        expect(partial.bytesWritten).toBe(6);

        const restarted = fsUploadStore({ root });
        const state = await restarted.getUploadState(uploadToken);
        expect(state.offset).toBe(6);
        expect(state.status === "invalidated").toBe(false);

        await restarted.appendChunk(uploadToken, 6, enc.encode("ghi"), { now: 2 });
        const done = await completeDurable(restarted, uploadToken, {
            expectedDigests: { "sha-256": sha256b64("abcdefghi") },
            now: 3,
        });
        expect(done.digest).toBe(sha256b64("abcdefghi"));
    });

    test("an aborted signal mid-body keeps the flushed prefix and stays resumable", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const ac = new AbortController();

        const partial = await store.appendChunk(uploadToken, 0, abortBeforeLateChunk(ac, "abc", "def"), {
            now: 1,
            signal: ac.signal,
        });
        expect(partial.bytesWritten).toBe(3);
        expect(partial.interrupted).toBe(true);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(3);
        expect(state.status === "invalidated").toBe(false);
    });

    test("a chunk whose read resolved after the abort is not written", async () => {
        // The signal is how a holder learns its lease is gone, and a read already
        // in flight resolves after that. Writing its bytes puts them over whatever
        // the new holder has since made durable at the same offset, and the caller
        // was already told this append stopped short of them.
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const ac = new AbortController();

        await store.appendChunk(uploadToken, 0, abortBeforeLateChunk(ac, "abc", "def"), {
            now: 1,
            signal: ac.signal,
        });
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(3);

        // The resumed append is the only thing that may write at offset 3.
        await store.appendChunk(uploadToken, 3, enc.encode("xyz"), { now: 2 });
        const done = await completeDurable(store, uploadToken, {
            expectedDigests: { "sha-256": sha256b64("abcxyz") },
            now: 3,
        });
        expect(done.digest).toBe(sha256b64("abcxyz"));
    });

    test("a signal aborted before the call reports a yield without touching the file", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const ac = new AbortController();
        ac.abort();
        // An abort is an interruption, not a failure: raising it would make the
        // caller classify an exception to tell a preempted write from a broken
        // one, which is the guess the return value exists to delete.
        const result = await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1, signal: ac.signal });
        expect(result).toEqual({ bytesWritten: 0, interrupted: true });
        expect((await store.getUploadState(uploadToken)).offset).toBe(0);
    });

    test("a zero-byte append is accepted and refreshes lastAppendAt", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const result = await store.appendChunk(uploadToken, 0, new Uint8Array(0), { now: 7 });
        expect(result.bytesWritten).toBe(0);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(0);
        expect(state.lastAppendAt).toBe(7);
    });
});

describe("fsUploadStore: maxBytes bound", () => {
    test("a stream crossing the bound mid-chunk keeps the exact prefix and invalidates durably", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await expect(
            store.appendChunk(uploadToken, 0, streamOf("abc", "defg"), { maxBytes: 5, maxBytesFatal: true, now: 1 }),
        ).rejects.toBeInstanceOf(UploadOverrunError);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(5);
        expect(state.status === "invalidated").toBe(true);
        // The prefix on disk is byte-exact.
        expect(await readFile(uploadFile(uploadToken, "data"), "utf8")).toBe("abcde");
    });

    test("a body exactly at the bound is accepted whole and stays valid", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const result = await store.appendChunk(uploadToken, 0, enc.encode("abcd"), {
            maxBytes: 4,
            maxBytesFatal: true,
            now: 1,
        });
        expect(result.bytesWritten).toBe(4);
        const state = await store.getUploadState(uploadToken);
        expect(state.status === "invalidated").toBe(false);
        const done = await completeDurable(store, uploadToken, { now: 2 });
        expect(done.digest).toBe(sha256b64("abcd"));
    });

    test("crossing the bound cancels the producer stream", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(enc.encode("0123456789"));
            },
            cancel() {
                cancelled = true;
            },
        });
        await expect(
            store.appendChunk(uploadToken, 0, body, { maxBytes: 4, maxBytesFatal: true, now: 1 }),
        ).rejects.toBeInstanceOf(UploadOverrunError);
        // The producer is told to stop; without the cancel it would sit on
        // an abandoned locked reader forever.
        expect(cancelled).toBe(true);
    });
});

describe("fsUploadStore: digest verification at completion", () => {
    test("a matching asserted digest completes; the digest feeds the read side", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("payload"), { now: 1 });
        const done = await completeDurable(store, uploadToken, {
            expectedDigests: { "sha-256": sha256b64("payload") },
            now: 2,
        });
        expect(done.digest).toBe(sha256b64("payload"));
    });

    test("a mismatch throws, publishes nothing, and leaves the resource for the abort", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("payload"), { now: 1 });

        expect(await completeWithWrongDigest(store, uploadToken, "payload")).toBeInstanceOf(UploadDigestMismatchError);

        // Atomic completion: nothing became visible at the final key.
        await expect(fsStore({ root }).headObject("k.bin")).rejects.toBeInstanceOf(ObjectNotFoundError);

        // The resource is intact for the orchestrator's abort.
        const state = await store.getUploadState(uploadToken);
        expect(state.status === "complete").toBe(false);
        expect(state.offset).toBe(7);
        await store.abortUpload(uploadToken);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

describe("fsUploadStore: hostile keys and tokens", () => {
    test("traversal keys are rejected at creation", async () => {
        const store = fsUploadStore({ root });
        // Backslash is a path separator only on Windows; on POSIX it is a
        // legal filename byte and "..\\x" stays inside the root (the same
        // platform semantics the read-side store documents).
        const hostile =
            process.platform === "win32"
                ? ["../escape.txt", "..\\escape.txt", "/abs.txt"]
                : ["../escape.txt", "/abs.txt"];
        for (const key of hostile) {
            await expect(store.createUpload({ key, now: 0 })).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
    });

    test("keys addressing the uploads workspace are rejected", async () => {
        const store = fsUploadStore({ root });
        await expect(store.createUpload({ key: ".uploads/victim", now: 0 })).rejects.toBeInstanceOf(
            ObjectNotFoundError,
        );
        await expect(store.createUpload({ key: ".uploads", now: 0 })).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("other spellings of the workspace are rejected on every platform", async () => {
        // Case and normal form are properties of the volume, not the runtime: a
        // case-insensitive volume answers `.Uploads` with the workspace anywhere.
        const store = fsUploadStore({ root });
        const spellings = [".Uploads/victim", ".UPLOADS/victim", "./.uploads/victim", "a/../.uploads/victim"];
        // An 8.3 alias opens the same directory on a Windows volume with short names.
        if (process.platform === "win32") spellings.push("UPLOAD~1/victim", ".uploads\\victim");
        for (const key of spellings) {
            await expect(store.createUpload({ key, now: 0 })).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
    });

    test("a recorded key tampered into a traversal cannot publish outside the root", async () => {
        // The store root is a SUBDIRECTORY of the per-test temp dir, so the
        // traversal target lands inside this test's own sandbox (asserting
        // on the shared OS tmpdir would be poisoned by unrelated leftovers).
        const storeRoot = join(root, "store");
        await mkdir(storeRoot, { recursive: true });
        const store = fsUploadStore({ root: storeRoot });
        const { uploadToken } = await store.createUpload({ key: "safe.txt", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("x"), { now: 1 });

        const infoPath = join(storeRoot, ".uploads", uploadToken, "info.json");
        const info = JSON.parse(await readFile(infoPath, "utf8"));
        info.key = "../evil.txt";
        await writeFile(infoPath, JSON.stringify(info));

        await expect(completeDurable(store, uploadToken, { now: 2 })).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(stat(join(root, "evil.txt"))).rejects.toThrow();
    });

    test("hostile tokens answer UploadNotFoundError, never a path lookup", async () => {
        const store = fsUploadStore({ root });
        for (const token of ["../../etc/passwd", "..", "a/b", "x\\y", "UPPER", "..json"]) {
            await expect(store.getUploadState(token)).rejects.toBeInstanceOf(UploadNotFoundError);
            await expect(store.appendChunk(token, 0, enc.encode("x"), { now: 0 })).rejects.toBeInstanceOf(
                UploadNotFoundError,
            );
            await expect(completeDurable(store, token, { now: 0 })).rejects.toBeInstanceOf(UploadNotFoundError);
        }
        // Abort is idempotent even for tokens this store could never issue.
        await store.abortUpload("../../etc/passwd");
    });

    test("traversal-shaped tokens cannot reach files outside the workspace", async () => {
        // Plant a valid-looking sidecar and data file OUTSIDE .uploads: if a
        // hostile token ever reached the path layer, this is what it would
        // read (and answer state from) instead of rejecting.
        await writeFile(
            join(root, "escape.json"),
            JSON.stringify({ key: "escape", createdAt: 0, isComplete: false, isInvalidated: false }),
        );
        await writeFile(join(root, "escape"), "planted bytes");
        const store = fsUploadStore({ root });
        for (const token of ["../escape", "aaaa/../../escape"]) {
            await expect(store.getUploadState(token)).rejects.toBeInstanceOf(UploadNotFoundError);
        }
    });

    test("unknown-but-well-formed tokens answer UploadNotFoundError", async () => {
        const store = fsUploadStore({ root });
        await expect(store.getUploadState("deadbeef-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
    });

    test("accepts empty options objects (no signal) on every read-only call", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        expect((await store.getUploadState(uploadToken, {})).offset).toBe(0);
        expect((await store.sweepExpired!({ idleSinceMs: 0 }, {})).removed).toBe(0);
        await store.abortUpload(uploadToken, {});
    });
});

describe("fsUploadStore: damaged workspaces", () => {
    test("a lost data file under live records reports terminal invalidation", async () => {
        const { store, uploadToken } = await abcUpload();
        await unlink(uploadFile(uploadToken, "data"));

        const state = await store.getUploadState(uploadToken);
        expect(state.status === "invalidated").toBe(true);
        expect(state.status === "complete").toBe(false);
        expect(state.offset).toBe(0);
        await expect(store.appendChunk(uploadToken, 0, enc.encode("x"), { now: 2 })).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
        await expect(completeDurable(store, uploadToken, { now: 3 })).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a torn info record answers UploadNotFoundError instead of crashing", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await writeFile(uploadFile(uploadToken, "info.json"), "{ not json");
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    // A record that parses but holds a shape this store never writes is damage
    // too, and each one must answer the same not-found: a wrong-typed field
    // flowing on would reach offset math, the seal's plan, or the sweep's clock
    // comparison. Each case rewrites one record file from the creation record.
    const identity = { dev: "1", ino: "2", size: "0", mtimeNs: "3" };
    const malformed: Array<[string, string, (info: Record<string, unknown>) => unknown]> = [
        ["torn text", "info.json", () => undefined],
        ["not an object", "info.json", () => [1, 2]],
        ["a null record", "info.json", () => null],
        ["an empty record", "info.json", () => ({})],
        ["a string createdAt", "info.json", (s) => ({ ...s, createdAt: "soon" })],
        ["a null createdAt", "info.json", (s) => ({ ...s, createdAt: null })],
        ["an object createdAt", "info.json", (s) => ({ ...s, createdAt: {} })],
        ["a negative length", "info.json", (s) => ({ ...s, length: -1 })],
        ["a non-string metadata value", "info.json", (s) => ({ ...s, metadata: { a: 1 } })],
        ["a string lastAppendAt", "progress.json", () => ({ lastAppendAt: "later" })],
        ["a fractional declared length", "length.json", () => ({ length: 1.5 })],
        ["a seal without a destination", "seal.json", () => ({ length: 3 })],
        ["a seal with a numeric identity", "seal.json", () => ({ length: 3, destination: { ...identity, ino: 2 } })],
        ["a publication with a numeric digest", "publication.json", () => ({ ...identity, digest: 42 })],
        ["a fractional completedSize", "complete.json", () => ({ completedSize: 1.5, etag: '"e"', digest: "d" })],
    ];
    for (const [label, file, mutate] of malformed) {
        test(`a record with ${label} is damaged storage: not-found to the client, corrupt to the operator`, async () => {
            const store = fsUploadStore({ root });
            const key = "users/alice/tax-return.pdf";
            const { uploadToken } = await store.createUpload({ key, now: 0 });
            const info = await readRecord(uploadToken, "info.json");
            const next = mutate(info);
            await writeFile(
                uploadFile(uploadToken, file),
                next === undefined ? `{"key":"${key}",` : JSON.stringify(next),
            );

            const err = await store.getUploadState(uploadToken).then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(UploadNotFoundError);
            expect(isCorruptUploadState(err)).toBe(true);
            // The cause names the damage and nothing read from the record, which
            // holds the key; a parse error's text would quote it.
            const cause = (err as Error).cause as Error;
            expect(cause.name).toBe("UploadStateCorruptError");
            expect(cause.message).not.toContain("tax-return");
            expect(JSON.stringify({ ...(err as object), message: (err as Error).message })).not.toContain("tax-return");
        });
    }

    test("an info record that is simply absent is a plain not-found, not damage", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await unlink(uploadFile(uploadToken, "info.json"));
        const err = await store.getUploadState(uploadToken).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(UploadNotFoundError);
        expect(isCorruptUploadState(err)).toBe(false);
    });

    test("a completion record without its size is corrupt, never an offset of zero", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "sized.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
        await completeDurable(store, uploadToken, { now: 2 });
        const completion = await readRecord(uploadToken, "complete.json");
        expect(completion.completedSize).toBe(3);
        delete completion.completedSize;
        await writeFile(uploadFile(uploadToken, "complete.json"), JSON.stringify(completion));

        // Each call starts only once the previous one settled, so no rejection
        // is left unhandled while another is awaited.
        for (const call of [
            () => store.getUploadState(uploadToken),
            () => store.appendChunk(uploadToken, 0, enc.encode("x"), { now: 3 }),
            () => store.completeUpload(uploadToken, { expectedLength: 0, now: 3 }),
        ]) {
            const err = await (call() as Promise<unknown>).then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(isCorruptUploadState(err)).toBe(true);
        }
    });
});

describe("fsUploadStore: sweepExpired", () => {
    test("removes only resources idle since strictly before the cutoff", async () => {
        const store = fsUploadStore({ root });
        const stale = await store.createUpload({ key: "stale.bin", now: 1_000 });
        const active = await store.createUpload({ key: "active.bin", now: 1_000 });
        await store.appendChunk(active.uploadToken, 0, enc.encode("x"), { now: 9_000 });

        const swept = await store.sweepExpired!({ idleSinceMs: 5_000 });
        expect(swept.removed).toBe(1);
        await expect(store.getUploadState(stale.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect((await store.getUploadState(active.uploadToken)).offset).toBe(1);
        // Both files of the swept resource are gone, not just the sidecar.
        await expectOnlyResource(active.uploadToken);

        // Boundary: idle exactly AT the cutoff is kept (idle since BEFORE it).
        expect((await store.sweepExpired!({ idleSinceMs: 9_000 })).removed).toBe(0);
        expect((await store.sweepExpired!({ idleSinceMs: 9_001 })).removed).toBe(1);
    });

    test("a swept-away resource cannot be resumed but a published object survives", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "done.bin", now: 1_000 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1_500 });
        await completeDurable(store, uploadToken, { now: 2_000 });

        const swept = await store.sweepExpired!({ idleSinceMs: Date.now() });
        expect(swept.removed).toBe(1);
        // Completed-and-reaped answers not-found on the resource...
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        // ...while the published object keeps serving.
        expect(await drain((await fsStore({ root }).getObject("done.bin")).body)).toBe("abc");
    });

    test("reaps orphaned data files and torn sidecars by mtime, once idle", async () => {
        const store = fsUploadStore({ root });
        await mkdir(join(root, ".uploads"), { recursive: true });
        await writeFile(join(root, ".uploads", "deadbeef"), "orphan bytes");
        await writeFile(join(root, ".uploads", "cafe.json"), "{ torn");

        // A future cutoff means both artifacts are already idle.
        const swept = await store.sweepExpired!({ idleSinceMs: Date.now() + 3_600_000 });
        expect(swept.removed).toBe(2);
        expect(await readdir(join(root, ".uploads"))).toEqual([]);
    });

    test("fresh artifacts survive the mtime fallback (mid-write is not raced)", async () => {
        const store = fsUploadStore({ root });
        await mkdir(join(root, ".uploads"), { recursive: true });
        await writeFile(join(root, ".uploads", "deadbeef"), "just created");
        // A cutoff in the past: nothing recent may be touched.
        const swept = await store.sweepExpired!({ idleSinceMs: Date.now() - 3_600_000 });
        expect(swept.removed).toBe(0);
        expect(await readdir(join(root, ".uploads"))).toEqual(["deadbeef"]);
    });

    // A non-numeric clock compares false against every cutoff (null even
    // coerces to 0, the oldest instant), so read as a record it would either
    // never be reaped or be reaped at once; it is damage and ages like a torn one.
    for (const [label, createdAt] of [
        ["a string", "soon"],
        ["a null", null],
        ["an object", {}],
    ] as const) {
        test(`a sidecar with ${label} createdAt is aged by mtime, not by the values it holds`, async () => {
            const store = fsUploadStore({ root });
            await mkdir(join(root, ".uploads"), { recursive: true });
            await writeFile(join(root, ".uploads", "cafe.json"), JSON.stringify({ key: "k.bin", createdAt }));
            expect((await store.sweepExpired!({ idleSinceMs: Date.now() - 3_600_000 })).removed).toBe(0);
            expect((await store.sweepExpired!({ idleSinceMs: Date.now() + 3_600_000 })).removed).toBe(1);
            expect(await readdir(join(root, ".uploads"))).toEqual([]);
        });
    }

    test("a freshly written torn sidecar survives a past-cutoff sweep", async () => {
        const store = fsUploadStore({ root });
        await mkdir(join(root, ".uploads"), { recursive: true });
        await writeFile(join(root, ".uploads", "cafe.json"), "{ torn");
        // A cutoff in the past: the mtime fallback must anchor the artifact
        // as fresh, never treat unparseable as already-expired.
        const swept = await store.sweepExpired!({ idleSinceMs: Date.now() - 3_600_000 });
        expect(swept.removed).toBe(0);
        expect(await readdir(join(root, ".uploads"))).toEqual(["cafe.json"]);
    });

    test("sweep never mistakes upload CONTENT for a sidecar", async () => {
        const store = fsUploadStore({ root });
        const now = Date.now();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now });
        // The uploaded BYTES are attacker-controlled and here they look like
        // an ancient sidecar; only the real sidecar may drive the sweep.
        const decoy = JSON.stringify({ key: "k.bin", createdAt: 0, isComplete: false, isInvalidated: false });
        await store.appendChunk(uploadToken, 0, enc.encode(decoy), { now });

        const swept = await store.sweepExpired!({ idleSinceMs: now - 3_600_000 });
        expect(swept.removed).toBe(0);
        expect((await store.getUploadState(uploadToken)).offset).toBe(decoy.length);
    });

    test("an old upload directory with live records is never orphan-reaped", async () => {
        const store = fsUploadStore({ root });
        const now = Date.now();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now });
        // Age every file and the directory far past any cutoff; the recorded
        // facts (createdAt = now) still anchor the resource, so none is an orphan.
        for (const name of await readdir(join(root, ".uploads", uploadToken))) {
            await utimes(uploadFile(uploadToken, name), 1, 1);
        }
        await utimes(join(root, ".uploads", uploadToken), 1, 1);

        const swept = await store.sweepExpired!({ idleSinceMs: now - 3_600_000 });
        expect(swept.removed).toBe(0);
        expect((await store.getUploadState(uploadToken)).offset).toBe(3);
    });

    test("an entry that vanishes between the listing and its read is neither removed nor failed", async () => {
        // A link to nowhere lists like an entry and then neither reads nor
        // stats, which is what an entry another sweeper removed looks like.
        // A junction, so the link needs no symlink privilege on Windows; other
        // platforms ignore the type.
        const uploadsDir = join(root, ".uploads");
        await mkdir(uploadsDir, { recursive: true });
        const nowhere = join(root, "nowhere");
        await symlink(nowhere, join(uploadsDir, "gone.json"), "junction");
        await symlink(nowhere, join(uploadsDir, "gone"), "junction");
        const store = fsUploadStore({ root });
        expect(await store.sweepExpired({ idleSinceMs: Date.now() + 3_600_000 })).toEqual({ removed: 0, failed: 0 });
    });

    test("a root with no uploads workspace sweeps zero", async () => {
        const store = fsUploadStore({ root });
        expect(await store.sweepExpired({ idleSinceMs: Date.now() })).toEqual({ removed: 0, failed: 0 });
    });

    test("an abort raised after the scan starts stops it partway", async () => {
        // A sweep runs over a workspace of unbounded size, so a caller that
        // revokes it must not be made to wait out the rest of the scan.
        const store = fsUploadStore({ root });
        const uploadsDir = join(root, ".uploads");
        // Created through the store itself, so the entries are the format the
        // sweep reads in production, and tracked so teardown waits for them.
        await tracked(
            (async () => {
                for (let i = 0; i < 20; i++) {
                    await store.createUpload({ key: `k${i}.bin`, now: 1_000, signal: teardown.signal });
                }
            })(),
        );
        const total = (await readdir(uploadsDir)).length;
        expect(total).toBe(20);

        const controller = new AbortController();
        const reason = new Error("partial-content-test: shutting down");
        // The revocation lands at the sweep's own per-entry check, halfway
        // through the listing, so it is inside the loop by construction. A
        // test that instead polls the directory for a first reap can spin
        // without ever yielding the sweep its turn, and never aborts at all.
        const { signal } = controller;
        const check = signal.throwIfAborted.bind(signal);
        let checks = 0;
        signal.throwIfAborted = () => {
            if (++checks === total / 2) controller.abort(reason);
            check();
        };
        await expect(store.sweepExpired({ idleSinceMs: Date.now() + 3_600_000 }, { signal })).rejects.toBe(reason);
        const remaining = (await readdir(uploadsDir)).length;
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThan(total);
    });
});

describe("fsUploadStore: a sweep that reaps mid-append", () => {
    test("the in-flight append answers not-found instead of resurrecting the sidecar", async () => {
        // The lifetime cutoff condemns an upload that is being written to, so
        // the append finds its files unlinked underneath it. Writing the
        // sidecar back there recreates the resource around bytes no reader can
        // reach: the caller is acked an offset that is not durable, the next
        // probe answers invalidated, and completion fails. The gone resource is
        // the truthful answer.
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 1_000 });

        let release!: () => void;
        const reaped = new Promise<void>((resolve) => {
            release = resolve;
        });
        // The sweep must land MID-append: after the append opened the data file
        // and wrote the first chunk. The second pull is the first point that is
        // guaranteed, because the append reads the sidecar and opens the file
        // before it reads the body. Sweeping any earlier lets the append reject
        // before the assertion below is attached, which is a different case
        // (nothing opened, nothing to resurrect) reported as an unhandled
        // rejection.
        let midAppend!: () => void;
        const writing = new Promise<void>((resolve) => {
            midAppend = resolve;
        });
        let delivered = false;
        const stalled = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (!delivered) {
                    delivered = true;
                    controller.enqueue(enc.encode("abcdefgh"));
                    return;
                }
                midAppend();
                await reaped;
                controller.close();
            },
        });

        const appending = store.appendChunk(uploadToken, 0, stalled, { now: 2_000 });
        await writing;
        const swept = await store.sweepExpired!({ createdBeforeMs: 2_000 });
        expect(swept.removed).toBe(1);
        expect(await readdir(join(root, ".uploads"))).toEqual([]);
        release();

        await expect(appending).rejects.toBeInstanceOf(UploadNotFoundError);
        // Nothing was written back: the workspace stays as the sweep left it.
        expect(await readdir(join(root, ".uploads"))).toEqual([]);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

describe("fsUploadStore: abort", () => {
    test("abort is idempotent and removes both workspace files", async () => {
        const { store, uploadToken } = await abcUpload();

        await store.abortUpload(uploadToken);
        await store.abortUpload(uploadToken); // second discard: no-op
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(await readdir(join(root, ".uploads"))).toEqual([]);
    });

    test("aborting a completed upload discards the resource but never the published object", async () => {
        // Store contract: once completeUpload returns, the object at the key is
        // live data readers can already be serving, and abort is idempotent, so
        // an abort that deleted it would destroy production data on a DELETE
        // that arrived late, was retried, or was replayed.
        const { store, uploadToken } = await abcUpload();
        await completeDurable(store, uploadToken, { now: 2 });

        await store.abortUpload(uploadToken);
        await store.abortUpload(uploadToken); // and again: still not destructive
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect((await fsStore({ root }).headObject("k.bin")).contentLength).toBe(3);
    });
});

// ─── A read store never serves an upload store's bookkeeping ────────────────

describe("fsStore: reserved upload prefix", () => {
    test("in-flight upload bytes and their sidecar are not readable", async () => {
        const up = fsUploadStore({ root });
        const read = fsStore({ root });
        const { uploadToken } = await up.createUpload({ key: "private/secret.txt", now: 0 });
        await up.appendChunk(uploadToken, 0, enc.encode("TOPSECRET"), { now: 1 });

        // The bytes of an upload nobody published, and the sidecar naming the
        // key it is destined for, which commonly embeds a filename. Upload
        // tokens are the only handles into that namespace and a read handler
        // holds none.
        await expect(read.headObject(`.uploads/${uploadToken}`)).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(read.getObject(`.uploads/${uploadToken}`)).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(read.getObject(`.uploads/${uploadToken}.json`)).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(read.getObject(".uploads")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("the reservation holds on the resolved path, whatever the key's spelling", async () => {
        const up = fsUploadStore({ root });
        const read = fsStore({ root });
        const { uploadToken } = await up.createUpload({ key: "private/secret.txt", now: 0 });
        await up.appendChunk(uploadToken, 0, enc.encode("TOPSECRET"), { now: 1 });

        // Dot segments resolve lexically to the workspace while starting with
        // something other than the prefix; a Windows separator does the same.
        const spellings = [
            `./.uploads/${uploadToken}`,
            `x/../.uploads/${uploadToken}.json`,
            `public/../.uploads/${uploadToken}`,
            ...(process.platform === "win32" ? [`.uploads\\${uploadToken}`] : []),
        ];
        for (const key of spellings) {
            await expect(read.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(read.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
    });

    test("a case or normal-form variant of the prefix is refused on every platform", async () => {
        // Case sensitivity and normalization belong to the VOLUME, not to the
        // runtime: a case-insensitive volume mounted under a POSIX runtime opens
        // the workspace as `.Uploads/`, and a normalizing one opens it under a
        // decomposed spelling. These are real published files here, so what
        // refuses them is the guard rather than the path not existing.
        await mkdir(join(root, ".Uploads"), { recursive: true });
        await writeFile(join(root, ".Uploads", "visible.txt"), "SERVED");
        await mkdir(join(root, "café"), { recursive: true });
        await writeFile(join(root, "café", "visible.txt"), "SERVED");

        const read = fsStore({ root });
        await expect(read.headObject(".Uploads/visible.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(read.getObject(".UPLOADS/visible.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);

        // The reserved prefix composed, the directory on disk decomposed.
        const normalizing = fsStore({ root, reservedPrefix: "café/" });
        await expect(normalizing.headObject("café/visible.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("a short-name alias of the prefix is refused within the prefix's own depth", async () => {
        // A name that does not fit 8.3 also answers to a generated short name on
        // a Windows volume with them enabled, opening the same directory under a
        // spelling no folding relates to the prefix. The alias is not derivable,
        // so the shape is what is refused, and only as deep as the prefix runs.
        if (process.platform !== "win32") return;
        await mkdir(join(root, "UPLOAD~1"), { recursive: true });
        await writeFile(join(root, "UPLOAD~1", "visible.txt"), "SERVED");
        await mkdir(join(root, "public"), { recursive: true });
        await writeFile(join(root, "public", "report~1.pdf"), "PUBLISHED");

        const read = fsStore({ root });
        await expect(read.headObject("UPLOAD~1/visible.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        // Past the prefix's depth the shape means nothing, so an ordinary key
        // carrying a tilde is still served.
        expect((await read.headObject("public/report~1.pdf")).contentLength).toBe(9);
    });

    test("a published object sharing the root is unaffected", async () => {
        await mkdir(join(root, "public"), { recursive: true });
        await writeFile(join(root, "public", "ok.txt"), "PUBLISHED");
        const read = fsStore({ root });
        expect((await read.headObject("public/ok.txt")).contentLength).toBe(9);
    });

    test("a key that merely starts with the same letters is not reserved", async () => {
        await writeFile(join(root, ".uploadsomething"), "FINE");
        const read = fsStore({ root });
        expect((await read.headObject(".uploadsomething")).contentLength).toBe(4);
    });

    test("an empty reservedPrefix serves the whole namespace", async () => {
        const up = fsUploadStore({ root });
        const read = fsStore({ root, reservedPrefix: "" });
        const { uploadToken } = await up.createUpload({ key: "k.bin", now: 0 });
        await up.appendChunk(uploadToken, 0, enc.encode("bytes"), { now: 1 });
        // The escape hatch for a root no upload store shares.
        expect((await read.headObject(`.uploads/${uploadToken}/data`)).contentLength).toBe(5);
    });
});

// ─── A relative root points somewhere else in production ────────────────────

describe("fsStore / fsUploadStore: root validation", () => {
    test("a relative root is refused, naming why it is not merely inconvenient", () => {
        // It resolves against process.cwd(), which is the shell's directory in
        // development and the service manager's in production, so the same
        // configuration addresses two different places.
        expect(() => fsStore({ root: "./data" })).toThrow(/absolute path/);
        expect(() => fsUploadStore({ root: "data/uploads" })).toThrow(/process\.cwd\(\)/);
    });

    test("a missing root is refused", () => {
        expect(() => fsStore({} as never)).toThrow(/options\.root must be an absolute path/);
        expect(() => fsUploadStore({ root: "" })).toThrow(TypeError);
    });

    test("an absolute root is accepted", () => {
        expect(() => fsUploadStore({ root })).not.toThrow();
    });
});

// ─── A refusal still owes the request body a release ────────────────────────

describe("fsUploadStore: appendChunk releases a body it never reads", () => {
    test("the routine resume conflict (a stale saved offset) releases it", async () => {
        const { store, uploadToken } = await abcUpload();

        const held = heldBody();
        await expect(store.appendChunk(uploadToken, 0, held.body, { now: 2 })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );
        expect(held.wasReleased()).toBe(true);
    });

    test("a published resource releases it", async () => {
        const { store, uploadToken } = await abcUpload();
        await completeDurable(store, uploadToken, { now: 2 });

        const held = heldBody();
        await expect(store.appendChunk(uploadToken, 3, held.body, { now: 3 })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );
        expect(held.wasReleased()).toBe(true);
    });

    test("an invalidated resource releases it", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await expect(
            store.appendChunk(uploadToken, 0, enc.encode("ab"), {
                now: 1,
                maxBytes: 1,
                maxBytesFatal: true,
            }),
        ).rejects.toBeInstanceOf(UploadOverrunError);

        const held = heldBody();
        await expect(store.appendChunk(uploadToken, 1, held.body, { now: 2 })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );
        expect(held.wasReleased()).toBe(true);
    });

    test("a resource whose data file is gone releases it", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await unlink(uploadFile(uploadToken, "data"));

        const held = heldBody();
        await expect(store.appendChunk(uploadToken, 0, held.body, { now: 1 })).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
        expect(held.wasReleased()).toBe(true);
    });

    test("a token this store never issued releases it", async () => {
        const store = fsUploadStore({ root });
        const held = heldBody();
        await expect(
            store.appendChunk("deadbeef-0000-4000-8000-000000000000", 0, held.body, { now: 1 }),
        ).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(held.wasReleased()).toBe(true);
    });

    test("an abort latched before the call arrived releases it", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const ac = new AbortController();
        ac.abort();

        const held = heldBody();
        const result = await store.appendChunk(uploadToken, 0, held.body, { now: 1, signal: ac.signal });
        expect(result).toEqual({ bytesWritten: 0, interrupted: true });
        expect(held.wasReleased()).toBe(true);
    });

    test("a body the append DID read is left to the read's own teardown", async () => {
        // The release the entry owes is for an untouched body only: a body the
        // store consumed is torn down by the read that consumed it, and
        // cancelling it twice would report a second, invented stop.
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        let cancels = 0;
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent) {
                    controller.close();
                    return;
                }
                sent = true;
                controller.enqueue(enc.encode("abc"));
            },
            cancel() {
                cancels++;
            },
        });

        expect(await store.appendChunk(uploadToken, 0, body, { now: 1 })).toEqual({
            bytesWritten: 3,
            interrupted: false,
        });
        // Read to its end: cancel() is never reached on an exhausted stream.
        expect(cancels).toBe(0);
        expect((await store.getUploadState(uploadToken)).offset).toBe(3);
    });
});

// ─── One unreapable entry must not end the scan ─────────────────────────────

describe("fsUploadStore: a sweep that cannot remove an entry", () => {
    /**
     * Whether this platform can pin an entry against removal in a test.
     *
     * POSIX: a subdirectory without write permission keeps its file, so a
     * recursive removal fails past the "does not exist" that `force`
     * suppresses, as a read-only remount or a sticky-bit directory would.
     * Root ignores the mode bits, so it cannot pin. Windows has no portable
     * stand-in: its ACLs do not follow the mode bits, and the volume deletes
     * even a file another handle holds open (with POSIX semantics), which is
     * why the store removes such a directory in place there.
     */
    const canPin = process.platform !== "win32" && process.getuid?.() !== 0;

    async function unremovable(path: string): Promise<void> {
        await mkdir(join(path, "pinned"), { recursive: true });
        await writeFile(join(path, "pinned", "occupied"), "held");
        await chmod(join(path, "pinned"), 0o500);
    }

    afterEach(async () => {
        // The pinned entry may have been renamed for reaping; unpin whatever
        // holds one so the root can be removed.
        const uploads = join(root, ".uploads");
        for (const name of await readdir(uploads).catch(() => [] as string[])) {
            await chmod(join(uploads, name, "pinned"), 0o700).catch(() => undefined);
        }
    });

    test.skipIf(!canPin)("the entries behind it are still reclaimed, and the failure is counted", async () => {
        const store = fsUploadStore({ root });
        // Created at epoch, so their age is decided by createdAt and never by
        // an mtime written in the cutoff's millisecond.
        const stuck = await store.createUpload({ key: "a.bin", now: 0 });
        const free = await store.createUpload({ key: "b.bin", now: 0 });
        await unremovable(join(root, ".uploads", stuck.uploadToken));

        const swept = await store.sweepExpired({ idleSinceMs: Date.now() });

        expect(swept).toEqual({ removed: 1, failed: 1 });
        // The stuck entry is left for the next sweep; the other is gone.
        const left = await readdir(join(root, ".uploads"));
        expect(left).toHaveLength(1);
        expect(left).not.toContain(free.uploadToken);
    });

    test.skipIf(!canPin)("an unreapable orphan does not cost the orphans behind it", async () => {
        const store = fsUploadStore({ root });
        const uploads = join(root, ".uploads");
        await mkdir(uploads, { recursive: true });
        await unremovable(join(uploads, "aaa-orphan"));
        await writeFile(join(uploads, "bbb-orphan"), "orphan bytes");

        // A future cutoff: both artifacts are already idle.
        const swept = await store.sweepExpired({ idleSinceMs: Date.now() + 3_600_000 });

        expect(swept).toEqual({ removed: 1, failed: 1 });
        const left = await readdir(uploads);
        expect(left).toHaveLength(1);
        expect(left).not.toContain("bbb-orphan");
    });
});

// ─── Records are replaced whole, never truncated in place ───────────────────

describe("fsUploadStore: record writes are all-or-nothing", () => {
    test("a failed write leaves the previous record and every durable byte", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 1_000 });
        await store.appendChunk(uploadToken, 0, enc.encode("abcdef"), { now: 2_000 });

        // A value JSON cannot serialize fails the progress write. Written in
        // place, an open for writing empties the file first, and a record that
        // no longer parses is damage: the six durable bytes below would be
        // unreachable and unresumable.
        await expect(
            store.appendChunk(uploadToken, 6, enc.encode("gh"), {
                now: 3_000n as unknown as number,
            }),
        ).rejects.toBeInstanceOf(TypeError);

        const state = await store.getUploadState(uploadToken);
        expect(state.key).toBe("k.bin");
        expect(state.createdAt).toBe(1_000);
        // The bytes reached the data file before the progress write was tried.
        expect(state.offset).toBe(8);
        // And the failed write left no temp behind.
        await expectOnlyResource(uploadToken);
    });

    test("a temp stranded by a crash is invisible to reads and goes with its upload", async () => {
        const store = fsUploadStore({ root });
        const now = Date.now();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now });
        // What a crash mid-write leaves inside a live upload.
        const stranded = uploadFile(uploadToken, "progress.json.0f0f0f0f.tmp");
        await writeFile(stranded, "{ half-writ");
        await utimes(stranded, 1, 1); // long past any cutoff

        // The upload's records anchor it, not the temp's age.
        expect(await store.sweepExpired({ idleSinceMs: now - 3_600_000 })).toEqual({ removed: 0, failed: 0 });
        expect((await store.getUploadState(uploadToken)).offset).toBe(3);
        await store.appendChunk(uploadToken, 3, enc.encode("d"), { now: now + 1 });

        // Reaping the upload takes the temp with it.
        expect(await store.sweepExpired({ idleSinceMs: now + 3_600_000 })).toEqual({ removed: 1, failed: 0 });
        expect(await readdir(join(root, ".uploads"))).toEqual([]);
    });
});

// ─── Links that leave the root ──────────────────────────────────────────────

describe("fsUploadStore: directory links out of the root", () => {
    let outside: string;

    beforeEach(async () => {
        outside = await mkdtemp(join(tmpdir(), "pc-upload-fs-outside-"));
        await writeFile(join(outside, "passwd"), "the original");
    });

    afterEach(async () => {
        await rm(outside, { recursive: true, force: true });
    });

    /** A junction on Windows (no privilege needed), a symlink on POSIX. */
    const linkDir = (target: string, path: string) => symlink(target, path, "junction");

    async function uploaded(store: ReturnType<typeof fsUploadStore>, key: string): Promise<string> {
        const { uploadToken } = await store.createUpload({ key, now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("attacker"), { now: 1 });
        return uploadToken;
    }

    test("completion refuses to publish through a link that leaves the root", async () => {
        const store = fsUploadStore({ root });
        const uploadToken = await uploaded(store, "escape/passwd");
        await linkDir(outside, join(root, "escape"));

        await expect(completeDurable(store, uploadToken, { now: 2 })).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(await readFile(join(outside, "passwd"), "utf8")).toBe("the original");
        expect((await store.getUploadState(uploadToken)).status).not.toBe("complete");
    });

    test("completion creates no directory outside the root on the way to a deeper key", async () => {
        const store = fsUploadStore({ root });
        const uploadToken = await uploaded(store, "escape/made/here/passwd");
        await linkDir(outside, join(root, "escape"));

        await expect(completeDurable(store, uploadToken, { now: 2 })).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect((await readdir(outside)).toSorted()).toEqual(["passwd"]);
    });

    test("a link that stays inside the root still publishes", async () => {
        await mkdir(join(root, "real"));
        await linkDir(join(root, "real"), join(root, "alias"));
        const store = fsUploadStore({ root });
        const uploadToken = await uploaded(store, "alias/sub/doc.bin");
        await completeDurable(store, uploadToken, { now: 2 });
        expect(await readFile(join(root, "real", "sub", "doc.bin"), "utf8")).toBe("attacker");
    });

    test("a link inside the root cannot publish into the upload workspace", async () => {
        const store = fsUploadStore({ root });
        const uploadToken = await uploaded(store, "ws/victim");
        await linkDir(join(root, ".uploads"), join(root, "ws"));
        await expect(completeDurable(store, uploadToken, { now: 2 })).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(await readdir(join(root, ".uploads"))).not.toContain("victim");
    });

    test("an interrupted publish is not recorded from its own object reached through such a link", async () => {
        // The published inode itself, moved out of the root and reached back
        // through a link: its identity matches the publication exactly, and
        // recording it would still report a completion outside the root.
        const store = fsUploadStore({ root });
        const uploadToken = await publishedWithoutRecord(store, "escape/doc.bin", "attacker");
        await rename(join(root, "escape", "doc.bin"), join(outside, "doc.bin"));
        await rm(join(root, "escape"), { recursive: true });
        await linkDir(outside, join(root, "escape"));

        expect(await store.getUploadState(uploadToken)).toMatchObject({ status: "incomplete" });
        await expect(completeDurable(store, uploadToken, { now: 3 })).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(await readdir(join(root, ".uploads", uploadToken))).not.toContain("complete.json");
    });

    test("an upload workspace that is itself a link out of the root is never written or swept", async () => {
        await linkDir(outside, join(root, ".uploads"));
        await writeFile(join(outside, "0000.json"), JSON.stringify({ createdAt: 0, isComplete: false }));
        const store = fsUploadStore({ root });

        // A misconfiguration or a planted link, answered loudly on every operation
        // rather than as a missing upload, so an operator sees it.
        const refused = /outside the root/;
        await expect(store.createUpload({ key: "k.bin", now: 0 })).rejects.toThrow(refused);
        await expect(store.sweepExpired({ createdBeforeMs: Number.MAX_SAFE_INTEGER })).rejects.toThrow(refused);
        await expect(store.getUploadState("0000")).rejects.toThrow(refused);
        await expect(store.appendChunk("0000", 0, enc.encode("x"), { now: 1 })).rejects.toThrow(refused);
        await expect(store.completeUpload("0000", { expectedLength: 0, now: 1 })).rejects.toThrow(refused);
        await expect(store.abortUpload("0000")).rejects.toThrow(refused);
        expect((await readdir(outside)).toSorted()).toEqual(["0000.json", "passwd"]);
    });
});

// ─── The sealed completion plan ─────────────────────────────────────────────

describe("fsUploadStore: sealed completion", () => {
    /**
     * A body that delivers `first`, then holds until released and delivers
     * `late`: an append still in flight when another party acts on the upload.
     */
    function gatedBody(first: string, late: string) {
        let reach!: () => void;
        let release!: () => void;
        const reached = new Promise<void>((resolve) => (reach = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                pulls += 1;
                if (pulls === 1) {
                    controller.enqueue(enc.encode(first));
                    return;
                }
                if (pulls === 2) {
                    reach();
                    await released;
                    controller.enqueue(enc.encode(late));
                    return;
                }
                controller.close();
            },
        });
        return { body, reached, release };
    }

    /** The append's outcome: undefined on success, else what it threw. */
    function settled(work: Promise<unknown>): Promise<unknown> {
        return tracked(
            work.then(
                () => undefined,
                (e: unknown) => e,
            ),
        );
    }

    test("an append that lands after the seal is refused and absent from the published object", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const gate = gatedBody("abc", "XYZ");
        const stale = settled(store.appendChunk(uploadToken, 0, gate.body, { now: 1 }));
        await gate.reached;
        // The completer seals the plan at the length it read while the
        // appender still holds the data file open.
        await sealAs(uploadToken, 3, null);
        gate.release();

        const err = await stale;
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(3);
        await store.completeUpload(uploadToken, { expectedLength: 3, now: 2 });
        expect(await drain((await fsStore({ root }).getObject("k.bin")).body)).toBe("abc");
    });

    test("an append through a handle opened before completion never reaches the published object", async () => {
        const { store, uploadToken } = await abcUpload();
        const stale = await open(uploadFile(uploadToken, "data"), "r+");
        try {
            await completeDurable(store, uploadToken, { now: 2 });
            await stale.write(enc.encode("ZZZ"), 0, 3, 0);
        } finally {
            await stale.close();
        }
        expect(await drain((await fsStore({ root }).getObject("k.bin")).body)).toBe("abc");
    });

    test("a sealed upload refuses appends with the sealed length and writes nothing", async () => {
        const { store, uploadToken } = await abcUpload();
        await sealAs(uploadToken, 3, null);

        const err = await settled(store.appendChunk(uploadToken, 3, enc.encode("d"), { now: 2 }));
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(3);
        expect(await readFile(uploadFile(uploadToken, "data"), "utf8")).toBe("abc");
    });

    test("an append in flight across an abort does not resurrect the upload", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const gate = gatedBody("abc", "def");
        const stale = settled(store.appendChunk(uploadToken, 0, gate.body, { now: 1 }));
        await gate.reached;
        await store.abortUpload(uploadToken);
        gate.release();

        expect(await stale).toBeInstanceOf(UploadNotFoundError);
        expect(await readdir(join(root, ".uploads"))).not.toContain(uploadToken);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("an object written at the key between the seal and the publish is never overwritten", async () => {
        const { store, uploadToken } = await abcUpload();
        // Sealed over an empty key; a third party then creates the object.
        await sealAs(uploadToken, 3, null);
        await writeFile(join(root, "k.bin"), "foreign");

        await expectDestinationConflict(store, uploadToken, 2);
        expect(await readFile(join(root, "k.bin"), "utf8")).toBe("foreign");
        expect((await store.getUploadState(uploadToken)).status).not.toBe("complete");
    });

    test("an object replaced at the key between the seal and the publish is never overwritten", async () => {
        await writeFile(join(root, "k.bin"), "old");
        const { store, uploadToken } = await abcUpload();
        // Sealed over the old object; a third party then replaces it.
        await sealAs(uploadToken, 3, await identityOf(join(root, "k.bin")));
        await replaceFile(join(root, "k.bin"), "new");

        await expectDestinationConflict(store, uploadToken, 2);
        expect(await readFile(join(root, "k.bin"), "utf8")).toBe("new");
        expect(await readdir(join(root, ".uploads", uploadToken))).not.toContain("displaced");
    });

    test("a foreign object of the same size at the key is not adopted as the publication", async () => {
        const store = fsUploadStore({ root });
        const uploadToken = await publishedWithoutRecord(store, "k.bin", "abc");
        // Same name, same size, different file.
        await replaceFile(join(root, "k.bin"), "xyz");

        expect((await store.getUploadState(uploadToken)).status).toBe("incomplete");
        await expectDestinationConflict(store, uploadToken, 3);
        expect(await readFile(join(root, "k.bin"), "utf8")).toBe("xyz");
        expect(await readdir(join(root, ".uploads", uploadToken))).not.toContain("complete.json");
    });

    test("a snapshot whose length differs from the plan lifts the seal and reports the durable length", async () => {
        const { store, uploadToken } = await abcUpload();

        const err = await settled(store.completeUpload(uploadToken, { expectedLength: 2, now: 2 }));
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(3);
        expect(await readdir(join(root, ".uploads", uploadToken))).not.toContain("seal.json");
        await expect(fsStore({ root }).headObject("k.bin")).rejects.toBeInstanceOf(ObjectNotFoundError);

        // The upload is live again: it resumes and completes at its real length.
        await store.appendChunk(uploadToken, 3, enc.encode("d"), { now: 3 });
        await store.completeUpload(uploadToken, { expectedLength: 4, now: 4 });
        expect(await drain((await fsStore({ root }).getObject("k.bin")).body)).toBe("abcd");
    });

    test("a lock-free read writes nothing where a repairing read records the completion", async () => {
        const store = fsUploadStore({ root });
        const uploadToken = await publishedWithoutRecord(store, "k.bin", "abc");
        const before = (await readdir(join(root, ".uploads", uploadToken))).toSorted();

        const derived = await store.getUploadState(uploadToken, { repair: false });
        expect(derived).toMatchObject({ status: "complete", offset: 3 });
        expect((await readdir(join(root, ".uploads", uploadToken))).toSorted()).toEqual(before);

        await store.getUploadState(uploadToken);
        expect(await readdir(join(root, ".uploads", uploadToken))).toContain("complete.json");
    });

    test("a sweep quarantines an upload caught mid-completion instead of deleting it", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 0 });
        await sealAs(uploadToken, 3, null);

        // Counted as failed: the operator's signal that a completion stopped.
        expect(await store.sweepExpired({ idleSinceMs: Date.now() })).toEqual({ removed: 0, failed: 1 });
        expect(await readdir(join(root, ".uploads"))).toEqual([".quarantine"]);
        const held = await readdir(join(root, ".uploads", ".quarantine", uploadToken));
        expect(held).toContain("seal.json");
        expect(held).not.toContain("data");
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);

        // Quarantine ages out on its own clock.
        expect(await store.sweepExpired({ idleSinceMs: Date.now() + 3_600_000 })).toEqual({ removed: 1, failed: 0 });
        expect(await readdir(join(root, ".uploads", ".quarantine"))).toEqual([]);
    });

    test("an abort puts back an object a stopped completion had moved aside", async () => {
        await writeFile(join(root, "k.bin"), "old");
        const { store, uploadToken } = await abcUpload();
        // What a completer leaves when it stops right after moving the sealed
        // destination aside to replace it.
        await sealAs(uploadToken, 3, await identityOf(join(root, "k.bin")));
        await rename(join(root, "k.bin"), uploadFile(uploadToken, "displaced"));

        await store.abortUpload(uploadToken);
        expect(await readFile(join(root, "k.bin"), "utf8")).toBe("old");
    });
});
