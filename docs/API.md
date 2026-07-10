# API Reference

The complete export surface. Everything is typed; your editor's IntelliSense mirrors this page.

## Kernel (`partial-content`)

**`evaluateConditionalRequest(reqHeaders, meta)`** - One-call handler for the full HTTP evaluation chain (GET/HEAD). Returns `{ status, headers, range }`.

**`evaluateConditionalWrite(reqHeaders, meta)`** - One-call handler for write requests (PUT/PATCH/DELETE). Returns `{ proceed: true }` or `{ proceed: false, status: 412, headers }`. The 412 response includes the current `ETag` when available, so the client can resync without a follow-up GET.

**`parseRangeHeader(rangeHeader, totalSize)`** - Returns `{ start, end }`, `"unsatisfiable"`, or `null`.

**`parseRanges(rangeHeader, totalSize, maxRanges?)`** - Multi-range parsing for `multipart/byteranges`: coalesces overlapping/adjacent ranges and applies range-amplification defenses. Returns a `RangeSet`, `"unsatisfiable"`, or `null` (serve the full 200).

**`buildRangeResponseHeaders(opts)`** - Build 200 or 206 response headers.

**`buildMultipartHeaders(opts)` / `buildMultipartPartHeader(...)` / `multipartEpilogue(boundary)` / `generateMultipartBoundary()`** - The `multipart/byteranges` framing primitives with exact precomputed Content-Length (never chunked).

**`parseContentRange(header)`** - Parse a `Content-Range` response header (e.g. `bytes 0-499/1000`). Returns `{ start, end, totalSize }` or `null`.

**`generateETag(source)`** - Derive an entity-tag from storage metadata. Returns a strong `"<hash>"` when a content digest is available, a weak `W/"<size>-<mtime>"` when only size and modification time are known, or `undefined` when there is insufficient metadata.

**`buildContentDisposition(filename, options?)`** - Security-hardened `Content-Disposition` header builder with CRLF injection prevention, path traversal protection, bidi override stripping, and RFC 8187 non-ASCII encoding.

**`fromNodeHeaders(headers)`** - Convert Node.js `IncomingHttpHeaders` to the `{ get(name) }` interface.

**`isConditionalFresh(reqHeaders, etag, lastModified)`** - `true` if not modified (304).

**`isPreconditionFailure(reqHeaders, etag, lastModified, exists?)`** - `true` if precondition failed (412). Pass `exists` when the resource's presence is known independently of its validators (e.g. `If-Match: *` upload guards).

**`isRangeFresh(reqHeaders, etag, lastModified)`** - `true` if If-Range passes (honor the range).

**`build304Headers(etag, lastModified, cacheControl?)`** - Build 304 headers.

**`build412Headers()`** - Build 412 headers.

**`build416Headers(totalSize)`** - Build 416 Range Not Satisfiable headers.

**`clientWantsDigest(reqHeaders)`** - RFC 9530 Section 4 negotiation: `true` when the client's `Want-Repr-Digest` / `Want-Content-Digest` headers accept `sha-256` (or are absent). The web adapter and orchestrator both honor this, so `Want-Repr-Digest: sha-256=0` suppresses digest emission everywhere.

**`sanitizeHeaderValue(s)`** - Strip every byte outside RFC 9110 field-value grammar. The kernel applies it to all metadata-derived headers; exported so adapters can sanitize headers they build themselves.

## MIME Lookup (`partial-content/mime`)

**`lookupMime(filenameOrExt)`** - Curated, zero-dependency extension -> MIME lookup for documents, media, archives, fonts, and web assets. Case-insensitive, resolves the last dot segment (`archive.tar.gz` -> `application/gzip`), returns `undefined` for unknown types so the caller controls the fallback. `html` is deliberately absent: serving stored uploads as `text/html` is stored XSS, so that decision must be explicit at the call site.

```typescript
import { lookupMime } from "partial-content/mime";

app.get("/files/:key", serveObject(store, {
  key: (req) => req.params.key,
  mime: (req) => lookupMime(req.params.key),
}));
```

## Universal HTTP Store (`partial-content/http`)

**`httpStore({ url, headers?, fetch?, redirect? })`** - Serve from ANY range-capable HTTP origin over plain `fetch`: Supabase Storage, presigned S3/GCS/Azure URLs, CDN origins, or another partial-content server. Pinned reads map to `If-Match` (origin 412 -> `ObjectChangedError`), `Repr-Digest` response headers are extracted, and requests are sent `Accept-Encoding: identity` and any response that still carries a non-identity `Content-Encoding` is refused, so transparent compression can never corrupt byte accounting. Redirects error by default (a hostile origin must not 3xx the store toward internal/metadata IPs); set `redirect: "follow"` for origins that legitimately redirect, paired with a validating `fetch` when keys are untrusted (see SECURITY.md).

```typescript
import { httpStore } from "partial-content/http";

const store = httpStore({
  url: (key) => `${SUPABASE_URL}/storage/v1/object/documents/${key}`,
  headers: { Authorization: `Bearer ${serviceRoleKey}` },
});
```

## Memory Store (`partial-content/memory`)

**`memoryStore({ objects })`** - A spec-faithful in-memory store for consumer test suites, demos, and small embedded assets. Fabricates correct Content-Range values, honors `ifMatch` pinning (mutate the map to simulate overwrites and exercise retry logic), and streams zero-byte objects correctly.

## Web Adapter (`partial-content/web`)

