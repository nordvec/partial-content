import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    checkResumableWriteStore,
    checkObjectStore,
    formatConformanceReport,
    runConformanceCheck,
    tallyConformance,
} from "../conformance";
import type { ConformanceAssert, ConformanceReport } from "../conformance";
import { memoryUploadStore, memoryStore } from "../memory";
import type { MemoryObject } from "../memory";
import { fsUploadStore, fsStore } from "../fs";
import {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
} from "../upload-store";
import type {
    AppendChunkOptions,
    AppendChunkResult,
    CompletedUpload,
    CompleteUploadOptions,
    CreateUploadOptions,
    ResumableWriteStore,
    StoredUploadState,
} from "../upload-store";
import type { ObjectStore } from "../index";

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pc-conformance-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const failedNames = (checks: { name: string; ok: boolean; skipped?: boolean }[]) =>
    checks.filter((c) => !c.ok && !c.skipped).map((c) => c.name);

const skippedNames = (checks: { name: string; skipped?: boolean }[]) =>
    checks.filter((c) => c.skipped).map((c) => c.name);

const detailOf = (report: ConformanceReport, name: string) => report.checks.find((c) => c.name === name)?.detail;

// ─── A store whose flaws can be turned on one at a time ─────────────────────

/**
 * The dishonest shapes the harness has to catch. Each is a store that answers
 * every question about itself correctly and is wrong only about the object.
 *
 * - `writes-before-checking`: the bytes land at the claimed offset, and the
 *   offset check runs afterwards. The conflict it raises is indistinguishable
 *   from a correct store's, and the durable offset never moves, because the
 *   replay overwrote a prefix already there.
 * - `publishes-before-verifying`: completion puts the assembled bytes at the
 *   key and only then hashes them, so a rejected completion leaves an
 *   unverified object where readers can see it.
 * - `deletes-on-abort`: cancelling the upload resource deletes the object the
 *   upload published.
 * - `stops-mid-body`: the append reads one chunk of a multi-chunk body, makes
 *   it durable, and reports a clean append.
 * - `swallows-a-torn-body`: the body fails mid-transfer and the append reports
 *   the flushed prefix as a body read to its end.
 * - `ignores-a-mid-read-abort`: the signal is tested once on arrival and never
 *   again, so a yield asked for while the body is being read is not honoured
 *   and not reported.
 * - `overruns-the-bound-on-a-stream`: `maxBytes` is honoured for a buffer body
 *   and ignored for a chunked one, which is what a bound satisfied by slicing
 *   rather than by stopping looks like.
 * - `ignores-the-expected-length`: completion publishes whatever the assembly
 *   holds, whatever length the caller acknowledged.
 * - `reopens-after-completion`: an append to a completed upload is accepted
 *   and re-publishes the object with the late bytes in it.
 */
type StoreFlaw =
    | "none"
    | "writes-before-checking"
    | "publishes-before-verifying"
    | "deletes-on-abort"
    | "stops-mid-body"
    | "swallows-a-torn-body"
    | "ignores-a-mid-read-abort"
    | "overruns-the-bound-on-a-stream"
    | "ignores-the-expected-length"
    | "reopens-after-completion";

interface FakeStoreOptions {
    flaw?: StoreFlaw;
    /** Published objects, by key. The harness reads these through `readObject`. */
    objects: Record<string, Uint8Array>;
    /**
     * Whether completion verifies an asserted digest. The second of the two
     * ways the harness can see published bytes, so turning it off with no
     * `readObject` is what leaves it blind.
     */
    verifiesDigest?: boolean;
}

interface FakeRecord {
    key: string;
    /** Durable bytes; only the first `size` of them are accounted for. */
    buffer: Uint8Array<ArrayBuffer>;
    size: number;
    length?: number;
    isComplete: boolean;
    isInvalidated: boolean;
    createdAt: number;
    expiresAt?: number;
    lastAppendAt?: number;
    metadata?: Record<string, string>;
    digest?: string;
    etag?: string;
}

const base64 = (input: Uint8Array): string => {
    let binary = "";
    for (const byte of input) binary += String.fromCharCode(byte);
    return btoa(binary);
};

async function sha256Base64(input: Uint8Array<ArrayBuffer>): Promise<string> {
    return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
}

/**
 * A correct write store with one flaw switched on, backed by a byte buffer per
 * upload so a positional write is expressible at all.
 *
 * Purpose-built rather than a wrapper: every one of these flaws is about where
 * bytes land relative to a check, which a delegating wrapper cannot express
 * over a store that already does it right.
 */
