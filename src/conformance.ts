/**
 * Conformance harness for the read contract.
 *
 * {@link checkObjectStore} checks a custom {@link ObjectStore} against what the
 * serving path assumes, where the two things a custom store most often gets
 * subtly wrong are an honest total size on a partial read and a not-found that
 * is distinguishable from a failure. Both are invisible in the happy path: a
 * wrong total becomes the `Content-Range` total a client sizes its remaining
 * requests against, and an indistinguishable not-found turns a missing object
 * into a backend error a caching layer will retry. It only reads, so it is safe
 * against a staging bucket that already holds the object.
 *
 * It needs no test framework: every check is a plain async function over the
 * store's own public surface, so it runs under any runner, in CI, or as a
 * startup self-test.
 *
 * A check reports through the {@link ConformanceAssert} it is handed and
 * through nothing else, and a body that never calls it FAILS. A harness invents
 * no verdict it did not observe: a body that looks at nothing has nothing to
 * report, and the one thing worse than a missing check is a green one.
 *
 * @example
 * ```typescript
 * import { checkObjectStore, formatConformanceReport } from "partial-content/conformance";
 *
 * const report = await checkObjectStore(store, { key: "fixtures/known.bin", content: knownBytes });
 * if (!report.ok) throw new Error(formatConformanceReport(report));
 * ```
 *
 * @packageDocumentation
 */

import {
    isObjectChangedError,
    isObjectNotFoundError,
    representationCoding,
    type GetObjectOptions,
    type HeadObjectOptions,
    type ObjectStore,
    type ObjectStream,
} from "./object-store.ts";
import { isSha256Base64 } from "./kernel.ts";
import { bytesToBase64 } from "./base64.ts";

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

/** What a call did: threw `error`, or returned `value`. */
type Outcome = { raised: true; error: unknown } | { raised: false; value: unknown };

/**
 * What a call raised, or the value it returned. A resolved value is handed
 * back rather than dropped so a check that expected a refusal can release what
 * the store opened before it fails.
 */
const raisedBy = async (call: () => Promise<unknown>): Promise<Outcome> => {
    try {
        return { raised: false, value: await call() };
    } catch (error) {
        return { raised: true, error };
    }
};

/** Cancel the body of a stray read, so a store that handed one out is not also leaked by the harness. */
const releaseStray = (value: unknown): void => {
    const body = (value as { body?: unknown } | null | undefined)?.body;
    if (body instanceof ReadableStream) body.cancel().catch(() => undefined);
};

/** Default per-check deadline, in milliseconds. */
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/**
 * Run `run` against a deadline. A store whose promise never settles, or whose
 * body never ends, fails the check instead of hanging the run; the timer is
 * always cleared.
 *
 * `run` gets a view of `store` whose calls carry the deadline's abort signal,
 * so a store that honors a signal stops working for an abandoned check. A body
 * a call opens is read through a relay the signal also cancels, and one that
 * arrives after the deadline is cancelled unread, so nothing a timed-out check
 * started stays open.
 */
