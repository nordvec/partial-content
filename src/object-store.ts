/**
 * Storage backend contract for partial-content adapters.
 *
 * Implementations adapt a concrete store (S3, R2, Hetzner, GCS, fs) down to
 * this surface. The kernel and framework adapters depend only on these types,
 * never on a storage SDK.
 *
 * @packageDocumentation
 */
import { parseContentRange, type ParsedRange } from "./kernel.js";

// ─── Cancel Signal ──────────────────────────────────────────────────────────

/**
 * Structural type matching the standard `AbortSignal` interface.
 *
 * Using a structural type instead of the global `AbortSignal` keeps the kernel
 * free of DOM/lib dependencies. At call sites, `req.signal` (which is a real
 * `AbortSignal`) satisfies this interface automatically.
 */
export interface CancelSignal {
  readonly aborted: boolean;
  throwIfAborted(): void;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

// ─── Error Types ────────────────────────────────────────────────────────────

/**
 * Thrown when an object does not exist in a storage backend.
 *
 * All built-in adapters (S3, R2, GCS, Azure, fs) throw this error
 * for missing objects. Framework adapters (e.g. `partial-content/web`)
 * use the `status` property to distinguish "object not found" (404)
 * from a transiently unavailable backend (503, {@link StoreUnavailableError})
 * and other store failures (502).
 */
export class ObjectNotFoundError extends Error {
  /** HTTP status hint for downstream handlers. */
  readonly status = 404 as const;
  /** The storage key that was not found. */
  readonly key: string;

  constructor(key: string, cause?: unknown) {
    super(`Object not found: ${key}`);
    this.name = "ObjectNotFoundError";
    this.key = key;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Thrown when a pinned read ({@link GetObjectOptions.ifMatch}) finds the
 * object changed since its validator was captured.
 *
 * Adapters map their backend's native rejection to this error (S3 412
 * PreconditionFailed, R2 `onlyIf` body-less response, Azure 412
 * ConditionNotMet, GCS etag mismatch). The web adapter treats it as a
 * signal to re-validate the request against the object's new state.
 */
export class ObjectChangedError extends Error {
  /** HTTP status hint: the pinned read's precondition failed. */
  readonly status = 412 as const;
  /** The storage key whose object changed. */
  readonly key: string;

  constructor(key: string, cause?: unknown) {
    super(`Object changed since validation: ${key}`);
    this.name = "ObjectChangedError";
    this.key = key;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Thrown when a storage backend is transiently unavailable: overloaded,
 * throttling, or timing out after the adapter's own retries are exhausted.
 *
 * A generic store failure (a malformed response, an unparseable
 * `Content-Range`, an empty body) is reported by the framework adapter as
 * `502 Bad Gateway` -- "the upstream returned something invalid." This error
 * is the distinct RETRYABLE case: the upstream is healthy but momentarily
 * cannot serve. The web adapter maps it to `503 Service Unavailable` and, when
 * {@link retryAfterSeconds} is set, emits a `Retry-After` header so clients and
 * shared caches back off instead of hammering an origin that is already shedding
 * load. Adapters map their backend's throttle signals here (S3/R2/Hetzner
 * `503 SlowDown`, `429 TooManyRequests`, request timeouts).
 */
export class StoreUnavailableError extends Error {
  /** HTTP status hint: the backend is transiently unavailable. */
  readonly status = 503 as const;
  /** The storage key whose read failed. */
  readonly key: string;
  /**
   * Suggested back-off in whole seconds, echoed as `Retry-After`. Normalized at
   * construction: a non-negative finite hint is floored to an integer (a
   * fractional `2.9` -> `2`), and a NaN/negative/infinite/out-of-safe-range hint
   * (from a hostile backend header or a buggy third-party classifier) is dropped
   * entirely. So every consumer -- the web adapter AND anyone reading
   * `.retryAfterSeconds` directly off the frozen contract -- sees a clean
   * non-negative integer or `undefined`. Absent means the adapter emits `503`
   * without a `Retry-After` (RFC 9110 Section 15.6.4 permits its absence).
   */
  readonly retryAfterSeconds?: number;

