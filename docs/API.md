# API Reference

The complete export surface. Everything is typed; your editor's IntelliSense mirrors this page.

## Kernel (`partial-content`)

**`evaluateConditionalRequest(reqHeaders, meta, opts?)`** - One-call handler for the full HTTP evaluation chain. Returns `{ status, headers, range }`. Pass `opts.method` (default `"GET"`): for `"HEAD"` the Range and If-Range headers are ignored per RFC 9110 14.2 (never 206/416; `Content-Length` is the full size, exactly what the 200 would carry) and `Content-Digest` is suppressed (a HEAD transfers no content, RFC 9530 B.2). For writes use `evaluateConditionalWrite` instead.

**`evaluateConditionalWrite(reqHeaders, meta)`** - One-call handler for write requests (PUT/PATCH/DELETE). Returns `{ proceed: true }` or `{ proceed: false, status: 412, headers }`. The 412 response includes the current `ETag` when available, so the client can resync without a follow-up GET.

**`parseRangeHeader(rangeHeader, totalSize)`** - Returns `{ start, end }`, `"unsatisfiable"`, or `null`.

**`parseRanges(rangeHeader, totalSize, maxRanges?)`** - Multi-range parsing for `multipart/byteranges`: coalesces overlapping, adjacent, and near-adjacent ranges (gaps under the ~80-byte part overhead, RFC 9110 15.3.7.2), preserves the request's part order, and caps the part count (`maxRanges`, default 50). Returns a `RangeSet` (in request order), `"unsatisfiable"`, or `null` (serve the full 200).

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

**`clientWantsDigest(reqHeaders)`** - RFC 9530 Section 4 negotiation for `Repr-Digest`: `true` when the client's `Want-Repr-Digest` accepts `sha-256` (or the header is absent). Duplicate keys resolve last-wins per RFC 8941. The web adapter and orchestrator both honor this on every path including multipart, so `Want-Repr-Digest: sha-256=0` suppresses digest emission everywhere.

**`clientWantsContentDigest(reqHeaders)`** - The same negotiation for `Content-Digest` via `Want-Content-Digest`. Each Want-* field gates only its own response field: a client can decline `Content-Digest` while still receiving `Repr-Digest`.

**`sanitizeHeaderValue(s)`** - Strip every byte outside RFC 9110 field-value grammar. The kernel applies it to all metadata-derived headers; exported so adapters can sanitize headers they build themselves.

## Content-Coding Negotiation & Cache-Control (kernel exports)

**`parseAcceptEncoding(header)`** - Parse an `Accept-Encoding` field value into `{ coding, q }` entries (lowercased, last-wins duplicates, malformed members skipped, linear-time).

**`negotiateEncoding(header, available)`** - Rank the server's available codings against the request: returns the accepted codings ordered by client quality then server preference, `[]` when identity should be served (absent/empty header, `q=0` exclusions, or identity preferred). Never signals 406; identity is always the fallback.

**`isCompressibleMime(mime)`** - Allowlist gate for encoding negotiation: `text/*` (minus `event-stream`), structured `application/*` formats, `+json`/`+xml`/`+yaml`/`+toml`/`+text` suffixes (so `image/svg+xml` qualifies), uncompressed fonts and bitmaps. Already-entropy-coded formats (JPEG, video, zip, PDF, OOXML, woff2) return `false`.

**`buildCacheControl(policy)`** - Compose a validated Cache-Control value from a typed policy: `visibility`, `maxAge`, `sMaxAge`, `noCache`, `noStore`, `immutable`, `mustRevalidate`, `staleWhileRevalidate` / `staleIfError` (RFC 5861), and `noTransform` (default **on**: intermediary transforms corrupt byte-exact ranges, digests, and strong validators). Contradictions throw (`no-store` + freshness, `immutable` without `maxAge`); negative/NaN seconds throw instead of serializing directives caches would ignore.

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

## Cloud & Filesystem Stores

