# partial-content

[![npm version](https://img.shields.io/npm/v/partial-content.svg)](https://www.npmjs.com/package/partial-content)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/partial-content)
[![ci](https://github.com/nordvec/partial-content/actions/workflows/ci.yml/badge.svg)](https://github.com/nordvec/partial-content/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6.svg)](https://www.typescriptlang.org/)

RFC-compliant HTTP file serving for any storage backend. Range requests, conditional caching, Content-Disposition, ETag generation, and complete storage adapters in one zero-dependency kernel.

```
npm install partial-content
```

### The problem

When your app proxies files from object storage, browsers expect your server to speak the full HTTP file-serving protocol: range requests for video seeking, conditional requests for cache validation, Content-Disposition for safe downloads. Today you need three or four packages to get there, and none of them handle the orchestration:

| | Range parsing | Conditional requests | Content-Disposition | Repr-Digest | Orchestration | Storage agnostic |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **partial-content** | **Yes** | **Yes** (304, 412) | **Yes** (RFC 8187) | **Yes** (RFC 9530) | **Yes** | **Yes** |
| `range-parser` | Yes | -- | -- | -- | -- | Yes |
| `fresh` | -- | 304 only | -- | -- | -- | Yes |
| `content-disposition` | -- | -- | Yes | -- | -- | Yes |
| `send` | Yes | Yes | Yes | -- | Yes | **No** (local fs only) |

`partial-content` is the **protocol layer without the I/O layer**. You bring the bytes from wherever they live, or use a built-in storage adapter.

```
            Request
               │
               ▼
  evaluateConditionalRequest()
               │
               ├──► 200 OK
               ├──► 206 Partial Content
               ├──► 304 Not Modified
               ├──► 412 Precondition Failed
               └──► 416 Range Not Satisfiable
               │
               ▼
       Your storage backend
```

## Architecture

One package. Subpath exports. Install only the SDKs you use.

```
partial-content              Zero-dep kernel (RFC 7232/7233/9110 evaluation)
partial-content/web          Fetch API handler (Next.js, SvelteKit, Remix, Workers)
partial-content/s3           AWS S3, R2 (S3 mode), Hetzner, MinIO, Wasabi
partial-content/r2           Cloudflare R2 native bindings (no AWS SDK)
partial-content/gcs          Google Cloud Storage
partial-content/azure        Azure Blob Storage
partial-content/fs           Local filesystem (Node.js)
partial-content/node         Node.js http/Express/Fastify adapter
partial-content/hono         Hono middleware
partial-content/http         Any range-capable HTTP origin (Supabase, presigned URLs, CDNs)
partial-content/memory       In-memory store (tests, demos, embedded assets)
partial-content/mime         Curated zero-dep MIME lookup
```

Cloud SDKs are **optional peer dependencies**: `@aws-sdk/client-s3` for `/s3` (plus `@aws-sdk/s3-request-presigner` only if you use `createSignedUrl()`), `@google-cloud/storage` for `/gcs`, `@azure/storage-blob` for `/azure`, `hono` for `/hono`. The kernel, `/web`, `/node`, `/fs`, `/http`, `/r2`, `/memory`, and `/mime` need nothing beyond the platform.

## Features

- **One call does everything**: `evaluateConditionalRequest()` handles the complete evaluation chain (412 > 304 > If-Range > Range) in correct order
- **Write-side OCC**: `evaluateConditionalWrite()` handles If-Match/If-None-Match for PUT/PATCH/DELETE with correct 412 semantics
- **RFC 9530 Repr-Digest**: End-to-end integrity verification via `sha-256=:<base64>:` header, with `Want-Repr-Digest` negotiation -- first-class support that `send`, `sirv`, and the framework static middlewares lack
- **Built-in storage adapters**: S3-compatible (AWS, R2 S3-mode, Hetzner, MinIO, Backblaze, Wasabi), R2 native, GCS, Azure, local filesystem, any range-capable HTTP origin, in-memory
- **Built-in framework adapters**: Fetch API (Next.js, SvelteKit, Remix, Nuxt, Astro, Workers, Bun.serve, Deno.serve), Node.js (Express/Fastify/Koa/raw http), Hono
- Range requests (206, 416), including multi-range `multipart/byteranges` with overlapping/adjacent-range coalescing and range-amplification defense (`maxRanges`)
- Conditional requests (304, 412) with sub-second timestamp flooring
- ETag generation from storage metadata (strong for content hash, weak for size+mtime, safe undefined fallback)
- Content-Disposition with non-ASCII filename encoding, CRLF injection prevention, path traversal protection, and bidi spoofing defense
- Published `ObjectStore` interface for building custom storage adapters against a stable contract
- Pure functions, zero I/O, zero dependencies; the hot path constructs no fetch primitives, no stream machinery for small bodies, and re-parses no dates
- ESM-only. Works across Node.js 20+, Bun, Deno, Cloudflare Workers, and edge runtimes

## Quick Start

The handler manages the full HTTP protocol (200, 206, 304, 412, 416, HEAD) automatically: combine a storage adapter with a framework adapter.

### Next.js / SvelteKit / Remix (Fetch API)

```typescript
import { serveObject } from "partial-content/web";
import { s3Store } from "partial-content/s3";
import { S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({ region: "eu-central-1" });
const store = s3Store({ client, bucket: "documents" });
const handler = serveObject(store, { disposition: "inline" });

// Next.js App Router
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handler(req, { key: params.id, mime: "application/pdf" });
}
export const HEAD = GET;
```

### Express / Node.js

```typescript
import express from "express";
import { serveObject } from "partial-content/node";
import { fsStore } from "partial-content/fs";

const store = fsStore({ root: "/var/data/uploads" });
// Hot small files? Opt into the bounded TTL cache (see Benchmarks):
// fsStore({ root, cache: { ttlMs: 1000 } })
const app = express();

app.get("/files/:key", serveObject(store, {
  key: (req) => req.params.key,
  disposition: "inline",
}));
```

### Kernel only (bring your own I/O)

```typescript
import { evaluateConditionalRequest } from "partial-content";

const { status, headers, range } = evaluateConditionalRequest(
  request.headers,
  {
    totalSize: fileSize,
    contentType: "video/mp4",
    etag: '"abc123"',
    lastModified: "2025-06-28T12:00:00.000Z",  // ISO 8601 normalized automatically
  },
);

if (status === 304 || status === 412 || status === 416) {
  return new Response(null, { status, headers });
}

// `range` is a kernel-validated ParsedRange -- pass it straight to your store.
const { stream } = range
  ? await store.getObject(key, { range })  // 206: only the requested slice
  : await store.getObject(key);         // 200: the whole object

return new Response(stream, { status, headers });
```

More recipes in **[docs/EXAMPLES.md](docs/EXAMPLES.md)**: Hono, Cloudflare Workers (R2 native), kernel-only Express, Content-Disposition, Repr-Digest, and the manual step-by-step primitives.

## Real-world example: authorized proxy from object storage

A common pattern when serving private files from object storage: you proxy file requests through your own server so every request is authorized and audited, then stream the bytes with full range and conditional-request support.

Use this library when your application **must** proxy file requests (authorization, auditing, tenant isolation, or custom business logic) instead of redirecting clients to signed object-storage URLs:

```typescript
import { serveObject } from "partial-content/web";
import { s3Store } from "partial-content/s3";

const store = s3Store({ client, bucket: "private-documents" });

const handler = serveObject(store, {
  disposition: "inline",
  cacheControl: "private, no-cache",
  // SOC 2 CC7.2 audit trail: bytes GRANTED, at header-commit time.
  onServe: (event) => logger.info({ ...event }, "file.served"),
  // Egress accounting / abandonment: bytes ACTUALLY transferred, once the
  // body settles. `completed === false` means the client disconnected early.
  onTransfer: (event) => meter.recordEgress(event.key, event.bytesTransferred),
  onError: (err, ctx) => logger.error({ err, ...ctx }, "file.error"),
});

async function serveFile(request: Request, key: string) {
  // 1. Authorize on your server. Access control lives in your application:
  //    deny here and not a single byte is read.
  const file = await authorize(request, key); // your code
  if (!file) return new Response("Not found", { status: 404 });

  // 2. One call runs the full RFC 7232/7233 chain: 412, 304, If-Range, Range.
  //    The handler does HEAD, evaluates conditionals, streams bytes, and
  //    builds the correct 200/206/304/412/416 response automatically.
  return handler(request, {
    key: file.path,
    mime: file.mimeType,
    filename: file.filename,
  });
}
```

This is the path behind `<video>`/`<audio>` seeking and PDF.js progressive loading: the media element sends `Range` to **your** origin, you re-check access, and stream just that slice from storage. If you could hand the client a signed URL instead, the storage backend would speak this protocol for you and you wouldn't need a protocol layer -- see [Scope](docs/DESIGN.md#scope) for when this library earns its place.

## API

The full reference lives in **[docs/API.md](docs/API.md)**. The shape of the surface:

- **Kernel** (`partial-content`): `evaluateConditionalRequest` / `evaluateConditionalWrite` (the one-call orchestrators), the step-by-step primitives (`parseRangeHeader`, `parseRanges`, `isConditionalFresh`, `isPreconditionFailure`, `isRangeFresh`, the `build*Headers` family), `generateETag`, `buildContentDisposition`, `clientWantsDigest`, `fromNodeHeaders`, `sanitizeHeaderValue`
- **Serving** (`/web`, `/node`, `/hono`): `serveObject` handlers with `disposition`, `cacheControl` (verbatim passthrough), security headers, `onServe` / `onTransfer` / `onError` / `onTiming` observability hooks, `maxRanges`, and a slow-read stall bound on the Node pump
- **Stores** (`/s3`, `/r2`, `/gcs`, `/azure`, `/fs`, `/http`, `/memory`): ready-made `ObjectStore` implementations with pinned reads and truthful error mapping (404 / retryable 503 + `Retry-After` / 502)
- **Custom adapters**: the published `ObjectStore` contract plus the primitives the built-ins are made of (`classifyStoreRead`, `nodeStreamToWeb`, `guardStreamLength`, `resolveServedRange`)

## Design Decisions

**Multi-range is served as `multipart/byteranges`.** Overlapping and adjacent ranges are coalesced, and a range-amplification defense (`maxRanges`, default 50; plus a "ranges cover the whole file" check) degrades pathological requests to a full 200. The single-range fast path is untouched.

**Weak ETag matching.** Storage providers (S3, R2, GCS) emit `W/` prefixes inconsistently. We strip `W/` for pragmatic matching to avoid false 412s.

**Sub-second timestamp flooring.** Storage backends return ISO-8601 with milliseconds. HTTP dates use whole seconds. All comparisons floor both sides to prevent permanent false-stale results.

**Atomic pinned reads (TOCTOU elimination).** After validating conditionals against HEAD metadata, the web adapter pins the GET to that exact representation via the store's native conditional read (S3 `IfMatch`, R2 `onlyIf.etagMatches`, Azure `conditions.ifMatch`, GCS generation pinning). If the object changes in the HEAD->GET window, the store throws `ObjectChangedError` and the request is re-validated once against the new state. For stores that cannot pin, a response-side guard remains: validators come from the GET response, the emitted 206 bounds come from the backend's actual Content-Range, and a missing Content-Range degrades to 200 (never a lying 206).

**Single-round-trip range serving.** Plain range requests (no conditionals, no `If-Range`) skip the HEAD entirely on `authoritativeRange` stores: one GET, with validators and bounds taken from the response itself -- inherently TOCTOU-atomic, and half the latency on media seeks.

**Store failures map to the truthful status.** Missing object -> `404`. Transiently unavailable backend (throttling/overload) -> `503` + `Retry-After` (`StoreUnavailableError`). Malformed upstream response -> `502`. Every error response carries `Cache-Control: no-store`, `nosniff`, and a `default-src 'none'` CSP.

See [docs/DESIGN.md](docs/DESIGN.md) for full RFC deviation notes, response header matrix, and parsing details.

## Benchmarks

Full HTTP serving vs `send` and `sirv` (Node 24, loopback, out-of-process autocannon, every cell correctness-verified before timing; reproduce with `npm run bench`):

| Scenario | partial-content | + `cache` | send | sirv |
|---|---|---|---|---|
| GET 4 KB (200) | 9,210 req/s | **15,772 req/s** | 6,557 req/s | 7,162 req/s |
| GET 1 MB (200) | 118 req/s | 116 req/s | 117 req/s | 119 req/s |
| Range 64 KB of 1 MB (206) | 1,441 req/s | 1,413 req/s | 1,403 req/s | 1,443 req/s |
| Revalidation (304) | 11,716 req/s | **19,542 req/s** | 10,081 req/s | 23,774 req/s* |

- At payload sizes where file serving actually spends its time (>= 64 KB), all contenders converge on I/O parity.
- Small bodies and revalidations lead `send` and `sirv` even without the cache, while doing strictly more per request (digest negotiation, audit hooks, pinned-read plumbing, storage abstraction).
- The `cache` column is the opt-in fs hot-object cache (nginx `open_file_cache` semantics: TTL revalidation, `maxEntries` + `maxBytes` LRU bounds). \* sirv's 304 figure comes from a boot-time directory snapshot that 404s files created after startup; in the mode that can serve runtime uploads it measures 4,957 req/s.

Kernel micro-benchmarks, the Bun.serve numbers (38k req/s revalidation with cache), and the full fairness notes are in **[docs/BENCHMARKS.md](docs/BENCHMARKS.md)**.

## Security & Compliance

The library surface maps directly to audit requirements for SOC 2 Type II, ISO 27001, and EU regulatory frameworks.

| Requirement | Standard | Feature |
|---|---|---|
| Integrity verification | RFC 9530, SOC 2 CC6.1 | `Repr-Digest` (SHA-256) on 200/206 responses whenever the backend supplies a representation digest (S3 checksummed uploads, `digest` in metadata) |
| Content integrity | RFC 9530 Section 2 | `Content-Digest` on 200 (content = full representation) |
| Digest negotiation | RFC 9530 Section 4 | `Want-Repr-Digest` / `Want-Content-Digest` parsing |
| Audit trail | SOC 2 CC7.2, ISO 27001 A.8.15 | `onServe` callback with structured audit events (bytes granted) |
| Egress accounting / abandonment | operational | `onTransfer` callback with true bytes transferred and a `completed` flag |
| Encoding-sniffing XSS prevention | OWASP | `charset=utf-8` enforcement on textual MIME types |
| MIME-sniffing prevention | OWASP, SOC 2 CC6.6 | `X-Content-Type-Options: nosniff` on every success + error response (`200`/`206`, the `404`/`502`/`503` bodies, and the bodyless `412`/`416` denials); `304`/`302` carry none |
| Header injection prevention | OWASP, CWE-113 | CRLF stripping in ETag, Last-Modified, filename |
| Content-Disposition hardening | RFC 6266, RFC 8187 | Bidi override stripping, path traversal prevention |
| Conditional request compliance | RFC 9110, RFC 7232 | Full precondition evaluation chain (412, 304, 416) |
| Retryable backend failures | RFC 9110 §15.6.4 / §10.2.3 | Transient store throttling/overload maps to `503 Service Unavailable` + `Retry-After` (`StoreUnavailableError`), distinct from `502` for malformed upstream responses |
| OCC for writes | RFC 9110 Section 13.1.2 | `evaluateConditionalWrite` (If-Match, If-None-Match) |
| Range request compliance | RFC 7233 / RFC 9110 §14 | Single- and multi-range (`multipart/byteranges`) serving with TOCTOU guards and range-amplification defense |
| Cross-origin resource policy | CORP | `Cross-Origin-Resource-Policy` header support |
| Performance observability | W3C Server-Timing | `Server-Timing` metrics with `onTiming` callback |
| Cache control | RFC 9111 / RFC 5861 | Verbatim `Cache-Control` passthrough (`s-maxage`, `must-revalidate`, `stale-while-revalidate`, `stale-if-error`); auto-`immutable` for content-addressed keys |

## License

MIT