  constructor(key: string, opts?: { retryAfterSeconds?: number; cause?: unknown }) {
    super(`Storage backend unavailable: ${key}`);
    this.name = "StoreUnavailableError";
    this.key = key;
    const hint = parseRetryAfterSeconds(opts?.retryAfterSeconds);
    if (hint !== undefined) this.retryAfterSeconds = hint;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * Normalize a `Retry-After` value to whole non-negative seconds, or `undefined`.
 *
 * The single sanctioned parser shared by every adapter and the web layer.
 * Accepts the delay-seconds form (a number, or a numeric string) and -- when
 * `allowHttpDate` is set -- the HTTP-date form (RFC 9110 Section 10.2.3) as a
 * non-negative delta from now. Everything else yields `undefined`: NaN,
 * Infinity, negatives, and any value whose floor exceeds `Number.MAX_SAFE_INTEGER`
 * (so a huge finite hint can never serialize as `1e+21`, which violates the
 * `delay-seconds = DIGIT+` grammar), plus non-numeric text. A hostile header or
 * a buggy third-party classifier therefore can never emit a malformed header.
 */
export function parseRetryAfterSeconds(
  raw: unknown,
  opts?: { allowHttpDate?: boolean },
): number | undefined {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return undefined;
    const floored = Math.floor(raw);
    return Number.isSafeInteger(floored) ? floored : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (opts?.allowHttpDate) {
    const when = Date.parse(trimmed);
    if (Number.isNaN(when)) return undefined;
    return Math.max(0, Math.round((when - Date.now()) / 1000));
  }
  return undefined;
}

// ─── Error Classification ─────────────────────────────────────────────────────

/**
 * Per-backend predicates that map a thrown SDK error to the contract's error
 * types. An adapter supplies one set and reuses it for both `headObject` and
 * `getObject`: a HEAD without a conditional never produces a `changed` (412),
 * so sharing the set costs nothing and keeps the two paths provably symmetric.
 */
export interface StoreErrorClassifiers {
  /** The object does not exist (maps to {@link ObjectNotFoundError}, 404). */
  notFound(err: unknown): boolean;
  /**
   * A pinned read's precondition failed (maps to {@link ObjectChangedError},
   * 412). Omit for backends whose pin is an etag/metadata comparison rather
   * than a native conditional error (e.g. GCS).
   */
  changed?(err: unknown): boolean;
  /**
   * Transient throttle/overload (maps to {@link StoreUnavailableError}, 503).
   * Return `true` for a throttle with no back-off hint, or
   * `{ retryAfterSeconds }` to surface a backend's `Retry-After` so the 503
   * echoes it and shared caches back off for the advised interval. Return
   * `false` when the error is not a throttle.
   */
  throttled(err: unknown): boolean | { retryAfterSeconds: number };
}

/**
 * Run a backend read and normalize its failures to the contract's error types.
 *
 * This is the single ordered classification pipeline every SDK-backed adapter
 * shares: `notFound` -> `changed` -> `throttled` -> rethrow. Centralizing it
 * means the "which errors are handled, in what order" contract is structural
 * rather than copy-pasted into each adapter's head/get catch blocks, so a
 * classifier can never be present on one path and silently missing on another.
 * The predicates MUST be mutually exclusive on a given backend (a 404, 412, and
 * 429/503 are distinct); the order only decides precedence if they are not.
 *
 * @example
 * ```typescript
 * const meta = await classifyStoreRead(key, () => client.headObject(key), {
 *   notFound: isNotFound,
 *   changed: isPreconditionFailed,
 *   throttled: isThrottled,
 * });
 * ```
 */
export async function classifyStoreRead<T>(
  key: string,
  op: () => Promise<T>,
  classifiers: StoreErrorClassifiers,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (classifiers.notFound(err)) throw new ObjectNotFoundError(key, err);
    if (classifiers.changed?.(err)) throw new ObjectChangedError(key, err);
    const throttled = classifiers.throttled(err);
    if (throttled) {
      throw new StoreUnavailableError(key, {
        cause: err,
        // `throttled` may return the backend's advised back-off; a bare `true`
        // means "throttled, no hint" and emits a 503 without `Retry-After`.
        retryAfterSeconds: typeof throttled === "object" ? throttled.retryAfterSeconds : undefined,
      });
    }
    throw err;
  }
}

// ─── Read Options ───────────────────────────────────────────────────────────

/** Options for `headObject`. */
export interface HeadObjectOptions {
  /**
   * Cancel signal. Pass `req.signal` to cancel the backend request when the
   * client disconnects.
   */
  signal?: CancelSignal;
}

/**
 * Options for `getObject`.
 *
 * `ifMatch` pins the read to the representation whose validator was captured
 * by a prior `headObject` -- pass the RAW backend ETag from
 * {@link ObjectMetadata.etag}, not a derived/formatted one, and only a
 * STRONG validator (never `W/`-prefixed). Adapters map it to their backend's
 * native conditional read (S3 `IfMatch`, R2 `onlyIf.etagMatches`, Azure
 * `conditions.ifMatch`, GCS etag + generation pinning), making the HEAD->GET
 * pair atomic: either the exact validated bytes are streamed, or the adapter
 * throws {@link ObjectChangedError}.
 */
export interface GetObjectOptions {
  /** Validated byte range to stream. Omit for full content. */
  range?: ParsedRange;
  /**
   * Cancel signal. Cancels the backend stream when the client disconnects,
   * preventing orphaned TCP connections.
   */
  signal?: CancelSignal;
  /** Raw backend ETag the object must still match (strong validators only). */
  ifMatch?: string;
  /**
   * Opaque pin token from a prior `headObject` on the same key
   * ({@link ObjectMetadata.pin}), passed back verbatim. Adapters that issue
   * pins use it to stream the exact validated representation without
   * re-fetching metadata; when the pinned version no longer exists they
   * throw {@link ObjectChangedError}. Adapters that never issue pins
   * ignore it.
   */
  pin?: string;
}

// ─── Node Stream Conversion ─────────────────────────────────────────────────

/**
 * Convert a Node.js readable stream (async iterable) to a web ReadableStream
 * with proper backpressure, Buffer coercion, signal propagation, and cleanup.
 *
 * This is the single implementation shared by all Node.js-based adapters
 * (fs, GCS, Azure, S3 fallback). It handles:
 *
 * - **Pull-based backpressure**: the web ReadableStream's `pull()` method
 *   drives the async iterator, so chunks are only read when the consumer
 *   is ready.
 * - **Buffer to Uint8Array coercion**: Node.js streams yield `Buffer`
 *   instances. We coerce to `Uint8Array` for cross-runtime compatibility
 *   (Buffer extends Uint8Array in Node, but the `instanceof` check
 *   ensures correctness in edge cases).
 * - **AbortSignal propagation**: when the client disconnects (signal aborts),
 *   the underlying node stream is destroyed immediately to stop I/O.
 * - **Cancel cleanup**: when the web ReadableStream is cancelled (e.g. by
 *   `Response.body.cancel()`), the node stream is destroyed.
 *
 * @param iterable - The async iterable (Node.js Readable stream). Typed
 *   `AsyncIterable<Uint8Array>` (Node `Buffer` extends `Uint8Array`, so Buffer
 *   streams satisfy it) to keep the `Buffer` name -- and its `@types/node`
 *   coupling -- out of the package's public type surface.
 * @param opts.destroy - Destroys the underlying stream on cancel/abort. When
 *   omitted, a `destroy()` method on the iterable is auto-detected and used.
 * @param opts.signal - Optional AbortSignal for client-disconnect detection
 * @param opts.expectedBytes - Exact byte count the source promised. When set,
 *   a graceful end that delivered a different total (a file truncated or grown
 *   in place mid-read) errors the web stream instead of closing it short, so a
 *   torn body can never masquerade as a complete response under the committed
 *   `Content-Length`. A client abort tears down via a thrown iterator error,
 *   not a graceful end, so it is unaffected by this check.
 */
export function nodeStreamToWeb(
  iterable: AsyncIterable<Uint8Array>,
  opts?: {
    destroy?: () => void;
    signal?: {
      addEventListener(type: "abort", listener: () => void): void;
      removeEventListener?(type: "abort", listener: () => void): void;
    };
    expectedBytes?: number;
  },
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const { signal, expectedBytes } = opts ?? {};
  let seen = 0;
  // Auto-detect the Node-stream destroy capability when the caller doesn't
  // supply one: every adapter was hand-rolling the same
  // `typeof stream.destroy === "function"` guard.
  const nativeDestroy = (iterable as AsyncIterable<Uint8Array> & { destroy?: () => void }).destroy;
  const destroy = opts?.destroy ?? (
    typeof nativeDestroy === "function" ? () => nativeDestroy.call(iterable) : undefined
  );

  // Propagate abort signal to the underlying stream. The listener MUST be
  // removed once the stream settles: a consumer that reuses one long-lived
  // signal across many getObject calls would otherwise accumulate one
  // listener (and one retained stream reference) per completed transfer
  // until the signal is aborted or GC'd.
  const abortListener = signal && destroy ? destroy : undefined;
  if (signal && abortListener) signal.addEventListener("abort", abortListener);
  const detach = () => {
    if (signal && abortListener) signal.removeEventListener?.("abort", abortListener);
  };

  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      let result: IteratorResult<Uint8Array>;
      try {
        result = await iterator.next();
      } catch (err) {
        // Stop backend I/O when iteration fails, then error the web stream.
        // Without this, a mid-transfer backend failure leaks the socket.
        detach();
        destroy?.();
        throw err;
      }
      if (result.done) {
        detach();
        // A graceful end that under- or over-ran the promised length means the
        // source changed under an already-committed Content-Length: fail the
        // body loudly (a reset the client sees as a failed transfer) rather
        // than deliver a truncated stream that looks complete.
        if (expectedBytes !== undefined && seen !== expectedBytes) {
          destroy?.();
          controller.error(new Error(
            `stream delivered ${seen} bytes, expected ${expectedBytes} (source changed mid-read)`,
          ));
          return;
        }
        controller.close();
      } else {
        // Node.js streams yield Buffer; ensure Uint8Array for cross-runtime compat.
        // Node Buffers and adapter chunks are ArrayBuffer-backed, so the narrow
        // is runtime-safe and lets the web stream advertise a BodyInit-assignable
        // Uint8Array<ArrayBuffer> (see F5 rationale in guardStreamLength).
        const raw = result.value instanceof Uint8Array ? result.value : Buffer.from(result.value);
        const chunk = raw as Uint8Array<ArrayBuffer>;
        seen += chunk.byteLength;
        controller.enqueue(chunk);
      }
    },
    async cancel(reason) {
      detach();
      try {
        await iterator.return?.(reason);
      } catch {
        // Iterator cleanup failed; socket will be GC'd
      }
      destroy?.();
    },
  });
}

/**
 * Wrap a web `ReadableStream` so a graceful end that delivered a byte count
 * other than `expectedBytes` errors the stream instead of closing it short.
 *
 * The Node-stream path gets this guard inside {@link nodeStreamToWeb}. This is
 * the equivalent for adapters whose SDK hands back a web `ReadableStream`
 * directly (S3 in Bun/Deno or via `transformToWebStream`, R2's native binding,
 * a browser `Blob` stream) rather than a Node `Readable`. Without it, an
 * S3-compatible backend that ends a body cleanly but short of the committed
 * `Content-Length` (some do in-flight body retries) would under-run the
 * response undetected -- the exact truncation `expectedBytes` exists to catch.
 * Passing `undefined` disables the check and returns the stream unwrapped.
 */
export function guardStreamLength(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number | undefined,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  // Return position narrows to <ArrayBuffer> (backend byte chunks are always
  // ArrayBuffer-backed) so the guarded body stays `new Response(...)`-assignable
  // under DOM lib; the input stays wide for callers.
  if (expectedBytes === undefined) return stream as ReadableStream<Uint8Array<ArrayBuffer>>;
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        controller.enqueue(chunk as Uint8Array<ArrayBuffer>);
      },
      flush(controller) {
        // A short (or long) graceful end means the source diverged from the
        // committed length: fail the body loudly rather than deliver a
        // truncated stream that looks complete. Mirrors nodeStreamToWeb.
        if (seen !== expectedBytes) {
          controller.error(new Error(
            `stream delivered ${seen} bytes, expected ${expectedBytes} (source changed mid-read)`,
          ));
        }
      },
    }),
  );
}

