/**
 * HTTP Range header parser and response builder (RFC 7233 + RFC 9110).
 *
 * Pure functions for building RFC-compliant HTTP responses that serve
 * files from any storage backend (S3, R2, GCS, local disk). Handles
 * range parsing, conditional request evaluation, and response header
 * construction.
 *
 * Supports:
 *   - `If-None-Match` -> 304 Not Modified (bandwidth savings on revisits)
 *   - `If-Match` / `If-Unmodified-Since` -> 412 Precondition Failed
 *   - `If-Range` -> ETag/date validation (prevents data corruption)
 *   - `Range: bytes=...` -> 206 Partial Content (seeking in video/PDF)
 *   - 416 Range Not Satisfiable (proper error for unsatisfiable ranges)
 *
 * Supports both single byte ranges and multiple ranges (`parseRanges` +
 * the `multipart/byteranges` builders below). Multi-range coalesces
 * overlapping/adjacent parts and caps the count (amplification defense); the
 * single-range fast path is kept separate so the common seek pays no
 * multi-range overhead.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** A validated, clamped byte range with inclusive bounds. */
export interface ParsedRange {
  /** First byte position (0-indexed). */
  start: number;
  /**
   * Last byte position (inclusive). May equal {@link OPEN_ENDED} on the
   * single-round-trip fast path, meaning "to end of object" -- the range's
   * true end is unknown until the backend responds. Adapters MUST treat
   * `end === OPEN_ENDED` as an open-ended read (`bytes=start-`, or omit the
   * count) rather than emitting the sentinel as a literal last-byte-pos.
   */
  end: number;
}

/**
 * Sentinel `ParsedRange.end` meaning "to the end of the object". Used only
 * by the fast path for a `bytes=a-` request, where the total size is not yet
 * known. It is deliberately NOT `Number.MAX_SAFE_INTEGER`-as-a-magic-number
 * at call sites: adapters compare against this named constant and emit the
 * idiomatic open-ended wire form, so no 16-digit last-byte-pos ever reaches
 * a backend or proxy that might reject it.
 */
export const OPEN_ENDED = Number.MAX_SAFE_INTEGER;

/** True when a range is the fast-path open-ended form (`bytes=start-`). */
export function isOpenEndedRange(range: { end: number } | undefined | null): boolean {
  return range?.end === OPEN_ENDED;
}

/** Options for building range response headers. */
export interface RangeResponseHeaderOpts {
  /**
   * Total object size in bytes, or `undefined` when the total is unknown --
   * a `bytes a-b/*` partial response from a streaming origin that does not
   * know its full length (RFC 7233 Section 4.2). Unknown is valid ONLY
   * alongside a `range`: a 206's `Content-Length` is the range span, so the
   * total is not needed to size the body and is emitted as `*`. A full (200)
   * response has no length without it and rejects `undefined`.
   */
  totalSize: number | undefined;
  /** Parsed range, or null for a full-content response. */
  range: ParsedRange | null;
  /** MIME type from storage metadata. */
  contentType: string | undefined;
  /** ETag from storage metadata, for conditional caching. */
  etag: string | undefined;
  /**
   * Last-Modified date from storage metadata.
   *
   * Accepts any string parseable by `Date.parse()` (ISO 8601, IMF-fixdate,
   * RFC 850, asctime). The library normalizes it to IMF-fixdate
   * (e.g. "Sun, 29 Jun 2025 12:00:00 GMT") before emitting the
   * `Last-Modified` response header, because ISO strings are not valid
   * HTTP-dates and would break `If-Modified-Since` revalidation.
   */
  lastModified: string | undefined;
  /**
   * RFC 9530 representation digest for end-to-end integrity.
   *
   * When provided, emitted as `Repr-Digest: sha-256=:<base64>:` on 200/206
   * responses. The digest covers the *full representation* (not the partial
   * range), so it remains stable across range requests.
   *
   * Storage backends typically provide this:
   * - S3: `x-amz-checksum-sha256`
   * - GCS: `x-goog-hash: crc32c=...,md5=...`
   *
   * Must be a raw base64-encoded SHA-256 hash (no prefix, no colons).
   */
  digest?: string;
  /**
   * Cache-Control directive to include in the response.
   *
   * The library never generates cache directives on its own. It only echoes
   * a value you provide. Common patterns:
   *   - `"private, no-cache"` (revalidate every request)
   *   - `"private, max-age=3600"` (cache 1 hour)
   *   - `"public, max-age=31536000, immutable"` (content-addressed)
   */
  cacheControl?: string;
}

/** Result of building range response headers. */
export interface RangeResponseHeaders {
  /** HTTP status code: 200 for full content, 206 for partial, 304 for not modified, 412 for precondition failure, 416 for unsatisfiable. */
  status: 200 | 206 | 304 | 412 | 416;
  /** Headers to set on the response. */
  headers: Record<string, string>;
}

/** Result of the full conditional request evaluation chain. */
export interface EvaluatedRequest extends RangeResponseHeaders {
  /** Parsed range, or null if full content or an error status. */
  range: ParsedRange | null;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse an HTTP Range header value into a validated byte range.
 *
 * Supports three RFC 7233 forms:
 *   - `bytes=0-499`   (first 500 bytes)
 *   - `bytes=500-`    (everything from byte 500 onward)
 *   - `bytes=-500`    (last 500 bytes, suffix range)
 *
 * Returns `null` for:
 *   - Missing or empty header
 *   - Malformed syntax
 *   - Multi-range requests (e.g. `bytes=0-100,200-300`)
 *   - Non-byte range units
 *
 * Returns `"unsatisfiable"` for:
 *   - Start >= totalSize (valid syntax but out of bounds)
 *   - Suffix of 0 bytes
 *   - Start > end after clamping
 *
 * This distinction matters: `null` means "not a range request" (serve 200),
 * while `"unsatisfiable"` means "valid range syntax but cannot be honored" (serve 416).
 *
 * @param rangeHeader - The raw `Range` header value (e.g. "bytes=0-499")
 * @param totalSize - Total file size in bytes
 */
export function parseRangeHeader(
  rangeHeader: string | null | undefined,
  totalSize: number,
): ParsedRange | "unsatisfiable" | null {
  // Reject corrupt metadata: NaN, Infinity, negative, or non-integer sizes
  // would produce invalid Content-Range headers downstream.
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) return null;
  if (!rangeHeader || totalSize <= 0) return null;

  // RFC 9110 Section 14.1: "Range units are case-insensitive."
  const lower = rangeHeader.toLowerCase();
  if (!lower.startsWith("bytes=")) return null;

  const rangeSpec = rangeHeader.slice(6); // Strip "bytes=" (preserves original casing for value)

  // Single range only on this fast path. Multi-range (comma-separated) is
  // served as multipart/byteranges via parseRanges; this path handles the
  // common single-seek that media elements and PDF viewers emit.
  if (rangeSpec.includes(",")) return null;

  return parseOneRange(rangeSpec, totalSize);
}

/**
 * Parse ONE byte-range-spec element (already stripped of the `bytes=` unit)
 * against a known total size. Shared by {@link parseRangeHeader} (single) and
 * {@link parseRanges} (multipart).
 *
 * Returns a clamped {@link ParsedRange}, `"unsatisfiable"` for valid syntax
 * that cannot be honored (start past EOF, zero-length suffix), or `null` for
 * malformed syntax.
 */