function fakeUploadStore(opts: FakeStoreOptions): ResumableWriteStore {
    const flaw = opts.flaw ?? "none";
    const uploads = new Map<string, FakeRecord>();

    const lookup = (uploadToken: string): FakeRecord => {
        const record = uploads.get(uploadToken);
        if (!record) throw new UploadNotFoundError(uploadToken);
        return record;
    };

    const writeAt = (record: FakeRecord, offset: number, chunk: Uint8Array): void => {
        const end = offset + chunk.byteLength;
        if (end > record.buffer.byteLength) {
            const grown = new Uint8Array(end);
            grown.set(record.buffer);
            record.buffer = grown;
        }
        record.buffer.set(chunk, offset);
    };

    const durableBytes = (record: FakeRecord): Uint8Array<ArrayBuffer> => record.buffer.slice(0, record.size);

    return {
        atomicCompletion: true,
        enforcesOffsetCheck: true,
        exactOffsetRecovery: true,
        digestOnComplete: opts.verifiesDigest === false ? false : ["sha-256"],

        async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
            const uploadToken = `fake-${crypto.randomUUID()}`;
            uploads.set(uploadToken, {
                key: createOpts.key,
                buffer: new Uint8Array(0),
                size: 0,
                length: createOpts.length,
                metadata: createOpts.metadata,
                createdAt: createOpts.now,
                expiresAt: createOpts.expiresAt,
                isComplete: false,
                isInvalidated: false,
            });
            return { uploadToken };
        },

        async getUploadState(uploadToken: string): Promise<StoredUploadState> {
            const record = lookup(uploadToken);
            return {
                key: record.key,
                offset: record.size,
                length: record.length,
                status: record.isInvalidated ? "invalidated" : record.isComplete ? "complete" : "incomplete",
                createdAt: record.createdAt,
                expiresAt: record.expiresAt,
                lastAppendAt: record.lastAppendAt,
                metadata: record.metadata,
            };
        },

        async appendChunk(
            uploadToken: string,
            offset: number,
            body: ReadableStream<Uint8Array> | Uint8Array,
            appendOpts: AppendChunkOptions,
        ): Promise<AppendChunkResult> {
            if (appendOpts.signal?.aborted === true) {
                if (!(body instanceof Uint8Array)) await body.cancel().catch(() => undefined);
                return { bytesWritten: 0, interrupted: true };
            }
            const record = lookup(uploadToken);
            const reopens = record.isComplete && flaw === "reopens-after-completion";
            const conflicts = (record.isComplete && !reopens) || record.isInvalidated || offset !== record.size;
            if (conflicts && flaw !== "writes-before-checking") {
                throw new UploadOffsetConflictError(uploadToken, record.size);
            }

            const parts: Uint8Array[] = [];
            let taken = 0;
            let crossed: number | undefined;
            let interrupted = false;
            const streaming = !(body instanceof Uint8Array);
            const bound = streaming && flaw === "overruns-the-bound-on-a-stream" ? undefined : appendOpts.maxBytes;
            const accept = (chunk: Uint8Array): boolean => {
                const room = bound === undefined ? chunk.byteLength : Math.min(chunk.byteLength, bound - taken);
                if (room > 0) {
                    parts.push(chunk.slice(0, room));
                    taken += room;
                }
                if (room < chunk.byteLength) {
                    crossed = bound;
                    return false;
                }
                return true;
            };

            /**
             * Read afresh at every chunk boundary, because `aborted` flips
             * while the call is running: a lock preempted mid-read is the
             * routine case, and the boundary is what bounds what a preempted
             * holder still writes.
             */
            const preempted = (): boolean => appendOpts.signal?.aborted === true && flaw !== "ignores-a-mid-read-abort";

            if (body instanceof Uint8Array) {
                accept(body);
            } else {
                const reader = body.getReader();
                try {
                    for (;;) {
                        if (preempted()) {
                            interrupted = true;
                            break;
                        }
                        let next: Awaited<ReturnType<typeof reader.read>>;
                        try {
                            next = await reader.read();
                        } catch {
                            // Torn body: the prefix is the truthful answer, and
                            // the tear is reported rather than raised.
                            interrupted = flaw !== "swallows-a-torn-body";
                            break;
                        }
                        if (next.done) break;
                        if (!accept(next.value)) break;
                        // The lie: stop with the body unfinished and say nothing.
                        if (flaw === "stops-mid-body") break;
                    }
                } finally {
                    void reader.cancel().catch(() => undefined);
                }
            }

            const accepted = new Uint8Array(taken);
            let at = 0;
            for (const part of parts) {
                accepted.set(part, at);
                at += part.byteLength;
            }
            writeAt(record, offset, accepted);
            if (conflicts) {
                // `writes-before-checking`: the bytes are durable and only now
                // does the store look at the offset it was handed.
                throw new UploadOffsetConflictError(uploadToken, record.size);
            }

            record.size = offset + taken;
            record.lastAppendAt = appendOpts.now;
            if (reopens) opts.objects[record.key] = durableBytes(record);
            if (appendOpts.length !== undefined && record.length === undefined) {
                record.length = appendOpts.length;
            }
            if (crossed !== undefined && appendOpts.maxBytesFatal === true) {
                record.isInvalidated = true;
                throw new UploadOverrunError(uploadToken, crossed);
            }
            if (crossed !== undefined) throw new UploadAppendBoundError(uploadToken, record.size);
            return { bytesWritten: taken, interrupted };
        },

        async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
            const record = lookup(uploadToken);
            if (record.isComplete) return { etag: record.etag, digest: record.digest };
            if (record.isInvalidated) throw new Error("cannot complete an invalidated upload");
            if (record.size !== completeOpts.expectedLength && flaw !== "ignores-the-expected-length") {
                throw new UploadOffsetConflictError(uploadToken, record.size);
            }
            const assembled = durableBytes(record);
            const digest = await sha256Base64(assembled);
            if (flaw === "publishes-before-verifying") opts.objects[record.key] = assembled;
            const expected = completeOpts.expectedDigests?.["sha-256"];
            if (expected !== undefined && digest !== expected) {
                throw new UploadDigestMismatchError(uploadToken, "sha-256", expected, digest);
            }
            opts.objects[record.key] = assembled;
            record.isComplete = true;
            record.digest = digest;
            record.etag = `"${digest}"`;
            return { etag: record.etag, digest };
        },

        async abortUpload(uploadToken: string): Promise<void> {
            const record = uploads.get(uploadToken);
            uploads.delete(uploadToken);
            if (flaw === "deletes-on-abort" && record !== undefined) {
                delete opts.objects[record.key];
            }
        },
    };
}