// ─── Storage Metadata ───────────────────────────────────────────────────────

/**
 * Metadata from a HEAD request -- enough to evaluate conditionals before
 * any body transfer.
 */
export interface ObjectMetadata {
  /** Full object size in bytes. */
  contentLength: number;
  /** Backend ETag, if any (already quoted or `W/`-prefixed -- pass through `generateETag`). */
  etag?: string;
  /** Last-Modified, in whatever format the backend emits (`Date.parse`-able). */
  lastModified?: string;
  /**
   * RFC 9530 SHA-256 digest of the full representation (raw base64, no prefix).
   *
   * When provided, the adapter emits `Repr-Digest: sha-256=:<base64>:` on
   * success responses for end-to-end integrity verification.
   *
   * S3: map from `x-amz-checksum-sha256`
   * GCS: map from `x-goog-hash` (extract sha256 component)
   */
  digest?: string;
  /**
   * Opaque adapter token pinning a later `getObject` to this exact
   * representation. The orchestrator round-trips it verbatim into
   * {@link GetObjectOptions.pin} without interpreting it.
   *
   * Only needed by stores whose version identifier is not the ETag: GCS
   * encodes its generation (plus the size/validators `getObject` would
   * otherwise re-fetch), turning the HEAD->GET pair into a single backend
   * read. ETag-pinning stores (S3, R2, Azure, http) omit it -- `ifMatch`
   * already carries their pin.
   */
  pin?: string;
}

