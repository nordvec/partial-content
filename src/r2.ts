/**
 * Cloudflare R2 native ObjectStore adapter for partial-content.
 *
 * Uses Cloudflare's native R2 bindings (`R2Bucket`) directly, without the
 * AWS SDK. This eliminates the ~50-package `@aws-sdk/client-s3` dependency
 * and its cold-start overhead in Workers.
 *
 * For S3-compatible access to R2 (e.g. from Node.js outside Workers),
 * use `partial-content/s3` instead.
 *
 * @example
 * ```typescript
 * import { r2Store } from "partial-content/r2";
 * import { serveObject } from "partial-content/hono";
 *
 * // In a Cloudflare Worker with R2 binding:
 * app.get("/files/:key", serveObject(
 *   r2Store({ bucket: env.MY_BUCKET }),
 *   { key: (c) => c.req.param("key") },
 * ));
 * ```
 *
 * @packageDocumentation
 */

import {
    isOpenEndedRange,
    guardStreamLength,
    ObjectNotFoundError,
    ObjectChangedError,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectStream,
    type ParsedRange,
    reservedKeyGuard,
} from "./index.ts";
import {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadDestinationConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    type ResumableWriteStore,
    type SweepingWriteStore,
    type PrefixedUploadStore,
    type StoredUploadState,
    type CreateUploadOptions,
    type AppendChunkOptions,
    type AppendChunkResult,
    type UploadSweepCutoff,
    type CompleteUploadOptions,
    type CompletedUpload,
} from "./upload-store.ts";
import {
    assertUploadWritable,
    bytesToBase64,
    decodeUploadId,
    uploadIdForDiscard,
    isCount,
    newUploadId,
    isSweepable,
    requireSweepCutoff,
    admitAppend,
    pumpUploadBody,
    publishKeyGuard,
    toStoredState,
    corruptUploadState,
    UPLOAD_ID_RE,
    validatePersistedUploadShape,
    DEFAULT_UPLOAD_PREFIX,
} from "./upload-internals.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError };
export { UploadNotFoundError, UploadOffsetConflictError, UploadDestinationConflictError };
export { UploadAppendBoundError, UploadOverrunError };
export type {
    ResumableWriteStore,
    SweepingWriteStore,
    StoredUploadState,
    CreateUploadOptions,
    AppendChunkOptions,
    AppendChunkResult,
    UploadSweepCutoff,
    CompleteUploadOptions,
    CompletedUpload,
};

// ─── R2 Types ───────────────────────────────────────────────────────────────

/**
 * Minimal R2Bucket interface from Cloudflare Workers types.
 *
 * Declared locally to avoid a dependency on `@cloudflare/workers-types`.
 * The shapes match the runtime behavior; type-checking is the caller's
 * responsibility (their Worker project imports the full types).
 */
export interface R2Bucket {
    head(key: string): Promise<R2Object | null>;
    /**
     * With `onlyIf`, a failed precondition resolves to a body-less `R2Object`
     * (not null, not an error) -- callers must check for `body`.
     */
    get(key: string, options?: R2GetOptions): Promise<R2Object | R2ObjectBody | null>;
}

export interface R2Object {
    key: string;
    size: number;
    etag: string;
    uploaded: Date;
    checksums: R2Checksums;
    httpMetadata?: R2HttpMetadata;
}

export interface R2ObjectBody extends R2Object {
    body: ReadableStream<Uint8Array>;
    /** The span returned; the binding reports it for ranged reads only. */
    range?: R2Range;
}

export interface R2Range {
    offset: number;
    length: number;
}

export interface R2GetOptions {
    // `length` is optional in the real R2 binding: offset alone reads to the
    // end of the object (the open-ended fast-path form).
    range?: { offset: number; length?: number };
    onlyIf?: { etagMatches?: string };
}

export interface R2Checksums {
    sha256?: ArrayBuffer;
}

