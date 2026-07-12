# Changelog

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
serving-policy primitives, informed by a sweep of production file-serving
implementations.

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
- `/fs`: opt-in hot-object cache (nginx `open_file_cache` semantics): TTL revalidation, coherent metadata + small-body capture, LRU eviction under both an entry cap (`maxEntries`) and a body byte budget (`maxBytes`; `0` = metadata-only).
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
