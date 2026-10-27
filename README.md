# partial-content

[![npm version](https://img.shields.io/npm/v/partial-content.svg)](https://www.npmjs.com/package/partial-content)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/partial-content)
[![ci](https://github.com/nordvec/partial-content/actions/workflows/ci.yml/badge.svg)](https://github.com/nordvec/partial-content/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
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
partial-content              Zero-dep kernel (RFC 9110 evaluation)
partial-content/web          Fetch API handler (Next.js, SvelteKit, Remix, Workers)
partial-content/tus          Resumable uploads: tus 1.0 dialect (Fetch handler)
partial-content/upload       Resumable uploads: IETF draft dialect (Fetch handler)
partial-content/redis-locker Multi-instance upload locking (Redis/Valkey, client injected)
partial-content/s3           AWS S3, R2 (S3 mode), Hetzner, MinIO, Wasabi
partial-content/r2           Cloudflare R2 native bindings (no AWS SDK)
partial-content/gcs          Google Cloud Storage
partial-content/azure        Azure Blob Storage
partial-content/fs           Local filesystem (Node.js)
partial-content/node         Node.js http/Express/Fastify serving adapter
partial-content/hono         Hono middleware
partial-content/http         Any range-capable HTTP origin (Supabase, presigned URLs, CDNs)
partial-content/memory       In-memory store (tests, demos, embedded assets)
partial-content/mime         Curated zero-dep MIME lookup
partial-content/conformance  Contract harness for a custom read or write store
```

Every storage backend ships both sides of the protocol from the same subpath: an `ObjectStore` for serving and a `ResumableWriteStore` for uploads. `s3Store` + `s3UploadStore` (multipart), `r2Store` + `r2UploadStore` (native multipart), `gcsStore` + `gcsUploadStore` (compose), `azureStore` + `azureUploadStore` (uncommitted blocks), `fsStore` + `fsUploadStore` (fsync + atomic rename), `memoryStore` + `memoryUploadStore`. `/http` is read-side only: a generic HTTP origin cannot accept resumable writes.

Cloud SDKs are **optional peer dependencies**: `@aws-sdk/client-s3` for `/s3` (plus `@aws-sdk/s3-request-presigner` only if you use `createSignedUrl()`), `@google-cloud/storage` for `/gcs`, `@azure/storage-blob` for `/azure`, `hono` for `/hono`. The kernel, `/web`, `/node`, `/fs`, `/http`, `/r2`, `/memory`, `/mime`, `/tus`, `/upload`, and `/conformance` need nothing beyond the platform, and `/redis-locker` takes whatever Redis client you already run behind a four-command interface instead of depending on one.

## Features

- **One call does everything**: `evaluateConditionalRequest()` handles the complete evaluation chain (412 > 304 > If-Range > Range) in correct order
- **Write-side OCC**: `evaluateConditionalWrite()` handles If-Match/If-None-Match for PUT/PATCH/DELETE with correct 412 semantics
- **RFC 9530 Repr-Digest**: End-to-end integrity verification via `sha-256=:<base64>:` header, with `Want-Repr-Digest` negotiation -- first-class support that `send`, `sirv`, and the framework static middlewares lack
- **Built-in storage adapters**: S3-compatible (AWS, R2 S3-mode, Hetzner, MinIO, Backblaze, Wasabi), R2 native, GCS, Azure, local filesystem, any range-capable HTTP origin, in-memory
- **Built-in framework adapters**: Fetch API (Next.js, SvelteKit, Remix, Nuxt, Astro, Workers, Bun.serve, Deno.serve) covering both serving and uploads; Hono middleware; and a Node.js `IncomingMessage`/`ServerResponse` adapter for Express, Fastify, Koa, and raw `http.createServer`, covering serving AND uploads (`toWebRequest`/`sendResponse`, or `nodeHandler` over both, so the Fetch-shaped upload dialects run on a Node server without a bridge of your own)
- **Resumable uploads, one engine, two dialects**: `createTusHandler` (`/tus`: tus 1.0 core plus the creation, creation-with-upload, creation-defer-length, termination, expiration, and opt-in checksum extensions) and `createUploadHandler` (`/upload`: IETF resumable-uploads draft, interop versions 3, 5, 6, 9, and 10) translate the wire; one shared, wire-agnostic state machine makes every protocol decision
- **Upload write stores for every backend**: in-memory, filesystem (fsynced appends, atomic-rename publish), S3 multipart, Azure uncommitted blocks, GCS compose, R2 native multipart -- each declaring honest capability flags the engine adapts to
- **A conformance harness for custom stores** (`/conformance`): 25 checks that a write store DOES what its capability flags CLAIM, since nothing at construction can tell a store that performs the at-write offset check from one that declares `enforcesOffsetCheck: true` and writes anyway, plus 6 read-side checks that an `ObjectStore` serves the window it was asked for, an honest total on a partial read, and a not-found the serving path can tell from a failure. No test framework and no dependencies, so it runs in CI, under any runner, or as a startup self-test; the read side is side-effect free, so it can run against a staging bucket
- **Crash-safe upload offsets**: the offset a probe reports comes from the backend's own bookkeeping (part listings, block lists, an fsynced file size) or, on R2, from a ledger written after each part lands, never ahead of the bytes; the `exactOffsetRecovery` capability flag says which stores are exact
- **Upload policy enforced before bytes land**: max/min total size, per-append bounds, and max age are evaluated against fresh state before any byte reaches storage, and streaming appends are hard-capped mid-flight
- **Cooperative-preemption upload locking** plus a post-abort grace window: a dropped connection resumes in milliseconds instead of stalling behind a zombie request, and bytes received before the drop still become durable; `/redis-locker` ships the same semantics for multi-instance deployments over any Redis-protocol server (client injected, still zero dependencies)
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
- ESM-only. Works across Node.js 24+, Bun, Deno, Cloudflare Workers, and edge runtimes

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
import { lookupMime } from "partial-content/mime";

const store = fsStore({ root: "/var/data/uploads" });
// Hot small files? Opt into the bounded TTL cache (see Benchmarks):
// fsStore({ root, cache: { ttlMs: 1000 } })
const app = express();

// The type parameter makes framework fields (req.params) typecheck in the
// extractors; plain JS callers just omit it.
app.get("/files/:key", serveObject<express.Request>(store, {
  key: (req) => req.params.key,
  // Without a mime the response is application/octet-stream, which no browser
  // renders inline: a PDF or video downloads instead of playing.
  mime: (req) => lookupMime(req.params.key),
  disposition: "inline",
}));
```

### Kernel only (bring your own I/O)

```typescript
import { evaluateConditionalRequest, type ObjectStore } from "partial-content";

// Your storage and the metadata you already hold for this object.
declare const store: ObjectStore;
declare const key: string;
declare const fileSize: number;

export async function GET(request: Request): Promise<Response> {
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
}
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
  policy: {
    maxSize: 5 * 1024 * 1024 * 1024,  // advertised as Tus-Max-Size
    maxAgeSeconds: 24 * 60 * 60,      // drives Upload-Expires
  },
});

const route = (req: Request) => handler(req);
export { route as POST };    // creation (+ creation-with-upload)
export { route as HEAD };    // offset probe
export { route as PATCH };   // append at offset
export { route as DELETE };  // termination
export { route as OPTIONS }; // capability discovery
```

Point any tus 1.0 client at the creation URL and resumable uploads work end to end: pause, disconnect, resume from the durable offset. On frameworks that route the token as a path parameter, pass it explicitly instead of using `resolveToken`: `handler(req, { uploadToken: params.token })`.

On any surface reachable by untrusted clients, set at least one of `policy.maxSize` and `policy.maxAgeSeconds`: with neither, an upload accepts unbounded bytes and abandoned resources never expire. `maxAgeSeconds` marks a resource eligible for expiry, but storage is reclaimed only when you run the store's `sweepExpired()` on a schedule (e.g. a cron), so pair the two.

### IETF resumable-uploads draft

The same store works under the IETF dialect (`draft-ietf-httpbis-resumable-upload`), which speaks the draft revisions clients implement, identified by interop versions 3 (draft-01), 5 (draft-03), 6 (draft-04/-05), 9 (draft-12), and 10 (draft-13 and -14). Each request is answered entirely in its own version's terms, including the `Upload-Complete`/`Upload-Incomplete` header flip between 3 and the rest, so a client upgrades on its own schedule. Interop 9 and 10 additionally advertise the server's bounds as an RFC 8941 `Upload-Limit` dictionary on offset retrievals and on any rejection a limit caused, admit `GET` as an offset probe beside `HEAD`, and replays the completion answer for one exact shape: a content-free append to a finished upload whose claimed offset EQUALS the durable offset. That is the retry of a completing request that already landed, and nothing else qualifies -- a different offset is answered 409 with the true offset, and an append carrying bytes is refused, because the length is fixed at completion and bytes past it have nowhere to go. A request may assert a whole-representation SHA-256 via `Repr-Digest` (RFC 9530) on every version; it is verified before publication on stores that can hash the assembled bytes (`fs` and `memory`, SHA-256 and SHA-512). On `s3`, `r2`, `gcs` and `azure`, which complete without a whole-object digest check, a `Repr-Digest` is ignored under the default policy and the upload publishes unverified; set `policy.digestPolicy: "require-verifiable"` to refuse such a request with a `400` before any byte is written. Interop 10 answers a creation or append the server interrupted `409` with the durable offset (a creation keeps its `Location`), where the older revisions answer `201` or `204`.

```typescript
import { createUploadHandler } from "partial-content/upload";
import { fsUploadStore } from "partial-content/fs";

const handler = createUploadHandler(fsUploadStore({ root: "/var/data/files" }), {
  key: () => `uploads/${crypto.randomUUID()}`,
  location: (token) => `/api/uploads/${token}`,
  // How resource requests recover the token from the URL. This dialect
  // consults resolveToken on EVERY request and treats "no token" as a
  // CREATION, so both directions matter: omit it and every probe, append and
  // cancel creates a fresh upload instead, orphaning the bytes already stored;
  // return a token for the creation URL itself and the create is answered 405.
  // Match only the resource path, so `/api/uploads` stays a creation.
  resolveToken: (req) =>
    /^\/api\/uploads\/(.+)$/.exec(new URL(req.url).pathname)?.[1],
  policy: { maxSize: 5 * 1024 * 1024 * 1024, maxAgeSeconds: 24 * 60 * 60 },
});
// Requests without an upload token are creations; requests with one target
// the resource: HEAD probes the offset, PATCH appends, DELETE cancels.
```

### One engine, two dialects

Both handlers are thin header translations over the same wire-agnostic engine: a pure state machine evaluates every interaction (create, probe, append, cancel) against fresh storage state and a policy, and returns a typed verdict; the dialect only maps verdicts to each protocol's statuses and header names. What that buys, on every backend and both wires:

- **Offsets come from the backend's own bookkeeping** (a part listing, a block list, an fsynced file size), or on R2, which has no part listing, from a ledger written after each part lands -- never ahead of the bytes, so the offset a client resumes from cannot exceed what survived a crash. R2 declares `exactOffsetRecovery: false` because its ledger can trail the bytes, and a resume there may re-send its last chunk.
- **Cooperative-preemption locking**: when a client's connection drops mid-append and it resumes before the server notices the dead socket, the new request asks the old one to stop at the next chunk boundary instead of stalling behind its timeout.
- **A post-abort grace window** (default 10 s) lets storage finish flushing bytes that already arrived when the client vanished, so the next offset probe answers truthfully.
- **Digest verification at completion where the backend honestly can**: the filesystem and memory stores hash the assembled bytes and refuse to publish on a mismatch. S3 multipart SHA-256 checksums are composite (a hash of per-part hashes), so whole-object verification is impossible server-side and the S3 store declines the capability instead of faking it; the optional `checksums` flag still gives per-part transport integrity.

See [docs/DESIGN.md](docs/DESIGN.md#resumable-uploads) for the design rationale, [docs/API.md](docs/API.md#resumable-uploads) for the full option reference, and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for reverse-proxy, CORS, multi-instance, and object-storage-part-limit guidance when self-hosting.

## Real-world example: authorized proxy from object storage

A common pattern when serving private files from object storage: you proxy file requests through your own server so every request is authorized and audited, then stream the bytes with full range and conditional-request support.

Use this library when your application **must** proxy file requests (authorization, auditing, tenant isolation, or custom business logic) instead of redirecting clients to signed object-storage URLs:

```typescript
import { serveObject } from "partial-content/web";
import { s3Store, type S3StoreOptions } from "partial-content/s3";

// Yours to supply: a configured S3 client (`new S3Client({ region: "eu-central-1" })`),
// wherever you log and meter, and the authorization check that owns access.
declare const client: S3StoreOptions["client"];
declare const logger: { info(fields: object, msg: string): void; error(fields: object, msg: string): void };
declare const meter: { recordEgress(key: string, bytes: number): void };
declare const authorize: (request: Request, key: string) =>
  Promise<{ id: string; path: string; mimeType: string; filename: string } | null>;

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

  // 2. One call runs the full RFC 9110 chain: 412, 304, If-Range, Range.
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

- **Kernel** (`partial-content`): `evaluateConditionalRequest` / `evaluateConditionalWrite` (the one-call orchestrators), the step-by-step primitives (`parseRangeHeader`, `parseRanges`, `isConditionalFresh`, `isPreconditionFailure`, `isRangeFresh`, the `build*Headers` family), `generateETag`, `buildContentDisposition`, `clientWantsDigest`, `clientWantsContentDigest`, `fromNodeHeaders`, `sanitizeHeaderValue`, `isSha256Base64`
- **Serving** (`/web`, `/node`, `/hono`): `serveObject` handlers with `disposition`, `cacheControl` (verbatim passthrough), security headers, `onServe` / `onTransfer` / `onError` / `onTiming` observability hooks, `auditKey` (PII-free audit events), `maxRanges`, and a slow-read stall bound on the Node pump
- **Stores** (`/s3`, `/r2`, `/gcs`, `/azure`, `/fs`, `/http`, `/memory`): ready-made `ObjectStore` implementations with pinned reads and truthful error mapping (404 / retryable 503 + `Retry-After` / 502)
- **Custom adapters**: the published `ObjectStore` contract plus the primitives the built-ins are made of (`classifyStoreRead`, `nodeStreamToWeb`, `guardStreamLength`, `resolveServedRange`, `reservedKeyGuard`, `redactErrorText` for a custom store's own error sink) and the name-based store-error matchers (`isObjectNotFoundError`, `isObjectChangedError`, `isStoreUnavailableError`)
- **Resumable uploads** (`/tus`, `/upload`, plus an `*UploadStore` factory on every storage subpath): `createTusHandler` / `createUploadHandler` wire dialects, the `ResumableWriteStore` write contract with honest per-backend capability flags, `UploadPolicy` bounds, cooperative-preemption locking, `onUploadEvent` content-free audit events, the `onUploadComplete` publication hook that pairs an upload token with the storage key it published to, and `sweepExpired` housekeeping
- **Store conformance** (`/conformance`): `checkResumableWriteStore(makeStore, opts?)`, `checkObjectStore(store, opts)` and `formatConformanceReport(report)`, for proving a custom write store meets the contract it declares and a custom read store meets the one the serving path assumes, plus `runConformanceCheck` and `tallyConformance` for folding your own backend-specific obligations into the same report. A check body reports through an `assert` it is handed and nothing else, so one that observes nothing fails rather than passing: an unverified obligation is worth less than no check at all, because a green row gets cited

## Design Decisions

**Multi-range is served as `multipart/byteranges`.** Overlapping, adjacent, and near-adjacent ranges are coalesced (gaps smaller than the ~80-byte part framing overhead are bridged, which RFC 9110 15.3.7.2 sanctions and which strictly shrinks the response), parts are emitted in the order the request asked for them, and a range-amplification cap (`maxRanges`, default 8) degrades pathological requests to a full 200, and a ranges header with a non-numeric bound is served as a full 200 as well. The single-range fast path is untouched. Cost model: up to `maxBackendReads` (default 8) parts each stream from their own ranged `getObject`; past that, the parts are cut from one buffered read of the covering span when it is under 256 KiB, and the full 200 is served otherwise. Lower `maxBackendReads` or `maxRanges` (even to 1) if your backend bills per request.

**Validator comparison follows the RFC strength rules.** `If-None-Match` uses weak comparison (`W/` is stripped, as RFC 9110 8.8.3.2 directs for freshness checks), while `If-Match` and `If-Range` use strong comparison only: a weak validator can never authorize a write or a range resume, because it cannot assert byte equality. `If-Range` dates additionally require the Last-Modified second to have fully elapsed (RFC 9110 8.8.2.2) before the range is honored.

**Sub-second timestamp flooring.** Storage backends return ISO-8601 with milliseconds. HTTP dates use whole seconds. All comparisons floor both sides to prevent permanent false-stale results.

**Atomic pinned reads (TOCTOU elimination).** After validating conditionals against HEAD metadata, the web adapter pins the GET to that exact representation via the store's native conditional read (S3 `IfMatch`, R2 `onlyIf.etagMatches`, Azure `conditions.ifMatch`, GCS generation pinning). If the object changes in the HEAD->GET window, the store throws `ObjectChangedError` and the request is re-validated once against the new state. For stores that cannot pin, a response-side guard remains: validators come from the GET response, the emitted 206 bounds come from the backend's actual Content-Range, and a missing Content-Range degrades to 200 (never a lying 206).

**Single-round-trip range serving.** Plain range requests (no conditionals, no `If-Range`) skip the HEAD entirely on `authoritativeRange` stores: one GET, with validators and bounds taken from the response itself -- inherently TOCTOU-atomic, and half the latency on media seeks.

**Store failures map to the truthful status.** Missing object -> `404`. Transiently unavailable backend (throttling/overload) -> `503` + `Retry-After` (`StoreUnavailableError`). Malformed upstream response -> `502`. Every error response carries `Cache-Control: no-store`, `nosniff`, and a `default-src 'none'` CSP.

See [docs/DESIGN.md](docs/DESIGN.md) for full RFC deviation notes, response header matrix, and parsing details.

## Benchmarks

Full HTTP serving vs `send` and `sirv`, measured 2026-09-04 on partial-content 5.0.0 (Node 24, Windows 11, loopback, out-of-process autocannon, every cell correctness-verified before timing, per-cell median of three runs; reproduce with `npm run bench`). Only scenarios proven server-bound are published: adding a second load generator doubled the 1 MB and 64 KB-range rows for every server, our own included, so their throughput measured the client and not any library.

CPU per request (user + system microseconds) is the metric to compare on, because it does not depend on the load generator; throughput follows it.

| Scenario | partial-content | partial-content (cache) | `send` | `sirv` |
|---|---|---|---|---|
| GET 4 KB (200), CPU | 225 us | 59 us | 261 us | 273 us |
| GET 4 KB (200), throughput | 9,748 req/s | 17,745 req/s | 9,988 req/s | 9,924 req/s |
| Revalidation (304), CPU | 173 us | 62 us | 140 us | 38 us* |
| Revalidation (304), throughput | 10,453 req/s | 15,065 req/s | 12,854 req/s | 25,435 req/s* |

\* `sirv` buys that 304 figure with a directory snapshot taken at startup, so a file created afterwards is a 404. In the configuration that CAN serve a file uploaded a second ago, the same scenario measures `sirv` at 4,279 req/s and 231 us of CPU per request. Whether that row is a deficit or a lead of two and a half times depends entirely on whether your files exist before the server starts.

- On the 4 KB body partial-content costs the least CPU of the three while doing strictly more per request: digest negotiation, audit hooks, pinned-read plumbing, and a storage abstraction. A plain range is a single round-trip because the fs store's one open handle stats, clamps, and reads (`authoritativeRange`).
- `fsStore({ cache })` is an opt-in hot-object cache (TTL revalidation, `maxEntries` + `maxBytes` LRU bounds) that removes the per-request syscalls on hot small files, in exchange for a bounded staleness window.

Kernel micro-benchmarks, the methodology that decides which rows get published, and why CPU per request is the metric to compare on are in **[docs/BENCHMARKS.md](docs/BENCHMARKS.md)**.

## Security & Compliance

The library surface maps directly to audit requirements for SOC 2 Type II, ISO 27001, and EU regulatory frameworks.

| Requirement | Standard | Feature |
|---|---|---|
| Integrity verification | RFC 9530, GDPR Art. 32 (integrity of processing) | `Repr-Digest` (SHA-256) on 200/206 responses whenever the backend supplies a representation digest (S3 checksummed uploads, `digest` in metadata, `gcsStore` `digestMetadataKey`) |
| Content integrity | RFC 9530 Section 2 | `Content-Digest` on 200 (content = full representation) |
| Digest negotiation | RFC 9530 Section 4 | `Want-Repr-Digest` / `Want-Content-Digest` parsing |
| Audit trail | SOC 2 CC7.2, ISO 27001 A.8.15 | `onServe` callback with structured audit events (bytes granted); feeds the monitoring/detection layer DORA Art. 10 and EU AI Act Art. 12 ask for once wired to your alerting stack |
| Log data minimization | ISO 27001 A.8.15, OWASP ASVS (no PII in logs) | `auditKey` substitutes an opaque id for the filename-bearing storage key in every hook event, and hands `onError` an allow-listed `ProjectedError` (`name`, `code`, `status`, `operation`, `cause`) in place of the raw error, so neither the key nor the upload token reaches the sink |
| Egress accounting / abandonment | operational | `onTransfer` callback with true bytes transferred and a `completed` flag; a body that ends short of, or runs past, the committed `Content-Length` errors the response instead of passing as complete |
| Encoding-sniffing XSS prevention | OWASP | `charset=utf-8` enforcement on textual MIME types |
| MIME-sniffing prevention | OWASP | `X-Content-Type-Options: nosniff` on every success + error response (`200`/`206`, the `404`/`502`/`503` bodies, and the bodyless `412`/`416` denials); `304`/`302` carry none |
| Header injection prevention | OWASP, CWE-113 | CRLF stripping in ETag, Last-Modified, filename |
| Content-Disposition hardening | RFC 6266, RFC 8187 | Bidi override stripping, path traversal prevention |
| Conditional request compliance | RFC 9110 Section 13 | Full precondition evaluation chain (412, 304, 416) |
| Retryable backend failures | RFC 9110 §15.6.4 / §10.2.3 | Transient store throttling/overload maps to `503 Service Unavailable` + `Retry-After` (`StoreUnavailableError`), distinct from `502` for malformed upstream responses |
| OCC for writes | RFC 9110 Sections 13.1.1, 13.1.2 | `evaluateConditionalWrite` (If-Match, If-None-Match) |
| Range request compliance | RFC 9110 §14 | Single- and multi-range (`multipart/byteranges`) serving with TOCTOU guards and range-amplification defense |
| Cross-origin resource policy | CORP | `Cross-Origin-Resource-Policy` header support |
| Performance observability | W3C Server-Timing | `Server-Timing` metrics with `onTiming` callback |
| Cache control | RFC 9111 / RFC 5861 | Verbatim `Cache-Control` passthrough (`s-maxage`, `must-revalidate`, `stale-while-revalidate`, `stale-if-error`); auto-`immutable` for content-addressed keys |
| Upload audit trail | SOC 2 CC7.2, ISO 27001 A.8.15 | `onUploadEvent` structured, content-free events (created, append accepted/rejected with reason, completed, cancelled, expired); `auditKey` substitutes an opaque id for the upload token and the filename-bearing storage key in every event, and `onError` receives an allow-listed `ProjectedError` in place of the raw error |
| Upload size bounds | OWASP (resource exhaustion) | `UploadPolicy` `maxSize`/`minSize`/`maxAppendSize`/`minAppendSize` enforced by the engine before any byte reaches storage; appends of unknown length are hard-capped mid-stream, and what crossing a cap means depends on which cap: past a known length or the total `maxSize` the resource is terminally invalidated, while past the per-request `maxAppendSize` the append stops, answers 413, and leaves the upload resumable |
| Abandoned-upload expiry | GDPR Art. 5(1)(e) (storage limitation) | `maxAgeSeconds` policy (an unfinished resource past it refuses probes and appends with 410/404, while a `DELETE` still frees their bytes; a completed upload keeps its answer, since the clock bounds unfinished bytes rather than finished ones) plus the `sweepExpired` store hook, which takes an idleness cutoff and a lifetime cutoff so a resource cannot be refused as expired while staying invisible to the sweep |
| Upload integrity at completion | RFC 9530, GDPR Art. 32 (integrity of processing) | Client-asserted `Repr-Digest` (SHA-256 or SHA-512) verified against the assembled bytes BEFORE publication, on stores that can hash them (`fs`, `memory`). `s3`, `r2`, `gcs` and `azure` complete without a whole-object digest check (`digestOnComplete: false`; S3 multipart checksums are composite-only), so a digest asserted against them is ignored under the default policy and the upload publishes unverified; `policy.digestPolicy: "require-verifiable"` refuses that request with a `400` before any byte is written |

Not claimed, deliberately: malware scanning, content-type allowlists, authentication/authorization, and per-tenant quotas are the caller's responsibility -- the upload handlers assume the request was already authorized, exactly like the serving handlers.

## License

Apache-2.0 from 5.0.0 onward, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Versions up to and including 4.0.0, as published, remain under the MIT License.
