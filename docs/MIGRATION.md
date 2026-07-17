# Migration

## partial-content 2.x to 3.0

Two breaking changes, both on the write-side extension points. If you use the
built-in lockers (`memoryUploadLocker`, `redisUploadLocker`) and the built-in
stores, nothing changes for you.

- **Custom `UploadLocker`**: `acquire` loses its `onPreemptRequested` callback
  parameter (`acquire(uploadToken, opts?)`), and the returned `UploadLock` must
  now carry a `signal`: `{ signal: AbortSignal; release(): void }`. Instead of
  invoking a callback to ask the holder to yield, create an `AbortController` at
  acquire time and abort it (reason `UPLOAD_PREEMPTED`, exported) when a later
  acquirer wants the lock; expose `controller.signal` as `lock.signal`. The
  orchestrator threads that signal into the holder's store write, so preemption
  is a real cancellation rather than an advisory call.

  ```typescript
  // before
  acquire(token, onPreemptRequested, opts) { /* ... call onPreemptRequested() ... */
    return { release() {} };
  }
  // after
  acquire(token, opts) {
    const controller = new AbortController();
    // ...abort(UPLOAD_PREEMPTED) it when a later acquirer arrives...
    return { signal: controller.signal, release() {} };
  }
  ```

- **Custom `ResumableWriteStore`**: `digestOnComplete` is now `"sha256" |
  false` (the `"crc32c"` option is gone). A store that cannot verify a whole-
  representation SHA-256 reports `false`.

## partial-content 1.x to 2.0

2.0 adds the resumable-upload surface (`partial-content/tus`,
`partial-content/upload`, and a `ResumableWriteStore` factory on every
storage subpath). Everything new is additive. Three existing type signatures
tightened; plain-JavaScript callers are unaffected by the first two, and the
third only surfaces if you switch on the operation string:

