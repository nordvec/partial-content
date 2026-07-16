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

**`clientWantsContentDigest(reqHeaders)`** - The same negotiation for `Content-Digest` via `Want-Content-Digest`. Each Want-* field gates only its own response field: a client can decline `Content-Digest` while still receiving `Repr-Digest`, and decline `Repr-Digest` while still receiving `Content-Digest` on a full 200.

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

**`httpStore({ url, headers?, fetch?, redirect? })`** - Serve from ANY range-capable HTTP origin over plain `fetch`: Supabase Storage, presigned S3/GCS/Azure URLs, CDN origins, or another partial-content server. Pinned reads map to `If-Match` (origin 412 -> `ObjectChangedError`), `Repr-Digest` response headers are extracted, and requests are sent `Accept-Encoding: identity` and any response that still carries a non-identity `Content-Encoding` is refused, so transparent compression can never corrupt byte accounting. `Accept-Encoding`, `Range`, and `If-Match` are reserved: the adapter owns them and replaces any consumer-supplied value case-insensitively. Redirects error by default (a hostile origin must not 3xx the store toward internal/metadata IPs); set `redirect: "follow"` for origins that legitimately redirect, paired with a validating `fetch` when keys are untrusted (see SECURITY.md).

```typescript
import { httpStore } from "partial-content/http";

const store = httpStore({
  url: (key) => `${SUPABASE_URL}/storage/v1/object/documents/${key}`,
  headers: { Authorization: `Bearer ${serviceRoleKey}` },
});
```

## Memory Store (`partial-content/memory`)

**`memoryStore({ objects })`** - A spec-faithful in-memory store for consumer test suites, demos, and small embedded assets. Fabricates correct Content-Range values, honors `ifMatch` pinning (mutate the map to simulate overwrites and exercise retry logic), declares `authoritativeRange` (plain ranges serve in one round-trip), and streams zero-byte objects correctly.

## Cloud & Filesystem Stores