function parseOneRange(spec: string, totalSize: number): ParsedRange | "unsatisfiable" | null {
  const dashIndex = spec.indexOf("-");
  if (dashIndex === -1) return null;

  const startStr = spec.slice(0, dashIndex).trim();
  const endStr = spec.slice(dashIndex + 1).trim();

  // Suffix range: bytes=-500 (last 500 bytes)
  if (startStr === "") {
    const suffixLength = parsePos(endStr);
    if (isNaN(suffixLength)) return null;
    // bytes=-0 is a zero-length suffix: valid syntax but unsatisfiable
    if (suffixLength <= 0) return "unsatisfiable";
    const start = Math.max(0, totalSize - suffixLength);
    return { start, end: totalSize - 1 };
  }

  const start = parsePos(startStr);
  if (isNaN(start)) return null;

  // Unsatisfiable: start beyond file (valid syntax, cannot be honored)
  if (start >= totalSize) return "unsatisfiable";

  // Open-ended range: bytes=500-
  if (endStr === "") {
    return { start, end: totalSize - 1 };
  }

  let end = parsePos(endStr);
  if (isNaN(end)) return null;

  // Clamp end to file boundary
  end = Math.min(end, totalSize - 1);

  // RFC 9110 Section 14.1.2: "A server that receives a byte-range-spec
  // with a first-byte-pos that is greater than its last-byte-pos MUST
  // ignore the invalid range." Ignore = serve full 200.
  if (start > end) return null;

  return { start, end };
}

// ─── Multiple Ranges (multipart/byteranges, RFC 9110 Section 14) ────────────

/** Default cap on distinct coalesced ranges before a request degrades to 200. */
export const MAX_RANGES_DEFAULT = 50;

/** A validated, coalesced set of satisfiable ranges. */
export interface RangeSet {
  /**
   * Coalesced satisfiable ranges in ascending order (length >= 1). A length
   * of 1 is served as a normal single 206; length > 1 as multipart/byteranges.
   */
  ranges: ParsedRange[];
}

/**
 * Parse a possibly-multi-range `Range` header into a coalesced, satisfiable
 * range set, applying range-amplification defenses.
 *
 * Return contract mirrors {@link parseRangeHeader} but for a set:
 *   - `null`          -- not a byte range, ignorable syntax, or a defense
 *                        tripped: serve the full 200.
 *   - `"unsatisfiable"` -- every element was valid syntax but out of bounds:
 *                        serve 416.
 *   - {@link RangeSet} -- 1+ satisfiable ranges (overlapping/adjacent already
 *                        coalesced): serve 206 (single) or multipart (>1).
 *
 * Amplification defenses (informed by Go `net/http.ServeContent`'s
 * sum-of-ranges check and nginx `max_ranges` + adjacent coalescing):
 *   1. Overlapping/adjacent ranges are coalesced, so a client cannot force
 *      redundant bytes by requesting the same region many times.
 *   2. If the coalesced set still exceeds `maxRanges` distinct parts, or the
 *      bytes it covers reach or exceed the whole representation, the ranges
 *      are ignored and the full 200 is served -- multipart framing over the
 *      entire file is pure overhead and a classic amplification vector.
 *
 * Empty list elements (`bytes=0-1,,2-3`) are skipped per the RFC 9110
 * Section 5.6.1 list rule; a genuinely malformed element voids the whole
 * header (serve 200), matching single-range leniency.
 */
export function parseRanges(
  rangeHeader: string | null | undefined,
  totalSize: number,
  maxRanges: number = MAX_RANGES_DEFAULT,
): RangeSet | "unsatisfiable" | null {
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) return null;
  if (!rangeHeader || totalSize <= 0) return null;

  const lower = rangeHeader.toLowerCase();
  if (!lower.startsWith("bytes=")) return null;

  const specs = rangeHeader.slice(6).split(",");
  const satisfiable: ParsedRange[] = [];
  let sawUnsatisfiable = false;

  for (const rawSpec of specs) {
    const spec = rawSpec.trim();
    if (spec === "") continue; // RFC 9110 Section 5.6.1 list rule: skip empties
    const parsed = parseOneRange(spec, totalSize);
    if (parsed === null) return null; // malformed element -> ignore whole header
    if (parsed === "unsatisfiable") {
      sawUnsatisfiable = true;
      continue;
    }
    satisfiable.push(parsed);
  }

  if (satisfiable.length === 0) {
    // Valid syntax but nothing in range -> 416; nothing at all -> serve 200.
    return sawUnsatisfiable ? "unsatisfiable" : null;
  }

  const coalesced = coalesceRanges(satisfiable);

  // Amplification defenses: too many parts, or the parts already cover the
  // whole file -- either way, serving the full 200 is cheaper and safe.
  if (coalesced.length > maxRanges) return null;
  const covered = coalesced.reduce((n, r) => n + (r.end - r.start + 1), 0);
  if (covered >= totalSize) return null;

  return { ranges: coalesced };
}

/**
 * Merge overlapping and adjacent ranges (sorted ascending). Adjacent means
 * `next.start <= cur.end + 1` (a 1-byte gap is NOT bridged; touching ranges
 * are). Prevents redundant bytes in the multipart body.
 */
function coalesceRanges(ranges: ParsedRange[]): ParsedRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ParsedRange[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start <= last.end + 1) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Generate a multipart/byteranges boundary token. Hyphen-free so the token
 * itself can never contain the `--` delimiter run; random so it cannot appear
 * in body content by construction.
 */
export function generateMultipartBoundary(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `partialcontent${uuid.replace(/-/g, "")}`;
  // Fallback for runtimes without randomUUID: 16 random bytes as hex.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `partialcontent${hex}`;
}

/**
 * Build the per-part header block for one multipart/byteranges part:
 * `--BOUNDARY CRLF [Content-Type CRLF] Content-Range CRLF CRLF`. The part's
 * body bytes and a trailing CRLF follow (the caller emits those).
 */
export function buildMultipartPartHeader(
  boundary: string,
  range: ParsedRange,
  totalSize: number,
  contentType: string | undefined,
): string {
  const ct = contentType ? `Content-Type: ${sanitizeHeaderValue(contentType)}\r\n` : "";
  return `--${boundary}\r\n${ct}Content-Range: bytes ${range.start}-${range.end}/${totalSize}\r\n\r\n`;
}

/** The closing delimiter for a multipart/byteranges body: `--BOUNDARY-- CRLF`. */
export function multipartEpilogue(boundary: string): string {
  return `--${boundary}--\r\n`;
}

/** Result of {@link buildMultipartHeaders}. */
export interface MultipartResponse {
  status: 206;
  headers: Record<string, string>;
  /** Exact byte length of the full multipart body (framing + all part bytes). */
  contentLength: number;
}

/**
 * Build the top-level headers and exact Content-Length for a
 * multipart/byteranges (206) response. The per-representation Content-Type
 * lives in each part; the top-level type is `multipart/byteranges`.
 *
 * Content-Length is computed deterministically from the framing and the
 * range spans, so the response is never chunked and the client gets an exact
 * length up front. `contentType` is the representation's own MIME (placed in
 * every part header).
 */