**`s3Store({ client, bucket })`** (`partial-content/s3`) - Any S3-compatible backend (AWS, R2 in S3 mode, Hetzner, MinIO, Backblaze, Wasabi) via `@aws-sdk/client-s3`. Pinned reads via `IfMatch`, `authoritativeRange` single-round-trip seeks, `x-amz-checksum-sha256` surfaced as the RFC 9530 digest, throttle errors mapped to retryable 503s (with the backend's `Retry-After` when the SDK exposes it), and `createSignedUrl` via `@aws-sdk/s3-request-presigner`.

**`r2Store({ bucket })`** (`partial-content/r2`) - Cloudflare R2 via the native Workers binding (no AWS SDK). Pinned reads via `onlyIf.etagMatches`; served bounds come from R2's own reported range.

**`gcsStore({ bucket })`** (`partial-content/gcs`) - Google Cloud Storage via `@google-cloud/storage`. Pins reads to the object GENERATION (an opaque `pin` token from `headObject` makes the HEAD->GET pair a single metadata round-trip).

**`azureStore({ containerClient })`** (`partial-content/azure`) - Azure Blob Storage via `@azure/storage-blob`. Single-call `download()` (metadata and body are one response by construction); pinned reads via `conditions.ifMatch`.

**`fsStore({ root, cache? })`** (`partial-content/fs`) - Local filesystem with path-traversal/null-byte/Windows-device-name hardening, nanosecond-mtime weak ETags, an fd-coherent stat+stream (no stat-then-reopen race), a single-read fast path for bodies <= 128 KiB, and an opt-in TTL/LRU hot-object cache (nginx `open_file_cache` semantics; see Benchmarks).

The cloud SDKs are optional peer dependencies: install only the one your store uses.

## Hono Adapter (`partial-content/hono`)

**`serveObject(store, options)`** - A Hono handler factory over the same engine: web-adapter options plus `key`/`mime`/`filename` extractors receiving the Hono `Context`.

## Web Adapter (`partial-content/web`)

**`serveObject(store, options?)`** - Create a Fetch API handler that serves files from an ObjectStore. Returns `(req: Request, ctx: ServeContext) => Promise<Response>`.

**`serveObjectRaw(store, options?)`** - The same engine returning `RawResponseParts` (`{ status, statusText, headers, body }`) instead of a `Response`, for server adapters that write to their runtime natively (the bundled node adapter uses it). Skips all fetch-primitive construction on the hot path.

Options: `disposition`, `cacheControl`, `immutable`, `etag` (set `false` to suppress derived ETags, e.g. multi-replica filesystems with unsynchronized mtimes; `Last-Modified` revalidation is unaffected), `securityHeaders`, `crossOriginResourcePolicy`, `timingAllowOrigin`, `timing`, `onTiming`, `onError`, `onServe`, `onTransfer`, `maxRanges`, `enforceCharset`, `fallbackFilename`, `precompressed`, `preferSignedUrl`, `signedUrlExpiresSeconds`.

**`precompressed: true | ["br", "zstd", "gzip"]`** - Serve precompressed sibling objects (`<key>.br`, `<key>.zst`, `<key>.gz`) negotiated via `Accept-Encoding` (RFC 9110 12.5.3: qvalues, `*`, `identity` preference; the array order is the server tie-break). The chosen variant is its own representation: its validators drive 304/If-Range, its size drives Range/`Content-Range`/416 (byte ranges address the ENCODED bytes), its digest rides `Repr-Digest`, and `Vary: Accept-Encoding` is emitted on every success response for the type, including identity fallbacks and 304s. Gated on compressible MIME types (`isCompressibleMime`); multi-range requests serve identity; a non-404 probe failure falls back to identity and reports to `onError`. Selection only -- upload the variants yourself (e.g. `brotli -k`, `gzip -k` at build/ingest time); the library never compresses at serve time because transforming would corrupt byte ranges and digests.

**`preferSignedUrl(info)`** - Per-request egress offload: return `true` to answer a 302 to `createSignedUrl` instead of proxying bytes (`info` = `{ key, mime, method, isRange, isConditional }`). The classic split is `({ isRange, isConditional }) => !isRange && !isConditional`: ranges and revalidations stay on the origin where the protocol machinery matters, large full-file downloads go straight to the bucket. The signed request carries the route's `cacheControl` (S3 `response-cache-control` override) so private documents cannot be CDN-cached under an object's baked-in public Cache-Control. `signedUrlExpiresSeconds` (default 60) sets the URL lifetime -- note that temporary credentials (STS/Lambda) cap the effective lifetime at the session token's remaining life regardless.

Method surface: GET and HEAD are served (HEAD with identical headers and no body), OPTIONS answers `204` + `Allow: GET, HEAD, OPTIONS`, everything else `405`. A store with `supportsRange: false` redirects to a signed URL when it can (`createSignedUrl`), and otherwise serves the FULL representation with `Accept-Ranges: none` (Range and If-Range read as absent; conditionals still work).

`ServeContext`: `key` (required), `mime?`, `filename?`, `cacheControl?` (per-request override of the handler-level value, e.g. `immutable` for content-addressed keys next to `private, no-cache` user uploads from the same handler).

`cacheControl` is emitted verbatim on 200/206/304, so any directive vocabulary your CDN or edge understands passes straight through: RFC 9111 `s-maxage` / `must-revalidate` / `proxy-revalidate` and the RFC 5861 resilience directives `stale-while-revalidate` and `stale-if-error`. The library does not synthesize or reorder directives (only appending `immutable` when the `immutable` option is set and it is not already present), so you keep full control of the response caching policy. `Vary` (e.g. `Vary: Accept-Encoding`) rides `securityHeaders` and is forwarded onto 304 responses too, satisfying the RFC 9110 15.4.5 MUST-generate list.

## Node Adapter (`partial-content/node`)

**`serveObject<Req>(store, options)`** - Create a Node.js `(req, res) => Promise<void>` handler for Express, Fastify (compat), Koa, and raw `http.createServer`. Extends the web adapter options with `key` (required, extracts the storage key from the request), `mime?`, and `filename?`. `Req` defaults to `IncomingMessage`; pass your framework's request type (`serveObject<express.Request>(store, { key: (req) => req.params.key })`) so framework fields typecheck in the extractors. A throwing extractor becomes a hardened 500 and is reported to `onError` with `operation: "context"`.

**Server timeouts (deployment note)** - Node's `http.Server` defaults (`requestTimeout` 300s, `headersTimeout` 60s) force-close any transfer that outlives them, independent of this adapter's stall detection: a large download over a slow link dies mid-stream at 5 minutes. Raise them on the server you `listen()` with (`server.requestTimeout = 0` or a generous ceiling) when serving large files.

**`writeStallTimeoutMs?`** (default `60000`) - Bounds how long the streaming pump waits for a single backpressure `drain` before treating the client as stalled and tearing the transfer down (cancel the storage read, destroy the response). A client that stops reading but holds its socket open would otherwise pin a backend storage connection indefinitely (a slow-read attack). Set to `0` to disable and rely on an upstream proxy / socket timeout instead. Only the raw-Node pump needs this; Fetch-runtime backpressure is the platform's own concern.

## Storage Contract

**`ObjectStore`** (interface) - Read-only storage backend abstraction. Implementations provide `headObject(key, opts?)` for metadata and `getObject(key, opts?)` for streaming, where `opts` carries `range`, `signal`, `ifMatch` (pinned reads), and `pin` (an opaque token issued by `headObject` for stores whose version identifier is not the ETag; GCS uses it to stream a pinned generation without re-fetching metadata). Optional `createSignedUrl(key, opts)` for backends that cannot stream ranges through the origin. Optional `authoritativeRange: true` declares that ranged responses report the backend's ACTUAL served bounds (parsed Content-Range) -- the web adapter then serves plain range requests in a single round-trip with no validating HEAD (S3, Azure, R2, and http set it; video seeking and PDF.js chunking hit this path constantly).

**`ObjectMetadata`** (type) - HEAD response shape: `contentLength`, `etag?`, `lastModified?`, `digest?`, `pin?`.

**`OPEN_ENDED` / `isOpenEndedRange(range)`** - The sentinel `ParsedRange.end` meaning "to the end of the object", used by the single-round-trip fast path where the total size is not yet known. Custom store authors MUST branch on it (`isOpenEndedRange(range)`) and emit their backend's idiomatic open form (`bytes=start-`, an offset-only read) -- never the sentinel as a literal last-byte-pos. The header builders throw if it ever reaches serialization.

**`ObjectNotFoundError` / `ObjectChangedError`** (classes) - Thrown by adapters for a missing object (mapped to 404) and a pinned read whose object changed since validation (mapped to one re-validation, then 502). Matched by `name`, so a custom store can throw equivalently-named errors without importing the classes.

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
