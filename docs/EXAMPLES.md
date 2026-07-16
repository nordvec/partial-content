# Examples

Recipes beyond the README's Quick Start. Every serving handler manages the full HTTP protocol (200, 206, 304, 412, 416, HEAD) automatically; the upload handlers manage the full resumable-upload protocol (creation, offset probes, appends, termination, expiry) the same way.

## Hono

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

## Cloudflare Workers (R2 native, no AWS SDK)

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

## Kernel only: the evaluation flow

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

## Node.js / Express (kernel only)

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

## Content-Disposition

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

## RFC 9530 Repr-Digest (end-to-end integrity)

Pass a SHA-256 digest from your storage backend for automatic `Repr-Digest` headers:

```typescript
const { status, headers, range } = evaluateConditionalRequest(
  request.headers,
  {
    totalSize: fileSize,
    etag: '"abc123"',
    // S3: x-amz-checksum-sha256; R2: checksums.sha256. GCS has no native
    // SHA-256 (x-goog-hash is crc32c/md5 only): store your own hash as
    // custom metadata and use gcsStore's digestMetadataKey.
    digest: "d2VsY29tZQ==",  // raw base64 SHA-256
  },
);
// Response headers include: Repr-Digest: sha-256=:d2VsY29tZQ==:
// Same digest on both 200 (full) and 206 (partial) -- covers the full representation
```

## Advanced: manual primitives

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

## Write-side OCC (evaluateConditionalWrite)

Optimistic concurrency for PUT/PATCH/DELETE: the client echoes the ETag it
last saw via `If-Match`, and a mismatch means someone else wrote first.

```typescript
import { evaluateConditionalWrite } from "partial-content";

export async function PUT(req: Request) {
  const current = await db.getDocumentMeta(id); // { etag, updatedAt } or null

  const verdict = evaluateConditionalWrite(req.headers, {
    etag: current?.etag,               // strong validator required for If-Match
    lastModified: current?.updatedAt,
    exists: current !== null,          // enables If-None-Match: * (create-only)
  });
  if (!verdict.proceed) {
    // 412; headers include the CURRENT ETag so the client can resync
    return new Response(null, { status: verdict.status, headers: verdict.headers });
  }

  await db.saveDocument(id, await req.json());
  return new Response(null, { status: 204 });
}
```

`If-None-Match: *` makes the write create-only (fails 412 if the resource
exists); `exists` must be passed explicitly for that pattern, or the kernel
throws rather than guess and overwrite.

## Multi-range (multipart/byteranges)

Nothing to wire: `serveObject` serves `Range: bytes=0-99,5000-5099` as a
`multipart/byteranges` 206 with an exact precomputed `Content-Length`, parts
in request order, gap/overlap coalescing, and the `maxRanges` amplification
cap. Each part costs one ranged `getObject`, so tune the cap to your backend:

```typescript
const handler = serveObject(store, {
  maxRanges: 5,   // at most 5 backend reads per request (default 50)
});
// maxRanges: 1 disables multipart entirely: multi-range requests degrade to
// a full 200 and every request costs at most one backend read.
```

Kernel-only consumers: `parseRanges()` + `buildMultipartHeaders()` +
`buildMultipartPartHeader()` / `multipartEpilogue()` are the framing
primitives (see Advanced: manual primitives).

## Digest negotiation (Want-Repr-Digest / Want-Content-Digest)

A client that wants integrity metadata asks for it; one that cannot use it
declines. Both fields negotiate independently:

```
GET /file HTTP/1.1
Want-Repr-Digest: sha-256=5        -> Repr-Digest: sha-256=:<base64>:
Want-Repr-Digest: sha-256=0        -> no digest headers at all
Want-Content-Digest: sha-256=0     -> Repr-Digest only, no Content-Digest
(no Want-* header)                 -> both emitted on a full 200 GET
```

The negotiation is exported for kernel-only consumers:

