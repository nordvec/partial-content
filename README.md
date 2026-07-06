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

Cloud SDKs are **optional peer dependencies**:

```bash
# S3 users
npm install partial-content @aws-sdk/client-s3
# add @aws-sdk/s3-request-presigner only if you use createSignedUrl()

# GCS users
npm install partial-content @google-cloud/storage

# Azure users
npm install partial-content @azure/storage-blob

# Filesystem or kernel only (zero extra deps)
npm install partial-content
```

## Features

- **One call does everything**: `evaluateConditionalRequest()` handles the complete evaluation chain (412 > 304 > If-Range > Range) in correct order
- **Write-side OCC**: `evaluateConditionalWrite()` handles If-Match/If-None-Match for PUT/PATCH/DELETE with correct 412 semantics
- **RFC 9530 Repr-Digest**: End-to-end integrity verification via `sha-256=:<base64>:` header, with `Want-Repr-Digest` negotiation -- first-class support that `send`, `sirv`, and the framework static middlewares lack
- **Built-in storage adapters**: S3, R2 (native), GCS, Azure, local filesystem
- **Built-in framework adapters**: Fetch API (Next.js/SvelteKit/Remix/Workers), Node.js (Express/Fastify/Koa), Hono
- Range requests (206 Partial Content, 416 Range Not Satisfiable), including multi-range `multipart/byteranges` with overlapping/adjacent-range coalescing and range-amplification defense (`maxRanges`)
- Conditional requests (304 Not Modified, 412 Precondition Failed) with sub-second timestamp flooring
- ETag generation from storage metadata (strong for content hash, weak for size+mtime, safe undefined fallback)
- Content-Disposition with non-ASCII filename encoding, CRLF injection prevention, path traversal protection, and bidi spoofing defense
- Published `ObjectStore` interface for building custom storage adapters against a stable contract
- Pure functions, zero I/O, zero dependencies; the hot path constructs no fetch primitives, no stream machinery for small bodies, and re-parses no dates (validators derive once at stat time)
- ESM-only. Works across Node.js 20+, Bun, Deno, Cloudflare Workers, and edge runtimes

### Storage Adapters

| Adapter | Backends | Extra Dependencies |
|---------|----------|--------------------|
| `partial-content/s3` | AWS S3, R2 (S3 mode), Hetzner, MinIO, Backblaze, Wasabi | `@aws-sdk/client-s3` |
| `partial-content/r2` | Cloudflare R2 (native) | None (uses R2 bindings) |
| `partial-content/gcs` | Google Cloud Storage | `@google-cloud/storage` |
| `partial-content/azure` | Azure Blob Storage | `@azure/storage-blob` |
| `partial-content/fs` | Local filesystem | None (Node.js builtins) |
| `partial-content/http` | Supabase Storage, presigned URLs, CDNs, any range-capable HTTP origin | None (global fetch) |
| `partial-content/memory` | In-memory objects (tests, demos, embedded assets) | None |

### Framework Adapters

| Adapter | Works With |
|---------|------------|
| `partial-content/web` | Next.js, SvelteKit, Remix, Nuxt 3, SolidStart, Astro, Fresh (Deno), Elysia (Bun), Cloudflare Workers, Bun.serve, Deno.serve, and any Fetch API runtime |
| `partial-content/node` | Express, Fastify, Koa, NestJS, Angular SSR, raw `http.createServer` |
| `partial-content/hono` | Hono (all runtimes) |
| Kernel only | Anything. Pure functions, zero runtime assumptions. |

## Quick Start

### High-Level: Built-in Adapters

For most applications, combine a storage adapter with a framework adapter. The handler manages the full HTTP protocol (200, 206, 304, 412, 416, HEAD) automatically.

#### Next.js / SvelteKit / Remix (Fetch API)

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

#### Express / Node.js

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

#### Hono

```typescript
import { Hono } from "hono";
import { serveObject } from "partial-content/hono";
import { s3Store } from "partial-content/s3";

const store = s3Store({ client, bucket: "media" });
const app = new Hono();

app.get("/media/:key", serveObject(store, {
  key: (c) => c.req.param("key"),
  cacheControl: "public, max-age=31536000, immutable",
}));
```

#### Cloudflare Workers (R2 native, no AWS SDK)