/** Read back what the fake store published, which is what the harness needs. */
const readFrom =
    (objects: Record<string, Uint8Array>) =>
    (key: string): Uint8Array | undefined =>
        Object.hasOwn(objects, key) ? objects[key] : undefined;

/** What the harness can read back from a filesystem store's destination keys. */
const readFromRoot =
    (at: string) =>
    async (key: string): Promise<Uint8Array | undefined> => {
        try {
            return await readFile(join(at, key));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw err;
        }
    };

const readFromMemory =
    (objects: Record<string, MemoryObject>) =>
    (key: string): Uint8Array | undefined => {
        const entry = Object.hasOwn(objects, key) ? objects[key] : undefined;
        if (entry === undefined) return undefined;
        return typeof entry.body === "string" ? new TextEncoder().encode(entry.body) : entry.body;
    };

// The whole conformance battery against a real filesystem, including the
// restart obligations that reopen the store. It runs once per file and every
// test that reads its report awaits the same run, so no test pays for it twice.
// The limit is calibrated for the CONTENDED run rather than an idle one,
// because that is the run it has: inside a parallel suite competing for the
// same disk, ten full-suite rounds measured it near 40s where idle it is
// seconds. Every test awaiting the battery carries this limit, since whichever
// runs first (a filtered run picks either) is the one that pays.
const FS_BATTERY_TIMEOUT_MS = 180_000;
let fsBattery: Promise<ConformanceReport> | undefined;
const fsBatteryReport = (): Promise<ConformanceReport> =>
    (fsBattery ??= (async () => {
        const at = await mkdtemp(join(tmpdir(), "pc-conformance-battery-"));
        try {
            return await checkResumableWriteStore(() => fsUploadStore({ root: at }), { readObject: readFromRoot(at) });
        } finally {
            await rm(at, { recursive: true, force: true });
        }
    })());

describe("the built-in stores satisfy the contract they document", () => {
    test(
        "fsUploadStore passes every check, restart obligations included",
        async () => {
            const report = await fsBatteryReport();
            expect(failedNames(report.checks)).toEqual([]);
            expect(report.skipped).toBe(0);
            expect(report.ok).toBe(true);
        },
        FS_BATTERY_TIMEOUT_MS,
    );

    test("memoryUploadStore passes, with the cross-instance checks reported as unverified", async () => {
        const objects: Record<string, MemoryObject> = {};
        const report = await checkResumableWriteStore(() => memoryUploadStore({ objects }), {
            restartable: false,
            readObject: readFromMemory(objects),
        });
        expect(failedNames(report.checks)).toEqual([]);
        // Skipped, not passed: an in-process store cannot demonstrate durability
        // across instances, and the report says so rather than implying it did.
        expect(skippedNames(report.checks)).toEqual(["offset-is-backend-derived", "records-a-deferred-length"]);
        expect(report.ok).toBe(true);
    });

    test("the harness passes a correct store that has no flaw switched on", async () => {
        // The floor under every negative test below: each of those asserts an
        // exact list of failures, which only means anything if this one is empty.
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ objects });
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        expect(failedNames(report.checks)).toEqual([]);
        expect(report.ok).toBe(true);
    });
});

