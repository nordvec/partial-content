# API Reference

The complete export surface. Everything is typed; your editor's IntelliSense mirrors this page.

## Kernel (`partial-content`)

**`evaluateConditionalRequest(reqHeaders, meta, opts?)`** - One-call handler for the full HTTP evaluation chain. Returns `{ status, headers, range }`. Pass `opts.method` (default `"GET"`): for `"HEAD"` the Range and If-Range headers are ignored per RFC 9110 14.2 (never 206/416; `Content-Length` is the full size, exactly what the 200 would carry) and `Content-Digest` is suppressed (a HEAD transfers no content, RFC 9530 B.2). For writes use `evaluateConditionalWrite` instead.

**`evaluateConditionalWrite(reqHeaders, meta)`** - One-call handler for write requests (PUT/PATCH/DELETE). Returns `{ proceed: true }` or `{ proceed: false, status: 412, headers }`. The 412 response includes the current `ETag` when available, so the client can resync without a follow-up GET.

**`parseRangeHeader(rangeHeader, totalSize)`** - Returns `{ start, end }`, `"unsatisfiable"`, or `null`.

**`parseRanges(rangeHeader, totalSize, maxRanges?)`** - Multi-range parsing for `multipart/byteranges`: coalesces overlapping, adjacent, and near-adjacent ranges (gaps under the ~80-byte part overhead, RFC 9110 15.3.7.2), preserves the request's part order, and caps the part count (`maxRanges`, default 8). A cap that is not a number at least as large as the coalesced count, `NaN` included, returns `null`. Returns a `RangeSet` (in request order), `"unsatisfiable"`, or `null` (serve the full 200).

**`buildRangeResponseHeaders(opts)`** - Build 200 or 206 response headers.

**`buildMultipartHeaders(opts)` / `buildMultipartPartHeader(...)` / `multipartEpilogue(boundary)` / `generateMultipartBoundary()`** - The `multipart/byteranges` framing primitives with exact precomputed Content-Length (never chunked).

**`parseContentRange(header)`** - Parse a `Content-Range` response header (e.g. `bytes 0-499/1000`). Returns `{ start, end, totalSize }` or `null`. `totalSize` is `undefined` when the header states the total as `*` (`bytes 0-499/*`), never a sentinel number.

**`generateETag(source)`** - Derive an entity-tag from storage metadata. This is a formatter, not a hasher: it classifies metadata the backend already gave you into the correct validator strength per RFC 9110 Section 8.8.1.

`source` carries three optional fields, named to match `ObjectMetadata` so a store's own metadata is a valid argument:

| Field | Type | Meaning |
|---|---|---|
| `etag` | `string` | Backend version identifier that changes whenever the stored bytes change. Surrounding quotes and a `W/` prefix are normalized. |
| `contentLength` | `number` | Object size in bytes. |
| `lastModified` | `string \| number \| Date` | Modification time. |

Because the names line up, `generateETag(await store.headObject(key))` is a supported call. Extra properties are ignored, which is what lets a whole `ObjectMetadata` through; `digest` is one of them on purpose, and it is never read, so when a store supplies both, `etag` decides the validator.

Outcomes: `etag` present yields a strong `"<value>"` (the ETag grammar is enforced, so the emitted tag is always well-formed); `contentLength` plus `lastModified` alone yield a weak `W/"<size>-<mtime>"`; anything less yields `undefined`.

**Never pass a value that can stay constant across a byte change.** Strength requires exactly that the identifier moves when the bytes do, not that it is a content digest: an S3 multipart ETag is not a digest, yet every rewrite changes it, so it qualifies.

**A retired field name throws rather than degrading.** The three fields were once called `hash`, `size` and `mtime`. Passing one of those now raises a `TypeError` naming the replacement, because the alternative is the worst failure this function has: an unrecognized property is not an error in JavaScript and neither is a missing one, so the old name would simply read as absent, the call would correctly refuse to fabricate a validator it cannot stand behind, and the server would serve every response with no `ETag` at all. No revalidation, no `If-Range` resume, no OCC, and the only symptom is a cache-hit rate that was never there. Any other unrecognized name is still silent, so type the argument as `ETagSource` (`import type { ETagSource } from "partial-content"`) and assert a non-`undefined` return in one test.

Never pass a value that can stay constant across a byte change: strength requires exactly that the identifier moves when the bytes do, not that it is a content digest.

**`buildContentDisposition(filename, options?)`** - Security-hardened `Content-Disposition` header builder with CRLF injection prevention, path traversal protection, bidi override stripping, and RFC 8187 non-ASCII encoding. Options (`ContentDispositionOptions`): `type?` (`"attachment"` or `"inline"`, default `attachment`, the safe disposition for untrusted content) and `fallback?` (the filename used when `filename` is null, undefined, or empty after sanitization, default `"document"`).

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

**`lookupMime(filenameOrExt, options?)`** - Curated, zero-dependency extension -> MIME lookup for documents, media, archives and fonts. Case-insensitive, resolves the last dot segment (`archive.tar.gz` -> `application/gzip`), returns `undefined` for unknown types so the caller controls the fallback. `html` is deliberately absent: serving stored uploads as `text/html` is stored XSS, so that decision must be explicit at the call site. The same holds for `js`, `mjs`, `css` and `wasm`, which resolve only with `{ webAssets: true }` (`text/javascript`, `text/css`, `application/wasm`): pass it for your own build output, never for user uploads.

```typescript
// doc-check: fragment
import { lookupMime } from "partial-content/mime";

app.get("/files/:key", serveObject(store, {
  key: (req) => req.params.key,
  mime: (req) => lookupMime(req.params.key),
}));
```

## Universal HTTP Store (`partial-content/http`)

**`httpStore({ url, headers?, fetch?, redirect?, reservedPrefix? })`** - Serve from ANY range-capable HTTP origin over plain `fetch`: Supabase Storage, presigned S3/GCS/Azure URLs, CDN origins, or another partial-content server. Pinned reads map to `If-Match` (origin 412 -> `ObjectChangedError`), `Repr-Digest` response headers are extracted, and requests are sent `Accept-Encoding: identity` and any response that still carries a non-identity `Content-Encoding` is refused, so transparent compression can never corrupt byte accounting. `Accept-Encoding`, `Range`, and `If-Match` are reserved: the adapter owns them and replaces any consumer-supplied value case-insensitively. Redirects error by default (a hostile origin must not 3xx the store toward internal/metadata IPs); set `redirect: "follow"` for origins that legitimately redirect, paired with a validating `fetch` when keys are untrusted (see SECURITY.md).

```typescript
import { httpStore, encodeKeyPath } from "partial-content/http";

// The origin you are proxying, and the credential it expects.
declare const SUPABASE_URL: string;
declare const serviceRoleKey: string;

const store = httpStore({
  // A key is a path in the origin's namespace, not a URL fragment: each segment
  // is encoded so a key cannot carry a query, a fragment or a dot segment into
  // the request line.
  url: (key) => `${SUPABASE_URL}/storage/v1/object/documents/${encodeKeyPath(key)}`,
  headers: { Authorization: `Bearer ${serviceRoleKey}` },
});
```

**`encodeKeyPath(key)`** - Percent-encodes each `/`-separated segment of a key for use as the path suffix of an origin URL, keeping the separators literal. Refuses an empty segment and the `.` and `..` dot segments as `ObjectNotFoundError`, since a URL parser resolves those before the origin sees the path. Use it in `url()` whenever the key is not already a URL-safe path.

## Memory Store (`partial-content/memory`)

**`memoryStore({ objects })`** - A spec-faithful in-memory store for consumer test suites, demos, and small embedded assets. Fabricates correct Content-Range values, honors `ifMatch` pinning (mutate the map to simulate overwrites and exercise retry logic), declares `authoritativeRange` (plain ranges serve in one round-trip), and streams zero-byte objects correctly.

`objects` is a `Record<string, MemoryObject>` held BY REFERENCE, which is the supported way to simulate an upload, an overwrite, or a deletion between requests: mutate the map and the next request sees it.

**`MemoryObject`** (type) - One entry in that map:

| Field | Type | Meaning |
|---|---|---|
| `body` | `Uint8Array \| string` | Object content. A string is encoded as UTF-8 (the encoding is memoized per entry, and a changed string re-encodes rather than serving stale bytes). Required. |
| `etag` | `string?` | Raw ETag exactly as a backend would return it, quotes included (`'"abc123"'`). Omit and the entry has no strong validator. |
| `lastModified` | `string?` | Any `Date.parse()`-able string. |
| `digest` | `string?` | RFC 9530 raw base64 SHA-256 of the body, surfaced as `Repr-Digest`/`Content-Digest` when the client negotiates one. |

A key not present as an OWN property of the map is a `404`: inherited names (`constructor`, `toString`) are not objects.

## Cloud & Filesystem Stores

**`reservedPrefix?`** (on `fsStore`, `s3Store`, `r2Store`, `gcsStore`, `azureStore`, `httpStore`) - Keys at or under this prefix are refused with `ObjectNotFoundError` on `headObject`, `getObject`, and `createSignedUrl` where the backend has one. A read store and an upload store are routinely pointed at the same root or bucket, which is what makes a completed upload servable without copying it; in that arrangement the upload store's own namespace is reachable through the read path, exposing the in-flight bytes of an upload nobody has published and the sidecar naming the key it is destined for, which commonly embeds a filename. An upload token is the only handle meant to reach that namespace, and a read handler holds none. Refusal is therefore the DEFAULT, not an opt-in: it is the sibling upload store's own prefix (`.uploads/` for fs and s3, `.partial-content-uploads/` for r2, gcs and azure; `httpStore` cannot know which upload store sits behind its origin and refuses both by default). Set it to your own value when you changed the upload store's `uploadPrefix`, or to `""` to serve the whole namespace when no upload store shares the location. `memoryStore` takes no such option: its in-flight uploads live in a separate map, never in `objects`. The guard itself is exported from the package root as `reservedKeyGuard(prefix)`, which also takes a list of prefixes, for custom `ObjectStore` implementations sharing a location with an upload store.

**Construction validates its options.** `memoryStore`/`memoryUploadStore` require `objects`, `fsStore`/`fsUploadStore` require an ABSOLUTE `root`, and `s3Store`/`s3UploadStore` require `client` and `bucket`; each throws a `TypeError` naming what to change. A missing `objects` map otherwise surfaced as a 502 at publication, after the entire body had transferred, and a relative `root` silently anchored to `process.cwd()`. The `fsStore` `cache` options `ttlMs`, `maxEntries` and `maxBytes` throw a `TypeError` for `NaN`, an infinity or a negative number, each of which would disable the bound it names.

