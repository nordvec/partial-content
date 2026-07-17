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
export { memoryUploadLocker, UploadLockTimeoutError } from "./upload-locker.ts";
export type { UploadLocker, UploadLock } from "./upload-locker.ts";
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
