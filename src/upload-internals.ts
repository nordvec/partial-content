/**
 * Internals the object-store adapters share: base64 codecs, the opaque upload
 * token, append-body iteration, the publish-key guard, and the projection from
 * persisted bookkeeping to engine-facing state.
 *
 * Package-internal. This module is deliberately absent from the `exports` map,
 * and nothing outside `src/` may import it: it is a factoring of the adapters,
 * not a contract with consumers.
 *
 * Crash ordering stays OUT of here. Which sidecar is written before which
 * payload, which is deleted first, and what a half-finished sequence looks
 * like on recovery differ per backend, and must stay readable and auditable
 * inside each adapter, beside the calls that establish the order.
 */

import {
    isUploadNotFoundError,
    UploadDigestMismatchError,
    UploadNotFoundError,
    UploadOverrunError,
    type AppendChunkOptions,
    type UploadDigestAlgorithm,
    type UploadDigests,
    type StoredUploadState,
    type UploadSweepCutoff,
} from "./upload-store.ts";
import type { UploadPolicy, UploadStatus } from "./upload-engine.ts";
import type {
    UploadAuditKey,
    UploadAuthorize,
    UploadAuthorizer,
    UploadOperation,
    UploadOrchestratorOptions,
    UploadPolicyResolver,
    UploadResourceEvent,
} from "./upload-orchestrator.ts";
import type { UploadLocker } from "./upload-locker.ts";
import { projectError } from "./object-store.ts";

// ─── Handler options ────────────────────────────────────────────────────────

/**
 * The last-resort report of a dialect handler: a hostile input or a throwing
 * caller callback reached the outermost catch.
 *
 * Projection keys on whether the caller configured `auditKey`, never on whether
 * deriving it succeeded: a caller who configured one has said raw errors must
 * not reach the sink, and a throwing or token-less derivation is exactly when
 * the raw error (which can quote a URL holding the token, or a key) would leak.
 * The token is resolved the way dispatch resolves it, guardedly, since a
 * throwing `resolveToken` is one of the things that reaches this seam.
 */
export function reportHandlerFailure(
    options: Pick<UploadHandlerBaseOptions, "auditKey" | "onError"> & {
        resolveToken?: (req: Request) => string | undefined;
    },
    req: Request,
    routedToken: string | undefined,
    err: unknown,
): void {
    const { onError } = options;
    if (onError === undefined) return;
    let token = routedToken;
    let auditKey: string | undefined;
    try {
        token ??= options.resolveToken?.(req);
        auditKey = options.auditKey?.({ request: req, uploadToken: token });
    } catch {
        auditKey = undefined;
    }
    if (options.auditKey === undefined) {
        onError(err, { uploadToken: token, operation: "handler" });
        return;
    }
    onError(
        projectError(err, "handler"),
        auditKey === undefined ? { operation: "handler" } : { auditKey, operation: "handler" },
    );
}

/**
 * The options both wire dialects (`/tus`, `/upload`) take with one meaning:
 * identity, authorization, the orchestrator's lock, clock and sinks. Declared
 * once so a hook's contract cannot be documented two ways.
 */
export interface UploadHandlerBaseOptions {
    /**
     * Audit-safe identifier reported on upload events and error contexts
     * instead of the raw token, which is the capability. Called per resource
     * request with the request and its token, and on a creation with the
     * token the store minted, before any event or error names the new
     * resource. A dialect that names a creation earlier calls it once first,
     * without a token.
     */
    auditKey?: UploadAuditKey;
    /**
     * Per-upload authorization for resource requests (probe, append, cancel),
     * called under the resource lock with the stored key and metadata before
     * anything is read back or written. Return a Response to refuse with it,
     * `undefined` to proceed. Creation is authorized by `key()`, which may
     * answer a Response. The same shape both dialects take.
     */
    authorize?: UploadAuthorize;
    /** Lock provider. Default: in-process cooperative-preemption locker. */
    locker?: UploadLocker;
    /** Structured, content-free audit events. */
    onUploadEvent?: (event: UploadResourceEvent) => void;
    /**
     * The upload published. The one hook carrying the storage key, so a caller
     * can record which object an upload became; the key is chosen before a
     * token exists, and pairing them by position across the creation call is a
     * race. Awaited before the response goes out, so a throw answers a backend
     * error rather than acknowledging an object the caller's records never saw.
     *
     * Deliberately not the audit stream, which is content-free by design: a
     * storage key commonly embeds a filename.
     */
    onUploadComplete?: UploadOrchestratorOptions["onUploadComplete"];
    /** How long a request waits for the upload lock before answering busy. */
    lockTimeoutMs?: number;
    /**
     * Error sink for storage failures, throwing hooks and dialect-level
     * failures. Must not throw (there is no sink for a failing error sink).
     * Under `createTusHandler`, a throwing `key`, `location` or `resolveToken`
     * callback reports with operation `"handler"`.
     * Whenever the `auditKey` option is configured, `uploadToken` never
     * arrives (the derived key does, when deriving it succeeded) and `error`
     * arrives as a `ProjectedError` (`name`, `code`,
     * `status`, `operation`, `cause` projected the same way): the message, the
     * stack and every other property, any of which can carry the token or the
     * key, stay behind.
     */
    onError?: (
        error: unknown,
        context: {
            uploadToken?: string;
            auditKey?: string;
            operation: string;
        },
    ) => void;
    /** Post-abort flush window in milliseconds. @default 10000 */
    graceMs?: number;
    /** Clock injection (tests), used for expiry and passed to the orchestrator. @default Date.now */
    now?: () => number;
}