describe("the harness catches a store that is honest about itself and wrong about the object", () => {
    test("bytes written before the offset check are caught, even though the offset never moves", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "writes-before-checking", objects });
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        // The offset assertion cannot see this one: the replay overwrote bytes
        // already inside the prefix, so the durable size is where it was.
        expect(failedNames(report.checks)).toEqual(["stale-write-leaves-the-bytes-alone"]);
        expect(detailOf(report, "stale-write-leaves-the-bytes-alone")).toContain(
            "the stale bytes landed and the refusal came afterwards",
        );
    });

    test("the same store is caught through its own digest verification, with no read-back", async () => {
        // A store that verifies at completion answers the question from the
        // inside: corrupted bytes cannot hash to the digest of the correct ones.
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "writes-before-checking", objects });
        const report = await checkResumableWriteStore(() => store, { restartable: false });
        expect(failedNames(report.checks)).toContain("stale-write-leaves-the-bytes-alone");
        expect(detailOf(report, "stale-write-leaves-the-bytes-alone")).toContain("do not hash to the digest");
    });

    test("with neither read-back nor digest verification the bytes go unverified, not green", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({
            flaw: "writes-before-checking",
            objects,
            verifiesDigest: false,
        });
        const report = await checkResumableWriteStore(() => store, { restartable: false });
        // The corruption is real and invisible here, so the report must say the
        // obligation went unlooked-at rather than report a pass.
        expect(failedNames(report.checks)).toEqual([]);
        expect(skippedNames(report.checks)).toContain("stale-write-leaves-the-bytes-alone");
        expect(detailOf(report, "stale-write-leaves-the-bytes-alone")).toContain("no readObject was supplied");
        expect(formatConformanceReport(report)).toContain("SKIP  stale-write-leaves-the-bytes-alone");
    });

    test("a completion that publishes before it verifies is caught at the destination key", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "publishes-before-verifying", objects });
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        // Every question asked of the store alone is answered correctly: it
        // throws the right error, does not report itself complete, and lets the
        // retry land. Only the key shows the unverified object.
        expect(failedNames(report.checks)).toEqual(["failed-completion-publishes-nothing"]);
        expect(detailOf(report, "failed-completion-publishes-nothing")).toContain(
            "readable at the destination key after a failed verification",
        );
    });

    test("the same store passes every self-report, so without read-back the check is skipped", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "publishes-before-verifying", objects });
        const report = await checkResumableWriteStore(() => store, { restartable: false });
        expect(failedNames(report.checks)).toEqual([]);
        expect(skippedNames(report.checks)).toContain("failed-completion-publishes-nothing");
        expect(detailOf(report, "failed-completion-publishes-nothing")).toContain("no readObject was supplied");
    });

    test("a store with no verification step still has its atomic completion exercised", async () => {
        // digestOnComplete false is the common case (four of the six built-ins),
        // and it used to leave atomicCompletion with no behavioural coverage at
        // all. The destination key is what closes that.
        const objects: Record<string, Uint8Array> = {};
        const leaky = fakeUploadStore({ objects, verifiesDigest: false });
        const store: ResumableWriteStore = {
            ...leaky,
            async appendChunk(token, offset, body, appendOpts) {
                const result = await leaky.appendChunk(token, offset, body, appendOpts);
                // Progressive publication: readers can see a torn object while
                // the upload is still open, which is what atomicCompletion denies.
                const state = await leaky.getUploadState(token);
                objects[state.key] = new Uint8Array(state.offset);
                return result;
            },
        };
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        expect(failedNames(report.checks)).toContain("completion-publishes-exactly-what-was-appended");
        expect(detailOf(report, "completion-publishes-exactly-what-was-appended")).toContain(
            "with the upload still open",
        );
    });

    test("an abort that deletes the object the upload published is caught", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "deletes-on-abort", objects });
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        expect(failedNames(report.checks)).toEqual(["abort-spares-a-published-object"]);
        expect(detailOf(report, "abort-spares-a-published-object")).toContain("destroys live data on a routine probe");
    });

    test("the same abort goes unverified without read-back rather than passing", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "deletes-on-abort", objects });
        const report = await checkResumableWriteStore(() => store, { restartable: false });
        expect(failedNames(report.checks)).toEqual([]);
        expect(skippedNames(report.checks)).toContain("abort-spares-a-published-object");
        expect(detailOf(report, "abort-spares-a-published-object")).toContain("no readObject was supplied");
    });

    test("a store that stops mid-body and calls it a clean append is caught", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "stops-mid-body", objects });
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        // A signal latched before the call is the easy shape and every store
        // gets it right. This is the one that publishes a short object: the
        // append stops with the body unfinished and reports interrupted: false.
        // It is wrong on every shape a stream arrives in, so every stream check
        // sees it, and the exact list is what keeps that claim honest.
        expect(failedNames(report.checks)).toEqual([
            "short-append-reports-interrupted",
            "torn-body-reports-interrupted",
            "mid-read-abort-reports-interrupted",
            "request-ceiling-stops-a-stream",
        ]);
        expect(detailOf(report, "short-append-reports-interrupted")).toContain("publishes a short object");
        // Stopping short of a ceiling it never reached is not the same defect
        // as reading past it, and the report says which one it saw.
        expect(detailOf(report, "request-ceiling-stops-a-stream")).toContain("with 4 bytes durable");
    });

    test("a store that swallows a torn body and calls it a clean append is caught", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "swallows-a-torn-body", objects });
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        // Everything durable is accounted for and the offset agrees. The lie is
        // the one bit the orchestrator's publish decision reads.
        expect(failedNames(report.checks)).toEqual(["torn-body-reports-interrupted"]);
        expect(detailOf(report, "torn-body-reports-interrupted")).toContain("publishes a short object");
    });

    test("a store that tests the signal only on arrival is caught mid-read", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "ignores-a-mid-read-abort", objects });
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        // The already-aborted signal is the easy shape and the guard at the top
        // of the method answers it, so that check still passes here.
        expect(failedNames(report.checks)).toEqual(["mid-read-abort-reports-interrupted"]);
        expect(detailOf(report, "mid-read-abort-reports-interrupted")).toContain("never reached its end");
    });

    test("a store that publishes at a length nobody acknowledged is caught", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "ignores-the-expected-length", objects });
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        expect(failedNames(report.checks)).toEqual(["completion-refuses-an-unacknowledged-length"]);
        expect(detailOf(report, "completion-refuses-an-unacknowledged-length")).toContain(
            "published at a length the caller never acknowledged",
        );
    });

    test("a store that reopens a completed upload and re-publishes it is caught", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "reopens-after-completion", objects });
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        expect(failedNames(report.checks)).toEqual([
            "completion-publishes-and-closes",
            "late-append-leaves-the-published-object-alone",
        ]);
        expect(detailOf(report, "late-append-leaves-the-published-object-alone")).toContain(
            "acknowledged an append after completion",
        );
    });

    test("a bound honoured by slicing a buffer and not by stopping a stream is caught", async () => {
        const objects: Record<string, Uint8Array> = {};
        const store = fakeUploadStore({ flaw: "overruns-the-bound-on-a-stream", objects });
        const report = await checkResumableWriteStore(() => store, {
            restartable: false,
            readObject: readFrom(objects),
        });
        // The buffer-bodied ceiling check passes: one slice satisfies it without
        // any stopping logic existing at all.
        expect(failedNames(report.checks)).toEqual(["request-ceiling-stops-a-stream"]);
        expect(detailOf(report, "request-ceiling-stops-a-stream")).toContain(
            "only a stream exercises the stopping logic",
        );
    });

    test("a store that raises a yield instead of reporting it is caught on all three shapes", async () => {
        const objects: Record<string, Uint8Array> = {};
        const correct = fakeUploadStore({ objects });
        const raising: ResumableWriteStore = {
            ...correct,
            async appendChunk(token, offset, body, appendOpts) {
                const result = await correct.appendChunk(token, offset, body, appendOpts);
                // The shape the contract forbids: a caller handed an exception
                // cannot tell a yield from a backend failure, so it discards an
                // upload that is resumable from a truthful offset.
                if (result.interrupted) throw new Error("client went away");
                return result;
            },
        };
        const report = await checkResumableWriteStore(() => raising, {
            restartable: false,
            readObject: readFrom(objects),
        });
        expect(failedNames(report.checks)).toEqual([
            "abort-is-reported-not-raised",
            "torn-body-reports-interrupted",
            "mid-read-abort-reports-interrupted",
        ]);
        expect(detailOf(report, "torn-body-reports-interrupted")).toContain("a yield is REPORTED");
    });
});

