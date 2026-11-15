# Examples

Recipes beyond the README's Quick Start. Every serving handler manages the full HTTP protocol (200, 206, 304, 412, 416, HEAD) automatically.

## Hono

```typescript
import { Hono } from "hono";
import { S3Client } from "@aws-sdk/client-s3";
import { serveObject } from "partial-content/hono";
import { s3Store } from "partial-content/s3";

const client = new S3Client({ region: "eu-central-1" });
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

## Raw `http.createServer` (no framework)

The Node adapter takes `(IncomingMessage, ServerResponse)`, which is the raw
`http` server's own callback signature, so there is nothing to bridge:

```typescript
import { createServer } from "node:http";
import { serveObject } from "partial-content/node";
import { fsStore } from "partial-content/fs";
import { lookupMime } from "partial-content/mime";

const store = fsStore({ root: "/var/data/uploads" });

// Everything below /files/ is one storage key. Percent-decoding is yours to
// do (the URL carries `%20`, the storage key does not); the store rejects
// traversal, NUL bytes, and Windows device names on top of whatever you pass.
const keyOf = (req: { url?: string | undefined }) =>
  decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname.slice("/files/".length));

const files = serveObject(store, {
  key: keyOf,
  // Without a mime the response is application/octet-stream, which no browser
  // renders inline: a PDF or video downloads instead of playing.
  mime: (req) => lookupMime(keyOf(req)),
  disposition: "inline",
  // 206 range serving, 304/412 conditionals, and HEAD are all handled here;
  // anything that is not GET/HEAD/OPTIONS is answered 405.
});

createServer((req, res) => {
  if (req.url?.startsWith("/files/")) {
    void files(req, res);
    return;
  }
  res.writeHead(404).end();
}).listen(3000);
```

`serveObject` never throws at the caller: storage failures are mapped to the
truthful status (404, 502, 503 with `Retry-After`) and reported to `onError`,
so the returned promise settling is the only signal the request is done.

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
// doc-check: fragment
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
import { evaluateConditionalRequest } from "partial-content";

declare const request: Request;
declare const fileSize: number;

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
  type ParsedRange,
} from "partial-content";

// The request's headers, the metadata you already hold for the object, and
// your own read, which `range` tells how many bytes to return.
declare const reqHeaders: Headers;
declare const fileSize: number;
declare const etag: string;
declare const lastModified: string;
declare const contentType: string;
declare const checksum: string;   // raw base64 SHA-256
declare const readBytes: (range: ParsedRange | null) => Promise<ReadableStream<Uint8Array<ArrayBuffer>>>;

export async function respond(): Promise<Response> {
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
  return new Response(await readBytes(range), { status, headers });
}
```

## Write-side OCC (evaluateConditionalWrite)

Optimistic concurrency for PUT/PATCH/DELETE: the client echoes the ETag it
last saw via `If-Match`, and a mismatch means someone else wrote first.

```typescript
import { evaluateConditionalWrite } from "partial-content";

// Your data layer, and the document id this route resolved.
declare const db: {
  getDocumentMeta(id: string): Promise<{ etag: string; updatedAt: string } | null>;
  saveDocument(id: string, body: unknown): Promise<void>;
};
declare const id: string;

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
cap. Up to `maxBackendReads` parts each cost one ranged `getObject`, so tune
both to your backend:

```typescript
import { serveObject } from "partial-content/web";
import type { ObjectStore } from "partial-content";

declare const store: ObjectStore;