/**
 * The orchestrator options a dialect's handler options map onto. A policy
 * function is resolved per request by the dialect, so it is not passed here.
 */
export function orchestratorOptionsOf(
    options: UploadHandlerBaseOptions & { policy: UploadPolicy | UploadPolicyResolver },
    now: () => number,
): UploadOrchestratorOptions {
    return {
        policy: typeof options.policy === "function" ? undefined : options.policy,
        locker: options.locker,
        onUploadEvent: options.onUploadEvent,
        onError: options.onError,
        redactErrors: options.auditKey !== undefined,
        graceMs: options.graceMs,
        onUploadComplete: options.onUploadComplete,
        lockTimeoutMs: options.lockTimeoutMs,
        now,
    };
}

// ─── Authorization ──────────────────────────────────────────────────────────

/** Bind a dialect's authorize hook to one resource request. */
export function bindAuthorize(
    authorize: UploadAuthorize | undefined,
    request: Request,
    uploadToken: string,
    operation: UploadOperation,
): UploadAuthorizer | undefined {
    return authorize && ((upload) => authorize({ ...upload, request, uploadToken, operation }));
}

// ─── Digests ────────────────────────────────────────────────────────────────

/** The algorithms the built-in stores verify, in RFC 9530 names. */
export const VERIFIED_DIGESTS: readonly UploadDigestAlgorithm[] = ["sha-256", "sha-512"];

/**
 * Verify every asserted digest against `compute`, throwing
 * {@link UploadDigestMismatchError} for the first that disagrees. A store
 * calls it before publishing, so a failed verification publishes nothing.
 */
export async function verifyDigests(
    uploadToken: string,
    expected: UploadDigests | undefined,
    compute: (algorithm: UploadDigestAlgorithm) => Promise<string>,
): Promise<void> {
    for (const algorithm of VERIFIED_DIGESTS) {
        const want = expected?.[algorithm];
        if (want === undefined) continue;
        const actual = await compute(algorithm);
        if (actual !== want) throw new UploadDigestMismatchError(uploadToken, algorithm, want, actual);
    }
}

// ─── Base64 ─────────────────────────────────────────────────────────────────

/** Base64 of raw bytes, standard alphabet with padding (RFC 4648 Section 4). */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
}

/** Base64url of raw bytes, padding omitted (RFC 4648 Section 5). */
export function bytesToBase64Url(bytes: Uint8Array): string {
    return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode base64url back to raw bytes, with or without padding (RFC 4648
 * Section 5 makes it optional). `atob` runs the HTML Standard's
 * forgiving-base64 decode, which accepts an unpadded final quantum, so the
 * padding is never restored by hand.
 */
export function base64UrlToBytes(value: string): Uint8Array {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

// ─── Upload Token ───────────────────────────────────────────────────────────

/** The UUID shape `createUpload` mints; nothing else may name bookkeeping. */
export const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Mint an upload id: opaque, unguessable, and the whole of the upload token.
 *
 * Always UUID-shaped, including on a runtime without `randomUUID`, because the
 * shape is what {@link decodeUploadId} accepts and an id that cannot be decoded
 * is an upload that can never be resumed.
 */
export function newUploadId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid !== undefined) return uuid;
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8]! & 0x3f) | 0x80; // IETF variant
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Read the resource id out of an upload token. The token IS the id.
 *
 * So the destination key never travels to a client, which would disclose a
 * filename or tenant identifier, and never arrives from one, which would let a
 * request name an object the server never recorded. The persisted record is the
 * only source of a key.
 *
 * Only the exact shape minted at creation is accepted, since the id is
 * interpolated into backend object names.
 */
