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
} from "./kernel.js";

// ─── Multiple Ranges (multipart/byteranges) ─────────────────────────────────
export {
  parseRanges,
  MAX_RANGES_DEFAULT,
  generateMultipartBoundary,
  buildMultipartPartHeader,
  multipartEpilogue,
  buildMultipartHeaders,
} from "./kernel.js";

// ─── Header Safety ──────────────────────────────────────────────────────────
export { sanitizeHeaderValue } from "./kernel.js";

// ─── Conditional Requests (RFC 9110 / RFC 7232) ─────────────────────────────
export {
  isConditionalFresh,
  isPreconditionFailure,
  isRangeFresh,
  build304Headers,
  build412Headers,
  evaluateConditionalRequest,
  evaluateConditionalWrite,
} from "./kernel.js";

// ─── Digest Negotiation (RFC 9530) ──────────────────────────────────────────
export { clientWantsDigest } from "./kernel.js";

// ─── ETag Generation ────────────────────────────────────────────────────────
export { generateETag } from "./kernel.js";

// ─── Adapters ───────────────────────────────────────────────────────────────
export { fromNodeHeaders } from "./kernel.js";

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
} from "./kernel.js";

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
} from "./object-store.js";

// ─── Storage Primitives ─────────────────────────────────────────────────────
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError, nodeStreamToWeb, guardStreamLength, resolveServedRange, classifyStoreRead, parseRetryAfterSeconds } from "./object-store.js";

// ─── Content-Disposition (RFC 6266 / RFC 8187) ──────────────────────────────
export { buildContentDisposition } from "./content-disposition.js";
export type { ContentDispositionOptions } from "./content-disposition.js";