describe("the harness catches a store that does not do what it declares", () => {
    /**
     * A store that reports `enforcesOffsetCheck: true` and ignores the claimed
     * offset. This is the dangerous shape, because it presents as working: every
     * append lands and every upload completes, and the guarantee is absent only
     * when a lock is stolen from a holder that stalled past its TTL.
     */
    function storeThatSkipsTheOffsetCheck(): ResumableWriteStore {
        const real = memoryUploadStore({ objects: {} });
        return {
            ...real,
            enforcesOffsetCheck: true,
            async appendChunk(token, _offset, body, opts) {
                const state = await real.getUploadState(token);
                return real.appendChunk(token, state.offset, body, opts);
            },
        };
    }

    test("a declared offset check that is not performed fails, on both directions", async () => {
        const report = await checkResumableWriteStore(storeThatSkipsTheOffsetCheck, { restartable: false });
        expect(report.ok).toBe(false);
        expect(failedNames(report.checks)).toEqual([
            "stale-write-changes-nothing",
            "stale-write-leaves-the-bytes-alone",
            "refuses-stale-offset",
            "refuses-future-offset",
        ]);
        // The message has to say what the consequence is, not just that a check
        // failed, because the author reading it believes their store is correct.
        const stale = report.checks.find((c) => c.name === "refuses-stale-offset");
        expect(stale?.detail).toContain("declared but not implemented");
    });

    test("tokens minted from a counter fail, however long they are", async () => {
        const real = memoryUploadStore({ objects: {} });
        const map = new Map<string, string>();
        let n = 0;
        const guessable: ResumableWriteStore = {
            ...real,
            async createUpload(opts) {
                const { uploadToken } = await real.createUpload(opts);
                // Long enough to clear a length check, ordered enough to be guessed.
                const pretty = `upload-from-a-counter-not-a-csprng-${String(n++).padStart(6, "0")}`;
                map.set(pretty, uploadToken);
                return { uploadToken: pretty };
            },
            getUploadState: (t, o) => real.getUploadState(map.get(t) ?? t, o),
            appendChunk: (t, off, b, o) => real.appendChunk(map.get(t) ?? t, off, b, o),
            completeUpload: (t, o) => real.completeUpload(map.get(t) ?? t, o),
            abortUpload: (t, o) => real.abortUpload(map.get(t) ?? t, o),
        };

        const report = await checkResumableWriteStore(() => guessable, { restartable: false });
        expect(failedNames(report.checks)).toContain("token-is-unguessable");
        expect(report.checks.find((c) => c.name === "token-is-unguessable")?.detail).toContain(
            "counter or a timestamp",
        );
    });

    /** A random token that also carries its object key, in the shape `mint` gives it. */
    function storeWhoseTokenCarriesTheKey(mint: (key: string) => string): ResumableWriteStore {
        const real = memoryUploadStore({ objects: {} });
        const map = new Map<string, string>();
        const inner = (t: string) => map.get(t) ?? t;
        return {
            ...real,
            async createUpload(opts) {
                const { uploadToken } = await real.createUpload(opts);
                const carrying = `${crypto.randomUUID()}.${mint(opts.key)}`;
                map.set(carrying, uploadToken);
                return { uploadToken: carrying };
            },
            getUploadState: (t, o) => real.getUploadState(inner(t), o),
            appendChunk: (t, off, b, o) => real.appendChunk(inner(t), off, b, o),
            completeUpload: (t, o) => real.completeUpload(inner(t), o),
            abortUpload: (t, o) => real.abortUpload(inner(t), o),
        };
    }

    test("a token that carries its object key fails, plain or encoded", async () => {
        const forms: Array<(key: string) => string> = [
            (key) => key,
            (key) => encodeURIComponent(key),
            // A malformed escape beside the encoded key must not hide it.
            (key) => `%zz%ff${encodeURIComponent(`/${key}`)}`,
            (key) => Buffer.from(key).toString("base64url"),
            (key) => Buffer.from(key).toString("base64"),
        ];
        for (const mint of forms) {
            const report = await checkResumableWriteStore(() => storeWhoseTokenCarriesTheKey(mint), {
                restartable: false,
            });
            expect(failedNames(report.checks)).toEqual(["token-is-unguessable"]);
            expect(report.checks.find((c) => c.name === "token-is-unguessable")?.detail).toContain("encode nothing");
        }
    });

    test("a store that returns normally after crossing a representation bound fails", async () => {
        const real = memoryUploadStore({ objects: {} });
        const swallowing: ResumableWriteStore = {
            ...real,
            async appendChunk(token, offset, body, opts) {
                try {
                    return await real.appendChunk(token, offset, body, opts);
                } catch {
                    // The pre-4.0 shape: invalidate, then answer as if it worked.
                    return { bytesWritten: opts.maxBytes ?? 0, interrupted: false };
                }
            },
        };
        const report = await checkResumableWriteStore(() => swallowing, { restartable: false });
        expect(failedNames(report.checks)).toContain("representation-bound-invalidates");
    });
});