export function buildMultipartHeaders(opts: {
  boundary: string;
  ranges: ParsedRange[];
  totalSize: number;
  contentType: string | undefined;
  etag?: string;
  lastModified?: string;
  cacheControl?: string;
  digest?: string;
}): MultipartResponse {
  const { boundary, ranges, totalSize, contentType, etag, lastModified, cacheControl, digest } = opts;

  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw new RangeError(
      `buildMultipartHeaders: totalSize must be a non-negative safe integer, got ${totalSize}`,
    );
  }

  let contentLength = 0;
  for (const range of ranges) {
    const partHeader = buildMultipartPartHeader(boundary, range, totalSize, contentType);
    // Framing is ASCII, but Content-Type may carry obs-text; count real bytes.
    contentLength += utf8ByteLength(partHeader);
    contentLength += range.end - range.start + 1; // the part body
    contentLength += 2; // trailing CRLF after each part body
  }
  contentLength += utf8ByteLength(multipartEpilogue(boundary));

  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": `multipart/byteranges; boundary=${boundary}`,
    "Content-Length": String(contentLength),
  };
  if (etag) headers["ETag"] = sanitizeHeaderValue(etag);
  if (lastModified) headers["Last-Modified"] = toHttpDate(lastModified) ?? sanitizeHeaderValue(lastModified);
  // Repr-Digest covers the full representation, so it is valid on a partial
  // multipart response; Content-Digest is omitted (it would have to cover the
  // assembled parts, not the representation).
  if (digest) emitReprDigest(headers, digest, true);
  if (cacheControl) headers["Cache-Control"] = sanitizeHeaderValue(cacheControl);

  return { status: 206, headers, contentLength };
}

/** Shared UTF-8 encoder: allocating one per call is pure waste in the
 * per-part multipart sizing loop, and TextEncoder is stateless/reusable. */
const UTF8_ENCODER = new TextEncoder();

/** Byte length of a string as UTF-8 (framing math must count bytes, not code units). */
function utf8ByteLength(s: string): number {
  return UTF8_ENCODER.encode(s).byteLength;
}

// ─── Conditional Request Helpers (RFC 9110 / RFC 7232) ──────────────────────

/**
 * Check if a conditional GET request is "fresh" (resource not modified).
 *
 * Implements RFC 7232 Section 3.2 (If-None-Match) and Section 3.3
 * (If-Modified-Since). `If-None-Match` takes precedence per the spec.
 *
 * When this returns true, the server should respond with 304 Not Modified
 * and skip streaming the body entirely.
 *
 * @param reqHeaders - Request headers (must support `.get(name)`)
 * @param etag - Current resource ETag
 * @param lastModified - Current resource Last-Modified date string
 */
export function isConditionalFresh(
  reqHeaders: { get(name: string): string | null },
  etag: string | undefined,
  lastModified: string | undefined,
): boolean {
  const ifNoneMatch = reqHeaders.get("if-none-match");
  const ifModifiedSince = reqHeaders.get("if-modified-since");

  // No conditional headers -> not a conditional request
  if (!ifNoneMatch && !ifModifiedSince) return false;

  // Request `Cache-Control: no-cache` is deliberately IGNORED here, matching
  // Go stdlib and nginx. RFC 9111 aims that directive at caches, not origin
  // conditional evaluation, and a 304 IS the end-to-end revalidation the
  // client asked for. Critically, spec-compliant fetch clients (undici,
  // browsers) auto-append `Cache-Control: no-cache` to any request carrying
  // manual conditional headers -- honoring it would make 304 unreachable for
  // every programmatic revalidation. Hard reloads need no special case: they
  // omit the validators entirely, so this function already returns false.

  // If-None-Match takes precedence (RFC 7232 Section 6)
  if (ifNoneMatch) {
    // Wildcard: "a representation exists" (RFC 9110 Section 8.8.3).
    // Must be checked before the !etag guard.
    if (ifNoneMatch.trim() === "*") return true;
    if (!etag) return false;
    // Parse comma-separated list of ETags, compare each.
    // Supports both strong and weak comparison (W/ prefix stripping).
    const normalizedEtag = stripWeakPrefix(etag);
    return parseETagList(ifNoneMatch).some(
      (candidate) => stripWeakPrefix(candidate) === normalizedEtag,
    );
  }

  // If-Modified-Since (only evaluated when If-None-Match is absent)
  if (ifModifiedSince && lastModified) {
    const modifiedDate = parseHttpSeconds(lastModified);
    const sinceDate = parseRequestHttpSeconds(ifModifiedSince);
    if (!isNaN(modifiedDate) && !isNaN(sinceDate)) {
      // RFC 9110 Section 13.1.3: "A recipient MUST ignore
      // If-Modified-Since if the field value is not a valid HTTP-date,
      // or if it is a date in the future." A future date would cause
      // false freshness (always 304).
      if (sinceDate > Date.now()) return false;
      return modifiedDate <= sinceDate;
    }
  }

  return false;
}

/**
 * Check if a request's preconditions have failed.
 *
 * Implements RFC 7232 Section 3.1 (If-Match) and Section 3.4
 * (If-Unmodified-Since). `If-Match` takes precedence per the spec.
 *
 * When this returns true, the server MUST respond with 412 Precondition
 * Failed and skip processing the request body.
 *
 * Evaluation order per RFC 7232 Section 6:
 *   1. isPreconditionFailure -> 412 (this function)
 *   2. isConditionalFresh    -> 304
 *   3. Process range / serve content
 *
 * @param reqHeaders - Request headers (must support `.get(name)`)
 * @param etag - Current resource ETag
 * @param lastModified - Current resource Last-Modified date string
 * @param exists - Whether the resource currently exists. When omitted,
 *   inferred from `etag !== undefined`. Callers that have already fetched
 *   metadata (e.g. the read orchestrator) should pass `true` explicitly.
 */
export function isPreconditionFailure(
  reqHeaders: { get(name: string): string | null },
  etag: string | undefined,
  lastModified: string | undefined,
  exists?: boolean,
): boolean {
  // If-Match (RFC 7232 Section 3.1)
  const ifMatch = reqHeaders.get("if-match");
  if (ifMatch) {
    // RFC 9110 Section 13.1.1: "If-Match: *" is false when the server has
    // no current representation. Existence is threaded from the caller;
    // when omitted, inferred from etag presence.
    if (ifMatch.trim() === "*") {
      const present = exists ?? (etag !== undefined);
      return !present;
    }
    // No server ETag -> precondition fails (cannot confirm match)
    if (!etag) return true;
    // Strong comparison only. RFC 9110 Section 13.1.1: "A recipient
    // MUST use the strong comparison function when comparing entity-tags
    // for If-Match." This means: (a) both sides must be strong validators
    // (no W/ prefix), and (b) the quoted values must match exactly.
    // If the server's ETag is weak, it cannot satisfy If-Match because
    // a weak validator only asserts semantic equivalence, not byte equality.
    if (etag.startsWith("W/")) return true;
    const matches = parseETagList(ifMatch).some(
      (candidate) => !candidate.startsWith("W/") && candidate === etag,
    );
    return !matches;
  }

  // If-Unmodified-Since (RFC 7232 Section 3.4)
  // Only evaluated when If-Match is absent.
  const ifUnmodifiedSince = reqHeaders.get("if-unmodified-since");
  if (ifUnmodifiedSince) {
    // RFC 9110 Section 13.1.4: "A recipient MUST ignore the
    // If-Unmodified-Since header field if the resource does not have
    // a modification date available." No date = ignore = no failure.
    if (!lastModified) return false;
    const modifiedDate = parseHttpSeconds(lastModified);
    const sinceDate = parseRequestHttpSeconds(ifUnmodifiedSince);
    if (!isNaN(modifiedDate) && !isNaN(sinceDate)) {
      // Precondition fails if the resource was modified after the client's date
      return modifiedDate > sinceDate;
    }
    // RFC 9110 Section 13.1.4: "A recipient MUST ignore the
    // If-Unmodified-Since header field if the received field-value
    // is not a valid HTTP-date." Unparseable dates are ignored.
    return false;
  }

  return false;
}

