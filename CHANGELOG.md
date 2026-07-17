# Changelog

## 2.3.1 (2026-07-17)

Documentation only; no code change from 2.3.0. Corrects changelog and
doc wording. Prefer this over 2.3.0.

## 2.3.0 (2026-07-17)

Operational hardening for self-hosted and multi-instance deployments: CORS,
reverse-proxy body streaming, honest capability advertising, and safer failure
modes on the filesystem and S3 stores.

### Added
- **`TUS_EXPOSED_HEADERS` / `UPLOAD_EXPOSED_HEADERS`**: the exact response
  headers a cross-origin browser upload must be allowed to read, published as
  frozen `string[]` for `Access-Control-Expose-Headers`. The package ships no
  CORS middleware (the policy is yours), but assembling this list by hand is
  the step that silently drops `Upload-Offset` and breaks every resume.
- **`isInlineSafeMediaType(mediaType)`**: an allow-list predicate for choosing
  `inline` vs `attachment` when serving untrusted content, excluding the
  script-capable types (`text/html`, `image/svg+xml`, `application/pdf`) that
  a deny-list forgets. Stored-XSS hardening for the download path.
- **`docs/DEPLOYMENT.md`**: reverse-proxy configuration (nginx/Apache/Caddy)
  that streams `PATCH` bodies instead of buffering them (the most common
  self-host failure), CORS, multi-instance locking, and object-storage part
  limits.

### Changed
- **Honest extension advertising.** The tus handler advertises the
  `expiration` extension on `OPTIONS` only when a max age is configured;
  claiming it with nothing to expire was a false capability.
- The filesystem store retries transient file-open failures (`EMFILE`,
  `ENFILE`, `EBUSY`, `EAGAIN`) with a short backoff, so a momentary share
  violation on a network volume, or descriptor exhaustion under load, no
  longer sinks a whole `PATCH`. The `wx`/`r+` open semantics are unchanged
  (a real collision or missing file still fails on the first attempt).

### Fixed
- The S3 store now fails loudly at the append that would cross S3's 10,000-part
  limit, naming the `minPartSize` knob to raise, instead of letting
  `CompleteMultipartUpload` reject the finished object with an opaque error.
  (The R2 store already guarded this.)

## 2.2.0 (2026-07-17)

### Added
- **tus checksum extension** (opt-in via `checksum` on `createTusHandler`):
  `Upload-Checksum` verified per request, advertised via `Tus-Extension` and
  `Tus-Checksum-Algorithm`. A checksummed request is buffered (hard-capped;
  construction refuses an unbounded buffer), verified, and only then
  appended, so a mismatch (`460 Checksum Mismatch`) leaves durable state
  untouched, the only honest reading of the extension's
  discard-on-mismatch. Hashing is caller-injected (`TusChecksumOptions`);
  `webCryptoChecksum()` ships ready-made `sha1`/SHA-2 over `crypto.subtle`
  on every supported runtime. Unconfigured, an unsolicited `Upload-Checksum`
  is ignored, mirroring the completion-digest posture for assertions nothing
  can verify.
- **`partial-content/redis-locker`**: multi-instance upload locking over any
  Redis-protocol server (Redis, Valkey, KeyDB, Dragonfly) with the same
  cooperative-preemption semantics as the in-process locker. Zero
  dependencies: the caller passes a client behind a four-command interface
  (`RedisLockerClient`). `SET NX PX` with a per-acquire fencing id, watchdog
  renewal at ttl/3 (a renewal that cannot confirm the hold preempts the
  holder), waiter-republished preempt pub/sub (level-triggered, so a
  subscribe-gap request is never lost), and compare-and-delete release that
  can only ever release its own hold.

### Changed
- **The PATCH/append hot path costs one state read instead of three.** The
  tus dialect no longer pre-probes before every PATCH: implicit-completion
  inference moved into the orchestrator (`AppendUploadRequest.complete`
  accepts `"infer"`), computed against the fresh state read under the
  append's own lock, which is also strictly more accurate than a pre-probe
  whose answer can go stale before the lock. And a clean append no longer
  re-reads state afterwards: the store contract pins `getUploadState` to
  agree with the write's own return, so the outcome derives from it; only an
  interrupted write still re-reads for the durable prefix.