```typescript
import { Hono } from "hono";
import { serveObject } from "partial-content/hono";
import { r2Store } from "partial-content/r2";

const app = new Hono<{ Bindings: { MY_BUCKET: R2Bucket } }>();

app.get("/files/:key", (c) => {
  const store = r2Store({ bucket: c.env.MY_BUCKET });
  return serveObject(store, { key: (c) => c.req.param("key") })(c);
});
```

### Low-Level: Kernel Only

For custom integrations, use the kernel primitives directly. You control the storage I/O, the kernel handles the protocol.

#### One call does everything

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

```
Request                        evaluateConditionalRequest()
  │                                       │
  │  If-Match / If-Unmodified-Since       ├──► 412 Precondition Failed
  │  If-None-Match / If-Modified-Since    ├──► 304 Not Modified
  │  If-Range + Range                     ├──► 416 Range Not Satisfiable
  │                                       ├──► 206 Partial Content
  │                                       └──► 200 OK
  │
  ▼
Fetch bytes from storage (you control this)
  │
  ▼
new Response(body, { status, headers })
```

#### Node.js / Express (kernel only)

```typescript
import { fromNodeHeaders, evaluateConditionalRequest } from "partial-content";

app.get("/files/:key", (req, res) => {
  const headers = fromNodeHeaders(req.headers);
  const { status, headers: resHeaders, range } = evaluateConditionalRequest(
    headers,
    { totalSize: fileSize, etag, lastModified, contentType },
  );
  res.writeHead(status, resHeaders);
  // ...
});
```

### Content-Disposition

```typescript
import { buildContentDisposition } from "partial-content";

buildContentDisposition("report.pdf");
// => 'attachment; filename=report.pdf'

buildContentDisposition("Årlig_Rapport.pdf");
// => 'attachment; filename="?rlig_Rapport.pdf"; filename*=UTF-8''%C3%85rlig_Rapport.pdf'

buildContentDisposition("slides.pdf", { type: "inline" });
// => 'inline; filename=slides.pdf'

// Handles untrusted input safely
buildContentDisposition("../../etc/passwd");        // Path traversal stripped
buildContentDisposition("evil\r\nX-Injected: yes"); // CRLF injection stripped
buildContentDisposition(null, { fallback: "export.csv" }); // Graceful fallback
```

### RFC 9530 Repr-Digest (End-to-End Integrity)

Pass a SHA-256 digest from your storage backend for automatic `Repr-Digest` headers:

```typescript
const { status, headers, range } = evaluateConditionalRequest(
  request.headers,
  {
    totalSize: fileSize,
    etag: '"abc123"',
    // S3: x-amz-checksum-sha256, GCS: x-goog-hash (sha256 component)
    digest: "d2VsY29tZQ==",  // raw base64 SHA-256
  },
);
// Response headers include: Repr-Digest: sha-256=:d2VsY29tZQ==:
// Same digest on both 200 (full) and 206 (partial) -- covers the full representation
```

### Advanced: Manual Primitives

For full control over the evaluation chain:

```typescript
import {
  parseRangeHeader,
  buildRangeResponseHeaders,
  isConditionalFresh,
  isPreconditionFailure,
  isRangeFresh,
  build304Headers,
  build412Headers,
  build416Headers,
} from "partial-content";

// Step 1: Preconditions (If-Match / If-Unmodified-Since)
if (isPreconditionFailure(reqHeaders, etag, lastModified)) {
  return new Response(null, build412Headers());
}

// Step 2: Freshness (If-None-Match / If-Modified-Since)
if (isConditionalFresh(reqHeaders, etag, lastModified)) {
  return new Response(null, build304Headers(etag, lastModified));
}

// Step 3: Range (If-Range + Range header)
const range = isRangeFresh(reqHeaders, etag, lastModified)
  ? parseRangeHeader(reqHeaders.get("range"), fileSize)
  : null;

if (range === "unsatisfiable") {
  return new Response(null, build416Headers(fileSize));
}

const { status, headers } = buildRangeResponseHeaders({
  totalSize: fileSize, range, contentType, etag, lastModified,
  digest: checksum,          // RFC 9530 Repr-Digest
  cacheControl: "private, no-cache",
});
```

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

## API Reference

