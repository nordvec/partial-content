/**
 * Cache-Control composition for file serving (RFC 9111 + RFC 5861).
 *
 * A typed policy builder for the directives that matter when serving bytes:
 * no more hand-assembled directive strings with typos a cache silently
 * ignores. The output feeds the serve options' / kernel's `cacheControl`
 * passthrough.
 *
 * `no-transform` defaults ON: this library's value proposition is byte-exact
 * ranges, strong validators, and representation digests, and every one of
 * those breaks if an intermediary re-compresses or transcodes the payload
 * (a proxy that gzips a response changes the bytes that `Repr-Digest` and
 * `Content-Range` describe). Callers who WANT intermediary transforms opt
 * out explicitly.
 *
 * @packageDocumentation
 */

/** Typed Cache-Control policy ({@link buildCacheControl}). */
export interface CacheControlPolicy {
  /**
   * `public` (shared caches may store) or `private` (browser cache only).
   * Omit for neither directive (rely on status-code heuristics).
   */
  visibility?: "public" | "private";
  /** `max-age` in seconds (non-negative integer). */
  maxAge?: number;
  /** `s-maxage` in seconds: shared-cache override of `max-age`. */
  sMaxAge?: number;
  /**
   * `no-cache`: store, but revalidate before every reuse. The right default
   * for private documents behind validators (this library's 304 machinery
   * makes revalidation nearly free).
   */
  noCache?: boolean;
  /**
   * `no-store`: never write this response to any cache. Overrides everything
   * else except `no-transform`; combining it with freshness directives is a
   * contradiction and throws.
   */
  noStore?: boolean;
  /**
   * `immutable`: the representation never changes for the lifetime of
   * `max-age` (content-addressed keys). Browsers skip even the revalidation
   * request on reload.
   */
  immutable?: boolean;
  /** `must-revalidate`: once stale, a cache MUST revalidate before reuse. */
  mustRevalidate?: boolean;
  /**
   * `no-transform`: forbid intermediaries from altering the payload
   * (re-compression, image transcoding). Defaults to `true` -- transforms
   * corrupt byte ranges, digests, and strong validators.
   *
   * @default true
   */
  noTransform?: boolean;
  /**
   * RFC 5861 `stale-while-revalidate` window in seconds: a cache may serve
   * the stale copy while revalidating in the background.
   */
  staleWhileRevalidate?: number;
  /**
   * RFC 5861 `stale-if-error` window in seconds: a cache may serve the stale
   * copy when the origin answers 5xx (keeps downloads working through a
   * storage-backend incident).
   */
  staleIfError?: number;
}

/** Validate a seconds directive: non-negative safe integer. */
function assertSeconds(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `buildCacheControl: ${name} must be a non-negative integer of seconds, got ${value}`,
    );
  }
}

/**
 * Compose a Cache-Control field value from a typed policy.
 *
 * Directive order follows reading convention (visibility, freshness,
 * revalidation, transforms); order is semantically irrelevant to caches.
 * Numeric directives are validated (a `NaN` or negative would serialize
 * into a directive every cache ignores, silently disabling caching policy).
 *
 * @example
 * ```typescript
 * buildCacheControl({ visibility: "private", noCache: true });
 * // "private, no-cache, no-transform"
 *
 * buildCacheControl({
 *   visibility: "public", maxAge: 86400, immutable: true,
 *   staleWhileRevalidate: 604800, staleIfError: 604800,
 * });
 * // "public, max-age=86400, immutable, stale-while-revalidate=604800,
 * //  stale-if-error=604800, no-transform"
 * ```
 */
export function buildCacheControl(policy: CacheControlPolicy): string {
  const {
    visibility,
    maxAge,
    sMaxAge,
    noCache = false,
    noStore = false,
    immutable = false,
    mustRevalidate = false,
    noTransform = true,
    staleWhileRevalidate,
    staleIfError,
  } = policy;

  if (noStore) {
    if (
      visibility !== undefined || maxAge !== undefined || sMaxAge !== undefined
      || noCache || immutable || mustRevalidate
      || staleWhileRevalidate !== undefined || staleIfError !== undefined
    ) {
      throw new TypeError(
        "buildCacheControl: no-store contradicts freshness/visibility directives; a response is either cacheable or it is not",
      );
    }
    return noTransform ? "no-store, no-transform" : "no-store";
  }

  const directives: string[] = [];
  if (visibility) directives.push(visibility);
  if (noCache) directives.push("no-cache");
  if (maxAge !== undefined) {
    assertSeconds("maxAge", maxAge);
    directives.push(`max-age=${maxAge}`);
  }
  if (sMaxAge !== undefined) {
    assertSeconds("sMaxAge", sMaxAge);
    directives.push(`s-maxage=${sMaxAge}`);
  }
  if (mustRevalidate) directives.push("must-revalidate");
  if (immutable) {
    if (maxAge === undefined) {
      throw new TypeError(
        "buildCacheControl: immutable without maxAge is inert (immutable qualifies a freshness lifetime)",
      );
    }
    directives.push("immutable");
  }
  if (staleWhileRevalidate !== undefined) {
    assertSeconds("staleWhileRevalidate", staleWhileRevalidate);
    directives.push(`stale-while-revalidate=${staleWhileRevalidate}`);
  }
  if (staleIfError !== undefined) {
    assertSeconds("staleIfError", staleIfError);
    directives.push(`stale-if-error=${staleIfError}`);
  }
  if (noTransform) directives.push("no-transform");
  if (directives.length === 0) {
    throw new TypeError("buildCacheControl: empty policy composes no directives");
  }
  return directives.join(", ");
}
