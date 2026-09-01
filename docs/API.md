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

**`buildContentDisposition(filename, options?)`** - Security-hardened `Content-Disposition` header builder with CRLF injection prevention, path traversal protection, bidi override stripping, and RFC 8187 non-ASCII encoding. Defaults to `attachment` (the safe disposition for untrusted content).

**`isInlineSafeMediaType(mediaType)`** - Allow-list predicate for choosing `inline` vs `attachment` when the CONTENT is untrusted (user uploads, third-party payloads). Returns `true` only for types a browser cannot be driven to execute script while rendering: images except `image/svg+xml`, `video/*`, `audio/*`, and a short inert-text allow-list (`text/plain`, `application/json`, `text/csv`, `text/markdown`). `text/html`, `application/xhtml+xml`, and `application/pdf` are excluded on purpose (serve PDF inline only from a CSP-sandboxed viewer route). Compose it: `buildContentDisposition(name, { type: isInlineSafeMediaType(mime) ? "inline" : "attachment" })`.

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

**`isSha256Base64(value)`** - Type guard for the raw base64 of a 32-byte SHA-256: 43 base64 characters plus optional `=` padding. The single gate the package applies before a digest reaches `Repr-Digest`/`Content-Digest`, exported so a custom store can validate what it is about to report. Padding is optional on input, because an unpadded 43-character encoding decodes to the same 32 bytes and rejecting it would discard a valid digest over a formatting difference; what the package EMITS is always the padded form, since RFC 9530 carries the digest as a Structured Fields Byte Sequence.

## Content-Coding Negotiation & Cache-Control (kernel exports)

**`parseAcceptEncoding(header)`** - Parse an `Accept-Encoding` field value into `{ coding, q }` entries (lowercased, last-wins duplicates, malformed members skipped, linear-time).

**`negotiateEncoding(header, available)`** - Rank the server's available codings against the request: returns the accepted codings ordered by client quality then server preference, `[]` when identity should be served (absent/empty header, `q=0` exclusions, or identity preferred). Never signals 406; identity is always the fallback.

**`isCompressibleMime(mime)`** - Allowlist gate for encoding negotiation: `text/*` (minus `event-stream`), structured `application/*` formats, `+json`/`+xml`/`+yaml`/`+toml`/`+text` suffixes (so `image/svg+xml` qualifies), uncompressed fonts and bitmaps. Already-entropy-coded formats (JPEG, video, zip, PDF, OOXML, woff2) return `false`.

**`buildCacheControl(policy)`** - Compose a validated Cache-Control value from a typed policy: `visibility`, `maxAge`, `sMaxAge`, `noCache`, `noStore`, `immutable`, `mustRevalidate`, `staleWhileRevalidate` / `staleIfError` (RFC 5861), and `noTransform` (default **on**: intermediary transforms corrupt byte-exact ranges, digests, and strong validators). Contradictions throw (`no-store` + freshness, `immutable` without `maxAge`); negative/NaN seconds throw instead of serializing directives caches would ignore.

## MIME Lookup (`partial-content/mime`)

**`lookupMime(filenameOrExt)`** - Curated, zero-dependency extension -> MIME lookup for documents, media, archives, fonts, and web assets. Case-insensitive, resolves the last dot segment (`archive.tar.gz` -> `application/gzip`), returns `undefined` for unknown types so the caller controls the fallback. `html` is deliberately absent: serving stored uploads as `text/html` is stored XSS, so that decision must be explicit at the call site.

```typescript
// doc-check: fragment
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

// The origin you are proxying, and the credential it expects.
declare const SUPABASE_URL: string;
declare const serviceRoleKey: string;

const store = httpStore({
  url: (key) => `${SUPABASE_URL}/storage/v1/object/documents/${key}`,
  headers: { Authorization: `Bearer ${serviceRoleKey}` },
});
```

## Memory Store (`partial-content/memory`)

**`memoryStore({ objects })`** - A spec-faithful in-memory store for consumer test suites, demos, and small embedded assets. Fabricates correct Content-Range values, honors `ifMatch` pinning (mutate the map to simulate overwrites and exercise retry logic), declares `authoritativeRange` (plain ranges serve in one round-trip), and streams zero-byte objects correctly.

## Cloud & Filesystem Stores

**`reservedPrefix?`** (on `fsStore`, `s3Store`, `r2Store`, `gcsStore`, `azureStore`) - Keys at or under this prefix are refused with `ObjectNotFoundError` on `headObject`, `getObject`, and `createSignedUrl` where the backend has one. A read store and an upload store are routinely pointed at the same root or bucket, which is what makes a completed upload servable without copying it; in that arrangement the upload store's own namespace is reachable through the read path, exposing the in-flight bytes of an upload nobody has published and the sidecar naming the key it is destined for, which commonly embeds a filename. An upload token is the only handle meant to reach that namespace, and a read handler holds none. Refusal is therefore the DEFAULT, not an opt-in: it is the sibling upload store's own prefix (`.uploads/` for fs and s3, `.partial-content-uploads/` for r2, gcs and azure). Set it to your own value when you changed the upload store's `uploadPrefix`, or to `""` to serve the whole namespace when no upload store shares the location. `memoryStore` takes no such option: its in-flight uploads live in a separate map, never in `objects`. The guard itself is exported from the package root as `reservedKeyGuard(prefix)` for custom `ObjectStore` implementations sharing a location with an upload store.

**Construction validates its options.** `memoryStore`/`memoryUploadStore` require `objects`, `fsStore`/`fsUploadStore` require an ABSOLUTE `root`, and `s3Store`/`s3UploadStore` require `client` and `bucket`; each throws a `TypeError` naming what to change. A missing `objects` map otherwise surfaced as a 502 at publication, after the entire body had transferred, and a relative `root` silently anchored to `process.cwd()`.

