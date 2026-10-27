/**
 * Conformance harnesses for the two store contracts.
 *
 * The write-store contract is enforced in two places and only one of them is
 * mechanical. `createUploadOrchestrator` checks that a store DECLARES
 * `atomicCompletion` and `enforcesOffsetCheck`, but a declaration is a claim
 * about behaviour, and nothing at construction can tell a store that performs
 * the offset check from one that returns `true` and writes anyway. The second
 * is the more dangerous, because it presents as working: appends land, uploads
 * complete, and the guarantee the flag stands for is absent exactly when a
 * distributed lock is stolen from a holder that stalled past its TTL, which is
 * the rare case nobody exercises by hand.
 *
 * This module turns those claims into assertions a store author can run. It is
 * not a test file and needs no test framework: every check is a plain async
 * function over the store's own public surface, so it runs under any runner,
 * in CI, or as a startup self-test against a staging bucket.
 *
 * A check reports through the {@link ConformanceAssert} it is handed and
 * through nothing else, and a body that never calls it FAILS. A harness invents
 * no verdict it did not observe: a body that looks at nothing has nothing to
 * report, and the one thing worse than a missing check is a green one.
 *
 * One class of obligation is about the OBJECT rather than the upload resource:
 * what reaches the destination key, when, and what survives a cancel. A
 * {@link ResumableWriteStore} has no read vocabulary, so asking the store
 * alone would only be asking it to describe its own work, which is exactly
 * what the flags already do. {@link ConformanceOptions.readObject} supplies
 * the missing handle; without it those checks are reported as UNVERIFIED,
 * because a publication obligation that goes unlooked-at and reads as a pass
 * is worse than no check at all.
 *
 * {@link checkObjectStore} does the same for the read contract, where the two
 * things a custom store most often gets subtly wrong are an honest total size
 * on a partial read and a not-found that is distinguishable from a failure.
 * Both are invisible in the happy path: a wrong total becomes the
 * `Content-Range` total a client sizes its remaining requests against, and an
 * indistinguishable not-found turns a missing object into a backend error a
 * caching layer will retry. It only reads, so it is safe against a staging
 * bucket that already holds the object.
 *
 * @example
 * ```typescript
 * import { checkResumableWriteStore } from "partial-content/conformance";
 * import { memoryUploadStore } from "partial-content/memory";
 *
 * const objects = {};
 * const report = await checkResumableWriteStore(
 *   () => memoryUploadStore({ objects }),
 *   // In-process by construction, so a second instance is a different store:
 *   // the cross-instance checks report as unverified rather than passing.
 *   { key: (n) => `conformance/${n}`, restartable: false },
 * );
 * if (!report.ok) {
 *   for (const check of report.checks.filter((c) => !c.ok)) {
 *     console.error(`${check.name}: ${check.detail}`);
 *   }
 *   throw new Error(`store failed ${report.failed} conformance check(s)`);
 * }
 * ```
 *
 * @packageDocumentation
 */

import { isObjectNotFoundError, type ObjectStore, type ObjectStream } from "./object-store.ts";
import { isSha256Base64 } from "./kernel.ts";
import { parkedBody } from "./parked-body.ts";
import { bytesToBase64 } from "./upload-internals.ts";
import {
    isUploadDigestMismatchError,
    isUploadNotFoundError,
    isUploadOffsetConflictError,
    isUploadAppendBoundError,
    isUploadOverrunError,
    type AppendChunkResult,
    type ResumableWriteStore,
} from "./upload-store.ts";

// ─── Report shapes ──────────────────────────────────────────────────────────

/** One contract obligation, and whether this store met it. */
export interface ConformanceCheck {
    /** Stable identifier, safe to allow-list against in a consumer's CI. */
    name: string;
    /** The obligation, phrased as what the store must do. */
    obligation: string;
    ok: boolean;
    /** Why it failed, or why it was not run. Absent when `ok` and executed. */
    detail?: string;
    /**
     * The check did not run because the store does not claim the capability, or
     * because an earlier step it depends on failed. Skipped checks never make
     * the report fail; they are reported so a gap is visible rather than green.
     */
    skipped?: boolean;
}

export interface ConformanceReport {
    /** No check failed. Skipped checks do not count against this. */
    ok: boolean;
    checks: ConformanceCheck[];
    passed: number;
    failed: number;
    skipped: number;
}

export interface ConformanceOptions {
    /**
     * Storage key for the nth upload the harness creates. Keys must be distinct
     * and disposable: the harness publishes to some of them and aborts others.
     * Point it somewhere a real deployment does not serve.
     */
    key?: (n: number) => string;
    /**
     * Epoch-ms clock handed to the store. Injected rather than read so a run is
     * reproducible and so expiry checks do not wait in real time.
     * @default a fixed instant
     */
    now?: () => number;
    /**
     * Does a second call to the factory yield a store that sees the same durable
     * state? True for anything backed by a filesystem or an object store, which
     * is what lets the harness verify that an offset survives a restart and that
     * an invalidation is visible to a process which never saw the append causing
     * it. False for a store that is in-process by construction, where a fresh
     * instance is genuinely a different store.
     *
     * Setting it false SKIPS those checks rather than passing them: the
     * guarantees go unverified, and the report says so.
     * @default true
     */
    restartable?: boolean;
    /**
     * Read whatever is published at a storage key right now, or `undefined`
     * when the key holds nothing. Never called for anything but the keys
     * {@link key} produced for this run.
     *
     * The write contract makes promises about the destination object that the
     * store's own bookkeeping cannot be asked about: that nothing is readable
     * there until completion, that a failed completion left it untouched, that
     * a refused stale append did not overwrite bytes in place, and that
     * `abortUpload` never destroys what a completion published. Supply this and
     * those become assertions against the object. Leave it out and each one is
     * reported skipped with the reason, never passed.
     *
     * Anything that can read the backend fits: the matching
     * {@link ObjectStore}'s `getObject`, the SDK the write store is built on, or
     * a plain `readFile`. A key the backend does not hold answers `undefined`
     * rather than throwing.
     */
    readObject?: (key: string) => Promise<Uint8Array | undefined> | Uint8Array | undefined;
}

// ─── Harness ────────────────────────────────────────────────────────────────

/**
 * Records one observation of the store, and ends the check when it does not
 * hold. `detail` is what the report shows: phrase it as the consequence for a
 * deployment, since the author reading it believes their store is correct.
 *
 * A check reports its verdict here and nowhere else, which is what makes the
 * count of calls meaningful: see {@link runConformanceCheck}.
 */
export type ConformanceAssert = (held: boolean, detail: string) => asserts held;

/**
 * The unmet obligation, carried out of the body by the only mechanism that can
 * leave the middle of one. Module-private, so nothing outside can raise it and
 * an escape would be a bug rather than a shape a store can imitate.
 */
class Unmet extends Error {
    constructor(readonly reason: string) {
        super(reason);
    }
}

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