async function settlesWithin<T>(
    timeoutMs: number,
    store: ObjectStore,
    run: (store: ObjectStore) => Promise<T>,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Unmet(`did not settle within ${timeoutMs} ms; a call or a body that never ends`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([run(withSignal(store, controller.signal)), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * `store` with `signal` on every call. Other members read through to `store`
 * itself: a check only calls the two read methods.
 */
function withSignal(store: ObjectStore, signal: AbortSignal): ObjectStore {
    return Object.create(store, {
        headObject: { value: (key: string, opts?: HeadObjectOptions) => store.headObject(key, { ...opts, signal }) },
        getObject: {
            value: async (key: string, opts?: GetObjectOptions) => {
                const read = await store.getObject(key, { ...opts, signal });
                if (!(read.body instanceof ReadableStream)) return read;
                if (signal.aborted) {
                    releaseStray(read);
                    return read;
                }
                return { ...read, body: relayUntilAborted(read.body, signal) };
            },
        },
    }) as ObjectStore;
}

/** A stream that reads from `source` and ends it when `signal` aborts, whoever holds the reader. */
function relayUntilAborted(
    source: ReadableStream<Uint8Array<ArrayBuffer>>,
    signal: AbortSignal,
): ReadableStream<Uint8Array<ArrayBuffer>> {
    const reader = source.getReader();
    const stop = (): void => {
        reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", stop, { once: true });
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

/** Whether a reported coding is already in the form {@link representationCoding} writes. */
const isNormalizedCoding = (value: string): boolean => {
    try {
        return representationCoding(value) === value;
    } catch {
        return false;
    }
};

/** Name whatever came out of {@link raisedBy}, error or not. */
const errName = (err: unknown): string => (err instanceof Error ? err.name : String(err));

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
    /**
     * How long one check may run before it fails as "did not settle". A store
     * whose call or body never ends would otherwise hang the run, startup
     * self-tests included.
     * @default 10000
     */
    timeoutMs?: number;
}

const PIN_PROBE = "a read pinned to a validator the object does not carry is refused, or names what it served";

/** Whether a read could be mistaken for the HEAD's representation: the store claims pins, or the HEAD names one. */
const pinProbeApplies = (store: ObjectStore, head: { etag?: string; lastModified?: string } | undefined): boolean =>
    store.pinsReads === true || !!head?.etag || !!head?.lastModified;

/**
 * Read with an ifMatch the object cannot carry. A store that enforces the pin
 * throws ObjectChangedError; one that cannot must still name the
 * representation it served, or the serving path emits the HEAD's ETag and
 * digest over whatever bytes came back.
 */
async function assertMismatchedPinHandled(store: ObjectStore, key: string, assert: ConformanceAssert): Promise<void> {
    const outcome = await raisedBy(() => store.getObject(key, { ifMatch: '"partial-content-conformance-mismatch"' }));
    if (outcome.raised) {
        assert(
            isObjectChangedError(outcome.error),
            `a mismatching ifMatch threw ${errName(outcome.error)}; ` +
                "a store that enforces the pin reports a changed object as ObjectChangedError, which the serving path re-validates on",
        );
        return;
    }
    releaseStray(outcome.value);
    const read = outcome.value as ObjectStream;
    assert(
        store.pinsReads !== true,
        "pinsReads is declared but a read pinned to a mismatching ifMatch was served; " +
            "the serving path would emit the HEAD's ETag and digest over bytes it never checked",
    );
    assert(
        !!read.etag || !!read.lastModified,
        "this store neither pins a read nor names the representation it served; " +
            "the HEAD's ETag and digest would be emitted over whatever bytes the read returned",
    );
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
    subject: ObjectStore,
    opts: ObjectStoreConformanceOptions,
): Promise<ConformanceReport> {
    const { key, content } = opts;
    const missingKey = opts.missingKey ?? `${key}.partial-content-conformance-missing`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    const checks: ConformanceCheck[] = [];

    const recordUnbounded = recorder(checks);
    const record = (
        name: string,
        obligation: string,
        run: (assert: ConformanceAssert, store: ObjectStore) => Promise<void>,
    ) =>
        recordUnbounded(name, obligation, (assert) => settlesWithin(timeoutMs, subject, (store) => run(assert, store)));
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
        async (assert: ConformanceAssert, store: ObjectStore) => {
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
        async (assert: ConformanceAssert, store: ObjectStore) => {
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
            assert(
                stream.totalSize === content.byteLength,
                `totalSize ${stream.totalSize} on a full read, expected ${content.byteLength}; ` +
                    "a full read that reports no total cannot be framed, so every plain GET is answered 502",
            );
            assert(
                stream.range === undefined,
                `a full read reported the served range ${stream.range?.start}-${stream.range?.end}; ` +
                    "only a ranged read has one, and a range here turns a plain GET into a 206",
            );
        },
    );

    await record(
        "get-validators-agree-with-head",
        "the validators a read reports name the same representation as the HEAD's",
        async (assert: ConformanceAssert, store: ObjectStore) => {
            const meta = await store.headObject(key);
            const stream = await store.getObject(key);
            await readBody(stream);
            assert(
                !(meta.etag && stream.etag) || meta.etag === stream.etag,
                `HEAD etag ${meta.etag} but GET etag ${stream.etag}; ` +
                    "the serving path reads the two as a changed object and re-validates every conditional request",
            );
            assert(
                !(meta.lastModified && stream.lastModified) || meta.lastModified === stream.lastModified,
                `HEAD lastModified ${meta.lastModified} but GET lastModified ${stream.lastModified}; ` +
                    "spell one instant one way, or every If-Range request is answered as a changed object",
            );
            // The HEAD's coding decides the HEAD response and whether a multi-range
            // request is served whole; the GET's decides the header on the body. A
            // store that fills one side serves encoded bytes with no Content-Encoding.
            assert(
                meta.contentEncoding === stream.contentEncoding,
                `HEAD contentEncoding ${JSON.stringify(meta.contentEncoding)} but GET contentEncoding ${JSON.stringify(stream.contentEncoding)}; ` +
                    "a body served in one coding under the other's headers is bytes the client cannot decode",
            );
            for (const [side, coding] of [
                ["HEAD", meta.contentEncoding],
                ["GET", stream.contentEncoding],
            ] as const) {
                assert(
                    coding === undefined || isNormalizedCoding(coding),
                    `${side} contentEncoding ${JSON.stringify(coding)} is not what representationCoding returns for it; ` +
                        "pass the stored value through representationCoding so an unregistered or identity value is never framed as a coding",
                );
            }
        },
    );

    const head = await settlesWithin(timeoutMs, subject, (store) => store.headObject(key)).then(
        (meta) => meta,
        () => undefined,
    );
    const pinnedBy = head?.pin !== undefined || (!!head?.etag && !head.etag.startsWith("W/"));
    if (pinnedBy) {
        await record(
            "pinned-read-serves-the-heads-representation",
            "a read pinned with the HEAD's own ifMatch and pin serves that representation",
            async (assert: ConformanceAssert, store: ObjectStore) => {
                const strong = head?.etag && !head.etag.startsWith("W/") ? head.etag : undefined;
                const stream = await store.getObject(key, { ifMatch: strong, pin: head?.pin });
                const body = await readBody(stream);
                assert(
                    sameBytes(body, content),
                    `a read pinned to the HEAD's validators returned ${body.byteLength} bytes that did not match; ` +
                        "the HEAD to GET pair would then splice two representations",
                );
            },
        );
    } else {
        skip(
            "pinned-read-serves-the-heads-representation",
            "a read pinned with the HEAD's own ifMatch and pin serves that representation",
            "the store reports neither a strong ETag nor a pin, so there is nothing to pin a read to",
        );
    }

    if (pinProbeApplies(subject, head)) {
        await record("mismatched-pin-is-refused-or-named", PIN_PROBE, (assert, store) =>
            assertMismatchedPinHandled(store, key, assert),
        );
    } else {
        skip(
            "mismatched-pin-is-refused-or-named",
            PIN_PROBE,
            "the store reports no ETag or Last-Modified, so a read has no validator to be mistaken for",
        );
    }

    await record(
        "missing-object-is-not-found",
        "an absent key must throw ObjectNotFoundError, distinguishably from a failure",
        async (assert: ConformanceAssert, store: ObjectStore) => {
            const outcome = await raisedBy(() => store.headObject(missingKey));
            assert(outcome.raised, "resolved for a key that should not exist");
            assert(
                isObjectNotFoundError(outcome.error),
                `threw ${errName(outcome.error)}; ` +
                    "anything else is answered as a backend failure, so a missing object becomes a 502",
            );
        },
    );

    await record(
        "missing-object-is-not-found-on-read",
        "getObject on an absent key, whole or ranged, must throw ObjectNotFoundError, since a plain GET reads with no HEAD first",
        async (assert: ConformanceAssert, store: ObjectStore) => {
            const reads: [label: string, opts: Parameters<ObjectStore["getObject"]>[1]][] = [["whole", undefined]];
            // A store declaring no range support is never asked for a window.
            if (store.supportsRange !== false) reads.push(["ranged", { range: { start: 0, end: 0 } }]);
            for (const [label, readOpts] of reads) {
                const outcome = await raisedBy(() => store.getObject(missingKey, readOpts));
                if (!outcome.raised) releaseStray(outcome.value);
                assert(outcome.raised, `a ${label} read resolved for a key that should not exist`);
                assert(
                    isObjectNotFoundError(outcome.error),
                    `a ${label} read threw ${errName(outcome.error)}; ` +
                        "anything else is a backend failure on the read path, so a missing object becomes a 502",
                );
            }
        },
    );

    const skipBothRangeChecks = (why: string): void => {
        skip("range-serves-the-requested-window", RANGE_WINDOW_OBLIGATION, why);
        skip("range-reports-an-honest-total", RANGE_TOTAL_OBLIGATION, why);
        skip("open-ended-range-reads-to-the-end", "a range with no end reads to the last byte", why);
        skip("past-eof-end-is-clamped", "a range ending past the last byte is clamped to it", why);
    };

    if (subject.supportsRange === false) {
        skipBothRangeChecks("supportsRange: false, so the serving path never asks this store for a window");
    } else if (content.byteLength < 4) {
        skipBothRangeChecks("the sample object is too short to slice a meaningful window from");
    } else {
        const start = 1;
        const end = content.byteLength - 2;

        await record(
            "range-serves-the-requested-window",
            RANGE_WINDOW_OBLIGATION,
            async (assert: ConformanceAssert, store: ObjectStore) => {
                // Anchored at the start, in the middle, anchored at the end, and the
                // last byte alone (what a suffix range resolves to): an offset
                // computed from a falsy start or a short tail is wrong only there.
                const last = content.byteLength - 1;
                const windows = [
                    { start: 0, end: 1 },
                    { start, end },
                    { start: last - 1, end: last },
                    { start: last, end: last },
                ];
                for (const window of windows) {
                    const where = `bytes ${window.start}-${window.end}`;
                    const expectedWindow = content.subarray(window.start, window.end + 1);
                    const stream = await store.getObject(key, { range: window });
                    const body = await readBody(stream);
                    assert(
                        sameBytes(body, expectedWindow),
                        `${where} came back as ${body.byteLength} bytes and did not match; ` +
                            "a window that is off by one hands the client bytes it cannot reassemble",
                    );
                    assert(
                        stream.contentLength === expectedWindow.byteLength,
                        `${where}: contentLength ${stream.contentLength}, expected ${expectedWindow.byteLength} for the window`,
                    );
                    assert(
                        stream.range?.start === window.start && stream.range.end === window.end,
                        `${where}: served range ${stream.range?.start}-${stream.range?.end}; ` +
                            "this span becomes the Content-Range header, so a shifted one labels the right bytes with the wrong offsets",
                    );
                }
            },
        );

        if (subject.authoritativeRange) {
            await record(
                "open-ended-range-reads-to-the-end",
                "a range with no end reads from its start to the last byte, and reports that span",
                async (assert: ConformanceAssert, store: ObjectStore) => {
                    const stream = await store.getObject(key, { range: { start, end: undefined } });
                    const body = await readBody(stream);
                    assert(
                        sameBytes(body, content.subarray(start)),
                        `an open range from ${start} came back as ${body.byteLength} bytes that did not match the tail; ` +
                            "an authoritative store receives `bytes=a-` as exactly this read",
                    );
                    assert(
                        stream.range?.start === start && stream.range.end === content.byteLength - 1,
                        `served range ${stream.range?.start}-${stream.range?.end}, expected ${start}-${content.byteLength - 1}`,
                    );
                    assert(
                        stream.totalSize === content.byteLength,
                        `totalSize ${stream.totalSize}, expected ${content.byteLength}`,
                    );
                },
            );

            await record(
                "past-eof-end-is-clamped",
                "a range ending past the last byte is clamped to it and reports the clamped span",
                async (assert: ConformanceAssert, store: ObjectStore) => {
                    const stream = await store.getObject(key, { range: { start, end: content.byteLength + 1000 } });
                    const body = await readBody(stream);
                    assert(
                        sameBytes(body, content.subarray(start)),
                        `a range ending past EOF came back as ${body.byteLength} bytes that did not match the tail; ` +
                            "an authoritative store receives the client's range unclamped",
                    );
                    assert(
                        stream.range?.start === start && stream.range.end === content.byteLength - 1,
                        `served range ${stream.range?.start}-${stream.range?.end}, expected ${start}-${content.byteLength - 1}`,
                    );
                },
            );
        } else {
            const why = "authoritativeRange is not claimed, so the serving path resolves every range against a HEAD";
            skip("open-ended-range-reads-to-the-end", "a range with no end reads to the last byte", why);
            skip("past-eof-end-is-clamped", "a range ending past the last byte is clamped to it", why);
        }

        await record(
            "range-reports-an-honest-total",
            RANGE_TOTAL_OBLIGATION,
            async (assert: ConformanceAssert, store: ObjectStore) => {
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
            },
        );
    }

    await record(
        "digest-is-the-whole-representation",
        "any digest reported is the raw base64 SHA-256 of the whole object, never of a window",
        async (assert: ConformanceAssert, store: ObjectStore) => {
            const { digest } = await store.headObject(key);
            // A store reporting no digest asserts nothing about one, and that is
            // conformant. Both observations are still made, so the check never
            // reports a pass it did not look for.
            assert(
                digest === undefined || isSha256Base64(digest),
                `digest ${JSON.stringify(digest)} is not the raw base64 of a 32-byte SHA-256; ` +
                    "a malformed value framed as a digest is a false integrity assertion",
            );
            const whole = await sha256Base64(content);
            assert(digest === undefined || digest === whole, "digest does not match the object's own bytes");

            // The GET's digest is emitted as Repr-Digest too, including on a
            // ranged read: it must name the whole object or be absent.
            const full = await store.getObject(key);
            await readBody(full);
            assert(
                full.digest === undefined || full.digest === whole,
                "the full read's digest does not match the object's own bytes",
            );
            if (store.supportsRange !== false && content.byteLength >= 4) {
                const window = await store.getObject(key, { range: { start: 1, end: content.byteLength - 2 } });
                await readBody(window);
                assert(
                    window.digest === undefined || window.digest === whole,
                    "a ranged read reported a digest that is not the whole object's; " +
                        "Repr-Digest on a 206 describes the whole representation, so a window's hash is a false integrity assertion",
                );
            }
        },
    );

    return tallyConformance(checks);
}