// ─── Stream Result ──────────────────────────────────────────────────────────

/**
 * The byte range a backend actually served, inclusive on both ends
 * (`bytes start-end/total` without the total: {@link ObjectStream.totalSize}
 * carries it, or is `undefined` when the backend reported `bytes a-b/*`).
 */
export interface ServedRange {
  /** First byte position served (0-based, inclusive). */
  start: number;
  /** Last byte position served (inclusive). */
  end: number;
}

/** Served bounds plus honest total parsed from a backend `Content-Range`. */
export interface ResolvedContentRange {
  /** The byte range the backend actually served (inclusive bounds). */
  served: ServedRange;
  /**
   * Full representation size, or `undefined` for the `bytes a-b/*`
   * unknown-total sentinel (a streaming origin that does not know its length).
   */
  totalSize: number | undefined;
}

/**
 * Parse a backend `Content-Range` response header into served bounds plus an
 * honest total, applying the parser's `-1` unknown-total sentinel -> `undefined`
 * mapping that every SDK adapter needs identically. Returns `null` ONLY when the
 * header is present but unparseable -- the exact "byte accounting is
 * untrustworthy, tear down and fail loudly" signal, which each adapter pairs
 * with its own live-body cleanup (S3 `stream.cancel()`, Azure
 * `destroyAzureDownload`, http `drain`) before throwing.
 *
 * Adapters that treat an ABSENT header as a full 200 (S3, Azure) check for the
 * header before calling; callers that already know the response is partial
 * (http's 206 branch) treat both an absent header and a `null` here as the same
 * malformed-206 failure. Adapters that know their bounds natively (fs, memory,
 * GCS, R2) construct {@link ServedRange} directly and never call this.
 */
