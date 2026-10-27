/**
 * The surface both resumable-upload wire dialects (`/tus`, `/upload`) share:
 * the write-store contract, its errors, the lock, and the dialect-agnostic
 * orchestrator (for custom dialects). Each dialect re-exports this with
 * `export *`, so the two subpaths can never drift a single export apart, and
 * consumers never reach into internal module paths.
 *
 * @packageDocumentation
 */

import { isSha256Base64, sanitizeHeaderValue } from "./kernel.ts";

export {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadDestinationConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
    UploadDigestUnverifiableError,
    isUploadNotFoundError,
    isUploadOffsetConflictError,
    isUploadDestinationConflictError,
    isUploadAppendBoundError,
    isUploadOverrunError,
    isUploadDigestMismatchError,
    isUploadDigestUnverifiableError,
    UPLOAD_STORE_CONTRACT_VERSION,
} from "./upload-store.ts";
export type {
    UploadErrorCode,
    UploadDigestAlgorithm,
    UploadDigests,
    ResumableWriteStore,
    SweepingWriteStore,
    PrefixedUploadStore,
    StoredUploadState,
    UploadStateReadOptions,
    UploadStateSnapshot,
    CreateUploadOptions,
    AppendChunkOptions,
    AppendChunkResult,
    UploadSweepCutoff,
    CompleteUploadOptions,
    CompletedUpload,
    UploadClaim,
} from "./upload-store.ts";
export {
    memoryUploadLocker,
    UploadLockTimeoutError,
    isUploadLockTimeoutError,
    UPLOAD_PREEMPTED,
    UPLOAD_LEASE_LOST,
} from "./upload-locker.ts";
export type { UploadLocker, UploadLock, AcquireOptions } from "./upload-locker.ts";
export type { ProjectedError } from "./object-store.ts";
export { createUploadOrchestrator } from "./upload-orchestrator.ts";
export type {
    UploadOrchestrator,
    UploadOrchestratorOptions,
    UploadOutcome,
    UploadResourceEvent,
    CreateUploadRequest,
    AppendUploadRequest,
    UploadAuditKey,
    UploadAuditKeyContext,
    UploadKeyResolution,
    UploadKeyResult,
    UploadAuthorize,
    UploadAuthorizeContext,
    UploadAuthorizeTarget,
    UploadAuthorizer,
    UploadOperation,
    UploadPolicyResolver,
    UploadResourceOptions,
} from "./upload-orchestrator.ts";
export type {
    UploadPolicy,
    UploadAuditEvent,
    UploadRejectReason,
    FatalBoundReason,
    UploadStatus,
} from "./upload-engine.ts";

/**
 * Hardening headers on every dialect error response (4xx/5xx): no MIME
 * sniffing, no caching of an error, and an empty CSP so a body cannot be
 * interpreted as active content. Both dialects share this one definition so a
 * change to the security posture cannot land in one dialect and not the other.
 */
export const UPLOAD_ERROR_HEADERS: Readonly<Record<string, string>> = Object.freeze({
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
});

/**
 * Representation metadata for the object a completing upload just published,
 * as it appears on the completion outcome.
 */
export interface PublishedRepresentation {
    /** Raw base64 SHA-256 of the published bytes, when the store reported one. */
    digest?: string;
    /** Validator of the published object, when the backend reported one. */
    etag?: string;
}

/**
 * The response headers that describe the object a completing upload just
 * published: RFC 9530 `Repr-Digest` for the digest, RFC 9110 `ETag` for the
 * validator. Both dialects build them here so the response that says "your
 * upload landed" describes the same representation the read side will serve,
 * with the same values.
 *
 * Both fields are omitted when the outcome carries nothing for them, which is
 * the case for every non-completing append and for a store that neither
 * computes a digest nor reports a validator. Absence therefore means "not
 * asserted", never "asserted empty": a client that sent `Repr-Digest` and gets
 * none back knows its assertion was not verified against stored bytes, which
 * is the per-object answer to the question a static capability flag can only
 * answer per-endpoint. The dialects read no such flag for that reason.
 *
 * A store-supplied value is untrusted input on a header line and is treated
 * as one:
 *
 * - The digest must be the raw base64 of a 32-byte SHA-256, because that is
 *   the only thing `sha-256=:...:` may frame (RFC 9530 Section 3 makes the
 *   member value a Structured Fields Byte Sequence). Anything else emits no
 *   field at all: framing a malformed value produces a field recipients must
 *   discard at best, and a false integrity assertion at worst.
 * - The validator is stripped to RFC 9110 field-value bytes, the same
 *   treatment the read side gives a backend `ETag`, so the two surfaces
 *   cannot disagree about the validator of one object. A value left empty by
 *   that stripping emits no field.
 */
export function publishedRepresentationHeaders(published: PublishedRepresentation): Record<string, string> {
    const headers: Record<string, string> = {};
    if (published.digest !== undefined) {
        const digest = published.digest.trim();
        if (isSha256Base64(digest)) headers["Repr-Digest"] = `sha-256=:${digest}:`;
    }
    if (published.etag !== undefined) {
        const etag = sanitizeHeaderValue(published.etag);
        if (etag.length > 0) headers.ETag = etag;
    }
    return headers;
}