Resumable-upload hardening from an external adversarial review of the
protocol core and both wire dialects. Every fix is additive or a bug fix; no
breaking changes.

### Fixed
- **Deferred-length uploads now work end to end.** A length first declared on
  a later append (tus `creation-defer-length`, or `Upload-Length` on an IETF
  PATCH) is persisted durably by every write store, so the upload completes,
  the length becomes immutable, and HEAD stops reporting a deferred length
  forever. Previously such uploads stranded and could not complete.
- **IETF append completeness fails closed.** An absent or malformed
  completeness header on an append is no longer treated as "completing"
  (which could publish a truncated object): it is a 400 where the revision
  requires the header (interop 5/6) and treated as incomplete where it does
  not (interop 3), never as complete.
- **Cooperative preemption is level-triggered.** A preempt that arrives
  during lock handover or before a write starts is no longer lost, so a
  contended resume hands over in milliseconds instead of waiting out the lock
  timeout.
- **Unverifiable client digests are ignored, not refused.** A `Repr-Digest` a
  store cannot verify (non-sha256 backends) is dropped per RFC 9530 rather
  than answered with a false integrity-mismatch error.
- **`minSize` is enforced at completion**, closing a bypass where a
  deferred-length upload could publish under the floor.
- **Creation runs under the resource lock**, so a client resuming via an
  early `Location` cannot race a still-flushing creation.
- **tus HEAD heals an implicit completion**: an upload whose completing
  request died after its bytes were durable is published on the next probe
  instead of remaining a permanently unpublished 404.
- The IETF `Location` header is sanitized; raw upload tokens are kept off
  error messages (they remain on the error property); `Upload-Expires` is an
  absolute deadline a long append cannot inflate.

### Added
- `AppendChunkOptions.length`: the write-store contract field carrying a
  late-declared length for adapters to persist.
- Construction-time validation: `createUploadOrchestrator` throws on a policy
  with NaN/negative/fractional bounds or inverted floor/ceiling pairs, and on
  a store reporting `atomicCompletion: false`.
- `createUploadOrchestrator` and the write-store contract types are now
  re-exported from both `partial-content/tus` and `partial-content/upload`
  (via a shared module), so custom stores and dialects need no internal
  import paths.

### Changed
- Capability-flag docs corrected to describe what the orchestrator actually
  requires: stores must accept any append size and buffer internally;
  `exactOffsetRecovery: false` means a resume may re-send its last chunk (a
  durable lower bound), never corruption.

## 2.0.0 (2026-07-16)

The write side. One resumable-upload engine, two wire dialects, and write
support across every storage adapter, alongside the existing read-side
serving. Built to the tus 1.0 spec and the current IETF resumable-uploads
draft, and to the write primitives each storage backend actually provides.

### Added
- **`partial-content/tus`**: a tus 1.0 server handler (`createTusHandler`)
  speaking core + creation + creation-with-upload + creation-defer-length +
  termination + expiration. Framework-agnostic (Fetch Request/Response),
  never-throw, hardened error responses.
- **`partial-content/upload`**: an IETF resumable-uploads draft handler
  (`createUploadHandler`) supporting draft interop versions 3, 5, and 6
  (the versions deployed clients actually speak), with the per-version
  completeness-header polarity handled explicitly, 409 offset-mismatch
  responses carrying the correct offset (and problem+json at interop 6),
  and 423 for lock contention as a distinct retry-later signal.
- **Upload engine + orchestrator (shared by both dialects)**: a pure,
  wire-agnostic state machine (offset monotonicity, length immutability,
  limit enforcement BEFORE bytes move, expiry, terminal invalidation) under
  an orchestrator that always re-derives state from storage inside the
  resource lock, preempts hung holders cooperatively (the disconnect-resume
  race), grants aborted appends a grace window so received bytes still
  flush, and emits content-free, auditKey-aware upload events.
- **`ResumableWriteStore`** contract with honest per-backend capability
  flags, implemented by every storage adapter: `memoryUploadStore` and
  `fsUploadStore` (fsync-before-ack offsets, atomic rename publish,
  sha-256 verification at completion), `s3UploadStore` (multipart with
  sub-minimum tail buffering, offsets derived from part listings, error
  translation for S3-compatibles), `azureUploadStore` (uncommitted blocks
  with a creation sentinel, byte-exact offset recovery),
  `gcsUploadStore` (object-per-chunk with batched composition, exact
  offsets, stateless recovery), `r2UploadStore` (manifest-tracked parts,
  uniform part size, honest `exactOffsetRecovery: false`).
