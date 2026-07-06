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