describe("the report", () => {
    // The formatter is a pure function of a report, so it is fed one directly.
    // Driving a real store here would spend a filesystem conformance pass to
    // assert string shape, and make a formatting test fail for I/O reasons.
    const report: ConformanceReport = {
        ok: false,
        passed: 1,
        failed: 1,
        skipped: 1,
        checks: [
            { name: "refuses-stale-offset", obligation: "o", ok: true },
            { name: "offset-is-backend-derived", obligation: "o", ok: true, skipped: true, detail: "why" },
            { name: "representation-bound-invalidates", obligation: "o", ok: false, detail: "returned normally" },
        ],
    };

    test("renders a verdict per check, with the detail on the ones that carry it", () => {
        const text = formatConformanceReport(report);
        expect(text).toContain("PASS  refuses-stale-offset");
        expect(text).toContain("SKIP  offset-is-backend-derived");
        expect(text).toContain("FAIL  representation-bound-invalidates");
        // A failure the reader cannot act on is only half a report.
        expect(text).toContain("returned normally");
    });

    test("ends with the tally", () => {
        expect(formatConformanceReport(report)).toContain("1 passed, 1 failed, 1 skipped");
    });
});

// ─── The read contract, and a store that does not meet it ───────────────────

const CONTENT = new TextEncoder().encode("conformance-read-side-sample-bytes");

