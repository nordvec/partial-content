# Examples

Recipes beyond the README's Quick Start. Every handler manages the full HTTP protocol (200, 206, 304, 412, 416, HEAD) automatically.

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
    // S3: x-amz-checksum-sha256, GCS: x-goog-hash (sha256 component)
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
