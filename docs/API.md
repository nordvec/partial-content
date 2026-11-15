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

**`isPreconditionFailure(reqHeaders, etag, lastModified, exists?)`** - `true` if precondition failed (412). Pass `exists` when the resource's presence is known independently of its validators (e.g. an `If-Match: *` guard on a write your own handler performs).

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

**`httpStore({ url, headers?, fetch?, redirect?, reservedPrefix?, keys?, maxKeyBytes? })`** - Serve from ANY range-capable HTTP origin over plain `fetch`: Supabase Storage, presigned S3/GCS/Azure URLs, CDN origins, or another partial-content server. Pinned reads map to `If-Match` (origin 412 -> `ObjectChangedError`), `Repr-Digest` response headers are extracted, and requests are sent `Accept-Encoding: identity` and any response that still carries a non-identity `Content-Encoding` is refused, so transparent compression can never corrupt byte accounting. `Accept-Encoding`, `Range`, and `If-Match` are reserved: the adapter owns them and replaces any consumer-supplied value case-insensitively. `url` may return a string or a `URL`, directly or as a promise (a presigner), and is called once per store call. Redirects are refused by default (a hostile origin must not 3xx the store toward internal/metadata IPs); with `redirect: "follow"` the store follows them itself, the same way on every runtime: at most 10 hops, `http:` and `https:` only, never from `https:` to `http:`, each through your `fetch`, and a hop to another origin carries none of your `headers` (see SECURITY.md). An origin `Retry-After` is relayed only as delay-seconds or an HTTP-date, capped at one day. A URL carrying a user name or password is refused (pass credentials in `headers`). **`maxKeyBytes?`** (default 1024) answers `ObjectNotFoundError` for a longer key, in UTF-8 bytes, before any other reading of it; raise it for an origin that holds longer names. A key is the object's name, never URL text: build the path with `encodeKeyPath(key)` (`encodeKeyPath(key, { keys: "verbatim" })` under `keys: "verbatim"`, which keeps an empty segment other than a leading one), so a key such as `#1 Invoice.pdf` or `a?b.pdf` is fetched as the object it names.

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

**`reservedPrefix?`** (on `fsStore`, `s3Store`, `r2Store`, `gcsStore`, `azureStore`, `httpStore`) - Keys at or under this prefix are refused with `ObjectNotFoundError` on `headObject`, `getObject`, and `createSignedUrl` where the backend has one. It exists for a location shared with a partial-content 5.x upload store, whose in-flight bytes and sidecars (which name the destination key, commonly a filename) would otherwise be readable through the read path. The defaults are the 5.x upload-store namespaces: `.uploads/` for `s3Store` and `fsStore`, `.partial-content-uploads/` for `r2Store`, `gcsStore` and `azureStore`, and both for `httpStore`, which cannot know which layout sits behind its origin. Pass one prefix or a list to name another namespace, or `""` to serve the whole location when no upload store ever shared it. A prefix that would reserve nothing (`"/.uploads/"`, `"a//b"`) throws a `TypeError` at construction. **`keys?: "plain" | "verbatim"`** is the separate key policy: `"plain"` (the default for `s3Store`, `azureStore` and `httpStore`, which build a URL from the key) refuses a key with an empty segment; `"verbatim"` (the default for `r2Store` and `gcsStore`, whose clients take the key as is) serves it. `s3Store`, `azureStore` and `httpStore` refuse a dot segment under either policy, because the URL they build resolves it before the backend sees the path. `httpStore`, which hands the raw key to a URL the consumer builds, also refuses under either policy a key that starts with `/` or `\`, with a special scheme such as `https:` or `file:`, or with a C0 control or a space at either end, fetches only an `http:` or `https:` URL from `url()`, and reads a dot segment and the reserved prefixes in the path before any `?` or `#`. `s3Store`, `r2Store`, `gcsStore` and `httpStore` answer `ObjectNotFoundError` for a key over 1,024 UTF-8 bytes, and `azureStore` for one over 4,096, before any other reading of it. `memoryStore` takes no such option. The guard itself is exported from the package root as `reservedKeyGuard(prefix)`, for custom `ObjectStore` implementations.