function servedMemoryStore() {
    return memoryStore({ objects: { "docs/sample.bin": { body: CONTENT } } });
}

describe("checkObjectStore", () => {
    test("memoryStore satisfies every read obligation", async () => {
        const report = await checkObjectStore(servedMemoryStore(), {
            key: "docs/sample.bin",
            content: CONTENT,
        });
        expect(report.checks.filter((c) => !c.ok && !c.skipped).map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
        expect(report.ok).toBe(true);
    });

    test("fsStore satisfies them too, over a real filesystem", async () => {
        // The suite already owns a fresh root per test and removes it after,
        // so a second temp directory here would only add a lifecycle to race.
        await mkdir(join(root, "docs"), { recursive: true });
        await writeFile(join(root, "docs", "sample.bin"), CONTENT);

        const report = await checkObjectStore(fsStore({ root }), {
            key: "docs/sample.bin",
            content: CONTENT,
        });

        expect(report.checks.filter((c) => !c.ok && !c.skipped).map((c) => c.name)).toEqual([]);
        expect(report.ok).toBe(true);
    });

    test("a store that overstates the total on a partial read is caught", async () => {
        // The number becomes the Content-Range total, so a client sizes its
        // remaining requests against it and runs off the end of the object.
        const inner = servedMemoryStore();
        const lying: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                const s = await inner.getObject(key, opts);
                return opts?.range ? { ...s, totalSize: CONTENT.byteLength + 100 } : s;
            },
        };
        const report = await checkObjectStore(lying, { key: "docs/sample.bin", content: CONTENT });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => c.name === "range-reports-an-honest-total")?.detail).toContain(
            "Content-Range total",
        );
    });

    test("a store whose absent key is an ordinary failure is caught", async () => {
        const inner = servedMemoryStore();
        const opaque: ObjectStore = {
            ...inner,
            headObject: async (key, opts) => {
                try {
                    return await inner.headObject(key, opts);
                } catch {
                    // The shape that turns a missing object into a 502 the
                    // caller's cache will retry indefinitely.
                    throw new Error("backend said no");
                }
            },
        };
        const report = await checkObjectStore(opaque, { key: "docs/sample.bin", content: CONTENT });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => c.name === "missing-object-is-not-found")?.detail).toContain(
            "backend failure",
        );
    });

    test("a store that maps not-found on head only is caught on the read path", async () => {
        // A plain GET calls getObject with no HEAD first, so a getObject that
        // surfaces the backend's own error answers 502 for a missing object.
        const inner = servedMemoryStore();
        const headOnly: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                try {
                    return await inner.getObject(key, opts);
                } catch {
                    throw new Error("backend said no");
                }
            },
        };
        const report = await checkObjectStore(headOnly, { key: "docs/sample.bin", content: CONTENT });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => c.name === "missing-object-is-not-found-on-read")?.detail).toContain(
            "backend failure",
        );
        expect(report.checks.find((c) => c.name === "missing-object-is-not-found")?.ok).toBe(true);
    });

    test("a store that fails the ranged read of an absent key only is caught", async () => {
        const inner = servedMemoryStore();
        const rangeOnly: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                try {
                    return await inner.getObject(key, opts);
                } catch (err) {
                    if (opts?.range) throw new Error("backend said no");
                    throw err;
                }
            },
        };
        const report = await checkObjectStore(rangeOnly, { key: "docs/sample.bin", content: CONTENT });
        expect(report.checks.find((c) => c.name === "missing-object-is-not-found-on-read")?.ok).toBe(false);
    });

    test("a store declaring no range support has those checks reported unverified", async () => {
        const inner = servedMemoryStore();
        const noRange: ObjectStore = { ...inner, supportsRange: false };
        const report = await checkObjectStore(noRange, { key: "docs/sample.bin", content: CONTENT });
        expect(report.ok).toBe(true);
        // Skipped rather than passed: the obligation went unverified and the
        // report says which and why.
        expect(report.skipped).toBe(2);
    });
});

