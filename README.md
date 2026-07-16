# partial-content

[![npm version](https://img.shields.io/npm/v/partial-content.svg)](https://www.npmjs.com/package/partial-content)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/partial-content)
[![ci](https://github.com/nordvec/partial-content/actions/workflows/ci.yml/badge.svg)](https://github.com/nordvec/partial-content/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6.svg)](https://www.typescriptlang.org/)

RFC-compliant HTTP file serving and resumable uploads for any storage backend. Range requests, conditional caching, Content-Disposition, ETag generation, a resumable-upload engine speaking tus 1.0 and the IETF resumable-uploads draft, and complete storage adapters in one zero-dependency kernel.

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
| `send` | Yes | Yes | -- | -- | Yes | **No** (local fs only) |

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
partial-content/tus          Resumable uploads: tus 1.0 dialect (Fetch handler)
partial-content/upload       Resumable uploads: IETF draft dialect (Fetch handler)
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

Every storage backend ships both sides of the protocol from the same subpath: an `ObjectStore` for serving and a `ResumableWriteStore` for uploads. `s3Store` + `s3UploadStore` (multipart), `r2Store` + `r2UploadStore` (native multipart), `gcsStore` + `gcsUploadStore` (compose), `azureStore` + `azureUploadStore` (uncommitted blocks), `fsStore` + `fsUploadStore` (fsync + atomic rename), `memoryStore` + `memoryUploadStore`. `/http` is read-side only: a generic HTTP origin cannot accept resumable writes.

Cloud SDKs are **optional peer dependencies**: `@aws-sdk/client-s3` for `/s3` (plus `@aws-sdk/s3-request-presigner` only if you use `createSignedUrl()`), `@google-cloud/storage` for `/gcs`, `@azure/storage-blob` for `/azure`, `hono` for `/hono`. The kernel, `/web`, `/node`, `/fs`, `/http`, `/r2`, `/memory`, `/mime`, `/tus`, and `/upload` need nothing beyond the platform.

## Features

- **One call does everything**: `evaluateConditionalRequest()` handles the complete evaluation chain (412 > 304 > If-Range > Range) in correct order
- **Write-side OCC**: `evaluateConditionalWrite()` handles If-Match/If-None-Match for PUT/PATCH/DELETE with correct 412 semantics
- **RFC 9530 Repr-Digest**: End-to-end integrity verification via `sha-256=:<base64>:` header, with `Want-Repr-Digest` negotiation -- first-class support that `send`, `sirv`, and the framework static middlewares lack
- **Built-in storage adapters**: S3-compatible (AWS, R2 S3-mode, Hetzner, MinIO, Backblaze, Wasabi), R2 native, GCS, Azure, local filesystem, any range-capable HTTP origin, in-memory
- **Built-in framework adapters**: Fetch API (Next.js, SvelteKit, Remix, Nuxt, Astro, Workers, Bun.serve, Deno.serve), Node.js (Express/Fastify/Koa/raw http), Hono
- **Resumable uploads, one engine, two dialects**: `createTusHandler` (`/tus`: tus 1.0 core plus the creation, creation-with-upload, creation-defer-length, termination, and expiration extensions) and `createUploadHandler` (`/upload`: IETF resumable-uploads draft, interop versions 3, 5, and 6) translate the wire; one shared, wire-agnostic state machine makes every protocol decision
- **Upload write stores for every backend**: in-memory, filesystem (fsynced appends, atomic-rename publish), S3 multipart, Azure uncommitted blocks, GCS compose, R2 native multipart -- each declaring honest capability flags the engine adapts to
- **Crash-safe upload offsets**: the offset a probe reports is always derived from storage's own bookkeeping (part listings, block lists, an fsynced file size), never from a stored counter that can drift from the bytes after a crash
- **Upload policy enforced before bytes land**: max/min total size, per-append bounds, and max age are evaluated against fresh state before any byte reaches storage, and streaming appends are hard-capped mid-flight
- **Cooperative-preemption upload locking** plus a post-abort grace window: a dropped connection resumes in milliseconds instead of stalling behind a zombie request, and bytes received before the drop still become durable
- Range requests (206, 416), including multi-range `multipart/byteranges` with overlapping/adjacent-range coalescing and range-amplification defense (`maxRanges`)
- **Precompressed variant negotiation** (`precompressed: true`): serves `<key>.br`/`<key>.zst`/`<key>.gz` siblings via Accept-Encoding (RFC 9110 12.5.3) with `Content-Encoding` + `Vary`, the variant's OWN validators and digest, and byte ranges computed against the encoded bytes -- the correctness detail naive precompressed serving gets wrong
- **Per-request egress offload** (`preferSignedUrl`): split one route by request shape -- proxy ranges, revalidations, and HEAD probes, 302 large full-file downloads to a signed URL that carries your `Cache-Control` (S3 `response-cache-control`; signed URLs also mint on GCS and Azure)
- **Inline active-content lockdown**: SVG/HTML/XML served `inline` automatically gets `Content-Security-Policy: sandbox` (caller-overridable), so a stored `image/svg+xml` cannot execute script from your origin
- **`buildCacheControl()`**: typed Cache-Control composer (visibility, max-age, immutable, RFC 5861 stale-while-revalidate/stale-if-error) that defaults `no-transform` on, because intermediary transforms corrupt byte ranges, digests, and strong validators
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

// Next.js App Router (route-handler params arrive as a Promise)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handler(req, { key: id, mime: "application/pdf" });
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

// The type parameter makes framework fields (req.params) typecheck in the
// extractors; plain JS callers just omit it.
app.get("/files/:key", serveObject<express.Request>(store, {
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
const { body } = range
  ? await store.getObject(key, { range })  // 206: only the requested slice
  : await store.getObject(key);            // 200: the whole object

return new Response(body, { status, headers });
```

More recipes in **[docs/EXAMPLES.md](docs/EXAMPLES.md)**: Hono, Cloudflare Workers (R2 native), kernel-only Express, Content-Disposition, Repr-Digest, resumable uploads, and the manual step-by-step primitives. Coming from `send` or `sirv`? **[docs/MIGRATION.md](docs/MIGRATION.md)** maps every option and event, and is honest about what has no equivalent.

## Resumable uploads

The upload side mirrors the serving side: a wire dialect handler over a storage write store. The handler manages the full upload protocol (creation, offset probes, appends, cancellation, expiry) automatically.

### tus 1.0 (Next.js route handler)

```typescript
// app/api/files/[[...token]]/route.ts -- one catch-all route serves the
// creation endpoint (/api/files) and every upload resource (/api/files/<token>)
import { createTusHandler } from "partial-content/tus";
import { s3UploadStore } from "partial-content/s3";
import { S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({ region: "eu-central-1" });
const store = s3UploadStore({ client, bucket: "documents" });
// Local disk instead: fsUploadStore({ root: "/var/data/files" }) from "partial-content/fs"

const handler = createTusHandler(store, {
  // The SERVER decides the final storage key. Never derive it from the
  // client's filename (a caller-controlled key is a path/overwrite
  // primitive); keep the filename as metadata.
  key: () => `uploads/${crypto.randomUUID()}`,
  // Where the created upload resource lives (the Location header).
  location: (token) => `/api/files/${token}`,
  // How resource requests recover the token from the URL.
  resolveToken: (req) => new URL(req.url).pathname.split("/").pop() || undefined,
  maxSize: 5 * 1024 * 1024 * 1024,  // advertised as Tus-Max-Size
  maxAgeSeconds: 24 * 60 * 60,      // drives Upload-Expires
});

const route = (req: Request) => handler(req);
export { route as POST };    // creation (+ creation-with-upload)
export { route as HEAD };    // offset probe
export { route as PATCH };   // append at offset
export { route as DELETE };  // termination
export { route as OPTIONS }; // capability discovery
```

Point any tus 1.0 client at the creation URL and resumable uploads work end to end: pause, disconnect, resume from the durable offset. On frameworks that route the token as a path parameter, pass it explicitly instead of using `resolveToken`: `handler(req, { uploadToken: params.token })`.

### IETF resumable-uploads draft

The same store works under the IETF dialect (`draft-ietf-httpbis-resumable-upload`), which speaks the draft revisions actual clients implement, identified by interop versions 3, 5, and 6, including the `Upload-Complete`/`Upload-Incomplete` header flip between them. A request may assert a whole-representation SHA-256 via `Repr-Digest`; it is verified before publication on stores that can hash the assembled bytes.

```typescript
import { createUploadHandler } from "partial-content/upload";
import { fsUploadStore } from "partial-content/fs";

const handler = createUploadHandler(fsUploadStore({ root: "/var/data/files" }), {
  key: () => `uploads/${crypto.randomUUID()}`,
  location: (token) => `/api/uploads/${token}`,
  policy: { maxSize: 5 * 1024 * 1024 * 1024, maxAgeSeconds: 24 * 60 * 60 },
});
// Requests without an upload token are creations; requests with one target
// the resource: HEAD probes the offset, PATCH appends, DELETE cancels.
```

### One engine, two dialects

Both handlers are thin header translations over the same wire-agnostic engine: a pure state machine evaluates every interaction (create, probe, append, cancel) against fresh storage state and a policy, and returns a typed verdict; the dialect only maps verdicts to each protocol's statuses and header names. What that buys, on every backend and both wires:

- **Offsets are always derived from storage** (a part listing, a block list, an fsynced file size), never from a stored counter -- so the offset a client resumes from can never be ahead of the bytes that actually survived a crash.
- **Cooperative-preemption locking**: when a client's connection drops mid-append and it resumes before the server notices the dead socket, the new request asks the old one to stop at the next chunk boundary instead of stalling behind its timeout.
- **A post-abort grace window** (default 10 s) lets storage finish flushing bytes that already arrived when the client vanished, so the next offset probe answers truthfully.
- **Digest verification at completion where the backend honestly can**: the filesystem and memory stores hash the assembled bytes and refuse to publish on a mismatch. S3 multipart SHA-256 checksums are composite (a hash of per-part hashes), so whole-object verification is impossible server-side and the S3 store declines the capability instead of faking it; the optional `checksums` flag still gives per-part transport integrity.

See [docs/DESIGN.md](docs/DESIGN.md#resumable-uploads) for the design rationale and [docs/API.md](docs/API.md#resumable-uploads) for the full option reference.

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
    // Storage keys usually embed the filename: personal data that logging
    // controls (ISO 27001 A.8.15, OWASP ASVS) keep out of log records.
    // auditKey replaces `key` in every hook event with an opaque id, so
    // the audit trail stays correlatable without the filename.
    auditKey: file.id,
  });
}
```

This is the path behind `<video>`/`<audio>` seeking and PDF.js progressive loading: the media element sends `Range` to **your** origin, you re-check access, and stream just that slice from storage. If you could hand the client a signed URL instead, the storage backend would speak this protocol for you and you wouldn't need a protocol layer -- see [Scope](docs/DESIGN.md#scope) for when this library earns its place.

## API

The full reference lives in **[docs/API.md](docs/API.md)**. The shape of the surface:

- **Kernel** (`partial-content`): `evaluateConditionalRequest` / `evaluateConditionalWrite` (the one-call orchestrators), the step-by-step primitives (`parseRangeHeader`, `parseRanges`, `isConditionalFresh`, `isPreconditionFailure`, `isRangeFresh`, the `build*Headers` family), `generateETag`, `buildContentDisposition`, `clientWantsDigest`, `clientWantsContentDigest`, `fromNodeHeaders`, `sanitizeHeaderValue`
- **Serving** (`/web`, `/node`, `/hono`): `serveObject` handlers with `disposition`, `cacheControl` (verbatim passthrough), security headers, `onServe` / `onTransfer` / `onError` / `onTiming` observability hooks, `auditKey` (PII-free audit events), `maxRanges`, and a slow-read stall bound on the Node pump
- **Stores** (`/s3`, `/r2`, `/gcs`, `/azure`, `/fs`, `/http`, `/memory`): ready-made `ObjectStore` implementations with pinned reads and truthful error mapping (404 / retryable 503 + `Retry-After` / 502)
- **Custom adapters**: the published `ObjectStore` contract plus the primitives the built-ins are made of (`classifyStoreRead`, `nodeStreamToWeb`, `guardStreamLength`, `resolveServedRange`)
- **Resumable uploads** (`/tus`, `/upload`, plus an `*UploadStore` factory on every storage subpath): `createTusHandler` / `createUploadHandler` wire dialects, the `ResumableWriteStore` write contract with honest per-backend capability flags, `UploadPolicy` bounds, cooperative-preemption locking, `onUploadEvent` content-free audit events, and `sweepExpired` housekeeping

## Design Decisions

**Multi-range is served as `multipart/byteranges`.** Overlapping, adjacent, and near-adjacent ranges are coalesced (gaps smaller than the ~80-byte part framing overhead are bridged, which RFC 9110 15.3.7.2 sanctions and which strictly shrinks the response), parts are emitted in the order the request asked for them, and a range-amplification cap (`maxRanges`, default 50) degrades pathological requests to a full 200. The single-range fast path is untouched. Cost model: each multipart part is one ranged `getObject` against your store, so one request can drive up to `maxRanges` backend reads; lower `maxRanges` (even to 1) if your backend bills per request.

**Validator comparison follows the RFC strength rules.** `If-None-Match` uses weak comparison (`W/` is stripped, as RFC 9110 8.8.3.2 directs for freshness checks), while `If-Match` and `If-Range` use strong comparison only: a weak validator can never authorize a write or a range resume, because it cannot assert byte equality. `If-Range` dates additionally require the Last-Modified second to have fully elapsed (RFC 9110 8.8.2.2) before the range is honored.

**Sub-second timestamp flooring.** Storage backends return ISO-8601 with milliseconds. HTTP dates use whole seconds. All comparisons floor both sides to prevent permanent false-stale results.

**Atomic pinned reads (TOCTOU elimination).** After validating conditionals against HEAD metadata, the web adapter pins the GET to that exact representation via the store's native conditional read (S3 `IfMatch`, R2 `onlyIf.etagMatches`, Azure `conditions.ifMatch`, GCS generation pinning). If the object changes in the HEAD->GET window, the store throws `ObjectChangedError` and the request is re-validated once against the new state. For stores that cannot pin, a response-side guard remains: validators come from the GET response, the emitted 206 bounds come from the backend's actual Content-Range, and a missing Content-Range degrades to 200 (never a lying 206).

**Single-round-trip range serving.** Plain range requests (no conditionals, no `If-Range`) skip the HEAD entirely on `authoritativeRange` stores: one GET, with validators and bounds taken from the response itself -- inherently TOCTOU-atomic, and half the latency on media seeks.

**Store failures map to the truthful status.** Missing object -> `404`. Transiently unavailable backend (throttling/overload) -> `503` + `Retry-After` (`StoreUnavailableError`). Malformed upstream response -> `502`. Every error response carries `Cache-Control: no-store`, `nosniff`, and a `default-src 'none'` CSP.

See [docs/DESIGN.md](docs/DESIGN.md) for full RFC deviation notes, response header matrix, and parsing details.

## Benchmarks

Full HTTP serving vs `send` and `sirv` (Node 24, loopback, out-of-process autocannon, every cell correctness-verified before timing, per-cell median of three runs; reproduce with `npm run bench`):

| Scenario | partial-content | + `cache` | send | sirv |
|---|---|---|---|---|
| GET 4 KB (200) | 13,185 req/s | **22,594 req/s** | 12,876 req/s | 13,014 req/s |
| GET 1 MB (200) | 117 req/s | 115 req/s | 117 req/s | 120 req/s |
| Range 64 KB of 1 MB (206) | **1,566 req/s** | 1,552 req/s | 1,532 req/s | 1,456 req/s |
| Revalidation (304) | 20,014 req/s | **22,838 req/s** | 19,931 req/s | 33,165 req/s* |

- At payload sizes where file serving actually spends its time (1 MB bodies), all contenders converge on I/O parity.
- Small bodies, ranged serves, and revalidations run at parity-to-modest-lead while doing strictly more per request (digest negotiation, audit hooks, pinned-read plumbing, storage abstraction). Ranges lead because a plain range is a single round-trip: the fs store's one open handle stats, clamps, and reads (`authoritativeRange`).
- The `cache` column is the opt-in fs hot-object cache (nginx `open_file_cache` semantics: TTL revalidation, `maxEntries` + `maxBytes` LRU bounds). \* sirv's 304 figure comes from a boot-time directory snapshot that 404s files created after startup; in the mode that can serve runtime uploads it measures 5,676 req/s.

Kernel micro-benchmarks, the Bun.serve numbers (38k req/s revalidation with cache), and the full fairness notes are in **[docs/BENCHMARKS.md](docs/BENCHMARKS.md)**.

## Security & Compliance

The library surface maps directly to audit requirements for SOC 2 Type II, ISO 27001, and EU regulatory frameworks.

| Requirement | Standard | Feature |
|---|---|---|
| Integrity verification | RFC 9530, GDPR Art. 32 (integrity of processing) | `Repr-Digest` (SHA-256) on 200/206 responses whenever the backend supplies a representation digest (S3 checksummed uploads, `digest` in metadata, `gcsStore` `digestMetadataKey`) |
| Content integrity | RFC 9530 Section 2 | `Content-Digest` on 200 (content = full representation) |
| Digest negotiation | RFC 9530 Section 4 | `Want-Repr-Digest` / `Want-Content-Digest` parsing |
| Audit trail | SOC 2 CC7.2, ISO 27001 A.8.15 | `onServe` callback with structured audit events (bytes granted); feeds the monitoring/detection layer DORA Art. 10 and EU AI Act Art. 12 ask for once wired to your alerting stack |
| Log data minimization | ISO 27001 A.8.15, OWASP ASVS (no PII in logs) | `auditKey` substitutes an opaque id for the filename-bearing storage key in every hook event |
| Egress accounting / abandonment | operational | `onTransfer` callback with true bytes transferred and a `completed` flag |
| Encoding-sniffing XSS prevention | OWASP | `charset=utf-8` enforcement on textual MIME types |
| MIME-sniffing prevention | OWASP | `X-Content-Type-Options: nosniff` on every success + error response (`200`/`206`, the `404`/`502`/`503` bodies, and the bodyless `412`/`416` denials); `304`/`302` carry none |
| Header injection prevention | OWASP, CWE-113 | CRLF stripping in ETag, Last-Modified, filename |
| Content-Disposition hardening | RFC 6266, RFC 8187 | Bidi override stripping, path traversal prevention |
| Conditional request compliance | RFC 9110, RFC 7232 | Full precondition evaluation chain (412, 304, 416) |
| Retryable backend failures | RFC 9110 §15.6.4 / §10.2.3 | Transient store throttling/overload maps to `503 Service Unavailable` + `Retry-After` (`StoreUnavailableError`), distinct from `502` for malformed upstream responses |
| OCC for writes | RFC 9110 Section 13.1.2 | `evaluateConditionalWrite` (If-Match, If-None-Match) |
| Range request compliance | RFC 7233 / RFC 9110 §14 | Single- and multi-range (`multipart/byteranges`) serving with TOCTOU guards and range-amplification defense |
| Cross-origin resource policy | CORP | `Cross-Origin-Resource-Policy` header support |
| Performance observability | W3C Server-Timing | `Server-Timing` metrics with `onTiming` callback |
| Cache control | RFC 9111 / RFC 5861 | Verbatim `Cache-Control` passthrough (`s-maxage`, `must-revalidate`, `stale-while-revalidate`, `stale-if-error`); auto-`immutable` for content-addressed keys |
| Upload audit trail | SOC 2 CC7.2, ISO 27001 A.8.15 | `onUploadEvent` structured, content-free events (created, append accepted/rejected with reason, completed, cancelled, expired); `auditKey` substitutes an opaque id for the upload token and the filename-bearing storage key in every event |
| Upload size bounds | OWASP (resource exhaustion) | `UploadPolicy` `maxSize`/`minSize`/`maxAppendSize`/`minAppendSize` enforced by the engine before any byte reaches storage; appends of unknown length are hard-capped mid-stream and an over-bound append terminally invalidates the resource |
| Abandoned-upload expiry | GDPR Art. 5(1)(e) (storage limitation) | `maxAgeSeconds` policy (expired resources refuse every interaction and answer 410/404) plus the `sweepExpired` store hook to reap idle upload state on a schedule |
| Upload integrity at completion | RFC 9530, GDPR Art. 32 (integrity of processing) | Client-asserted `Repr-Digest` SHA-256 verified against the assembled bytes BEFORE publication, on stores that can hash them (`fs`, `memory`); S3 multipart checksums are composite-only, so the S3 store honestly declines whole-object verification (`digestOnComplete: false`) and a digest asserted against it is rejected rather than silently ignored |

Not claimed, deliberately: malware scanning, content-type allowlists, authentication/authorization, and per-tenant quotas are the caller's responsibility -- the upload handlers assume the request was already authorized, exactly like the serving handlers.

## License

MIT