### Kernel (`partial-content`)

**`evaluateConditionalRequest(reqHeaders, meta)`** - One-call handler for the full HTTP evaluation chain (GET/HEAD). Returns `{ status, headers, range }`.

**`evaluateConditionalWrite(reqHeaders, meta)`** - One-call handler for write requests (PUT/PATCH/DELETE). Returns `{ proceed: true }` or `{ proceed: false, status: 412, headers }`. The 412 response includes the current `ETag` when available, so the client can resync without a follow-up GET.

**`parseRangeHeader(rangeHeader, totalSize)`** - Returns `{ start, end }`, `"unsatisfiable"`, or `null`.

**`buildRangeResponseHeaders(opts)`** - Build 200 or 206 response headers.

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

### MIME Lookup (`partial-content/mime`)

**`lookupMime(filenameOrExt)`** - Curated, zero-dependency extension -> MIME lookup for documents, media, archives, fonts, and web assets. Case-insensitive, resolves the last dot segment (`archive.tar.gz` -> `application/gzip`), returns `undefined` for unknown types so the caller controls the fallback. `html` is deliberately absent: serving stored uploads as `text/html` is stored XSS, so that decision must be explicit at the call site.

```typescript
import { lookupMime } from "partial-content/mime";

app.get("/files/:key", serveObject(store, {
  key: (req) => req.params.key,
  mime: (req) => lookupMime(req.params.key),
}));
```

### Universal HTTP Store (`partial-content/http`)

**`httpStore({ url, headers?, fetch?, redirect? })`** - Serve from ANY range-capable HTTP origin over plain `fetch`: Supabase Storage, presigned S3/GCS/Azure URLs, CDN origins, or another partial-content server. Pinned reads map to `If-Match` (origin 412 -> `ObjectChangedError`), `Repr-Digest` response headers are extracted, and requests are sent `Accept-Encoding: identity` and any response that still carries a non-identity `Content-Encoding` is refused, so transparent compression can never corrupt byte accounting. Redirects error by default (a hostile origin must not 3xx the store toward internal/metadata IPs); set `redirect: "follow"` for origins that legitimately redirect, paired with a validating `fetch` when keys are untrusted (see SECURITY.md).

```typescript
import { httpStore } from "partial-content/http";

const store = httpStore({
  url: (key) => `${SUPABASE_URL}/storage/v1/object/documents/${key}`,
  headers: { Authorization: `Bearer ${serviceRoleKey}` },
});
```

### Memory Store (`partial-content/memory`)

**`memoryStore({ objects })`** - A spec-faithful in-memory store for consumer test suites, demos, and small embedded assets. Fabricates correct Content-Range values, honors `ifMatch` pinning (mutate the map to simulate overwrites and exercise retry logic), and streams zero-byte objects correctly.

### Web Adapter (`partial-content/web`)

**`serveObject(store, options?)`** - Create a Fetch API handler that serves files from an ObjectStore. Returns `(req: Request, ctx: ServeContext) => Promise<Response>`.

**`serveObjectRaw(store, options?)`** - The same engine returning `RawResponseParts` (`{ status, statusText, headers, body }`) instead of a `Response`, for server adapters that write to their runtime natively (the bundled node adapter uses it). Skips all fetch-primitive construction on the hot path.

Options: `disposition`, `cacheControl`, `immutable`, `securityHeaders`, `crossOriginResourcePolicy`, `timingAllowOrigin`, `timing`, `onTiming`, `onError`, `onServe`, `onTransfer`, `maxRanges`, `enforceCharset`, `fallbackFilename`.

### Node Adapter (`partial-content/node`)

**`serveObject(store, options)`** - Create a Node.js `(req, res) => Promise<void>` handler for Express, Fastify (compat), Koa, and raw `http.createServer`. Extends the web adapter options with `key` (required, extracts the storage key from `IncomingMessage`), `mime?`, and `filename?`.

**`writeStallTimeoutMs?`** (default `60000`) - Bounds how long the streaming pump waits for a single backpressure `drain` before treating the client as stalled and tearing the transfer down (cancel the storage read, destroy the response). A client that stops reading but holds its socket open would otherwise pin a backend storage connection indefinitely (a slow-read attack). Set to `0` to disable and rely on an upstream proxy / socket timeout instead. Only the raw-Node pump needs this; Fetch-runtime backpressure is the platform's own concern.