// ─── What a pass costs ──────────────────────────────────────────────────────

describe("a check body that observes nothing cannot report a pass", () => {
    // The failure this guard deletes is not a wrong verdict, it is an invented
    // one: a check with a name, an obligation, a green mark, and a body that
    // asked the store nothing. It is indistinguishable from coverage, which is
    // why it has to be impossible to write rather than something review catches.

    test("an empty body fails, and says that is why", async () => {
        const check = await runConformanceCheck("observes-nothing", "an obligation", async () => {
            // Deliberately empty: this is the shape under test.
        });
        expect(check.ok).toBe(false);
        expect(check.skipped).toBeUndefined();
        expect(check.detail).toContain("made no assertion");
        expect(formatConformanceReport(tallyConformance([check]))).toContain("FAIL  observes-nothing");
    });

    test("a body that does the work and reports none of it fails the same way", async () => {
        // Closer to how one is really written: the body exercises the store,
        // states its property in a comment, and reads nothing back.
        const worked: string[] = [];
        const check = await runConformanceCheck("looks-and-says-nothing", "an obligation", async () => {
            worked.push("published, then aborted");
        });
        expect(worked).toEqual(["published, then aborted"]);
        expect(check.ok).toBe(false);
        expect(check.detail).toContain("made no assertion");
    });

    test("one observation that holds is what a pass costs", async () => {
        const check = await runConformanceCheck(
            "observes-one-thing",
            "an obligation",
            async (assert: ConformanceAssert) => {
                assert(true, "unreachable detail");
            },
        );
        expect(check).toEqual({ name: "observes-one-thing", obligation: "an obligation", ok: true });
    });

    test("the first unmet obligation ends the body", async () => {
        // Later assertions would run against state the first failure already
        // invalidated, and the report can only carry one detail anyway.
        const reached: string[] = [];
        const check = await runConformanceCheck(
            "stops-at-the-first",
            "an obligation",
            async (assert: ConformanceAssert) => {
                assert(reached.length > 0, "the obligation that went unmet");
                reached.push("kept going");
            },
        );
        expect(check.detail).toBe("the obligation that went unmet");
        expect(reached).toEqual([]);
    });

    test("a body that throws is a failed check carrying what it threw", async () => {
        const check = await runConformanceCheck("throws", "an obligation", async () => {
            throw new TypeError("the backend went away");
        });
        expect(check.ok).toBe(false);
        expect(check.detail).toBe("threw TypeError: the backend went away");
    });

    test("no check in either harness reports a verdict it did not look for", async () => {
        // Both harnesses build every verdict from runConformanceCheck, so a
        // check that passes is a check that asserted. These two runs pass every
        // obligation they execute, which is what proves no body in either
        // harness returns green without observing the store. The claim is about
        // the harness bodies, not a backend, so the write run uses one shared
        // in-memory instance: every restart obligation executes against it with
        // no disk, where a real filesystem pays a durable sync per bookkeeping
        // write and its time under contention is the fs test's to budget.
        const objects: Record<string, MemoryObject> = {};
        const shared = memoryUploadStore({ objects });
        const write = await checkResumableWriteStore(() => shared, { readObject: readFromMemory(objects) });
        const read = await checkObjectStore(servedMemoryStore(), {
            key: "docs/sample.bin",
            content: CONTENT,
        });
        expect(write.checks.length + read.checks.length).toBeGreaterThan(20);
        expect([...write.checks, ...read.checks].filter((c) => !c.ok || c.skipped)).toEqual([]);
    });

    test("an obligation of the caller's own folds into the report under the same rule", async () => {
        // A store author with backend-specific obligations extends a run this
        // way, and an empty one of theirs is caught exactly as an empty one of
        // ours is.
        const report = await checkObjectStore(servedMemoryStore(), {
            key: "docs/sample.bin",
            content: CONTENT,
        });
        const mine = await runConformanceCheck("my-own-obligation", "an obligation", async () => {
            // Deliberately empty: an added check gets no exemption.
        });
        const extended = tallyConformance([...report.checks, mine]);
        expect(extended.ok).toBe(false);
        expect(extended.failed).toBe(1);
        expect(extended.passed).toBe(report.passed);
    });
});