- Upload policy limits (max/min size, per-append bounds, max age) enforced
  in the engine and advertised per dialect; `sweepExpired` on stores for
  abandoned-upload cleanup.

### Changed (breaking)
- `evaluateConditionalRequest` `opts.method` is typed `"GET" | "HEAD"`
  (writes belong to `evaluateConditionalWrite`).
- `preferSignedUrl` receives `method: "GET"` only (HEAD never offloads).
- `onError` `operation` union gains `"sign"`: signed-URL minting failures
  report truthfully instead of as `"get"`/`"head"`.
- The onServe/onTransfer hooks are deliberately UNCHANGED: grant-time and
  settle-time events have different lifecycles, and unifying them was
  evaluated and rejected.

### Fixed
- `s3UploadStore` checksum posture: multipart SHA-256 checksums are
  composite-only, so the `checksums` option provides per-part transport
  integrity (verified at part-upload time, restated at completion) and
  `digestOnComplete` is honestly `false`; whole-object digest assertions
  are refused loudly instead of laundered.

## 1.5.0 (2026-07-16)

Gap-removal release from a full-package adversarial audit (protocol core,
serving layer, all seven storage adapters, RFC-currency re-verification
against the live spec texts, and a compliance-mapping review).

### Fixed
- `httpStore` builds request headers through a `Headers` instance:
  case-variant consumer spellings of the reserved fields (`accept-encoding`,
  `range`, `if-match`) are now REPLACED instead of merged. Previously a
  lowercase `accept-encoding` in `opts.headers` survived alongside the
  adapter's `Accept-Encoding: identity` and fetch joined the duplicates
  ("gzip, identity"), letting the origin compress and every request then
  fail through the non-identity guard. Consumer `Range`/`If-Match` values
  are cleared on requests that carry neither.
- `Want-Content-Digest` and `Want-Repr-Digest` now negotiate fully
  independently (RFC 9530 Section 4), in the kernel orchestrator and the
  web adapter both: declining `Repr-Digest` no longer suppresses a wanted
  `Content-Digest` on a full 200.
- Range-incapable stores with `createSignedUrl` no longer redirect
  unconditionally: HEAD serves real metadata headers, conditional requests
  revalidate at the origin (304/412 from real validators), and only a
  body-bearing GET answers 302, so client caching works again on these
  stores. Plain GETs keep the zero-round-trip immediate redirect.
- `preferSignedUrl` never consults the predicate for HEAD: a metadata probe
  answered with a bare 302 defeats exactly the clients that send HEAD
  (PDF.js size probing).
- `buildMultipartHeaders` enforces the same bounds contract as
  `buildRangeResponseHeaders` (RangeError on inverted/negative/past-EOF
  parts and on the OPEN_ENDED sentinel) and rejects boundaries outside the
  RFC 2046 grammar instead of interpolating them into header + framing.
- `decodeGcsPin` validates what its hostile-token defense claims: negative
  or fractional sizes, non-string validators, and malformed digests in a
  forged pin now fall back to revalidation.
- Signed-URL redirect failures report `operation: "head"` for HEAD requests.

### Added
- `auditKey` (`ServeContext` field; extractor on the node and hono
  adapters): an opaque identifier substituted for the storage key in every
  `onServe`/`onTransfer`/`onError` event, keeping filename-bearing keys
  (personal data) out of consumer logs while the store reads by the real key.
- `createSignedUrl` on `gcsStore` (V4 signed READ URLs; GCS offers no
  Cache-Control response override, documented) and `azureStore` (read-only
  SAS with disposition/type/cache-control response overrides), so
  `preferSignedUrl` egress offload works on all three cloud stores.
- `digestMetadataKey` on `gcsStore`: surfaces a caller-stored raw-base64
  SHA-256 from custom object metadata as the RFC 9530 digest (GCS has no
  native SHA-256; `x-goog-hash` is crc32c/md5 only).
- `httpStore` refuses a bodyless response that declares a non-zero
  Content-Length instead of serving a clean-looking empty stream.