/**
 * Run one obligation and answer its verdict. Both harnesses are built from
 * this, and a store author with backend-specific obligations of their own adds
 * them to a run the same way, folding the results back through
 * {@link tallyConformance}.
 *
 * Three properties, in the order they matter:
 *
 * A body that calls `assert` zero times FAILS. Reporting a pass for a body
 * that observed nothing is the failure mode a conformance harness cannot
 * afford, because it is indistinguishable from coverage: the check has a name,
 * an obligation, and a green verdict, and it asked the store nothing.
 *
 * The first unmet obligation ends the body, so later assertions never run
 * against state an earlier failure already invalidated.
 *
 * A body that throws is a failed CHECK and never a failed run: one gap must
 * not hide the ones after it.
 */
export async function runConformanceCheck(
    name: string,
    obligation: string,
    run: (assert: ConformanceAssert) => Promise<void>,
): Promise<ConformanceCheck> {
    let observations = 0;
    const assert: ConformanceAssert = (held, detail) => {
        observations++;
        if (!held) throw new Unmet(detail);
    };
    const verdict = (detail?: string): ConformanceCheck =>
        detail === undefined ? { name, obligation, ok: true } : { name, obligation, ok: false, detail };
    try {
        await run(assert);
    } catch (err) {
        if (err instanceof Unmet) return verdict(err.reason);
        return verdict(`threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    return verdict(
        observations === 0
            ? "the check body made no assertion, so a pass would state nothing about this store"
            : undefined,
    );
}

/** Run one obligation and append its verdict to a run in progress. */
const recorder =
    (checks: ConformanceCheck[]) =>
    async (name: string, obligation: string, run: (assert: ConformanceAssert) => Promise<void>): Promise<void> => {
        checks.push(await runConformanceCheck(name, obligation, run));
    };

/**
 * Record an obligation nothing looked at, with the reason it went unlooked-at.
 *
 * Exempt from the zero-assertion rule by construction rather than by
 * exception: a skip carries no body, so there is nothing that could have
 * observed the store and failed to. What it must never do is claim a pass,
 * and the `skipped` flag is what keeps the tally honest about that.
 */
const skipper =
    (checks: ConformanceCheck[]) =>
    (name: string, obligation: string, why: string): void => {
        checks.push({ name, obligation, ok: true, skipped: true, detail: why });
    };

/**
 * Count a set of check results into a report. Skipped checks are counted apart
 * from passes, so a gap never reads as green.
 */
export function tallyConformance(checks: ConformanceCheck[]): ConformanceReport {
    const passed = checks.filter((c) => c.ok && !c.skipped).length;
    const skipped = checks.filter((c) => c.skipped).length;
    const failed = checks.filter((c) => !c.ok && !c.skipped).length;
    return { ok: failed === 0, checks, passed, failed, skipped };
}

/** Byte-for-byte, so an equal length never reads as equal content. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

/** Raw base64 SHA-256: the one digest form this package speaks end to end. */
async function sha256Base64(input: Uint8Array<ArrayBuffer>): Promise<string> {
    return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
}

/**
 * A body delivered in more than one chunk. A store that stops reading after
 * the first is indistinguishable from a correct one when the body arrives as
 * a single buffer, because there is no second chunk to leave behind.
 */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

/**
 * A body whose first chunk is queued and whose rest arrives only once a reader
 * has taken it. The queue holds exactly one chunk, so the pull that refills it
 * cannot run before the store's first read, and `onPull` therefore fires while
 * the read is in progress. That is the case a guard at the top of `appendChunk`
 * does not answer, and it is the routine one: every probe preempts the lock.
 */
function streamYieldingAfterFirstChunk(chunks: Uint8Array[], onPull: () => void): ReadableStream<Uint8Array> {
    let next = 1;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(chunks[0]!);
        },
        pull(controller) {
            onPull();
            // The rest keeps arriving so a store that ignores the yield reads to an
            // end and reports itself, rather than hanging on a body that stopped.
            if (next < chunks.length) controller.enqueue(chunks[next++]!);
            else controller.close();
        },
    });
}

/** The same shape torn instead of yielded: the read after the first fails. */
function streamTearingAfterFirstChunk(head: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(head);
        },
        pull(controller) {
            controller.error(new Error("the body tore"));
        },
    });
}

/** Distinct-enough to catch a token minted from a counter or a timestamp. */
const MIN_TOKEN_ENTROPY_CHARS = 16;

/**
 * Tokens minted for the ordering property. Ordering is a statistical
 * question, so it needs a sample rather than a single observation: eight
 * CSPRNG tokens sort into mint order about once in 40,000 runs, which is a
 * false failure in somebody's CI.
 */
const TOKEN_SAMPLES = 24;

/**
 * A token with every run of RFC 3986 percent-escapes decoded as UTF-8. The
 * decode is lenient (an invalid byte becomes U+FFFD), so a malformed escape
 * beside a well-formed encoding of the key cannot hide it.
 */
function percentDecoded(token: string): string {
    const utf8 = new TextDecoder();
    return token.replace(/(?:%[\dA-Fa-f]{2})+/g, (run) =>
        utf8.decode(Uint8Array.from(run.slice(1).split("%"), (hex) => Number.parseInt(hex, 16))),
    );
}

/**
 * How many of the {@link TOKEN_SAMPLES} - 1 consecutive pairs may be
 * ascending before the sequence reads as ordered rather than random. Random
 * tokens ascend on about half their pairs, and reach this count roughly three
 * times in a million runs; a counter or a timestamp prefix ascends on every
 * pair, and still trips it when clock ties scramble a few.
 */
const ORDERED_PAIR_THRESHOLD = 22;

/** What a call raised, or `undefined` when it returned. */
const raisedBy = async (call: () => Promise<unknown>): Promise<unknown> => {
    try {
        await call();
    } catch (err) {
        return err;
    }
    return undefined;
};

/** Name whatever came out of {@link raisedBy}, error or not. */
const errName = (err: unknown): string => (err instanceof Error ? err.name : String(err));

/**
 * Run the write-store contract against `makeStore`.
 *
 * The factory is called rather than a store instance passed, because two
 * obligations can only be observed across instances: that the derived offset
 * comes from durable backend state rather than in-process memory, and that an
 * invalidation survives a process that never saw the append which caused it.
 *
 * Every check is independent: one failure does not stop the rest, so a single
 * run reports every gap instead of the first.
 *
 * One completion obligation is out of reach: that a destination written
 * between the seal and the publish raises `UploadDestinationConflictError`
 * and is left intact. The harness can read the destination but not write it,
 * and a write made before `completeUpload` is called lands before the seal,
 * where the contract lets publication replace it. Prove that one in the
 * store's own suite, which can reach inside the seal-to-publish window.
 */
export async function checkResumableWriteStore(
    makeStore: () => ResumableWriteStore | Promise<ResumableWriteStore>,
    opts: ConformanceOptions = {},
): Promise<ConformanceReport> {
    const key = opts.key ?? ((n: number) => `partial-content-conformance/${n}`);
    const now = opts.now ?? (() => 1_700_000_000_000);
    const restartable = opts.restartable ?? true;
    const checks: ConformanceCheck[] = [];
    let seq = 0;
    const nextKey = () => key(seq++);

    const record = recorder(checks);

    const skip = skipper(checks);
    const NOT_RESTARTABLE = "restartable: false, so durability across instances is unverified";

    const store = await makeStore();
    const readObject = opts.readObject;
    const verifiesDigest = [store.digestOnComplete].flat().includes("sha-256");
    const NO_READ_BACK = "no readObject was supplied, so nothing here can look at what reached the destination key";
    const NO_CONTENT_EVIDENCE =
        "no readObject was supplied and digestOnComplete is false, so the published bytes " +
        "can be looked at from neither side";

    /**
     * Complete `uploadToken` and answer whether the object at `objectKey` is
     * exactly `expected`, as a failure detail or `undefined`.
     *
     * Two independent kinds of evidence, because a write store has no read
     * vocabulary of its own. `readObject` looks at the destination directly. A
     * store that verifies a digest at completion answers the same question from
     * the inside: bytes other than `expected` cannot hash to the digest of
     * `expected`, so the mismatch it is required to raise IS the corruption
     * surfacing. Callers gate on one of the two being available.
     */
    const publishedBytesDiffer = async (
        uploadToken: string,
        objectKey: string,
        expected: Uint8Array<ArrayBuffer>,
    ): Promise<string | undefined> => {
        if (readObject !== undefined) {
            await store.completeUpload(uploadToken, { expectedLength: expected.byteLength, now: now() });
            const published = await readObject(objectKey);
            if (published === undefined) return "completion left the destination key empty";
            return sameBytes(published, expected)
                ? undefined
                : `the destination key holds ${published.byteLength} bytes that are not the ones appended`;
        }
        try {
            await store.completeUpload(uploadToken, {
                expectedDigests: { "sha-256": await sha256Base64(expected) },
                expectedLength: expected.byteLength,
                now: now(),
            });
        } catch (err) {
            if (isUploadDigestMismatchError(err)) {
                return "the assembled bytes do not hash to the digest of the bytes that were appended";
            }
            throw err;
        }
        return undefined;
    };

    // ── Capability declarations ───────────────────────────────────────────────
    await record(
        "declares-atomic-completion",
        "atomicCompletion must be true: the orchestrator has no completion rollback of its own",
        async (assert: ConformanceAssert) => {
            assert(store.atomicCompletion, "declared false");
        },
    );

    await record(
        "declares-offset-check",
        "enforcesOffsetCheck must be true: it is the only guard against a stolen-lock writer",
        async (assert: ConformanceAssert) => {
            assert(store.enforcesOffsetCheck, "declared false");
        },
    );

    // ── What those two declarations actually stand for ────────────────────────
    //
    // A flag is a claim, and both of these claims are about behaviour under a
    // race nobody exercises by hand. The checks below are what turn each into an
    // assertion; without them a store can declare `true`, behave otherwise, and
    // present as working right up to the moment a lock is stolen.
    const STALE_PREFIX = "0123456789";
    const STALE_REPLAY_OFFSET = 4;
    /**
     * Longer than the room between the replayed offset and the durable one, so a
     * store that writes positionally and checks afterwards cannot land inside
     * the prefix: its durable size has to move, which the offset assertion sees.
     * A store that writes in place and keeps its size is the other half of the
     * same flaw, and only the bytes show that one.
     */
    const STALE_REPLAY = "XXXXXXXXXXXX";
    /** Stage a prefix, then replay a stalled writer's append over it. */
    const replayAStaleAppend = async (): Promise<{ uploadToken: string; objectKey: string }> => {
        const objectKey = nextKey();
        const { uploadToken } = await store.createUpload({ key: objectKey, now: now() });
        await store.appendChunk(uploadToken, 0, bytes(STALE_PREFIX), { now: now() });
        // The refusal is expected; `refuses-stale-offset` covers which error it must be.
        await raisedBy(() => store.appendChunk(uploadToken, STALE_REPLAY_OFFSET, bytes(STALE_REPLAY), { now: now() }));
        return { uploadToken, objectKey };
    };

    await record(
        "stale-write-changes-nothing",
        "a refused stale append must leave the durable offset exactly where it was",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await replayAStaleAppend();
            const state = await store.getUploadState(uploadToken);
            assert(
                state.offset === STALE_PREFIX.length,
                `offset moved to ${state.offset} after a refused stale append, expected ${STALE_PREFIX.length}; ` +
                    "the offset check ran after the write, so a stolen-lock holder's bytes still landed",
            );
        },
    );

    const STALE_BYTES_OBLIGATION =
        "a refused stale append must leave the durable BYTES where they were, not only the offset";
    if (readObject !== undefined || verifiesDigest) {
        await record(
            "stale-write-leaves-the-bytes-alone",
            STALE_BYTES_OBLIGATION,
            async (assert: ConformanceAssert) => {
                const { uploadToken, objectKey } = await replayAStaleAppend();
                const differ = await publishedBytesDiffer(uploadToken, objectKey, bytes(STALE_PREFIX));
                assert(
                    differ === undefined,
                    `${differ}; the stale bytes landed and the refusal came afterwards, so the offset never ` +
                        "moved and the corruption is silent: an offset that agrees is not the same as bytes that do",
                );
            },
        );
    } else {
        skip("stale-write-leaves-the-bytes-alone", STALE_BYTES_OBLIGATION, NO_CONTENT_EVIDENCE);
    }

    const FAILED_COMPLETION_OBLIGATION =
        "a completion that fails verification must leave the destination key untouched and the upload still completable";
    if (verifiesDigest && readObject !== undefined) {
        await record(
            "failed-completion-publishes-nothing",
            FAILED_COMPLETION_OBLIGATION,
            async (assert: ConformanceAssert) => {
                const objectKey = nextKey();
                const payload = bytes("atomic");
                const { uploadToken } = await store.createUpload({ key: objectKey, now: now() });
                await store.appendChunk(uploadToken, 0, payload, { now: now() });
                // A syntactically valid SHA-256 the content cannot match.
                const wrong = bytesToBase64(new Uint8Array(32));
                const thrownAtCompletion = await raisedBy(() =>
                    store.completeUpload(uploadToken, {
                        expectedDigests: { "sha-256": wrong },
                        expectedLength: payload.byteLength,
                        now: now(),
                    }),
                );
                assert(
                    thrownAtCompletion !== undefined,
                    "published despite a digest the content does not match; " +
                        "the assertion is verified before publication or not at all",
                );
                assert(
                    isUploadDigestMismatchError(thrownAtCompletion),
                    `threw ${errName(thrownAtCompletion)}, expected UploadDigestMismatchError`,
                );
                const published = await readObject(objectKey);
                assert(
                    published === undefined,
                    `${published?.byteLength} bytes are readable at the destination key after a failed ` +
                        "verification; the bytes were published and verified afterwards, which is the order " +
                        "atomicCompletion exists to forbid",
                );
                const state = await store.getUploadState(uploadToken);
                assert(
                    state.status !== "complete",
                    "reports the upload complete after a failed verification; " +
                        "atomicCompletion means a failed completion publishes nothing at all",
                );
                // All-or-nothing cuts both ways: the failure must not have consumed
                // the staged bytes either, or the client's correct retry cannot land.
                await store.completeUpload(uploadToken, { expectedLength: payload.byteLength, now: now() });
                const retried = await readObject(objectKey);
                assert(
                    retried !== undefined && sameBytes(retried, payload),
                    "a correct retry after the failed verification did not publish the staged bytes; " +
                        "the failed completion consumed them and the client has no way back",
                );
            },
        );
    } else {
        skip(
            "failed-completion-publishes-nothing",
            FAILED_COMPLETION_OBLIGATION,
            verifiesDigest ? NO_READ_BACK : "digestOnComplete is false, so this store has no verification step to fail",
        );
    }

    const ATOMIC_PUBLICATION_OBLIGATION =
        "the destination key stays empty until completion, which puts the appended bytes there whole";
    if (readObject !== undefined) {
        await record(
            "completion-publishes-exactly-what-was-appended",
            ATOMIC_PUBLICATION_OBLIGATION,
            async (assert: ConformanceAssert) => {
                const objectKey = nextKey();
                const payload = bytes("all-or-nothing-at-the-destination-key");
                const half = 16;
                const { uploadToken } = await store.createUpload({ key: objectKey, now: now() });
                await store.appendChunk(uploadToken, 0, payload.subarray(0, half), { now: now() });
                const midway = await readObject(objectKey);
                assert(
                    midway === undefined,
                    `${midway?.byteLength} bytes are already readable at the destination key with the ` +
                        "upload still open; atomicCompletion promises readers never see a torn object",
                );
                await store.appendChunk(uploadToken, half, payload.subarray(half), { now: now() });
                await store.completeUpload(uploadToken, { expectedLength: payload.byteLength, now: now() });
                const published = await readObject(objectKey);
                assert(published !== undefined, "completion left the destination key empty");
                assert(
                    sameBytes(published, payload),
                    `the destination key holds ${published.byteLength} bytes, expected the ` +
                        `${payload.byteLength} that were appended`,
                );
            },
        );
    } else {
        skip("completion-publishes-exactly-what-was-appended", ATOMIC_PUBLICATION_OBLIGATION, NO_READ_BACK);
    }

    await record(
        "abort-is-reported-not-raised",
        "an already-aborted signal returns interrupted with nothing written, rather than throwing",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            const result = await store.appendChunk(uploadToken, 0, bytes("0123456789"), {
                now: now(),
                signal: AbortSignal.abort(),
            });
            assert(
                result.bytesWritten === 0,
                `wrote ${result.bytesWritten} bytes under an already-aborted signal, expected 0`,
            );
            assert(
                result.interrupted,
                "reported interrupted: false for a call that never read the body; " +
                    "the caller uses this to tell a yield from a completed append and would publish a truncated object",
            );
            const state = await store.getUploadState(uploadToken);
            assert(state.offset === 0, `offset moved to ${state.offset} under an aborted signal`);
        },
    );

    await record(
        "short-append-reports-interrupted",
        "interrupted: false claims the body was read to its end, so bytesWritten must account for all of it",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            const head = bytes("FIRST-HALF");
            const tail = bytes("SECOND-HALF");
            const total = head.byteLength + tail.byteLength;
            const result = await store.appendChunk(uploadToken, 0, streamOf([head, tail]), { now: now() });
            assert(
                !result.interrupted,
                "reported interrupted for a body nothing asked it to stop reading; " +
                    "a caller reads that as a yield and refuses to complete an upload that is in fact finished",
            );
            assert(
                result.bytesWritten === total,
                `reported a clean append of ${result.bytesWritten} bytes for a ${total}-byte body; ` +
                    "interrupted: false is the caller's only signal that the body ended, so a request that " +
                    "declares no total length completes here and publishes a short object",
            );
            const state = await store.getUploadState(uploadToken);
            assert(
                state.offset === total,
                `getUploadState reports ${state.offset} after an append that claimed the whole ` +
                    `${total}-byte body; the store stopped mid-body and answered as if it had not, and the ` +
                    "object the caller completes is missing the tail",
            );
        },
    );

    /** How a store answered a body it was not allowed to finish reading. */
    const yieldedAppend = async (
        assert: ConformanceAssert,
        uploadToken: string,
        result: AppendChunkResult,
        delivered: number,
        what: string,
    ): Promise<void> => {
        assert(
            result.interrupted,
            `reported interrupted: false for a body that never reached its end after ${what}; ` +
                "the caller reads that as a finished body and publishes a short object",
        );
        assert(
            result.bytesWritten <= delivered,
            `claims ${result.bytesWritten} durable bytes of the ${delivered} delivered before ${what}`,
        );
        const state = await store.getUploadState(uploadToken);
        assert(
            state.offset === result.bytesWritten,
            `getUploadState reports ${state.offset} against the ${result.bytesWritten} the interrupted ` +
                "append accounted for; the client resumes from the state read",
        );
    };
    const yieldWasRaised = (err: unknown, what: string): string =>
        `raised ${errName(err)} for ${what}; a yield is REPORTED, ` +
        "so a caller never has to classify an exception to tell one from a failure";

    await record(
        "torn-body-reports-interrupted",
        "a body that fails mid-transfer is reported as interrupted with the flushed prefix, not raised",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            const head = bytes("FIRST-HALF");
            let result: AppendChunkResult | undefined;
            const thrownWhileReading = await raisedBy(async () => {
                result = await store.appendChunk(uploadToken, 0, streamTearingAfterFirstChunk(head), {
                    now: now(),
                });
            });
            assert(result !== undefined, yieldWasRaised(thrownWhileReading, "a torn body"));
            await yieldedAppend(assert, uploadToken, result, head.byteLength, "the body tore");
        },
    );

    await record(
        "mid-read-abort-reports-interrupted",
        "a signal firing mid-read stops the read, is reported not raised, and leaves a durable offset",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            const piece = bytes("0123");
            const pieces = [piece, piece, piece, piece, piece];
            const total = piece.byteLength * pieces.length;
            const preempt = new AbortController();
            const body = streamYieldingAfterFirstChunk(pieces, () => preempt.abort());
            let result: AppendChunkResult | undefined;
            const thrownWhileReading = await raisedBy(async () => {
                result = await store.appendChunk(uploadToken, 0, body, {
                    now: now(),
                    signal: preempt.signal,
                });
            });
            assert(result !== undefined, yieldWasRaised(thrownWhileReading, "a signal that fired mid-read"));
            await yieldedAppend(assert, uploadToken, result, total, "the signal fired");
            assert(
                result.bytesWritten < total,
                `made all ${total} bytes durable after the signal fired; the signal is tested at each ` +
                    "chunk boundary, which is what bounds a preempted holder's writes",
            );
        },
    );

    await record(
        "request-ceiling-stops-a-stream",
        "a non-fatal bound stops a chunked body at the ceiling and leaves the upload resumable",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            const piece = bytes("0123");
            const pieces = [piece, piece, piece, piece, piece];
            const total = piece.byteLength * pieces.length;
            const ceiling = 6;
            const thrownAtCeiling = await raisedBy(() =>
                store.appendChunk(uploadToken, 0, streamOf(pieces), {
                    maxBytes: ceiling,
                    maxBytesFatal: false,
                    now: now(),
                }),
            );
            const state = await store.getUploadState(uploadToken);
            assert(
                thrownAtCeiling !== undefined,
                `returned normally for a ${total}-byte chunked body under a ${ceiling}-byte ceiling, ` +
                    `with ${state.offset} bytes durable; a buffer body is bounded by one slice, so only a ` +
                    "stream exercises the stopping logic",
            );
            assert(
                isUploadAppendBoundError(thrownAtCeiling),
                `threw ${errName(thrownAtCeiling)}, expected UploadAppendBoundError`,
            );
            assert(
                state.status !== "invalidated",
                "invalidated the upload over a per-request ceiling; " +
                    "the representation was untouched, so this turns a resumable situation into a lost one",
            );
            assert(
                state.offset <= ceiling,
                `offset ${state.offset} exceeds the ${ceiling}-byte ceiling the stream was told to stop at`,
            );
            const resumed = await store.appendChunk(uploadToken, state.offset, piece, { now: now() });
            assert(
                resumed.bytesWritten === piece.byteLength,
                "could not resume from the offset the stopped stream reported",
            );
        },
    );

    // ── Token quality ─────────────────────────────────────────────────────────
    await record(
        "token-is-unguessable",
        "tokens must come from a CSPRNG: possession alone authorizes append, probe and cancel",
        async (assert: ConformanceAssert) => {
            const minted: string[] = [];
            for (let i = 0; i < TOKEN_SAMPLES; i++) {
                const objectKey = nextKey();
                const { uploadToken } = await store.createUpload({ key: objectKey, now: now() });
                // The key is looked for in the token and in every segment of it read
                // as percent-encoding or base64 (either alphabet), however it was folded in.
                for (const form of [uploadToken, percentDecoded(uploadToken), ...uploadToken.split(/[^\w+/-]+/)]) {
                    let decoded = "";
                    try {
                        decoded = atob(form.replace(/-/g, "+").replace(/_/g, "/"));
                    } catch {
                        // Not base64: the form itself is what gets searched.
                    }
                    assert(!(form + decoded).includes(objectKey), "token must encode nothing, not even its object key");
                }
                assert(!minted.includes(uploadToken), "createUpload returned a duplicate token");
                minted.push(uploadToken);
                assert(
                    uploadToken.length >= MIN_TOKEN_ENTROPY_CHARS,
                    `token is ${uploadToken.length} chars, too short to be unguessable`,
                );
            }
            // Sequential tokens ascend from one mint to the next. A counter or a
            // timestamp prefix shows up here and nowhere else, and it is a property
            // of the sequence rather than a verdict on one observation: random
            // tokens ascend on about half their pairs, so a threshold separates the
            // two without failing an unlucky but honest CSPRNG.
            const ascending = minted.filter((t, i) => i > 0 && minted[i - 1]! < t).length;
            assert(
                ascending < ORDERED_PAIR_THRESHOLD,
                `${ascending} of ${TOKEN_SAMPLES - 1} consecutive tokens ascend, which is ordering ` +
                    "rather than chance: the token looks minted from a counter or a timestamp, and a " +
                    "neighbour's upload is then reachable by guessing",
            );
        },
    );

    // ── Offset derivation ─────────────────────────────────────────────────────
    await record(
        "offset-starts-at-zero",
        "a fresh upload reports offset 0, is neither complete nor invalidated, and echoes createdAt",
        async (assert: ConformanceAssert) => {
            const created = now();
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: created });
            const state = await store.getUploadState(uploadToken);
            assert(state.offset === 0, `offset ${state.offset}, expected 0`);
            assert(state.status === "incomplete", `status ${state.status} before any append, expected "incomplete"`);
            assert(state.createdAt === created, `createdAt ${state.createdAt}, expected the injected ${created}`);
        },
    );

    await record(
        "state-reports-the-recorded-expiry",
        "an upload created with expiresAt reports that instant on every state read, before and after an append",
        async (assert: ConformanceAssert) => {
            const created = now();
            const expiresAt = created + 86_400_000;
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: created, expiresAt });
            const before = await store.getUploadState(uploadToken);
            await store.appendChunk(uploadToken, 0, bytes("abc"), { now: now() });
            const after = await store.getUploadState(uploadToken);
            for (const [when, state] of [
                ["before an append", before],
                ["after an append", after],
            ] as const) {
                assert(
                    state.expiresAt === expiresAt,
                    `expiresAt ${state.expiresAt} ${when}, expected the recorded ${expiresAt}; without it every ` +
                        "request judges expiry by its own policy, so a shorter one retroactively expires the upload",
                );
            }
        },
    );

    await record(
        "offset-agrees-after-clean-append",
        "after a clean append, getUploadState must agree with the offset plus bytesWritten",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            const { bytesWritten, interrupted } = await store.appendChunk(uploadToken, 0, bytes("0123456789"), {
                now: now(),
            });
            assert(bytesWritten === 10, `bytesWritten ${bytesWritten}, expected 10`);
            assert(
                !interrupted,
                "reported interrupted after reading the whole body; " +
                    "a caller reads that as a yield and refuses to complete an upload that is in fact finished",
            );
            const state = await store.getUploadState(uploadToken);
            assert(
                state.offset === 10,
                `getUploadState reports ${state.offset} after a clean 10-byte append; ` +
                    "the two must agree or a client resumes at an offset the store disputes",
            );
        },
    );

    const BACKEND_DERIVED_OBLIGATION =
        "the offset must come from durable backend state, so a fresh instance derives the same one";
    if (restartable) {
        await record("offset-is-backend-derived", BACKEND_DERIVED_OBLIGATION, async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            await store.appendChunk(uploadToken, 0, bytes("abcdef"), { now: now() });
            const restarted = await makeStore();
            const state = await restarted.getUploadState(uploadToken);
            assert(
                state.offset === 6,
                `a fresh instance reports ${state.offset}, expected 6; ` +
                    "an offset held in process memory is lost on restart and the upload cannot resume",
            );
        });
    } else {
        skip("offset-is-backend-derived", BACKEND_DERIVED_OBLIGATION, NOT_RESTARTABLE);
    }

    // ── The offset check the capability flag stands for ───────────────────────
    await record(
        "refuses-stale-offset",
        "appendChunk must throw UploadOffsetConflictError when the claimed offset is behind durable state",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            await store.appendChunk(uploadToken, 0, bytes("0123456789"), { now: now() });
            // The stolen-lock case: a holder that stalled past its TTL comes back
            // and replays an append the current holder has already moved past.
            const conflict = await raisedBy(() => store.appendChunk(uploadToken, 4, bytes("XXXX"), { now: now() }));
            assert(
                conflict !== undefined,
                "accepted a write at offset 4 when durable state was 10; " +
                    "enforcesOffsetCheck is declared but not implemented, so a stalled writer interleaves silently",
            );
            assert(
                isUploadOffsetConflictError(conflict),
                `threw ${errName(conflict)}, expected UploadOffsetConflictError`,
            );
            assert(
                conflict.durableOffset === 10,
                `conflict carried durableOffset ${conflict.durableOffset}, expected 10; ` +
                    "the client retries against this number, so a wrong one sends it to the wrong place",
            );
        },
    );

    await record(
        "refuses-future-offset",
        "appendChunk must refuse an offset ahead of durable state rather than leaving a hole",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            const conflict = await raisedBy(() => store.appendChunk(uploadToken, 64, bytes("XXXX"), { now: now() }));
            assert(
                conflict !== undefined,
                "accepted a write at offset 64 on an empty upload, which leaves unwritten bytes in the object",
            );
            assert(
                isUploadOffsetConflictError(conflict),
                `threw ${errName(conflict)}, expected UploadOffsetConflictError`,
            );
        },
    );

    // ── The two bounds, which mean opposite things ────────────────────────────
    await record(
        "request-ceiling-keeps-the-resource",
        "a non-fatal bound stops at maxBytes, keeps the prefix durable, and leaves the upload healthy",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            const thrownAtCeiling = await raisedBy(() =>
                store.appendChunk(uploadToken, 0, bytes("0123456789"), {
                    maxBytes: 4,
                    maxBytesFatal: false,
                    now: now(),
                }),
            );
            assert(thrownAtCeiling !== undefined, "accepted a body past the request ceiling without reporting it");
            assert(
                isUploadAppendBoundError(thrownAtCeiling),
                `threw ${errName(thrownAtCeiling)}, expected UploadAppendBoundError`,
            );
            const state = await store.getUploadState(uploadToken);
            assert(
                state.status !== "invalidated",
                "invalidated the upload over a per-request ceiling; " +
                    "the representation was untouched, so this turns a resumable situation into a lost one",
            );
            // A ceiling, not a target: a part-based backend lands on the last
            // boundary at or below it. What must hold is that the reported offset
            // is durable and never past the bound.
            assert(state.offset <= 4, `offset ${state.offset} exceeds the 4-byte ceiling it was told to stop at`);
            // The client's whole recovery is resuming from here in smaller chunks.
            const resumed = await store.appendChunk(uploadToken, state.offset, bytes("45"), { now: now() });
            assert(resumed.bytesWritten === 2, "could not resume from the reported offset");
        },
    );

    await record(
        "representation-bound-invalidates",
        "a fatal bound must invalidate durably and throw UploadOverrunError",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            const thrownAtBound = await raisedBy(() =>
                store.appendChunk(uploadToken, 0, bytes("0123456789"), {
                    maxBytes: 4,
                    maxBytesFatal: true,
                    now: now(),
                }),
            );
            assert(
                thrownAtBound !== undefined,
                "returned normally after the body crossed a representation bound; " +
                    "the caller is told the append succeeded and hands the client an offset it cannot build on",
            );
            assert(isUploadOverrunError(thrownAtBound), `threw ${errName(thrownAtBound)}, expected UploadOverrunError`);
            // The invalidation must be visible to a process that never saw the
            // append which caused it, so read it back from a fresh instance where
            // the store claims to be durable across them.
            const reader = restartable ? await makeStore() : store;
            const state = await reader.getUploadState(uploadToken);
            assert(
                state.status === "invalidated",
                restartable
                    ? "a fresh instance does not see the invalidation; " +
                          "it must be durable, or a process that never saw this append accepts more bytes"
                    : "the upload is not marked invalidated after a representation bound was crossed",
            );
        },
    );

    // ── Completion and its terminal effects ───────────────────────────────────
    await record(
        "completion-publishes-and-closes",
        "completeUpload publishes, and the upload refuses further appends afterwards",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            await store.appendChunk(uploadToken, 0, bytes("payload"), { now: now() });
            await store.completeUpload(uploadToken, { expectedLength: bytes("payload").byteLength, now: now() });
            const state = await store.getUploadState(uploadToken);
            assert(
                state.status === "complete",
                "getUploadState does not report the upload complete after completeUpload",
            );
            const refusal = await raisedBy(() => store.appendChunk(uploadToken, 7, bytes("more"), { now: now() }));
            assert(
                refusal !== undefined,
                "accepted an append after completion, which mutates an object readers can already see",
            );
        },
    );

    // ── The sealed plan ───────────────────────────────────────────────────────
    //
    // Completion seals at the length the caller acknowledged, and an append after
    // the seal is refused. A third obligation, that a destination written between
    // the seal and the publish raises UploadDestinationConflictError and survives,
    // is not certified here: the harness has no write handle on the destination
    // (`readObject` only reads), and a write it made before calling completeUpload
    // lands BEFORE the seal, where the contract makes it the state publication is
    // allowed to replace. Only a store's own suite can land a write inside its
    // seal-to-publish window.
    const checkTheSealedPlan = async (): Promise<void> => {
        await record(
            "completion-refuses-an-unacknowledged-length",
            "completeUpload at any length but the assembled one throws UploadOffsetConflictError carrying the " +
                "assembled length, publishes nothing, and leaves the upload resumable",
            async (assert: ConformanceAssert) => {
                const objectKey = nextKey();
                const payload = bytes("0123456789");
                const { uploadToken } = await store.createUpload({ key: objectKey, now: now() });
                await store.appendChunk(uploadToken, 0, payload, { now: now() });
                // Shorter is the dangerous direction: a completer whose view predates an
                // acknowledged append would publish without it.
                const refused = await raisedBy(() =>
                    store.completeUpload(uploadToken, { expectedLength: payload.byteLength - 1, now: now() }),
                );
                assert(
                    refused !== undefined,
                    "published at a length the caller never acknowledged; a completer with a stale view " +
                        "silently drops bytes a client was told are durable",
                );
                assert(
                    isUploadOffsetConflictError(refused),
                    `threw ${errName(refused)}, expected UploadOffsetConflictError`,
                );
                assert(
                    refused.durableOffset === payload.byteLength,
                    `the conflict carries ${refused.durableOffset}, but the assembly holds ${payload.byteLength}; ` +
                        "the client re-anchors at the length it is handed",
                );
                if (readObject !== undefined) {
                    const published = await readObject(objectKey);
                    assert(
                        published === undefined,
                        `${published?.byteLength} bytes are readable at the destination key after a refused completion`,
                    );
                }
                const state = await store.getUploadState(uploadToken);
                assert(state.status !== "complete", "reports the upload complete after a refused completion");
                // The seal is lifted on the way out, or the client can never finish.
                const tail = bytes("+");
                await store.appendChunk(uploadToken, payload.byteLength, tail, { now: now() });
                await store.completeUpload(uploadToken, {
                    expectedLength: payload.byteLength + tail.byteLength,
                    now: now(),
                });
                const after = await store.getUploadState(uploadToken);
                assert(
                    after.status === "complete",
                    "an append and a completion at the corrected length did not complete the upload",
                );
            },
        );

        const LATE_APPEND_OBLIGATION =
            "an append after completion is refused and changes neither the offset nor the published bytes";
        if (readObject !== undefined) {
            await record(
                "late-append-leaves-the-published-object-alone",
                LATE_APPEND_OBLIGATION,
                async (assert: ConformanceAssert) => {
                    const objectKey = nextKey();
                    const payload = bytes("sealed-and-published");
                    const { uploadToken } = await store.createUpload({ key: objectKey, now: now() });
                    await store.appendChunk(uploadToken, 0, payload, { now: now() });
                    await store.completeUpload(uploadToken, { expectedLength: payload.byteLength, now: now() });
                    const late = await raisedBy(() =>
                        store.appendChunk(uploadToken, payload.byteLength, bytes("LATE"), { now: now() }),
                    );
                    // Which error is the store's choice: a terminal resource's refusal is
                    // a guard no dialect maps. That it is refused, and harmlessly, is not.
                    assert(
                        late !== undefined,
                        "acknowledged an append after completion; the client believes bytes are durable " +
                            "that no published object holds",
                    );
                    const state = await store.getUploadState(uploadToken);
                    assert(
                        state.offset === payload.byteLength,
                        `offset moved to ${state.offset} after a refused late append, expected ${payload.byteLength}`,
                    );
                    const published = await readObject(objectKey);
                    assert(published !== undefined, "completion left the destination key empty");
                    assert(
                        sameBytes(published, payload),
                        `the destination key holds ${published.byteLength} bytes after a refused late append, ` +
                            `expected the ${payload.byteLength} completion published`,
                    );
                },
            );
        } else {
            skip("late-append-leaves-the-published-object-alone", LATE_APPEND_OBLIGATION, NO_READ_BACK);
        }
    };
    await checkTheSealedPlan();

    await record(
        "abort-is-idempotent",
        "abortUpload must tolerate being called twice: a retried cancel is a normal thing to receive",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            await store.appendChunk(uploadToken, 0, bytes("discard me"), { now: now() });
            await store.abortUpload(uploadToken);
            const thrownOnRetry = await raisedBy(() => store.abortUpload(uploadToken));
            assert(
                thrownOnRetry === undefined,
                `the second abortUpload raised ${errName(thrownOnRetry)}; a cancel whose response is lost ` +
                    "is sent again, and arrives for an upload the store has already discarded",
            );
        },
    );

    const ABORT_SPARES_OBLIGATION = "abortUpload must never destroy an object completion already published";
    if (readObject !== undefined) {
        await record("abort-spares-a-published-object", ABORT_SPARES_OBLIGATION, async (assert: ConformanceAssert) => {
            const objectKey = nextKey();
            const payload = bytes("published");
            const { uploadToken } = await store.createUpload({ key: objectKey, now: now() });
            await store.appendChunk(uploadToken, 0, payload, { now: now() });
            await store.completeUpload(uploadToken, { expectedLength: payload.byteLength, now: now() });
            assert(
                (await readObject(objectKey)) !== undefined,
                "completion published nothing at the destination key, so the abort below proves nothing",
            );
            await store.abortUpload(uploadToken);
            const survivor = await readObject(objectKey);
            // Aborting a completed resource is ordinary traffic, not a corner: an
            // upload past its maximum age answers gone whether or not it finished,
            // and the caller discards the resource on the spot.
            assert(
                survivor !== undefined,
                "abortUpload deleted the object the completion published; a cancel terminates the " +
                    "UPLOAD and never its result, so this destroys live data on a routine probe",
            );
            assert(
                sameBytes(survivor, payload),
                "the object at the destination key changed across an abort of the upload that produced it, " +
                    `now ${survivor.byteLength} bytes`,
            );
        });
    } else {
        skip("abort-spares-a-published-object", ABORT_SPARES_OBLIGATION, NO_READ_BACK);
    }

    await record(
        "invalidated-upload-is-still-cancellable",
        "a dead upload must remain discardable, or its bytes are stranded until a sweep that may never run",
        async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            // The throw is expected; `representation-bound-invalidates` covers what it must be.
            await raisedBy(() =>
                store.appendChunk(uploadToken, 0, bytes("0123456789"), {
                    maxBytes: 4,
                    maxBytesFatal: true,
                    now: now(),
                }),
            );
            const thrownOnAbort = await raisedBy(() => store.abortUpload(uploadToken));
            assert(
                thrownOnAbort === undefined,
                `abortUpload raised ${errName(thrownOnAbort)} for an invalidated upload, so the bytes it ` +
                    "staged are unreachable and undeletable",
            );
        },
    );

    // ── Deferred length ───────────────────────────────────────────────────────
    const DEFERRED_LENGTH_OBLIGATION = "a length first declared on an append must be persisted and then immutable";
    if (restartable) {
        await record("records-a-deferred-length", DEFERRED_LENGTH_OBLIGATION, async (assert: ConformanceAssert) => {
            const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
            await store.appendChunk(uploadToken, 0, bytes("hello"), { length: 5, now: now() });
            const restarted = await makeStore();
            const state = await restarted.getUploadState(uploadToken);
            assert(
                state.length === 5,
                `a fresh instance reports length ${state.length}, expected 5; ` +
                    "an unrecorded length strands the upload just as its absence would",
            );
        });
    } else {
        skip("records-a-deferred-length", DEFERRED_LENGTH_OBLIGATION, NOT_RESTARTABLE);
    }

    // ── Sweep ─────────────────────────────────────────────────────────────────
    const SWEEP_OBLIGATION =
        "a reaped resource stays gone: an append in flight across the sweep must not write it back";
    if (store.sweepExpired === undefined) {
        skip("swept-resource-is-not-resurrected", SWEEP_OBLIGATION, "the store implements no sweepExpired");
    } else {
        const sweepExpired = store.sweepExpired.bind(store);
        await record("swept-resource-is-not-resurrected", SWEEP_OBLIGATION, async (assert: ConformanceAssert) => {
            // The sweep runs without the upload's lock, so it can condemn a
            // resource whose append is mid-body. That append's closing
            // bookkeeping write is the resurrection: a store that writes its own
            // snapshot back recreates a resource the reap already ended, with
            // bytes the client will never be told were lost.
            const objectKey = nextKey();
            const { uploadToken } = await store.createUpload({ key: objectKey, now: now() });
            await store.appendChunk(uploadToken, 0, bytes("abc"), { now: now() });
            const { body, pulled, release } = parkedBody(bytes("def"));
            const append = store.appendChunk(uploadToken, 3, body, { now: now() }).then(
                () => undefined,
                (err: unknown) => err,
            );
            await pulled;
            // Every resource this run created was created at the injected
            // instant, so a lifetime cutoff one past it condemns exactly them.
            const swept = await sweepExpired({ createdBeforeMs: now() + 1 });
            assert(swept.removed >= 1, `the sweep reaped ${swept.removed} resources with ${swept.failed} failures`);
            release();
            await append;
            const thrownAfterSweep = await raisedBy(() => store.getUploadState(uploadToken));
            assert(
                thrownAfterSweep !== undefined && isUploadNotFoundError(thrownAfterSweep),
                thrownAfterSweep === undefined
                    ? "the resource answers a state after the sweep reaped it; the in-flight append wrote it back"
                    : `raised ${errName(thrownAfterSweep)} for a swept resource, expected UploadNotFoundError`,
            );
            if (readObject !== undefined) {
                assert(
                    (await readObject(objectKey)) === undefined,
                    "the destination key holds bytes after a sweep, without a completion",
                );
            }
        });
    }

    return tallyConformance(checks);
}

/**
 * Render a report as plain lines, for a CI log or a startup self-test.
 * Returns the text; it prints nothing itself, so the caller chooses the sink.
 */
export function formatConformanceReport(report: ConformanceReport): string {
    const lines = report.checks.map((c) => {
        const mark = c.skipped ? "SKIP" : c.ok ? "PASS" : "FAIL";
        const detail = c.detail === undefined ? "" : `\n       ${c.detail}`;
        return `${mark}  ${c.name}${detail}`;
    });
    lines.push(`\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
    return lines.join("\n");
}

// ─── Read side ──────────────────────────────────────────────────────────────

export interface ObjectStoreConformanceOptions {
    /**
     * A key the store already serves, and the exact bytes behind it. The harness
     * only reads: it never creates or deletes, because an {@link ObjectStore} has
     * no vocabulary for either and a read store may front something immutable.
     */
    key: string;
    /** The object's exact content, which every assertion is measured against. */
    content: Uint8Array<ArrayBuffer>;
    /** A key the store must NOT serve. @default the served key plus a suffix */
    missingKey?: string;
}

const RANGE_WINDOW_OBLIGATION = "a ranged read returns exactly the requested bytes";
const RANGE_TOTAL_OBLIGATION =
    "a ranged read reports the whole representation's size, or undefined when it cannot know";

/**
 * Run the read contract against an {@link ObjectStore}.
 *
 * The serving path asks a store for two things a custom implementation
 * routinely gets subtly wrong: an honest total size on a partial read, and a
 * not-found that is distinguishable from a failure. Both are invisible in the
 * happy path and both corrupt a client when wrong, one by handing it a
 * `Content-Range` it cannot reassemble against, the other by turning a missing
 * object into a 502 that a caching layer will happily retry forever.
 *
 * Read-only and side-effect free, so it is safe to point at a staging bucket
 * that already holds the object.
 */
export async function checkObjectStore(
    store: ObjectStore,
    opts: ObjectStoreConformanceOptions,
): Promise<ConformanceReport> {
    const { key, content } = opts;
    const missingKey = opts.missingKey ?? `${key}.partial-content-conformance-missing`;
    const checks: ConformanceCheck[] = [];

    const record = recorder(checks);
    const skip = skipper(checks);

    const readBody = async (stream: ObjectStream): Promise<Uint8Array<ArrayBuffer>> => {
        if (stream.body instanceof Uint8Array) return stream.body;
        const reader = stream.body.getReader();
        const parts: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                parts.push(value);
                total += value.byteLength;
            }
        }
        const out = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
            out.set(p, at);
            at += p.byteLength;
        }
        return out;
    };

    await record(
        "head-reports-the-true-length",
        "headObject must report the object's exact byte length",
        async (assert: ConformanceAssert) => {
            const meta = await store.headObject(key);
            assert(
                meta.contentLength === content.byteLength,
                `contentLength ${meta.contentLength}, expected ${content.byteLength}; ` +
                    "a wrong length is a Content-Length the client counts bytes against",
            );
        },
    );

    await record(
        "full-read-returns-every-byte",
        "getObject with no range returns the whole representation and its total size",
        async (assert: ConformanceAssert) => {
            const stream = await store.getObject(key);
            const body = await readBody(stream);
            assert(
                sameBytes(body, content),
                `read ${body.byteLength} bytes, expected ${content.byteLength} and byte-identical`,
            );
            assert(
                stream.contentLength === content.byteLength,
                `contentLength ${stream.contentLength}, expected ${content.byteLength}`,
            );
        },
    );

    await record(
        "missing-object-is-not-found",
        "an absent key must throw ObjectNotFoundError, distinguishably from a failure",
        async (assert: ConformanceAssert) => {
            const refusal = await raisedBy(() => store.headObject(missingKey));
            assert(refusal !== undefined, "resolved for a key that should not exist");
            assert(
                isObjectNotFoundError(refusal),
                `threw ${errName(refusal)}; ` +
                    "anything else is answered as a backend failure, so a missing object becomes a 502",
            );
        },
    );

    await record(
        "missing-object-is-not-found-on-read",
        "getObject on an absent key, whole or ranged, must throw ObjectNotFoundError, since a plain GET reads with no HEAD first",
        async (assert: ConformanceAssert) => {
            const reads: [label: string, opts: Parameters<ObjectStore["getObject"]>[1]][] = [["whole", undefined]];
            // A store declaring no range support is never asked for a window.
            if (store.supportsRange !== false) reads.push(["ranged", { range: { start: 0, end: 0 } }]);
            for (const [label, readOpts] of reads) {
                const refusal = await raisedBy(() => store.getObject(missingKey, readOpts));
                assert(refusal !== undefined, `a ${label} read resolved for a key that should not exist`);
                assert(
                    isObjectNotFoundError(refusal),
                    `a ${label} read threw ${errName(refusal)}; ` +
                        "anything else is a backend failure on the read path, so a missing object becomes a 502",
                );
            }
        },
    );

    const skipBothRangeChecks = (why: string): void => {
        skip("range-serves-the-requested-window", RANGE_WINDOW_OBLIGATION, why);
        skip("range-reports-an-honest-total", RANGE_TOTAL_OBLIGATION, why);
    };

    if (store.supportsRange === false) {
        skipBothRangeChecks("supportsRange: false, so the serving path never asks this store for a window");
    } else if (content.byteLength < 4) {
        skipBothRangeChecks("the sample object is too short to slice a meaningful window from");
    } else {
        const start = 1;
        const end = content.byteLength - 2;
        const expected = content.subarray(start, end + 1);

        await record(
            "range-serves-the-requested-window",
            RANGE_WINDOW_OBLIGATION,
            async (assert: ConformanceAssert) => {
                const stream = await store.getObject(key, { range: { start, end } });
                const body = await readBody(stream);
                assert(
                    sameBytes(body, expected),
                    `bytes ${start}-${end} came back as ${body.byteLength} bytes and did not match; ` +
                        "a window that is off by one hands the client bytes it cannot reassemble",
                );
                assert(
                    stream.contentLength === expected.byteLength,
                    `contentLength ${stream.contentLength}, expected ${expected.byteLength} for the window`,
                );
            },
        );

        await record("range-reports-an-honest-total", RANGE_TOTAL_OBLIGATION, async (assert: ConformanceAssert) => {
            const stream = await store.getObject(key, { range: { start, end } });
            await readBody(stream);
            // Reporting no total is allowed: the obligation is on what a reported
            // one means, so the observation is made either way rather than the
            // check returning early with nothing looked at.
            assert(
                stream.totalSize === undefined || stream.totalSize === content.byteLength,
                `totalSize ${stream.totalSize} on a partial read, expected ${content.byteLength} ` +
                    "or undefined; this number becomes the Content-Range total the client sizes against",
            );
        });
    }

    await record(
        "digest-is-the-whole-representation",
        "any digest reported is the raw base64 SHA-256 of the whole object, never of a window",
        async (assert: ConformanceAssert) => {
            const { digest } = await store.headObject(key);
            // A store reporting no digest asserts nothing about one, and that is
            // conformant. Both observations are still made, so the check never
            // reports a pass it did not look for.
            assert(
                digest === undefined || isSha256Base64(digest),
                `digest ${JSON.stringify(digest)} is not the raw base64 of a 32-byte SHA-256; ` +
                    "a malformed value framed as a digest is a false integrity assertion",
            );
            assert(
                digest === undefined || digest === (await sha256Base64(content)),
                "digest does not match the object's own bytes",
            );
        },
    );

    return tallyConformance(checks);
}