`ServeContext`: `key` (required), `mime?`, `filename?`, `cacheControl?` (per-request override of the handler-level value, e.g. `immutable` for content-addressed keys next to `private, no-cache` user uploads from the same handler).

`cacheControl` is emitted verbatim on 200/206/304, so any directive vocabulary your CDN or edge understands passes straight through: RFC 9111 `s-maxage` / `must-revalidate` / `proxy-revalidate` and the RFC 5861 resilience directives `stale-while-revalidate` and `stale-if-error`. The library does not synthesize or reorder directives (only appending `immutable` when the `immutable` option is set and it is not already present), so you keep full control of the response caching policy. `Vary` (e.g. `Vary: Accept-Encoding`) rides `securityHeaders` / `extraHeaders`.

### Storage Contract

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

## Design Decisions

**Multi-range is served as `multipart/byteranges`.** Overlapping and adjacent ranges are coalesced, and a range-amplification defense (`maxRanges`, default 50; plus a "ranges cover the whole file" check) degrades pathological requests to a full 200. The single-range fast path is untouched. See DESIGN.md for the framing and the eager-first-part re-validation.

**Weak ETag matching.** Storage providers (S3, R2, GCS) emit `W/` prefixes inconsistently. We strip `W/` for pragmatic matching to avoid false 412s.

**Sub-second timestamp flooring.** Storage backends return ISO-8601 with milliseconds. HTTP dates use whole seconds. All comparisons floor both sides to prevent permanent false-stale results.

**Atomic pinned reads (TOCTOU elimination).** After validating conditionals against HEAD metadata, the web adapter pins the GET to that exact representation via the store's native conditional read (S3 `IfMatch`, R2 `onlyIf.etagMatches`, Azure `conditions.ifMatch`, GCS generation pinning). If the object changes in the HEAD->GET window, the store throws `ObjectChangedError` and the request is re-validated once against the new state -- a stale `If-Range` then correctly yields a full 200 of the new bytes. For stores that cannot pin, a response-side guard remains: validators come from the GET response, the emitted 206 bounds come from the backend's actual Content-Range, and a missing Content-Range degrades to 200 (never a lying 206).

**Single-round-trip range serving.** Plain range requests (no conditionals, no `If-Range`) skip the HEAD entirely on `authoritativeRange` stores: one GET, with validators and bounds taken from the response itself -- inherently TOCTOU-atomic, and half the latency on media seeks. Backend-rejected ranges self-heal through the validating HEAD path, which emits the correct 416.

**Store failures map to the truthful status.** A missing object (the store throws `ObjectNotFoundError`, or an error with `status: 404`) becomes a `404`. A transiently unavailable backend -- throttling or overload after the adapter's own retries are exhausted -- is a distinct, retryable case: throw `StoreUnavailableError` (or an error with `status: 503`) and the web adapter emits `503 Service Unavailable`, echoing its optional `retryAfterSeconds` as a `Retry-After` header so clients and shared caches back off. Everything else -- a malformed response, an unparseable `Content-Range`, an empty body -- is a `502 Bad Gateway`. The bundled `/s3`, `/gcs`, `/azure`, and `/http` adapters classify `503 SlowDown` / `429 TooManyRequests` / SDK throttle signals into `StoreUnavailableError` automatically; the `/azure` and `/http` adapters additionally surface the backend's `Retry-After` when it sends one. Every error response carries `Cache-Control: no-store`, `nosniff`, and a `default-src 'none'` CSP; the `404`/`502`/`503` bodies also set `Accept-Ranges: none`, while a `416` keeps its RFC-mandated `Accept-Ranges: bytes` and `Content-Range`.

See [docs/DESIGN.md](docs/DESIGN.md) for full RFC deviation notes, response header matrix, and parsing details.

## Benchmarks

Representative throughput measured on Bun 1.3 (single core, 2M iterations). Benchmarks measure library overhead only -- they do not include network or storage latency.