export interface R2HttpMetadata {
    contentType?: string;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface R2StoreOptions {
    /**
     * Key prefix this store refuses to serve, because it is where an upload
     * store sharing this location keeps its in-flight bytes and the sidecars
     * naming their destination keys. Keys at or under it answer
     * {@link ObjectNotFoundError}. Set to `""` when no upload store shares it.
     * @default ".partial-content-uploads/"
     */
    reservedPrefix?: string;
    /** The R2 bucket binding from the Worker environment. */
    bucket: R2Bucket;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * The validators every read reports: the last-modified date, and the SHA-256
 * checksum as base64 for RFC 9530 Repr-Digest.
 *
 * `checksums.sha256` is R2's whole-object SHA-256 as raw bytes, so unlike the
 * S3 adapter there is no `<base64>-<partCount>` composite string form to
 * reject: a 32-byte buffer always describes the full representation. If R2
 * ever exposes a per-part checksum in this field, this digest would need the
 * same whole-object guard S3 applies.
 */
function validatorsOf(obj: R2Object): { lastModified: string; digest: string | undefined } {
    const { sha256 } = obj.checksums;
    return {
        lastModified: obj.uploaded.toUTCString(),
        digest: sha256 ? bytesToBase64(new Uint8Array(sha256)) : undefined,
    };
}

/**
 * The binding's form of a parsed range. An open-ended fast-path range
 * (OPEN_ENDED sentinel end) reads to the end of the object: offset alone, so
 * R2 streams the tail rather than being asked for a ~9e15 length.
 */
function r2RangeOf(range: ParsedRange): { offset: number; length?: number } {
    return isOpenEndedRange(range)
        ? { offset: range.start }
        : { offset: range.start, length: range.end - range.start + 1 };
}

/** The get options for a read, or `undefined` for a plain whole-object read. */
function getOptionsOf(range: ParsedRange | undefined, ifMatch: string | undefined): R2GetOptions | undefined {
    if (range === undefined && !ifMatch) return undefined;
    return {
        ...(range ? { range: r2RangeOf(range) } : {}),
        // Pin the read to the validated representation. On mismatch R2
        // returns the object WITHOUT a body (checked by the caller).
        ...(ifMatch ? { onlyIf: { etagMatches: ifMatch } } : {}),
    };
}

/**
 * The span a ranged read actually returned. Content-Range must report what R2
 * returned, not what was requested: `body.range` is R2's authoritative
 * offset/length, and if R2 clamped the range (the object changed between HEAD
 * and GET), reporting the request would corrupt the client's bytes. The
 * request is the answer only where the binding reports no range.
 */
function servedSpan(body: R2ObjectBody, range: ParsedRange): { start: number; length: number } {
    return {
        start: body.range?.offset ?? range.start,
        length: body.range?.length ?? r2RangeOf(range).length ?? body.size - range.start,
    };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} backed by a Cloudflare R2 bucket.
 *
 * @example
 * ```typescript
 * import { r2Store } from "partial-content/r2";
 *
 * export default {
 *   async fetch(request, env) {
 *     const store = r2Store({ bucket: env.MY_BUCKET });
 *     const meta = await store.headObject("reports/q4.pdf");
 *     // ...
 *   },
 * };
 * ```
 */
export function r2Store(opts: R2StoreOptions): ObjectStore {
    const { bucket } = opts;
    const assertReadable = reservedKeyGuard(opts.reservedPrefix ?? DEFAULT_UPLOAD_PREFIX);

    // No `classifyStoreRead` here (unlike s3/gcs/azure): the R2 Workers binding
    // signals its recoverable outcomes structurally, not as classifiable errors.
    // Not-found is a `null` return, a failed `onlyIf` pin is a body-less object,
    // and both are handled inline below. R2 exposes NO documented throttle/503
    // error shape on the native binding (rate limiting surfaces at the Workers
    // platform layer, before the handler runs), so there is nothing to map to
    // `StoreUnavailableError`. Inventing a classifier for an undocumented error
    // shape would be guessing; the README correctly omits R2 from the throttle-
    // classification list. Use `partial-content/s3` (R2's S3 endpoint) if you
    // need SlowDown/429 -> 503 mapping.
    return {
        supportsRange: true,
        // 206 bounds/total come from the R2ObjectBody's actual size/offset: the
        // orchestrator may skip the validating HEAD for plain range requests.
        authoritativeRange: true,

        async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
            assertReadable(key);
            opts?.signal?.throwIfAborted();
            const obj = await bucket.head(key);
            if (!obj) throw new ObjectNotFoundError(key);

            return {
                contentLength: obj.size,
                etag: obj.etag,
                ...validatorsOf(obj),
            };
        },

        async getObject(
            key: string,
            opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string },
        ): Promise<ObjectStream> {
            assertReadable(key);
            const { range, ifMatch } = opts ?? {};
            opts?.signal?.throwIfAborted();

            const obj = await bucket.get(key, getOptionsOf(range, ifMatch));
            if (!obj) throw new ObjectNotFoundError(key);

            // onlyIf precondition failed: R2 resolves with metadata but no body.
            if (!("body" in obj) || !obj.body) {
                throw new ObjectChangedError(key);
            }

            const span = range && servedSpan(obj, range);
            const contentLength = span ? span.length : obj.size;

            return {
                // Guard the committed length: if R2 ever ends the body short of the
                // computed contentLength, error the stream rather than under-run it.
                body: guardStreamLength(obj.body, contentLength),
                contentLength,
                totalSize: obj.size,
                range: span && { start: span.start, end: span.start + span.length - 1 },
                etag: obj.etag,
                ...validatorsOf(obj),
            };
        },
    };
}

// ─── Resumable Upload: R2 Types ─────────────────────────────────────────────

/**
 * The bucket surface the upload store needs from the native Workers binding.
 * Declared locally (like the read side's {@link R2Bucket}) to avoid a
 * dependency on `@cloudflare/workers-types`; `env.MY_BUCKET` satisfies it
 * structurally.
 */