const handler = serveObject(store, {
  maxRanges: 5,         // more than 5 coalesced ranges serve the full 200 (default 8)
  maxBackendReads: 2,   // parts past 2 are cut from one buffered span read when
                        // the span is under 256 KiB (default 8)
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

// The request, plus the metadata your storage backend reported.
declare const req: Request;
declare const totalSize: number;
declare const etag: string;
declare const lastModified: string;
declare const storedSha256: string;   // raw base64 SHA-256

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
import { s3Store, type S3StoreOptions } from "partial-content/s3";

// Your configured S3 client (`new S3Client({ region: "eu-central-1" })`).
declare const client: S3StoreOptions["client"];

const handler = serveObject(s3Store({ client, bucket: "assets" }), {
  precompressed: true, // probes <key>.br, <key>.zst, <key>.gz
  cacheControl: "public, max-age=31536000, immutable, no-transform",
});
// A browser sending `Accept-Encoding: gzip, br` gets app.js.br with
// Content-Encoding: br, Vary: Accept-Encoding, the .br object's ETag,
// and Range support over the encoded bytes.
```

The siblings are keys you write: keep user-named uploads out of a namespace
served with `precompressed`, since the authorization you check for `app.js`
covers `app.js.br`. A variant is served only while `app.js` exists and is not
newer than the variant.

## Authorized proxy from object storage

Proxy private files through your own server so every request is authorized and audited, with full range and conditional-request support. This is the path behind `<video>`/`<audio>` seeking and PDF.js progressive loading: the media element sends `Range` to your origin, you re-check access, and only that slice is read from storage.

```typescript
import { serveObject } from "partial-content/web";
import { s3Store, type S3StoreOptions } from "partial-content/s3";

// Yours to supply: a configured S3 client, your logger and meter, and the
// authorization check that owns access.
declare const client: S3StoreOptions["client"];
declare const logger: { info(fields: object, msg: string): void; error(fields: object, msg: string): void };
declare const meter: { recordEgress(key: string, bytes: number): void };
declare const authorize: (request: Request, key: string) =>
  Promise<{ id: string; path: string; mimeType: string; filename: string } | null>;

const store = s3Store({ client, bucket: "private-documents" });

const handler = serveObject(store, {
  disposition: "inline",
  cacheControl: "private, no-cache",
  // Bytes GRANTED, at header-commit time.
  onServe: (event) => logger.info({ ...event }, "file.served"),
  // Bytes ACTUALLY transferred, once the body settles. `completed === false`
  // means the client disconnected early.
  onTransfer: (event) => meter.recordEgress(event.key, event.bytesTransferred),
  onError: (err, ctx) => logger.error({ err, ...ctx }, "file.error"),
});

export async function serveFile(request: Request, key: string) {
  // Deny here and not a single byte is read.
  const file = await authorize(request, key);
  if (!file) return new Response("Not found", { status: 404 });

  return handler(request, {
    key: file.path,
    mime: file.mimeType,
    filename: file.filename,
    // Storage keys usually embed the filename (personal data). auditKey
    // replaces `key` in every hook event with an opaque id.
    auditKey: file.id,
  });
}
```

## Split proxy/redirect on one route (preferSignedUrl)

Proxy the requests where the protocol layer earns its keep (ranges,
revalidations), offload bulk full-file egress to the bucket:

```typescript
import { serveObject } from "partial-content/web";
import type { ObjectStore } from "partial-content";

// A store whose backend can mint signed URLs (S3, R2, GCS, Azure).
declare const store: ObjectStore;

const handler = serveObject(store, {
  preferSignedUrl: ({ isRange, isConditional }) => !isRange && !isConditional,
  signedUrlExpiresSeconds: 120,
  cacheControl: "private, no-cache", // rides the signed response too
});
```

## Proving a custom ObjectStore meets the read contract

The serving path asks a read store for two things a happy-path smoke test
never looks at. A partial read must report the whole representation's size,
because that number becomes the `Content-Range` total the client sizes its
remaining requests against, and an absent key must fail in a way the adapter
can tell from a backend outage, or a missing object is answered as a 502 that
a caching layer retries forever. A store can serve every byte correctly and
still get both wrong.

`checkObjectStore` asserts them against an object the store already serves.
It only reads: it never creates and never deletes, since an `ObjectStore` has
no vocabulary for either and a read store may front something immutable, so
the same call is safe against a staging bucket:

```typescript
import { checkObjectStore, formatConformanceReport } from "partial-content/conformance";
import { memoryStore } from "partial-content/memory";

// A key the store already serves, and that object's exact bytes. Every
// assertion is measured against them, so they are the object's content and
// not a fixture the harness uploads first.
const content = new TextEncoder().encode("conformance-read-side-sample-bytes");
const store = memoryStore({ objects: { "docs/sample.bin": { body: content } } });

const report = await checkObjectStore(store, {
  key: "docs/sample.bin",
  content,
  // Optional: a key the store must NOT serve. The default is the served key
  // plus a suffix, so override it only where that could collide with a real
  // object.
  missingKey: "docs/sample.bin.absent",
});

console.log(formatConformanceReport(report));
if (!report.ok) {
  throw new Error(`store failed ${report.failed} of ${report.checks.length} read checks`);
}
```

A store instance is passed rather than a factory, because nothing in the read
contract is observed across instances. What the harness checks follows the
store's own declaration: a
store with `supportsRange: false` has the two range checks reported "SKIP"
rather than "PASS", since the serving path never asks it for a window, and so
does an object too short to slice a meaningful window from. An unverified
obligation reads as unverified either way.