export function resolveServedRange(contentRange: string): ResolvedContentRange | null {
  const parsed = parseContentRange(contentRange);
  if (!parsed) return null;
  return {
    served: { start: parsed.start, end: parsed.end },
    totalSize: parsed.totalSize < 0 ? undefined : parsed.totalSize,
  };
}

/**
 * A body-transfer result from `getObject`.
 *
 * Every field is sourced from the **same GET response** -- including `etag`
 * and `lastModified`. Consumers MUST prefer these over any prior HEAD values
 * to avoid advertising stale validators against freshly-fetched bytes
 * (the HEAD->GET TOCTOU window).
 */
export interface ObjectStream {
  /**
   * The body: a `ReadableStream` for streamed transfers, or a plain
   * `Uint8Array` when the adapter already has the exact bytes in memory
   * (small files, in-memory stores). Byte bodies let consumers skip stream
   * machinery entirely -- server adapters write them in a single syscall
   * and `new Response(bytes)` takes the fetch runtime's static-body fast
   * path. Return whichever form is natural; never buffer large transfers
   * just to produce bytes.
   *
   * Typed `<ArrayBuffer>`-backed (not the wider `ArrayBufferLike`) so a
   * consumer can pass it straight to `new Response(...)` under `lib: ["DOM"]`
   * on TS >= 5.7, where `BodyInit` requires an `ArrayBuffer`-backed view.
   */
  body: ReadableStream<Uint8Array<ArrayBuffer>> | Uint8Array<ArrayBuffer>;
  /** Bytes in THIS response (range length for 206, full size for 200). */
  contentLength: number;
  /**
   * Full object size, independent of any range, or `undefined` when the
   * backend served a partial response with an unknown total (`bytes a-b/*`,
   * RFC 7233 Section 4.2) -- a streaming origin that does not know its full
   * length. Object stores (S3, R2, GCS, Azure) always know their sizes and
   * set a number; only proxied origins (the http adapter) legitimately leave
   * it `undefined`. Valid ONLY alongside a `range`: a full response carries a
   * concrete size in `contentLength`, so `undefined` with no `range` is an
   * adapter bug (the orchestrator emits 200 and needs the length).
   */
  totalSize: number | undefined;
  /**
   * The byte range the backend ACTUALLY served (inclusive bounds), or
   * `undefined` if it served full content.
   *
   * This is the source of truth for 206 vs 200: if a range was requested but
   * `range` is `undefined`, the backend ignored it -- emit 200, never a
   * lying 206. Adapters that receive a `Content-Range` string from their
   * backend parse it with {@link parseContentRange} and fail loudly on
   * garbage; adapters that know the bounds natively (fs, memory, GCS, R2)
   * construct this directly -- malformed range strings cannot exist in the
   * contract.
   */
  range?: ServedRange;
  /** ETag as returned by the GET (authoritative for this body). */
  etag?: string;
  /** Last-Modified as returned by the GET (authoritative for this body). */
  lastModified?: string;
  /**
   * RFC 9530 SHA-256 digest of the full representation (raw base64, no prefix).
   *
   * When provided by the GET response, the adapter can emit `Repr-Digest`
   * even on Path C (no prior HEAD). This closes the digest gap for
   * first-visit requests that skip the HEAD round-trip.
   *
   * S3: map from `x-amz-checksum-sha256` on GetObject response.
   */
  digest?: string;
}

