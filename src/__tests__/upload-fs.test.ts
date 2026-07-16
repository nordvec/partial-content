import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    fsStore,
    fsUploadStore,
    ObjectNotFoundError,
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadDigestMismatchError,
} from "../fs";
import { isUploadOffsetConflictError } from "../upload-store";

const enc = new TextEncoder();

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pc-upload-fs-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function sha256b64(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("base64");
}

async function drain(body: ReadableStream<Uint8Array> | Uint8Array): Promise<string> {
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

/** A well-behaved stream delivering the given chunks, then closing. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
            else controller.close();
        },
    });
}

/** Delivers the chunks, then errors: a client that vanished mid-request. */
function tornStream(...chunks: string[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
            else controller.error(new Error("connection reset"));
        },
    });
}

/** Delivers ONE chunk, then aborts the controller and never yields again. */
function abortingStream(ac: AbortController, first: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(enc.encode(first));
        },
        pull() {
            ac.abort();
            return new Promise<void>(() => {
                // never settles: the abort signal is the only exit
            });
        },
    });
}

/** The sidecar path for a token (test-side mirror of the layout). */
function sidecarPath(token: string): string {
    return join(root, ".uploads", `${token}.json`);
}

describe("fsUploadStore: capability flags", () => {
    test("advertises exact offsets, atomic completion, sha-256, byte-exact appends", () => {
        const store = fsUploadStore({ root });
        expect(store.exactOffsetRecovery).toBe(true);
        expect(store.atomicCompletion).toBe(true);
        expect(store.digestOnComplete).toBe("sha256");
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
        expect(fresh.isComplete).toBe(false);
        expect(fresh.isInvalidated).toBe(false);
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

        const done = await store.completeUpload(uploadToken, { now: 4_000 });
        expect(done.digest).toBe(sha256b64("hellowrld"));

        const after = await store.getUploadState(uploadToken);
        expect(after.isComplete).toBe(true);
        expect(after.isInvalidated).toBe(false);
        expect(after.offset).toBe(9);

        // The read side serves the published object with the SAME validator.
        const reads = fsStore({ root });
        const meta = await reads.headObject("docs/q4/report.txt");
        expect(meta.contentLength).toBe(9);
        expect(meta.etag).toBe(done.etag!);
        expect(await drain((await reads.getObject("docs/q4/report.txt")).body)).toBe("hellowrld");

        // The in-flight data file is gone from the workspace after publish.
        const workspace = await readdir(join(root, ".uploads"));
        expect(workspace).toEqual([`${uploadToken}.json`]);
    });

    test("a zero-byte upload completes and serves", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "empty.bin", length: 0, now: 10 });
        const done = await store.completeUpload(uploadToken, { now: 20 });
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
        await store.completeUpload(uploadToken, { now: 2 });
        expect(await drain((await fsStore({ root }).getObject("doc.txt")).body)).toBe("new!");
    });

    test("completion is idempotent: a retry answers the recorded facts", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
        const first = await store.completeUpload(uploadToken, { now: 2 });
        const retry = await store.completeUpload(uploadToken, { now: 3 });
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
        const done = await resumed.completeUpload(uploadToken, { now: 3 });
        expect(done.digest).toBe(sha256b64("abcdefghi"));
        expect(await drain((await fsStore({ root }).getObject("k.bin")).body)).toBe("abcdefghi");
    });

    test("maxBytes invalidation is durable: a fresh instance still refuses", async () => {
        const writer = fsUploadStore({ root });
        const { uploadToken } = await writer.createUpload({ key: "k.bin", now: 0 });
        const result = await writer.appendChunk(
            uploadToken, 0, enc.encode("0123456789"), { maxBytes: 4, now: 1 },
        );
        expect(result.bytesWritten).toBe(4);

        const restarted = fsUploadStore({ root });
        const state = await restarted.getUploadState(uploadToken);
        expect(state.offset).toBe(4);
        expect(state.isInvalidated).toBe(true);
        await expect(restarted.appendChunk(uploadToken, 4, enc.encode("x"), { now: 2 }))
            .rejects.toBeInstanceOf(UploadOffsetConflictError);
        await expect(restarted.completeUpload(uploadToken, { now: 3 })).rejects.toThrow(/invalidated/);
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
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
        await store.completeUpload(uploadToken, { now: 2 });

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
        expect(state.isInvalidated).toBe(false);

        await restarted.appendChunk(uploadToken, 6, enc.encode("ghi"), { now: 2 });
        const done = await restarted.completeUpload(uploadToken, {
            expectedDigest: sha256b64("abcdefghi"),
            now: 3,
        });
        expect(done.digest).toBe(sha256b64("abcdefghi"));
    });

    test("an aborted signal mid-body keeps the flushed prefix and stays resumable", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const ac = new AbortController();

        const partial = await store.appendChunk(
            uploadToken, 0, abortingStream(ac, "abc"), { now: 1, signal: ac.signal },
        );
        expect(partial.bytesWritten).toBe(3);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(3);
        expect(state.isInvalidated).toBe(false);
    });

    test("a signal aborted before the call rejects without touching the file", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const ac = new AbortController();
        ac.abort();
        await expect(
            store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1, signal: ac.signal }),
        ).rejects.toThrow();
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
        const result = await store.appendChunk(
            uploadToken, 0, streamOf("abc", "defg"), { maxBytes: 5, now: 1 },
        );
        expect(result.bytesWritten).toBe(5);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(5);
        expect(state.isInvalidated).toBe(true);
        // The prefix on disk is byte-exact.
        expect(await readFile(join(root, ".uploads", uploadToken), "utf8")).toBe("abcde");
    });

    test("a body exactly at the bound is accepted whole and stays valid", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        const result = await store.appendChunk(
            uploadToken, 0, enc.encode("abcd"), { maxBytes: 4, now: 1 },
        );
        expect(result.bytesWritten).toBe(4);
        const state = await store.getUploadState(uploadToken);
        expect(state.isInvalidated).toBe(false);
        const done = await store.completeUpload(uploadToken, { now: 2 });
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
        await store.appendChunk(uploadToken, 0, body, { maxBytes: 4, now: 1 });
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
        const done = await store.completeUpload(uploadToken, {
            expectedDigest: sha256b64("payload"),
            now: 2,
        });
        expect(done.digest).toBe(sha256b64("payload"));
    });

    test("a mismatch throws, publishes nothing, and leaves the resource for the abort", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("payload"), { now: 1 });

        const wrong = sha256b64("tampered");
        const err = await store.completeUpload(uploadToken, { expectedDigest: wrong, now: 2 }).catch((e) => e);
        expect(err).toBeInstanceOf(UploadDigestMismatchError);
        expect((err as UploadDigestMismatchError).actualDigest).toBe(sha256b64("payload"));

        // Atomic completion: nothing became visible at the final key.
        await expect(fsStore({ root }).headObject("k.bin")).rejects.toBeInstanceOf(ObjectNotFoundError);

        // The resource is intact for the orchestrator's abort.
        const state = await store.getUploadState(uploadToken);
        expect(state.isComplete).toBe(false);
        expect(state.offset).toBe(7);
        await store.abortUpload(uploadToken);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