/**
 * Check if a Range request's `If-Range` precondition is "fresh".
 *
 * RFC 7233 Section 3.2: If the client sends `If-Range`, the server MUST
 * only honor the Range when the validator matches. If it doesn't match,
 * the resource has changed since the client cached it, so serving a partial
 * response would result in data corruption (new bytes appended to old content).
 *
 * Returns `true` if the Range should be honored (validator matches or no If-Range).
 * Returns `false` if the Range should be ignored (serve full 200 instead).
 *
 * @param reqHeaders - Request headers
 * @param etag - Current resource ETag
 * @param lastModified - Current resource Last-Modified date string
 */
export function isRangeFresh(
  reqHeaders: { get(name: string): string | null },
  etag: string | undefined,
  lastModified: string | undefined,
): boolean {
  const ifRange = reqHeaders.get("if-range");

  // No If-Range header -> range is always fresh (honor the Range)
  if (!ifRange) return true;

  // If-Range as ETag (contains a quote character)
  if (ifRange.includes('"')) {
    if (!etag) return false;
    const client = ifRange.trim();
    // RFC 7233 Section 3.2: If-Range requires a STRONG validator. If either
    // side is weak, the representations may be byte-different, so honoring
    // the range could splice mismatched bytes onto the client's cached body.
    if (client.startsWith("W/") || etag.startsWith("W/")) return false;
    return client === etag; // both strong: exact quoted match, no W/ stripping
  }

  // If-Range as HTTP-date. RFC 9110 Section 13.1.5: the condition is true
  // only if the date EXACTLY matches the representation's Last-Modified.
  // A lenient `<=` would honor the range when the current Last-Modified is
  // older than the client's cached date (clock skew, restored backup), even
  // though the bytes may differ -- splicing corrupted content.
  if (lastModified) {
    const lastMod = parseHttpSeconds(lastModified);
    const ifRangeDate = parseRequestHttpSeconds(ifRange);
    if (!isNaN(lastMod) && !isNaN(ifRangeDate)) {
      return lastMod === ifRangeDate;
    }
  }

  // Cannot validate -> ignore the range (return full resource)
  return false;
}

// ─── Response Builder ───────────────────────────────────────────────────────

/**
 * Build HTTP response headers for a full or partial content response.
 *
 * Always includes `Accept-Ranges: bytes` to advertise range support
 * (even on 200 responses, per RFC 7233 Section 2.3).
 *
 * Handles:
 *   - 200 OK (full content, when range is null)
 *   - 206 Partial Content (valid range)
 *
 * For error statuses (304, 412, 416), use the dedicated builders
 * (`build304Headers`, `build412Headers`, `build416Headers`).
 *
 * @returns Status code and headers dict ready to pass to `new Response()`.
 */
export function buildRangeResponseHeaders(opts: RangeResponseHeaderOpts): RangeResponseHeaders {
  const { totalSize, range, contentType, etag, lastModified, digest, cacheControl } = opts;

  // Validate totalSize to prevent invalid Content-Length / Content-Range headers.
  // Content-Length MUST be a non-negative integer (RFC 9110 Section 8.6).
  // `undefined` is the unknown-total sentinel (`bytes a-b/*`); it is only
  // admissible on a partial response and is re-checked on the 200 path below.
  if (totalSize !== undefined && (!Number.isSafeInteger(totalSize) || totalSize < 0)) {
    throw new RangeError(
      `buildRangeResponseHeaders: totalSize must be a non-negative safe integer or undefined, got ${totalSize}`,
    );
  }

  const headers: Record<string, string> = {};

  // Always advertise range support
  headers["Accept-Ranges"] = "bytes";

  if (contentType) {
    // MIME types commonly originate from stored upload metadata
    // (attacker-influenced at upload time); header-sanitize like every
    // other metadata-derived value.
    headers["Content-Type"] = sanitizeHeaderValue(contentType);
  }

  if (etag) {
    headers["ETag"] = sanitizeHeaderValue(etag);
  }

  if (lastModified) {
    // Strip CRLF from raw fallback to prevent header injection on unparseable dates
    headers["Last-Modified"] = toHttpDate(lastModified) ?? sanitizeHeaderValue(lastModified);
  }

  // RFC 9530: Repr-Digest covers the full representation.
  if (digest) emitReprDigest(headers, digest, range !== null);

  if (range) {
    // 206 Partial Content. The body length is the range span, so an unknown
    // total is emitted honestly as `*` (RFC 7233 Section 4.2) rather than a
    // fabricated number.
    const rangeLength = range.end - range.start + 1;
    headers["Content-Length"] = String(rangeLength);
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${totalSize ?? "*"}`;
    if (cacheControl) headers["Cache-Control"] = sanitizeHeaderValue(cacheControl);
    return { status: 206, headers };
  }

  // 200 OK (full content) -- a bodyful full response cannot be sized without a
  // known total, so the unknown sentinel is an adapter bug on this path.
  if (totalSize === undefined) {
    throw new RangeError(
      "buildRangeResponseHeaders: a full (non-range) response requires a known totalSize",
    );
  }
  headers["Content-Length"] = String(totalSize);
  if (cacheControl) headers["Cache-Control"] = sanitizeHeaderValue(cacheControl);
  return { status: 200, headers };
}

/**
 * Build 416 Range Not Satisfiable response headers.
 *
 * Per RFC 7233 Section 4.4, the response MUST include a Content-Range
 * header with the unsatisfied-range syntax: `bytes * /totalSize`.
 *
 * Deliberately omits ETag, Last-Modified, and Content-Type. These are
 * representation metadata for the successful response; including them
 * on error responses can poison shared caches.
 */
export function build416Headers(totalSize: number): RangeResponseHeaders {
  return {
    status: 416,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${totalSize}`,
      "Content-Length": "0",
    },
  };
}

// ─── Content-Range Parser ───────────────────────────────────────────────────

/** Result of parsing a Content-Range response header. */
export interface ParsedContentRange {
  /** First byte of the range (inclusive, 0-indexed). */
  start: number;
  /** Last byte of the range (inclusive). */
  end: number;
  /** Total size of the complete representation. */
  totalSize: number;
}

/**
 * Parse a `Content-Range` response header into structured fields.
 *
 * Understands the two RFC 7233 Section 4.2 forms:
 *   - `bytes 0-499/1000` (byte range with known total)
 *   - `bytes 0-499/*`    (byte range with unknown total, returns `totalSize: -1`)
 *
 * The unsatisfied-range form (`bytes * /1000`) is NOT parsed because it carries
 * no range information -- callers should check the HTTP status (416) instead.
 *
 * Returns `null` for:
 *   - Missing or empty header
 *   - Non-byte range units
 *   - Malformed syntax
 *   - Unsatisfied range form (`bytes * /...`)
 *
 * Storage adapters use this to extract `totalSize` from a 206 response when
 * the backend serves a range slice. Without it, each adapter reimplements the
 * same regex inline, with varying correctness on edge cases.
 *
 * @example
 * ```typescript
 * import { parseContentRange } from "partial-content";
 *
 * const cr = parseContentRange("bytes 0-499/1000");
 * // => { start: 0, end: 499, totalSize: 1000 }
 *
 * const unknown = parseContentRange("bytes 0-499/*");
 * // => { start: 0, end: 499, totalSize: -1 }
 * ```
 */