// ─── Store Contract ─────────────────────────────────────────────────────────

/**
 * Storage backend abstraction consumed by partial-content adapters.
 *
 * This contract is **read-only by design**. It covers the operations needed
 * to evaluate conditional requests and stream object content. Write operations
 * (PUT, PATCH, DELETE) remain the consumer's responsibility -- use
 * `evaluateConditionalWrite()` to evaluate preconditions, then perform the
 * write through your storage SDK directly.
 *
 * Implementations adapt a concrete store (S3/R2/Hetzner/GCS/fs) down to this
 * surface. The kernel and framework adapters depend only on this interface,
 * never on a storage SDK.
 *
 * @example
 * ```typescript
 * import type { ObjectStore } from "partial-content";
 *
 * const store: ObjectStore = {
 *   async headObject(key, opts) { ... },
 *   async getObject(key, opts) { ... },
 * };
 * ```
 */
export interface ObjectStore {
  /**
   * Fetch metadata without a body. Used to evaluate conditional requests
   * (304/412) and If-Range before deciding whether to transfer bytes.
   *
   * @param key - Object key within the bucket.
   * @param opts - Cancellation ({@link HeadObjectOptions}).
   */
  headObject(key: string, opts?: HeadObjectOptions): Promise<ObjectMetadata>;