**`s3Store({ client, bucket })`** (`partial-content/s3`) - Any S3-compatible backend (AWS, R2 in S3 mode, Hetzner, MinIO, Backblaze, Wasabi) via `@aws-sdk/client-s3`. Pinned reads via `IfMatch`, `authoritativeRange` single-round-trip seeks, `x-amz-checksum-sha256` surfaced as the RFC 9530 digest, throttle errors mapped to retryable 503s (with the backend's `Retry-After` when the SDK exposes it), and `createSignedUrl` via `@aws-sdk/s3-request-presigner`.

**`r2Store({ bucket })`** (`partial-content/r2`) - Cloudflare R2 via the native Workers binding (no AWS SDK). Pinned reads via `onlyIf.etagMatches`; served bounds come from R2's own reported range.

**`gcsStore({ storage, bucket, digestMetadataKey? })`** (`partial-content/gcs`) - Google Cloud Storage via `@google-cloud/storage` (pass the constructed `Storage` client plus the bucket name). Pins reads to the object GENERATION (an opaque `pin` token from `headObject` makes the HEAD->GET pair a single metadata round-trip), and mints V4 signed READ URLs via `createSignedUrl` (no Cache-Control response override -- GCS signed URLs have no `response-cache-control` parameter, unlike S3). GCS exposes no native SHA-256 (`x-goog-hash` carries only `crc32c`/`md5`), so set `digestMetadataKey` to the custom-metadata key where your uploader stores the raw-base64 SHA-256 and the store surfaces it as the RFC 9530 digest; invalid or absent values are simply not emitted.

**`azureStore({ containerClient })`** (`partial-content/azure`) - Azure Blob Storage via `@azure/storage-blob`. Single-call `download()` (metadata and body are one response by construction); pinned reads via `conditions.ifMatch`; `createSignedUrl` mints a read-only SAS URL (requires a shared-key credential on the client) with sanitized Content-Disposition, inert content type, and the Cache-Control response override.

**`fsStore({ root, cache? })`** (`partial-content/fs`) - Local filesystem with path-traversal/null-byte/Windows-device-name hardening, nanosecond-mtime weak ETags, an fd-coherent stat+stream (no stat-then-reopen race), `authoritativeRange` single-round-trip range serving (the one open handle stats, clamps, and reads, so bounds, validators, and bytes are coherent by construction), a single-read fast path for bodies <= 128 KiB, and an opt-in TTL/LRU hot-object cache (see Benchmarks).

The cloud SDKs are optional peer dependencies: install only the one your store uses.

**The SDK shim interfaces are exported as types**, so you can write the adapter object a store expects and have the compiler check it, rather than reaching for a cast when your client is wrapped, mocked, or a compatible non-SDK implementation. `/azure` exports `AzureContainerClient`, `AzureBlobClient`, `AzureGenerateSasUrlOptions`, `AzureBlobProperties` and `AzureBlobDownloadResponse`; `/gcs` exports `GcsStorage`, `GcsBucket`, `GcsFile`, `GcsSignedUrlConfig` and `GcsFileMetadata`; `/r2` exports `R2Bucket`, `R2Object`, `R2ObjectBody`, `R2GetOptions`, `R2Range`, `R2Checksums` and `R2HttpMetadata`. Each is the narrow structural slice the store actually calls, which is also the surface a shim has to satisfy.

## Hono Adapter (`partial-content/hono`)

**`serveObject(store, options)`** - A Hono handler factory over the same engine: web-adapter options plus `key`/`mime`/`filename`/`auditKey` extractors receiving the Hono `Context`. A throwing extractor becomes a hardened 500 and is reported to `onError` with `operation: "context"`.

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

`ServeContext`: `key` (required), `mime?` (the response `Content-Type`; **when omitted it is `application/octet-stream`**, which no browser renders inline, so a PDF or video downloads instead of playing even under `disposition: "inline"`. Derive it from the key with `lookupMime` from `partial-content/mime`, or pass the type you stored at upload), `filename?`, `cacheControl?` (per-request override of the handler-level value, e.g. `immutable` for content-addressed keys next to `private, no-cache` user uploads from the same handler), `auditKey?` (opaque identifier reported as `key` in every `onServe`/`onTransfer`/`onError` event; storage keys commonly embed filenames, which are personal data that logging controls such as ISO 27001 A.8.15 keep out of log records -- pass a document id or hash here and the audit trail stays correlatable without the filename).

`cacheControl` is emitted verbatim on 200/206/304, so any directive vocabulary your CDN or edge understands passes straight through: RFC 9111 `s-maxage` / `must-revalidate` / `proxy-revalidate` and the RFC 5861 resilience directives `stale-while-revalidate` and `stale-if-error`. The library does not synthesize or reorder directives (only appending `immutable` when the `immutable` option is set and it is not already present), so you keep full control of the response caching policy. `Vary` (e.g. `Vary: Accept-Encoding`) rides `securityHeaders` and is forwarded onto 304 responses too, satisfying the RFC 9110 15.4.5 MUST-generate list.

**Cross-origin consumers**: `Content-Range`, `ETag`, `Accept-Ranges`, `Content-Encoding`, and the digest fields are not CORS-safelisted; list them in `Access-Control-Expose-Headers` or cross-origin readers (pdf.js range loading in particular) silently degrade to full downloads. **Behind a CDN**: only CloudFront forwards client ranges to the origin; Cloudflare/Fastly/Bunny fetch-and-slice, `.zst` variants are unreachable through Cloudflare/CloudFront default encoding normalization, and edge 206s require the origin response to carry `Content-Length` (never chunked). Full details and configuration pointers in `docs/DESIGN.md` "Behind a CDN".

## Node Adapter (`partial-content/node`)

**`serveObject<Req>(store, options)`** - Create a Node.js `(req, res) => Promise<void>` handler for Express, Fastify (compat), Koa, and raw `http.createServer`. Extends the web adapter options with `key` (required, extracts the storage key from the request), `mime?`, `filename?`, and `auditKey?` (see `ServeContext.auditKey`). `Req` defaults to `IncomingMessage`; pass your framework's request type (`serveObject<express.Request>(store, { key: (req) => req.params.key })`) so framework fields typecheck in the extractors. A throwing extractor becomes a hardened 500 and is reported to `onError` with `operation: "context"`.

`partial-content/node` re-exports `ServeObjectOptions`, `ServeContext` and `ObjectStore` alongside the `ObjectNotFoundError`, `ObjectChangedError` and `StoreUnavailableError` classes, so an adapter-only consumer types its handler and matches store errors from one import. `partial-content/hono` re-exports the same three types.

**Server timeouts (deployment note)** - Node's `http.Server` defaults (`requestTimeout` 300s, `headersTimeout` 60s) force-close any transfer that outlives them, independent of this adapter's stall detection: a large download over a slow link dies mid-stream at 5 minutes. Raise them on the server you `listen()` with (`server.requestTimeout = 0` or a generous ceiling) when serving large files.

**`writeStallTimeoutMs?`** (default `60000`) - Bounds how long the streaming pump waits for a single backpressure `drain` before treating the client as stalled and tearing the transfer down (cancel the storage read, destroy the response). A client that stops reading but holds its socket open would otherwise pin a backend storage connection indefinitely (a slow-read attack). Set to `0` to disable and rely on an upstream proxy / socket timeout instead. Only the raw-Node pump needs this; Fetch-runtime backpressure is the platform's own concern.

## Storage Contract

**`ObjectStore`** (interface) - Read-only storage backend abstraction. Implementations provide `headObject(key, opts?)` for metadata and `getObject(key, opts?)` for streaming, where `opts` carries `range`, `signal`, `ifMatch` (pinned reads), and `pin` (an opaque token issued by `headObject` for stores whose version identifier is not the ETag; GCS uses it to stream a pinned generation without re-fetching metadata). Optional `createSignedUrl(key, opts)` for backends that cannot stream ranges through the origin, or where a caller wants bulk egress off the origin (`preferSignedUrl`). Optional `authoritativeRange: true` declares that ranged responses report the backend's ACTUAL served bounds (parsed Content-Range) -- the web adapter then serves plain range requests in a single round-trip with no validating HEAD (S3, Azure, R2, http, fs, and memory set it; video seeking and PDF.js chunking hit this path constantly).

**`createSignedUrl(key, { expiresInSeconds, downloadFilename?, cacheControl? })`** -> `Promise<{ ok: true; url: string } | { ok: false; error: string }>`. It returns an outcome where every other method on the interface throws, and the asymmetry is the point: DECLINING and FAILING are different answers a caller acts on differently. `{ ok: false }` says this store cannot sign (no credential configured, a backend without the capability), and the serving path falls back to streaming the bytes itself, which is a correct response and not an error. A THROWN error says signing was supposed to work and did not, which is reported to `onError` and answered as a backend failure. Collapsing the two would turn "no signing configured" into a 502 on every request. Pass `cacheControl` for a private object: without it the redirect target serves whatever Cache-Control was baked in at upload, which a CDN in front of the bucket will honor.

**`ObjectMetadata`** (type) - HEAD response shape: `contentLength`, `etag?`, `lastModified?`, `digest?`, `pin?`.

**`OPEN_ENDED` / `isOpenEndedRange(range)`** - The sentinel `ParsedRange.end` meaning "to the end of the object", used by the single-round-trip fast path where the total size is not yet known. Custom store authors MUST branch on it (`isOpenEndedRange(range)`) and emit their backend's idiomatic open form (`bytes=start-`, an offset-only read) -- never the sentinel as a literal last-byte-pos. The header builders throw if it ever reaches serialization.

**`ObjectNotFoundError` / `ObjectChangedError`** (classes) - Thrown by adapters for a missing object (mapped to 404) and a pinned read whose object changed since validation (mapped to one re-validation, then 502). Matched by `name`, so a custom store can throw equivalently-named errors without importing the classes.

**`isObjectNotFoundError(err)` / `isObjectChangedError(err)` / `isStoreUnavailableError(err)`** - The name-based matchers for the three read-side store errors, from the package root, mirroring the write side's `isUploadNotFoundError` and its siblings. Each is a type guard narrowing `unknown` to its class. Use them rather than `instanceof`, which is unreliable across package boundaries: a consumer with two copies of this package in its tree, or a store built against a different install, throws an error that is structurally right and fails the check, while the `name` is stable identity. It is also what lets a custom store throw an equivalently-named error of its own and be recognized.

**`ObjectStream`** (type) - GET response shape: `body` (a `ReadableStream`, or a plain `Uint8Array` when the adapter already holds the exact bytes -- consumers then skip stream machinery entirely), `contentLength`, `totalSize`, `range?` (the `{ start, end }` the backend ACTUALLY served; absent = full content), `etag?`, `lastModified?`, `digest?`.

**`classifyStoreRead(key, op, classifiers)`** - The ordered error-classification pipeline the built-in SDK adapters share, exported for custom adapter authors. Runs `op()` and maps its failure to the contract's error types in a fixed precedence: `notFound` -> `ObjectNotFoundError` (404), `changed` -> `ObjectChangedError` (412), `throttled` -> `StoreUnavailableError` (503), otherwise rethrow untouched. Supply one `StoreErrorClassifiers` set and reuse it for both `headObject` and `getObject` so the two paths cannot drift; predicates must be mutually exclusive on a given backend.

**`reservedKeyGuard(prefix)`** -> `(key: string) => void`. Build the refusal a built-in read store applies to its `reservedPrefix`: throws `ObjectNotFoundError` for a key equal to the prefix or under it, and is a no-op for `""`. Call it at the top of a custom `ObjectStore`'s `headObject`, `getObject`, and `createSignedUrl` when the store shares a location with an upload store, so the upload bookkeeping is not reachable through the read path.

```typescript
import { classifyStoreRead, type StoreErrorClassifiers } from "partial-content";

// The key being read, and your backend's own SDK call.
declare const key: string;
declare const backend: { head(key: string): Promise<{ contentLength: number }> };

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

Both dialect subpaths re-export the whole shared surface, so custom stores and custom dialects import everything from `partial-content/tus` or `partial-content/upload`: `createUploadOrchestrator` (+ its option/outcome types), the `ResumableWriteStore` contract types, `UploadPolicy`, `memoryUploadLocker` / the `UploadLocker` interface, and the error classes with their name-based matchers (`isUploadNotFoundError`, `isUploadOffsetConflictError`, `isUploadAppendBoundError`, `isUploadOverrunError`, `isUploadDigestMismatchError`), plus `FatalBoundReason` (`"length" | "size"`, which representation bound a fatal append crossed).

### tus dialect (`partial-content/tus`)

**`createTusHandler(store, options)`** - A tus 1.0 endpoint: core protocol plus the creation, creation-with-upload, creation-defer-length, termination, expiration, and (when `checksum` is configured) checksum extensions (advertised on OPTIONS via `Tus-Extension`). Method surface: `POST` creates (optionally carrying first bytes under `Content-Type: application/offset+octet-stream`), `HEAD` probes the offset, `PATCH` appends, `DELETE` terminates, `OPTIONS` discovers capabilities; `X-HTTP-Method-Override` tunnels PATCH/DELETE through POST for environments that cannot send them. `DELETE` terminates the upload and never an object it already published, so a client that deletes an upload resource after completion frees bookkeeping without destroying its own file. Every non-OPTIONS request is version-gated on `Tus-Resumable: 1.0.0` (412 otherwise). tus completion is implicit (an upload is complete when its offset reaches its length), and the handler publishes the assembled object the moment that happens, including when the final bytes arrived from a connection that died mid-request.

Options:

- **`key(creation)`** (required) - Decide the final storage key for a new upload from `{ metadata, request }` (the base64-decoded `Upload-Metadata` pairs, commonly `filename`/`filetype`, plus the raw `Request`). The server decides the key; never derive it from the client filename verbatim (a caller-controlled key is a path/overwrite primitive).
- **`location(uploadToken)`** (required) - Build the `Location` header value for a created upload resource (absolute or path-relative URL). It is also called for a creation REJECTED after the resource was allocated: a creation-with-upload whose body is refused mid-stream has already made a prefix durable, and the `Location` is the only way the client can resume or `DELETE` those bytes. Without it they are unreachable and only a sweep reclaims them, which is optional and does nothing at all with no `maxAgeSeconds`. The value is header-sanitized on both paths.
- **`resolveToken(req)`** - Extract the upload token from a resource request when the caller does not pass `ctx.uploadToken` (e.g. parse the URL path). `undefined` means "no token here" and the request is answered 404.
- **`auditKey(uploadToken)`** - Audit-safe identifier reported INSTEAD of the raw token on upload events and in the `onError` context (supply one and `uploadToken` is not reported at all), called per resource request (HEAD/PATCH/DELETE). The token is the capability: possession of it authorizes appending, probing and cancelling, since nothing re-authenticates the follow-up requests, and `onUploadEvent` is the most log-adjacent surface in the package. Creation events fire before any token exists to map, so they carry only the token.
- **`policy`** - The size, append and lifetime bounds this endpoint enforces, as a `UploadPolicy` (see below).
- **`checksum`** - Enable the tus checksum extension (`Upload-Checksum: <algorithm> <base64>` verified per request). `webCryptoChecksum()` is the ready-made config: `sha1` (the spec's server-MUST) plus SHA-2 over `crypto.subtle`, available on every supported runtime; inject a custom `TusChecksumOptions` (`algorithms` + one-shot `digest(algorithm, content)`) for `md5` and friends. A checksummed `PATCH` first confirms the token resolves (one lock-free, non-preempting state read), because verification buffers and hashes the whole request and a token that names nothing must not buy that work. A checksummed request is then BUFFERED, verified, and only then appended, because discard-on-mismatch is only honest when unverified bytes never become durable; the buffer is hard-capped by `checksum.maxBufferBytes` (default: the effective `maxAppendSize`; construction throws when neither bounds it). Mismatch answers `460 Checksum Mismatch` with durable state untouched; an unadvertised algorithm or malformed header answers 400; content over the cap answers 413 before hashing. Unconfigured, the extension is not advertised and an unsolicited `Upload-Checksum` is ignored (an assertion nothing can verify is dropped, mirroring the completion-digest posture).
- **`locker`** - Lock provider (see Locking below). Default: in-process cooperative-preemption locker.
- **`onUploadEvent(event)`** - Structured, content-free audit events (see Upload audit events below).
- **`onError(error, { uploadToken?, auditKey?, operation })`** - Error sink for storage failures, throwing hooks, and dialect-level failures (a throwing `key`/`location`/`resolveToken` callback reports with operation `"handler"`). Must not throw.
- **`graceMs`** (default `10000`) - Post-abort flush window in milliseconds: how long store writes keep running after the client vanished so received bytes become durable. `0` disables it.
- **`now`** - Clock injection (tests); also anchors `Upload-Expires`.
- **`extraHeaders`** - Extra headers on EVERY response (CORS exposure, tracing). Protocol headers win on collision.

Status mapping: `409` offset mismatch (recover via HEAD re-probe; tus defines no offset header on the 409), `410` expired/invalidated, `404` unknown resource or missing token, `413` size violations (with `Tus-Max-Size` when configured), including a body that crossed the policy `maxSize`, `400` other policy floors and length conflicts, including a body that crossed the length the client itself declared, `423` contended (kept distinct from 409 so retry-later never looks like re-probe-now), `415` PATCH without `application/offset+octet-stream`, `502` storage failure (details only to `onError`), `460 Checksum Mismatch` when a configured checksum fails to verify. Not implemented: the concatenation extension, and the checksum-trailer variant (Fetch exposes no portable Request trailer API).

**`parseUploadMetadata(header)`** - Parse an `Upload-Metadata` header (creation extension) into decoded key/value pairs. Strict: standard base64 with canonical padding, printable-ASCII keys, unique keys, UTF-8 values; returns `null` for malformed input (the handler answers 400), `{}` for an absent header.

### IETF draft dialect (`partial-content/upload`)

**`createUploadHandler(store, options)`** - An endpoint speaking the IETF resumable-uploads draft (`draft-ietf-httpbis-resumable-upload`) over Fetch primitives. It serves the draft revisions clients implement, identified by `Upload-Draft-Interop-Version`: **3** (draft-01), **5** (draft-03), **6** (draft-04/-05), and **9** (draft-12). A missing or unlisted version is answered 400 with the supported set named (the draft forbids cross-version interop, so nothing falls through), and every response that participates in the protocol echoes the version it was answered in.

The per-version wire differences are handled internally, most importantly the completeness header flip: interop 3 sends `Upload-Incomplete` (`?1` = not complete), 5, 6 and 9 send `Upload-Complete` (`?1` = complete). Interop 6 adds the `application/partial-upload` media-type requirement on appends, RFC 9457 problem details on offset mismatches, and `Upload-Length` on probes. Interop 9 adds three more:

- **`Upload-Limit`** (RFC 8941 Dictionary) on a successful offset retrieval (the `204` answering a `HEAD`, or a `GET`), and on a rejection a limit caused (the `413` for `size-exceeded` / `append-too-large`, the `400` for the floors), so a client that has just been refused has a number to aim its retry at instead of guessing a smaller chunk. Members are serialized from the effective `UploadPolicy`: `max-size`, `min-size`, `max-append-size`, `min-append-size`, `max-age`. An absent member states no limit of that kind; `min-size` is always present, defaulting to `0`, because an empty structured-field value is not a valid dictionary and a server applying no limits still has to say so.
- **`GET` probes the offset** beside `HEAD`. On 3, 5 and 6 a `GET` to an upload resource is `405` with `Allow: HEAD, PATCH, DELETE, OPTIONS`; on 9 the `Allow` on a `405` reads `GET, HEAD, PATCH, DELETE, OPTIONS`. (`OPTIONS` is version-agnostic, is not gated on an interop version, and always answers `Allow: POST, HEAD, PATCH, DELETE, OPTIONS` with no `Upload-Limit`.)
- **An append to an already-complete upload replays the completion answer** (`200`, `Upload-Complete: ?1`, `Upload-Offset`) instead of refusing it `400`. See the version-specific status note below, because this one differs between versions by design.

**An append to an upload that is already complete is answered `400` on interop 3, 5 and 6, and `200` on interop 9.** The engine reaches that case only when the claimed offset IS the durable offset, so the request is a retry of a completion whose response the client never received. Which answer is correct is the version's decision and not a preference: draft-05 Section 4.4.2 has the server "MUST NOT modify the upload resource and MUST respond with a 400 (Bad Request) status code", so a client written against those revisions uses the 400 to learn its upload finished, and replaying a success there would deny it that signal. draft-12 Section 4.4.2 revises it, saying the server "can choose to replay the final response to the client if the request to append to the completed upload is valid". A client that wants the retry to succeed asks for interop 9.

`Repr-Digest` verification (RFC 9530) is offered on **every** version this endpoint serves, interop 9 included, whose draft revision carries no upload-digest text of its own. RFC 9530 defines the field independently of any upload protocol, and honoring an assertion the client volunteered cannot break a client that sends none: absent means unverified, exactly as before. Restricting it to the older versions would remove an integrity guarantee from the consumers most likely to want one, in exchange for nothing a client can observe.

Requests without an upload token (none in `ctx.uploadToken`, none from `resolveToken`) are creations; requests with one target the resource: `HEAD` probes, `PATCH` appends, `DELETE` cancels. `resolveToken` is consulted on EVERY request here, unlike the tus dialect where only `HEAD`/`PATCH`/`DELETE` consult it, so it has to be right in both directions: with no `resolveToken` and no `ctx.uploadToken`, a probe or append is routed into creation and answered 400 while its bytes orphan, and a `resolveToken` that returns a token for the creation URL itself makes the creation a 405. Match the resource path specifically, or pass `ctx.uploadToken` from your router's path parameter. A creation or append may assert a whole-representation SHA-256 via `Repr-Digest` (RFC 9530); it is verified at completion when the store supports it (`digestOnComplete: "sha256"`), and rejected up front when the store cannot verify, never silently ignored. The offset-mismatch 409 carries the CORRECT offset and true completeness, so clients re-anchor without a probe round trip.

Options: `key(creation)` (from `{ request, interopVersion, declaredLength, complete }`), `location(uploadToken)`, `resolveToken(req)`, `auditKey(req)`, `policy`, `locker`, `onUploadEvent`, `onError`, `graceMs`, `now` (as in the tus dialect, except that `auditKey` is derived from the `Request` rather than the token, so it covers creations too), plus:

- **`interopVersions`** (default `[3, 5, 6, 9]`) - Versions to serve; construction throws `TypeError` for a version with no wire mapping, and for an empty list (misconfiguration is loud, requests never throw). Narrow it to pin an endpoint to one revision's behavior, for instance `[9]` when every client is current and you want the completion replay unconditionally.
- **`onResumptionSupported(info)`** - Fires when a creation produced an upload resource, carrying what a `104 (Upload Resumption Supported)` interim response would (`{ uploadToken, location, interopVersion }`). A Fetch `Response` cannot carry interim responses, so the handler itself never emits 104; a transport that can write interim responses may wire this hook. Guarded: a throwing hook is routed to `onError`.

### The orchestrator (`createUploadOrchestrator`)

`createUploadOrchestrator(store, options?)` is what both dialects are built on, and it is exported from both dialect subpaths for anyone writing a third wire dialect or driving uploads from something that is not HTTP. It owns locking, fresh-state sequencing, the post-abort grace window, and the effective policy (`orchestrator.policy`, with the store's own `maxAppendSize` folded in), and it exposes `create`, `probe`, `resourceExists`, `append` and `cancel`, each answering a wire-agnostic `UploadOutcome`. It throws a `TypeError` at construction for a store reporting `atomicCompletion: false` or `enforcesOffsetCheck: false`, and for a policy bound that is not a non-negative safe integer or whose floor exceeds its ceiling (`minSize` over `maxSize`, `minAppendSize` over `maxAppendSize`).

`policy`, `locker`, `onUploadEvent`, `onError` (whose context here also declares `auditKey?`), `graceMs` and `now` mean what they do on the dialect factories, which pass them straight through. Two options exist only here, so reaching them means constructing the orchestrator yourself rather than calling `createTusHandler` / `createUploadHandler`:

- **`onUploadComplete(info)`** - Fires on publication with `{ uploadToken, auditKey?, key, length, metadata?, etag?, digest? }`. **Delivered at-least-once; make it idempotent on `uploadToken`.** This is the one hook that carries the storage **key**, deliberately kept out of `onUploadEvent`, which is content-free by design while a key commonly embeds a filename. It is where a consumer records "this upload became that object", which is otherwise not learnable: the key is chosen by the `key()` callback before a token exists, and correlating that callback's return with the token by position across the creation call is a race rather than an answer. It is **awaited before the response goes out**, so a hook that throws fails the request instead of acknowledging an object the consumer's own records never saw: the throw becomes a `store-error` outcome, reported to `onError` with `operation: "complete"` and answered `500` by the IETF dialect and `502` by tus. Return a promise and the client is told the upload landed only after your write did. That await is only worth something if a failed delivery gets another attempt, and the only retry a resumable protocol has is the client repeating its completing request; that repeat is answered idempotently and re-delivers here rather than short-circuiting, so an upload whose first delivery threw is recorded on the retry instead of being lost. A re-delivery reports what durable state knows and omits `etag` and `digest`; the token is unchanged, which is why it is the key to dedupe on.
- **`lockTimeoutMs`** - How long a request waits for the upload lock before the dialect answers `423`. The orchestrator is the only caller of `UploadLocker.acquire`, so this is the knob for it whichever locker is installed; a locker keeps its own default for callers outside the orchestrator (`memoryUploadLocker({ acquireTimeoutMs })`, `redisUploadLocker(client, { acquireTimeoutMs })`, both 15 s).

### Upload policy (`UploadPolicy`)

Server policy for one upload surface; every field optional, an absent bound is simply not enforced. The engine enforces these BEFORE any byte reaches a store; the dialects advertise them where their protocol has a vocabulary for it (`Tus-Max-Size`).

| Field | Meaning |
|---|---|
| `maxSize` | Maximum total representation size in bytes. Bounds the REPRESENTATION, so an unknown-size body that runs past it mid-stream is terminal: the store invalidates the resource durably, the answer is `413`, and every later probe or append refuses. A body that runs past the length the client itself declared is terminal the same way and answers `400`, since the fault is against the client's own declaration |
| `minSize` | Minimum total representation size in bytes |
| `maxAppendSize` | Maximum bytes accepted by a single append (a store's own `maxAppendSize` capability is folded in as a further minimum). Bounds the REQUEST, not the representation: a known-size append over it is refused up front with `413`, and an unknown-size (chunked) body that runs past it stops at the bound and answers `413` with the resource intact and the accepted prefix durable, so the client resumes. Only `maxSize` and a declared length are terminal |
| `minAppendSize` | Minimum bytes required per append. Exempt: a creation with no content, and an append that completes the upload (the tail is however small it is) |
| `maxAgeSeconds` | Maximum resource lifetime, from creation. Expired resources refuse probes and appends (tus 410 / IETF 404) and drive `Upload-Expires`; a `DELETE` is still accepted, so a client told its upload is dead can free the partial bytes |

### Write stores

Every storage backend subpath except `/http` (a generic HTTP origin cannot accept resumable writes) exports a `ResumableWriteStore` factory next to its `ObjectStore`. Point both at the same bucket/root/map and a completed upload becomes servable the moment completion returns. The read store refuses the write store's bookkeeping prefix by default, so that sharing does not also publish in-flight uploads (see `reservedPrefix` above).

**`memoryUploadStore({ objects })`** (`partial-content/memory`) - Process-memory write store for consumer test suites and demos; publishes into the same map a `memoryStore` serves.

**`fsUploadStore({ root })`** (`partial-content/fs`) - Local filesystem. In-flight bytes live in a reserved `.uploads/` subtree under `root`; appends are fsynced before they are acknowledged (the offset a later probe derives from `stat` is crash-durable), completion verifies any asserted SHA-256 by streaming the assembled file, then publishes with a same-volume atomic `rename()`.

**`s3UploadStore({ client, bucket, minPartSize?, uploadPrefix?, checksums? })`** (`partial-content/s3`) - Any S3-compatible backend, built on multipart uploads. Appends buffer to the 5 MiB part-size floor (`minPartSize`; raise it when objects may exceed 10,000 x minPartSize); the sub-minimum remainder is parked in a sidecar object and committed as the size-exempt final part at completion. The offset derives from `ListParts` plus the sidecar's size. `checksums: true` opts into per-part SHA-256 (transport integrity, verified by the backend part by part, restated at completion); it is OFF by default because the parameters are not portable across S3-compatibles, and it never enables whole-object digest verification: multipart SHA-256 is composite (a hash of per-part hashes), so `digestOnComplete` stays `false` either way.

**`azureUploadStore({ containerClient, uploadPrefix?, blockSize? })`** (`partial-content/azure`) - Azure Blob Storage via uncommitted blocks staged on the final blob (nothing visible until commit); `Put Block List` publishes atomically. Appends are byte-exact (`blockSize` only bounds adapter memory). A one-byte sentinel block distinguishes a freshly created upload from a missing one. Azure garbage-collects uncommitted blocks after 7 days; `sweepExpired` reaps the small `.info` bookkeeping blobs Azure will not. One in-flight upload per key (blocks stage on the final blob's namespace).

**`gcsUploadStore({ storage, bucket, uploadPrefix? })`** (`partial-content/gcs`) - Google Cloud Storage via object-per-chunk plus server-side compose (deliberately not GCS's native resumable sessions; see DESIGN.md). Appends are byte-exact immutable chunk objects; completion composes level by level (32 sources per call) with a single final compose onto the destination key, so publication is all-or-nothing. No native lifecycle covers the staging objects: schedule `sweepExpired` or scope a bucket lifecycle rule to `uploadPrefix`.

**`r2UploadStore({ bucket, uploadPrefix?, partSize? })`** (`partial-content/r2`) - Cloudflare R2 via the native multipart binding (no AWS SDK). The binding has no ListParts, so the adapter keeps its own durable part ledger (a `.manifest` object rewritten after every accepted part) and the offset derives from that ledger; that is why `exactOffsetRecovery` is `false`. R2 requires every non-final part to be the SAME size (`partSize`, default and minimum 5 MiB). R2's default lifecycle aborts incomplete multipart uploads after 7 days; `sweepExpired` reaps the manifests.

Capability flags, per built-in store (what each backend honestly declares about itself):

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
- **`getUploadState(uploadToken)`** -> `{ key, offset, length?, isComplete, isInvalidated, createdAt, lastAppendAt?, metadata? }`. **The contract's one load-bearing rule: `offset` must be derived from storage bookkeeping the backend itself maintains** (a part listing, a block list, an fsynced file size), never from a counter persisted alongside the data. A stored counter and the bytes it describes cannot be written atomically, and their drift after a crash is exactly the corruption class resumable uploads exist to prevent. `key` is the storage key this upload publishes to, as given at creation: every backend already persists it in order to publish at all, so reporting it costs nothing, and it is what lets a caller pair an upload with the object it became. It is what `onUploadComplete` carries.
- **`appendChunk(uploadToken, offset, body, { maxBytes?, maxBytesFatal?, length?, now, signal? })`** -> `{ bytesWritten }`, the bytes made DURABLE by this call (on interruption, the flushed prefix; the next `getUploadState` must agree). It MUST open with the offset preflight `enforcesOffsetCheck` declares (see the capability flags below). `length` appears only on the deferred-length flow, when an append is the first request to state the total: persist it durably, after which it is immutable. The adapter MUST stop at `maxBytes`, and `maxBytesFatal` says what crossing it means. It is absent exactly when `maxBytes` is, since with no bound there is nothing to cross and a caller should not have to state a consequence for a limit it never set; the orchestrator derives both from one decision, so it is present whenever `maxBytes` is. An adapter that reads it absent treats a crossing as non-fatal, the direction that keeps the resource. `true`: the bound came from the REPRESENTATION (room toward a known length, or the policy's total `maxSize`), so bytes past it are the spec's terminal fault; the adapter durably invalidates the resource and throws `UploadOverrunError` carrying the bound, which the orchestrator answers `400` when the bound was the client's declared length and `413` when it was the policy maximum. `false`: the bound is this REQUEST's ceiling (`maxAppendSize`, or a backend's own per-call limit), so the adapter keeps the prefix it made durable, leaves the resource healthy, and throws `UploadAppendBoundError` carrying the durable offset; the orchestrator turns that into a `413` and the client resumes in smaller chunks. Collapsing the two would destroy an upload over a per-request nicety.
- **`completeUpload(uploadToken, { expectedDigest?, now, signal? })`** -> `{ etag?, digest? }`. Atomically publish: after success the object is readable; after ANY failure (including a digest mismatch) nothing new is visible to readers.
- **`abortUpload(uploadToken)`** - Discard the resource and its partial bytes. Idempotent, and it MUST NOT touch an object this upload already published: after `completeUpload` returns, the object at the key is live data readers can already be serving, while the upload resource is only the scaffolding that produced it. A `DELETE` arriving late, retried, or replayed therefore terminates the upload and never its result, which is what keeps an idempotent-by-contract call from destroying production data on its second invocation. Delete the object itself through your storage API, where the intent is explicit. Every built-in store behaves this way.
- **`sweepExpired?(olderThanMs)`** -> `{ removed }`. Remove resources idle since before the epoch-ms cutoff (callers typically pass `Date.now() - maxAgeMs` on a schedule). Optional on `ResumableWriteStore`, since an adapter whose backend has native lifecycle rules may document the native rule instead. Every built-in factory returns `SweepingWriteStore` (`ResumableWriteStore` plus a required `sweepExpired`), so a scheduled call needs no `?.`, which would otherwise turn a missed retention obligation into a silent no-op. `SweepingWriteStore` is assignable anywhere the wider type is expected, so a custom store that leaves the method out still fits. Three properties are contract, not implementation detail: it reclaims BYTES (sweeping a resource must do what `abortUpload` does to it, since a metadata-only sweep strands the data with nothing pointing at it, and those bytes are what a storage-limitation obligation is about); its clock is IDLENESS (`lastAppendAt ?? createdAt`) while `maxAgeSeconds` is measured from creation, so neither implements the other; and it runs WITHOUT the upload's lock, because a store has no locker, so keep the cutoff comfortably longer than the longest single append you permit or a sweep can reap a resource mid-write. Every built-in store reclaims bytes.

Capability flags (readonly fields, honest per backend, never assumed). Every adapter MUST accept an `appendChunk` of ANY size and buffer to its backend's real granularity internally, so the orchestrator never re-chunks; the first two flags are efficiency HINTS a caller or CDN may use to align its chunk sizes, not constraints anything upstream honors: `appendGranularity?` (the backend's natural part size in bytes, so aligning appends to a multiple of it avoids the adapter's internal tail buffering; `undefined` = byte-exact with no alignment benefit), `uniformPartSize?` (the backend prefers every non-final part to be the same size), `exactOffsetRecovery?` (where the offset derivation gets its truth: `true` means the backend's own bookkeeping (a file size, a part or block listing) so the offset is byte-exact and crash-durable, while `false` means the adapter's own durable ledger with nothing to cross-check it against, making the offset a durable LOWER BOUND that a crash can leave a few bytes behind the last acknowledged write. `false` is never corruption, since the client re-appends from a real durable offset; it costs a redundant chunk on recovery. Nothing in the orchestrator branches on it: it is published so you can weigh that cost when choosing a backend), `atomicCompletion` (`completeUpload` is all-or-nothing), `enforcesOffsetCheck` (`appendChunk` re-derives durable state at the start of every call and throws `UploadOffsetConflictError` rather than writing when the claimed offset disagrees; REQUIRED, and `createUploadOrchestrator` refuses a store reporting `false`, because the lock serializes writers but cannot prove the writer still holds it: an expiry-based distributed lock is stealable from a holder that stalls past its TTL and resumes, and this check is what makes that holder's next append a loud conflict instead of silent interleaving. It is a preflight per call, not one atomic step with the bytes: a holder that stalls MID-call and resumes can still land the flush it was performing, since `UploadPart`, `stageBlock`, an R2 part upload and a positional file write all accept their bytes unconditionally. That residual is bounded by the lock signal the orchestrator threads into the write, which every adapter tests at each chunk boundary, with a ceiling of one stale write; closing it entirely needs a backend-enforced fencing token. Read the flag as a floor, not as "stale writes are impossible"), `digestOnComplete` (`"sha256"` or `false`: whether the backend can verify a client-asserted SHA-256 over the whole assembled representation before publishing. SHA-256 is the only algorithm the orchestrator and the read side's `Repr-Digest` wiring speak end to end, so this is a two-value capability rather than an algorithm menu), `maxAppendSize?` (largest single append the backend accepts, folded into the effective policy). `atomicCompletion` and `enforcesOffsetCheck` are typed `true`, not `boolean`: `createUploadOrchestrator` refuses either as `false`, so a wider type would only invite an author to write a value the runtime rejects and discover it at server boot.

### Locking (`UploadLocker`)

A probe takes the lock too, which means a `HEAD` ASKS AN IN-FLIGHT APPEND TO YIELD: the running write aborts at its next chunk boundary, flushes what it has, and answers with a truthful shorter offset. No bytes are lost and the client resumes, but a monitoring loop polling `HEAD` against an active upload will keep chopping it into small appends. `orchestrator.resourceExists(uploadToken)` is the lock-free, non-preempting alternative when all you need is whether the token still resolves; it deliberately says nothing about the offset, which is the part the lock exists to make coherent.

Interactions on one upload resource are serialized by a lock, probes included (deriving an offset can be a multi-call backend read, and a torn snapshot would hand the client an offset its next request fails on). The lock is **cooperatively preempted**, not a plain mutex: a new acquirer aborts the current holder's signal, the holder yields its append at the next chunk boundary (flushing what it has, so the offset stays truthful), and the lock hands over in milliseconds. The interface is one method: `acquire(uploadToken, { timeoutMs?, auditKey? })` -> `Promise<UploadLock>`, where `UploadLock` is `{ signal: AbortSignal; release(): void }`. `auditKey` is the same substitution the rest of the package makes: supply one and a locker names the resource by it instead of by the token wherever it reports a failure. The holder threads `lock.signal` into its store write; the signal aborts (reason `UPLOAD_PREEMPTED`) the moment a later acquirer wants the resource, so preemption is a real cancellation the holder cannot silently ignore rather than a callback convention. Because the signal carries latched state, a preempt that lands during hand-over is never lost. A holder that does not yield within `timeoutMs` rejects with `UploadLockTimeoutError`, which the dialects answer as 423. Writing a custom `UploadLocker` is a page of code: create an `AbortController` at acquire time, abort it when a later acquirer arrives, and expose its `signal`.

Three places set that deadline, innermost first. `AcquireOptions.timeoutMs` on a single `acquire` call wins; failing that, the locker's own default (`memoryUploadLocker({ acquireTimeoutMs })` and `redisUploadLocker(client, { acquireTimeoutMs })`, both 15 s, both rejecting a non-positive or non-safe-integer value with a `TypeError` at construction); and `UploadOrchestratorOptions.lockTimeoutMs` is what supplies the per-call value, since the orchestrator is the only caller of `acquire` on a served request. Set the orchestrator option to bound waiting for the deployment, and the locker option to bound it for callers outside the orchestrator.

The default locker is in-process and correct for a single process. **Supply a shared locker via the `locker` option when more than one server instance can receive requests for the same upload resource** (horizontally scaled deployments without upload-affinity routing). See [DEPLOYMENT.md](DEPLOYMENT.md) for the reverse-proxy, CORS, and multi-instance operational checklist.

**CORS exposed headers.** A cross-origin browser upload cannot resume unless the browser is allowed to READ the protocol response headers. This package ships no CORS middleware (the origin/credential policy is yours), but it publishes the exact header list so you never assemble it by hand and drop one: `TUS_EXPOSED_HEADERS` (from `partial-content/tus`) and `UPLOAD_EXPOSED_HEADERS` (from `partial-content/upload`), both frozen `string[]`. Spread into `Access-Control-Expose-Headers`: expose `Location` but forget `Upload-Offset` and every resume silently fails.

**`redisUploadLocker(client, options?)`** (`partial-content/redis-locker`) - The shared locker for Redis-protocol servers (Redis, Valkey, KeyDB, Dragonfly), with the same cooperative-preemption semantics as the in-process one. Zero dependencies: the caller passes a client behind the four-command `RedisLockerClient` interface (`set` NX PX, `eval` for the module's two static compare-and-delete/compare-and-expire Lua scripts, `publish`, `subscribe`), which any client library adapts in a few lines. One requirement the four signatures cannot express: commands issued through the client MUST reach the server in issue order, which a single connection gives and a round-robin POOL does not. The safety of an abandoned acquire rests on it, since a `SET` whose reply never arrived is followed by the compare-and-delete that frees it; run them out of order and the resource is held by nobody for a full TTL.

```typescript
// node-redis v4/v5 (subscribe needs its own connection, as Redis requires):
import { createClient } from "redis";
import { redisUploadLocker } from "partial-content/redis-locker";

const redis = await createClient({ url }).connect();
const locker = redisUploadLocker({
  set: (key, value, opts) => redis.set(key, value, opts),
  eval: (script, keys, args) => redis.eval(script, { keys: [...keys], arguments: [...args] }),
  publish: (channel, message) => redis.publish(channel, message),
  subscribe: async (channel, onMessage) => {
    const sub = redis.duplicate();
    await sub.connect();
    await sub.subscribe(channel, onMessage);
    return () => sub.destroy();
  },
});
```

`ttlMs`, `acquireTimeoutMs` and `pollIntervalMs` must each be a positive safe integer; a value that is not throws a `TypeError` naming the option and the value it was given, at construction rather than on the first contended upload.

Mechanics: the lock is `SET key <hold-id> NX PX ttl` (`ttlMs`, default 30 s, is the crash-recovery bound), the hold id being a per-acquire random value; a live holder renews at ttl/3 via a watchdog, and a renewal that cannot confirm the hold aborts the holder's lock signal, because a holder that cannot prove its lock must stop writing. Waiters publish a preempt request on the resource's channel and RE-publish it every poll round (`pollIntervalMs`, default 50 ms, jittered), so a request landing in the holder's subscribe gap is re-delivered, never lost; release and renewal compare the hold id in Lua, so an instance can only ever release its own hold. The hold id is deliberately NOT a fencing token: it fences this locker's own release and renewal against a stale holder, and it never reaches a store write, so it cannot fence the thing a fencing token exists to fence. `onError` observes absorbed failures (failed renewal/release/unsubscribe); its context is `{ uploadToken?, auditKey?, operation }` and carries exactly one identifier, the `auditKey` from the acquire when there was one and the token otherwise. The acquire timeout bounds every round trip the acquire makes, not just the polling, so a server that accepts a command and never answers costs the caller its timeout and then a 423; because the protocol has no client-side cancel, an abandoned `SET` is followed by the compare-and-delete that keeps a late arrival from holding the resource, and a renewal that has not answered by the time the next one is due counts as a failure to confirm. Honesty about fencing: an expiry-based lock can be stolen from a holder that stalls past its TTL and resumes; the write store takes no fencing token, so what makes that non-corrupting is the same defense the engine has in-process, fresh-state validation under the new holder's lock plus the stores' own at-write offset checks, which turn a zombie's late append into a loud `UploadOffsetConflictError`.

### Upload audit events (`onUploadEvent`)

Structured, content-free by construction (no filenames, no bytes, no metadata values): `{ uploadToken?, auditKey?, event }`, where `uploadToken` is present only when no `auditKey` was supplied (the key substitutes for it, because the token is the capability and this hook feeds log records) where `event` is one of `created` (with `declaredLength?`), `append-accepted` (`atOffset`, `completes`), `append-rejected` (`reason`, `atOffset?`), `completed` (`length`), `cancelled`, `expired`. Reject reasons: `offset-mismatch`, `length-inconsistent`, `size-exceeded`, `append-too-small`, `append-too-large`, `below-min-size`, `invalidated`. An expiry is reported as its own `expired` event rather than a reject reason, and the two answers that reject nothing durable, a repeat of a completed upload and a lock contention, emit no event at all: neither changed the resource.

The same substitution governs the context handed to `onError`, which carries `{ uploadToken?, auditKey?, operation }`: supply an `auditKey` and it arrives on the context while `uploadToken` is absent, since an error sink is at least as log-adjacent as an event sink. Correlate on the key either way.

### Upload error classes

The first five are thrown by write stores, the last by the locker. All six, with their matchers, come from either dialect subpath (`partial-content/tus`, `partial-content/upload`); the store classes are additionally re-exported from the storage subpaths (`UploadNotFoundError`, `UploadOffsetConflictError`, `UploadAppendBoundError` and `UploadOverrunError` from all six, `UploadDigestMismatchError` from `/fs`, `/memory`, and `/s3`). Every one is matched **by `name`**, so a custom store can throw equivalently-named errors without importing the classes:

- **`UploadNotFoundError`** - The upload resource does not exist (never created, completed and reaped, cancelled, or expired-and-swept). Dialects answer 404.
- **`UploadOffsetConflictError`** - An append's claimed offset lost a race with durable state (defense in depth under the lock; carries `durableOffset`). The orchestrator answers offset-mismatch with the correct offset.
- **`UploadAppendBoundError`** - The body ran past a NON-fatal append bound (`maxBytesFatal: false`), this request's ceiling rather than the representation's (carries `durableOffset`). The resource is untouched and healthy and the prefix the adapter made durable stays durable, so both dialects answer 413 and the client resumes from `durableOffset` in smaller chunks. Matcher: `isUploadAppendBoundError`.
- **`UploadOverrunError`** - The body ran past a FATAL append bound (`maxBytesFatal: true`), the representation's own bound (carries `bound`). The upload can never be completed coherently, so the adapter has already invalidated it durably and every later probe or append refuses. The orchestrator answers 400 when the bound was the length the client declared and 413 when it was the policy's `maxSize`, because the fault is the client's against its own declaration, not the storage's. Matcher: `isUploadOverrunError`.
- **`UploadDigestMismatchError`** - The assembled bytes do not hash to the digest the client asserted (carries `expectedDigest`, `actualDigest?`). Thrown BEFORE publishing; the dialect answers a client error, never a torn object.
- **`UploadLockTimeoutError`** - The lock was not obtained within the acquire timeout, because the holder did not yield or (for a server-backed locker) the server did not answer in time; raised by the locker rather than a store (a custom `UploadLocker` signals timeout by rejecting with an error of this `name`). Dialects answer 423. Matcher: `isUploadLockTimeoutError`.

## Store conformance (`partial-content/conformance`)

Two harnesses over one report shape: `checkResumableWriteStore` for a `ResumableWriteStore`, `checkObjectStore` for an `ObjectStore`. Neither is a test file and neither needs a test framework: every check is a plain async call against the store's own public surface, so a run works under any runner, in CI, or as a startup self-test against a staging bucket. Checks are independent, so one run reports every gap rather than the first.

Both return `{ ok, checks, passed, failed, skipped }`, where `ok` is `failed === 0`. A **skipped check never makes the report fail, and never counts as passed either**: it is reported as its own outcome (`skipped: true`, with a `detail` saying why) so an unverified guarantee is visible instead of green. Each `ConformanceCheck` carries a stable `name` safe to allow-list against in your own CI, an `obligation` phrased as what the store must do, `ok`, and a `detail` explaining a failure in terms of its consequence rather than its assertion.

**`formatConformanceReport(report)`** -> `string` renders either report as plain `PASS`/`FAIL`/`SKIP` lines plus a tally. It returns the text and prints nothing, so the caller chooses the sink.

### Write stores (`checkResumableWriteStore`)

The write-store contract is enforced in two places, and only one of them is mechanical. `createUploadOrchestrator` checks that a store DECLARES `atomicCompletion` and `enforcesOffsetCheck`, but a declaration is a claim about behavior: nothing at construction can tell a store that performs the at-write offset check from one that reports `true` and writes anyway. The second store is the more dangerous of the two, because it presents as working. Appends land, uploads complete, and the guarantee the flag stands for is missing exactly when a distributed lock is stolen from a holder that stalled past its TTL, which is the case nobody exercises by hand.

**`checkResumableWriteStore(makeStore, opts?)`** -> `Promise<ConformanceReport>` turns those claims into assertions.

A **factory** is passed rather than a store instance, because two obligations can only be observed across instances: that the offset comes from durable backend state rather than in-process memory, and that an invalidation is visible to a process which never saw the append that caused it.

```typescript
import { checkResumableWriteStore, formatConformanceReport } from "partial-content/conformance";
import { fsUploadStore } from "partial-content/fs";

const report = await checkResumableWriteStore(
  () => fsUploadStore({ root: "/var/tmp/conformance" }),
  { key: (n) => `conformance/${n}` },
);
console.log(formatConformanceReport(report));
if (!report.ok) {
  throw new Error(`store failed ${report.failed} conformance check(s)`);
}
```

Options (`ConformanceOptions`), all optional:

- **`key(n)`** (default `` `partial-content-conformance/${n}` ``) - Storage key for the nth upload the harness creates. Keys must be distinct and disposable: the harness publishes to some of them and aborts others, so point it somewhere a real deployment does not serve.
- **`now()`** (default a fixed instant) - Epoch-ms clock handed to the store. Injected rather than read, so a run is reproducible and expiry checks do not wait in real time.
- **`restartable`** (default `true`) - Does a second call to the factory yield a store that sees the same durable state? True for anything backed by a filesystem or an object store. False for a store that is in-process by construction, where a fresh instance is genuinely a different store: `memoryUploadStore` holds its in-flight uploads per instance, so it needs `restartable: false`. **Setting it false SKIPS the cross-instance checks rather than passing them.** The guarantees go unverified and the report says so.

The 15 checks, by what they pin:

| Check | Obligation |
|---|---|
| `declares-atomic-completion` | `atomicCompletion` is `true`; the orchestrator has no completion rollback of its own |
| `declares-offset-check` | `enforcesOffsetCheck` is `true`; it is the only guard against a stolen-lock writer |
| `token-is-unguessable` | Tokens come from a CSPRNG: distinct, long enough, and not sorting into the order they were minted (which is what a counter or a timestamp prefix looks like) |
| `offset-starts-at-zero` | A fresh upload reports offset 0, is neither complete nor invalidated, and echoes the injected `createdAt` |
| `offset-agrees-after-clean-append` | `getUploadState().offset` agrees with the `bytesWritten` an append reported |
| `offset-is-backend-derived` | A fresh instance derives the same offset (skipped when `restartable: false`) |
| `refuses-stale-offset` | An append behind durable state throws `UploadOffsetConflictError` carrying the right `durableOffset`, rather than interleaving silently |
| `refuses-future-offset` | An append ahead of durable state is refused rather than leaving a hole in the object |
| `request-ceiling-keeps-the-resource` | A non-fatal bound stops at `maxBytes`, keeps the prefix durable, leaves the upload healthy, and can be resumed from |
| `representation-bound-invalidates` | A fatal bound throws `UploadOverrunError` and invalidates durably, visibly to a fresh instance where the store is restartable |
| `completion-publishes-and-closes` | `completeUpload` publishes and the upload refuses further appends afterwards |
| `abort-is-idempotent` | `abortUpload` tolerates being called twice; a retried cancel is a normal thing to receive |
| `abort-spares-a-published-object` | `abortUpload` never destroys an object completion already published |
| `invalidated-upload-is-still-cancellable` | A dead upload stays discardable, or its bytes are stranded until a sweep that may never run |
| `records-a-deferred-length` | A length first declared on an append is persisted (skipped when `restartable: false`) |

### Read stores (`checkObjectStore`)

**`checkObjectStore(store, opts)`** -> `Promise<ConformanceReport>` runs the read contract against an `ObjectStore`. Two of its obligations are the ones a custom read store most often gets subtly wrong, and neither shows up on the happy path: an honest total size on a partial read, and a not-found that is distinguishable from a failure. A wrong total becomes the `Content-Range` total a client sizes its remaining requests against, and an indistinguishable not-found turns a missing object into a backend error that a caching layer will retry.

A store INSTANCE is passed here rather than a factory, because nothing in the read contract is observed across instances. The harness is strictly read-only: it never creates and never deletes, since an `ObjectStore` has no vocabulary for either and a read store may front something immutable. That is what makes it safe to point at a staging bucket that already serves the object.

```typescript
import { checkObjectStore, formatConformanceReport } from "partial-content/conformance";
import { memoryStore } from "partial-content/memory";

// A key the store already serves, and the exact bytes behind it.
const content = new TextEncoder().encode("conformance sample bytes");
const store = memoryStore({ objects: { "docs/sample.bin": { body: content } } });

const report = await checkObjectStore(store, { key: "docs/sample.bin", content });
console.log(formatConformanceReport(report));
if (!report.ok) {
  throw new Error(`store failed ${report.failed} conformance check(s)`);
}
```

Options (`ObjectStoreConformanceOptions`):

- **`key`** (required) - a key the store ALREADY serves. Nothing in the run puts it there, so it has to exist first.
- **`content`** (required) - that object's exact bytes, as a `Uint8Array`. Every assertion is measured against them, so a stale copy reports the store wrong rather than the content.
- **`missingKey`** (default: `key` plus a `.partial-content-conformance-missing` suffix) - a key the store must NOT serve. Override it where the default would collide with something real.

The 6 checks, by what they pin:

| Check | Obligation |
|---|---|
| `head-reports-the-true-length` | `headObject` reports the object's exact byte length, which is the `Content-Length` a client counts bytes against |
| `full-read-returns-every-byte` | A rangeless `getObject` returns the whole representation byte-identically, with a `contentLength` that matches it |
| `missing-object-is-not-found` | `headObject` on an absent key throws `ObjectNotFoundError`; anything else is answered as a backend failure, so a missing object becomes a 502 |
| `range-serves-the-requested-window` | A ranged read returns exactly the requested bytes, with a `contentLength` describing the window rather than the object |
| `range-reports-an-honest-total` | A ranged read reports the whole representation's size as `totalSize`, or `undefined` where the backend cannot know it |
| `digest-is-the-whole-representation` | Any `digest` reported is the raw base64 SHA-256 of the whole object and matches its bytes, never a window's |

Skips keep an unverified obligation from reading as a met one. A store declaring `supportsRange: false` has the two range checks **skipped rather than passed**, since the serving path never asks it for a window; the same happens when `content` is under 4 bytes, which is too short to slice a meaningful window from. `digest-is-the-whole-representation` is not among them: a store that reports no digest passes it, because absent is a legitimate answer, and what the check refuses is a digest that is malformed or computed over anything but the whole representation.
