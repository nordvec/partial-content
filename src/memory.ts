/**
 * In-memory ObjectStore for partial-content.
 *
 * A complete, spec-faithful store over a plain object map. Built for:
 * - **Consumer test suites** -- exercise your serving routes (ranges,
 *   conditionals, pinned-read retries) without a storage backend.
 * - **Demos and examples** -- a working store in three lines.
 * - **Small embedded assets** -- serve a handful of in-process files with
 *   the full 200/206/304 protocol.
 *
 * Faithful to the contract: real Content-Range fabrication, `ifMatch`
 * pinning (mismatch throws {@link ObjectChangedError}, so retry logic is
 * testable), and per-object validators.
 *
 * @example
 * ```typescript
 * import { memoryStore } from "partial-content/memory";
 * import { serveObject } from "partial-content/web";
 *
 * const store = memoryStore({
 *   objects: {
 *     "hello.txt": { body: "Hello, world!", etag: '"v1"' },
 *   },
 * });
 * const handler = serveObject(store);
 * ```
 *
 * @packageDocumentation
 */

import {
  ObjectNotFoundError,
  ObjectChangedError,
  type ObjectStore,
  type ObjectMetadata,
  type ObjectStream,
  type ParsedRange,
} from "./index.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError };

// ─── Options ────────────────────────────────────────────────────────────────

/** A stored object: body plus optional validators and integrity metadata. */
export interface MemoryObject {
  /** Object content. Strings are encoded as UTF-8. */
  body: Uint8Array | string;
  /** Raw ETag (quoted, like a backend would return). */
  etag?: string;
  /** Last-Modified (any `Date.parse`-able string). */
  lastModified?: string;
  /** RFC 9530 raw base64 SHA-256 digest of the body. */
  digest?: string;
}

export interface MemoryStoreOptions {
  /**
   * Key -> object map. Held BY REFERENCE: mutate it between requests to
   * simulate uploads, overwrites (change `etag` to trigger pinned-read
   * retries), and deletions.
   */
  objects: Record<string, MemoryObject>;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} over an in-memory object map.
 */
export function memoryStore(opts: MemoryStoreOptions): ObjectStore {
  const encoder = new TextEncoder();
  // Cache the UTF-8 encoding of string bodies so a hot-served asset is not
  // re-encoded on every head + get. The map is keyed by the entry and holds
  // the exact string it encoded: the objects map is mutable by reference
  // (the documented way to simulate overwrites), so a changed body misses
  // the cache and re-encodes rather than serving stale bytes.
  const encodeCache = new WeakMap<MemoryObject, { source: string; bytes: Uint8Array }>();

  function lookup(key: string): { entry: MemoryObject; bytes: Uint8Array } {
    // Own-property check: the map is a caller-supplied plain object, so an
    // inherited key ("constructor", "__proto__", "toString") would otherwise
    // return a truthy prototype member and crash downstream as a 502 instead
    // of answering the honest 404.
    const entry = Object.hasOwn(opts.objects, key) ? opts.objects[key] : undefined;
    if (!entry) throw new ObjectNotFoundError(key);
    if (typeof entry.body !== "string") return { entry, bytes: entry.body };
    const cached = encodeCache.get(entry);
    if (cached && cached.source === entry.body) return { entry, bytes: cached.bytes };
    const bytes = encoder.encode(entry.body);
    encodeCache.set(entry, { source: entry.body, bytes });
    return { entry, bytes };
  }

  return {
    supportsRange: true,

    async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
      opts?.signal?.throwIfAborted();
      const { entry, bytes } = lookup(key);
      return {
        contentLength: bytes.length,
        etag: entry.etag,
        lastModified: entry.lastModified,
        digest: entry.digest,
      };
    },

    async getObject(
      key: string,
      getOpts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string },
    ): Promise<ObjectStream> {
      const { range, signal, ifMatch } = getOpts ?? {};
      signal?.throwIfAborted();
      const { entry, bytes } = lookup(key);

      // Pinned read: the object must still match the caller's validator.
      if (ifMatch && entry.etag !== ifMatch) {
        throw new ObjectChangedError(key);
      }

      if (range && range.start >= bytes.length) {
        // Unsatisfiable ranges are the orchestrator's job to reject
        // (parseRangeHeader 416s them first); a direct caller gets a loud
        // error instead of an empty body with lying bounds.
        throw new RangeError(
          `memoryStore ${key}: range start ${range.start} is beyond object size ${bytes.length}`,
        );
      }
      // subarray() clamps to the object size and returns a view (no copy);
      // the served bytes are read-only, so a view is safe. Derive the reported
      // range from the actual slice so ObjectStream.range is the SERVED bounds.
      const slice = range ? bytes.subarray(range.start, range.end + 1) : bytes;
      return {
        // In-memory bytes are ArrayBuffer-backed (TextEncoder output or the
        // caller's view); narrow so the body is `new Response(...)`-assignable
        // under DOM lib (F5).
        body: slice as Uint8Array<ArrayBuffer>,
        contentLength: slice.length,
        totalSize: bytes.length,
        range: range ? { start: range.start, end: range.start + slice.length - 1 } : undefined,
        etag: entry.etag,
        lastModified: entry.lastModified,
        digest: entry.digest,
      };
    },
  };
}