- The fs hot-object cache's byte-budget eviction skips metadata-only
  entries (they free zero bytes); stat-elision entries now survive body
  pressure and are bounded by the entry cap alone.

### Docs
- `gcsStore` signature corrected in the API reference (`{ storage, bucket }`).
- The `ObjectMetadata.digest` contract no longer instructs an impossible
  GCS mapping; it points at `digestMetadataKey` and names the fields that
  really are SHA-256s.
- Scope section updated: encoding negotiation over stored siblings is in
  scope (shipped in 1.2.0); the non-goal is serve-time compression.
- RFC 8941 citations annotated: RFC 9530 pins to 8941 by DOI, so they must
  not be "modernized" to RFC 9651.
- Compliance table: integrity verification cites GDPR Art. 32 (CC6.1 is a
  logical-access control and was the wrong citation); the `nosniff` row no
  longer cites SOC 2 CC6.6 (a network-boundary control); new log
  data-minimization row for `auditKey`.
- Option-precedence table for the serve handler's routing options.

## 1.4.0 (2026-07-12)

- `fsStore` and `memoryStore` now declare `authoritativeRange`: plain range
  requests (no conditionals, no `If-Range`) serve in a single round-trip with
  no validating HEAD. Both adapters already satisfied the contract -- the fs
  store stats, clamps, and reads from ONE open handle (bounds, validators,
  and bytes are coherent by construction; a start beyond EOF is rejected
  natively and becomes a correct 416 via the fallback path), and a memory
  read is atomic by definition. This removes the extra stat on the hottest
  local-serving path (media seeks, PDF.js chunked loading) and makes ranged
  serving MORE coherent, not less: one handle is a true pin, where
  HEAD-then-GET needed the drift guard.
- New fuzzed totality suite for the adapter's never-throw contract
  (`fast-check` over `serveObjectRaw`): arbitrary methods, adversarial
  protocol-header soup (malformed ranges, header-splitting attempts, control
  bytes, hostile qvalues), and arbitrary filename/MIME contexts must always
  resolve to structurally sound response parts -- integer status, CR/LF/NUL-free
  header names and values, numeric Content-Length, bodyless HEAD.
- Mutation-testing floor for `web.ts` (83; baseline 85.07 after a
  survivor-driven sweep added 35 behavior-pinning tests).

## 1.3.0 (2026-07-12)

- `accessControlExposeHeaders` serve option (+ exported
  `PROTOCOL_EXPOSE_HEADERS`): one flag exposes the protocol's
  non-CORS-safelisted response headers (`Accept-Ranges`, `Content-Range`,
  `Content-Encoding`, `ETag`, `Content-Disposition`, digest fields,
  `Server-Timing`) so cross-origin readers like pdf.js stop silently
  degrading to full downloads.
- Mutation-testing floors for the 1.2.0 modules (`encoding.ts` 86,
  `cache-control.ts` 96).

Docs: "Behind a CDN" interop guide (verified against vendor docs,
July 2026) covering which CDNs forward ranges vs fetch-and-slice, the
Content-Length requirement for edge 206s (and the Bun chunked-stream
interaction), Accept-Encoding normalization (`.zst` unreachable through
Cloudflare/CloudFront defaults), Cloudflare's strong-ETag downgrade on
encoding mismatch, RFC 5861 support at Fastly, pdf.js identity-coding
requirements, and the `Access-Control-Expose-Headers` list cross-origin
range/digest readers need.

## 1.2.0 (2026-07-10)

Feature release: content-coding negotiation, per-request egress offload, and
serving-policy primitives.

### Precompressed variant negotiation
- `precompressed: true | ["br", "zstd", "gzip"]` on the serve options: probes
  `<key>.br` / `<key>.zst` / `<key>.gz` siblings, negotiates via
  `Accept-Encoding` (RFC 9110 12.5.3 with real qvalue handling, `*`, and
  `identity` preference), and serves the variant with `Content-Encoding` +
  `Vary: Accept-Encoding`.
- The variant is treated as its own representation end to end: its validators
  drive 304/If-Range, its size drives Range/416 bounds (`Content-Range`
  describes the encoded bytes), its digest rides `Repr-Digest`, and the
  TOCTOU pin + drift guard apply to it. Selection only -- the library never
  compresses at serve time (that would corrupt ranges and digests).