export function parseContentRange(
  header: string | null | undefined,
): ParsedContentRange | null {
  if (!header) return null;

  // RFC 7233 Section 4.2: content-range = byte-content-range / other-content-range
  // byte-content-range = bytes-unit SP ( byte-range-resp / unsatisfied-range )
  // Case-insensitive unit per RFC 9110 Section 14.1.
  const lower = header.toLowerCase();
  if (!lower.startsWith("bytes ")) return null;

  const spec = header.slice(6); // Strip "bytes "

  // Reject unsatisfied-range form: "bytes */1000"
  if (spec.startsWith("*")) return null;

  // Parse "start-end/total" or "start-end/*"
  const slashIdx = spec.indexOf("/");
  if (slashIdx === -1) return null;

  const rangePart = spec.slice(0, slashIdx).trim();
  const totalPart = spec.slice(slashIdx + 1).trim();

  const dashIdx = rangePart.indexOf("-");
  if (dashIdx === -1) return null;

  const startStr = rangePart.slice(0, dashIdx).trim();
  const endStr = rangePart.slice(dashIdx + 1).trim();

  if (!startStr || !endStr) return null;

  const start = parseStrictInt(startStr);
  const end = parseStrictInt(endStr);
  if (isNaN(start) || isNaN(end)) return null;
  if (start > end) return null;

  // Total: "*" means unknown (use -1 sentinel), otherwise must be a valid integer.
  let totalSize: number;
  if (totalPart === "*") {
    totalSize = -1;
  } else {
    totalSize = parseStrictInt(totalPart);
    if (isNaN(totalSize) || totalSize < 0) return null;
    // Sanity: end must be < totalSize when total is known.
    if (end >= totalSize) return null;
  }

  return { start, end, totalSize };
}

/**
 * Parse a string as a strict non-negative integer.
 * Rejects floats, scientific notation, negative values, and leading zeros
 * (except for the literal "0").
 */
function parseStrictInt(s: string): number {
  if (!/^\d+$/.test(s)) return NaN;
  const n = Number(s);
  if (n > Number.MAX_SAFE_INTEGER) return NaN;
  return n;
}

/**
 * Build 412 Precondition Failed response headers.
 *
 * Per RFC 7232 Section 4.2, a 412 response indicates that one or more
 * conditions in the request headers (If-Match, If-Unmodified-Since)
 * evaluated to false.
 *
 * Deliberately omits representation metadata (ETag, Last-Modified,
 * Content-Type) to prevent cache poisoning.
 */
export function build412Headers(): RangeResponseHeaders {
  return {
    status: 412,
    headers: {
      // Explicit Content-Length: 0 for enterprise proxies (HAProxy, Envoy)
      // that require it on bodyless responses to avoid chunked-encoding timeouts.
      "Content-Length": "0",
    },
  };
}

/**
 * Build 304 Not Modified response headers.
 *
 * Per RFC 7232 Section 4.1, a 304 response MUST NOT contain a message
 * body and SHOULD NOT include representation headers (Content-Type,
 * Content-Length, Content-Encoding, Content-Language, Content-Range).
 *
 * Only includes: ETag, Last-Modified, and Cache-Control.
 */
export function build304Headers(
  etag: string | undefined,
  lastModified: string | undefined,
  cacheControl?: string,
): RangeResponseHeaders {
  const headers: Record<string, string> = {};

  if (etag) {
    headers["ETag"] = sanitizeHeaderValue(etag);
  }
  // RFC 7232 Section 4.1: "a sender SHOULD NOT generate representation
  // metadata other than the above listed fields unless said metadata exists
  // for the purpose of guiding cache updates (e.g., Last-Modified might be
  // useful if the response does not have an ETag field)."
  // When ETag is present, Last-Modified is redundant (ETag is the stronger
  // validator). Omitting it reduces 304 size and matches Go stdlib behavior.
  if (lastModified && !etag) {
    headers["Last-Modified"] = toHttpDate(lastModified) ?? sanitizeHeaderValue(lastModified);
  }
  if (cacheControl) {
    headers["Cache-Control"] = sanitizeHeaderValue(cacheControl);
  }

  return { status: 304, headers };
}

/**
 * Evaluate a conditional request and return the correct HTTP response.
 *
 * Implements the full RFC 7232 Section 6 evaluation chain in the correct
 * order. This is the recommended entry point for most consumers -- it
 * eliminates the risk of misordering the evaluation steps.
 *
 * Evaluation order:
 *   1. `isPreconditionFailure` -> 412 Precondition Failed
 *   2. `isConditionalFresh`    -> 304 Not Modified
 *   3. `isRangeFresh`          -> Should we honor the Range?
 *   4. `parseRangeHeader`      -> Parse and validate the Range
 *   5. `buildRangeResponseHeaders` or `build416Headers`
 *
 * @returns Status, headers, and the parsed range (null if full content or error status).
 */
export function evaluateConditionalRequest(
  reqHeaders: { get(name: string): string | null },
  meta: {
    totalSize: number;
    contentType?: string;
    etag?: string;
    lastModified?: string;
    cacheControl?: string;
    /** RFC 9530 SHA-256 digest (raw base64, no prefix). Emitted as `Repr-Digest` on 200/206. */
    digest?: string;
  },
): EvaluatedRequest {
  // Guard against corrupt metadata from storage adapters. NaN, Infinity,
  // negative, or fractional sizes would produce invalid Content-Range /
  // Content-Length headers. Content-Length MUST be a non-negative integer
  // (RFC 9110 Section 8.6). Fail loudly so the caller notices the adapter bug.
  if (!Number.isSafeInteger(meta.totalSize) || meta.totalSize < 0) {
    throw new RangeError(
      `evaluateConditionalRequest: totalSize must be a non-negative safe integer, got ${meta.totalSize}`,
    );
  }
  // Pre-compute the HTTP-date once. toHttpDate calls Date.parse + toUTCString
  // which together cost ~190ns. Without caching, the orchestrator would call
  // it up to 4 times on the same string (isPreconditionFailure,
  // isConditionalFresh, isRangeFresh, and the final header builder).
  const httpDate = meta.lastModified ? toHttpDate(meta.lastModified) : undefined;
  // Use the normalized IMF-fixdate for all downstream calls.
  // If toHttpDate returned undefined (unparseable), fall back to sanitized
  // raw string. This matches the standalone builders (build304Headers,
  // buildRangeResponseHeaders) which apply the same sanitizeHeaderValue on
  // their fallback path.
  const normalizedLastModified = httpDate ?? (meta.lastModified ? sanitizeHeaderValue(meta.lastModified) : undefined);

  // Step 1: Preconditions (If-Match / If-Unmodified-Since)
  // Pass exists: true because metadata was already fetched (the resource exists).
  if (isPreconditionFailure(reqHeaders, meta.etag, normalizedLastModified, true)) {
    return { ...build412Headers(), range: null };
  }

  // Step 2: Freshness (If-None-Match / If-Modified-Since)
  if (isConditionalFresh(reqHeaders, meta.etag, normalizedLastModified)) {
    // Pass pre-formatted date directly to avoid another toHttpDate call.
    const headers: Record<string, string> = {};
    if (meta.etag) headers["ETag"] = sanitizeHeaderValue(meta.etag);
    // RFC 7232 Section 4.1: omit Last-Modified when ETag is present (see build304Headers).
    if (normalizedLastModified && !meta.etag) headers["Last-Modified"] = normalizedLastModified;
    if (meta.cacheControl) headers["Cache-Control"] = sanitizeHeaderValue(meta.cacheControl);
    return { status: 304, headers, range: null };
  }

  // Step 3-4: Range validation and parsing
  const rangeHeader = reqHeaders.get("range");
  const rangeFresh = isRangeFresh(reqHeaders, meta.etag, normalizedLastModified);
  const parsed = rangeFresh && rangeHeader
    ? parseRangeHeader(rangeHeader, meta.totalSize)
    : null;

  // Step 5: Build response
  if (parsed === "unsatisfiable") {
    return { ...build416Headers(meta.totalSize), range: null };
  }

  // Inline the header building to avoid another toHttpDate call inside
  // buildRangeResponseHeaders.
  const headers: Record<string, string> = {};
  headers["Accept-Ranges"] = "bytes";
  if (meta.contentType) headers["Content-Type"] = sanitizeHeaderValue(meta.contentType);
  if (meta.etag) headers["ETag"] = sanitizeHeaderValue(meta.etag);
  if (normalizedLastModified) headers["Last-Modified"] = normalizedLastModified;

  // RFC 9530: Repr-Digest and Content-Digest.
  // Only emit when the client accepts sha-256 (or sends no Want-* header).
  if (meta.digest && clientWantsDigest(reqHeaders)) {
    emitReprDigest(headers, meta.digest, parsed !== null);
  }

  // Emit Cache-Control on 200/206 (not only 304) so standalone orchestrator
  // consumers get complete response headers without a framework adapter.
  if (meta.cacheControl) headers["Cache-Control"] = sanitizeHeaderValue(meta.cacheControl);

  if (parsed) {
    const rangeLength = parsed.end - parsed.start + 1;
    headers["Content-Length"] = String(rangeLength);
    headers["Content-Range"] = `bytes ${parsed.start}-${parsed.end}/${meta.totalSize}`;
    return { status: 206, headers, range: parsed };
  }

  headers["Content-Length"] = String(meta.totalSize);
  return { status: 200, headers, range: parsed };
}