export function decodeUploadId(uploadToken: string): string {
    if (!UPLOAD_ID_RE.test(uploadToken)) throw new UploadNotFoundError(uploadToken);
    return uploadToken;
}

// ─── Persisted State ────────────────────────────────────────────────────────

/** Where the object-store adapters keep upload bookkeeping unless configured otherwise. */
export const DEFAULT_UPLOAD_PREFIX = ".partial-content-uploads";

/** Durable upload bookkeeping, the fields every object-store adapter persists. */
export interface PersistedUpload {
    key: string;
    length?: number;
    metadata?: Record<string, string>;
    createdAt: number;
    /** {@link StoredUploadState.expiresAt}; absent on a record created without one. */
    expiresAt?: number;
    lastAppendAt?: number;
    isComplete: boolean;
    isInvalidated: boolean;
    /** Recorded at completion for idempotent-retry answers. */
    etag?: string;
}

/** The only number shape persisted state may carry: a non-negative safe integer. */
export function isCount(v: unknown): v is number {
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** The largest delay a timer honours; past it the timer fires at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Refuse a handler policy without a size ceiling. An unbounded upload endpoint
 * is a storage-exhaustion surface, so the absence of a cap must be a stated
 * choice (`maxSize: Infinity`), never the default an omitted field falls to.
 */
function requireMaxSize(name: string, policy: { maxSize?: number } | undefined): void {
    if (policy?.maxSize === undefined) {
        throw new TypeError(`${name}: policy.maxSize is required (Infinity opts out of a size cap)`);
    }
}

/**
 * A dialect's per-request policy source. `derive` folds a policy into what the
 * dialect enforces and advertises, and throws a TypeError for one it refuses.
 * A static policy is derived once, here, so a bad one fails at construction; a
 * resolved one is held to the same checks on every request, where the throw
 * reaches the handler's error seam (a 500 reported to `onError`).
 */
export function policySource<L>(
    name: string,
    policy: (UploadPolicy & { maxSize: number }) | UploadPolicyResolver,
    derive: (policy: UploadPolicy) => L,
): (request: Request) => L | Promise<L> {
    if (typeof policy !== "function") {
        requireMaxSize(name, policy);
        const fixed = derive(policy);
        return () => fixed;
    }
    return async (request) => {
        const resolved = await policy(request);
        requireMaxSize(name, resolved);
        return derive(resolved);
    };
}

/**
 * Refuse a numeric option that is not an integer in `[min, max]`; `name`
 * carries the factory and option. A NaN bound would otherwise disable
 * enforcement silently (`x > NaN` is false) and flow into byte or timer math.
 */
export function intOption(name: string, value: number | undefined, min: number, max = Number.MAX_SAFE_INTEGER): void {
    if (value !== undefined && !(Number.isInteger(value) && value >= min && value <= max)) {
        throw new TypeError(`${name} must be an integer from ${min} to ${max}, got ${value}`);
    }
}

/**
 * Shape gate for persisted upload state. Numbers feed offset math and expiry
 * policy, so only non-negative safe integers pass; a forged or corrupt value
 * yields null and the caller answers not-found rather than flowing bad state
 * into the engine.
 */
export function validatePersistedUploadShape(parsed: unknown): PersistedUpload | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as Record<string, unknown>;
    if (
        typeof c.key === "string" &&
        c.key.length > 0 &&
        (c.length === undefined || isCount(c.length)) &&
        isCount(c.createdAt) &&
        (c.expiresAt === undefined || isCount(c.expiresAt)) &&
        (c.lastAppendAt === undefined || isCount(c.lastAppendAt)) &&
        typeof c.isComplete === "boolean" &&
        typeof c.isInvalidated === "boolean" &&
        (c.etag === undefined || typeof c.etag === "string") &&
        (c.metadata === undefined ||
            (typeof c.metadata === "object" &&
                c.metadata !== null &&
                Object.values(c.metadata).every((v) => typeof v === "string")))
    ) {
        return c as unknown as PersistedUpload;
    }
    return null;
}