describe("fsUploadStore: hostile keys and tokens", () => {
    test("traversal keys are rejected at creation", async () => {
        const store = fsUploadStore({ root });
        for (const key of ["../escape.txt", "..\\escape.txt", "/abs.txt"]) {
            await expect(store.createUpload({ key, now: 0 })).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
    });

    test("keys addressing the uploads workspace are rejected", async () => {
        const store = fsUploadStore({ root });
        await expect(store.createUpload({ key: ".uploads/victim", now: 0 }))
            .rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.createUpload({ key: ".uploads", now: 0 }))
            .rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("a sidecar key tampered into a traversal cannot publish outside the root", async () => {
        // The store root is a SUBDIRECTORY of the per-test temp dir, so the
        // traversal target lands inside this test's own sandbox (asserting
        // on the shared OS tmpdir would be poisoned by unrelated leftovers).
        const storeRoot = join(root, "store");
        await mkdir(storeRoot, { recursive: true });
        const store = fsUploadStore({ root: storeRoot });
        const { uploadToken } = await store.createUpload({ key: "safe.txt", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("x"), { now: 1 });

        const sc = join(storeRoot, ".uploads", `${uploadToken}.json`);
        const sidecar = JSON.parse(await readFile(sc, "utf8"));
        sidecar.key = "../evil.txt";
        await writeFile(sc, JSON.stringify(sidecar));

        await expect(store.completeUpload(uploadToken, { now: 2 })).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(stat(join(root, "evil.txt"))).rejects.toThrow();
    });

    test("hostile tokens answer UploadNotFoundError, never a path lookup", async () => {
        const store = fsUploadStore({ root });
        for (const token of ["../../etc/passwd", "..", "a/b", "x\\y", "UPPER", "..json"]) {
            await expect(store.getUploadState(token)).rejects.toBeInstanceOf(UploadNotFoundError);
            await expect(store.appendChunk(token, 0, enc.encode("x"), { now: 0 }))
                .rejects.toBeInstanceOf(UploadNotFoundError);
            await expect(store.completeUpload(token, { now: 0 }))
                .rejects.toBeInstanceOf(UploadNotFoundError);
        }
        // Abort is idempotent even for tokens this store could never issue.
        await store.abortUpload("../../etc/passwd");
    });

    test("traversal-shaped tokens cannot reach files outside the workspace", async () => {
        // Plant a valid-looking sidecar and data file OUTSIDE .uploads: if a
        // hostile token ever reached the path layer, this is what it would
        // read (and answer state from) instead of rejecting.
        await writeFile(join(root, "escape.json"), JSON.stringify({
            key: "escape", createdAt: 0, isComplete: false, isInvalidated: false,
        }));
        await writeFile(join(root, "escape"), "planted bytes");
        const store = fsUploadStore({ root });
        for (const token of ["../escape", "aaaa/../../escape"]) {
            await expect(store.getUploadState(token)).rejects.toBeInstanceOf(UploadNotFoundError);
        }
    });

    test("unknown-but-well-formed tokens answer UploadNotFoundError", async () => {
        const store = fsUploadStore({ root });
        await expect(store.getUploadState("deadbeef-0000-4000-8000-000000000000"))
            .rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("accepts empty options objects (no signal) on every read-only call", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        expect((await store.getUploadState(uploadToken, {})).offset).toBe(0);
        expect((await store.sweepExpired!(0, {})).removed).toBe(0);
        await store.abortUpload(uploadToken, {});
    });
});

describe("fsUploadStore: damaged workspaces", () => {
    test("a lost data file under a live sidecar reports terminal invalidation", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
        await unlink(join(root, ".uploads", uploadToken));

        const state = await store.getUploadState(uploadToken);
        expect(state.isInvalidated).toBe(true);
        expect(state.isComplete).toBe(false);
        expect(state.offset).toBe(0);
        await expect(store.appendChunk(uploadToken, 0, enc.encode("x"), { now: 2 }))
            .rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.completeUpload(uploadToken, { now: 3 }))
            .rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a torn sidecar answers UploadNotFoundError instead of crashing", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await writeFile(sidecarPath(uploadToken), "{ not json");
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

describe("fsUploadStore: sweepExpired", () => {
    test("removes only resources idle since strictly before the cutoff", async () => {
        const store = fsUploadStore({ root });
        const stale = await store.createUpload({ key: "stale.bin", now: 1_000 });
        const active = await store.createUpload({ key: "active.bin", now: 1_000 });
        await store.appendChunk(active.uploadToken, 0, enc.encode("x"), { now: 9_000 });

        const swept = await store.sweepExpired!(5_000);
        expect(swept.removed).toBe(1);
        await expect(store.getUploadState(stale.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect((await store.getUploadState(active.uploadToken)).offset).toBe(1);
        // Both files of the swept resource are gone, not just the sidecar.
        expect(await readdir(join(root, ".uploads"))).toEqual([
            active.uploadToken,
            `${active.uploadToken}.json`,
        ].sort());

        // Boundary: idle exactly AT the cutoff is kept (idle since BEFORE it).
        expect((await store.sweepExpired!(9_000)).removed).toBe(0);
        expect((await store.sweepExpired!(9_001)).removed).toBe(1);
    });

    test("a swept-away resource cannot be resumed but a published object survives", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "done.bin", now: 1_000 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1_500 });
        await store.completeUpload(uploadToken, { now: 2_000 });

        const swept = await store.sweepExpired!(Date.now());
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
        const swept = await store.sweepExpired!(Date.now() + 3_600_000);
        expect(swept.removed).toBe(2);
        expect(await readdir(join(root, ".uploads"))).toEqual([]);
    });

    test("fresh artifacts survive the mtime fallback (mid-write is not raced)", async () => {
        const store = fsUploadStore({ root });
        await mkdir(join(root, ".uploads"), { recursive: true });
        await writeFile(join(root, ".uploads", "deadbeef"), "just created");
        // A cutoff in the past: nothing recent may be touched.
        const swept = await store.sweepExpired!(Date.now() - 3_600_000);
        expect(swept.removed).toBe(0);
        expect(await readdir(join(root, ".uploads"))).toEqual(["deadbeef"]);
    });

    test("a freshly written torn sidecar survives a past-cutoff sweep", async () => {
        const store = fsUploadStore({ root });
        await mkdir(join(root, ".uploads"), { recursive: true });
        await writeFile(join(root, ".uploads", "cafe.json"), "{ torn");
        // A cutoff in the past: the mtime fallback must anchor the artifact
        // as fresh, never treat unparseable as already-expired.
        const swept = await store.sweepExpired!(Date.now() - 3_600_000);
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

        const swept = await store.sweepExpired!(now - 3_600_000);
        expect(swept.removed).toBe(0);
        expect((await store.getUploadState(uploadToken)).offset).toBe(decoy.length);
    });

    test("an old data file with a live sidecar is never orphan-reaped", async () => {
        const store = fsUploadStore({ root });
        const now = Date.now();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now });
        // Age both files far past any cutoff; the sidecar facts (createdAt =
        // now) still anchor the resource, so neither file is an orphan.
        await utimes(join(root, ".uploads", uploadToken), 1, 1);
        await utimes(sidecarPath(uploadToken), 1, 1);

        const swept = await store.sweepExpired!(now - 3_600_000);
        expect(swept.removed).toBe(0);
        expect((await store.getUploadState(uploadToken)).offset).toBe(3);
    });

    test("a root with no uploads workspace sweeps zero", async () => {
        const store = fsUploadStore({ root });
        expect(await store.sweepExpired!(Date.now())).toEqual({ removed: 0 });
    });
});

describe("fsUploadStore: abort", () => {
    test("abort is idempotent and removes both workspace files", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });

        await store.abortUpload(uploadToken);
        await store.abortUpload(uploadToken); // second discard: no-op
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(await readdir(join(root, ".uploads"))).toEqual([]);
    });
});