```typescript
import { clientWantsDigest, clientWantsContentDigest } from "partial-content";

const meta = {
  totalSize, etag, lastModified,
  digest: clientWantsDigest(req.headers) ? storedSha256 : undefined,
  contentDigest: clientWantsContentDigest(req.headers),
};
```

## Precompressed variants (brotli/zstd/gzip siblings)

Upload encoded siblings at build or ingest time, then let negotiation pick:

```bash
# alongside dist/app.js, produce dist/app.js.br and dist/app.js.gz
brotli -k dist/app.js && gzip -k dist/app.js
```

```typescript
import { serveObject } from "partial-content/web";
import { s3Store } from "partial-content/s3";

const handler = serveObject(s3Store({ client, bucket: "assets" }), {
  precompressed: true, // probes <key>.br, <key>.zst, <key>.gz
  cacheControl: "public, max-age=31536000, immutable, no-transform",
});
// A browser sending `Accept-Encoding: gzip, br` gets app.js.br with
// Content-Encoding: br, Vary: Accept-Encoding, the .br object's ETag,
// and Range support over the encoded bytes.
```

## Split proxy/redirect on one route (preferSignedUrl)

Proxy the requests where the protocol layer earns its keep (ranges,
revalidations), offload bulk full-file egress to the bucket:

```typescript
const handler = serveObject(store, {
  preferSignedUrl: ({ isRange, isConditional }) => !isRange && !isConditional,
  signedUrlExpiresSeconds: 120,
  cacheControl: "private, no-cache", // rides the signed response too
});
```

## Resumable uploads: a tus 1.0 endpoint

Upload and serving are two sides of the same storage: point an upload store
and a read store at the same root/bucket/map and a completed upload is
immediately servable with ranges, conditionals, and Repr-Digest.

```typescript
import { createTusHandler } from "partial-content/tus";
import { serveObject } from "partial-content/web";
import { fsStore, fsUploadStore } from "partial-content/fs";

const root = "/var/data/files";
const uploads = createTusHandler(fsUploadStore({ root }), {
  // The server decides the key; the client filename stays metadata.
  key: () => crypto.randomUUID(),
  location: (token) => `/files/upload/${token}`,
  resolveToken: (req) => new URL(req.url).pathname.split("/").pop() || undefined,
  maxSize: 1024 * 1024 * 1024,
  maxAgeSeconds: 24 * 60 * 60,
  onUploadEvent: ({ uploadToken, event }) => logger.info({ uploadToken, ...event }, "upload"),
  onError: (err, ctx) => logger.error({ err, ...ctx }, "upload.error"),
});
const downloads = serveObject(fsStore({ root }), { disposition: "attachment" });

// Mount: POST /files/upload creates; HEAD/PATCH/DELETE /files/upload/<token>
// probe, append, and terminate; OPTIONS discovers capabilities. Authorize
// BEFORE calling the handler, exactly like the serving side.
```

Browser clients: any tus 1.0 client works unmodified. Give it the creation
URL as its endpoint; the `Location` header on the 201 is the upload resource
every follow-up request (offset probe, append, termination) targets, and the
client resumes an interrupted transfer by re-probing that URL with HEAD. The
handler advertises `creation`, `creation-with-upload`,
`creation-defer-length`, `termination`, and `expiration`, so clients that use
those extensions (unknown-length streams, upload cancellation, expiry
display) negotiate them automatically. Cross-origin uploaders additionally
need the tus headers exposed via `extraHeaders` (e.g.
`Access-Control-Expose-Headers: Location, Upload-Offset, Upload-Length,
Upload-Expires, Tus-Resumable`) plus your CORS layer's
`Access-Control-Allow-*` response.

Housekeeping: expired resources refuse interaction on their own
(`maxAgeSeconds`), but their storage is reclaimed by the store's sweep hook.
Run it on a schedule with the same cutoff:

```typescript
const store = fsUploadStore({ root });
// e.g. hourly: reap uploads idle longer than the policy's max age
await store.sweepExpired(Date.now() - 24 * 60 * 60 * 1000);
```

## Resumable uploads: a custom ResumableWriteStore

Any backend that can append durably and publish atomically can host
resumable uploads. Implement the write contract; the object you pass to
`createTusHandler`/`createUploadHandler` is checked structurally, and the
error classes are matched by `name`, so a custom store can throw
equivalently-named errors without importing them (or import them from a
built-in store subpath such as `partial-content/memory`).

```typescript
import { UploadNotFoundError } from "partial-content/memory";

const myUploadStore = {
  // ── Capability flags: HONEST, per backend, never aspirational ──
  exactOffsetRecovery: true,   // only if the derived offset is crash-durable
  atomicCompletion: true,      // completeUpload must be all-or-nothing
  digestOnComplete: false as const, // "sha256" ONLY if you verify before publishing
  // appendGranularity / uniformPartSize / maxAppendSize: set when the
  // backend forces them; omit for byte-exact appends.

  async createUpload({ key, length, metadata, now }) {
    // Allocate the resource; fold EVERYTHING resumption needs into the
    // token (the built-ins encode key + backend upload id). Nothing
    // upstream ever parses it.
    const uploadToken = await backend.allocate({ key, length, metadata, createdAt: now });
    return { uploadToken };
  },

  async getUploadState(uploadToken) {
    const record = await backend.find(uploadToken);
    if (!record) throw new UploadNotFoundError(uploadToken);
    return {
      // THE rule: derive the offset from the backend's own durable
      // bookkeeping (part listing, block list, fsynced size). Never
      // persist an offset counter next to the data: the two cannot be
      // written atomically, and their post-crash drift is the corruption
      // resumable uploads exist to prevent.
      offset: await backend.sumDurableBytes(uploadToken),
      length: record.length,            // immutable once known
      isComplete: record.isComplete,
      isInvalidated: record.isInvalidated, // terminal; recorded durably
      createdAt: record.createdAt,
      lastAppendAt: record.lastAppendAt,
      metadata: record.metadata,
    };
  },

  async appendChunk(uploadToken, offset, body, { maxBytes, now, signal }) {
    // Write at `offset` (already validated against fresh state, under the
    // upload's lock). Rules:
    // - Stop at `maxBytes`; if the body tries to cross it, terminally
    //   invalidate the resource (bytes past a known length are the
    //   protocol's terminal fault, and only you see the stream).
    // - Honor `signal` at chunk boundaries, flushing what you have: the
    //   orchestrator's grace window is already built into it.
    // - Return the bytes made DURABLE by this call; the next
    //   getUploadState must agree with it.
    const bytesWritten = await backend.append(uploadToken, offset, body, { maxBytes, signal });
    return { bytesWritten };
  },

  async completeUpload(uploadToken, { expectedDigest, now }) {
    // Publish atomically: after success the object is readable under its
    // key; after ANY failure nothing new is visible to readers. If you
    // declared digestOnComplete: "sha256", verify expectedDigest against
    // the assembled bytes BEFORE publishing and throw an
    // UploadDigestMismatchError-named error on mismatch.
    const { etag, digest } = await backend.publishAtomically(uploadToken);
    return { etag, digest };
  },

  async abortUpload(uploadToken) {
    await backend.discard(uploadToken); // idempotent: already-gone is fine
  },

  async sweepExpired(olderThanMs) {
    // Optional: reap resources idle since before the cutoff (epoch ms).
    return { removed: await backend.reapIdleSince(olderThanMs) };
  },
};
```

The dialect handlers do not call these methods concurrently for one upload
resource: the orchestrator serializes every interaction (probes included)
under a cooperative-preemption lock and re-derives fresh state before each
decision. Your store's job is durability and honesty, not coordination --
just remember the default lock is in-process, so multi-instance deployments
supply a shared `locker` (see API.md, Locking).