const CORRUPT_UPLOAD_STATE = "UploadStateCorruptError";

/**
 * The not-found an adapter answers for bookkeeping it cannot read: a record
 * that does not parse, holds a shape no adapter writes, or is missing beside
 * the resource it describes. The client is told not-found, all a protocol can
 * say of a resource nobody can resume (tus answers an unknown resource 404);
 * the cause is what tells an operator that storage was damaged rather than
 * that a token expired, and the orchestrator reports it to `onError`. The
 * cause carries nothing read from the record, which holds the object key.
 */
export function corruptUploadState(uploadToken: string): UploadNotFoundError {
    const cause = new Error("Upload bookkeeping is unreadable");
    cause.name = CORRUPT_UPLOAD_STATE;
    return new UploadNotFoundError(uploadToken, cause);
}

/** Whether a not-found answers damaged bookkeeping rather than an absent resource. */
export function isCorruptUploadState(err: unknown): boolean {
    return isUploadNotFoundError(err) && err.cause instanceof Error && err.cause.name === CORRUPT_UPLOAD_STATE;
}

/**
 * The lifecycle status persisted flags describe. Invalidation wins: a store
 * that recorded both flags holds a resource no later request may touch.
 */
export function uploadStatus(flags: { isComplete: boolean; isInvalidated: boolean }): UploadStatus {
    return flags.isInvalidated ? "invalidated" : flags.isComplete ? "complete" : "incomplete";
}

/** Project persisted bookkeeping plus a backend-derived offset into engine state. */
export function toStoredState(state: PersistedUpload, offset: number): StoredUploadState {
    return {
        key: state.key,
        offset,
        length: state.length,
        status: uploadStatus(state),
        createdAt: state.createdAt,
        expiresAt: state.expiresAt,
        lastAppendAt: state.lastAppendAt,
        metadata: state.metadata,
    };
}

// ─── Sweep Cutoffs ──────────────────────────────────────────────────────────

/**
 * Refuse a sweep that names no cutoff, in one place for every adapter.
 *
 * A sweep with nothing to compare against would visit every resource, reclaim
 * none, and report success: a retention job that runs green while reclaiming
 * nothing is worse than one that is absent, because it is mistaken for a
 * control.
 */
export function requireSweepCutoff(cutoff: UploadSweepCutoff): void {
    const named: Array<[string, number | undefined]> = [
        ["idleSinceMs", cutoff.idleSinceMs],
        ["createdBeforeMs", cutoff.createdBeforeMs],
    ];
    for (const [name, value] of named) {
        if (value !== undefined && !Number.isFinite(value)) {
            throw new TypeError(`sweepExpired: cutoff.${name} must be a finite epoch-ms instant, got ${value}`);
        }
    }
    if (cutoff.idleSinceMs === undefined && cutoff.createdBeforeMs === undefined) {
        throw new TypeError("sweepExpired: cutoff must name idleSinceMs, createdBeforeMs, or both");
    }
}

/**
 * Whether one resource is reclaimable under either cutoff: idle since before
 * `idleSinceMs`, or created before `createdBeforeMs`. Either is enough,
 * because each names an independent way an upload ends.
 */
export function isSweepable(cutoff: UploadSweepCutoff, createdAt: number, lastAppendAt?: number): boolean {
    if (cutoff.idleSinceMs !== undefined && (lastAppendAt ?? createdAt) < cutoff.idleSinceMs) {
        return true;
    }
    return cutoff.createdBeforeMs !== undefined && createdAt < cutoff.createdBeforeMs;
}

// ─── Publish-Key Guard ──────────────────────────────────────────────────────

/**
 * Bar publish keys from the store's bookkeeping namespace. A consumer whose
 * key() derives from user input would otherwise let a caller name another
 * upload's sidecar as its own destination and overwrite it at completion.
 * Upload tokens are the only handles into that namespace.
 *
 * @param bookkeepingPrefix the staging prefix, trailing slash included.
 */
export function publishKeyGuard(bookkeepingPrefix: string): (key: string) => void {
    return (key: string): void => {
        if (key === bookkeepingPrefix.slice(0, -1) || key.startsWith(bookkeepingPrefix)) {
            throw new TypeError(`Upload key is inside the reserved upload bookkeeping prefix "${bookkeepingPrefix}"`);
        }
    };
}

// ─── Append Body ────────────────────────────────────────────────────────────