**`s3Store({ client, bucket })`** (`partial-content/s3`) - Any S3-compatible backend (AWS, R2 in S3 mode, Hetzner, MinIO, Backblaze, Wasabi) via `@aws-sdk/client-s3`. Pinned reads via `IfMatch`, `authoritativeRange` single-round-trip seeks, `x-amz-checksum-sha256` surfaced as the RFC 9530 digest, throttle errors mapped to retryable 503s (with the backend's `Retry-After` when the SDK exposes it), and `createSignedUrl` via `@aws-sdk/s3-request-presigner`. A failure while signing (a credential provider, the signer) throws; the store declines (`code: "unsupported"`) only when the presigner package cannot be loaded.

**`r2Store({ bucket })`** (`partial-content/r2`) - Cloudflare R2 via the native Workers binding (no AWS SDK). Pinned reads via `onlyIf.etagMatches`; served bounds come from R2's own reported range.

**`gcsStore({ storage, bucket, digestMetadataKey? })`** (`partial-content/gcs`) - Google Cloud Storage via `@google-cloud/storage` (pass the constructed `Storage` client plus the bucket name). Pins reads to the object GENERATION (an opaque `pin` token from `headObject` makes the HEAD->GET pair a single metadata round-trip), and mints V4 signed READ URLs via `createSignedUrl` (no Cache-Control response override -- GCS signed URLs have no `response-cache-control` parameter, unlike S3); a client with no `client_email` to sign with declines (`code: "no-credential"`) and the response streams. A read awaits the first chunk before the status is committed: an object gone or replaced under a pinned read throws `ObjectChangedError`, and a missing one under an unpinned read throws `ObjectNotFoundError`, each answered as its own status and never as a `200` that fails mid-body. GCS exposes no native SHA-256 (`x-goog-hash` carries only `crc32c`/`md5`), so set `digestMetadataKey` to the custom-metadata key where your uploader stores the raw-base64 SHA-256 and the store surfaces it as the RFC 9530 digest; invalid or absent values are simply not emitted.

**`azureStore({ containerClient })`** (`partial-content/azure`) - Azure Blob Storage via `@azure/storage-blob`. Single-call `download()` (metadata and body are one response by construction); pinned reads via `conditions.ifMatch`; `createSignedUrl` mints a read-only SAS URL with sanitized Content-Disposition, inert content type, and the Cache-Control response override. It requires a shared-key credential on the client; without one it declines (`code: "no-credential"`) and the response streams.

**`fsStore({ root, cache?, reservedPrefix?, symlinks? })`** (`partial-content/fs`) - Local filesystem with path-traversal/null-byte/Windows-device-name hardening, nanosecond-mtime weak ETags, an fd-coherent stat+stream (no stat-then-reopen race), `authoritativeRange` single-round-trip range serving (the one open handle stats, clamps, and reads, so bounds, validators, and bytes are coherent by construction), and a single-read fast path for bodies <= 128 KiB. `root` must be ABSOLUTE. `reservedPrefix` defaults to `.uploads/` (see above). A path that is not a regular file (a FIFO, a device) is refused rather than opened for a blocking read.

`symlinks` decides what a symbolic link or junction under the root may reach. `"contain"` (the default) serves a key only when its real path, every link resolved, is inside the root's real path, and opens the file without following a link in the final component where the platform supports `O_NOFOLLOW`. A link from one place in the root to another serves; one that leaves the root, or that reaches the reserved upload workspace, answers `ObjectNotFoundError`. `"follow"` resolves links wherever they point, for a root whose layout links to content kept elsewhere on purpose; any other value contains. The containment check and the open are two steps, so a writer that can swap a directory under the root for a link between them is outside what it defends against: keep the served tree writable only by principals you would trust with the files, or serve from a root no untrusted party can create links in. `fsUploadStore` always publishes inside the real root: it refuses a directory link that leaves the root and a linked `.uploads`.

`cache` is off by default, correctness first. Supplying it opts into a hot-object cache that holds metadata and, for bodies at or below the 128 KiB single-read limit, the bytes as well -- both captured from ONE read, so a response's headers always describe the bytes it actually sends:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `ttlMs` | `number` | required | How long an entry may serve before it revalidates against disk. This is the staleness budget you are buying throughput with: after an overwrite, responses (304 revalidations included) can affirm the previous representation for up to `ttlMs`. Use a long TTL for content-addressed or otherwise immutable keys. |
| `maxEntries` | `number?` | `1024` | Entry cap, evicted least-recently-used. |
| `maxBytes` | `number?` | `67108864` (64 MiB) | Total byte budget for cached BODIES, evicted least-recently-used. Metadata-only entries cost nothing against it, and a single body larger than the whole budget is served normally but cached metadata-only, so one oversized object can never flush the cache and still not fit. `0` keeps the cache metadata-only: stat elision with no body memory. |

Worst-case memory is therefore `min(maxEntries * 128 KiB, maxBytes)` plus per-entry metadata.

**What the weak validator costs you, and why it is correct.** `fsStore` derives its ETag from size and modification time, which cannot assert byte equality, so it is always weak (`W/"..."`). Two consequences follow from the strength rules in RFC 9110 Section 8.8.3.2, and both are correct behavior rather than a gap to work around:

- **An `If-Range` entity-tag can never honor a range against an fs-backed object.** `If-Range` requires strong comparison, so an interrupted download that resumes with an entity-tag `If-Range` + `Range` is answered `200` with the whole representation, every time. An `If-Range` HTTP-date is honored once the object's Last-Modified second has fully elapsed and the date matches it exactly (RFC 9110 Section 13.1.5); a client that resumes with the `Last-Modified` it was given gets its `206`. The alternative would be splicing bytes from one version onto a client's cached copy of another. A resume that sends `Range` WITHOUT `If-Range` is unaffected and still gets its `206`, which is what media players and PDF readers send.
- **`If-Match` with an entity-tag always fails.** `evaluateConditionalWrite` answers `412` for any specific tag, because a weak validator cannot authorize a write. `If-Match: *` is unaffected and still succeeds whenever the resource exists, so use it when all you need is "the object is there".

Both lift the moment the store supplies a strong validator, which is what the object stores do (`s3Store` and `azureStore` pass the backend ETag straight through). If you need OCC or `If-Range` resumes over local files, put the strong validator in front of the write path rather than trying to strengthen the derived one.

The cloud SDKs are optional peer dependencies: install only the one your store uses.

**The SDK shim interfaces are exported as types**, so you can write the adapter object a store expects and have the compiler check it, rather than reaching for a cast when your client is wrapped, mocked, or a compatible non-SDK implementation. `/azure` exports `AzureContainerClient`, `AzureBlobClient`, `AzureGenerateSasUrlOptions`, `AzureBlobProperties` and `AzureBlobDownloadResponse`; `/gcs` exports `GcsStorage`, `GcsBucket`, `GcsFile`, `GcsSignedUrlConfig` and `GcsFileMetadata`; `/r2` exports `R2Bucket`, `R2Object`, `R2ObjectBody`, `R2GetOptions`, `R2Range`, `R2Checksums` and `R2HttpMetadata`. Each is the narrow structural slice the store actually calls, which is also the surface a shim has to satisfy.

## Hono Adapter (`partial-content/hono`)

**`serveObject(store, options)`** - A Hono handler factory over the same engine: web-adapter options plus `key`/`mime`/`filename`/`auditKey` extractors receiving the Hono `Context`. A throwing extractor becomes a hardened 500 and is reported to `onError` with `operation: "context"`.

## Web Adapter (`partial-content/web`)

**`serveObject(store, options?)`** - Create a Fetch API handler that serves files from an ObjectStore. Returns `(req: Request, ctx: ServeContext) => Promise<Response>`.

**`serveObjectRaw(store, options?)`** - The same engine returning `RawResponseParts` (`{ status, statusText, headers, body }`) instead of a `Response`, for server adapters that write to their runtime natively (the bundled node adapter uses it). Skips all fetch-primitive construction on the hot path.

Options: `disposition`, `cacheControl`, `immutable`, `etag` (set `false` to suppress derived ETags, e.g. multi-replica filesystems with unsynchronized mtimes; `Last-Modified` revalidation is unaffected), `securityHeaders`, `crossOriginResourcePolicy`, `timingAllowOrigin`, `timing`, `onTiming`, `onError`, `onServe`, `onTransfer`, `maxRanges`, `maxBackendReads`, `enforceCharset`, `fallbackFilename`, `precompressed`, `preferSignedUrl`, `signedUrlExpiresSeconds`, `accessControlExposeHeaders` (`true` = expose the protocol's non-safelisted headers -- the exported `PROTOCOL_EXPOSE_HEADERS` list -- so cross-origin readers like pdf.js can see `Accept-Ranges`/`Content-Range`/`ETag`; a string is emitted verbatim; exposure only, your CORS layer still sets `Access-Control-Allow-Origin`).

**`maxRanges`** (default `8`) and **`maxBackendReads`** (default `8`) bound a `multipart/byteranges` response. More than `maxRanges` coalesced ranges is answered with the full `200`. Up to `maxBackendReads` parts, each part streams from its own ranged, pinned read of the store, so one request can drive that many backend reads; past it, the parts are cut from ONE buffered read of the span covering them when the span is under 256 KiB, and the full `200` is served otherwise. Raising `maxRanges` above `maxBackendReads` is therefore safe but buffered, and raising both makes a request as expensive as that many backend calls: lower `maxBackendReads` (even to 1) if your backend bills per request. Each must be a safe integer of at least 1; `serveObject` throws a `TypeError` at construction otherwise, because a `NaN` cap would compare false against every count and allow unlimited ranges.

**`precompressed: true | ["br", "zstd", "gzip"]`** - Serve precompressed sibling objects (`<key>.br`, `<key>.zst`, `<key>.gz`) negotiated via `Accept-Encoding` (RFC 9110 12.5.3: qvalues, `*`, `identity` preference; the array order is the server tie-break). The chosen variant is its own representation: its validators drive 304/If-Range, its size drives Range/`Content-Range`/416 (byte ranges address the ENCODED bytes), its digest rides `Repr-Digest`, and `Vary: Accept-Encoding` is emitted on every success response for the type, including identity fallbacks and 304s. Gated on compressible MIME types (`isCompressibleMime`); multi-range requests serve identity; a non-404 probe failure falls back to identity and reports to `onError`. Selection only -- upload the variants yourself (e.g. `brotli -k`, `gzip -k` at build/ingest time); the library never compresses at serve time because transforming would corrupt byte ranges and digests.

**`preferSignedUrl(info)`** - Per-request egress offload: return `true` to answer a 302 to `createSignedUrl` instead of proxying bytes (`info` = `{ key, mime, method, isRange, isConditional }`). The classic split is `({ isRange, isConditional }) => !isRange && !isConditional`: ranges and revalidations stay on the origin where the protocol machinery matters, large full-file downloads go straight to the bucket. HEAD requests never consult the predicate (a metadata probe answered with a bare 302 defeats exactly the clients that send HEAD, like PDF.js size probing), so `info.method` is always `"GET"`. The signed request carries the route's `cacheControl` (S3 `response-cache-control` override) so private documents cannot be CDN-cached under an object's baked-in public Cache-Control. A store that declines to sign (`{ ok: false }`) is streamed from the origin and the decline is not reported; a signer that throws is reported with operation `"sign"` and answered `502` (`499` when the client had already gone). `signedUrlExpiresSeconds` (default 60) sets the URL lifetime -- note that temporary credentials (STS/Lambda) cap the effective lifetime at the session token's remaining life regardless.

Method surface: GET and HEAD are served (HEAD with identical headers and no body), OPTIONS answers `204` + `Allow: GET, HEAD, OPTIONS`, everything else `405`.

**A HEAD carrying `Range` is answered `200`, never `206` or `416`.** RFC 9110 Section 14.2 scopes `Range` to GET, so on a HEAD the `Range` and `If-Range` fields are ignored: the response is the metadata of the full representation, with `Content-Length` equal to the total size -- exactly the headers the corresponding `200` GET would carry, which is the whole point of a HEAD. A range that would be unsatisfiable on a GET is therefore still a `200` here, because there is no content whose bounds could fail. `Content-Digest` is suppressed as well (a HEAD transfers no content, RFC 9530 B.2), while `Repr-Digest` still rides along.

Expect this to differ from a static file server you proxy (nginx answers such a request `206`), and expect a client that probes size with `HEAD` + `Range` to read the total rather than a slice. Neither is a bug on this side: `Accept-Ranges: bytes` is on the response, and the following GET gets its `206`. A store with `supportsRange: false` and `createSignedUrl` answers a plain GET with an immediate 302 (no origin round-trip), while HEAD and conditional requests are answered at the origin (real headers, 304, 412) and only a would-be-200 conditional GET redirects; without `createSignedUrl` it serves the FULL representation with `Accept-Ranges: none` (Range and If-Range read as absent; conditionals still work).

**Option precedence** (the order the handler consults its routing options; each row only runs when no earlier row answered):

| Order | Gate | Outcome |
|---|---|---|
| 1 | method is not GET/HEAD | `204` (OPTIONS) or `405` |
| 2 | `supportsRange: false` + `createSignedUrl`, plain GET | immediate 302 (a declined signature continues with the rows below) |
| 3 | `preferSignedUrl` predicate (GET only) | 302 (a declined signature continues with the rows below) |
| 4 | `precompressed` negotiation (compressible MIME, not multi-range) | variant selected for all later steps |
| 5 | plain-range fast path (`authoritativeRange`, identity, no conditionals) | single-round-trip 206 |
| 6 | HEAD-resolved evaluation | 304 / 412 / 416 / multipart / 206 / 200, with the rangeless-offload 302 replacing a would-be-200 body from row 2's store |
| 7 | plain GET, nothing above applied | full 200 stream |

`ServeContext`: `key` (required), `mime?` (the response `Content-Type`; **when omitted it is `application/octet-stream`**, which no browser renders inline, so a PDF or video downloads instead of playing even under `disposition: "inline"`. Derive it from the key with `lookupMime` from `partial-content/mime`, or pass the type you stored at upload), `filename?`, `cacheControl?` (per-request override of the handler-level value, e.g. `immutable` for content-addressed keys next to `private, no-cache` user uploads from the same handler), `auditKey?` (opaque identifier reported as `key` in every `onServe`/`onTransfer`/`onError` event; storage keys commonly embed filenames, which are personal data that logging controls such as ISO 27001 A.8.15 keep out of log records -- pass a document id or hash here and the audit trail stays correlatable without the filename). With it set, `onError` receives a `ProjectedError` instead of the raw error: only `name`, `code`, `status`, `operation` and the `cause` chain projected the same way, because the message, the stack and every other property can carry the key in some spelling. Branch on those fields, not on the message or `instanceof`. `ProjectedError` is exported from `partial-content/web`. Without an `auditKey` events carry the storage key and errors arrive unchanged. A precompressed variant's events report the identity key with `variantKey` and `contentEncoding` (`variantKey` is withheld under an `auditKey`), and `onServe` and `onTransfer` carry `storedContentType` when the store reports `ObjectMetadata.contentType`.

`cacheControl` is emitted verbatim on 200/206/304, so any directive vocabulary your CDN or edge understands passes straight through: RFC 9111 `s-maxage` / `must-revalidate` / `proxy-revalidate` and the RFC 5861 resilience directives `stale-while-revalidate` and `stale-if-error`. The library does not synthesize or reorder directives (only appending `immutable` when the `immutable` option is set and it is not already present), so you keep full control of the response caching policy. `Vary` (e.g. `Vary: Accept-Encoding`) rides `securityHeaders` and is forwarded onto 304 responses too, satisfying the RFC 9110 15.4.5 MUST-generate list.

**Cross-origin consumers**: `Content-Range`, `ETag`, `Accept-Ranges`, `Content-Encoding`, and the digest fields are not CORS-safelisted; list them in `Access-Control-Expose-Headers` or cross-origin readers (pdf.js range loading in particular) silently degrade to full downloads. **Behind a CDN**: only CloudFront forwards client ranges to the origin; Cloudflare/Fastly/Bunny fetch-and-slice, `.zst` variants are unreachable through Cloudflare/CloudFront default encoding normalization, and edge 206s require the origin response to carry `Content-Length` (never chunked). Full details and configuration pointers in `docs/DESIGN.md` "Behind a CDN".

## Node Adapter (`partial-content/node`)

**`serveObject<Req>(store, options)`** - Create a Node.js `(req, res) => Promise<void>` handler for Express, Fastify (compat), Koa, and raw `http.createServer`. Extends the web adapter options with `key` (required, extracts the storage key from the request), `mime?`, `filename?`, and `auditKey?` (see `ServeContext.auditKey`). `Req` defaults to `IncomingMessage`; pass your framework's request type (`serveObject<express.Request>(store, { key: (req) => req.params.key })`) so framework fields typecheck in the extractors. A throwing extractor becomes a hardened 500 and is reported to `onError` with `operation: "context"`.

`partial-content/node` re-exports `ServeObjectOptions`, `ServeContext` and `ObjectStore` alongside the `ObjectNotFoundError`, `ObjectChangedError` and `StoreUnavailableError` classes, so an adapter-only consumer types its handler and matches store errors from one import. `partial-content/hono` re-exports the same three types.

**Server timeouts (deployment note)** - Node's `http.Server` defaults (`requestTimeout` 300s, `headersTimeout` 60s) force-close any transfer that outlives them, independent of this adapter's stall detection: a large download over a slow link dies mid-stream at 5 minutes. Raise them on the server you `listen()` with (`server.requestTimeout = 0` or a generous ceiling) when serving large files.

**`writeStallTimeoutMs?`** (default `60000`) - Bounds how long the streaming pump waits for a single backpressure `drain` before treating the client as stalled and tearing the transfer down (cancel the storage read, destroy the response). A client that stops reading but holds its socket open would otherwise pin a backend storage connection indefinitely (a slow-read attack). Set to `0` to disable and rely on an upstream proxy / socket timeout instead. Only the raw-Node pump needs this; Fetch-runtime backpressure is the platform's own concern.

### Running Fetch handlers on Node (the upload dialects)

The upload dialects (`partial-content/tus`, `partial-content/upload`) are Fetch handlers. Three exports run them, or any other Fetch handler, on `http.createServer`, Express and the like. Example: `docs/EXAMPLES.md`, "Resumable uploads: a tus 1.0 endpoint".

**`toWebRequest(req, options?)`** - Build a Fetch `Request` from an `IncomingMessage`. The body streams with socket backpressure and is attached only when the request frames one (`Content-Length` or `Transfer-Encoding`) on a method Fetch permits a body for. `Content-Length` is forwarded when the client sent one and absent when it did not, so a chunked PATCH reports no length rather than a fabricated one. Connection-management fields (RFC 9110 Section 7.6.1, plus whatever the request's `Connection` header nominates) are dropped. `request.signal` aborts when the client disconnects before completing the request, never on an ordinary completed one. The body is single-use, as Fetch requires; the bridge does not buffer it to allow a second read. Throws `TypeError` when no absolute URL can be derived, and for a request target the URL parser would rewrite, because the path a handler routes on must be the path the client sent: a leading `//`, a dot segment (`.` or `..`, including `%2e`), a backslash, and an absolute-form target whose path is one of those. Options:

- `origin?` - The scheme and authority of `request.url`. Without it the authority comes from the client's `Host` header, so anything derived from `request.url` (a tus `Location`, an origin check) is client-controlled. Only the path and query of the request target are taken, including from an absolute-form target.
- `readStallTimeoutMs?` (default `60000`) - How long a read of the body may wait for the next chunk before the request is destroyed. Armed only while a read is outstanding, so it measures the sender and never bounds a slow but progressing upload or a slow store. Needed because a `Request` body is read outside `server.requestTimeout`. `0` disables it.
- `signal?` - An extra abort source (a graceful-shutdown signal) folded into `request.signal` until the request message ends.
- `onExpectContinue?` - Called once, the first time the body is read, when the request carries `Expect: 100-continue` (RFC 9110 Section 10.1.1). The bridge never writes an interim response itself: on the `request` event Node has already sent `100 Continue`, and on `checkContinue` whether the body is worth receiving is the handler's authorization decision. A `checkContinue` consumer that approved the request passes `() => res.writeContinue()`.

**`sendResponse(res, response, options?)`** - Write a Fetch `Response` to a `ServerResponse`. Stream bodies stream with backpressure and the `writeStallTimeoutMs` bound described above; repeated `Set-Cookie` fields stay separate. Never rejects: a failure after the headers are written destroys the socket, the only signal left at that point.

**`nodeHandler(handler, options?)`** - `(req, res) => Promise<void>` over the two primitives, for a Fetch handler that owns a whole route. Takes every `toWebRequest` and `sendResponse` option plus `answerExpectContinue?` (default `false`; turn it on only for a handler wired to `checkContinue`) and `onError?`, which receives the cause of a 400 (no derivable URL, or a target the parser would rewrite) or a 500 (the handler threw or returned something other than a `Response`). Never rejects. Compose the primitives directly when the route needs routing or a session check between them, which an upload endpoint usually does.

## Storage Contract

**`ObjectStore`** (interface) - Read-only storage backend abstraction. Implementations provide `headObject(key, opts?)` for metadata and `getObject(key, opts?)` for streaming, where `opts` carries `range`, `signal`, `ifMatch` (pinned reads), and `pin` (an opaque token issued by `headObject` for stores whose version identifier is not the ETag; GCS uses it to stream a pinned generation without re-fetching metadata). Optional `createSignedUrl(key, opts)` for backends that cannot stream ranges through the origin, or where a caller wants bulk egress off the origin (`preferSignedUrl`). Optional `authoritativeRange: true` declares that ranged responses report the backend's ACTUAL served bounds (parsed Content-Range) -- the web adapter then serves plain range requests in a single round-trip with no validating HEAD (S3, Azure, R2, http, fs, and memory set it; video seeking and PDF.js chunking hit this path constantly).

**`createSignedUrl(key, { expiresInSeconds, downloadFilename?, cacheControl?, signal? })`** -> `Promise<{ ok: true; url: string } | { ok: false; error: string; code?: "no-credential" | "unsupported"; cause?: unknown }>`. It returns an outcome where every other method on the interface throws, and the asymmetry is the point: DECLINING and FAILING are different answers a caller acts on differently. `{ ok: false }` says this store cannot sign (no credential configured, a backend without the capability), and the serving path falls back to streaming the bytes itself, which is a correct response and not an error and is not reported. `code` says why in a form a caller can branch on (`"no-credential"`: no signing credential is configured; `"unsupported"`: the backend or this store cannot sign) and may gain a member, so give a `switch` over it a default branch; `cause` carries the underlying error for the store's own diagnostics. `signal` is the request's abort signal, for a signer that makes a network call. A THROWN error says signing was supposed to work and did not, which is reported to `onError` with operation `"sign"` and answered `502`, or `499` when the request had aborted. The built-ins decline as follows: `s3Store` with `unsupported` only when the presigner package cannot be loaded, `azureStore` without a shared-key credential and `gcsStore` without a `client_email` with `no-credential`, and `r2Store` and `httpStore` do not sign. Collapsing the two would turn "no signing configured" into a 502 on every request. Pass `cacheControl` for a private object: without it the redirect target serves whatever Cache-Control was baked in at upload, which a CDN in front of the bucket will honor.

**`ObjectMetadata`** (type) - HEAD response shape: `contentLength`, `etag?`, `lastModified?`, `digest?`, `pin?`, `contentType?`. `contentType` is the media type the backend stored with the object and is informational only: it is never sent as `Content-Type` (a stored type is usually whatever the uploader claimed), and reaches `onServe` and `onTransfer` as `storedContentType`. A custom store may return further fields; only `etag`, `contentLength` and `lastModified` feed the derived ETag.

**`OPEN_ENDED` / `isOpenEndedRange(range)`** - The sentinel `ParsedRange.end` meaning "to the end of the object", used by the single-round-trip fast path where the total size is not yet known. Custom store authors MUST branch on it (`isOpenEndedRange(range)`) and emit their backend's idiomatic open form (`bytes=start-`, an offset-only read) -- never the sentinel as a literal last-byte-pos. The header builders throw if it ever reaches serialization.

**`ObjectNotFoundError` / `ObjectChangedError`** (classes) - Thrown by adapters for a missing object (mapped to 404) and a pinned read whose object changed since validation (mapped to one re-validation, then 502). Matched by `name`, so a custom store can throw equivalently-named errors without importing the classes. The message names the failure, never the key: a key is commonly a user's filename and a message is free text a log prints whole, so the key rides on the `key` field (as it does on `StoreUnavailableError`), where it can be dropped, hashed or redacted by name. A custom store's own errors should follow the same rule.

**`isObjectNotFoundError(err)` / `isObjectChangedError(err)` / `isStoreUnavailableError(err)`** - The name-based matchers for the three read-side store errors, from the package root, mirroring the write side's `isUploadNotFoundError` and its siblings. Each is a type guard narrowing `unknown` to its class. Use them rather than `instanceof`, which is unreliable across package boundaries: a consumer with two copies of this package in its tree, or a store built against a different install, throws an error that is structurally right and fails the check, while the `name` is stable identity. It is also what lets a custom store throw an equivalently-named error of its own and be recognized.

**`ObjectStream`** (type) - GET response shape: `body` (a `ReadableStream`, or a plain `Uint8Array` when the adapter already holds the exact bytes -- consumers then skip stream machinery entirely), `contentLength`, `totalSize`, `range?` (the `{ start, end }` the backend ACTUALLY served; absent = full content), `etag?`, `lastModified?`, `digest?`.

**`toObjectBody(source)`** / **`ObjectBody`** / **`ObjectBodySource`** (types) - `ObjectStream.body` is typed `ObjectBody`, the `ArrayBuffer`-backed form (`ReadableStream<Uint8Array<ArrayBuffer>> | Uint8Array<ArrayBuffer>`) a consumer can hand straight to `new Response(...)` under `lib: ["DOM"]`. A custom store holding a wider value, any `ObjectBodySource` (`ReadableStream<Uint8Array> | Uint8Array`, which covers a `Buffer` typed over `ArrayBufferLike` and an SDK stream with bare `Uint8Array` chunks), passes it through `toObjectBody` rather than casting. A `SharedArrayBuffer`-backed view is copied into its own `ArrayBuffer`, because that view is the one input `new Response(...)` rejects; an `ArrayBuffer`-backed view and a stream pass through unchanged.

**`classifyStoreRead(key, op, classifiers)`** - The ordered error-classification pipeline the built-in SDK adapters share, exported for custom adapter authors. Runs `op()` and maps its failure to the contract's error types in a fixed precedence: `notFound` -> `ObjectNotFoundError` (404), `changed` -> `ObjectChangedError` (412), `throttled` -> `StoreUnavailableError` (503), otherwise rethrow untouched. Supply one `StoreErrorClassifiers` set and reuse it for both `headObject` and `getObject` so the two paths cannot drift; predicates must be mutually exclusive on a given backend.

**`reservedKeyGuard(prefix)`** -> `(key: string) => void`. Build the refusal a built-in read store applies to its `reservedPrefix`: throws `ObjectNotFoundError` for a key equal to the prefix or under it, and is a no-op for `""`. `prefix` may be a list, refusing each; empty entries are skipped. Call it at the top of a custom `ObjectStore`'s `headObject`, `getObject`, and `createSignedUrl` when the store shares a location with an upload store, so the upload bookkeeping is not reachable through the read path.

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

Both dialect subpaths re-export the whole shared surface, so custom stores and custom dialects import everything from `partial-content/tus` or `partial-content/upload`: `createUploadOrchestrator` (+ its option/outcome types), the `ResumableWriteStore` contract types, `UploadPolicy`, `memoryUploadLocker` / the `UploadLocker` interface, and the error classes with their name-based matchers (`isUploadNotFoundError`, `isUploadOffsetConflictError`, `isUploadDestinationConflictError`, `isUploadAppendBoundError`, `isUploadOverrunError`, `isUploadDigestMismatchError`, `isUploadDigestUnverifiableError`, `isUploadLockTimeoutError`, each a type guard narrowing `unknown` to its class by `name`), the lock reasons `UPLOAD_PREEMPTED` and `UPLOAD_LEASE_LOST`, plus `FatalBoundReason` (`"length" | "size"`, which representation bound a fatal append crossed).

### tus dialect (`partial-content/tus`)

**`createTusHandler(store, options)`** - A tus 1.0 endpoint: core protocol plus the creation, creation-with-upload, creation-defer-length, termination, expiration, and (when `checksum` is configured) checksum extensions (advertised on OPTIONS via `Tus-Extension`). Method surface: `POST` creates (optionally carrying first bytes under `Content-Type: application/offset+octet-stream`), `HEAD` probes the offset, `PATCH` appends, `DELETE` terminates, `OPTIONS` discovers capabilities; `X-HTTP-Method-Override` tunnels PATCH/DELETE through POST for environments that cannot send them. `DELETE` terminates the upload and never an object it already published, so a client that deletes an upload resource after completion frees bookkeeping without destroying its own file. Every non-OPTIONS request is version-gated on `Tus-Resumable: 1.0.0` (412 otherwise). tus completion is implicit (an upload is complete when its offset reaches its length), and the handler publishes the assembled object the moment that happens, including when the final bytes arrived from a connection that died mid-request.

Options:

- **`key(creation)`** (required) - Decide the final storage key for a new upload from `{ metadata, request, declaredLength?, policy }` (the base64-decoded `Upload-Metadata` pairs, commonly `filename`/`filetype`, the raw `Request`, the declared `Upload-Length` when there is one, and the effective policy the creation was accepted under). The server decides the key; never derive it from the client filename verbatim (a caller-controlled key is a path/overwrite primitive). It is called only once the policy accepts the creation and before anything is allocated, so a refused creation spends none of your allocation, and it may be async. It answers a string; `{ key, metadata? }`, where `metadata` is recorded on the resource and handed to `onUploadComplete` INSTEAD of the client's, so the server decides what is kept; or a `Response`, sent as-is, that refuses the creation (an exhausted quota, a failed authorization). Nothing is allocated before it answers.
- **`authorize(ctx)`** - Per-upload authorization for the requests that follow a creation (probe, append, cancel). Called under the upload's lock, with `{ request, uploadToken, operation, key, metadata }` (the key and metadata the creation recorded), before anything is read back to the client or written. Return a `Response` to refuse with it, `undefined` to proceed; a throw is a server error, never a pass. A creation is authorized by `key()`. Both dialects take the same shape.
- **`location(uploadToken)`** (required) - Build the `Location` header value for a created upload resource (absolute or path-relative URL). It is also called for a creation REJECTED after the resource was allocated: a creation-with-upload whose body is refused mid-stream has already made a prefix durable, and the `Location` is the only way the client can resume or `DELETE` those bytes. Without it they are unreachable and only a sweep reclaims them, which is optional and does nothing at all with no `maxAgeSeconds`. The value is header-sanitized on both paths.
- **`resolveToken(req)`** - Extract the upload token from a resource request when the caller does not pass `ctx.uploadToken` (e.g. parse the URL path). `undefined` means "no token here" and the request is answered 404.
- **`auditKey({ request, uploadToken })`** - Audit-safe identifier (`string | undefined`) reported INSTEAD of the raw token on upload events and in the `onError` context (supply one and `uploadToken` is not reported at all), called per resource request (HEAD/PATCH/DELETE). On a creation it is asked first without a token, for a creation refused before a resource exists, and again with the token the store minted, before any event or error names the new resource. The token is the capability: possession of it authorizes appending, probing and cancelling, since nothing re-authenticates the follow-up requests, and `onUploadEvent` is the most log-adjacent surface in the package. The IETF handler takes the same shape.
- **`policy`** (required, and so is its `maxSize`) - The size, append and lifetime bounds this endpoint enforces, as a `UploadPolicy` (see below), or a function `(request) => policy | Promise<policy>` that resolves it per request (a tenant's quota, a plan's ceiling). `maxSize: Infinity` states that the endpoint has no size ceiling; an omission is a `TypeError` at construction. Each request is judged under, and advertises (`Tus-Max-Size`, `Upload-Expires`, the checksum buffer bound), the policy it resolves; the resolved policy is validated like a static one, and an invalid answer fails that request with `500` and a `TypeError` to `onError`. The lifetime is the exception: the policy that creates an upload fixes its deadline, which the store records, so a later request's max age does not move it. `minAppendSize` is refused here at construction (`TypeError`): the floor's only exemption is an append that completes the upload, tus infers completion from a known total length, and an upload created under `Upload-Defer-Length` has none, so the floor would leave every such upload permanently unable to progress with no header to tell its client what it is missing. The IETF dialect advertises the floor in `Upload-Limit` and lets a request assert its own completion, so a floor belongs on `createUploadHandler`.
- **`metadataLimits`** (`{ maxBytes?, maxPairs? }`, defaults `4096` and `32`) - Bounds on a creation's `Upload-Metadata` header, which tus 1.0 leaves unbounded although every pair is decoded and handed to `key()` and the store. A header past either answers `400`. Each must be a positive integer. The parsed metadata has a null prototype, so a pair named `__proto__` or `constructor` is an ordinary entry; read it with `Object.hasOwn`.
- **`checksum`** - Enable the tus checksum extension (`Upload-Checksum: <algorithm> <base64>` verified per request). `webCryptoChecksum()` is the ready-made config: `sha1` (the spec's server-MUST) plus SHA-2 over `crypto.subtle`, available on every supported runtime; inject a custom `TusChecksumOptions` (`algorithms` + one-shot `digest(algorithm, content)`) for `md5` and friends. The algorithm list must include `sha1` (matched without case) and hold distinct header tokens ignoring case, or construction throws a `TypeError`; request tokens are matched without case, and the configured spelling is what `digest` receives. A checksummed `PATCH` first confirms the token resolves (one lock-free, non-preempting state read), because verification buffers and hashes the whole request and a token that names nothing must not buy that work. A checksummed request is then BUFFERED, verified, and only then appended, because discard-on-mismatch is only honest when unverified bytes never become durable; the buffer is hard-capped by `checksum.maxBufferBytes` (default: the effective `maxAppendSize`; a `TypeError` when neither bounds it, at construction for a static policy and as a failed request for a resolved one). Mismatch answers `460 Checksum Mismatch` with durable state untouched; an unadvertised algorithm or malformed header answers 400; content over the cap answers 413 before hashing. Unconfigured, the extension is not advertised and an unsolicited `Upload-Checksum` is ignored (an assertion nothing can verify is dropped, mirroring the completion-digest posture).
- **`locker`** - Lock provider (see Locking below). Default: in-process cooperative-preemption locker.
- **`onUploadEvent(event)`** - Structured, content-free audit events (see Upload audit events below).
- **`onError(error, { uploadToken?, auditKey?, operation })`** - Error sink for storage failures, throwing hooks, and dialect-level failures (a throwing `key`/`location`/`resolveToken` callback reports with operation `"handler"`). A resource that is simply absent is not reported, but damaged bookkeeping is: the client still receives not-found, and the sink receives the `UploadNotFoundError` with a `cause` named `UploadStateCorruptError`. Must not throw. Supply an `auditKey` and `error` arrives as a `ProjectedError` (`name`, `code?`, `status?`, `operation?`, `cause?`) with the message, the stack and every other property left behind, since any of them can carry the token or the key; branch on those fields.
- **`graceMs`** (default `10000`) - Post-abort flush window in milliseconds: how long store writes keep running after the client vanished so received bytes become durable. `0` disables it. An integer from 0 to 2147483647; anything else is a `TypeError` at construction. `lockTimeoutMs` is validated the same way (1 to 2147483647).
- **`now`** - Clock injection (tests); also anchors `Upload-Expires`.
- **`extraHeaders`** - Extra headers on EVERY response (CORS exposure, tracing). Protocol headers win on collision.

Status mapping: `409` offset mismatch (recover via HEAD re-probe; tus defines no offset header on the 409), `410` expired/invalidated, `404` unknown resource or missing token, `413` size violations (with `Tus-Max-Size` when configured), including a body that crossed the policy `maxSize`, `400` other policy floors and length conflicts, including a body that crossed the length the client itself declared and a body sent to an upload that is already complete, `423` contended (kept distinct from 409 so retry-later never looks like re-probe-now), `409` destination conflict (a completion found the key changed under its sealed plan and published nothing; unlike an offset mismatch, a HEAD re-probe does not resolve it), `415` PATCH without `application/offset+octet-stream`, `502` storage failure (details only to `onError`), `460 Checksum Mismatch` when a configured checksum fails to verify. Not implemented: the concatenation extension, and the checksum-trailer variant (Fetch exposes no portable Request trailer API).

**`parseUploadMetadata(header)`** - Parse an `Upload-Metadata` header (creation extension) into decoded key/value pairs. Strict: standard base64 with canonical padding, printable-ASCII keys, unique keys, UTF-8 values; returns `null` for malformed input or a header past `limits` (`TusMetadataLimits`, defaults 4096 bytes and 32 pairs; the handler answers 400), and an empty null-prototype object for an absent header.

### IETF draft dialect (`partial-content/upload`)

**`createUploadHandler(store, options)`** - An endpoint speaking the IETF resumable-uploads draft (`draft-ietf-httpbis-resumable-upload`) over Fetch primitives. It serves the draft revisions clients implement, identified by `Upload-Draft-Interop-Version`: **3** (draft-01), **5** (draft-03), **6** (draft-04/-05), **9** (draft-12), and **10** (draft-13 and -14). A missing or unlisted version is answered 400 with the supported set named (the draft forbids cross-version interop, so nothing falls through), and every response that participates in the protocol echoes the version it was answered in.

The per-version wire differences are handled internally, most importantly the completeness header flip: interop 3 sends `Upload-Incomplete` (`?1` = not complete), 5, 6 and 9 send `Upload-Complete` (`?1` = complete). Interop 6 adds the `application/partial-upload` media-type requirement on appends, RFC 9457 problem details on offset mismatches, and `Upload-Length` on probes. Interop 9 and 10 add three more, and 10 differs from 9 in one answer, stated after the list:

- **`Upload-Limit`** (RFC 8941 Dictionary) on a creation that leaves the upload incomplete (the `201`), on a successful offset retrieval (the `204` answering a `HEAD`, or a `GET`), and on a rejection a limit caused (the `413` for `size-exceeded` / `append-too-large`, the `400` for the floors), so a client that has just been refused has a number to aim its retry at instead of guessing a smaller chunk. Members are serialized from the effective `UploadPolicy`: `max-size`, `min-size`, `max-append-size`, `min-append-size`, `max-age`. An absent member states no limit of that kind; `min-size` is always present, defaulting to `0`, because an empty structured-field value is not a valid dictionary and a server applying no limits still has to say so. `max-age` is the whole seconds left until the resource's deadline (its creation instant plus `maxAgeSeconds`), rounded down, on every answer about a resource, a limit rejection included; only a creation refused before a resource exists states the configured `maxAgeSeconds`.
- **`GET` probes the offset** beside `HEAD`. On 3, 5 and 6 a `GET` to an upload resource is `405` with `Allow: HEAD, PATCH, DELETE, OPTIONS`; on 9 and 10 the `Allow` on a `405` reads `GET, HEAD, PATCH, DELETE, OPTIONS`. (`OPTIONS` is version-agnostic, is not gated on an interop version, and always answers `Allow: POST, HEAD, PATCH, DELETE, OPTIONS` with the `Upload-Limit` of the configured policy, `max-age` the configured `maxAgeSeconds`.)
- **An append to an already-complete upload replays the completion answer** (`200`, `Upload-Complete: ?1`, `Upload-Offset`) instead of refusing it `400`, for the requests that qualify. See the version-specific status note below, because this one differs between versions by design.

**Interop 10 answers a creation or append the server interrupted `409`.** A `2xx` there means the whole request content was processed (draft-13). When a later request preempts a creation or append (or the grace window ends it) after some of its bytes became durable, interop 9 and the older revisions answer `201` or `204` with the durable offset in `Upload-Offset`, and interop 10 answers `409` with that offset, so the client re-anchors as it does for any offset mismatch; a creation keeps its `Location`, the only way back to that prefix. On every version, a request asserting completion whose body ended cleanly short of the declared length answers `400` (`inconsistent-upload-length` on 9 and 10) carrying the durable `Upload-Offset` and an incomplete upload, so the client resumes without a probe.

**A CONTENT-FREE append to an upload that is already complete is answered `400` on interop 3, 5 and 6, and `200` on interop 9 and 10.** The engine reaches that case only when the claimed offset IS the durable offset and the request carries no content, so the request is a retry of a completion whose response the client never received. An append that carries content there is refused `400` at every version, with the registered `inconsistent-upload-length` problem type on interop 9 and 10: the total is fixed at completion and the offset may never exceed it, so the content has nowhere to go, and answering it with the completion would report success for bytes no store ever received. That holds for a request with no `Content-Length` too: the orchestrator reads such a body as far as its first byte, and a byte means the refusal, none the replay. Which answer is correct is the version's decision and not a preference: draft-05 Section 4.4.2 has the server "MUST NOT modify the upload resource and MUST respond with a 400 (Bad Request) status code", so a client written against those revisions uses the 400 to learn its upload finished, and replaying a success there would deny it that signal. draft-12 Section 4.4.2 revises it, saying the server "can choose to replay the final response to the client if the request to append to the completed upload is valid". A client that wants the retry to succeed asks for interop 9 or 10.

`Repr-Digest` verification (RFC 9530) is offered on **every** version this endpoint serves, interops 9 and 10 included, whose draft revisions carry no upload-digest text of their own. RFC 9530 defines the field independently of any upload protocol, and honoring an assertion the client volunteered cannot break a client that sends none: absent means unverified. Restricting it to the older versions would remove an integrity guarantee from the consumers most likely to want one, in exchange for nothing a client can observe. The field is advisory in RFC 9530's reading, and the endpoint treats it so by default: an assertion in an algorithm the store verifies (`orchestrator.verifiedDigests`) is compared against the assembled bytes before publication, and an assertion in an algorithm it does not is ignored, not rejected and not compared. On the S3, R2, GCS and Azure stores nothing is verified, so a `Repr-Digest` sent to them is dropped and the upload completes; only the filesystem and memory stores compare. A `Repr-Digest` member whose value is not the length its algorithm produces is dropped as well. Check the store's `digestOnComplete` (the orchestrator's `verifiedDigests`) before telling a client its upload was integrity-checked. The `digestPolicy` option refuses a digest the store cannot verify instead of ignoring it.

Requests without an upload token (none in `ctx.uploadToken`, none from `resolveToken`) are creations; requests with one target the resource: `HEAD` probes, `PATCH` appends, `DELETE` cancels. `resolveToken` is consulted on EVERY request here, unlike the tus dialect where only `HEAD`/`PATCH`/`DELETE` consult it, so it has to be right in both directions: with no `resolveToken` and no `ctx.uploadToken`, a probe or append is routed into creation and answered 400 while its bytes orphan, and a `resolveToken` that returns a token for the creation URL itself makes the creation a 405. Match the resource path specifically, or pass `ctx.uploadToken` from your router's path parameter. A creation or append may assert a whole-representation SHA-256 via `Repr-Digest` (RFC 9530); it is verified at completion when the store verifies that algorithm (`digestOnComplete` lists `"sha-256"`, `"sha-512"`, or both), and ignored when it does not, as described above. A mismatch in any verified algorithm refuses the completion with `UploadDigestMismatchError` before anything is published. The offset-mismatch 409 carries the CORRECT offset and reports the upload as incomplete, as the draft requires, so clients re-anchor without a probe round trip.

Options: `key(creation)` (from `{ request, interopVersion, declaredLength, complete, policy }`; async, may answer `{ key, metadata? }` or a `Response` that refuses the creation, called once the policy accepts and before anything is allocated, exactly as in the tus dialect), `authorize`, `location(uploadToken)`, `resolveToken(req)`, `auditKey({ request, uploadToken })`, `policy` (required with its `maxSize`; a static policy or a per-request resolver), `locker`, `onUploadEvent`, `onError` (a dialect-level failure reports with operation `"handler"`, as in the tus dialect), `graceMs`, `now` (all as in the tus dialect), plus:

- **`interopVersions`** (default `[3, 5, 6, 9, 10]`) - Versions to serve; construction throws `TypeError` for a version with no wire mapping, and for an empty list (misconfiguration is loud, requests never throw). Narrow it to pin an endpoint to one revision's behavior, for instance `[10]` when every client is current and you want the completion replay unconditionally.
- **`onResumptionSupported(info)`** - Fires as soon as a creation has allocated its upload resource, before the creation content is read, carrying what a `104 (Upload Resumption Supported)` interim response would: `{ uploadToken, location, interopVersion, headers }`, where `headers` is that interim response's field set, ready to send (the interop version echo, `Location`, and `Upload-Limit` where the version announces limits). A Fetch `Response` cannot carry interim responses, so the handler itself never emits 104; a transport that can write interim responses wires this hook to send it, and a client handed the location early can resume while the creation body is still arriving. It fires also for a creation that fails after allocating. Guarded: a throwing hook is routed to `onError` with operation `resumption-hook`.

Requests without an upload token are creations only for `POST`, `PUT` and `PATCH` (draft Section 4.2.1); any other method without a token answers `405` with `Allow: POST, PUT, PATCH, OPTIONS`, so a tokenless `DELETE` or `GET` that carries `Upload-Complete: ?1` cannot create and publish an object.

### The orchestrator (`createUploadOrchestrator`)

`createUploadOrchestrator(store, options?)` is what both dialects are built on, and it is exported from both dialect subpaths for anyone writing a third wire dialect or driving uploads from something that is not HTTP. It owns locking, fresh-state sequencing, the post-abort grace window, and the effective policy (`orchestrator.policy`, with the store's own `maxAppendSize` folded in), and it exposes `create`, `probe`, `resourceExists`, `admit`, `append` and `cancel`, each answering a wire-agnostic `UploadOutcome`. It throws a `TypeError` at construction for a store reporting `atomicCompletion: false` or `enforcesOffsetCheck: false`, and for a policy bound that is not a non-negative safe integer or whose floor exceeds its ceiling (`minSize` over `maxSize`, `minAppendSize` over `maxAppendSize`).

`policy`, `locker`, `onUploadEvent`, `onError` (whose context here also declares `auditKey?`), `graceMs` and `now` mean what they do on the dialect factories, which pass them straight through. Three options exist only here, so reaching them means constructing the orchestrator yourself rather than calling `createTusHandler` / `createUploadHandler`:

- **`onUploadComplete(info)`** - Fires on publication with `{ uploadToken, auditKey?, key, length, metadata?, etag?, digest? }`. **Delivered at-least-once; make it idempotent on `uploadToken`.** This is the one hook that carries the storage **key**, deliberately kept out of `onUploadEvent`, which is content-free by design while a key commonly embeds a filename. It is where a consumer records "this upload became that object", which is otherwise not learnable: the key is chosen by the `key()` callback before a token exists, and correlating that callback's return with the token by position across the creation call is a race rather than an answer. It is **awaited before the response goes out**, so a hook that throws fails the request instead of acknowledging an object the consumer's own records never saw: the throw becomes a `store-error` outcome, reported to `onError` with `operation: "complete"` and answered `500` by the IETF dialect and `502` by tus. Return a promise and the client is told the upload landed only after your write did. That await is only worth something if a failed delivery gets another attempt, and the only retry a resumable protocol has is the client repeating its completing request; that repeat is answered idempotently and re-delivers here rather than short-circuiting, so an upload whose first delivery threw is recorded on the retry instead of being lost. A re-delivery reports what durable state knows and omits `etag` and `digest`; the token is unchanged, which is why it is the key to dedupe on.
- **`redactErrors`** (default `false`) - Every error reaching `onError`, and the error carried by a `store-error` outcome, arrives as a `ProjectedError` and no context carries the token, whether or not an audit key was derived for that call. Set it whenever you supply audit keys, so that a derivation that throws or answers `undefined` cannot hand the raw error to the sink. The dialects set it from their `auditKey` option.
- **`lockTimeoutMs`** - How long a request waits for the upload lock before the dialect answers `423`. The orchestrator is the only caller of `UploadLocker.acquire`, so this is the knob for it whichever locker is installed; a locker keeps its own default for callers outside the orchestrator (`memoryUploadLocker({ acquireTimeoutMs })`, `redisUploadLocker(client, { acquireTimeoutMs })`, both 15 s). `graceMs` and `lockTimeoutMs` are validated at construction: `graceMs` is an integer from 0 to 2147483647 and `lockTimeoutMs` from 1 to 2147483647, a `TypeError` otherwise.

Per-request inputs on the orchestrator's calls:

- **`key`** (on `create`) is a thunk, `() => UploadKeyResult | Promise<UploadKeyResult>`, called after the policy accepts and before anything is allocated. A `Response` answer produces the outcome `{ kind: "refused", response }`, which a dialect sends as-is; so does an `authorize` answer on `probe`, `append` and `cancel` (the `authorize` option there is bound to its request and called under the lock with `{ key, metadata }`).
- **`admitBody(body)`** (on `create`) admits a creation's body after the policy accepts and `key` resolves, and before anything is allocated. It returns the body to store or a `Response`, which produces `{ kind: "refused", response }`. tus verifies an `Upload-Checksum` on creation-with-upload here, so a creation that the policy or `key` refuses never costs a buffered and hashed body.
- **`onAllocated(uploadToken)`** (on `create`) runs once the resource exists (token minted, audit key resolved) and before the body is read, under the resource lock, so a client handed the location here and resuming at once waits for this creation's write instead of racing it. A throw is reported to `onError` as `allocated-hook` and the creation proceeds. It runs also for a creation that later fails.
- **`policy`** (on `create`, `append`, `probe`) is the policy that request is judged under, in place of the orchestrator's own, folded and validated like the configured one (a store's `maxAppendSize` still caps it); an invalid policy is a `TypeError`. `orchestrator.effectivePolicy(policy)` returns the folded form a dialect advertises for it. This is what the dialects' policy resolver feeds.
- **`expectedDigests`** (on `create` and `append`) is `{ "sha-256"?: string, "sha-512"?: string }` of raw padded base64. The orchestrator forwards only the algorithms in `orchestrator.verifiedDigests` (the store's `digestOnComplete`, empty when it is `false`) and drops the rest, so under the default `digestPolicy: "advisory"` an assertion the store cannot verify is ignored and never reaches it, and the upload publishes unverified. `policy.digestPolicy: "require-verifiable"` refuses such a request with a `400` before anything is allocated or written, and a mixed assertion keeps its verifiable algorithms and proceeds (see Upload policy).

**Fencing (`claimUpload`, `epoch`).** A store may implement `claimUpload(uploadToken)`, which mints an `UploadClaim` (`{ epoch }`) on the resource. The orchestrator calls it under the lock, and only for a request that is about to write: an append, and a creation that carries a body or completes (the early `Location` of a `104` hands the resource out before the creation returns). It passes the `epoch` to `appendChunk`, `completeUpload` and `abortUpload`, and a store refuses a superseded epoch with `UploadOffsetConflictError`, so a holder whose lock was stolen cannot write over the one that took it even where the backend offers no conditional write. Optional, additive, and the contract version is unchanged; no built-in adapter mints claims, because each already fences with its backend's own conditional write.

**Reusing the state read (`forAppend`, `snapshot`).** The orchestrator reads an upload's state under the lock before every append, passing `getUploadState(token, { forAppend: true })`. A store may answer it with an opaque `snapshot` on the returned state, which the orchestrator hands back unchanged as `AppendChunkOptions.snapshot`, so the append can use that read in place of a second one. A store that relies on it must fail closed when the snapshot is stale, and ignores one it did not mint; a store that does not use it omits the field.

**Reads without a lock (`repair: false`).** `admit()` and `resourceExists()` hold no lock, so they read with `getUploadState(token, { repair: false })`. A store that heals bookkeeping on read (promoting a matched publication record, rewriting a sidecar) must skip that write when it sees the flag and report the state it derived, because an unlocked write can race a completion or a cancel and recreate what it removed. Every locked read omits the flag.

**Releasing the request body (`releaseBody`).** `AppendChunkOptions.releaseBody` cancels the unread request body, even when the store has locked the stream. A store calls `opts.releaseBody?.()` on every early exit, a refusal before it read a byte included. It is idempotent, never rejects, does nothing once the body has been read to its end, and a read after it fails instead of ending clean. The orchestrator calls it once more when `appendChunk` returns or throws, so a body the store never took does not keep the peer sending. The built-in stores release through it on every refusal.

### Upload policy (`UploadPolicy`)

Server policy for one upload surface; every field optional on the type, an absent bound is simply not enforced. The two dialect handlers require `maxSize` (`Infinity` states that there is no ceiling) and throw a `TypeError` at construction without it. The engine enforces these BEFORE any byte reaches a store; the dialects advertise them where their protocol has a vocabulary for it (`Tus-Max-Size`, `Upload-Limit`). Each dialect refuses at construction a bound its wire cannot state: `createUploadHandler` one longer than 15 digits, the most an RFC 8941 integer in `Upload-Limit` holds, and `createTusHandler` a `maxAgeSeconds` whose deadline falls past the year 9999, which an IMF-fixdate `Upload-Expires` cannot name.

| Field | Meaning |
|---|---|
| `maxSize` | Maximum total representation size in bytes. Bounds the REPRESENTATION, so an unknown-size body that runs past it mid-stream is terminal: the store invalidates the resource durably, the answer is `413`, and every later probe or append refuses. A body that runs past the length the client itself declared is terminal the same way and answers `400`, since the fault is against the client's own declaration |
| `minSize` | Minimum total representation size in bytes |
| `maxAppendSize` | Maximum bytes accepted by a single append (a store's own `maxAppendSize` capability is folded in as a further minimum). Bounds the REQUEST, not the representation: a known-size append over it is refused up front with `413`, and an unknown-size (chunked) body that runs past it stops at the bound and answers `413` with the resource intact and the accepted prefix durable, so the client resumes. Only `maxSize` and a declared length are terminal |
| `minAppendSize` | Minimum bytes required per append. Exempt: a creation with no content, and an append that completes the upload (the tail is however small it is). An append that declares no size is refused under the floor, since a bound on what a request delivers can only be checked before its bytes are durable, so the exemption is reachable only on a wire that can express completion. `createTusHandler` refuses this field outright |
| `maxAgeSeconds` | Maximum resource lifetime, from creation. Expired resources refuse probes and appends (tus 410 / IETF 404) and drive `Upload-Expires`. The policy that creates an upload fixes its deadline: the store records it (`CreateUploadOptions.expiresAt`) and every later request judges by that instant, so a request resolving another max age neither shortens nor extends a lifetime already granted. A `DELETE` is still accepted, so a client told its upload is dead can free the partial bytes. A COMPLETED upload does not expire: the clock bounds partial bytes nothing will finish and the right to keep appending, and a finished upload has neither, while its idempotent completion answer is the only recovery a client has for a lost response. Reaping the finished resource's bookkeeping is `sweepExpired`'s job, on its own idleness clock. Invalidation still overrides completion |
| `digestPolicy` | What a request does when its `Repr-Digest` (RFC 9530) asserts only algorithms the store cannot verify. `"advisory"` (the default) ignores the assertion and the upload publishes unverified, which is what `s3`, `r2`, `gcs` and `azure` do, since they complete without a whole-object digest check. `"require-verifiable"` refuses the request with `400` before anything is allocated or written (`UploadDigestUnverifiableError`, outcome kind `digest-unverifiable`, audit reason `digest-unverifiable`). A mixed assertion keeps the verifiable algorithms and proceeds; a request with no assertion is unaffected. It is a field of the policy, so a per-request policy resolver can set it per tenant. `createTusHandler` throws a `TypeError` at construction when it is set, because tus verifies `Upload-Checksum` itself; an unknown value is a `TypeError` |

### Write stores

Every storage backend subpath except `/http` (a generic HTTP origin cannot accept resumable writes) exports a `ResumableWriteStore` factory next to its `ObjectStore`. Point both at the same bucket/root/map and a completed upload becomes servable the moment completion returns. The read store refuses the write store's bookkeeping prefix by default, so that sharing does not also publish in-flight uploads (see `reservedPrefix` above). The `fs`, `s3`, `r2`, `gcs` and `azure` factories return a `PrefixedUploadStore`, a write store with a `readonly uploadPrefix` that is the prefix it actually uses, so `s3Store({ client, bucket, reservedPrefix: uploads.uploadPrefix })` keeps the two in step; both defaults come from one constant.

**`memoryUploadStore({ objects })`** (`partial-content/memory`) - Process-memory write store for consumer test suites and demos; publishes into the same map a `memoryStore` serves.

**`fsUploadStore({ root })`** (`partial-content/fs`) - Local filesystem. In-flight bytes live in a reserved `.uploads/` subtree under `root`, one directory per upload with one file per fact; appends are fsynced before they are acknowledged (the offset a later probe derives from `stat` is crash-durable). Completion seals the upload at the acknowledged length, copies the data to a `staged` file (a copy-on-write clone where the filesystem supports one), verifies any asserted SHA-256 or SHA-512 against that copy, and hard-links it at the key, refusing an existing name, so an object written after the seal is never overwritten. It needs hard links and the workspace and every key on one volume. Replacing an existing object moves it aside and links the new one, so the key is empty for an instant. `root` is resolved to its real path first and the upload only ever publishes inside it: a directory link that leaves the root, and a linked `.uploads`, are refused.

**`s3UploadStore({ client, bucket, minPartSize?, uploadPrefix?, checksums?, sidecarCas?, publishCas?, multipartSweepPrefix? })`** (`partial-content/s3`) - Any S3-compatible backend, built on multipart uploads. Appends buffer to a part size and the sub-part remainder is parked in a tail object (`<token>.part`) and committed as the size-exempt final part at completion. Each upload fixes its part size at creation, in its record: at least `minPartSize` (default 5 MiB, the floor S3 enforces for every non-final part), grown so that a declared length fits S3's 10,000 parts, and every append, in every process, cuts parts at that size. A changed `minPartSize` therefore applies to new uploads only, and an upload without a declared length can only assume `minPartSize`, so it holds at most 10,000 x `minPartSize` bytes (about 48.8 GiB at the default) and an append past that is answered as a non-fatal append bound (`413`, resumable). A declared length above 10,000 x 5 GiB is a `RangeError` at `createUpload`. The offset derives from `ListParts` plus the tail's size, and appends do not rewrite the sidecar: idleness is read from the newest part or tail. An append that does not complete costs `5 + N` requests: three for the orchestrator's state read (the sidecar `GET`, `ListParts` and the tail `GET`), `N` `UploadPart` requests for the parts it cuts, one conditional park of the remainder (empty when nothing is left over, so an append working from a stale state read fails at the park's `If-Match` with `UploadOffsetConflictError` carrying the true offset), and one sidecar `GET` once its bytes are durable, which refuses the append when a completion sealed the upload meanwhile. The store honours the state read it is handed once. `checksums: true` opts into per-part SHA-256 (transport integrity, verified by the backend part by part, restated at completion); it is OFF by default because the parameters are not portable across S3-compatibles, and it never enables whole-object digest verification: multipart SHA-256 is composite (a hash of per-part hashes), so `digestOnComplete` stays `false` either way. `checksums` does not govern what the AWS SDK adds itself: while the client's `requestChecksumCalculation` is `"WHEN_SUPPORTED"`, its default, recent SDK clients send a CRC32 checksum on every upload, and a backend that rejects checksum parameters rejects that one too; construct the client with `requestChecksumCalculation: "WHEN_REQUIRED"` for such a backend, because the store cannot read the setting back from the client. `sidecarCas` (default `true`) writes the metadata sidecar with `If-Match` on the ETag the store holds (`If-None-Match: *` at creation), so a holder whose lock was stolen cannot write a stale record over the new holder's. Before its first conditional write the store checks once, with a canary object under `uploadPrefix` created twice with `If-None-Match: *` and then deleted, that the backend honours the headers: a backend that accepts the second create, or answers `NotImplemented`, fails the operation with an error naming `sidecarCas: false`, and the verdict is kept for the store's lifetime. `false` accepts unconditional sidecar writes protected by the re-read and the monotonic terminal flags alone. The same condition (`If-None-Match: *`) guards the parked remainder: it lands only where no tail exists and carries the offset its bytes belong at, so a holder that lost its lock mid-body cannot place its remainder after the winner's parts, and a tail is counted only at the offset it was accepted for. Completion seals the sidecar at the acknowledged length with the destination's state (its ETag, or empty) before it lists the parts, so every later append is refused, and records the published ETag after the commit. `publishCas` (default `true`) makes the commit conditional on that state: `If-None-Match: *` over an empty key, `If-Match` on the recorded ETag otherwise, and a refusal is `UploadDestinationConflictError` with the object another writer put there left intact. It is probed once per store like `sidecarCas`, with a canary multipart upload under `uploadPrefix`; a backend that ignores the condition fails with an error naming `publishCas: false`, which publishes unconditionally and leaves a write to the key between seal and commit overwritten. Each multipart upload carries a random publication id in its object metadata (`upload-publication`), and a later probe or completion retry attributes the object at the key to this upload only when it carries that id, never by size or part count. `multipartSweepPrefix` (unset by default; `""` for the whole bucket) names the key prefix under which every multipart upload belongs to this store: `sweepExpired` then also aborts the multipart uploads under it that no sidecar names and whose `Initiated` time precedes a cutoff, which is what a creation that failed between `CreateMultipartUpload` and its sidecar write leaves behind. Leave it unset for keys another writer also uploads to in multipart, whose uploads have no sidecar either; a bucket lifecycle rule with `AbortIncompleteMultipartUpload` covers the same orphans on the backend's own schedule.

**`azureUploadStore({ containerClient, uploadPrefix?, blockSize?, discardStaged? })`** (`partial-content/azure`) - Azure Blob Storage via uncommitted blocks staged on the final blob (nothing visible until commit); `Put Block List` publishes atomically. Appends are byte-exact (`blockSize` only bounds adapter memory). A one-byte sentinel block distinguishes a freshly created upload from a missing one. Azure garbage-collects uncommitted blocks after 7 days; `sweepExpired` reaps the small `.info` bookkeeping blobs Azure will not. Block ids carry a segment of the upload id, so two uploads to one key count and commit their own blocks only; still one in-flight upload per key, since a commit or a discard drops every block staged on the blob. Each accepted block is recorded in the info blob under the same conditional write as the rest of the record, the record is re-read before every stage, and a stage that would land on an index another holder of the token already had acknowledged is refused with `UploadOffsetConflictError`; a block list that disagrees with the record inside the accepted prefix invalidates the upload. The record lives in blob metadata, which Azure caps at 8 KiB, so creation measures it with every later field at its widest and refuses a key plus metadata that could cross a 7 KiB ceiling. Completion seals its plan in the info blob first, at `expectedLength`, with a random publication id and the destination's ETag (or its absence); an append that lands after the seal is refused, the block snapshot is taken after the seal and a length mismatch lifts it, and `Put Block List` commits under `If-None-Match: *` or `If-Match` on the recorded ETag, so a blob written at the key in between yields `UploadDestinationConflictError` and is left intact. The published blob carries the id in its metadata, and a completion retry adopts a blob at the key only when that id matches, never by size or block count. Abort and sweep never commit or create a blob at the key by default (`discardStaged: "age-out"`): they remove the bookkeeping and leave staged blocks to Azure's seven-day collection, which also bounds how long those bytes are billed. `discardStaged: "commit-empty"` reclaims them at once by committing an empty block list create-only (`If-None-Match: *`), which the service refuses when a committed blob is at the key, then deleting the zero-byte blob pinned to the ETag that commit returned. Its costs: the zero-byte blob is briefly visible at the key and raises a `BlobCreated` event, versioning or soft delete may keep a copy of it, a retention policy or legal hold makes the delete fail (abort rejects, sweep counts the resource as failed), and an upload overwriting an existing blob still leaves its staged blocks to the seven-day collection.

**`gcsUploadStore({ storage, bucket, uploadPrefix? })`** (`partial-content/gcs`) - Google Cloud Storage via object-per-chunk plus server-side compose (deliberately not GCS's native resumable sessions; see DESIGN.md). Appends are byte-exact immutable chunk objects, folded into a running composite every 32 chunks; completion seals the upload, folds what is left (32 sources per call), then publishes with one `copy` onto the destination key under `ifGenerationMatch` at the generation the seal recorded, stamping a `partial-content-publication` id, so publication is all-or-nothing. A refused precondition raises `UploadDestinationConflictError` and leaves the other writer's object intact. No native lifecycle covers the staging objects: schedule `sweepExpired` or scope a bucket lifecycle rule to `uploadPrefix`. Every write is conditional: the bookkeeping object on the generation it read (`ifGenerationMatch`, `0` at creation, re-read and retried at most twice on a refusal), each chunk object on its absence, so a holder whose lock was stolen mid-body neither lands a chunk over the winner's nor writes a stale record. The completion record is written before the chunk cleanup, so a cleanup that fails partway leaves an upload that reads complete, never one that recomposes a suffix; the leftover chunk is reaped by `abortUpload` or `sweepExpired`.

**`r2UploadStore({ bucket, uploadPrefix?, partSize? })`** (`partial-content/r2`) - Cloudflare R2 via the native multipart binding (no AWS SDK). The binding has no ListParts, so the adapter keeps its own durable part ledger (a `.manifest` object rewritten after every accepted part) and the offset derives from that ledger; that is why `exactOffsetRecovery` is `false`. R2 requires every non-final part to be the SAME size (`partSize`, default and minimum 5 MiB), so a remainder that is not a whole part is never written as a short part: it is parked as a tail object, `<prefix>/<id>.<uuid>.part`, that the manifest names (`tail: { id, size }`). The manifest's conditional write is the fence; the previous tail is deleted only after the manifest that replaces it is durable, and completion uploads a tail still parked as the one short final part R2 permits. A declared length raises the upload's part size to `ceil(length / 10000)` when `partSize` is smaller, so the whole representation fits R2's 10,000 parts; a deferred length keeps `partSize`, and a part past 10,000 is answered as a non-fatal append bound (`413`, resumable). A declared length above 10,000 x 5 GiB is a `RangeError` at `createUpload`. Completion seals the manifest at the acknowledged length and records the object at the key (its ETag, or its absence) before publishing. A zero-byte upload publishes with a `put` conditioned on that record (`onlyIf`), so a key written after the seal is an `UploadDestinationConflictError` and survives. The binding's multipart `complete()` takes no precondition, so a multipart publish re-reads the key immediately before `complete()` and refuses on a change; an object written between that read and `complete()` is overwritten, a window this store cannot close until the binding conditions `complete()`. Every published object carries a random publication id in the `partial-content-publication` custom-metadata field, minted when the upload is created because the binding fixes a multipart object's metadata then, and a completion retry adopts the object at the key only when it carries that id; an object without it, including the publication of an upload created by a release before 5.0.0, is a destination conflict rather than this upload's. A custom bucket's `head()` must therefore return `customMetadata`. R2's default lifecycle aborts incomplete multipart uploads after 7 days; `sweepExpired` reaps the manifests and the tail objects.

Capability flags, per built-in store (what each backend honestly declares about itself):

| Store | `appendGranularity` | `uniformPartSize` | `exactOffsetRecovery` | `atomicCompletion` | `digestOnComplete` | `maxAppendSize` |
|---|---|---|---|---|---|---|
| `memory` | byte-exact | - | `true` | `true` | `["sha-256", "sha-512"]` | - |
| `fs` | byte-exact | - | `true` (fsync before ack) | `true` (link of a staged copy; replacing an object leaves the key empty briefly) | `["sha-256", "sha-512"]` | - |
| `s3` | `minPartSize` (5 MiB default) | `false` | `true` (ListParts + sidecar) | `true` (CompleteMultipartUpload) | `false` (composite-only checksums) | - (parts stream out as they fill) |
| `azure` | byte-exact | - | `true` (block-list sums) | `true` (Put Block List) | `false` (no service-side whole-blob SHA-256) | - |
| `gcs` | byte-exact | - | `true` (chunk-listing sums) | `true` (one conditional `copy` of the folded composite) | `false` (native checksums are MD5/CRC32C) | - |
| `r2` | `partSize` (5 MiB default) | `true` (R2's rule) | `false` (adapter-owned ledger, no ListParts to cross-check) | `true` (binding `complete()`) | `false` (multipart etags are not content hashes) | - |

### `ResumableWriteStore` (custom write stores)

The write-side storage contract, independent of `ObjectStore` (an adapter implements one, the other, or both). Methods, all invoked by the orchestrator under the upload's lock and after a fresh state read:

<!-- generated:write-store-methods -->
- **`createUpload(opts: CreateUploadOptions)`** -> `Promise<{ uploadToken: string }>`

  Allocate a new upload resource and return its token. The token is the
  ONLY handle later calls receive, and it MUST be opaque and encode
  nothing: keep the object key, any backend upload id, and everything else
  resumption needs server-side, looked up by the token. A token that
  carries the key discloses it to every client that holds the upload URL,
  and a store that decodes the key back out of a presented token lets a
  client forge one that names another object. The engine and orchestrator
  never parse it; `checkResumableWriteStore` fails a token that contains
  its key, plain, percent-encoded or base64.

  The token MUST be unguessable, because possession of it IS the
  authorization. A resumable upload is reached by URL for minutes or days
  after the request that created it, and nothing in the protocol
  re-authenticates that follow-up: whoever holds the token can append to,
  probe, and cancel the upload. Derive it from a CSPRNG with at least the
  ~122 bits a v4 UUID carries, which is what every built-in store mints
  (`crypto.randomUUID`), never the backend's own upload id. A token
  built from a counter, a timestamp, or the storage key turns "authorized
  the creation" into "authorized everyone who can guess a neighbour".

- **`getUploadState(uploadToken: string, opts?: UploadStateReadOptions)`** -> `Promise<StoredUploadState>`

  Fresh, backend-derived state. Throws `UploadNotFoundError`.

- **`appendChunk(uploadToken: string, offset: number, body: ReadableStream<Uint8Array> | Uint8Array, opts: AppendChunkOptions)`** -> `Promise<AppendChunkResult>`

  Append `body` at `offset` (already engine-validated against fresh state).

  `bytesWritten` is the count made DURABLE by this call: on interruption
  that is the flushed prefix, and the next `getUploadState` must agree with
  it. `interrupted` says whether the call stopped before the body was
  exhausted because something asked it to YIELD: the abort signal was
  already latched on arrival, it fired mid-read, or the body itself tore.
  `false` means the body was read to its end.

  The store is the only party that reads the body, so it is the only one
  that knows this. A caller that inferred it from the signal instead would
  be reading "something asked for a yield" as "the store yielded", which is
  also true of a store that threw: an abort is therefore reported here and
  NOT raised, so a caller never has to classify an exception to tell a
  yield from a failure.

  A terminal resource refuses every append. The orchestrator answers `gone`
  from the state it already read, so this refusal is reached only by a
  caller holding the store directly, and the error it throws is a guard
  rather than a wire outcome: no dialect maps it, because no dialect gets
  there. A store may throw whatever names the situation.

- **`completeUpload(uploadToken: string, opts: CompleteUploadOptions)`** -> `Promise<CompletedUpload>`

  Publish the assembled object to its key. After success the object is
  readable and the upload resource answers status `"complete"`.

  Completion is a sealed-plan transaction, in this order:

  1. SEAL. Durably mark the resource completing at
     `CompleteUploadOptions.expectedLength`, with a write
     conditioned on the record version the store read (the same
     compare-and-swap its other record writes use), and record the
     destination state publication is allowed over: the version of the
     object at the key now, or its absence. A seal already present is
     adopted (a retried completion) and re-pointed at the new length.
  2. FENCE. From the seal on, `appendChunk` MUST refuse with
     `UploadOffsetConflictError` and acknowledge nothing. An append
     tests the seal AFTER its bytes are durable and before it returns, so
     an append either finished before the seal (and its bytes are in the
     snapshot below) or is refused; there is no third order. A check
     before the write alone would leave one.
  3. SNAPSHOT. Take the assembly plan (parts, chunks, blocks, file
     length) only after the seal, and throw
     `UploadOffsetConflictError` carrying the plan's length when it
     is not `expectedLength`, lifting the seal first so the upload stays
     resumable.
  4. PUBLISH under the provider's own precondition on the destination
     state the seal recorded, so a key a third party wrote after the
     seal is never overwritten: the store throws
     `UploadDestinationConflictError` instead. The published object
     carries this upload's publication identity (a random id the store
     minted, in object metadata, or the file identity on a filesystem).
  5. RECORD completion. A failure here leaves a published object and a
     sealed record; the next completion or state read recovers it by
     identity, never by shape: an object at the key is adopted as this
     upload's only when it carries this upload's publication identity,
     and anything else raises `UploadDestinationConflictError`.

  A failure before step 4 leaves nothing new visible. A failure after it
  leaves an object that is exactly the sealed plan, and the upload
  recoverable to complete; it never leaves a different object published.

- **`abortUpload(uploadToken: string, opts?: { signal?: AbortSignal; epoch?: number })`** -> `Promise<void>`

  Discard the resource and its partial bytes. Idempotent.

  MUST NOT touch an object this upload already published. Once
  `completeUpload` returns, the object at the key is live data that readers
  can already be serving, and the upload resource is only the scaffolding
  that produced it; a DELETE arriving late, retried, or replayed terminates
  the UPLOAD, never its result. An implementation that deleted the object
  here would make an idempotent-by-contract call destroy production data on
  its second invocation, with no way for the caller to tell the difference.
  Callers that do want the object gone delete it through their own storage
  API, where the intent is explicit. `checkResumableWriteStore`
  (`partial-content/conformance`) asserts this against the object itself
  when it is given a `readObject` hook, and reports it unverified when it is
  not: nothing the store says about its own resource can show whether the
  published object is still there.

- **`claimUpload?(uploadToken: string, opts?: { signal?: AbortSignal })`** -> `Promise<UploadClaim>`

  Mint a fencing claim on the resource (`UploadClaim`). Optional: the
  orchestrator calls it, under the lock, only on a store that implements
  it, and threads the returned epoch into the writes that follow. Throws
  `UploadNotFoundError` for an unknown token; any other throw is a
  store failure and nothing is written. No built-in adapter implements it
  yet.

- **`sweepExpired?(cutoff: UploadSweepCutoff, opts?: { signal?: AbortSignal })`** -> `Promise<{ removed: number; failed: number }>`

  Remove upload resources that either cutoff in `UploadSweepCutoff`
  names. The storage-limitation GC hook: callers run it on a schedule;
  adapters whose backend has native lifecycle rules may implement it as a
  no-op and document the native rule instead.

  Four things this contract pins, because each has a wrong answer that
  looks correct:

  1. **It reclaims BYTES, not bookkeeping.** Sweeping a resource MUST have
     the same effect as `abortUpload` on it: partial data, staged
     parts/blocks, sidecars, the lot. A sweep that removes only the metadata
     leaves the bytes alive with nothing left pointing at them, so they can
     never be found or deleted again. Those bytes are the personal data a
     storage-limitation obligation is about, which makes a metadata-only
     sweep a compliance gap dressed as a cleanup.
  2. **The two cutoffs are different clocks and a resource dies by either.**
     Idleness measures from the last append, lifetime from creation, and
     neither implements the other. A resource appended to once a minute is
     never idle, so an idleness sweep alone can never reach it, while every
     request against it is already refused once it passes
     `UploadPolicy.maxAgeSeconds`: storage that nothing can reclaim
     and nothing can use. Pass `createdBeforeMs` derived from the same max
     age the policy enforces, and the two agree by construction.
  3. **It runs WITHOUT the upload's lock**, because a store has no locker.
     An append in flight has not updated `lastAppendAt` yet, so a resource
     being written to right now still looks idle since its last completed
     append. Keep `idleSinceMs` comfortably longer than the longest single
     append the deployment permits (a slow client uploading a large chunk
     over a thin link is the case to size for), or the sweep can reap a
     resource mid-write and the client's next request answers 404.
  4. **One unreclaimable resource must not end the scan, and the count says
     so.** `failed` is the resources this pass condemned and could not
     remove: a file another handle holds open, a key a permission denies, a
     backend that answered an error. Each stays where it is and the next
     pass retries it. Propagating the first such failure instead would
     abandon every resource behind it, so one busy upload could stop a
     scheduled sweep from reclaiming anything, for as long as it stayed
     busy. `failed` is what a caller alerts on: a sweep that runs and
     reclaims nothing is otherwise indistinguishable from a sweep with
     nothing to do, and the difference surfaces later as unexplained
     storage growth. What makes the scan itself impossible still rejects:
     an unreadable listing cannot be counted resource by resource, and an
     aborted signal is the caller stopping the sweep rather than a resource
     resisting reclamation.
<!-- /generated:write-store-methods -->

Every built-in factory returns `SweepingWriteStore` (`ResumableWriteStore` with a required `sweepExpired`), so a scheduled call needs no `?.`, which would otherwise turn a missed retention obligation into a silent no-op.

Capability flags (readonly fields, honest per backend, never assumed). Every adapter MUST accept an `appendChunk` of ANY size and buffer to its backend's real granularity internally, so the orchestrator never re-chunks; `appendGranularity` and `uniformPartSize` are efficiency HINTS a caller or CDN may use to align its chunk sizes, not constraints anything upstream honors. `createUploadOrchestrator` refuses a store that reports `atomicCompletion` or `enforcesOffsetCheck` as `false`.

<!-- generated:write-store-flags -->
- **`appendGranularity`** (`number`, optional)

  The backend's natural part size in bytes: aligning appends to a multiple
  of it avoids the adapter's internal tail buffering. `undefined` = the
  backend takes arbitrary byte-exact appends with no alignment benefit.

- **`uniformPartSize`** (`boolean`, optional)

  The backend prefers every non-final part to be the same size (R2).

- **`exactOffsetRecovery`** (`boolean`, optional)

  Where the offset derivation gets its truth. `true`: the backend's own
  bookkeeping (a file size, a part or block listing), so a reported offset
  is one the backend can be asked to confirm. `false`: the adapter's own
  durable ledger, with nothing in the backend to cross-check it against,
  so after a crash the backend may report an offset a few bytes behind the
  last acknowledged write (a part landed but its manifest entry did not).

  Neither value promises the offset never moves backwards. An adapter that
  stages a sub-minimum remainder separately and later folds it into a part
  has a crash window of its own, bounded by that remainder, in which the
  derived offset regresses; that direction is deliberate, because an
  OVERSTATED offset silently drops the client's bytes while an understated
  one can be re-sent, PROVIDED the client still holds the bytes: an
  acknowledgement is not a licence to discard, and the contract says so
  (docs/API.md, capability flags), because a client that frees bytes on
  acknowledgement cannot resume across the window. What the flag
  distinguishes is whether the number comes from the backend or from a
  ledger beside it, and therefore how much a client must retain: a bounded
  remainder for `true`, one acknowledged write for `false`. Neither is
  corruption; both cost at most a redundant chunk.

  A DISCLOSURE, not a behavior switch: nothing in the engine branches on
  it. It is published so a consumer can weigh that recovery cost when
  choosing a backend.

- **`contractVersion`** (`typeof UPLOAD_STORE_CONTRACT_VERSION`, optional)

  The contract revision this store was written against,
  `UPLOAD_STORE_CONTRACT_VERSION` at the time. Optional; when
  present, `createUploadOrchestrator` refuses any value but the current
  one.

- **`atomicCompletion`** (`boolean`)

  `completeUpload` is all-or-nothing: no torn object is ever visible to
  readers. REQUIRED by the orchestrator (it publishes on a single
  `completeUpload` and has no rollback of its own); `createUploadOrchestrator`
  refuses a store that reports `false`.

  `boolean`, not the literal `true`: a flag a store cannot state falsely is
  a flag whose guard can never fire, and the refusal above is the whole
  point of asking. Declaring `true` is a CLAIM about behaviour that nothing
  at construction can verify, so prove it with
  `checkResumableWriteStore` (`partial-content/conformance`).

  What it can prove depends on what it is given, because this claim is
  about the OBJECT and a write store cannot be asked to look at one. Hand
  the harness a `readObject` hook and it asserts that the destination key
  holds nothing while the upload is open, that completion puts the appended
  bytes there whole, and that a completion which fails verification left the
  key untouched and the upload still completable. Without that hook it
  reports each of those unverified rather than met: a store's own
  bookkeeping saying "not complete" is the claim, not evidence for it.

- **`enforcesOffsetCheck`** (`boolean`)

  `appendChunk` re-derives durable state at the start of every call and
  refuses a claimed offset that disagrees with it, throwing
  `UploadOffsetConflictError` rather than writing.

  REQUIRED by the orchestrator, which refuses a store that reports `false`.
  The lock alone cannot carry this guarantee: an expiry-based distributed
  lock can be stolen from a holder that stalls past its TTL and resumes, and
  this check is what makes that holder's next append a loud conflict rather
  than silent interleaving. A single-process deployment cannot opt out of
  declaring it either, because the store is where the deployment shape stops
  being knowable: the same store runs behind the in-process locker today and
  a distributed one tomorrow, with no code change to notice.

  `true` claims a preflight per call, NOT that the check and the bytes are
  one atomic step. See the interface docs for the residual window and what
  bounds it; do not read this flag as "stale writes are impossible".

  `boolean`, not the literal `true`: a store that cannot make the check must
  be able to say so and be refused, and a flag that only admits one value
  makes the refusal unreachable. Declaring `true` is still only a claim;
  `checkResumableWriteStore` (`partial-content/conformance`) is what turns
  it into an assertion. It replays a stalled writer's stale append and
  requires the conflict, and then requires that the replay changed nothing:
  the durable offset stayed put, and the bytes did too. Both halves are
  needed, because a store that writes first and checks afterwards raises
  exactly the same conflict over an object it has already corrupted. The
  byte half reads the destination through `readObject`, or through the
  store's own completion-time digest verification where it has one, and
  where it has neither the harness reports it unverified.

- **`digestOnComplete`** (`readonly UploadDigestAlgorithm[] | false`)

  The algorithms whose client-asserted digest over the whole assembled
  representation the backend verifies at completion, or `false` when it
  verifies none. An assertion in an algorithm not listed is advisory and
  is dropped before it reaches the store (RFC 9530).

- **`maxAppendSize`** (`number`, optional)

  Largest single append the backend accepts, when bounded.
<!-- /generated:write-store-flags -->

### Locking (`UploadLocker`)

A probe takes the lock too, which means a `HEAD` ASKS AN IN-FLIGHT APPEND TO YIELD: the running write aborts at its next chunk boundary, flushes what it has, and answers with a truthful shorter offset. No bytes are lost and the client resumes, but a monitoring loop polling `HEAD` against an active upload will keep chopping it into small appends. `orchestrator.resourceExists(uploadToken)` is the lock-free, non-preempting alternative when all you need is whether the token still resolves; it deliberately says nothing about the offset, which is the part the lock exists to make coherent. `orchestrator.admit(uploadToken, { authorize })` is the same lock-free read answering the refusals that need no offset (`not-found`, or the `authorize` hook's `refused` response), for gating work such as buffering a body that the append would refuse anyway; the hook may run again inside the append.

Interactions on one upload resource are serialized by a lock, probes included (deriving an offset can be a multi-call backend read, and a torn snapshot would hand the client an offset its next request fails on). The lock is **cooperatively preempted**, not a plain mutex: a new acquirer aborts the current holder's signal, the holder yields its append at the next chunk boundary (flushing what it has, so the offset stays truthful), and the lock hands over in milliseconds. The interface is one method: `acquire(uploadToken, { timeoutMs?, auditKey? })` -> `Promise<UploadLock>`, where `UploadLock` is `{ signal: AbortSignal; lease: AbortSignal; release(): void }`. `auditKey` is the same substitution the rest of the package makes: supply one and a locker names the resource by it instead of by the token wherever it reports a failure. The holder threads `lock.signal` into its store write; the signal aborts (reason `UPLOAD_PREEMPTED`) the moment a later acquirer wants the resource, so preemption is a real cancellation the holder cannot silently ignore rather than a callback convention. Because the signal carries latched state, a preempt that lands during hand-over is never lost. A holder that does not yield within `timeoutMs` rejects with `UploadLockTimeoutError`, which the dialects answer as 423. `lock.lease` is the narrower signal: it aborts (reason `UPLOAD_LEASE_LOST`, which also aborts `signal`) only when the locker can no longer prove the hold, a distributed lease that lapsed or whose renewal went unanswered, never because someone asked for a yield. The orchestrator never seals or publishes once `lease` has aborted, and a lease lost while a completion is under way aborts its store call: the completion answers contention, so a holder that may no longer own the resource cannot publish it. An append in flight yields as it does for any preempt, since `signal` aborts too. A locker whose holds cannot be lost (the in-process one) never aborts `lease`. Writing a custom `UploadLocker` is a page of code: create an `AbortController` at acquire time, abort it when a later acquirer arrives, expose its `signal`, and expose a `lease` that aborts only when the hold itself is lost (a signal that never aborts, for a locker whose holds cannot be).

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

`ttlMs`, `acquireTimeoutMs` and `pollIntervalMs` must each be a positive safe integer; a value that is not throws a `TypeError` naming the option and the value it was given, at construction rather than on the first contended upload. `keyPrefix` (default `"partial-content:lock:"`) namespaces every lock key and preempt channel, so two deployments sharing one server do not contend for each other's uploads.

Names: the server never sees an upload token. The lock key is the `keyPrefix` (default `partial-content:lock:`) plus the token's SHA-256 in hex, and a preempt request is that digest published on the locker's one channel, `<prefix>preempt`.

Mechanics: the lock is `SET key <hold-id> NX PX ttl` (`ttlMs`, default 30 s, is the crash-recovery bound), the hold id being a per-acquire random value; a live holder renews at ttl/3 via a watchdog, and a renewal that cannot confirm the hold aborts the holder's lock signal, because a holder that cannot prove its lock must stop writing. Waiters publish a preempt request on the resource's channel and RE-publish it every poll round (`pollIntervalMs`, default 50 ms, jittered), so a request landing in the holder's subscribe gap is re-delivered, never lost; release and renewal compare the hold id in Lua, so an instance can only ever release its own hold. The hold id is deliberately NOT a fencing token: it fences this locker's own release and renewal against a stale holder, and it never reaches a store write, so it cannot fence the thing a fencing token exists to fence. `onError` observes absorbed failures (failed renewal/release/unsubscribe); its context is `{ uploadToken?, auditKey?, operation }` and carries exactly one identifier, the `auditKey` from the acquire when there was one and the token otherwise. The acquire timeout bounds every round trip the acquire makes, not just the polling, so a server that accepts a command and never answers costs the caller its timeout and then a 423; because the protocol has no client-side cancel, an abandoned `SET` is followed by the compare-and-delete that keeps a late arrival from holding the resource, and a renewal that has not answered by the time the next one is due counts as a failure to confirm. Honesty about fencing: an expiry-based lock can be stolen from a holder that stalls past its TTL and resumes; the write store takes no fencing token, so what makes that non-corrupting is the same defense the engine has in-process, fresh-state validation under the new holder's lock plus the stores' own at-write offset checks, which turn a zombie's late append into a loud `UploadOffsetConflictError`.

### Upload audit events (`onUploadEvent`)

Structured, content-free by construction (no filenames, no bytes, no metadata values): `{ uploadToken?, auditKey?, event }`, where `uploadToken` is present only when no `auditKey` was supplied (the key substitutes for it, because the token is the capability and this hook feeds log records) where `event` is one of `created` (with `declaredLength?`), `append-accepted` (`atOffset`, `completes`), `append-rejected` (`reason`, `atOffset?`), `completed` (`length`), `cancelled`, `expired`. Reject reasons: `offset-mismatch`, `length-inconsistent`, `size-exceeded`, `append-too-small`, `append-too-large`, `below-min-size`, `invalidated`, `digest-mismatch`, `digest-unverifiable`, `destination-conflict`. The set may gain a member in a minor release, so a consumer keeps a branch for an unknown reason. An expiry is reported as its own `expired` event rather than a reject reason, and the two answers that reject nothing durable, a repeat of a completed upload and a lock contention, emit no event at all: neither changed the resource.

The same substitution governs the context handed to `onError`, which carries `{ uploadToken?, auditKey?, operation }`: supply an `auditKey` and it arrives on the context while `uploadToken` is absent, since an error sink is at least as log-adjacent as an event sink. It governs the error too: under an `auditKey` the sink receives a `ProjectedError` (`name`, `code`, `status`, `operation` and the `cause` chain projected the same way) in place of the raw error, because the message, the stack and every other property can carry the token or the storage key in some spelling. The read path's `onError` does the same for the key. `redactErrorText(err, needles, replacement)` is exported from the package root for a custom store's own sink that wants the raw error with the needles replaced. Correlate on the key either way.

### Upload error classes

The first six are thrown by write stores, `UploadLockTimeoutError` by the locker and `UploadDigestUnverifiableError` by the orchestrator. All eight, with their matchers, come from either dialect subpath (`partial-content/tus`, `partial-content/upload`); the store classes are additionally re-exported from the storage subpaths (`UploadNotFoundError`, `UploadOffsetConflictError`, `UploadAppendBoundError` and `UploadOverrunError` from all six, `UploadDigestMismatchError` from `/fs`, `/memory`, and `/s3`). Every one is matched **by `name`**, so a custom store can throw equivalently-named errors without importing the classes:

- **`UploadNotFoundError`** - The upload resource does not exist (never created, completed and reaped, cancelled, or expired-and-swept). Dialects answer 404.
- **`UploadOffsetConflictError`** - An append's claimed offset lost a race with durable state (defense in depth under the lock; carries `durableOffset`). The orchestrator answers offset-mismatch with the correct offset.
- **`UploadDestinationConflictError`** - A completion found the destination key changed under its sealed plan (code `UPLOAD_DESTINATION_CONFLICT`). Nothing was published and the object at the key is left intact; the upload stays sealed. Never retried by the store, because the object at the key is someone's data. Every dialect answers `409`, and the orchestrator reports it to `onError`. Matcher: `isUploadDestinationConflictError`.
- **`UploadAppendBoundError`** - The body ran past a NON-fatal append bound (`maxBytesFatal: false`), this request's ceiling rather than the representation's (carries `durableOffset`). The resource is untouched and healthy and the prefix the adapter made durable stays durable, so both dialects answer 413 and the client resumes from `durableOffset` in smaller chunks. The one exception is a zero bound: an append at the durable end of a known length, or at the policy ceiling, has no room, and a body that carries bytes into it is answered as that representation's inconsistency (`400` for a declared length, `413` size violation for `maxSize`) rather than as a ceiling a smaller chunk could meet. Matcher: `isUploadAppendBoundError`.
- **`UploadOverrunError`** - The body ran past a FATAL append bound (`maxBytesFatal: true`), the representation's own bound (carries `bound`). The upload can never be completed coherently, so the adapter has already invalidated it durably and every later probe or append refuses. The orchestrator answers 400 when the bound was the length the client declared and 413 when it was the policy's `maxSize`, because the fault is the client's against its own declaration, not the storage's. Matcher: `isUploadOverrunError`.
- **`UploadDigestMismatchError`** - The assembled bytes do not hash to the digest the client asserted (carries `expectedDigest`, `actualDigest?`). Thrown BEFORE publishing; the dialect answers a client error, never a torn object.
- **`UploadDigestUnverifiableError`** - Under `policy.digestPolicy: "require-verifiable"`, the request asserted a `Repr-Digest` only in algorithms the store cannot verify (code `UPLOAD_DIGEST_UNVERIFIABLE`). Raised before anything is allocated or written; the dialect answers `400`. Matcher: `isUploadDigestUnverifiableError`.
- **`UploadLockTimeoutError`** - The lock was not obtained within the acquire timeout, because the holder did not yield or (for a server-backed locker) the server did not answer in time; raised by the locker rather than a store (a custom `UploadLocker` signals timeout by rejecting with an error of this `name`). Dialects answer 423. Matcher: `isUploadLockTimeoutError`, a type guard narrowing by `name`.

## Store conformance (`partial-content/conformance`)

Two harnesses over one report shape: `checkResumableWriteStore` for a `ResumableWriteStore`, `checkObjectStore` for an `ObjectStore`. Neither is a test file and neither needs a test framework: every check is a plain async call against the store's own public surface, so a run works under any runner, in CI, or as a startup self-test against a staging bucket. Checks are independent, so one run reports every gap rather than the first.

Both return `{ ok, checks, passed, failed, skipped }`, where `ok` is `failed === 0`. A **skipped check never makes the report fail, and never counts as passed either**: it is reported as its own outcome (`skipped: true`, with a `detail` saying why) so an unverified guarantee is visible instead of green. Each `ConformanceCheck` carries a stable `name` safe to allow-list against in your own CI, an `obligation` phrased as what the store must do, `ok`, and a `detail` explaining a failure in terms of its consequence rather than its assertion.

**`formatConformanceReport(report)`** -> `string` renders either report as plain `PASS`/`FAIL`/`SKIP` lines plus a tally. It returns the text and prints nothing, so the caller chooses the sink.

**A check that observes nothing cannot report a pass.** Every check body receives an `assert(held, detail)` and reports through it and nothing else; a body that never calls it fails, saying that a pass would have stated nothing about the store. That is structural rather than a review habit, because the failure it prevents is invisible by construction: a check that publishes an object, aborts the upload and then returns without reading anything back looks exactly like one that verified the object survived, and it passes every store including one that deletes its own published data.

**`runConformanceCheck(name, obligation, run)`** and **`tallyConformance(checks)`** are the seam for adding backend-specific obligations to a run under that same rule. Use them when your store guarantees something these harnesses cannot know to ask about, and the result folds into the same report shape:

```typescript
// doc-check: fragment
const extra = await runConformanceCheck(
  "parts-are-reaped-on-abort",
  "abortUpload leaves no multipart upload behind",
  async (assert) => {
    const { uploadToken } = await store.createUpload({ key, now: Date.now() });
    await store.abortUpload(uploadToken);
    assert((await listMultipartUploads()).length === 0, "an aborted upload left parts billing in the bucket");
  },
);
const report = tallyConformance([...(await checkResumableWriteStore(makeStore)).checks, extra]);
```

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

Several checks read the destination key to see what was actually published,
which needs `readObject?: (key) => Uint8Array | undefined` on the options.
Without it those checks are reported SKIPPED with the reason, never passed:
an obligation nothing could observe has not been met, it has gone unverified.

<!-- generated:write-store-checks -->
The 28 checks, by what they pin:

| Check | Obligation | Skipped when |
|---|---|---|
| `declares-atomic-completion` | atomicCompletion must be true: the orchestrator has no completion rollback of its own | never |
| `declares-offset-check` | enforcesOffsetCheck must be true: it is the only guard against a stolen-lock writer | never |
| `stale-write-changes-nothing` | a refused stale append must leave the durable offset exactly where it was | never |
| `stale-write-leaves-the-bytes-alone` | a refused stale append must leave the durable BYTES where they were, not only the offset | no readObject was supplied and digestOnComplete is false, so the published bytes can be looked at from neither side |
| `failed-completion-publishes-nothing` | a completion that fails verification must leave the destination key untouched and the upload still completable | no readObject was supplied, so nothing here can look at what reached the destination key; or digestOnComplete is false, so this store has no verification step to fail |
| `completion-publishes-exactly-what-was-appended` | the destination key stays empty until completion, which puts the appended bytes there whole | no readObject was supplied, so nothing here can look at what reached the destination key |
| `abort-is-reported-not-raised` | an already-aborted signal returns interrupted with nothing written, rather than throwing | never |
| `short-append-reports-interrupted` | interrupted: false claims the body was read to its end, so bytesWritten must account for all of it | never |
| `torn-body-reports-interrupted` | a body that fails mid-transfer is reported as interrupted with the flushed prefix, not raised | never |
| `mid-read-abort-reports-interrupted` | a signal firing mid-read stops the read, is reported not raised, and leaves a durable offset | never |
| `request-ceiling-stops-a-stream` | a non-fatal bound stops a chunked body at the ceiling and leaves the upload resumable | never |
| `token-is-unguessable` | tokens must come from a CSPRNG: possession alone authorizes append, probe and cancel | never |
| `offset-starts-at-zero` | a fresh upload reports offset 0, is neither complete nor invalidated, and echoes createdAt | never |
| `state-reports-the-recorded-expiry` | an upload created with expiresAt reports that instant on every state read, before and after an append | never |
| `offset-agrees-after-clean-append` | after a clean append, getUploadState must agree with the offset plus bytesWritten | never |
| `offset-is-backend-derived` | the offset must come from durable backend state, so a fresh instance derives the same one | restartable: false, so durability across instances is unverified |
| `refuses-stale-offset` | appendChunk must throw UploadOffsetConflictError when the claimed offset is behind durable state | never |
| `refuses-future-offset` | appendChunk must refuse an offset ahead of durable state rather than leaving a hole | never |
| `request-ceiling-keeps-the-resource` | a non-fatal bound stops at maxBytes, keeps the prefix durable, and leaves the upload healthy | never |
| `representation-bound-invalidates` | a fatal bound must invalidate durably and throw UploadOverrunError | never |
| `completion-publishes-and-closes` | completeUpload publishes, and the upload refuses further appends afterwards | never |
| `completion-refuses-an-unacknowledged-length` | completeUpload at any length but the assembled one throws UploadOffsetConflictError carrying the assembled length, publishes nothing, and leaves the upload resumable | never |
| `late-append-leaves-the-published-object-alone` | an append after completion is refused and changes neither the offset nor the published bytes | no readObject was supplied, so nothing here can look at what reached the destination key |
| `abort-is-idempotent` | abortUpload must tolerate being called twice: a retried cancel is a normal thing to receive | never |
| `abort-spares-a-published-object` | abortUpload must never destroy an object completion already published | no readObject was supplied, so nothing here can look at what reached the destination key |
| `invalidated-upload-is-still-cancellable` | a dead upload must remain discardable, or its bytes are stranded until a sweep that may never run | never |
| `records-a-deferred-length` | a length first declared on an append must be persisted and then immutable | restartable: false, so durability across instances is unverified |
| `swept-resource-is-not-resurrected` | a reaped resource stays gone: an append in flight across the sweep must not write it back | the store implements no sweepExpired |
<!-- /generated:write-store-checks -->

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

<!-- generated:read-store-checks -->
The 7 checks, by what they pin:

| Check | Obligation | Skipped when |
|---|---|---|
| `head-reports-the-true-length` | headObject must report the object's exact byte length | never |
| `full-read-returns-every-byte` | getObject with no range returns the whole representation and its total size | never |
| `missing-object-is-not-found` | an absent key must throw ObjectNotFoundError, distinguishably from a failure | never |
| `missing-object-is-not-found-on-read` | getObject on an absent key, whole or ranged, must throw ObjectNotFoundError, since a plain GET reads with no HEAD first | never |
| `range-serves-the-requested-window` | a ranged read returns exactly the requested bytes | supportsRange: false, so the serving path never asks this store for a window; or the sample object is too short to slice a meaningful window from |
| `range-reports-an-honest-total` | a ranged read reports the whole representation's size, or undefined when it cannot know | supportsRange: false, so the serving path never asks this store for a window; or the sample object is too short to slice a meaningful window from |
| `digest-is-the-whole-representation` | any digest reported is the raw base64 SHA-256 of the whole object, never of a window | never |
<!-- /generated:read-store-checks -->

Skips keep an unverified obligation from reading as a met one. A store declaring `supportsRange: false` has the two range checks **skipped rather than passed**, since the serving path never asks it for a window; the same happens when `content` is under 4 bytes, which is too short to slice a meaningful window from. `digest-is-the-whole-representation` is not among them: a store that reports no digest passes it, because absent is a legitimate answer, and what the check refuses is a digest that is malformed or computed over anything but the whole representation.
