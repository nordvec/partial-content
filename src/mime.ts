/**
 * Minimal MIME type lookup for file serving.
 *
 * A curated extension -> MIME map covering the formats that actually flow
 * through document/media serving: office documents, images, audio/video,
 * archives, fonts, and web assets. Deliberately small and auditable rather
 * than exhaustive -- for the long tail, pass an explicit `mime` to the
 * serve handler or bring a full database (`mime-types`, `mrmime`).
 *
 * Zero dependencies, aligned with IANA registrations and the WHATWG
 * mimesniff living standard.
 *
 * @example
 * ```typescript
 * import { serveObject } from "partial-content/node";
 * import { fsStore } from "partial-content/fs";
 * import { lookupMime } from "partial-content/mime";
 *
 * const handler = serveObject(fsStore({ root: "/data" }), {
 *   key: (req) => req.params.key,
 *   mime: (req) => lookupMime(req.params.key),
 * });
 * ```
 *
 * @packageDocumentation
 */

// ─── Extension Map ──────────────────────────────────────────────────────────

/**
 * Extension (lowercase, no dot) -> MIME type.
 *
 * Security-relevant choices:
 * - `html`/`htm`/`xhtml` are intentionally ABSENT: serving stored user
 *   uploads as `text/html` is stored XSS. If you serve trusted HTML, pass
 *   the MIME explicitly so the decision is visible at the call site.
 * - Several mapped types are ACTIVE CONTENT that can execute script when
 *   rendered `inline` from your own origin. For untrusted uploads serve
 *   them `attachment` (the library's default disposition) or behind a
 *   strict CSP -- never plain `inline`:
 *     - `svg`  -> `image/svg+xml`   (embedded `<script>`, event handlers)
 *     - `pdf`  -> `application/pdf` (embedded JavaScript in the viewer)
 *     - `xml`  -> `application/xml` (`<?xml-stylesheet?>` can run XSLT)
 *   `X-Content-Type-Options: nosniff` and the default `attachment`
 *   disposition already protect the built-in serve path; the warning
 *   matters when a caller overrides `disposition: "inline"`.
 */
// Null prototype: the lookup key is attacker-influenced (filenames, storage
// keys), and on a plain object `lookupMime("file.constructor")` would return
// Object.prototype members (a function, not a string), breaking the declared
// contract and crashing downstream header building.
const MIME_TYPES: Record<string, string> = Object.assign(Object.create(null), {
  // Documents
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  ics: "text/calendar",
  vcf: "text/vcard",

  // Office (OOXML + legacy + OpenDocument)
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",

  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",

  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",

  // Video
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  ogv: "video/ogg",

  // Archives
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",

  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",

  // Web assets
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  wasm: "application/wasm",
});

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Look up the MIME type for a filename, path, storage key, or bare extension.
 *
 * Matching is case-insensitive and uses the LAST dot segment, so keys like
 * `2025/reports/Q4 Report.PDF` and `archive.tar.gz` resolve correctly
 * (`application/pdf`, `application/gzip`).
 *
 * Returns `undefined` for unknown or missing extensions so the caller
 * controls the fallback (the serve handlers default to
 * `application/octet-stream`, the safe choice for unknown content).
 *
 * @example
 * ```typescript
 * lookupMime("report.pdf");          // "application/pdf"
 * lookupMime("Q4 Report.PDF");       // "application/pdf"
 * lookupMime("archive.tar.gz");      // "application/gzip"
 * lookupMime("pdf");                 // "application/pdf" (bare extension)
 * lookupMime("unknown.xyz");         // undefined
 * lookupMime("no-extension");        // undefined (unless it IS an extension)
 * ```
 */
export function lookupMime(filenameOrExt: string | null | undefined): string | undefined {
  if (!filenameOrExt) return undefined;

  const lastDot = filenameOrExt.lastIndexOf(".");
  // No dot: treat the whole input as a bare extension ("pdf" -> pdf).
  // Trailing dot ("file.") yields an empty extension -> undefined.
  const ext = lastDot === -1
    ? filenameOrExt
    : filenameOrExt.slice(lastDot + 1);

  if (!ext) return undefined;
  return MIME_TYPES[ext.toLowerCase()];
}