interface R2UploadBucket {
    head(key: string): Promise<R2UploadHead | null>;
    get(key: string): Promise<{ etag: string; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
    /**
     * Resolves `null` when `onlyIf` is given and refuses the write: an
     * `etagMatches` the object does not carry, or an `etagDoesNotMatch` of
     * `"*"` while any object exists at the key.
     */
    put(
        key: string,
        value: Uint8Array | string,
        options?: {
            onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
            customMetadata?: Record<string, string>;
        },
    ): Promise<{ etag: string } | null>;
    delete(key: string): Promise<void>;
    list(options?: {
        prefix?: string;
        cursor?: string;
    }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
    /** `customMetadata` is stamped on the object the upload's `complete()` publishes. */
    createMultipartUpload(
        key: string,
        options?: { customMetadata?: Record<string, string> },
    ): Promise<R2MultipartUploadHandle>;
    /** Synchronous in the real binding: errors surface on the handle's methods. */
    resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadHandle;
}

interface R2UploadHead {
    etag: string;
    customMetadata?: Record<string, string>;
}

interface R2MultipartUploadHandle {
    uploadId: string;
    uploadPart(partNumber: number, value: Uint8Array): Promise<{ partNumber: number; etag: string }>;
    complete(uploadedParts: Array<{ partNumber: number; etag: string }>): Promise<{ etag: string }>;
    abort(): Promise<void>;
}

// ─── Resumable Upload: Options ──────────────────────────────────────────────

export interface R2UploadStoreOptions {
    /** The R2 bucket binding from the Worker environment. */
    bucket: R2UploadBucket;
    /** Object-key prefix for the store's `.manifest` bookkeeping objects. */
    uploadPrefix?: string;
    /**
     * Fixed size of every non-final multipart part (default 5 MiB, R2's
     * minimum). R2 requires all non-final parts of one upload to be the SAME
     * size, so appends cut parts of exactly this size and park the remainder;
     * the value is persisted in the manifest at creation and later option
     * changes never tear an in-flight upload.
     */
    partSize?: number;
}

// ─── Resumable Upload: Internal Constants + Codecs ──────────────────────────

/** R2's minimum non-final part size, and the default uniform part size. */
const R2_DEFAULT_PART_SIZE = 5 * 1024 * 1024;
/**
 * R2 (like S3) caps a multipart upload at 10,000 parts, all but the last of
 * one size. A length known at creation raises the upload's part size so the
 * whole representation fits; a deferred length keeps `partSize`, so its
 * upload holds at most 10,000 parts of it and an append past that is refused
 * as a non-fatal append bound.
 */
const R2_MAX_PART_NUMBER = 10_000;
/** The largest part R2 accepts: 5 GiB. */
const R2_MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;

/** One accepted part, exactly as recorded after its upload. */
interface R2ManifestPart {
    partNumber: number;
    etag: string;
    size: number;
}

/**
 * The adapter's own durable part ledger (the binding has NO ListParts).
 * Persisted as JSON at `<uploadPrefix>/<id>.manifest` and REWRITTEN after
 * every accepted part, so the recorded parts are always a durable prefix of
 * what actually landed.
 */
interface R2PersistedManifest {
    key: string;
    uploadId: string;
    partSize: number;
    length?: number;
    metadata?: Record<string, string>;
    createdAt: number;
    expiresAt?: number;
    lastAppendAt?: number;
    isComplete: boolean;
    isInvalidated: boolean;
    /**
     * The upload is sealed: a completion fixed its plan, and every append
     * refuses from here on. Kept a boolean, with the plan's details in
     * `seal`, so a manifest a build without `seal` reads still decodes.
     */
    completing?: boolean;
    /**
     * What the seal fixed: the plan's length, and the ETag of the object the
     * key held when the upload was first sealed (`null` for none), which is
     * the only destination state the publish may replace.
     */
    seal?: { length: number; destination: string | null };
    /**
     * Random publication identity, stamped as custom metadata on the object
     * this upload publishes. It is never the upload token, which is a
     * capability: object metadata is readable by anyone who can read the key.
     */
    publicationId?: string;
    /** Recorded at completion for idempotent-retry answers. */
    etag?: string;
    parts: R2ManifestPart[];
    /**
     * The parked remainder that follows the parts: shorter than a part, so it
     * cannot be one until it is the last. Stored at `<id>.<tail id>.part`, a
     * name no other write reuses, so the manifest write that names a tail is
     * the one conditional write that replaces the previous tail.
     */
    tail?: { id: string; size: number };
}

/**
 * A persisted sub-record as the decoder sees it. Optional chaining reads
 * `undefined` off null and primitives, which every check below refuses.
 */
type ManifestFields =
    | { partNumber?: unknown; etag?: unknown; size?: unknown; id?: unknown; length?: unknown; destination?: unknown }
    | null
    | undefined;

const isManifestPart = (v: ManifestFields): boolean =>
    isCount(v?.partNumber) && v.partNumber !== 0 && typeof v.etag === "string" && isCount(v.size);

/** The tail id becomes part of an object key, so only a minted shape is accepted. */
const isManifestTail = (v: ManifestFields): boolean =>
    v === undefined || (UPLOAD_ID_RE.test(String(v?.id)) && isCount(v?.size));

const isManifestSeal = (v: ManifestFields): boolean =>
    v === undefined || (isCount(v?.length) && (v.destination === null || typeof v.destination === "string"));

/** The fields only this adapter persists; the shared ones are gated by validatePersistedUploadShape. */
const isR2ManifestShape = (c: Record<string, unknown>): boolean =>
    typeof c.uploadId === "string" &&
    c.uploadId.length > 0 &&
    isCount(c.partSize) &&
    c.partSize > 0 &&
    (c.completing === undefined || typeof c.completing === "boolean") &&
    isManifestSeal(c.seal as ManifestFields) &&
    (c.publicationId === undefined || (typeof c.publicationId === "string" && UPLOAD_ID_RE.test(c.publicationId))) &&
    Array.isArray(c.parts) &&
    c.parts.every(isManifestPart) &&
    isManifestTail(c.tail as ManifestFields);

/** Decode + shape-validate a manifest; null for corrupt values. */
function decodeR2Manifest(raw: string): R2PersistedManifest | null {
    let c: Record<string, unknown> | null;
    try {
        c = validatePersistedUploadShape(JSON.parse(raw)) as Record<string, unknown> | null;
    } catch {
        return null;
    }
    return c !== null && isR2ManifestShape(c) ? (c as unknown as R2PersistedManifest) : null;
}

/** The custom-metadata field that carries an upload's publication identity. */
const PUBLICATION_METADATA = "partial-content-publication";

/** The destination state a seal records and a publish is conditioned on: an ETag, or `null` for no object. */
const etagAt = (found: R2UploadHead | null): string | null => (found === null ? null : found.etag);

/** Whether the object at a key is the publication that carries `publicationId`. */
const carriesPublication = (found: R2UploadHead | null, publicationId: string): found is R2UploadHead =>
    found?.customMetadata?.[PUBLICATION_METADATA] === publicationId;

/** The binding's "multipart upload no longer exists" failure, by message. */
function isR2MultipartGone(err: unknown): boolean {
    return err instanceof Error && /does not exist|no such upload/i.test(err.message);
}

// ─── Resumable Upload: Factory ──────────────────────────────────────────────

/**
 * Create a {@link ResumableWriteStore} backed by Cloudflare R2's native
 * multipart binding (createMultipartUpload / uploadPart / complete / abort).
 *
 * The binding exposes NO ListParts, so the adapter keeps its OWN durable part
 * ledger: a `<uploadPrefix>/<id>.manifest` JSON object rewritten after EVERY
 * accepted part (part number, etag, size), and `getUploadState` derives the
 * offset from that manifest. The write ordering is always part first, then
 * manifest: a crash between the two orphans the just-uploaded part and the
 * derived offset honestly EXCLUDES it (the part slot is simply re-uploaded on
 * resume; same-number uploads replace). That honesty has a hard limit, and it
 * is why `exactOffsetRecovery` is FALSE: the manifest is the adapter's own
 * bookkeeping, not backend-derived truth, and with no ListParts the binding
 * offers nothing to cross-check it against. The flag declares that, so a
 * consumer weighing backends knows a resume here may re-send the tail of one
 * chunk; no engine behavior keys off it.
 *
 * Part sizing: R2 requires every non-final part of an upload to be the SAME
 * size (`uniformPartSize: true`), minimum 5 MiB. Appends cut parts of exactly
 * `partSize`, and a remainder below it (an append of any length, or a body
 * that died or was preempted) is parked as a tail object the manifest names,
 * so every received byte is durable and counted. The next append carries the
 * tail into its first part, and completion uploads a tail still parked as
 * the short final part R2 permits. A tail stops being named only by the same
 * manifest write that counts its bytes elsewhere, so the derived offset never
 * decreases, and an append that carries no bytes never touches it.
 *
 * `completeUpload` is a sealed plan. One conditional manifest write marks the
 * upload `completing` at the expected length and records the ETag of the
 * object at the key (or its absence); from then on every append refuses, and
 * the manifest's parts plus the parked tail are the whole plan. The publish
 * goes through the binding's `complete()` (nothing is visible until it
 * returns), after a check that the key still holds the recorded state; a key
 * written since is an {@link UploadDestinationConflictError} and is left
 * alone. The binding's `complete()` takes no precondition, so that check is
 * not atomic with the publish: an object written in the instant between them
 * is overwritten. A zero-byte upload is published by a `put` carrying the
 * binding's own `onlyIf` precondition instead, which has no such window.
 *
 * Every published object carries a random publication id in its custom
 * metadata (minted at creation, because the binding fixes a multipart
 * object's metadata then). A completion retried after the record was lost
 * adopts the object at the key only when it carries that id; a same-size
 * object written by anyone else is a destination conflict, never "already
 * published". A custom bucket's `head()` must therefore return
 * `customMetadata`.
 *
 * GC: R2's default lifecycle aborts incomplete multipart uploads 7 days
 * after creation, so abandoned PART DATA reaps itself; schedule
 * {@link ResumableWriteStore.sweepExpired} to reap the manifest and tail objects (it
 * also aborts still-live multipart state when it gets there first).
 *
 * `digestOnComplete` is `false`: multipart etags are not content hashes and
 * the binding exposes no whole-object SHA-256 for multipart uploads, so a
 * passed `expectedDigests` throws a clear error; the orchestrator reads the
 * flag and verifies upstream instead.
 *
 * @example
 * ```typescript
 * import { r2UploadStore } from "partial-content/r2";
 *
 * export default {
 *   async fetch(request, env) {
 *     const store = r2UploadStore({ bucket: env.MY_BUCKET });
 *     // ...
 *   },
 * };
 * ```
 */
export function r2UploadStore(opts: R2UploadStoreOptions): PrefixedUploadStore {
    const { bucket } = opts;
    const prefix = (opts.uploadPrefix ?? DEFAULT_UPLOAD_PREFIX).replace(/\/+$/, "");
    const assertPublishable = publishKeyGuard(`${prefix}/`);
    const partSize = opts.partSize ?? R2_DEFAULT_PART_SIZE;
    if (!Number.isSafeInteger(partSize) || partSize <= 0) {
        throw new RangeError(`r2UploadStore: partSize must be a positive integer, got ${partSize}`);
    }

    const manifestName = (id: string): string => `${prefix}/${id}.manifest`;

    /**
     * Write the manifest, pinned to the version this writer last read or wrote.
     * Returns the new version for the next write in the same call.
     *
     * The manifest IS the offset ledger, so two holders each holding their own
     * parts array cannot be merged, only ordered: the write carries `onlyIf`
     * with the ETag the writer holds, and a holder whose lock was stolen while
     * its body streamed loses the precondition instead of overwriting the
     * winner's parts. The binding reports a failed precondition as a `null`
     * result rather than an error. The loser is answered as the contract
     * answers every stale writer, with an offset conflict carrying the winner's
     * durable offset, read fresh.
     */
    async function putManifest(
        id: string,
        manifest: R2PersistedManifest,
        version: string,
        uploadToken: string,
    ): Promise<string> {
        const result = await bucket.put(manifestName(id), JSON.stringify(manifest), {
            onlyIf: { etagMatches: version },
        });
        return result?.etag ?? refuseStale(uploadToken);
    }

    /**
     * Answer a holder whose view of the manifest is stale with the winner's
     * durable offset, read fresh; not-found when the manifest is gone. A
     * `lostTail` the current manifest still names was lost by the bucket, not
     * replaced by a winner, and fails loudly instead.
     */
    async function refuseStale(uploadToken: string, lostTail?: string): Promise<never> {
        const { manifest } = await readUpload(uploadToken);
        if (lostTail !== undefined && manifest.tail?.id === lostTail) {
            throw new Error("r2UploadStore: the parked upload tail is missing");
        }
        throw new UploadOffsetConflictError(uploadToken, durableOffsetOf(manifest));
    }

    /** Read + validate the manifest behind a token, with its version. Throws 404-shaped. */
    async function readUpload(
        uploadToken: string,
    ): Promise<{ manifest: R2PersistedManifest; id: string; version: string }> {
        const id = decodeUploadId(uploadToken);
        const obj = await bucket.get(manifestName(id));
        if (!obj) throw new UploadNotFoundError(uploadToken);
        const manifest = decodeR2Manifest(await obj.text());
        // Corrupt bookkeeping answers 404, marked as damage for the operator.
        // There is no key to reconcile here: the token carries none, so the
        // persisted key is the only one that exists.
        if (!manifest) throw corruptUploadState(uploadToken);
        return { manifest, id, version: obj.etag };
    }

    function durableOffsetOf(manifest: R2PersistedManifest): number {
        return manifest.parts.reduce((sum, part) => sum + part.size, manifest.tail?.size ?? 0);
    }

    const tailName = (id: string, tailId: string): string => `${prefix}/${id}.${tailId}.part`;

    /**
     * The parked tail's bytes. A tail gone from under the manifest the caller
     * read was replaced by a newer holder, which makes the caller the stale
     * one; a tail the current manifest still names and the bucket lost is
     * lost acknowledged data, and fails loudly.
     */
    async function readTail(id: string, tail: { id: string; size: number }, uploadToken: string): Promise<Uint8Array> {
        const obj = await bucket.get(tailName(id, tail.id));
        const bytes = obj === null ? undefined : new Uint8Array(await obj.arrayBuffer());
        return bytes?.length === tail.size ? bytes : refuseStale(uploadToken, tail.id);
    }

    /**
     * Load the upload an append targets and check the append may proceed.
     *
     * A sealed upload refuses here. That check alone would leave a seal that
     * lands while the body streams, and the second half of the fence is the
     * manifest write itself: every write an append makes is pinned to the
     * version it holds, which descends from this unsealed one, so a seal
     * written in between fails the append's next write and it answers an
     * offset conflict instead of acknowledging. The write that makes an
     * append's bytes count is therefore also its re-check of the seal, after
     * the part is durable and before the append returns.
     */
    async function openAppend(uploadToken: string, offset: number) {
        const loaded = await readUpload(uploadToken);
        assertUploadWritable(loaded.manifest, "append");
        // Required by the store contract: the lock serializes writers but
        // cannot prove the writer still holds it, so verifying the claim here
        // is what makes a stolen-lock write loud instead of silently
        // interleaved. The manifest was needed anyway, so it costs nothing.
        const durableOffset = durableOffsetOf(loaded.manifest);
        if (offset !== durableOffset || loaded.manifest.completing === true) {
            throw new UploadOffsetConflictError(uploadToken, durableOffset);
        }
        return loaded;
    }

    const nextPartNumberOf = (manifest: R2PersistedManifest): number =>
        manifest.parts.reduce((max, part) => Math.max(max, part.partNumber), 0) + 1;

    /**
     * Remove tails no manifest names any more. Best-effort by design: the
     * write that stopped naming them already succeeded, and a tail left
     * behind is reclaimed when its upload is aborted or swept.
     */
    const dropTails = (id: string, tailIds: string[]): Promise<unknown> =>
        Promise.all(tailIds.map((tailId) => bucket.delete(tailName(id, tailId)).catch(() => undefined)));

    /**
     * Abort a multipart upload. Only "already gone" (lifecycle GC, a previous
     * abort) is done: any other failure leaves the parts stored, and reporting
     * that as a discard would claim an erasure that did not happen.
     */
    async function abortMultipart(key: string, uploadId: string): Promise<void> {
        try {
            await bucket.resumeMultipartUpload(key, uploadId).abort();
        } catch (err) {
            if (!isR2MultipartGone(err)) throw err;
        }
    }

    /**
     * Retire an upload: its multipart upload unless it published, every tail
     * object under its id (named or orphaned), then the manifest. The
     * manifest goes last, so a discard that fails midway is found again.
     */
    async function discard(id: string, manifest: R2PersistedManifest | null): Promise<void> {
        if (manifest && !manifest.isComplete) await abortMultipart(manifest.key, manifest.uploadId);
        let cursor: string | undefined;
        do {
            const page = await bucket.list({ prefix: `${prefix}/${id}.`, cursor });
            for (const object of page.objects) {
                if (object.key.endsWith(".part")) await bucket.delete(object.key);
            }
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor !== undefined);
        await bucket.delete(manifestName(id));
    }

    /**
     * SNAPSHOT and SEAL. The manifest is the plan, and every write to it is
     * pinned to the version its writer read, so the seal is pinned to exactly
     * the plan checked here: no append lands between the two. A plan of
     * another length lifts a seal already present, which leaves the upload
     * resumable (a parked tail is never folded into the parts before the
     * publish, so the parts stay uniform). A seal already present is adopted;
     * one at another length is re-pointed, keeping the destination its first
     * sealing found, because the object at the key now may be this upload's.
     */
    async function sealPlan(
        id: string,
        manifest: R2PersistedManifest,
        version: string,
        uploadToken: string,
        expectedLength: number,
    ): Promise<{ seal: { destination: string | null }; publicationId: string; version: string }> {
        const planned = durableOffsetOf(manifest);
        if (planned !== expectedLength) {
            if (manifest.completing === true) {
                await putManifest(id, { ...manifest, completing: undefined, seal: undefined }, version, uploadToken);
            }
            throw new UploadOffsetConflictError(uploadToken, planned);
        }
        const found = manifest.completing === true ? manifest.seal : undefined;
        let sealedAt = version;
        if (found?.length !== expectedLength) {
            manifest.seal = {
                length: expectedLength,
                destination: found === undefined ? etagAt(await bucket.head(manifest.key)) : found.destination,
            };
            manifest.completing = true;
            // An upload created before identities were minted gets one here.
            // Its multipart object cannot carry it (the binding fixed the
            // metadata at creation), so a lost multipart publish of such an
            // upload is never adopted, which is the fail-closed answer.
            manifest.publicationId ??= newUploadId();
            sealedAt = await putManifest(id, manifest, version, uploadToken);
        }
        const { seal, publicationId } = manifest;
        // Every seal is written with an identity, so a sealed manifest without
        // one is damage, and matching against a missing id would adopt any
        // object that carries no metadata at all.
        if (seal === undefined || publicationId === undefined) throw corruptUploadState(uploadToken);
        return { seal, publicationId, version: sealedAt };
    }

    /**
     * Zero-byte publish: multipart needs at least one part, so an empty object
     * is put directly, under the binding's precondition on the sealed
     * destination state. Returns the published ETag.
     */
    async function publishEmpty(
        manifest: R2PersistedManifest,
        uploadToken: string,
        destination: string | null,
        publicationId: string,
    ): Promise<string> {
        const put = await bucket.put(manifest.key, new Uint8Array(0), {
            onlyIf: destination === null ? { etagDoesNotMatch: "*" } : { etagMatches: destination },
            customMetadata: { [PUBLICATION_METADATA]: publicationId },
        });
        if (put === null) throw new UploadDestinationConflictError(uploadToken);
        // The publish stands either way: a multipart upload with no parts
        // holds no bytes, and the bucket's lifecycle rule reaps it.
        await abortMultipart(manifest.key, manifest.uploadId).catch(() => undefined);
        return put.etag;
    }

    /**
     * Publish the sealed plan through the multipart upload. Returns the ETag
     * of this upload's object at the key, whether this call published it or
     * an earlier attempt whose record was lost did.
     *
     * descope: the binding's multipart complete() takes no precondition (R2
     * Workers API: R2MultipartUpload.complete(uploadedParts)), so the caller's
     * check of the key is the last word on the destination, and an object
     * written in the instant between it and complete() is overwritten;
     * revisit when complete() accepts onlyIf.
     */
    async function publishMultipart(
        id: string,
        manifest: R2PersistedManifest,
        uploadToken: string,
        destination: string | null,
        publicationId: string,
    ): Promise<string> {
        const mpu = bucket.resumeMultipartUpload(manifest.key, manifest.uploadId);
        const parts = manifest.parts.map(({ partNumber, etag }) => ({ partNumber, etag }));
        try {
            if (manifest.tail !== undefined) {
                // The parked tail is the one short final part R2 permits. It is
                // uploaded on every attempt and never recorded as a part, so the
                // manifest's parts stay uniform whatever happens next.
                const tailBytes = await readTail(id, manifest.tail, uploadToken);
                parts.push(await mpu.uploadPart(nextPartNumberOf(manifest), tailBytes));
            }
            return (await mpu.complete(parts.toSorted((a, b) => a.partNumber - b.partNumber))).etag;
        } catch (err) {
            if (!isR2MultipartGone(err)) throw err;
            // The multipart upload is gone: either this upload's earlier
            // complete() landed and its record was lost, or the upload was
            // reaped. Only the identity tells them apart.
            const after = await bucket.head(manifest.key);
            if (carriesPublication(after, publicationId)) return after.etag;
            if (etagAt(after) !== destination) throw new UploadDestinationConflictError(uploadToken, err);
            throw err;
        }
    }

    /**
     * Reclaim one listed object under the upload prefix if it is due. Returns
     * whether a resource was removed; objects that are not this store's
     * bookkeeping are left alone.
     */
    async function sweepObject(objectKey: string, cutoff: UploadSweepCutoff): Promise<boolean> {
        // Every bookkeeping name starts with the fixed-length upload id.
        const id = objectKey.slice(prefix.length + 1, prefix.length + 37);
        if (!UPLOAD_ID_RE.test(id)) return false;
        if (objectKey.endsWith(".part")) {
            // A tail is reclaimed with its upload. One whose manifest is gone is
            // reached by nothing else. A tail's name sorts before its manifest's
            // (hex below "m"), so an upload this pass reaps still has its
            // manifest here and is counted once.
            if (await bucket.head(manifestName(id))) return false;
            await bucket.delete(objectKey);
            return true;
        }
        if (objectKey !== manifestName(id)) return false;
        const obj = await bucket.get(objectKey);
        if (!obj) return false; // raced another sweeper/abort
        const manifest = decodeR2Manifest(await obj.text());
        // A corrupt manifest is already unusable (state reads answer 404), so it
        // is swept regardless of age. R2's default lifecycle aborts the multipart
        // upload after 7 days on its own; aborting here reclaims parts earlier.
        if (manifest && !isSweepable(cutoff, manifest.createdAt, manifest.lastAppendAt)) return false;
        await discard(id, manifest);
        return true;
    }

    return {
        appendGranularity: partSize,
        uniformPartSize: true,
        exactOffsetRecovery: false,
        atomicCompletion: true,
        /** Every append verifies the claimed offset against durable state before writing. */
        enforcesOffsetCheck: true,
        digestOnComplete: false,
        uploadPrefix: prefix,

        async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
            createOpts.signal?.throwIfAborted();
            assertPublishable(createOpts.key);
            const { length } = createOpts;
            if (length !== undefined && length > R2_MAX_PART_NUMBER * R2_MAX_PART_SIZE) {
                throw new RangeError(`r2UploadStore: the upload does not fit R2's ${R2_MAX_PART_NUMBER}-part limit`);
            }
            const id = newUploadId();
            // The publication identity rides on the multipart upload, because
            // the binding fixes an object's metadata when the upload is created.
            const publicationId = newUploadId();
            // Multipart upload FIRST, manifest second: the reverse order could
            // mint a resource whose multipart upload never existed. A failed
            // manifest write aborts the multipart upload below; a crash leaves it
            // to R2's default lifecycle, which aborts it after 7 days.
            const mpu = await bucket.createMultipartUpload(createOpts.key, {
                customMetadata: { [PUBLICATION_METADATA]: publicationId },
            });
            const manifest: R2PersistedManifest = {
                key: createOpts.key,
                uploadId: mpu.uploadId,
                publicationId,
                // Never above R2's part maximum: the length check above bounds it.
                partSize: Math.max(partSize, Math.ceil((length ?? 0) / R2_MAX_PART_NUMBER)),
                length,
                metadata: createOpts.metadata,
                createdAt: createOpts.now,
                expiresAt: createOpts.expiresAt,
                isComplete: false,
                isInvalidated: false,
                parts: [],
            };
            // A freshly minted id names no existing manifest, so there is no
            // version to pin the creation to.
            try {
                await bucket.put(manifestName(id), JSON.stringify(manifest));
            } catch (err) {
                // Without its manifest the upload is unreachable: abort it rather
                // than leak its multipart upload until the lifecycle rule fires.
                // The manifest failure is what the caller hears.
                await abortMultipart(createOpts.key, mpu.uploadId).catch(() => undefined);
                throw err;
            }
            return { uploadToken: id };
        },

        async getUploadState(uploadToken: string, stateOpts?: { signal?: AbortSignal }): Promise<StoredUploadState> {
            stateOpts?.signal?.throwIfAborted();
            const { manifest } = await readUpload(uploadToken);
            return toStoredState(manifest, durableOffsetOf(manifest));
        },

        async appendChunk(
            uploadToken: string,
            offset: number,
            body: ReadableStream<Uint8Array> | Uint8Array,
            appendOpts: AppendChunkOptions,
        ): Promise<AppendChunkResult> {
            const admission = await admitAppend(body, appendOpts, () => openAppend(uploadToken, offset));
            if ("refused" in admission) return admission.refused;
            const { manifest, id, version: readVersion } = admission.admitted;
            let version = readVersion;
            const durableOffset = durableOffsetOf(manifest);
            // Deferred-length declaration: the first append to carry a length records
            // it in the manifest so the next getUploadState reports it and it turns
            // immutable. Only ever set once (the orchestrator guarantees it, and the
            // guard makes it safe): a length already recorded is never overwritten.
            // The mutation rides whichever putManifest below fires (a flushed part, or
            // the no-part-landed write), so it is durable before the ack either way.
            if (appendOpts.length !== undefined && manifest.length === undefined) {
                manifest.length = appendOpts.length;
            }
            const mpu = bucket.resumeMultipartUpload(manifest.key, manifest.uploadId);
            let nextPartNumber = nextPartNumberOf(manifest);
            const uniformSize = manifest.partSize;
            let unread = manifest.tail;
            // Bytes this append can take before it would need a part past the
            // ceiling; the parked tail already holds part of the next one.
            let room = (R2_MAX_PART_NUMBER + 1 - nextPartNumber) * uniformSize - (unread?.size ?? 0);

            let manifestTouched = false;
            // Exact-size part assembly: R2's uniform-part rule needs precise
            // splitting, not a flush threshold.
            let buffer = new Uint8Array(uniformSize);
            let buffered = 0;
            // Tails this append stopped naming, removed once its writes succeed.
            const stale: string[] = [];

            const commit = async (): Promise<void> => {
                manifest.lastAppendAt = appendOpts.now;
                version = await putManifest(id, manifest, version, uploadToken);
                manifestTouched = true;
            };

            const flushPart = async (bytes: Uint8Array): Promise<void> => {
                // Part FIRST, manifest second (the load-bearing ordering): a crash
                // between the two orphans this part and the offset honestly excludes
                // it; resume re-uploads the same part number, which replaces.
                const uploaded = await mpu.uploadPart(nextPartNumber, bytes);
                manifest.parts.push({ partNumber: nextPartNumber, etag: uploaded.etag, size: bytes.length });
                // A parked tail leads the first part, so the write that counts the
                // part stops counting the tail: its bytes count exactly once at
                // every instant, and the tail object is removed only afterwards.
                if (manifest.tail) stale.push(manifest.tail.id);
                manifest.tail = undefined;
                await commit();
                nextPartNumber += 1;
            };

            // The remainder is written under a fresh name, then named by one
            // manifest write pinned to the version this append holds. A holder
            // whose lock was stolen loses that write, and its tail is never named.
            const parkTail = async (bytes: Uint8Array): Promise<void> => {
                const tailId = newUploadId();
                await bucket.put(tailName(id, tailId), bytes);
                if (manifest.tail) stale.push(manifest.tail.id);
                manifest.tail = { id: tailId, size: bytes.length };
                try {
                    await commit();
                } catch (err) {
                    await dropTails(id, [tailId]);
                    throw err;
                }
            };

            const fill = async (chunk: Uint8Array): Promise<void> => {
                // The parked tail is read only once a byte arrives to follow it,
                // so an append that carries none never touches it.
                if (unread && chunk.length > 0) {
                    buffer.set(await readTail(id, unread, uploadToken));
                    buffered = unread.size;
                    unread = undefined;
                }
                let chunkOffset = 0;
                while (chunkOffset < chunk.length) {
                    const take = Math.min(uniformSize - buffered, chunk.length - chunkOffset);
                    buffer.set(chunk.subarray(chunkOffset, chunkOffset + take), buffered);
                    buffered += take;
                    chunkOffset += take;
                    if (buffered === uniformSize) {
                        await flushPart(buffer);
                        buffer = new Uint8Array(uniformSize);
                        buffered = 0;
                    }
                }
            };

            // The abort check, the body-death handling and both byte ceilings live in
            // pumpUploadBody; what stays here is the only part that is R2's, which is
            // filling a uniform-size part buffer.
            const { chunks, outcome, finalize } = pumpUploadBody(
                body,
                uploadToken,
                appendOpts,
                // Terminal-fault invalidation, recorded durably in the manifest so
                // every later interaction refuses. Awaited before the throw by the pump.
                async () => {
                    manifest.isInvalidated = true;
                    version = await putManifest(id, manifest, version, uploadToken);
                },
            );
            try {
                for await (const chunk of chunks) {
                    // The store's own ceiling, reported like the request's: a chunk
                    // that would need a part past the last is not taken.
                    room -= chunk.length;
                    if (room < 0) break;
                    await fill(chunk);
                }
                // Every received byte below a part boundary is parked, whether the
                // body ended, died or was preempted: a short part would break R2's
                // uniform-size rule unless it is the last, which only completion knows.
                if (buffered > 0) await parkTail(buffer.subarray(0, buffered));
                // Nothing written (a zero-byte body): still record the activity so
                // sweeps see a live upload, and any declared length.
                if (!manifestTouched) await commit();
            } finally {
                await finalize();
            }
            await dropTails(id, stale);
            const written = durableOffsetOf(manifest) - durableOffset;
            // Reported only after the accepted prefix is durable: the resource is
            // untouched, so the client resumes from here in smaller chunks.
            if (outcome.ceilingHit || room < 0) throw new UploadAppendBoundError(uploadToken, durableOffset + written);
            return { bytesWritten: written, interrupted: outcome.interrupted };
        },

        async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
            completeOpts.signal?.throwIfAborted();
            const { manifest, id, version: readVersion } = await readUpload(uploadToken);
            assertUploadWritable(manifest, "complete");
            if (manifest.isComplete) {
                return { etag: manifest.etag };
            }
            if (completeOpts.expectedDigests !== undefined) {
                // Orchestrators gate on digestOnComplete === false and never hand a
                // digest here; a digest anyway is a caller bug, never silently ignored.
                // R2 multipart uploads expose no whole-object SHA-256 to verify against.
                throw new Error("r2UploadStore: digestOnComplete is false");
            }
            const sealed = await sealPlan(id, manifest, readVersion, uploadToken, completeOpts.expectedLength);
            const { destination } = sealed.seal;
            // Recovery by identity, never by shape: an object at the key is this
            // upload's publication only when it carries this upload's id, and
            // anything else the seal did not record is someone else's.
            const current = await bucket.head(manifest.key);
            let etag: string;
            if (carriesPublication(current, sealed.publicationId)) {
                etag = current.etag;
            } else if (etagAt(current) !== destination) {
                throw new UploadDestinationConflictError(uploadToken);
            } else if (manifest.parts.length === 0 && manifest.tail === undefined) {
                etag = await publishEmpty(manifest, uploadToken, destination, sealed.publicationId);
            } else {
                etag = await publishMultipart(id, manifest, uploadToken, destination, sealed.publicationId);
            }
            // RECORD. A failure here leaves a published object carrying this
            // upload's identity, which the next completion adopts above.
            await putManifest(id, { ...manifest, isComplete: true, etag }, sealed.version, uploadToken);
            if (manifest.tail !== undefined) await dropTails(id, [manifest.tail.id]);
            return { etag };
        },

        async abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
            abortOpts?.signal?.throwIfAborted();
            const id = uploadIdForDiscard(uploadToken);
            if (id === null) return; // idempotent: the token named no resource
            const obj = await bucket.get(manifestName(id));
            // A completed upload's published object is live data: only the
            // bookkeeping goes. With no manifest left (already aborted or swept)
            // or a corrupt one, any tail objects under the id are all that remain.
            await discard(id, obj === null ? null : decodeR2Manifest(await obj.text()));
        },

