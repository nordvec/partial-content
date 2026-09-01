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

import { UploadNotFoundError, type StoredUploadState } from "./upload-store.ts";

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
 * Decode base64url back to raw bytes. Padding is restored before decoding, so
 * the pair round-trips on any decoder: RFC 4648 Section 5 makes the padding
 * optional on the wire, not optional for the decoder that reads it back.
 */
export function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
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

/** Durable upload bookkeeping, the fields every object-store adapter persists. */
export interface PersistedUpload {
  key: string;
  length?: number;
  metadata?: Record<string, string>;
  createdAt: number;
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
    typeof c.key === "string" && c.key.length > 0 &&
    (c.length === undefined || isCount(c.length)) &&
    isCount(c.createdAt) &&
    (c.lastAppendAt === undefined || isCount(c.lastAppendAt)) &&
    typeof c.isComplete === "boolean" &&
    typeof c.isInvalidated === "boolean" &&
    (c.etag === undefined || typeof c.etag === "string") &&
    (c.metadata === undefined ||
      (typeof c.metadata === "object" && c.metadata !== null &&
        Object.values(c.metadata).every((v) => typeof v === "string")))
  ) {
    return c as unknown as PersistedUpload;
  }
  return null;
}

/** Project persisted bookkeeping plus a backend-derived offset into engine state. */
export function toStoredState(state: PersistedUpload, offset: number): StoredUploadState {
  return {
    key: state.key,
    offset,
    length: state.length,
    isComplete: state.isComplete,
    isInvalidated: state.isInvalidated,
    createdAt: state.createdAt,
    lastAppendAt: state.lastAppendAt,
    metadata: state.metadata,
  };
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
      throw new TypeError(
        `Upload key "${key}" is inside the reserved upload bookkeeping prefix "${bookkeepingPrefix}"`,
      );
    }
  };
}

// ─── Append Body ────────────────────────────────────────────────────────────

/** An append body, buffered or streaming. */
export type UploadBody = ReadableStream<Uint8Array> | Uint8Array;

/** Normalize an append body to an async chunk sequence; empty chunks are skipped. */
export async function* uploadBodyChunks(
  body: UploadBody,
): AsyncGenerator<Uint8Array, void, undefined> {
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
 * Drive an append body as a manually-advanced iterator, paired with the
 * cleanup an early exit owes it.
 *
 * Leaving the loop early does not finalize a manually-driven generator the way
 * `for await` does, and the generator releases the reader lock in its
 * `finally`. Skip `finalize` and the lock outlives the loop, which leaves the
 * caller's stream locked with no way to cancel it.
 *
 * `cancelBody` says whether finalizing also cancels the stream. A store that
 * cancels only at points it picks (an abort, a request ceiling, a thrown
 * error) passes false and calls {@link cancelUploadBody} at those points.
 */
export function openUploadBody(
  body: UploadBody,
  opts: { cancelBody: boolean },
): { iterator: AsyncIterator<Uint8Array, void, undefined>; finalize: () => Promise<void> } {
  const iterator = uploadBodyChunks(body)[Symbol.asyncIterator]();
  const finalize = async (): Promise<void> => {
    await Promise.resolve(iterator.return?.()).catch(() => undefined);
    if (opts.cancelBody) await cancelUploadBody(body);
  };
  return { iterator, finalize };
}

// ─── Capability redaction ───────────────────────────────────────────────────

/**
 * Replace an upload token with its audit key everywhere it appears in an error:
 * the message, an errno `path`, and the stack.
 *
 * `auditKey` promises the capability never reaches a log surface, and redacting
 * only the reported context leaves it in the error that same sink receives.
 * Scrubbing here holds the promise whatever the throw site did.
 *
 * The clone keeps the prototype and every own property descriptor, so
 * `instanceof`, `code`, `status` and `cause` survive.
 *
 * A missing token is not an error here: the reporting paths that call this run
 * before a token exists as well as after (a creation failure has nothing to
 * redact yet). Absent and empty both mean there is nothing to search for, so
 * the error is returned untouched. The alternative is a search for whatever the
 * absent token stringifies to, and "undefined" appears in real backend messages
 * constantly, which would substitute the audit key into unrelated text.
 */
export function redactUploadToken(
  err: unknown,
  uploadToken: string | undefined,
  auditKey: string,
): unknown {
  // Absent and empty are the same case: nothing to search for.
  if (!uploadToken || !(err instanceof Error)) return err;
  const path = (err as { path?: unknown }).path;
  const carriesToken = err.message.includes(uploadToken)
    || (typeof err.stack === "string" && err.stack.includes(uploadToken))
    || (typeof path === "string" && path.includes(uploadToken));
  if (!carriesToken) return err;

  const clone = Object.create(
    Object.getPrototypeOf(err) as object,
    Object.getOwnPropertyDescriptors(err),
  ) as Error;
  clone.message = err.message.replaceAll(uploadToken, auditKey);
  if (typeof err.stack === "string") clone.stack = err.stack.replaceAll(uploadToken, auditKey);
  if (typeof path === "string") {
    (clone as { path?: string }).path = path.replaceAll(uploadToken, auditKey);
  }
  return clone;
}
