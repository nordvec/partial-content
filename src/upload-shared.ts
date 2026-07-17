/**
 * The surface both resumable-upload wire dialects (`/tus`, `/upload`) share:
 * the write-store contract, its errors, the lock, and the dialect-agnostic
 * orchestrator (for custom dialects). Each dialect re-exports this with
 * `export *`, so the two subpaths can never drift a single export apart, and
 * consumers never reach into internal module paths.
 *
 * @packageDocumentation
 */

export {
  UploadNotFoundError,
  UploadOffsetConflictError,
  UploadDigestMismatchError,
  isUploadNotFoundError,
  isUploadOffsetConflictError,
  isUploadDigestMismatchError,
} from "./upload-store.ts";
export type {
  ResumableWriteStore,
  StoredUploadState,
  CreateUploadOptions,
  AppendChunkOptions,
  CompleteUploadOptions,
  CompletedUpload,
} from "./upload-store.ts";
export { memoryUploadLocker, UploadLockTimeoutError, UPLOAD_PREEMPTED } from "./upload-locker.ts";
export type { UploadLocker, UploadLock, AcquireOptions } from "./upload-locker.ts";
export { createUploadOrchestrator } from "./upload-orchestrator.ts";
export type {
  UploadOrchestrator,
  UploadOrchestratorOptions,
  UploadOutcome,
  UploadResourceEvent,
  CreateUploadRequest,
  AppendUploadRequest,
} from "./upload-orchestrator.ts";
export type { UploadPolicy, UploadAuditEvent } from "./upload-engine.ts";

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
 * Every response header a cross-origin browser upload must be allowed to READ,
 * for an `Access-Control-Expose-Headers` value. This package does not ship CORS
 * middleware (the caller owns their CORS policy), but a resumable upload breaks
 * in non-obvious ways when the list is incomplete: expose `Location` but forget
 * `Upload-Offset` and a client cannot resume; forget `Upload-Expires` and it
 * cannot renew before expiry. Deriving the list by hand is exactly the step
 * that silently drops one header, so both dialects publish theirs here.
 *
 * Spread into your CORS layer:
 * ```typescript
 * "Access-Control-Expose-Headers": TUS_EXPOSED_HEADERS.join(", ")
 * ```
 *
 * The union covers both dialects and the checksum extension; a handler that
 * enables neither simply exposes a couple of headers it never sends, which is
 * harmless. Request-header allow-lists (`Access-Control-Allow-Headers`) are the
 * mirror image and remain the caller's to assemble from the same protocol
 * surface.
 */
export const TUS_EXPOSED_HEADERS: readonly string[] = Object.freeze([
  "Location",
  "Tus-Resumable",
  "Tus-Version",
  "Tus-Extension",
  "Tus-Max-Size",
  "Tus-Checksum-Algorithm",
  "Upload-Offset",
  "Upload-Length",
  "Upload-Defer-Length",
  "Upload-Metadata",
  "Upload-Expires",
  "Upload-Checksum",
]);

/**
 * The {@link TUS_EXPOSED_HEADERS} equivalent for the IETF resumable-uploads
 * dialect (`partial-content/upload`): the response headers a cross-origin
 * client must be allowed to read across interop versions 3/5/6.
 */
export const UPLOAD_EXPOSED_HEADERS: readonly string[] = Object.freeze([
  "Location",
  "Upload-Offset",
  "Upload-Length",
  "Upload-Complete",
  "Upload-Incomplete",
  "Upload-Draft-Interop-Version",
  "Upload-Limit",
  "Repr-Digest",
]);