// ─── Write-Side Orchestrator ────────────────────────────────────────────────

/**
 * Result of a conditional-write evaluation.
 *
 * Discriminated union on `proceed`:
 * - `{ proceed: true }` -- safe to execute the write.
 * - `{ proceed: false, status: 412, headers }` -- return 412 to the client.
 */
export type EvaluatedWrite =
  | { proceed: true }
  | { proceed: false; status: 412; headers: Record<string, string> };

/**
 * Evaluate conditional headers for a **write** request (PUT, PATCH, DELETE).
 *
 * On read requests (GET/HEAD), `If-None-Match` match triggers 304 Not Modified.
 * On write requests, the same match triggers **412 Precondition Failed**
 * (RFC 9110 Section 13.1.2). This function implements the write-side
 * evaluation so consumers don't accidentally use the read-side orchestrator
 * for OCC flows.
 *
 * Evaluation order (RFC 9110 Section 13.2.2):
 *   1. `If-Match` / `If-Unmodified-Since` -> 412 (same as reads)
 *   2. `If-None-Match`                    -> 412 (differs from reads: 412, not 304)
 *
 * ### OCC pattern (If-Match)
 *
 * ```typescript
 * const result = evaluateConditionalWrite(req.headers, {
 *   etag: '"v2"',
 *   lastModified: "2025-06-28T12:00:00.000Z",
 * });
 * if (!result.proceed) {
 *   return new Response(null, { status: result.status, headers: result.headers });
 * }
 * // Safe to apply the mutation
 * ```
 *
 * ### PUT-if-absent pattern (If-None-Match: *)
 *
 * ```typescript
 * const result = evaluateConditionalWrite(req.headers, {
 *   etag: existingEtag, // undefined if resource doesn't exist yet
 *   exists: resourceExists,
 * });
 * ```
 *
 * @param reqHeaders - Request headers (must support `.get(name)`)
 * @param meta - Current resource state
 */
export function evaluateConditionalWrite(
  reqHeaders: { get(name: string): string | null },
  meta: {
    etag?: string;
    lastModified?: string;
    /**
     * Whether the target resource currently exists. Used to evaluate
     * `If-None-Match: *` (PUT-if-absent / create-only pattern).
     *
     * When omitted, existence is inferred from `etag !== undefined`.
     */
    exists?: boolean;
  },
): EvaluatedWrite {
  // Normalize lastModified once, same pattern as the read orchestrator.
  const httpDate = meta.lastModified ? toHttpDate(meta.lastModified) : undefined;
  const normalizedLastModified = httpDate ?? (meta.lastModified ? sanitizeHeaderValue(meta.lastModified) : undefined);

  // Helper: build 412 headers, including the current ETag when available
  // so the client can resync without a follow-up GET.
  const make412 = (): EvaluatedWrite => ({
    proceed: false,
    status: 412 as const,
    headers: {
      "Content-Length": "0",
      ...(meta.etag ? { ETag: sanitizeHeaderValue(meta.etag) } : {}),
    },
  });

  // Step 1: If-Match / If-Unmodified-Since -> 412
  // Thread existence so If-Match:* is evaluated correctly.
  if (isPreconditionFailure(reqHeaders, meta.etag, normalizedLastModified, meta.exists)) {
    return make412();
  }

  // Step 2: If-None-Match -> 412 (NOT 304)
  // RFC 9110 Section 13.1.2: "if the request method is not GET or HEAD,
  // the server MUST respond with a 412 (Precondition Failed) status code."
  const ifNoneMatch = reqHeaders.get("if-none-match");
  if (ifNoneMatch) {
    if (ifNoneMatch.trim() === "*") {
      // Create-only. If existence is genuinely unknowable, FAIL CLOSED.
      // A loud error beats a silent overwrite of an existing resource.
      if (meta.exists === undefined && meta.etag === undefined) {
        throw new Error(
          "evaluateConditionalWrite: 'If-None-Match: *' (create-only) requires a known " +
          "existence state. Pass meta.exists explicitly -- refusing to guess and risk " +
          "overwriting an existing resource.",
        );
      }
      const resourceExists = meta.exists ?? (meta.etag !== undefined);
      if (resourceExists) {
        return make412();
      }
    } else if (meta.etag) {
      // Check if any client-provided ETag matches the current resource.
      const normalizedEtag = stripWeakPrefix(meta.etag);
      const matches = parseETagList(ifNoneMatch).some(
        (candidate) => stripWeakPrefix(candidate) === normalizedEtag,
      );
      if (matches) {
        return make412();
      }
    }
  }

  return { proceed: true };
}

/**
 * Adapter for Node.js HTTP servers (Express, Fastify, raw `http`).
 *
 * Converts a plain Node headers object (`IncomingHttpHeaders`) into the
 * `{ get(name) }` interface expected by `partial-content` functions.
 *
 * @example
 * ```typescript
 * import { fromNodeHeaders, isConditionalFresh } from "partial-content";
 *
 * // Express
 * app.get("/file", (req, res) => {
 *   const headers = fromNodeHeaders(req.headers);
 *   if (isConditionalFresh(headers, etag, lastModified)) {
 *     return res.status(304).end();
 *   }
 * });
 * ```
 */
export function fromNodeHeaders(
  headers: Record<string, string | string[] | undefined>,
): { get(name: string): string | null } {
  // Normalize keys to lowercase at construction time so lookups
  // work regardless of the caller's casing convention.
  const lower: Record<string, string | string[] | undefined> = {};
  for (const key in headers) {
    lower[key.toLowerCase()] = headers[key];
  }
  return {
    get(name: string): string | null {
      const val = lower[name.toLowerCase()];
      if (val === undefined) return null;
      // Node.js joins multi-value headers with ', ' for most headers,
      // but some proxies pass arrays. Join to match HTTP semantics.
      return Array.isArray(val) ? val.join(", ") : val;
    },
  };
}