- Negotiation is gated on compressible MIME types (new `isCompressibleMime`)
  and skipped for multi-range requests, which serve the identity bytes.
  Probe failures other than not-found fall back to identity and report to
  `onError`.
- New kernel exports: `parseAcceptEncoding`, `negotiateEncoding`,
  `isCompressibleMime`.

### Serving policy
- `preferSignedUrl` predicate: per-request 302 offload to `createSignedUrl`
  for stores that support it (e.g. proxy ranges + revalidations, redirect
  full-file downloads). `signedUrlExpiresSeconds` configures the lifetime.
- `createSignedUrl` gains a `cacheControl` response-override, honored by the
  S3 adapter (`response-cache-control`), so a private document redirected to
  the bucket origin cannot be cached under the object's baked-in public
  Cache-Control. The contract now documents the STS-credential expiry cap
  and the CloudFront canned-policy `filename*` trap.
- `buildCacheControl()`: typed Cache-Control composer (RFC 9111 + RFC 5861
  `stale-while-revalidate`/`stale-if-error`) with validation and a
  `no-transform` default -- intermediary transforms break byte-exact ranges,
  digests, and strong validators.

### Hardening
- Active content served `inline` (`image/svg+xml`, `text/html`,
  `application/xhtml+xml`, XML) automatically carries
  `Content-Security-Policy: sandbox`; caller `securityHeaders` overrides.
  `nosniff` never stopped a genuine SVG from executing its embedded script.

### Monorepo/tooling
- The `bun` export condition now points at the TypeScript source: Bun
  runtimes (and Bun-workspace consumers) execute `src/` directly, so a stale
  `dist/` build can never be served or tested.

## 1.1.0 (2026-07-10)

RFC compliance sweep re-verified against the current spec texts (RFC 9110,
9530, 8941, 6266/8187), plus hardening and observability parity.

### Kernel
- `evaluateConditionalRequest` accepts `opts.method`: `"HEAD"` ignores
  `Range`/`If-Range` (RFC 9110 14.2) and suppresses `Content-Digest`
  (RFC 9530 B.2: a HEAD transfers no content).
- `If-Range` HTTP-dates now enforce the 13.1.5 step-1 strong-validator rule:
  a Last-Modified whose second has not fully elapsed never authorizes a
  range resume.
- `parseRanges`: parts are returned in REQUEST order (15.3.7.2 SHOULD), gaps
  smaller than the ~80-byte part overhead coalesce (15.3.7.2 MAY), and a
  single coalesced range serves as a plain 206 instead of degrading to 200.
- Digest layer: values that are not the raw base64 of a 32-byte SHA-256 are
  never emitted; `Want-Repr-Digest` and `Want-Content-Digest` negotiate
  independently (new `clientWantsContentDigest` export) with RFC 8941
  last-wins duplicate keys.
- `build416Headers` / `buildRangeResponseHeaders` validate bounds: `NaN`
  totals and the `OPEN_ENDED` sentinel can no longer serialize into
  `Content-Range`.
- `fromNodeHeaders` uses a null-prototype map (a literal `__proto__` request
  header cannot poison lookups).

### Serving adapters
- 304 responses carry the caller's `securityHeaders` output, so a caller-set
  `Vary` satisfies the RFC 9110 15.4.5 MUST-generate list.
- HEAD-to-GET validator drift guard: on stores that cannot pin reads, a
  partial response whose GET validators disagree with the validating HEAD
  re-validates once instead of splicing bytes across representations.
- multipart/byteranges: honors `Want-Repr-Digest`, reports
  `Server-Timing`/`onTiming`, and verifies each part's actual byte count
  against the committed framing.
- `supportsRange: false` stores without a signed URL now serve the full
  representation with `Accept-Ranges: none` instead of failing 502;
  signed-URL provider rejections and declines are reported to `onError`.
- OPTIONS answers `204` + `Allow`; the disposition type is coerced on the
  no-filename path; new `etag: false` option for deployments with unstable
  derived validators; node adapter is generic over the request type
  (`serveObject<express.Request>`) and reports extractor failures to
  `onError` (`operation: "context"`).