| Function | Throughput |
|----------|-----------|
| `parseRangeHeader` | 10.1M ops/sec |
| `isPreconditionFailure` | 10.2M ops/sec |
| `isRangeFresh` | 13.9M ops/sec |
| `isConditionalFresh` | 4.7M ops/sec |
| `buildRangeResponseHeaders` | 4.2M ops/sec |
| `evaluateConditionalRequest` | 1.7M ops/sec |
| `buildContentDisposition` | 1.7M ops/sec |

### End-to-end vs `send` and `sirv`

Full HTTP serving (Node 24, `http.createServer`, loopback, 40 connections,
autocannon, identical fixtures; every cell correctness-verified before
timing; the load generator runs in a separate process so its parse cost
never throttles the server column). partial-content runs its shipped dist
through the node adapter + fsStore. Reproduce with `npm run bench`.

| Scenario | partial-content | + `cache` | send | sirv |
|---|---|---|---|---|
| GET 4 KB (200) | 9,210 req/s | **15,772 req/s** | 6,557 req/s | 7,162 req/s |
| GET 1 MB (200) | 118 req/s | 116 req/s | 117 req/s | 119 req/s |
| Range 64 KB of 1 MB (206) | 1,441 req/s | 1,413 req/s | 1,403 req/s | 1,443 req/s |
| Revalidation (304) | 11,716 req/s | **19,542 req/s** | 10,081 req/s | 23,774 req/s* |

The `cache` column is `fsStore({ root, cache: { ttlMs: 1000 } })`: an opt-in
hot-object cache with nginx `open_file_cache` semantics (TTL revalidation,
metadata + bytes captured atomically, bodies only at or below 128 KiB,
LRU-evicted under both an entry cap (`maxEntries`, default 1024) and a body
byte budget (`maxBytes`, default 64 MiB; `0` = metadata-only)). Hot small
files and their ranges serve from memory with zero syscalls. The trade is explicit: after an overwrite, responses (including
304 revalidations) can affirm the previous representation for up to
`ttlMs`; size it against acceptable staleness (see DESIGN.md).

\* sirv's 304 figure buys throughput with a different contract: at
`dev: false` it pre-renders complete header sets for a directory snapshot
taken at boot, so a file created after startup is a 404. In the
configuration that CAN see runtime-created files (`dev: true`), the same
run measures sirv at 4,957 req/s -- a quarter of the `cache` column. For a
fixed directory of immutable assets sirv's trade is exactly right; for
object storage (where uploads happen while the server runs) it is
disqualifying, which is why the boot-snapshot design stays a non-goal here.
On the rows where server code matters (4 KB bodies, revalidations), the
`cache` column is the fastest contender that can serve a file uploaded a
second ago; at 64 KB and above, all four columns converge on I/O parity.

Same code on Bun 1.3 (`Bun.serve`, same machine, same out-of-process
client -- the web adapter's Request/Response ARE the runtime's native
primitives there, no node bridge): GET 4 KB 9,418 req/s plain and
22,898 req/s with the cache; revalidation 12,538 plain and **38,090 req/s**
with the cache -- a TTL-revalidating cache serving runtime uploads,
outrunning even sirv's boot-frozen Node figure by 60%. `send` and `sirv`
are node-stream libraries and cannot ride `Bun.serve` natively. Reproduce:
`bun bench/bun-server.ts` (plain :18778, cache :18779) + autocannon.

Read this fairly in both directions:

- At payload sizes where file serving actually spends its time (>= 64 KB),
  the contenders are at parity: I/O dominates.
- Small-body transfers and revalidations lead `send` and `sirv` even
  without the cache, while doing strictly more per request: RFC 9530
  digest negotiation, audit hooks, pinned-read plumbing, and storage
  abstraction. Four things make that possible: transfers at or below
  128 KiB take a single positional-read fast path in the fs store, small
  bodies travel as plain bytes (no stream machinery), the node adapter
  consumes `serveObjectRaw` (zero fetch primitives constructed on the Node
  hot path), and validators are derived once at stat time instead of
  re-parsing dates on every request.
- Correctness note found while building this benchmark: `send` honors a
  request `Cache-Control: no-cache` during conditional evaluation, and
  spec-compliant fetch clients (undici, browsers) auto-append exactly that
  header to manually-conditional requests -- so `send` never answers 304 to
  a fetch()-based revalidation. partial-content deliberately ignores request
  cache directives here (matching Go stdlib and nginx; see DESIGN.md).

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