**Construction validates its options.** `memoryStore` requires `objects`, `fsStore` an ABSOLUTE `root`, and `s3Store` `client` and `bucket`; each throws a `TypeError` naming what to change. A missing `objects` map otherwise surfaced as a 502 at publication, after the entire body had transferred, and a relative `root` silently anchored to `process.cwd()`. The `fsStore` `cache` options `ttlMs`, `maxEntries` and `maxBytes` throw a `TypeError` for `NaN`, an infinity or a negative number, each of which would disable the bound it names.

**`s3Store({ client, bucket })`** (`partial-content/s3`) - Any S3-compatible backend (AWS, R2 in S3 mode, Hetzner, MinIO, Backblaze, Wasabi) via `@aws-sdk/client-s3`. Pinned reads via `IfMatch`, `authoritativeRange` single-round-trip seeks, `x-amz-checksum-sha256` surfaced as the RFC 9530 digest, throttle errors mapped to retryable 503s (with the backend's `Retry-After` when the SDK exposes it), and `createSignedUrl` via `@aws-sdk/s3-request-presigner`. A failure while signing (a credential provider, the signer) throws; the store declines (`code: "unsupported"`) only when the presigner package cannot be loaded.

**`r2Store({ bucket })`** (`partial-content/r2`) - Cloudflare R2 via the native Workers binding (no AWS SDK). Pinned reads via `onlyIf.etagMatches`; served bounds come from R2's own reported range.

**`gcsStore({ storage, bucket, digestMetadataKey? })`** (`partial-content/gcs`) - Google Cloud Storage via `@google-cloud/storage` (pass the constructed `Storage` client plus the bucket name). Pins reads to the object GENERATION (an opaque `pin` token from `headObject` makes the HEAD->GET pair a single metadata round-trip), and mints V4 signed READ URLs via `createSignedUrl` (no Cache-Control response override -- GCS signed URLs have no `response-cache-control` parameter, unlike S3); a client with no `client_email` to sign with declines (`code: "no-credential"`) and the response streams. A read awaits the first chunk before the status is committed: an object gone or replaced under a pinned read throws `ObjectChangedError`, and a missing one under an unpinned read throws `ObjectNotFoundError`, each answered as its own status and never as a `200` that fails mid-body. GCS exposes no native SHA-256 (`x-goog-hash` carries only `crc32c`/`md5`), so set `digestMetadataKey` to the custom-metadata key where your uploader stores the raw-base64 SHA-256 and the store surfaces it as the RFC 9530 digest; invalid or absent values are simply not emitted.

**`azureStore({ containerClient })`** (`partial-content/azure`) - Azure Blob Storage via `@azure/storage-blob`. Single-call `download()` (metadata and body are one response by construction); pinned reads via `conditions.ifMatch`; `createSignedUrl` mints a read-only SAS URL with sanitized Content-Disposition, inert content type, and the Cache-Control response override. It requires a shared-key credential on the client; without one it declines (`code: "no-credential"`) and the response streams.

**`fsStore({ root, cache?, reservedPrefix?, symlinks? })`** (`partial-content/fs`) - Local filesystem with path-traversal/null-byte/Windows-device-name hardening, nanosecond-mtime weak ETags, an fd-coherent stat+stream (no stat-then-reopen race), `authoritativeRange` single-round-trip range serving (the one open handle stats, clamps, and reads, so bounds, validators, and bytes are coherent by construction), and a single-read fast path for bodies <= 128 KiB. `root` must be ABSOLUTE. `reservedPrefix` defaults to `.uploads/` (see above). A path that is not a regular file (a FIFO, a device) is refused rather than opened for a blocking read.

`symlinks` decides what a symbolic link or junction under the root may reach. `"contain"` (the default) serves a key only when its real path, every link resolved, is inside the root's real path, and opens the file without following a link in the final component where the platform supports `O_NOFOLLOW`. A link from one place in the root to another serves; one that leaves the root, or that reaches the reserved upload workspace, answers `ObjectNotFoundError`. `"follow"` resolves links wherever they point, for a root whose layout links to content kept elsewhere on purpose; any other value contains. The containment check and the open are two steps, so a writer that can swap a directory under the root for a link between them is outside what it defends against: keep the served tree writable only by principals you would trust with the files, or serve from a root no untrusted party can create links in.

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

**`precompressed: true | ["br", "zstd", "gzip"]`** - Serve precompressed sibling objects (`<key>.br`, `<key>.zst`, `<key>.gz`) negotiated via `Accept-Encoding` (RFC 9110 12.5.3: qvalues, `*`, `identity` preference; the array order is the server tie-break). The chosen variant is its own representation: its validators drive 304/If-Range, its size drives Range/`Content-Range`/416 (byte ranges address the ENCODED bytes), its digest rides `Repr-Digest`, and `Vary: Accept-Encoding` is emitted on every success response for the type, including identity fallbacks and 304s. Gated on compressible MIME types (`isCompressibleMime`); multi-range requests serve identity; a non-404 probe failure falls back to identity and reports to `onError`. The siblings are probed in parallel, together with a `headObject` of the identity object in the same round, a sibling answered 404 is not probed again for 30 seconds (a variant uploaded inside that window is served once it expires), and a variant removed after the probe is answered from the identity object. A variant is served only while the identity object exists and is not newer than the variant: deleting the identity stops its variants being served, and a variant older than a replaced identity is skipped. A variant the store confirmed is remembered for 30 seconds; a plain GET for it then sends the variant's `getObject` together with the identity HEAD and takes the variant's validators from that read, while a range or conditional request still sends the variant's HEAD first. Only the deployer should write the variant namespace (see [SECURITY.md](../SECURITY.md)): anyone who can write `<key>.br` replaces what every client that accepts `br` receives. Upload the identity object first, or give each variant the identity's modification time: a variant older than its identity is skipped, so a parallel sync that writes the variants first disables them until they are rewritten. Selection only -- upload the variants yourself (e.g. `brotli -k`, `gzip -k` at build/ingest time); the library never compresses at serve time because transforming would corrupt byte ranges and digests.

**`preferSignedUrl(info)`** - Per-request egress offload: return `true` to answer a 302 to `createSignedUrl` instead of proxying bytes (`info` = `{ key, mime, method, isRange, isConditional }`). The classic split is `({ isRange, isConditional }) => !isRange && !isConditional`: ranges and revalidations stay on the origin where the protocol machinery matters, large full-file downloads go straight to the bucket. HEAD requests never consult the predicate (a metadata probe answered with a bare 302 defeats exactly the clients that send HEAD, like PDF.js size probing), so `info.method` is always `"GET"`. The redirect is decided before the object's existence is known, so a missing key reaches the client as the backend's own error page, not this handler's `404`. The predicate must return a boolean; a promise or any other value answers `500` with operation `"context"`. The signed request carries the route's `cacheControl` (S3 `response-cache-control` override) so private documents cannot be CDN-cached under an object's baked-in public Cache-Control. A store that declines to sign (`{ ok: false }`) is streamed from the origin and the decline is not reported; a signer that throws is reported with operation `"sign"` and answered `502` (`499` when the client had already gone). `signedUrlExpiresSeconds` (default 60, an integer of at least 1) sets the URL lifetime -- note that temporary credentials (STS/Lambda) cap the effective lifetime at the session token's remaining life regardless.

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

`ServeContext`: `key` (required; a string, and a `ctx` of the wrong shape answers `500` with operation `"context"` for any method), `mime?` (the response `Content-Type`; **when omitted it is `application/octet-stream`**, which no browser renders inline, so a PDF or video downloads instead of playing even under `disposition: "inline"`. Derive it from the key with `lookupMime` from `partial-content/mime`, or pass the type you stored at upload), `filename?`, `cacheControl?` (per-request override of the handler-level value, e.g. `immutable` for content-addressed keys next to `private, no-cache` user uploads from the same handler), `auditKey?` (opaque identifier reported as `key` in every `onServe`/`onTransfer`/`onError` event; storage keys commonly embed filenames, which are personal data that logging controls such as ISO 27001 A.8.15 keep out of log records -- pass a document id or hash here and the audit trail stays correlatable without the filename). With it set, `onError` receives a `ProjectedError` instead of the raw error: only `name`, `code`, `status`, `operation` and the `cause` chain projected the same way, because the message, the stack and every other property can carry the key in some spelling. Branch on those fields, not on the message or `instanceof`. `ProjectedError` is exported from `partial-content/web`. Without an `auditKey` events carry the storage key and errors arrive unchanged; the Node and Hono adapters, which take an `auditKey` extractor, pass the constant `"unkeyed"` when it returns `undefined`, so the storage key is never the fallback. `ctx` must be an object and `ctx.cacheControl` a string when present: any other shape answers `500` with operation `"context"`. A precompressed variant's events report the identity key with `variantKey` and `contentEncoding` (`variantKey` is withheld under an `auditKey`), and `onServe` and `onTransfer` carry `storedContentType` when the store reports `ObjectMetadata.contentType`.

`cacheControl` defaults to `private, no-cache, no-transform`: the responses carry digests and strong validators, which an intermediary that re-compresses the payload would invalidate. It is emitted verbatim on 200/206/304, so any directive vocabulary your CDN or edge understands passes straight through: RFC 9111 `s-maxage` / `must-revalidate` / `proxy-revalidate` and the RFC 5861 resilience directives `stale-while-revalidate` and `stale-if-error`. The library does not synthesize or reorder directives (only appending `immutable` when the `immutable` option is set and it is not already present), so you keep full control of the response caching policy. `Vary` (e.g. `Vary: Accept-Encoding`) rides `securityHeaders` and is forwarded onto 304 responses too, satisfying the RFC 9110 15.4.5 MUST-generate list.

**Cross-origin consumers**: `Content-Range`, `ETag`, `Accept-Ranges`, `Content-Encoding`, and the digest fields are not CORS-safelisted; list them in `Access-Control-Expose-Headers` or cross-origin readers (pdf.js range loading in particular) silently degrade to full downloads. **Behind a CDN**: only CloudFront forwards client ranges to the origin; Cloudflare/Fastly/Bunny fetch-and-slice, `.zst` variants are unreachable through Cloudflare/CloudFront default encoding normalization, and edge 206s require the origin response to carry `Content-Length` (never chunked). Full details and configuration pointers in `docs/DESIGN.md` "Behind a CDN".

## Node Adapter (`partial-content/node`)

**`serveObject<Req>(store, options)`** - Create a Node.js `(req, res) => Promise<void>` handler for Express, Fastify (compat), Koa, and raw `http.createServer`. Extends the web adapter options with `key` (required, extracts the storage key from the request), `mime?`, `filename?`, and `auditKey?` (see `ServeContext.auditKey`). `Req` defaults to `IncomingMessage`; pass your framework's request type (`serveObject<express.Request>(store, { key: (req) => req.params.key })`) so framework fields typecheck in the extractors. A throwing extractor becomes a hardened 500 and is reported to `onError` with `operation: "context"`.

`partial-content/node` re-exports `ServeObjectOptions`, `ServeContext` and `ObjectStore` alongside the `ObjectNotFoundError`, `ObjectChangedError` and `StoreUnavailableError` classes, so an adapter-only consumer types its handler and matches store errors from one import. `partial-content/hono` re-exports the same three types.

**Server timeouts (deployment note)** - Node's `http.Server` defaults (`requestTimeout` 300s, `headersTimeout` 60s) force-close any transfer that outlives them, independent of this adapter's stall detection: a large download over a slow link dies mid-stream at 5 minutes. Raise them on the server you `listen()` with (`server.requestTimeout = 0` or a generous ceiling) when serving large files.

**`writeStallTimeoutMs?`** (default `60000`) - Bounds how long the streaming pump waits for a single backpressure `drain` before treating the client as stalled and tearing the transfer down (cancel the storage read, destroy the response). A client that stops reading but holds its socket open would otherwise pin a backend storage connection indefinitely (a slow-read attack). Set to `0` to disable and rely on an upstream proxy / socket timeout instead. Only the raw-Node pump needs this; Fetch-runtime backpressure is the platform's own concern.

## Storage Contract

**`ObjectStore`** (interface) - Read-only storage backend abstraction. Implementations provide `headObject(key, opts?)` for metadata and `getObject(key, opts?)` for streaming, where `opts` carries `range`, `signal`, `ifMatch` (pinned reads), and `pin` (an opaque token issued by `headObject` for stores whose version identifier is not the ETag; GCS uses it to stream a pinned generation without re-fetching metadata). Optional `createSignedUrl(key, opts)` for backends that cannot stream ranges through the origin, or where a caller wants bulk egress off the origin (`preferSignedUrl`). Optional `authoritativeRange: true` declares that ranged responses report the backend's ACTUAL served bounds (parsed Content-Range) -- the web adapter then serves plain range requests in a single round-trip with no validating HEAD (S3, Azure, R2, http, fs, and memory set it; video seeking and PDF.js chunking hit this path constantly). Optional `pinsReads: true` declares that `getObject` enforces `ifMatch` (and the `pin` it issued) itself and throws `ObjectChangedError` when the object changed (S3, Azure, R2, GCS and memory set it). A store that ignores `ifMatch` leaves it unset and must report the same validator from `getObject` that `headObject` reported: the response-side guard compares them, and a read with nothing to compare is served without the HEAD's ETag and digest.

**`createSignedUrl(key, { expiresInSeconds, downloadFilename?, cacheControl?, signal? })`** -> `Promise<{ ok: true; url: string } | { ok: false; error: string; code?: "no-credential" | "unsupported"; cause?: unknown }>`. It returns an outcome where every other method on the interface throws, and the asymmetry is the point: DECLINING and FAILING are different answers a caller acts on differently. `{ ok: false }` says this store cannot sign (no credential configured, a backend without the capability), and the serving path falls back to streaming the bytes itself, which is a correct response and not an error and is not reported. `code` says why in a form a caller can branch on (`"no-credential"`: no signing credential is configured; `"unsupported"`: the backend or this store cannot sign) and may gain a member, so give a `switch` over it a default branch; `cause` carries the underlying error for the store's own diagnostics. `signal` is the request's abort signal, for a signer that makes a network call. A THROWN error says signing was supposed to work and did not, which is reported to `onError` with operation `"sign"` and answered `502`, or `499` when the request had aborted. The built-ins decline as follows: `s3Store` with `unsupported` only when the presigner package cannot be loaded, `azureStore` without a shared-key credential and `gcsStore` without a `client_email` with `no-credential`, and `r2Store` and `httpStore` do not sign. Collapsing the two would turn "no signing configured" into a 502 on every request. Pass `cacheControl` for a private object: without it the redirect target serves whatever Cache-Control was baked in at upload, which a CDN in front of the bucket will honor.

**`ObjectMetadata`** (type) - HEAD response shape: `contentLength`, `etag?`, `lastModified?`, `digest?`, `pin?`, `contentType?`, `contentEncoding?`. `contentEncoding` is the content coding the stored bytes are in (an object uploaded with `--content-encoding gzip`): `contentLength`, validators, digest and ranges then describe the encoded bytes, and the response carries `Content-Encoding`. The four SDK stores and `memoryStore` report it (`httpStore` refuses an encoded origin response instead); a custom store whose client decodes in flight must disable that or refuse the object. `ObjectStream` carries the same field from the GET. **`representationCoding(stored)`** normalizes a stored value for it (IANA-registered codings lower-cased with `x-gzip` as `gzip`, those the store cannot decode passed through under their own name; `undefined` for absent, `identity`, `none`, `aws-chunked`, a MIME transfer-encoding name (`base64`, `binary`, `7bit`, `8bit`, `quoted-printable`) or a value that is plainly not a coding such as a charset name; a `TypeError` for an unregistered token). `contentType` is the media type the backend stored with the object and is informational only: it is never sent as `Content-Type` (a stored type is usually whatever the uploader claimed), and reaches `onServe` and `onTransfer` as `storedContentType`. A custom store may return further fields; only `etag`, `contentLength` and `lastModified` feed the derived ETag.

**`ReadRange`** (type) - The range a store is asked to read, `{ start: number; end: number | undefined }`, inclusive. An `end` of `undefined` means "to the end of the object": the single-round-trip fast path sends it for `bytes=a-`, where the total size is not yet known. The open form is an absent value, and `ObjectStore.getObject` is a function-typed property, so a store typed for a numeric `end` (`range?: ParsedRange`) does not compile and cannot compute `end - start + 1` without first handling it; it emits its backend's idiomatic open form (`bytes=start-`, an offset-only read). A present `end` may lie past the object's end, and the store clamps it and reports the bounds it served. `ParsedRange` is the kernel's validated, always-closed range; it is assignable to `ReadRange`.

**`ObjectNotFoundError` / `ObjectChangedError`** (classes) - Thrown by adapters for a missing object (mapped to 404) and a pinned read whose object changed since validation (mapped to one re-validation, then 502). Matched by `name`, so a custom store can throw equivalently-named errors without importing the classes. The message names the failure, never the key: a key is commonly a user's filename and a message is free text a log prints whole, so the key rides on the `key` field (as it does on `StoreUnavailableError`), where it can be dropped, hashed or redacted by name. A custom store's own errors should follow the same rule.

**`isObjectNotFoundError(err)` / `isObjectChangedError(err)` / `isStoreUnavailableError(err)`** - The name-based matchers for the three read-side store errors, from the package root. Each is a type guard narrowing `unknown` to its class. Use them rather than `instanceof`, which is unreliable across package boundaries: a consumer with two copies of this package in its tree, or a store built against a different install, throws an error that is structurally right and fails the check, while the `name` is stable identity. It is also what lets a custom store throw an equivalently-named error of its own and be recognized.

**`ObjectStream`** (type) - GET response shape: `body` (a `ReadableStream`, or a plain `Uint8Array` when the adapter already holds the exact bytes -- consumers then skip stream machinery entirely), `contentLength`, `totalSize`, `range?` (the `{ start, end }` the backend ACTUALLY served; absent = full content), `etag?`, `lastModified?`, `digest?`.

**`toObjectBody(source)`** / **`ObjectBody`** / **`ObjectBodySource`** (types) - `ObjectStream.body` is typed `ObjectBody`, the `ArrayBuffer`-backed form (`ReadableStream<Uint8Array<ArrayBuffer>> | Uint8Array<ArrayBuffer>`) a consumer can hand straight to `new Response(...)` under `lib: ["DOM"]`. A custom store holding a wider value, any `ObjectBodySource` (`ReadableStream<Uint8Array> | Uint8Array`, which covers a `Buffer` typed over `ArrayBufferLike` and an SDK stream with bare `Uint8Array` chunks), passes it through `toObjectBody` rather than casting. A `SharedArrayBuffer`-backed view is copied into its own `ArrayBuffer`, because that view is the one input `new Response(...)` rejects; an `ArrayBuffer`-backed view and a stream pass through unchanged.

**`classifyStoreRead(key, op, classifiers)`** - The ordered error-classification pipeline the built-in SDK adapters share, exported for custom adapter authors. Runs `op()` and maps its failure to the contract's error types in a fixed precedence: `notFound` -> `ObjectNotFoundError` (404), `changed` -> `ObjectChangedError` (412), `throttled` -> `StoreUnavailableError` (503), otherwise rethrow untouched. Supply one `StoreErrorClassifiers` set and reuse it for both `headObject` and `getObject` so the two paths cannot drift; predicates must be mutually exclusive on a given backend.

**`reservedKeyGuard(prefix, { keys?, foldCase?, maxKeyBytes? })`** -> `(key: string) => void`. Build the refusal a built-in read store applies to its `reservedPrefix`: throws `ObjectNotFoundError` for a key equal to the prefix or under it (with `foldCase`, compared case- and normal-form-folded), and, under the default `keys: "plain"`, for any key that is not plain: one with an empty segment or a dot segment (`.`, `..`, or a percent-encoded spelling of either), with `\` counted as a separator, since such a key can resolve into the reserved namespace wherever a request URL or path is built from it (WHATWG URL Standard, section 4.1). `keys: "verbatim"` skips that second check, and with no prefix the guard enforces only the key policy. `maxKeyBytes` (a positive integer, no limit by default) refuses a longer key, counted in UTF-8 bytes, before any other test, so the guard's cost is bounded by it. `prefix` may be a list, refusing each; empty entries are skipped; a prefix that would reserve nothing throws a `TypeError`. Call it at the top of a custom `ObjectStore`'s `headObject`, `getObject`, and `createSignedUrl` when the store shares a location with a 5.x upload store, so its bookkeeping is not reachable through the read path.

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

## Store conformance (`partial-content/conformance`)

One harness, `checkObjectStore`, for an `ObjectStore`, and the report shape and helpers a backend-specific obligation folds into. It is not a test file and neither needs a test framework: every check is a plain async call against the store's own public surface, so a run works under any runner, in CI, or as a startup self-test against a staging bucket. Checks are independent, so one run reports every gap rather than the first.

It returns `{ ok, checks, passed, failed, skipped }`, where `ok` is `failed === 0`. A **skipped check never makes the report fail, and never counts as passed either**: it is reported as its own outcome (`skipped: true`, with a `detail` saying why) so an unverified guarantee is visible instead of green. Each `ConformanceCheck` carries a stable `name` safe to allow-list against in your own CI, an `obligation` phrased as what the store must do, `ok`, and a `detail` explaining a failure in terms of its consequence rather than its assertion.

**`formatConformanceReport(report)`** -> `string` renders a report as plain `PASS`/`FAIL`/`SKIP` lines plus a tally. It returns the text and prints nothing, so the caller chooses the sink.

**A check that observes nothing cannot report a pass.** Every check body receives an `assert(held, detail)` and reports through it and nothing else; a body that never calls it fails, saying that a pass would have stated nothing about the store. That is structural rather than a review habit, because the failure it prevents is invisible by construction: a check that publishes an object, aborts the upload and then returns without reading anything back looks exactly like one that verified the object survived, and it passes every store including one that deletes its own published data.

**`runConformanceCheck(name, obligation, run)`** and **`tallyConformance(checks)`** are the seam for adding backend-specific obligations to a run under that same rule. Use them when your store guarantees something these harnesses cannot know to ask about, and the result folds into the same report shape:

```typescript
// doc-check: fragment
const extra = await runConformanceCheck(
  "listing-is-stable",
  "two listings of an unchanged prefix agree",
  async (assert) => {
    const first = await listKeys(prefix);
    const second = await listKeys(prefix);
    assert(first.join() === second.join(), "an unchanged prefix listed two different ways");
  },
);
const report = tallyConformance([...(await checkObjectStore(store, { key, content })).checks, extra]);
```

### Read stores (`checkObjectStore`)

**`checkObjectStore(store, opts)`** -> `Promise<ConformanceReport>` runs the read contract against an `ObjectStore`. Two of its obligations are the ones a custom read store most often gets subtly wrong, and neither shows up on the happy path: an honest total size on a partial read, and a not-found that is distinguishable from a failure. A wrong total becomes the `Content-Range` total a client sizes its remaining requests against, and an indistinguishable not-found turns a missing object into a backend error that a caching layer will retry. The harness also reads what the serving path turns into response headers: the served span of a window (the `Content-Range` bounds), the total on a full read, the digest on a ranged read, HEAD-versus-GET validator agreement, HEAD-versus-GET `contentEncoding` agreement, a read pinned to a validator the object does not carry (it must throw `ObjectChangedError`, or name the representation it served; a store declaring `pinsReads` must throw), and, for a store claiming `authoritativeRange`, an open-ended range and a past-EOF end. Every check races a deadline and fails as "did not settle" rather than hanging the run.

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
- **`timeoutMs`** (default `10000`) - how long one check may run before it fails as "did not settle". A store whose call or body never ends would otherwise hang the run, a startup self-test included.

<!-- generated:read-store-checks -->
The 12 checks, by what they pin:

| Check | Obligation | Skipped when |
|---|---|---|
| `head-reports-the-true-length` | headObject must report the object's exact byte length | never |
| `full-read-returns-every-byte` | getObject with no range returns the whole representation and its total size | never |
| `get-validators-agree-with-head` | the validators a read reports name the same representation as the HEAD's | never |
| `pinned-read-serves-the-heads-representation` | a read pinned with the HEAD's own ifMatch and pin serves that representation | the store reports neither a strong ETag nor a pin, so there is nothing to pin a read to |
| `mismatched-pin-is-refused-or-named` | a read pinned to a validator the object does not carry is refused, or names what it served | the store reports no ETag or Last-Modified, so a read has no validator to be mistaken for |
| `missing-object-is-not-found` | an absent key must throw ObjectNotFoundError, distinguishably from a failure | never |
| `missing-object-is-not-found-on-read` | getObject on an absent key, whole or ranged, must throw ObjectNotFoundError, since a plain GET reads with no HEAD first | never |
| `range-serves-the-requested-window` | a ranged read returns exactly the requested bytes | supportsRange: false, so the serving path never asks this store for a window; or the sample object is too short to slice a meaningful window from |
| `range-reports-an-honest-total` | a ranged read reports the whole representation's size, or undefined when it cannot know | supportsRange: false, so the serving path never asks this store for a window; or the sample object is too short to slice a meaningful window from |
| `open-ended-range-reads-to-the-end` | a range with no end reads to the last byte | supportsRange: false, so the serving path never asks this store for a window; or the sample object is too short to slice a meaningful window from; or authoritativeRange is not claimed, so the serving path resolves every range against a HEAD |
| `past-eof-end-is-clamped` | a range ending past the last byte is clamped to it | supportsRange: false, so the serving path never asks this store for a window; or the sample object is too short to slice a meaningful window from; or authoritativeRange is not claimed, so the serving path resolves every range against a HEAD |
| `digest-is-the-whole-representation` | any digest reported is the raw base64 SHA-256 of the whole object, never of a window | never |
<!-- /generated:read-store-checks -->

Skips keep an unverified obligation from reading as a met one. A store declaring `supportsRange: false` has the two range checks **skipped rather than passed**, since the serving path never asks it for a window; the same happens when `content` is under 4 bytes, which is too short to slice a meaningful window from. `digest-is-the-whole-representation` is not among them: a store that reports no digest passes it, because absent is a legitimate answer, and what the check refuses is a digest that is malformed or computed over anything but the whole representation.