### Store adapters
- `http`: bodies are guarded against silent truncation (`guardStreamLength`);
  `Repr-Digest` extraction is a linear scan (no backtracking regex).
- `fs`: Windows reserved-device check covers trailing dots/spaces and
  superscript COM/LPT digits; the small-read path loops on legal short reads.
- `s3`/`gcs`: throttle classifiers surface the backend's `Retry-After` hint.
- `mime`: null-prototype lookup map (`lookupMime("x.constructor")` is
  `undefined`, not a function).

### Content-Disposition
- Invisible-character stripping extended (U+00AD, U+061C, U+180E,
  U+2060-2064, U+FEFF, U+FFF9-FFFB).
- ASCII fallbacks fold NFKD-decomposable letters to base letters
  ("Årlig" -> "Arlig") before `?`-replacement.
- Filenames containing a double quote gain a `filename*` companion
  (RFC 6266 Appendix D: quoted-pair alone is unreliable across clients).

## 1.0.1 (2026-07-06)

Docs-only release, no code changes.

- README restructured around evaluation flow: quick starts, comparison, and design summary up front.
- Deep-dives moved into the shipped `docs/` folder: full API reference (`docs/API.md`), framework/kernel recipes (`docs/EXAMPLES.md`), and the complete benchmark methodology (`docs/BENCHMARKS.md`).
- The npm tarball now includes the whole `docs/` folder (previously only `DESIGN.md`).

## 1.0.0 (2026-07-06)

Initial public release. Zero-dependency, ESM-only HTTP file-serving protocol layer for any storage backend.

### Kernel (`partial-content`)
- `evaluateConditionalRequest` / `evaluateConditionalWrite`: full RFC 7232/7233/9110 evaluation chain (412 > 304 > If-Range > Range) and write-side OCC.
- Range parsing with `multipart/byteranges` for multi-range requests, overlapping/adjacent coalescing, and range-amplification defense (`maxRanges`).
- ETag generation (strong content-hash, weak size+mtime, safe `undefined` fallback) with sub-second timestamp flooring.
- RFC 9530 `Repr-Digest` / `Content-Digest` with `Want-*` negotiation.
- `buildContentDisposition`: RFC 6266/8187 with CRLF-injection, path-traversal, and bidi-override hardening.

### Storage adapters
- `/s3` (AWS S3, R2 S3-mode, Hetzner, MinIO, Wasabi), `/r2` (native bindings), `/gcs`, `/azure`, `/fs`, `/http` (any range-capable origin), `/memory`.
- `/fs`: opt-in hot-object cache: TTL revalidation, coherent metadata + small-body capture, LRU eviction under both an entry cap (`maxEntries`) and a body byte budget (`maxBytes`; `0` = metadata-only).
- Atomic pinned reads (TOCTOU elimination) via each backend's native conditional read; `authoritativeRange` single-round-trip fast path for media seeking.
- Backend failures map to truthful status: `404` (not found), `503` + `Retry-After` (transient throttle/overload, `StoreUnavailableError`; the `/azure` and `/http` adapters surface the backend's advised `Retry-After`), `502` (malformed upstream).
- `classifyStoreRead` + `StoreErrorClassifiers`: the shared error-classification primitive, exported for custom adapters; a throttle classifier may return `{ retryAfterSeconds }` to propagate a back-off hint.
- `guardStreamLength`: wrap a web `ReadableStream` so a graceful short read errors the body instead of under-running the committed `Content-Length`.
- `resolveServedRange`: parse a backend `Content-Range` into served bounds + honest total (the `bytes a-b/*` unknown-total sentinel maps to `undefined`), the shared primitive behind the S3/Azure/HTTP adapters.

### Runtimes

- Verified in CI on Node, Bun, and Deno (a runtime-agnostic smoke suite over the built package); Cloudflare Workers via the `/r2` adapter's Fetch-standard surface.

### Framework adapters
- `/web` (Fetch API: Next.js, SvelteKit, Remix, Workers, Bun, Deno), `/node` (Express, Fastify, Koa, raw http) with a bounded backpressure stall timeout, `/hono`.

### Security
- `nosniff`, `charset=utf-8` enforcement on textual types, `default-src 'none'` CSP on error responses, CORP, forced-`attachment` signed URLs, SSRF-safe redirect-error default on the http store.