**`serveObject(store, options?)`** - Create a Fetch API handler that serves files from an ObjectStore. Returns `(req: Request, ctx: ServeContext) => Promise<Response>`.

**`serveObjectRaw(store, options?)`** - The same engine returning `RawResponseParts` (`{ status, statusText, headers, body }`) instead of a `Response`, for server adapters that write to their runtime natively (the bundled node adapter uses it). Skips all fetch-primitive construction on the hot path.

Options: `disposition`, `cacheControl`, `immutable`, `securityHeaders`, `crossOriginResourcePolicy`, `timingAllowOrigin`, `timing`, `onTiming`, `onError`, `onServe`, `onTransfer`, `maxRanges`, `enforceCharset`, `fallbackFilename`.

`ServeContext`: `key` (required), `mime?`, `filename?`, `cacheControl?` (per-request override of the handler-level value, e.g. `immutable` for content-addressed keys next to `private, no-cache` user uploads from the same handler).

`cacheControl` is emitted verbatim on 200/206/304, so any directive vocabulary your CDN or edge understands passes straight through: RFC 9111 `s-maxage` / `must-revalidate` / `proxy-revalidate` and the RFC 5861 resilience directives `stale-while-revalidate` and `stale-if-error`. The library does not synthesize or reorder directives (only appending `immutable` when the `immutable` option is set and it is not already present), so you keep full control of the response caching policy. `Vary` (e.g. `Vary: Accept-Encoding`) rides `securityHeaders`.

## Node Adapter (`partial-content/node`)

**`serveObject(store, options)`** - Create a Node.js `(req, res) => Promise<void>` handler for Express, Fastify (compat), Koa, and raw `http.createServer`. Extends the web adapter options with `key` (required, extracts the storage key from `IncomingMessage`), `mime?`, and `filename?`.

**`writeStallTimeoutMs?`** (default `60000`) - Bounds how long the streaming pump waits for a single backpressure `drain` before treating the client as stalled and tearing the transfer down (cancel the storage read, destroy the response). A client that stops reading but holds its socket open would otherwise pin a backend storage connection indefinitely (a slow-read attack). Set to `0` to disable and rely on an upstream proxy / socket timeout instead. Only the raw-Node pump needs this; Fetch-runtime backpressure is the platform's own concern.

## Storage Contract

**`ObjectStore`** (interface) - Read-only storage backend abstraction. Implementations provide `headObject(key, opts?)` for metadata and `getObject(key, opts?)` for streaming, where `opts` carries `range`, `signal`, `ifMatch` (pinned reads), and `pin` (an opaque token issued by `headObject` for stores whose version identifier is not the ETag; GCS uses it to stream a pinned generation without re-fetching metadata). Optional `createSignedUrl(key, opts)` for backends that cannot stream ranges through the origin. Optional `authoritativeRange: true` declares that ranged responses report the backend's ACTUAL served bounds (parsed Content-Range) -- the web adapter then serves plain range requests in a single round-trip with no validating HEAD (S3, Azure, R2, and http set it; video seeking and PDF.js chunking hit this path constantly).

**`ObjectMetadata`** (type) - HEAD response shape: `contentLength`, `etag?`, `lastModified?`, `digest?`.

**`ObjectStream`** (type) - GET response shape: `body` (a `ReadableStream`, or a plain `Uint8Array` when the adapter already holds the exact bytes -- consumers then skip stream machinery entirely), `contentLength`, `totalSize`, `range?` (the `{ start, end }` the backend ACTUALLY served; absent = full content), `etag?`, `lastModified?`, `digest?`.

**`classifyStoreRead(key, op, classifiers)`** - The ordered error-classification pipeline the built-in SDK adapters share, exported for custom adapter authors. Runs `op()` and maps its failure to the contract's error types in a fixed precedence: `notFound` -> `ObjectNotFoundError` (404), `changed` -> `ObjectChangedError` (412), `throttled` -> `StoreUnavailableError` (503), otherwise rethrow untouched. Supply one `StoreErrorClassifiers` set and reuse it for both `headObject` and `getObject` so the two paths cannot drift; predicates must be mutually exclusive on a given backend.

```typescript
import { classifyStoreRead, type StoreErrorClassifiers } from "partial-content";

const classifiers: StoreErrorClassifiers = {
  notFound: (e) => (e as { statusCode?: number }).statusCode === 404,
  changed: (e) => (e as { statusCode?: number }).statusCode === 412,   // omit if the pin is an etag compare
  throttled: (e) => (e as { statusCode?: number }).statusCode === 503,
};

const meta = await classifyStoreRead(key, () => backend.head(key), classifiers);
```

**`StoreUnavailableError`** (class) - Throw from an adapter when the backend is transiently unavailable (throttled/overloaded after the adapter's own retries). Carries an optional `retryAfterSeconds` echoed as `Retry-After`. Distinct from a malformed-response `502`: this is the retryable `503` case.

**`nodeStreamToWeb(iterable, opts?)` / `guardStreamLength(stream, expectedBytes)` / `resolveServedRange(contentRange)` / `parseRetryAfterSeconds(raw, opts?)`** - The stream/accounting primitives the built-in adapters are made of, exported for custom adapter authors: Node-to-web stream conversion with backpressure, abort propagation, and short-read detection; a committed-length guard for web streams; backend `Content-Range` resolution with the unknown-total (`bytes a-b/*`) sentinel; and the shared `Retry-After` parser.