        /**
         * One unreclaimable resource must not end the scan. A manifest read or
         * delete the binding rejects would, if propagated, abandon every resource
         * behind it in the listing, so a scheduled sweep could reclaim nothing
         * while reporting success by not throwing. Each manifest is isolated and
         * counted in `failed`, which is what a caller alerts on. The listing
         * itself is not isolated: a page that cannot be read leaves no resources
         * to attribute a failure to.
         */
        async sweepExpired(
            cutoff: UploadSweepCutoff,
            sweepOpts?: { signal?: AbortSignal },
        ): Promise<{ removed: number; failed: number }> {
            requireSweepCutoff(cutoff);
            let removed = 0;
            let failed = 0;
            let cursor: string | undefined;
            do {
                sweepOpts?.signal?.throwIfAborted();
                const page = await bucket.list({ prefix: `${prefix}/`, cursor });
                for (const object of page.objects) {
                    sweepOpts?.signal?.throwIfAborted();
                    try {
                        if (await sweepObject(object.key, cutoff)) removed += 1;
                    } catch {
                        // An abort is the caller ending the sweep, not this manifest
                        // resisting: it must reach them rather than be counted.
                        sweepOpts?.signal?.throwIfAborted();
                        // The manifest stays, so the next pass finds this resource again
                        // and retries both the multipart abort and the delete.
                        failed += 1;
                    }
                }
                cursor = page.truncated ? page.cursor : undefined;
            } while (cursor !== undefined);
            return { removed, failed };
        },
    };
}
