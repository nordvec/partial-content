# Changelog

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