/** An append body, buffered or streaming. */
export type UploadBody = ReadableStream<Uint8Array> | Uint8Array;

/** Normalize an append body to an async chunk sequence; empty chunks are skipped. */
async function* uploadBodyChunks(body: UploadBody): AsyncGenerator<Uint8Array, void, undefined> {
    if (body instanceof Uint8Array) {
        if (body.length > 0) yield body;
        return;
    }
    const reader = body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value && value.length > 0) yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

/** Cancel a streaming body after an early stop; a buffered body has nothing to cancel. */
export async function cancelUploadBody(body: UploadBody): Promise<void> {
    if (body instanceof Uint8Array) return;
    // Cancelling an already-errored/closed stream rejects; the stop already
    // happened, so that rejection carries no additional information.
    await body.cancel().catch(() => undefined);
}

/**
 * Release an append body at an exit that will not read it: through the
 * caller's {@link AppendChunkOptions.releaseBody} handle when there is one
 * (it works on a body the store has locked), else by cancelling the body.
 */
export function releaseUploadBody(body: UploadBody, opts: Pick<AppendChunkOptions, "releaseBody">): Promise<void> {
    return opts.releaseBody?.() ?? cancelUploadBody(body);
}

/**
 * Drive an append body as a manually-advanced iterator, paired with the
 * cleanup an early exit owes it.
 *
 * Leaving the loop early does not finalize a manually-driven generator the way
 * `for await` does, and the generator releases the reader lock in its
 * `finally`. Skip `finalize` and the lock outlives the loop, which leaves the
 * caller's stream locked with no way to cancel it.
 *
 * `release`, when given, runs after the lock is gone, so finalizing also
 * releases the body. A store that releases only at points it picks (an abort,
 * a request ceiling, a thrown error) omits it and calls
 * {@link releaseUploadBody} at those points.
 */
export function openUploadBody(
    body: UploadBody,
    release?: () => Promise<void>,
): { iterator: AsyncGenerator<Uint8Array, void, undefined>; finalize: () => Promise<void> } {
    const iterator = uploadBodyChunks(body);
    const finalize = async (): Promise<void> => {
        await iterator.return().catch(() => undefined);
        await release?.();
    };
    return { iterator, finalize };
}

/**
 * Admit an append: run `open` (load the upload, check it is writable and that
 * the offset matches) before any byte of the body is read, or refuse.
 *
 * A yield asked for before the call arrived is an interruption with nothing
 * durable, and it is REPORTED as `refused` rather than raised: a caller must
 * never have to read an exception to tell a yield from a failure. A throw from
 * `open` is rethrown.
 *
 * Either refusal releases the body, because nothing downstream will read it
 * and a body left unread holds its source open. The adapters that pump the
 * body themselves (gcs, azure, r2) open every append through here, so that
 * release is stated once.
 */
export async function admitAppend<T>(
    body: UploadBody,
    opts: Pick<AppendChunkOptions, "signal" | "releaseBody">,
    open: () => Promise<T>,
): Promise<{ refused: { bytesWritten: 0; interrupted: true } } | { admitted: T }> {
    if (opts.signal?.aborted === true) {
        await releaseUploadBody(body, opts);
        return { refused: { bytesWritten: 0, interrupted: true } };
    }
    try {
        return { admitted: await open() };
    } catch (err) {
        await releaseUploadBody(body, opts);
        throw err;
    }
}

/**
 * The upload id a discard names, or `null` when the token names nothing.
 *
 * `abortUpload` is idempotent by contract, so a token that never decoded has
 * nothing to discard and answering "done" is the correct outcome rather than a
 * swallowed error. Two adapters wrote the same try/catch to say it.
 */
export function uploadIdForDiscard(uploadToken: string): string | null {
    try {
        return decodeUploadId(uploadToken);
    } catch {
        return null;
    }
}

/** Why an append stopped reading the body. Exactly one of these is true. */
export interface UploadBodyOutcome {
    /** The read stopped without the body reaching a clean end. */
    interrupted: boolean;
    /** THIS REQUEST's `maxBytes` stopped the read; the accepted prefix still lands. */
    ceilingHit: boolean;
    /** The body reported a clean end, so an un-flushed tail is the final one. */
    endedCleanly: boolean;
}