- **`evaluateConditionalRequest` `opts.method`** is now the union
  `"GET" | "HEAD"` (previously a wider string type). Passing any other
  method was never meaningful; a TypeScript caller forwarding `req.method`
  verbatim now needs to narrow it first (writes belong to
  `evaluateConditionalWrite`, everything else to your router's 405).
- **`preferSignedUrl` `info.method`** is now the literal `"GET"`. HEAD
  requests never consult the predicate (a metadata probe answered with a
  bare 302 defeats exactly the clients that send HEAD), so the field could
  never be anything else; the type now says so. Remove any dead
  `method === "HEAD"` branches.
- **The serve adapters' `onError` `operation` union gains `"sign"`**:
  signed-URL minting failures now report as `operation: "sign"` (previously
  they were folded into `"get"`/`"head"`). If you switch exhaustively on the
  operation, add the arm.

Everything else is unchanged: no serving option was renamed or removed, and
the wire behavior of the read side is identical.

## Migrating from send or sirv

Both are excellent libraries for their job: serving a **local directory** over
Node's `http`. Migrate when the job changes, typically because your bytes
moved to object storage (S3, R2, GCS, Azure), or because you need protocol
behavior they don't implement. If you are serving a static asset folder and
that's the whole job, keep what you have.

### What changes conceptually

`send` and `sirv` resolve a **URL path against a directory tree** (index
files, extension fallbacks, dotfile policy). partial-content serves an
**explicit storage key against a backend**: you decide the key, the library
handles the HTTP protocol (200/206/304/412/416, HEAD). There is no directory
walking, so directory-oriented features have no equivalent here by design.

### What you gain

- Storage backends: S3-compatible, R2 native, GCS, Azure, any range-capable
  HTTP origin, local fs, in-memory. Same handler, same semantics.
- Multi-range requests: `send` collapses any request with more than one range
  to a full 200 (see the single-range check in its range handling);
  partial-content serves real `multipart/byteranges` with coalescing and an
  amplification cap (`maxRanges`).
- RFC 9530 `Repr-Digest` integrity headers with `Want-*` negotiation.
- Pinned reads: a concurrent overwrite cannot splice two file versions into
  one download (the storage read is conditioned on the validator the response
  advertises).
- Runtime portability: the same code runs on Node, Bun, Deno, and Workers
  (Fetch-primitive kernel; the Node adapter is one import away).
- Files that appear at runtime: `sirv` in production mode snapshots the
  directory at boot and 404s files created afterwards (documented behavior;
  `dev: true` lifts it at a large throughput cost). partial-content always
  consults the backend.

### What you lose (on purpose)

No `index.html` resolution, no extension fallback (`/page` -> `page.html`),
no dotfile policy, no SPA `single` fallback, no precompressed `.gz`/`.br`
sibling lookup. Those are directory-tree concerns; put them in your router or
keep `sirv` for that route. A hybrid is normal: `sirv` for the SPA shell,
partial-content for user files.

### From send

Before:

```js
import send from "send";

app.get("/files/:name", (req, res) => {
  send(req, req.params.name, { root: "/var/data", maxAge: "1d", immutable: true })
    .on("error", (err) => res.sendStatus(err.status ?? 500))
    .pipe(res);
});
```

After:

```js
import { serveObject } from "partial-content/node";
import { fsStore } from "partial-content/fs";

const store = fsStore({ root: "/var/data" });

app.get("/files/:name", serveObject(store, {
  key: (req) => req.params.name,
  cacheControl: "public, max-age=86400",
  immutable: true,
}));
```

Option mapping:

| send | partial-content |
|---|---|
| `root` | `fsStore({ root })`; keys are validated against root escape |
| `maxAge` (ms) + `cacheControl` | `cacheControl: "<verbatim header>"`, you write the header string, so there is no ms-vs-seconds unit trap |
| `immutable` | `immutable: true` (appends the directive if not present) |
| `etag` / `lastModified` | always emitted from storage metadata (strong when a content hash exists, weak size+mtime otherwise) |
| `acceptRanges` | always on; bound multi-range fan-out with `maxRanges` (set `1` to degrade multi-range to a full 200, which matches send's behavior) |
| `start` / `end` | client ranges come from the `Range` header; for a server-forced byte window, call the kernel primitives directly |
| `dotfiles`, `index`, `extensions` | no equivalent, encode path policy in your `key` function or router |

Event mapping:

| send event | partial-content |
|---|---|
| `error` | `onError(err, ctx)` (storage-boundary failures; terminal status is in the response) |
| `headers` | `securityHeaders(mime)`, a function of the response MIME type returning extra headers |
| `file` | `onServe(event)` |
| `stream` / `end` | `onTransfer(event)` (bytes expected vs transferred, completion flag) |
| `directory` | no equivalent (no directory semantics) |

Two behavioral differences worth knowing before you flip traffic:

- **`Cache-Control: no-cache` on the request**: send honors it during
  conditional evaluation, which means spec-compliant `fetch()` clients never
  get a 304 from send. partial-content ignores request cache directives
  (they address caches, not origin conditional evaluation). Your
  revalidation rate will go up, that is the intended fix.
- **Weak validators under If-Range**: partial-content requires a strong
  validator on BOTH sides (RFC 7233 §3.2) and refuses the range when only a
  weak ETag exists server-side, falling back to a full 200 rather than
  risking a spliced body.

### From sirv

`sirv` is a static-asset middleware with a boot-time cache; most migrations
keep sirv for the asset folder and adopt partial-content for dynamic or
private files. If you are replacing it outright:

```js
import { serveObject } from "partial-content/node";
import { fsStore } from "partial-content/fs";

const store = fsStore({ root: "public", cache: { ttlMs: 1000 } });

app.use("/assets", serveObject(store, {
  key: (req) => req.path.slice(1),
  cacheControl: "public, max-age=31536000",
  immutable: true,
}));
```

| sirv | partial-content |
|---|---|
| `dev: false` boot snapshot | opt-in hot-object cache (`fsStore({ cache })`): TTL-revalidated, serves runtime-created files, LRU-bounded (`maxEntries`, `maxBytes`) |
| `etag: false` (default) | validators always on, `If-None-Match` -> 304 works out of the box |
| `maxAge` (seconds) + `immutable` | `cacheControl` verbatim + `immutable: true` |
| `setHeaders(res, path, stats)` | `securityHeaders(mime)` |
| `onNoMatch` | 404 response is built in; wrap the handler to customize |
| `single`, `extensions`, `gzip`, `brotli`, `ignores`, `dotfiles` | no equivalent, router/CDN concerns here |

### Checklist

1. Pick the store for where the bytes live (`/fs`, `/s3`, `/r2`, `/gcs`,
   `/azure`, `/http`, `/memory`).
2. Write the `key` function; put any path policy (dotfiles, extensions) there.
3. Move cache policy into a verbatim `cacheControl` string (watch the unit:
   send's `maxAge` was milliseconds, sirv's was seconds).
4. Port `headers`/`setHeaders` hooks to the `securityHeaders(mime)` function.
5. Run your conditional-request paths (`If-None-Match`, `If-Range`, `Range`)
   against the new handler; `curl -H "Range: bytes=0-1"` should return a 206
   with an exact `Content-Range`.
