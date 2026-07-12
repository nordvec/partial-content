/**
 * partial-content
 *
 * RFC-compliant HTTP Range Requests, Conditional Requests, and
 * Content-Disposition. Pure functions, zero dependencies, any runtime.
 *
 * @packageDocumentation
 */

// ─── Range Requests (RFC 7233) ──────────────────────────────────────────────
export {
  parseRangeHeader,
  parseContentRange,
  buildRangeResponseHeaders,
  build416Headers,
  OPEN_ENDED,
  isOpenEndedRange,
} from "./kernel.ts";

// ─── Multiple Ranges (multipart/byteranges) ─────────────────────────────────
export {
  parseRanges,
  MAX_RANGES_DEFAULT,
  generateMultipartBoundary,
  buildMultipartPartHeader,
  multipartEpilogue,
  buildMultipartHeaders,
} from "./kernel.ts";

// ─── Header Safety ──────────────────────────────────────────────────────────
export { sanitizeHeaderValue } from "./kernel.ts";

// ─── Conditional Requests (RFC 9110 / RFC 7232) ─────────────────────────────
export {
  isConditionalFresh,
  isPreconditionFailure,
  isRangeFresh,
  build304Headers,
  build412Headers,
  evaluateConditionalRequest,
  evaluateConditionalWrite,
} from "./kernel.ts";

// ─── Digest Negotiation (RFC 9530) ──────────────────────────────────────────
export { clientWantsDigest, clientWantsContentDigest } from "./kernel.ts";

// ─── Content-Coding Negotiation (RFC 9110 Section 12.5.3) ───────────────────
export { parseAcceptEncoding, negotiateEncoding, isCompressibleMime } from "./encoding.ts";
export type { AcceptEncodingEntry } from "./encoding.ts";

// ─── Cache-Control Composition (RFC 9111 / RFC 5861) ────────────────────────
export { buildCacheControl } from "./cache-control.ts";
export type { CacheControlPolicy } from "./cache-control.ts";

// ─── ETag Generation ────────────────────────────────────────────────────────
export { generateETag } from "./kernel.ts";

// ─── Adapters ───────────────────────────────────────────────────────────────
export { fromNodeHeaders } from "./kernel.ts";

// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  ParsedRange,
  ParsedContentRange,
  RangeResponseHeaderOpts,
  RangeResponseHeaders,
  EvaluatedRequest,
  EvaluatedWrite,
  ETagSource,
  RangeSet,
  MultipartResponse,
} from "./kernel.ts";

// ─── Storage Contract ───────────────────────────────────────────────────────
export type {
  CancelSignal,
  ObjectStore,
  ObjectMetadata,
  ObjectStream,
  ServedRange,
  ResolvedContentRange,
  HeadObjectOptions,
  GetObjectOptions,
  StoreErrorClassifiers,
} from "./object-store.ts";

// ─── Storage Primitives ─────────────────────────────────────────────────────
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError, nodeStreamToWeb, guardStreamLength, resolveServedRange, classifyStoreRead, parseRetryAfterSeconds } from "./object-store.ts";

// ─── Content-Disposition (RFC 6266 / RFC 8187) ──────────────────────────────
export { buildContentDisposition } from "./content-disposition.ts";
export type { ContentDispositionOptions } from "./content-disposition.ts";