// ─── ETag Generation ────────────────────────────────────────────────────────

/** Metadata from a storage backend used to derive an entity-tag. */
export interface ETagSource {
  /**
   * Content digest from the backend (S3/Azure/GCS object hash).
   * Yields a STRONG validator. May include surrounding quotes or `W/` prefix,
   * both of which are normalized.
   */
  hash?: string;
  /** Object size in bytes. With `mtime`, yields a WEAK validator when no hash exists. */
  size?: number;
  /**
   * Last-modified: `Date`, epoch-ms number, or any `Date.parse()`-able string.
   * Floor to whole seconds for consistency with emitted `Last-Modified` headers.
   */
  mtime?: Date | number | string;
}

/**
 * Derive an entity-tag from storage metadata.
 *
 * This is a **formatter**, not a hasher. It classifies what the storage backend
 * already provides into the correct validator strength per RFC 9110 Section 8.8.1:
 *
 * - `hash` present        -> strong `"<hash>"` (a content digest asserts byte equality)
 * - `size` + `mtime` only -> weak `W/"<size>-<mtime>"` (cannot assert byte equality;
 *                            mtime resolution is coarse, collisions exist)
 * - insufficient metadata -> `undefined` (caller omits ETag; never fabricate a
 *                            validator we cannot stand behind)
 *
 * The dangerous failure mode is emitting a strong or size-only validator that ignores
 * modification, which would serve stale 304s. Every `undefined` return guards that.
 *
 * @param source - Storage metadata to derive the ETag from
 * @returns A correctly-typed ETag string, or `undefined` if insufficient metadata
 */
export function generateETag(source: ETagSource): string | undefined {
  // Strong path: a content digest is a byte-exact validator.
  if (source.hash) {
    const raw = source.hash.trim();
    if (!raw) return toWeakETag(source);

    const stripped = stripWeakPrefix(raw);
    const weak = stripped !== raw; // W/ prefix was present
    // Strip anchoring quotes, then enforce etagc grammar (removes interior
    // DQUOTE/DEL/controls) so the emitted tag is always well-formed.
    const unquoted = sanitizeETagBody(stripped.replace(/^"|"$/g, ""));
    if (unquoted) return `${weak ? "W/" : ""}"${unquoted}"`;

    // Hash cleaned to empty (was just quotes) -> fall through to weak path
    return toWeakETag(source);
  }

  return toWeakETag(source);
}

/**
 * Attempt to build a weak ETag from size + mtime.
 * Returns `undefined` if either is missing or invalid.
 */
function toWeakETag(source: ETagSource): string | undefined {
  if (source.size === undefined || !Number.isFinite(source.size) || source.size < 0) return undefined;

  const ms = toEpochMs(source.mtime);
  if (ms === undefined) return undefined;

  const sizeHex = Math.floor(source.size).toString(16);
  // Floor mtime to seconds to match the emitted Last-Modified header resolution.
  // Without this, the ETag and Last-Modified would disagree on sub-second jitter.
  const mtimeHex = Math.floor(ms / 1000).toString(16);
  return `W/"${sizeHex}-${mtimeHex}"`;
}

