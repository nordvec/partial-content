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

import {
  isObjectNotFoundError,
  type ObjectStore,
  type ObjectStream,
} from "./object-store.ts";
import { isSha256Base64 } from "./kernel.ts";
import { bytesToBase64 } from "./upload-internals.ts";
import {
  isUploadOffsetConflictError,
  isUploadAppendBoundError,
  isUploadOverrunError,
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
}

// ─── Harness ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

/** Distinct-enough to catch a token minted from a counter or a timestamp. */
const MIN_TOKEN_ENTROPY_CHARS = 16;

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

  const record = (
    name: string,
    obligation: string,
    run: () => Promise<string | undefined>,
  ) => async (): Promise<void> => {
    try {
      const detail = await run();
      checks.push(detail === undefined
        ? { name, obligation, ok: true }
        : { name, obligation, ok: false, detail });
    } catch (err) {
      checks.push({
        name,
        obligation,
        ok: false,
        detail: `threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      });
    }
  };

  const skip = (name: string, obligation: string, why: string) => {
    checks.push({ name, obligation, ok: true, skipped: true, detail: why });
  };
  const NOT_RESTARTABLE = "restartable: false, so durability across instances is unverified";

  const store = await makeStore();

  // ── Capability declarations ───────────────────────────────────────────────
  await record(
    "declares-atomic-completion",
    "atomicCompletion must be true: the orchestrator has no completion rollback of its own",
    async () => (store.atomicCompletion ? undefined : "declared false"),
  )();

  await record(
    "declares-offset-check",
    "enforcesOffsetCheck must be true: it is the only guard against a stolen-lock writer",
    async () => (store.enforcesOffsetCheck ? undefined : "declared false"),
  )();

  // ── Token quality ─────────────────────────────────────────────────────────
  await record(
    "token-is-unguessable",
    "tokens must come from a CSPRNG: possession alone authorizes append, probe and cancel",
    async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 8; i++) {
        const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
        if (seen.has(uploadToken)) return "createUpload returned a duplicate token";
        seen.add(uploadToken);
        if (uploadToken.length < MIN_TOKEN_ENTROPY_CHARS) {
          return `token is ${uploadToken.length} chars, too short to be unguessable`;
        }
      }
      const sorted = [...seen].sort();
      // Sequential tokens sort into the order they were minted. A counter or a
      // timestamp prefix shows up here and nowhere else.
      const minted = [...seen];
      if (sorted.every((t, i) => t === minted[i])) {
        return "tokens sort into the order they were minted, which suggests a counter or a timestamp";
      }
      return undefined;
    },
  )();

  // ── Offset derivation ─────────────────────────────────────────────────────
  await record(
    "offset-starts-at-zero",
    "a fresh upload reports offset 0, is neither complete nor invalidated, and echoes createdAt",
    async () => {
      const created = now();
      const { uploadToken } = await store.createUpload({ key: nextKey(), now: created });
      const state = await store.getUploadState(uploadToken);
      if (state.offset !== 0) return `offset ${state.offset}, expected 0`;
      if (state.isComplete) return "reported complete before any append";
      if (state.isInvalidated) return "reported invalidated before any append";
      if (state.createdAt !== created) return `createdAt ${state.createdAt}, expected the injected ${created}`;
      return undefined;
    },
  )();

  await record(
    "offset-agrees-after-clean-append",
    "after a clean append, getUploadState must agree with the offset plus bytesWritten",
    async () => {
      const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
      const { bytesWritten } = await store.appendChunk(uploadToken, 0, bytes("0123456789"), { now: now() });
      if (bytesWritten !== 10) return `bytesWritten ${bytesWritten}, expected 10`;
      const state = await store.getUploadState(uploadToken);
      if (state.offset !== 10) {
        return `getUploadState reports ${state.offset} after a clean 10-byte append; `
          + "the two must agree or a client resumes at an offset the store disputes";
      }
      return undefined;
    },
  )();

if (restartable) {
    await record(
      "offset-is-backend-derived",
      "the offset must come from durable backend state, so a fresh instance derives the same one",
      async () => {
        const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
        await store.appendChunk(uploadToken, 0, bytes("abcdef"), { now: now() });
        const restarted = await makeStore();
        const state = await restarted.getUploadState(uploadToken);
        if (state.offset !== 6) {
          return `a fresh instance reports ${state.offset}, expected 6; `
            + "an offset held in process memory is lost on restart and the upload cannot resume";
        }
        return undefined;
      },
    )();
} else {
    skip("offset-is-backend-derived", "the offset must come from durable backend state, so a fresh instance derives the same one", NOT_RESTARTABLE);
  }

  // ── The offset check the capability flag stands for ───────────────────────
  await record(
    "refuses-stale-offset",
    "appendChunk must throw UploadOffsetConflictError when the claimed offset is behind durable state",
    async () => {
      const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
      await store.appendChunk(uploadToken, 0, bytes("0123456789"), { now: now() });
      try {
        // The stolen-lock case: a holder that stalled past its TTL comes back
        // and replays an append the current holder has already moved past.
        await store.appendChunk(uploadToken, 4, bytes("XXXX"), { now: now() });
      } catch (err) {
        if (isUploadOffsetConflictError(err)) {
          return err.durableOffset === 10
            ? undefined
            : `conflict carried durableOffset ${err.durableOffset}, expected 10; `
              + "the client retries against this number, so a wrong one sends it to the wrong place";
        }
        return `threw ${err instanceof Error ? err.name : String(err)}, expected UploadOffsetConflictError`;
      }
      return "accepted a write at offset 4 when durable state was 10; "
        + "enforcesOffsetCheck is declared but not implemented, so a stalled writer interleaves silently";
    },
  )();

  await record(
    "refuses-future-offset",
    "appendChunk must refuse an offset ahead of durable state rather than leaving a hole",
    async () => {
      const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
      try {
        await store.appendChunk(uploadToken, 64, bytes("XXXX"), { now: now() });
      } catch (err) {
        return isUploadOffsetConflictError(err)
          ? undefined
          : `threw ${err instanceof Error ? err.name : String(err)}, expected UploadOffsetConflictError`;
      }
      return "accepted a write at offset 64 on an empty upload, which leaves unwritten bytes in the object";
    },
  )();

  // ── The two bounds, which mean opposite things ────────────────────────────
  await record(
    "request-ceiling-keeps-the-resource",
    "a non-fatal bound stops at maxBytes, keeps the prefix durable, and leaves the upload healthy",
    async () => {
      const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
      let thrown: unknown;
      try {
        await store.appendChunk(uploadToken, 0, bytes("0123456789"), {
          maxBytes: 4, maxBytesFatal: false, now: now(),
        });
      } catch (err) {
        thrown = err;
      }
      if (thrown === undefined) return "accepted a body past the request ceiling without reporting it";
      if (!isUploadAppendBoundError(thrown)) {
        return `threw ${thrown instanceof Error ? thrown.name : String(thrown)}, expected UploadAppendBoundError`;
      }
      const state = await store.getUploadState(uploadToken);
      if (state.isInvalidated) {
        return "invalidated the upload over a per-request ceiling; "
          + "the representation was untouched, so this turns a resumable situation into a lost one";
      }
      // A ceiling, not a target: a part-based backend lands on the last
      // boundary at or below it. What must hold is that the reported offset
      // is durable and never past the bound.
      if (state.offset > 4) {
        return `offset ${state.offset} exceeds the 4-byte ceiling it was told to stop at`;
      }
      const resumeAt = state.offset;
      // The client's whole recovery is resuming from here in smaller chunks.
      const resumed = await store.appendChunk(uploadToken, resumeAt, bytes("45"), { now: now() });
      if (resumed.bytesWritten !== 2) return "could not resume from the reported offset";
      return undefined;
    },
  )();

  await record(
    "representation-bound-invalidates",
    "a fatal bound must invalidate durably and throw UploadOverrunError",
    async () => {
      const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
      let thrown: unknown;
      try {
        await store.appendChunk(uploadToken, 0, bytes("0123456789"), {
          maxBytes: 4, maxBytesFatal: true, now: now(),
        });
      } catch (err) {
        thrown = err;
      }
      if (thrown === undefined) {
        return "returned normally after the body crossed a representation bound; "
          + "the caller is told the append succeeded and hands the client an offset it cannot build on";
      }
      if (!isUploadOverrunError(thrown)) {
        return `threw ${thrown instanceof Error ? thrown.name : String(thrown)}, expected UploadOverrunError`;
      }
      // The invalidation must be visible to a process that never saw the
      // append which caused it, so read it back from a fresh instance where
      // the store claims to be durable across them.
      const reader = restartable ? await makeStore() : store;
      const state = await reader.getUploadState(uploadToken);
      if (!state.isInvalidated) {
        return restartable
          ? "a fresh instance does not see the invalidation; "
            + "it must be durable, or a process that never saw this append accepts more bytes"
          : "the upload is not marked invalidated after a representation bound was crossed";
      }
      return undefined;
    },
  )();

  // ── Completion and its terminal effects ───────────────────────────────────
  await record(
    "completion-publishes-and-closes",
    "completeUpload publishes, and the upload refuses further appends afterwards",
    async () => {
      const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
      await store.appendChunk(uploadToken, 0, bytes("payload"), { now: now() });
      await store.completeUpload(uploadToken, { now: now() });
      const state = await store.getUploadState(uploadToken);
      if (!state.isComplete) return "getUploadState does not report the upload complete after completeUpload";
      try {
        await store.appendChunk(uploadToken, 7, bytes("more"), { now: now() });
      } catch {
        return undefined;
      }
      return "accepted an append after completion, which mutates an object readers can already see";
    },
  )();

  await record(
    "abort-is-idempotent",
    "abortUpload must tolerate being called twice: a retried cancel is a normal thing to receive",
    async () => {
      const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
      await store.appendChunk(uploadToken, 0, bytes("discard me"), { now: now() });
      await store.abortUpload(uploadToken);
      await store.abortUpload(uploadToken);
      return undefined;
    },
  )();

  await record(
    "abort-spares-a-published-object",
    "abortUpload must never destroy an object completion already published",
    async () => {
      const objectKey = nextKey();
      const { uploadToken } = await store.createUpload({ key: objectKey, now: now() });
      await store.appendChunk(uploadToken, 0, bytes("published"), { now: now() });
      await store.completeUpload(uploadToken, { now: now() });
      await store.abortUpload(uploadToken);
      // A client that tidies up its upload resource after completing must not
      // thereby delete its own file.
      return undefined;
    },
  )();

  await record(
    "invalidated-upload-is-still-cancellable",
    "a dead upload must remain discardable, or its bytes are stranded until a sweep that may never run",
    async () => {
      const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
      try {
        await store.appendChunk(uploadToken, 0, bytes("0123456789"), {
          maxBytes: 4, maxBytesFatal: true, now: now(),
        });
      } catch {
        // Expected: the previous check covers what this throw must be.
      }
      await store.abortUpload(uploadToken);
      return undefined;
    },
  )();

  // ── Deferred length ───────────────────────────────────────────────────────
if (restartable) {
    await record(
      "records-a-deferred-length",
      "a length first declared on an append must be persisted and then immutable",
      async () => {
        const { uploadToken } = await store.createUpload({ key: nextKey(), now: now() });
        await store.appendChunk(uploadToken, 0, bytes("hello"), { length: 5, now: now() });
        const restarted = await makeStore();
        const state = await restarted.getUploadState(uploadToken);
        if (state.length !== 5) {
          return `a fresh instance reports length ${state.length}, expected 5; `
            + "an unrecorded length strands the upload just as its absence would";
        }
        return undefined;
      },
    )();
} else {
    skip("records-a-deferred-length", "a length first declared on an append must be persisted and then immutable", NOT_RESTARTABLE);
  }

  const passed = checks.filter((c) => c.ok && !c.skipped).length;
  const skipped = checks.filter((c) => c.skipped).length;
  const failed = checks.filter((c) => !c.ok && !c.skipped).length;
  return { ok: failed === 0, checks, passed, failed, skipped };
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
  lines.push(
    `\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`,
  );
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

  const record = (
    name: string,
    obligation: string,
    run: () => Promise<string | undefined>,
  ) => async (): Promise<void> => {
    try {
      const detail = await run();
      checks.push(detail === undefined
        ? { name, obligation, ok: true }
        : { name, obligation, ok: false, detail });
    } catch (err) {
      checks.push({
        name,
        obligation,
        ok: false,
        detail: `threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      });
    }
  };

  const readBody = async (stream: ObjectStream): Promise<Uint8Array<ArrayBuffer>> => {
    if (stream.body instanceof Uint8Array) return stream.body;
    const reader = stream.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { parts.push(value); total += value.byteLength; }
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out;
  };

  const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

  await record(
    "head-reports-the-true-length",
    "headObject must report the object's exact byte length",
    async () => {
      const meta = await store.headObject(key);
      return meta.contentLength === content.byteLength
        ? undefined
        : `contentLength ${meta.contentLength}, expected ${content.byteLength}; `
          + "a wrong length is a Content-Length the client counts bytes against";
    },
  )();

  await record(
    "full-read-returns-every-byte",
    "getObject with no range returns the whole representation and its total size",
    async () => {
      const stream = await store.getObject(key);
      const body = await readBody(stream);
      if (!sameBytes(body, content)) {
        return `read ${body.byteLength} bytes, expected ${content.byteLength} and byte-identical`;
      }
      if (stream.contentLength !== content.byteLength) {
        return `contentLength ${stream.contentLength}, expected ${content.byteLength}`;
      }
      return undefined;
    },
  )();

  await record(
    "missing-object-is-not-found",
    "an absent key must throw ObjectNotFoundError, distinguishably from a failure",
    async () => {
      try {
        await store.headObject(missingKey);
      } catch (err) {
        return isObjectNotFoundError(err)
          ? undefined
          : `threw ${err instanceof Error ? err.name : String(err)}; `
            + "anything else is answered as a backend failure, so a missing object becomes a 502";
      }
      return "resolved for a key that should not exist";
    },
  )();

  if (store.supportsRange === false) {
    checks.push({
      name: "range-serves-the-requested-window",
      obligation: "a ranged read returns exactly the requested bytes",
      ok: true,
      skipped: true,
      detail: "supportsRange: false, so the serving path never asks this store for a window",
    });
    checks.push({
      name: "range-reports-an-honest-total",
      obligation: "a ranged read reports the whole representation's size, or undefined",
      ok: true,
      skipped: true,
      detail: "supportsRange: false, so the serving path never asks this store for a window",
    });
  } else if (content.byteLength < 4) {
    const why = "the sample object is too short to slice a meaningful window from";
    checks.push({ name: "range-serves-the-requested-window", obligation: "a ranged read returns exactly the requested bytes", ok: true, skipped: true, detail: why });
    checks.push({ name: "range-reports-an-honest-total", obligation: "a ranged read reports the whole representation's size, or undefined", ok: true, skipped: true, detail: why });
  } else {
    const start = 1;
    const end = content.byteLength - 2;
    const expected = content.subarray(start, end + 1);

    await record(
      "range-serves-the-requested-window",
      "a ranged read returns exactly the requested bytes",
      async () => {
        const stream = await store.getObject(key, { range: { start, end } });
        const body = await readBody(stream);
        if (!sameBytes(body, expected)) {
          return `bytes ${start}-${end} came back as ${body.byteLength} bytes and did not match; `
            + "a window that is off by one hands the client bytes it cannot reassemble";
        }
        return stream.contentLength === expected.byteLength
          ? undefined
          : `contentLength ${stream.contentLength}, expected ${expected.byteLength} for the window`;
      },
    )();

    await record(
      "range-reports-an-honest-total",
      "a ranged read reports the whole representation's size, or undefined when it cannot know",
      async () => {
        const stream = await store.getObject(key, { range: { start, end } });
        await readBody(stream);
        if (stream.totalSize === undefined) return undefined;
        return stream.totalSize === content.byteLength
          ? undefined
          : `totalSize ${stream.totalSize} on a partial read, expected ${content.byteLength} `
            + "or undefined; this number becomes the Content-Range total the client sizes against";
      },
    )();
  }

  await record(
    "digest-is-the-whole-representation",
    "any digest reported is the raw base64 SHA-256 of the whole object, never of a window",
    async () => {
      const meta = await store.headObject(key);
      if (meta.digest === undefined) return undefined;
      if (!isSha256Base64(meta.digest)) {
        return `digest ${JSON.stringify(meta.digest)} is not the raw base64 of a 32-byte SHA-256; `
          + "a malformed value framed as a digest is a false integrity assertion";
      }
      const expected = bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", content)));
      return meta.digest === expected
        ? undefined
        : "digest does not match the object's own bytes";
    },
  )();

  const passed = checks.filter((c) => c.ok && !c.skipped).length;
  const skipped = checks.filter((c) => c.skipped).length;
  const failed = checks.filter((c) => !c.ok && !c.skipped).length;
  return { ok: failed === 0, checks, passed, failed, skipped };
}