  /**
   * Stream an object, optionally a byte range.
   *
   * The adapter receives a `ParsedRange` in `opts.range` and formats it for
   * the backend (e.g. `bytes=${start}-${end}`). `range.end` may exceed the
   * object size (RFC 9110 lets servers clamp a last-byte-pos past EOF, and
   * the fast range path uses an open end deliberately); adapters clamp it
   * and report the bounds ACTUALLY served. `range.start` beyond EOF is the
   * caller's error: local adapters throw a RangeError, remote backends
   * reject natively. Returns the actual transfer result -- including the
   * real `Content-Range` -- so the caller can build a truthful 200/206
   * from a single round-trip.
   *
   * @param key - Object key within the bucket.
   * @param opts - Range, cancellation, and pinning
   *   ({@link GetObjectOptions}). Stores that cannot pin reads may ignore
   *   `ifMatch`; the web adapter keeps a response-side guard (actual
   *   Content-Range + GET validators) for that case.
   */
  getObject(key: string, opts?: GetObjectOptions): Promise<ObjectStream>;

  /**
   * Capability flag. When `false`, the framework adapter degrades gracefully
   * (e.g. signed-URL redirect) instead of attempting range streaming.
   * Omit or set `true` for any S3-compatible backend.
   *
   * @default true
   */
  readonly supportsRange?: boolean;

  /**
   * Capability flag: this adapter's ranged responses carry bounds and total
   * size taken from the BACKEND's actual response (`Content-Range`), not
   * echoed from the request. When `true`, the framework adapter skips the
   * validating HEAD for plain range requests (no conditionals, no
   * If-Range) and serves the seek in a single round-trip -- validators,
   * bounds, and digest all come from the GET response itself, which is
   * also inherently TOCTOU-atomic. Leave unset for stores that need the
   * orchestrator's pre-clamped ranges (fs, memory) or that fetch metadata
   * themselves anyway (GCS).
   *
   * @default false
   */
  readonly authoritativeRange?: boolean;

  /**
   * Optional egress-offload path: returns a short-lived URL the client is
   * redirected to. Used for backends that cannot stream ranges through the
   * origin, and by the web adapter's `preferSignedUrl` per-request offload.
   *
   * `downloadFilename` is RAW untrusted input (the consumer's
   * ServeContext.filename, verbatim). Implementations that embed it in a
   * response-content-disposition query parameter or similar MUST sanitize it
   * (e.g. via `buildContentDisposition`), exactly as the streaming path does.
   *
   * `cacheControl`, when provided, SHOULD override the Cache-Control of the
   * signed response (S3 `response-cache-control` and equivalents). Without
   * it, the redirect target serves whatever Cache-Control was baked into the
   * object at upload -- a private document stored with a public/immutable
   * value would be cached by any CDN in front of the bucket.
   *
   * Two adapter-author traps this contract documents:
   * - **Temporary credentials cap expiry.** A URL presigned under STS/role
   *   credentials (Lambda, ECS task roles) dies when the SESSION TOKEN
   *   expires, regardless of `expiresInSeconds`. Effective lifetime is
   *   `min(expiresInSeconds, credential lifetime remaining)`; long-lived
   *   links need long-term credentials or a stable re-signing endpoint that
   *   302s per fetch.
   * - **CloudFront canned policies break on RFC 8187 dispositions.** A
   *   sanitized disposition carries `filename*=UTF-8''...`; browsers
   *   re-encode the apostrophes to `%27`, which no longer matches a
   *   canned-policy signature (AccessDenied). CloudFront signers must use a
   *   custom policy with a wildcard query (`...?*`).
   */
  createSignedUrl?(
    key: string,
    opts: { expiresInSeconds: number; downloadFilename?: string; cacheControl?: string },
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
}