/** Convert a Date, number, or string to epoch milliseconds, or undefined if unparseable. */
function toEpochMs(m: Date | number | string | undefined): number | undefined {
  if (m === undefined) return undefined;
  const t = m instanceof Date ? m.getTime() : typeof m === "number" ? m : Date.parse(m);
  return Number.isNaN(t) ? undefined : t;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Strip bytes outside RFC 9110 field-value grammar to prevent HTTP header
 * injection (CWE-113) and header-write crashes.
 *
 * Storage backends may pass through untrusted ETag, Last-Modified,
 * Content-Type, digest, Cache-Control, or Location values. Exported so
 * framework adapters can sanitize backend-derived headers the kernel does
 * not build itself (e.g. the web adapter's signed-URL `Location`).
 */
export function sanitizeHeaderValue(s: string): string {
  // Strip every byte outside RFC 9110 field-value grammar (HTAB, SP,
  // visible ASCII, obs-text). CR/LF alone is not enough: Node writeHead,
  // undici Headers, and Workers all THROW on any other control byte
  // (\x00-\x08, \x0B, \x0C, \x7F), which would turn a poisoned metadata
  // value into a runtime crash instead of a clean response. The character
  // class mirrors Node's own invalid-header-char check, so anything that
  // survives is writable on every runtime.
  return s.replace(/[^\t\x20-\x7e\x80-ÿ]/g, "");
}

/**
 * Emit RFC 9530 `Repr-Digest` (and `Content-Digest` on a full response) for
 * a backend SHA-256 digest. Single source of truth for both the header
 * builder and the orchestrator: the digest is header-sanitized (custom
 * stores can return anything), and `Content-Digest` is omitted on a 206
 * because it would have to cover only the range slice (RFC 9530 Section 2),
 * which requires streaming the bytes through crypto.
 */
function emitReprDigest(headers: Record<string, string>, digest: string, isPartial: boolean): void {
  const reprDigest = `sha-256=:${sanitizeHeaderValue(digest)}:`;
  headers["Repr-Digest"] = reprDigest;
  if (!isPartial) headers["Content-Digest"] = reprDigest;
}

/**
 * Sanitize an ETag body to RFC 9110 Section 8.8.3 `etagc` grammar:
 * `%x21 / %x23-7E / obs-text` -- i.e. field-value bytes MINUS DQUOTE
 * (0x22), which is the entity-tag delimiter. A backend hash containing an
 * embedded quote would otherwise emit a structurally-broken ETag like
 * `"abc"def"` that no cache can parse (silently defeating revalidation).
 * DEL (0x7F) and control bytes are already removed by sanitizeHeaderValue.
 */
function sanitizeETagBody(s: string): string {
  return sanitizeHeaderValue(s).replace(/"/g, "");
}

/** Strip the `W/` weak validator prefix from an ETag for comparison. */
function stripWeakPrefix(etag: string): string {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

/**
 * Parse a list of ETags from an If-None-Match or If-Match header.
 *
 * Quote-aware: correctly handles commas inside ETag values, which are
 * valid per RFC 7232 Section 2.3 (etagc includes %x2C). A naive
 * `.split(",")` would incorrectly split `"ver,1", "ver,2"` into four
 * fragments instead of two ETags.
 *
 * Uses character-by-character parsing with quote boundary tracking
 * (modeled on Go stdlib `scanETag()` from `net/http/fs.go`).
 */
function parseETagList(header: string): string[] {
  const tags: string[] = [];
  let i = 0;
  const len = header.length;

  while (i < len) {
    // Skip whitespace and comma separators
    while (i < len && (header[i] === " " || header[i] === "\t" || header[i] === ",")) i++;
    if (i >= len) break;

    const start = i;

    // Check for W/ weak prefix
    if (header[i] === "W" && i + 1 < len && header[i + 1] === "/") {
      i += 2;
    }

    // Must start with a double quote
    if (i >= len || header[i] !== '"') {
      // Not a valid ETag, skip to next comma or end
      while (i < len && header[i] !== ",") i++;
      continue;
    }
    i++; // skip opening quote

    // Scan for closing quote, validating each character is a valid etagc.
    // RFC 9110 Section 8.8.3: etagc = %x21 / %x23-7E / obs-text
    // obs-text = %x80-FF (extended ASCII / UTF-8 continuation bytes)
    // This matches Go stdlib scanETag() which rejects invalid characters.
    let valid = true;
    while (i < len && header[i] !== '"') {
      const c = header.charCodeAt(i);
      // Valid etagc: 0x21 (!) or 0x23-0x7E (#..~) or >= 0x80 (obs-text)
      // Invalid: 0x00-0x20 (controls + space), 0x22 ("), 0x7F (DEL)
      // 0x22 is the quote terminator so it's handled by the while condition.
      if (c < 0x21 || c === 0x7F) {
        valid = false;
        break;
      }
      i++;
    }

    if (!valid) {
      // Invalid etagc character found, skip this malformed ETag
      while (i < len && header[i] !== ",") i++;
      continue;
    }

    if (i < len) i++; // skip closing quote

    tags.push(header.slice(start, i));
  }

  return tags;
}

/**
 * Parse a string as a non-negative integer position.
 *
 * Only accepts pure digit strings. Rejects floats ("1.5"), scientific
 * notation ("1e3"), and negative values ("-5") that `parseInt()` would
 * silently truncate to valid-looking integers.
 *
 * Values beyond `Number.MAX_SAFE_INTEGER` are capped rather than rejected.
 * Some HTTP clients (Go net/http, curl -r) send max-uint64 values for
 * open-ended ranges (e.g. `bytes=500-18446744073709551615`). The downstream
 * `Math.min(end, totalSize - 1)` clamps to the file boundary, so capping
 * here is safe and avoids unnecessary full-file fallback.
 */
function parsePos(str: string): number {
  if (!/^\d+$/.test(str)) return NaN;
  const n = Number(str);
  // Cap values that lost integer precision. Any realistic file size
  // fits in MAX_SAFE_INTEGER (9 PB). The downstream Math.min clamp
  // narrows to the actual file boundary.
  if (n > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return n;
}

/**
 * Parse a date string and floor to whole seconds for HTTP-date comparison.
 *
 * HTTP-dates (RFC 9110 Section 5.6.7) have 1-second resolution, but storage
 * backends often provide ISO-8601 timestamps with millisecond precision
 * (e.g. "2025-06-29T12:00:00.500Z"). The emitted Last-Modified header is
 * floored to whole seconds via `toHttpDate()`, so the client echoes back a
 * date without sub-second granularity. If we compare the raw millisecond
 * timestamp against the floored client date, the skew defeats 304, triggers
 * spurious 412s, and breaks If-Range validation.
 *
 * Floor both sides to seconds so comparisons match the HTTP wire format.
 */
function parseHttpSeconds(s: string): number {
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : Math.floor(t / 1000) * 1000;
}

// RFC 9110 Section 5.6.7 HTTP-date grammar: IMF-fixdate, obsolete RFC 850,
// and ANSI C asctime. Client-supplied conditional dates MUST be ignored when
// they match none of these (Sections 13.1.3/13.1.4) -- bare Date.parse would
// also honor ISO 8601 and other formats the spec requires us to reject.
const IMF_FIXDATE_RE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE_RE =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE_RE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Parse a CLIENT-supplied conditional date, accepting only the three
 * HTTP-date formats. Returns NaN for anything else, which callers treat as
 * "header not present" per RFC 9110. Backend metadata keeps the lenient
 * `parseHttpSeconds` path (adapters may hand us ISO 8601; that is our own
 * input, not wire input).
 */
function parseRequestHttpSeconds(s: string): number {
  if (IMF_FIXDATE_RE.test(s) || RFC850_DATE_RE.test(s)) {
    return parseHttpSeconds(s);
  }
  // asctime carries no zone designator; RFC 9110 says it is UTC. Date.parse
  // would interpret it as LOCAL time, skewing comparisons by the server's
  // offset, so build the timestamp explicitly.
  const m = ASCTIME_DATE_RE.exec(s);
  if (m) {
    const [, mon, day, hh, mm, ss, year] = m;
    return Date.UTC(Number(year), MONTHS.indexOf(mon), Number(day), Number(hh), Number(mm), Number(ss));
  }
  return NaN;
}

/**
 * Normalize a date string to IMF-fixdate (RFC 9110 Section 5.6.7).
 *
 * `Date.prototype.toUTCString()` produces exactly the IMF-fixdate format
 * (e.g. "Sun, 29 Jun 2025 12:00:00 GMT") and floors to whole seconds,
 * fixing both format and sub-second granularity issues.
 *
 * Returns `undefined` for unparseable input so the caller can fall back.
 *
 * Single-entry memo: hot serving paths normalize the same Last-Modified
 * string on every request for the same object (stores that cache metadata
 * even hand back the same string reference, making the hit a pointer
 * compare). Date.parse + toUTCString together cost ~190ns per call and the
 * evaluation chain needs the normalized form on every conditional request.
 */
let httpDateMemoIn: string | undefined;
let httpDateMemoOut: string | undefined;

function toHttpDate(s: string): string | undefined {
  if (s === httpDateMemoIn) return httpDateMemoOut;
  const t = Date.parse(s);
  const out = Number.isNaN(t) ? undefined : new Date(t).toUTCString();
  httpDateMemoIn = s;
  httpDateMemoOut = out;
  return out;
}

/**
 * RFC 9530 Section 4: Check if the client wants a `sha-256` digest.
 *
 * `Want-Repr-Digest` uses Structured Fields Dictionary syntax:
 *   Want-Repr-Digest: sha-256=5, sha-512=3
 *
 * Each key is a hash algorithm, each value is a preference weight (0-10).
 * Weight 0 means "explicitly unwanted." If the header is absent or contains
 * `sha-256` with weight > 0, we emit the digest. If it only lists algorithms
 * we don't support (e.g. `sha-512=5`), we skip emission entirely.
 *
 * We also check `Want-Content-Digest` since our Content-Digest uses the
 * same algorithm.
 *
 * Exported so framework adapters apply the same negotiation the orchestrator
 * uses internally -- digest emission behaves identically at every layer.
 */
export function clientWantsDigest(reqHeaders: { get(name: string): string | null }): boolean {
  const want = reqHeaders.get("want-repr-digest") ?? reqHeaders.get("want-content-digest");
  // No preference header: server MAY send unsolicited digests (RFC 9530 Section 4)
  if (!want) return true;

  // Parse Structured Fields Dictionary: "sha-256=5, sha-512=3"
  // Look for sha-256 with non-zero weight
  const lower = want.toLowerCase();
  for (const entry of lower.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed.startsWith("sha-256")) continue;
    // Guard against matching hypothetical future algorithms like "sha-256-v2".
    // After the "sha-256" prefix, the next character must be '=' (weight),
    // end-of-string (bare preference), or whitespace.
    const nextChar = trimmed[7]; // "sha-256".length === 7
    if (nextChar !== undefined && nextChar !== "=" && nextChar !== " ") continue;
    // Extract weight: "sha-256=5" or just "sha-256"
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) return true; // bare "sha-256" means wanted
    // Strip any Structured Fields parameters (";q=...") before the weight.
    const weightStr = trimmed.slice(eqIdx + 1).split(";")[0]!.trim();
    const weight = Number(weightStr);
    // Weight 0 means explicitly unwanted
    return !Number.isNaN(weight) && weight > 0;
  }

  // Client sent Want-* but didn't list sha-256: they don't want our algorithm
  return false;
}