/**
 * The chunks an append may accept, and the reason it stopped taking them.
 *
 * Three adapters ran the identical loop around {@link openUploadBody}: check
 * the abort signal, pull one chunk, treat a throw from the body as an
 * interruption rather than a failure, count the bytes, and stop at the
 * request's `maxBytes`. Only the per-chunk WORK differed (staged blocks, a
 * single-shot write stream, a uniform part buffer), which is why the loop
 * belongs here and the body of it does not.
 *
 * Two distinctions the callers depend on, and both were easy to get subtly
 * wrong in a fourth copy:
 *
 * - `interrupted` is not a failure. A client disconnect mid-body leaves a
 *   durable prefix, and the contract is to report how much of it landed rather
 *   than to raise, so the caller flushes what it has and answers truthfully.
 * - The two ceilings are different bounds. `maxBytes` without `maxBytesFatal`
 *   is THIS REQUEST's limit, so the read stops and the resource stays healthy;
 *   with it, the bytes crossed the REPRESENTATION's bound, which is terminal.
 *   The terminal case must record the invalidation durably before it throws, so
 *   every later interaction refuses, and the durable write differs per backend:
 *   `onOverrun` is that write, awaited here, ahead of the finalize and the
 *   throw so the ordering cannot drift between adapters.
 *
 * `s3.ts` deliberately does NOT use this: it opens the body with
 * no release and owns it at points it picks, so its loop is
 * a different contract wearing a similar shape.
 */
export function pumpUploadBody(
    body: UploadBody,
    uploadToken: string,
    /** The append's options: its signal, ceilings, and the `releaseBody` finalize releases through. */
    appendOpts: Pick<AppendChunkOptions, "signal" | "maxBytes" | "maxBytesFatal" | "releaseBody">,
    /** Record the invalidation durably. Runs before finalize and the throw. */
    onOverrun: () => Promise<void>,
): {
    chunks: AsyncGenerator<Uint8Array, void, undefined>;
    /** Mutated as the read progresses; read it after the loop, never during. */
    outcome: UploadBodyOutcome;
    finalize: () => Promise<void>;
} {
    const { iterator, finalize } = openUploadBody(body, () => releaseUploadBody(body, appendOpts));
    const outcome: UploadBodyOutcome = { interrupted: false, ceilingHit: false, endedCleanly: false };
    let consumed = 0;

    async function* chunks(): AsyncGenerator<Uint8Array, void, undefined> {
        for (;;) {
            if (appendOpts.signal?.aborted === true) {
                outcome.interrupted = true;
                return;
            }
            let next: IteratorResult<Uint8Array>;
            try {
                next = await iterator.next();
            } catch {
                // The body died (a client disconnect). The prefix already received is
                // durable once the caller flushes it, and accounting it truthfully is
                // what lets the next getUploadState agree.
                outcome.interrupted = true;
                return;
            }
            if (next.done === true) {
                outcome.endedCleanly = true;
                return;
            }
            consumed += next.value.length;
            if (appendOpts.maxBytes !== undefined && consumed > appendOpts.maxBytes) {
                if (appendOpts.maxBytesFatal !== true) {
                    outcome.ceilingHit = true;
                    return;
                }
                await onOverrun();
                await finalize();
                throw new UploadOverrunError(uploadToken, appendOpts.maxBytes);
            }
            yield next.value;
        }
    }

    return { chunks: chunks(), outcome, finalize };
}

/**
 * Refuse an append or a completion against an upload that can take neither.
 *
 * Three adapters carried this pair of checks verbatim. It is the same refusal
 * in each, and the message differs only by which operation was attempted, so a
 * new adapter should not be re-deciding the wording or, worse, the order: an
 * invalidated upload is reported as invalidated even once it is also complete.
 *
 * These stay bare Errors, unlike the typed offset conflict. The engine refuses
 * both conditions from the state it read under the upload lock, before any
 * store is called, so a store reaches this check only when its record changed
 * outside that lock: two instances sharing a backend without a shared locker.
 * That is a deployment fault, and it must reach `onError` as a store failure;
 * a typed refusal would answer it as an ordinary client error and hide it.
 */
export function assertUploadWritable(
    state: { isInvalidated?: boolean; isComplete?: boolean },
    operation: "append" | "complete",
): void {
    const consequence = operation === "append" ? "nothing may be appended" : "it cannot be completed";
    if (state.isInvalidated) {
        throw new Error(`Upload is invalidated; ${consequence}`);
    }
    if (operation === "append" && state.isComplete) {
        throw new Error(`Upload is already complete; nothing may be appended`);
    }
}