**`s3Store({ client, bucket })`** (`partial-content/s3`) - Any S3-compatible backend (AWS, R2 in S3 mode, Hetzner, MinIO, Backblaze, Wasabi) via `@aws-sdk/client-s3`. Pinned reads via `IfMatch`, `authoritativeRange` single-round-trip seeks, `x-amz-checksum-sha256` surfaced as the RFC 9530 digest, throttle errors mapped to retryable 503s (with the backend's `Retry-After` when the SDK exposes it), and `createSignedUrl` via `@aws-sdk/s3-request-presigner`.

**`r2Store({ bucket })`** (`partial-content/r2`) - Cloudflare R2 via the native Workers binding (no AWS SDK). Pinned reads via `onlyIf.etagMatches`; served bounds come from R2's own reported range.

**`gcsStore({ storage, bucket, digestMetadataKey? })`** (`partial-content/gcs`) - Google Cloud Storage via `@google-cloud/storage` (pass the constructed `Storage` client plus the bucket name). Pins reads to the object GENERATION (an opaque `pin` token from `headObject` makes the HEAD->GET pair a single metadata round-trip), and mints V4 signed READ URLs via `createSignedUrl` (no Cache-Control response override -- GCS signed URLs have no `response-cache-control` parameter, unlike S3). GCS exposes no native SHA-256 (`x-goog-hash` carries only `crc32c`/`md5`), so set `digestMetadataKey` to the custom-metadata key where your uploader stores the raw-base64 SHA-256 and the store surfaces it as the RFC 9530 digest; invalid or absent values are simply not emitted.

**`azureStore({ containerClient })`** (`partial-content/azure`) - Azure Blob Storage via `@azure/storage-blob`. Single-call `download()` (metadata and body are one response by construction); pinned reads via `conditions.ifMatch`; `createSignedUrl` mints a read-only SAS URL (requires a shared-key credential on the client) with sanitized Content-Disposition, inert content type, and the Cache-Control response override.

**`fsStore({ root, cache? })`** (`partial-content/fs`) - Local filesystem with path-traversal/null-byte/Windows-device-name hardening, nanosecond-mtime weak ETags, an fd-coherent stat+stream (no stat-then-reopen race), `authoritativeRange` single-round-trip range serving (the one open handle stats, clamps, and reads, so bounds, validators, and bytes are coherent by construction), a single-read fast path for bodies <= 128 KiB, and an opt-in TTL/LRU hot-object cache (nginx `open_file_cache` semantics; see Benchmarks).

The cloud SDKs are optional peer dependencies: install only the one your store uses.

## Hono Adapter (`partial-content/hono`)

**`serveObject(store, options)`** - A Hono handler factory over the same engine: web-adapter options plus `key`/`mime`/`filename`/`auditKey` extractors receiving the Hono `Context`.

## Web Adapter (`partial-content/web`)

**`serveObject(store, options?)`** - Create a Fetch API handler that serves files from an ObjectStore. Returns `(req: Request, ctx: ServeContext) => Promise<Response>`.

**`serveObjectRaw(store, options?)`** - The same engine returning `RawResponseParts` (`{ status, statusText, headers, body }`) instead of a `Response`, for server adapters that write to their runtime natively (the bundled node adapter uses it). Skips all fetch-primitive construction on the hot path.

Options: `disposition`, `cacheControl`, `immutable`, `etag` (set `false` to suppress derived ETags, e.g. multi-replica filesystems with unsynchronized mtimes; `Last-Modified` revalidation is unaffected), `securityHeaders`, `crossOriginResourcePolicy`, `timingAllowOrigin`, `timing`, `onTiming`, `onError`, `onServe`, `onTransfer`, `maxRanges`, `enforceCharset`, `fallbackFilename`, `precompressed`, `preferSignedUrl`, `signedUrlExpiresSeconds`, `accessControlExposeHeaders` (`true` = expose the protocol's non-safelisted headers -- the exported `PROTOCOL_EXPOSE_HEADERS` list -- so cross-origin readers like pdf.js can see `Accept-Ranges`/`Content-Range`/`ETag`; a string is emitted verbatim; exposure only, your CORS layer still sets `Access-Control-Allow-Origin`).

**`precompressed: true | ["br", "zstd", "gzip"]`** - Serve precompressed sibling objects (`<key>.br`, `<key>.zst`, `<key>.gz`) negotiated via `Accept-Encoding` (RFC 9110 12.5.3: qvalues, `*`, `identity` preference; the array order is the server tie-break). The chosen variant is its own representation: its validators drive 304/If-Range, its size drives Range/`Content-Range`/416 (byte ranges address the ENCODED bytes), its digest rides `Repr-Digest`, and `Vary: Accept-Encoding` is emitted on every success response for the type, including identity fallbacks and 304s. Gated on compressible MIME types (`isCompressibleMime`); multi-range requests serve identity; a non-404 probe failure falls back to identity and reports to `onError`. Selection only -- upload the variants yourself (e.g. `brotli -k`, `gzip -k` at build/ingest time); the library never compresses at serve time because transforming would corrupt byte ranges and digests.

**`preferSignedUrl(info)`** - Per-request egress offload: return `true` to answer a 302 to `createSignedUrl` instead of proxying bytes (`info` = `{ key, mime, method, isRange, isConditional }`). The classic split is `({ isRange, isConditional }) => !isRange && !isConditional`: ranges and revalidations stay on the origin where the protocol machinery matters, large full-file downloads go straight to the bucket. HEAD requests never consult the predicate (a metadata probe answered with a bare 302 defeats exactly the clients that send HEAD, like PDF.js size probing), so `info.method` is always `"GET"`. The signed request carries the route's `cacheControl` (S3 `response-cache-control` override) so private documents cannot be CDN-cached under an object's baked-in public Cache-Control. `signedUrlExpiresSeconds` (default 60) sets the URL lifetime -- note that temporary credentials (STS/Lambda) cap the effective lifetime at the session token's remaining life regardless.

Method surface: GET and HEAD are served (HEAD with identical headers and no body), OPTIONS answers `204` + `Allow: GET, HEAD, OPTIONS`, everything else `405`. A store with `supportsRange: false` and `createSignedUrl` answers a plain GET with an immediate 302 (no origin round-trip), while HEAD and conditional requests are answered at the origin (real headers, 304, 412) and only a would-be-200 conditional GET redirects; without `createSignedUrl` it serves the FULL representation with `Accept-Ranges: none` (Range and If-Range read as absent; conditionals still work).

**Option precedence** (the order the handler consults its routing options; each row only runs when no earlier row answered):

| Order | Gate | Outcome |
|---|---|---|
| 1 | method is not GET/HEAD | `204` (OPTIONS) or `405` |
| 2 | `supportsRange: false` + `createSignedUrl`, plain GET | immediate 302 |
| 3 | `preferSignedUrl` predicate (GET only) | 302 |
| 4 | `precompressed` negotiation (compressible MIME, not multi-range) | variant selected for all later steps |
| 5 | plain-range fast path (`authoritativeRange`, identity, no conditionals) | single-round-trip 206 |
| 6 | HEAD-resolved evaluation | 304 / 412 / 416 / multipart / 206 / 200, with the rangeless-offload 302 replacing a would-be-200 body from row 2's store |
| 7 | plain GET, nothing above applied | full 200 stream |

`ServeContext`: `key` (required), `mime?`, `filename?`, `cacheControl?` (per-request override of the handler-level value, e.g. `immutable` for content-addressed keys next to `private, no-cache` user uploads from the same handler), `auditKey?` (opaque identifier reported as `key` in every `onServe`/`onTransfer`/`onError` event; storage keys commonly embed filenames, which are personal data that logging controls such as ISO 27001 A.8.15 keep out of log records -- pass a document id or hash here and the audit trail stays correlatable without the filename).

`cacheControl` is emitted verbatim on 200/206/304, so any directive vocabulary your CDN or edge understands passes straight through: RFC 9111 `s-maxage` / `must-revalidate` / `proxy-revalidate` and the RFC 5861 resilience directives `stale-while-revalidate` and `stale-if-error`. The library does not synthesize or reorder directives (only appending `immutable` when the `immutable` option is set and it is not already present), so you keep full control of the response caching policy. `Vary` (e.g. `Vary: Accept-Encoding`) rides `securityHeaders` and is forwarded onto 304 responses too, satisfying the RFC 9110 15.4.5 MUST-generate list.

**Cross-origin consumers**: `Content-Range`, `ETag`, `Accept-Ranges`, `Content-Encoding`, and the digest fields are not CORS-safelisted; list them in `Access-Control-Expose-Headers` or cross-origin readers (pdf.js range loading in particular) silently degrade to full downloads. **Behind a CDN**: only CloudFront forwards client ranges to the origin; Cloudflare/Fastly/Bunny fetch-and-slice, `.zst` variants are unreachable through Cloudflare/CloudFront default encoding normalization, and edge 206s require the origin response to carry `Content-Length` (never chunked). Full details and configuration pointers in `docs/DESIGN.md` "Behind a CDN".

## Node Adapter (`partial-content/node`)

**`serveObject<Req>(store, options)`** - Create a Node.js `(req, res) => Promise<void>` handler for Express, Fastify (compat), Koa, and raw `http.createServer`. Extends the web adapter options with `key` (required, extracts the storage key from the request), `mime?`, `filename?`, and `auditKey?` (see `ServeContext.auditKey`). `Req` defaults to `IncomingMessage`; pass your framework's request type (`serveObject<express.Request>(store, { key: (req) => req.params.key })`) so framework fields typecheck in the extractors. A throwing extractor becomes a hardened 500 and is reported to `onError` with `operation: "context"`.

**Server timeouts (deployment note)** - Node's `http.Server` defaults (`requestTimeout` 300s, `headersTimeout` 60s) force-close any transfer that outlives them, independent of this adapter's stall detection: a large download over a slow link dies mid-stream at 5 minutes. Raise them on the server you `listen()` with (`server.requestTimeout = 0` or a generous ceiling) when serving large files.

**`writeStallTimeoutMs?`** (default `60000`) - Bounds how long the streaming pump waits for a single backpressure `drain` before treating the client as stalled and tearing the transfer down (cancel the storage read, destroy the response). A client that stops reading but holds its socket open would otherwise pin a backend storage connection indefinitely (a slow-read attack). Set to `0` to disable and rely on an upstream proxy / socket timeout instead. Only the raw-Node pump needs this; Fetch-runtime backpressure is the platform's own concern.

## Storage Contract

**`ObjectStore`** (interface) - Read-only storage backend abstraction. Implementations provide `headObject(key, opts?)` for metadata and `getObject(key, opts?)` for streaming, where `opts` carries `range`, `signal`, `ifMatch` (pinned reads), and `pin` (an opaque token issued by `headObject` for stores whose version identifier is not the ETag; GCS uses it to stream a pinned generation without re-fetching metadata). Optional `createSignedUrl(key, opts)` for backends that cannot stream ranges through the origin. Optional `authoritativeRange: true` declares that ranged responses report the backend's ACTUAL served bounds (parsed Content-Range) -- the web adapter then serves plain range requests in a single round-trip with no validating HEAD (S3, Azure, R2, http, fs, and memory set it; video seeking and PDF.js chunking hit this path constantly).

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

## Resumable Uploads

Two wire dialects over one engine. Each dialect factory takes a `ResumableWriteStore` (the write-side storage contract; each of the six storage backends ships one) and returns a framework-agnostic `(req: Request, ctx?) => Promise<Response>` handler that never throws: storage failures become hardened error responses and are reported to `onError`. Under both dialects sits the same orchestrator, which owns locking, fresh-state sequencing, and the post-abort grace window, and the same pure state machine, which makes every protocol decision.

Both dialect subpaths re-export the whole shared surface, so custom stores and custom dialects import everything from `partial-content/tus` or `partial-content/upload`: `createUploadOrchestrator` (+ its option/outcome types), the `ResumableWriteStore` contract types, `UploadPolicy`, `memoryUploadLocker` / the `UploadLocker` interface, and the error classes with their name-based matchers (`isUploadNotFoundError`, `isUploadOffsetConflictError`, `isUploadDigestMismatchError`).

### tus dialect (`partial-content/tus`)

**`createTusHandler(store, options)`** - A tus 1.0 endpoint: core protocol plus the creation, creation-with-upload, creation-defer-length, termination, and expiration extensions (advertised on OPTIONS via `Tus-Extension`). Method surface: `POST` creates (optionally carrying first bytes under `Content-Type: application/offset+octet-stream`), `HEAD` probes the offset, `PATCH` appends, `DELETE` terminates, `OPTIONS` discovers capabilities; `X-HTTP-Method-Override` tunnels PATCH/DELETE through POST for environments that cannot send them. Every non-OPTIONS request is version-gated on `Tus-Resumable: 1.0.0` (412 otherwise). tus completion is implicit (an upload is complete when its offset reaches its length), and the handler publishes the assembled object the moment that happens, including when the final bytes arrived from a connection that died mid-request.

Options (flat `UploadPolicy` fields may ride the options object directly; they win over the `policy` object form):

- **`key(creation)`** (required) - Decide the final storage key for a new upload from `{ metadata, request }` (the base64-decoded `Upload-Metadata` pairs, commonly `filename`/`filetype`, plus the raw `Request`). The server decides the key; never derive it from the client filename verbatim (a caller-controlled key is a path/overwrite primitive).
- **`location(uploadToken)`** (required) - Build the `Location` header value for a created upload resource (absolute or path-relative URL).
- **`resolveToken(req)`** - Extract the upload token from a resource request when the caller does not pass `ctx.uploadToken` (e.g. parse the URL path). `undefined` means "no token here" and the request is answered 404.
- **`auditKey(uploadToken, metadata?)`** - Audit-safe identifier reported on upload events instead of the raw token, called per resource request (HEAD/PATCH/DELETE). Creation events fire before any token exists to map, so they carry only the token.
- **`policy`** - `UploadPolicy` object form (see below).
- **`locker`** - Lock provider (see Locking below). Default: in-process cooperative-preemption locker.
- **`onUploadEvent(event)`** - Structured, content-free audit events (see Upload audit events below).
- **`onError(error, { uploadToken?, operation })`** - Error sink for storage failures, throwing hooks, and dialect-level failures (a throwing `key`/`location`/`resolveToken` callback reports with operation `"handler"`). Must not throw.
- **`graceMs`** (default `10000`) - Post-abort flush window in milliseconds: how long store writes keep running after the client vanished so received bytes become durable. `0` disables it.
- **`now`** - Clock injection (tests); also anchors `Upload-Expires`.
- **`extraHeaders`** - Extra headers on EVERY response (CORS exposure, tracing). Protocol headers win on collision.

Status mapping: `409` offset mismatch (recover via HEAD re-probe; tus defines no offset header on the 409), `410` expired/invalidated, `404` unknown resource or missing token, `413` size violations (with `Tus-Max-Size` when configured), `400` other policy floors and length conflicts, `423` contended (kept distinct from 409 so retry-later never looks like re-probe-now), `415` PATCH without `application/offset+octet-stream`, `502` storage failure (details only to `onError`). Not implemented: the concatenation extension, and the checksum extension (the package is zero-dependency, so per-append hashing needs a caller-injected hasher; not yet surfaced).

**`parseUploadMetadata(header)`** - Parse an `Upload-Metadata` header (creation extension) into decoded key/value pairs. Strict: standard base64 with canonical padding, printable-ASCII keys, unique keys, UTF-8 values; returns `null` for malformed input (the handler answers 400), `{}` for an absent header.

### IETF draft dialect (`partial-content/upload`)

**`createUploadHandler(store, options)`** - An endpoint speaking the IETF resumable-uploads draft (`draft-ietf-httpbis-resumable-upload`) over Fetch primitives. It serves the draft revisions actual clients implement, identified by `Upload-Draft-Interop-Version`: **3, 5, and 6**. The per-version wire differences are handled internally, most importantly the completeness header flip: interop 3 sends `Upload-Incomplete` (`?1` = not complete), interop 5 and 6 send `Upload-Complete` (`?1` = complete); interop 6 adds the `application/partial-upload` media-type requirement on appends, RFC 9457 problem details on offset mismatches, and `Upload-Length` on probes. A missing or unlisted version is answered 400 with the supported set named (the draft forbids cross-version interop, so nothing falls through).

Requests without an upload token (none in `ctx.uploadToken`, none from `resolveToken`) are creations; requests with one target the resource: `HEAD` probes, `PATCH` appends, `DELETE` cancels. A creation or append may assert a whole-representation SHA-256 via `Repr-Digest` (RFC 9530); it is verified at completion when the store supports it (`digestOnComplete: "sha256"`), and rejected up front when the store cannot verify, never silently ignored. The offset-mismatch 409 carries the CORRECT offset and true completeness, so clients re-anchor without a probe round trip.

Options: `key(creation)` (from `{ request, interopVersion, declaredLength, complete }`), `location(uploadToken)`, `resolveToken(req)`, `auditKey(req)`, `policy`, `locker`, `onUploadEvent`, `onError`, `graceMs`, `now` (all as in the tus dialect), plus:

- **`interopVersions`** (default `[3, 5, 6]`) - Versions to serve; construction throws `TypeError` for a version with no wire mapping (misconfiguration is loud, requests never throw).
- **`onResumptionSupported(info)`** - Fires when a creation produced an upload resource, carrying what a `104 (Upload Resumption Supported)` interim response would (`{ uploadToken, location, interopVersion }`). A Fetch `Response` cannot carry interim responses, so the handler itself never emits 104; a transport that can write interim responses may wire this hook. Guarded: a throwing hook is routed to `onError`.

### Upload policy (`UploadPolicy`)

Server policy for one upload surface; every field optional, an absent bound is simply not enforced. The engine enforces these BEFORE any byte reaches a store; the dialects advertise them where their protocol has a vocabulary for it (`Tus-Max-Size`).

| Field | Meaning |
|---|---|
| `maxSize` | Maximum total representation size in bytes |
| `minSize` | Minimum total representation size in bytes |
| `maxAppendSize` | Maximum bytes accepted by a single append (a store's own `maxAppendSize` capability is folded in as a further minimum) |
| `minAppendSize` | Minimum bytes required per append. Exempt: a creation with no content, and an append that completes the upload (the tail is however small it is) |
| `maxAgeSeconds` | Maximum resource lifetime, from creation. Expired resources refuse every interaction (tus 410 / IETF 404) and drive `Upload-Expires` |

### Write stores

Every storage backend subpath except `/http` (a generic HTTP origin cannot accept resumable writes) exports a `ResumableWriteStore` factory next to its `ObjectStore`. Point both at the same bucket/root/map and a completed upload becomes servable the moment completion returns.

**`memoryUploadStore({ objects })`** (`partial-content/memory`) - Process-memory write store for consumer test suites and demos; publishes into the same map a `memoryStore` serves.

**`fsUploadStore({ root })`** (`partial-content/fs`) - Local filesystem. In-flight bytes live in a reserved `.uploads/` subtree under `root`; appends are fsynced before they are acknowledged (the offset a later probe derives from `stat` is crash-durable), completion verifies any asserted SHA-256 by streaming the assembled file, then publishes with a same-volume atomic `rename()`.

**`s3UploadStore({ client, bucket, minPartSize?, uploadPrefix?, checksums? })`** (`partial-content/s3`) - Any S3-compatible backend, built on multipart uploads. Appends buffer to the 5 MiB part-size floor (`minPartSize`; raise it when objects may exceed 10,000 x minPartSize); the sub-minimum remainder is parked in a sidecar object and committed as the size-exempt final part at completion. The offset derives from `ListParts` plus the sidecar's size. `checksums: true` opts into per-part SHA-256 (transport integrity, verified by the backend part by part, restated at completion); it is OFF by default because the parameters are not portable across S3-compatibles, and it never enables whole-object digest verification: multipart SHA-256 is composite (a hash of per-part hashes), so `digestOnComplete` stays `false` either way.

**`azureUploadStore({ containerClient, uploadPrefix?, blockSize? })`** (`partial-content/azure`) - Azure Blob Storage via uncommitted blocks staged on the final blob (nothing visible until commit); `Put Block List` publishes atomically. Appends are byte-exact (`blockSize` only bounds adapter memory). A one-byte sentinel block distinguishes a freshly created upload from a missing one. Azure garbage-collects uncommitted blocks after 7 days; `sweepExpired` reaps the small `.info` bookkeeping blobs Azure will not. One in-flight upload per key (blocks stage on the final blob's namespace).

**`gcsUploadStore({ storage, bucket, uploadPrefix? })`** (`partial-content/gcs`) - Google Cloud Storage via object-per-chunk plus server-side compose (deliberately not GCS's native resumable sessions; see DESIGN.md). Appends are byte-exact immutable chunk objects; completion composes level by level (32 sources per call) with a single final compose onto the destination key, so publication is all-or-nothing. No native lifecycle covers the staging objects: schedule `sweepExpired` or scope a bucket lifecycle rule to `uploadPrefix`.

**`r2UploadStore({ bucket, uploadPrefix?, partSize? })`** (`partial-content/r2`) - Cloudflare R2 via the native multipart binding (no AWS SDK). The binding has no ListParts, so the adapter keeps its own durable part ledger (a `.manifest` object rewritten after every accepted part) and the offset derives from that ledger; that is why `exactOffsetRecovery` is `false`. R2 requires every non-final part to be the SAME size (`partSize`, default and minimum 5 MiB). R2's default lifecycle aborts incomplete multipart uploads after 7 days; `sweepExpired` reaps the manifests.

Capability flags, per built-in store (what the orchestrator reads to decide what it may promise on the wire):

| Store | `appendGranularity` | `uniformPartSize` | `exactOffsetRecovery` | `atomicCompletion` | `digestOnComplete` | `maxAppendSize` |
|---|---|---|---|---|---|---|
| `memory` | byte-exact | - | `true` | `true` | `"sha256"` | - |
| `fs` | byte-exact | - | `true` (fsync before ack) | `true` (atomic rename) | `"sha256"` | - |
| `s3` | `minPartSize` (5 MiB floor) | `false` | `true` (ListParts + sidecar) | `true` (CompleteMultipartUpload) | `false` (composite-only checksums) | - (parts stream out as they fill) |
| `azure` | byte-exact | - | `true` (block-list sums) | `true` (Put Block List) | `false` (no service-side whole-blob SHA-256) | - |
| `gcs` | byte-exact | - | `true` (chunk-listing sums) | `true` (single final compose) | `false` (native checksums are MD5/CRC32C) | - |
| `r2` | `partSize` (5 MiB default) | `true` (R2's rule) | `false` (adapter-owned ledger, no ListParts to cross-check) | `true` (binding `complete()`) | `false` (multipart etags are not content hashes) | - |

### `ResumableWriteStore` (custom write stores)

The write-side storage contract, independent of `ObjectStore` (an adapter implements one, the other, or both). Methods, all invoked by the orchestrator under the upload's lock and after a fresh state read:

- **`createUpload({ key, length?, metadata?, now, signal? })`** -> `{ uploadToken }`. The token is the ONLY handle later calls receive: fold everything resumption needs into it (the built-ins encode key + backend upload id). It is never parsed upstream.
- **`getUploadState(uploadToken)`** -> `{ offset, length?, isComplete, isInvalidated, createdAt, lastAppendAt?, metadata? }`. **The contract's one load-bearing rule: `offset` must be derived from storage bookkeeping the backend itself maintains** (a part listing, a block list, an fsynced file size), never from a counter persisted alongside the data. A stored counter and the bytes it describes cannot be written atomically, and their drift after a crash is exactly the corruption class resumable uploads exist to prevent.
- **`appendChunk(uploadToken, offset, body, { maxBytes?, now, signal? })`** -> `{ bytesWritten }`, the bytes made DURABLE by this call (on interruption, the flushed prefix; the next `getUploadState` must agree). The adapter MUST stop at `maxBytes` and terminally invalidate the resource if the body tries to cross it.
- **`completeUpload(uploadToken, { expectedDigest?, now, signal? })`** -> `{ etag?, digest? }`. Atomically publish: after success the object is readable; after ANY failure (including a digest mismatch) nothing new is visible to readers.
- **`abortUpload(uploadToken)`** - Discard the resource and its partial bytes. Idempotent.
- **`sweepExpired?(olderThanMs)`** -> `{ removed }`. Remove resources idle since before the epoch-ms cutoff (callers typically pass `Date.now() - maxAgeMs` on a schedule). Optional: adapters whose backend has native lifecycle rules may document the native rule instead.

Capability flags (readonly fields, honest per backend, never assumed): `appendGranularity?` (backend append granularity in bytes; forces orchestrator-side buffering; `undefined` = byte-exact), `uniformPartSize?` (every non-final part must be the same size), `exactOffsetRecovery` (the derived offset is byte-exact and crash-durable; when `false` the orchestrator never advertises exact resume), `atomicCompletion` (`completeUpload` is all-or-nothing), `digestOnComplete` (`"sha256"`, `"crc32c"`, or `false`; only `"sha256"` enables end-to-end verification of a client-asserted digest), `maxAppendSize?` (largest single append the backend accepts, folded into the effective policy).

### Locking (`UploadLocker`)

Interactions on one upload resource are serialized by a lock, probes included (deriving an offset can be a multi-call backend read, and a torn snapshot would hand the client an offset its next request fails on). The lock is **cooperatively preempted**, not a plain mutex: a new acquirer asks the current holder to stop, the holder aborts its append at the next chunk boundary (flushing what it has, so the offset stays truthful), and the lock hands over in milliseconds. The interface is one method: `acquire(uploadToken, onPreemptRequested, { timeoutMs? })` -> `Promise<UploadLock>` (`{ release() }`); a holder that does not yield within `timeoutMs` (default 15 s) rejects with `UploadLockTimeoutError`, which the dialects answer as 423.

The default locker is in-process and correct for a single process. **Supply your own via the `locker` option when more than one server instance can receive requests for the same upload resource** (horizontally scaled deployments without upload-affinity routing), backed by shared infrastructure; the interface is deliberately tiny so that stays a page of code.

### Upload audit events (`onUploadEvent`)

Structured, content-free by construction (no filenames, no bytes, no metadata values): `{ uploadToken?, auditKey?, event }` where `event` is one of `created` (with `declaredLength?`), `append-accepted` (`atOffset`, `completes`), `append-rejected` (`reason`, `atOffset?`), `completed` (`length`), `cancelled`, `expired`. Reject reasons: `offset-mismatch`, `length-inconsistent`, `size-exceeded`, `append-too-small`, `append-too-large`, `below-min-size`, `already-complete`, `invalidated`, `expired`, `contended`. A throwing hook is routed to `onError` (`operation: "audit"`) and never affects the upload.

### Upload error classes

Thrown by write stores, re-exported from the storage subpaths (`UploadNotFoundError` and `UploadOffsetConflictError` from all six; `UploadDigestMismatchError` additionally from `/fs`, `/memory`, and `/s3`), and matched **by `name`** so custom stores can throw equivalently-named errors without importing the classes:

- **`UploadNotFoundError`** - The upload resource does not exist (never created, completed and reaped, cancelled, or expired-and-swept). Dialects answer 404.
- **`UploadOffsetConflictError`** - An append's claimed offset lost a race with durable state (defense in depth under the lock; carries `durableOffset`). The orchestrator answers offset-mismatch with the correct offset.
- **`UploadDigestMismatchError`** - The assembled bytes do not hash to the digest the client asserted (carries `expectedDigest`, `actualDigest?`). Thrown BEFORE publishing; the dialect answers a client error, never a torn object.
- **`UploadLockTimeoutError`** - The lock holder did not yield within the acquire timeout; raised by the locker rather than a store (a custom `UploadLocker` signals timeout by rejecting with an error of this `name`). Dialects answer 423.
