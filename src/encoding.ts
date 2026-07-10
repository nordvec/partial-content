/**
 * Accept-Encoding negotiation (RFC 9110 Section 12.5.3) for precompressed
 * variant serving.
 *
 * These are the protocol primitives behind the web adapter's `precompressed`
 * option: parse the client's Accept-Encoding field, rank the server's
 * available content codings against it, and gate negotiation on content types
 * that actually benefit from compression.
 *
 * Deliberate scope: SELECTION of a stored, already-encoded sibling object
 * (`report.json` -> `report.json.br`). On-the-fly compression is out of scope
 * for a range-serving library -- transforming bytes at serve time breaks
 * byte-exact ranges, strong validators, and representation digests.
 *
 * @packageDocumentation
 */

// ─── Parsing ────────────────────────────────────────────────────────────────

/** One parsed Accept-Encoding member: a content coding and its quality. */
export interface AcceptEncodingEntry {
  /** Content coding token, lowercased (`"br"`, `"gzip"`, `"*"`, ...). */
  coding: string;
  /** Quality value in [0, 1]; 0 means "not acceptable". */
  q: number;
}

/** RFC 9110 token for a content coding (or the `*` wildcard). */
const CODING_RE = /^(?:\*|[!#$%&'+.^_`|~0-9A-Za-z-]+)$/;
/** RFC 9110 qvalue: 0/1 with up to three decimals. */
const QVALUE_RE = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Parse an `Accept-Encoding` field value into coding/quality entries.
 *
 * Robustness rules (all linear-time, no backtracking):
 * - Members are comma-separated; whitespace around members, `;`, and `=` is
 *   tolerated (RFC 9110 OWS).
 * - A malformed member (bad token, bad qvalue) is SKIPPED, never fatal: one
 *   broken UA extension must not disable negotiation for the whole request.
 * - Duplicate codings resolve last-wins, matching the library's RFC 8941
 *   duplicate-key stance elsewhere.
 * - Unknown parameters other than `q` are ignored per spec.
 *
 * Returns entries in field order (minus overridden duplicates). An absent
 * header is the CALLER's signal (pass the raw `string | null` through to
 * {@link negotiateEncoding}); this function treats `""` as "no codings
 * listed", which per spec means only `identity` is acceptable.
 */
export function parseAcceptEncoding(header: string): AcceptEncodingEntry[] {
  const byCoding = new Map<string, number>();
  for (const rawMember of header.split(",")) {
    const parts = rawMember.split(";");
    const coding = parts[0]!.trim().toLowerCase();
    if (!CODING_RE.test(coding)) continue;
    let q = 1;
    let malformed = false;
    for (let i = 1; i < parts.length; i++) {
      const param = parts[i]!.trim();
      const eq = param.indexOf("=");
      if (eq === -1) { malformed = true; break; }
      const name = param.slice(0, eq).trim().toLowerCase();
      if (name !== "q") continue; // unknown parameters are ignored
      const value = param.slice(eq + 1).trim();
      if (!QVALUE_RE.test(value)) { malformed = true; break; }
      q = Number(value);
    }
    if (malformed) continue;
    // Last-wins on duplicates; Map preserves first-insertion order, so
    // re-setting keeps field position while updating the quality.
    byCoding.set(coding, q);
  }
  return [...byCoding].map(([coding, q]) => ({ coding, q }));
}

// ─── Negotiation ────────────────────────────────────────────────────────────

/**
 * Rank the server's available content codings against a request's
 * Accept-Encoding field.
 *
 * Returns the codings from `available` that the client accepts, ordered by
 * client quality (descending), ties broken by `available` order (the server's
 * preference, e.g. `["br", "zstd", "gzip"]`). The caller tries them in order
 * -- the first one whose precompressed sibling object exists wins -- and
 * falls back to the identity representation when the list is empty or no
 * sibling exists.
 *
 * Semantics (RFC 9110 Section 12.5.3):
 * - `header === null` (absent field): the client expresses no preference;
 *   serve identity -> `[]`.
 * - `""` (empty field): only identity is acceptable -> `[]`.
 * - `*` matches any coding not explicitly listed.
 * - `q=0` excludes a coding.
 * - A coding is only offered when its quality is at least identity's:
 *   `Accept-Encoding: identity, gzip;q=0.5` yields `[]` because the client
 *   prefers the unencoded bytes. When identity is unlisted (and not covered
 *   by `*`), any explicitly acceptable coding outranks it -- listing a
 *   coding IS the preference signal browsers send (`gzip, deflate, br, zstd`).
 * - This library never emits 406 for encoding: identity remains the universal
 *   fallback, the behavior every production file server ships.
 */
export function negotiateEncoding(
  header: string | null,
  available: readonly string[],
): string[] {
  if (header === null) return [];
  const entries = parseAcceptEncoding(header);
  if (entries.length === 0) return [];

  let star: number | undefined;
  const explicit = new Map<string, number>();
  for (const { coding, q } of entries) {
    if (coding === "*") star = q;
    else explicit.set(coding, q);
  }

  // Identity's effective quality: explicit entry, else wildcard, else 0
  // (unlisted identity stays ACCEPTABLE as the fallback, but expresses no
  // preference, so any explicitly listed coding outranks it).
  const identityQ = explicit.get("identity") ?? star ?? 0;

  const ranked: Array<{ coding: string; q: number; idx: number }> = [];
  for (let idx = 0; idx < available.length; idx++) {
    const coding = available[idx]!.toLowerCase();
    const q = explicit.get(coding) ?? star;
    if (q === undefined || q <= 0) continue;
    if (q < identityQ) continue;
    ranked.push({ coding, q, idx });
  }
  ranked.sort((a, b) => b.q - a.q || a.idx - b.idx);
  return ranked.map((r) => r.coding);
}

// ─── Compressibility Gate ───────────────────────────────────────────────────

/**
 * Media types that are already entropy-coded: negotiating a precompressed
 * sibling for them wastes a probe round-trip and storage for ~0% savings.
 * The gate is an allowlist of compressible types rather than a denylist of
 * compressed ones, so unknown types default to "don't negotiate" (safe).
 */
const COMPRESSIBLE_APPLICATION_SUBTYPES = new Set([
  "json",
  "xml",
  "xml-dtd",
  "javascript",
  "ecmascript",
  "wasm",
  "x-www-form-urlencoded",
  "toml",
  "yaml",
  "sql",
  "rtf",
  "postscript",
  "tar",
  "x-tar",
  "x-sh",
]);

const COMPRESSIBLE_EXACT = new Set([
  "font/ttf",
  "font/otf",
  "font/collection",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "message/rfc822",
  "model/gltf-binary",
]);

/**
 * True when a media type benefits from a precompressed variant.
 *
 * Covers `text/*` (except the streaming `text/event-stream`), the structured
 * `application/*` formats, `+json`/`+xml`/`+yaml`/`+toml`/`+text` structured
 * suffixes (which is how `image/svg+xml` qualifies), uncompressed fonts
 * (`ttf`/`otf` -- `woff`/`woff2` embed their own compression), and the
 * handful of uncompressed binary formats (BMP, ICO, glTF).
 *
 * Everything already entropy-coded (JPEG, PNG, video, audio, zip, PDF,
 * OOXML, woff2) returns `false`, so the serve path never wastes a variant
 * probe on it.
 */
export function isCompressibleMime(mime: string): boolean {
  const semi = mime.indexOf(";");
  const essence = (semi === -1 ? mime : mime.slice(0, semi)).trim().toLowerCase();
  if (essence.startsWith("text/")) return essence !== "text/event-stream";
  if (COMPRESSIBLE_EXACT.has(essence)) return true;
  const slash = essence.indexOf("/");
  if (slash === -1) return false;
  const subtype = essence.slice(slash + 1);
  if (essence.startsWith("application/") && COMPRESSIBLE_APPLICATION_SUBTYPES.has(subtype)) {
    return true;
  }
  const plus = subtype.lastIndexOf("+");
  if (plus !== -1) {
    const suffix = subtype.slice(plus + 1);
    return suffix === "json" || suffix === "xml" || suffix === "yaml"
      || suffix === "toml" || suffix === "text";
  }
  return false;
}
