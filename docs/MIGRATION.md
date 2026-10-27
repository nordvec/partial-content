# Migration

## partial-content 3.x to 4.0

Seven breaking changes: four on surfaces every consumer touches, and three on
the write-side store contract. Five of them are compile errors. The two
exceptions are `maxBytesFatal`, which a store can ignore and still build, and
the interop status change, which no build sees at all, so read both even if
your build is green.

Two behavior changes are not compile errors. The first can turn a working read
into a 404 and the second changes a status code a client may act on, so read
them first.

Before either, one deployment note that no build and no request will show you:
**every upload token minted by 2.x or 3.x stops resolving.** The object stores
issued a token that encoded the destination key; 4.0.0 issues an opaque id and
keeps the key server-side, which is what closes the disclosure and forgery
described under Security in the changelog. The two shapes do not interoperate,
so an upload still in flight when the new build takes over answers `404` and its
client starts over. Drain the in-flight uploads first, or deploy when a restart
is acceptable. Nothing to change in your code: the token is opaque either way.

- **Read stores refuse the upload bookkeeping prefix.** `fsStore`, `s3Store`,
  `r2Store`, `gcsStore` and `azureStore` now answer `ObjectNotFoundError` for
  any key at or under a `reservedPrefix`, which defaults to the sibling upload
  store's own prefix: `.uploads/` for fs and s3, `.partial-content-uploads/` for
  r2, gcs and azure. Pointing a read store and an upload store at one root or
  bucket made the upload store's namespace readable through the read path,
  serving the in-flight bytes of an unpublished upload and the sidecar naming
  the key it is destined for, which commonly embeds a filename.

  Nothing to do if your published keys live outside that prefix, which is the
  documented arrangement. If you were deliberately serving something under it,
  those requests are 404 now: either move the objects, or point the guard
  somewhere else.

  ```typescript
  // doc-check: fragment
  // no upload store shares this bucket: serve the whole namespace
  s3Store({ client, bucket, reservedPrefix: "" });
  // you moved the upload store's prefix: match it
  s3Store({ client, bucket, reservedPrefix: "staging-uploads/" });
  ```

  `memoryStore` takes no such option and is unaffected, because its in-flight
  uploads live in a separate map rather than in `objects`. A custom
  `ObjectStore` sharing a location with an upload store should apply the same
  refusal: `reservedKeyGuard(prefix)` is exported from the package root.

- **An append to an already-complete upload answers `400` on interop 3, 5 and
  6, and `200` on interop 9.** It answered `200` on every version. draft-05
  Section 4.4.2 requires the refusal: the server "MUST NOT modify the upload
  resource and MUST respond with a 400 (Bad Request) status code". That status
  is how a client written against those revisions learns the upload it is
  retrying already finished, so answering a success told it something else.
  draft-12 Section 4.4.2 is the revision that permits the replay, saying the
  server "can choose to replay the final response to the client if the request
  to append to the completed upload is valid".

  This is only ever reached when the claimed offset IS the durable offset, so
  the request in question is a retry of a completion whose response the client
  never received, on both versions. Nothing to do if your client re-probes with
  `HEAD` on a `400`, which is the recovery every tus and IETF client already
  implements. If you have a client that treated the old `200` as confirmation,
  point it at interop 9 by sending `Upload-Draft-Interop-Version: 9`: version 9
  is served by default and replays the completion answer.

  ```typescript
  // doc-check: fragment
  // Or pin the endpoint, if every client of it is current:
  createUploadHandler(store, { key, location, policy, interopVersions: [9] });
  ```

  Serving fewer versions is the other direction: `interopVersions: [3, 5, 6]`
  keeps the older wire and its `400`, at the cost of refusing an interop 9
  client with a 400 naming the supported set.

- **Store factories now throw at construction on missing options.**
  `memoryStore`/`memoryUploadStore` without `objects`, `fsStore`/`fsUploadStore`
  with a missing or RELATIVE `root`, and `s3Store`/`s3UploadStore` without
  `client` or `bucket` throw a `TypeError` naming what to change. This surfaces
  a misconfiguration that used to appear as a `502` after a whole upload body
  had transferred, or as a store quietly reading from `process.cwd()`. If a
  relative `root` was load-bearing for you, resolve it yourself
  (`path.resolve(root)`) and pass the result.

- **`createTusHandler`**: move your policy bounds inside `policy`. The flat
  spelling on the options object is gone, so `maxSize`, `minSize`,
  `maxAppendSize`, `minAppendSize` and `maxAgeSeconds` are read only from the
  `policy` object, which is what `createUploadHandler` already required.

  ```typescript
  // doc-check: fragment
  // before
  createTusHandler(store, { key, location, maxSize: 5e9, maxAgeSeconds: 86400 });
  // after
  createTusHandler(store, {
    key,
    location,
    policy: { maxSize: 5e9, maxAgeSeconds: 86400 },
  });
  ```

  The flat form is now an unknown property, so TypeScript reports it rather than
  letting an unenforced bound ship. If you were setting some bounds flat and
  some under `policy`, check the merged result you actually want: the flat ones
  used to win, and the two halves were combined without saying so.

- **`createTusHandler`'s `auditKey`**: it is `(uploadToken: string) => string`.
  The second `metadata` parameter is gone. Nothing ever passed it (the callback
  runs on HEAD/PATCH/DELETE, which carry no creation metadata), so a declared
  parameter was always `undefined`. Only a callback that declared the parameter
  needs editing; drop it. To derive an audit id from creation metadata, map it
  in your own `onUploadEvent`, where the `created` event and the metadata are
  both in hand.

- **`CancelSignal` is removed**: `HeadObjectOptions.signal` and
  `GetObjectOptions.signal` are `AbortSignal`. If you imported the
  `CancelSignal` type from `partial-content`, use `AbortSignal`. If you passed a
  hand-rolled object shaped like the old interface (`aborted`,
  `throwIfAborted`, `addEventListener`, `removeEventListener`), pass an
  `AbortController`'s `signal` instead. Custom `ObjectStore` implementations that
  already typed their `signal` as `AbortSignal`, which is what every built-in
  store does and what `req.signal` is, need no change.

- **Custom `ResumableWriteStore`**: `getUploadState` must return `key`, the
  storage key the upload publishes to, as given to `createUpload`. Your backend
  already persists it in order to publish at all, so this is usually one field
  read from the record you already load. The compiler reports the omission.

  ```typescript
  // doc-check: fragment
  async getUploadState(uploadToken) {
    const record = await backend.find(uploadToken);
    if (!record) throw new UploadNotFoundError(uploadToken);
    return {
      key: record.key,                 // the object this upload publishes to
      offset: await backend.sumDurableBytes(uploadToken),
      // ...the rest, unchanged
    };
  }
  ```

  It closes a gap with no supported workaround: the key is produced by your
  `key()` callback BEFORE a token exists, so a caller that generated one per
  upload had no way to pair the two afterwards, and correlating the callback's
  return with the token by position across the creation call is a race rather
  than an answer. `UploadOrchestratorOptions.onUploadComplete` is the hook that
  now reports the pair at publication.

- **Custom `ResumableWriteStore`**: declare `enforcesOffsetCheck: true`, and
  make sure it is true. `appendChunk` must verify the claimed `offset` against
  durable state before writing and throw `UploadOffsetConflictError` instead of
  writing when the two disagree. The check is a preflight once per call, at the
  start of it, not something repeated per durable flush.
  `createUploadOrchestrator` refuses a store reporting `false`, the same way it
  already refuses `atomicCompletion: false`.

  ```typescript
  // doc-check: fragment
  async appendChunk(uploadToken, offset, body, opts) {
    const durableOffset = await backend.durableSize(uploadToken);
    if (offset !== durableOffset) {
      throw new UploadOffsetConflictError(uploadToken, durableOffset);
    }
    // ...write...
  }
  ```

  The lock does not make this redundant. It serializes writers but cannot prove
  the writer still holds it: an expiry-based distributed lock can be stolen from
  a holder that stalls past its TTL and then resumes, and this check is what
  makes that holder's next append a loud conflict rather than bytes interleaved
  into someone else's upload. Single-process deployments are not exempt, because
  the store outlives the assumption: the same store runs behind the in-process
  locker today and a distributed one tomorrow, with nothing in the code to
  notice the difference.

  It is a preflight per call, not one atomic step with the bytes that follow,
  and the flag does not claim otherwise. A holder that stalls MID-call and
  resumes can still land the flush it was already performing, because the
  backends accept their writes unconditionally. If your backend DOES offer a
  precondition on the write (a generation match, an ETag condition, a
  create-if-absent), use it: that turns the residual into a refusal too. What
  bounds it otherwise is cooperative, and your `appendChunk` must participate:
  test `opts.signal` at every chunk boundary and stop when it aborts, which is
  what the built-in adapters do.

- **Custom `ResumableWriteStore`**: `appendChunk` receives `maxBytesFatal`
  alongside `maxBytes`, and must honor it. Previously every bound was terminal,
  so a chunked body running past a per-REQUEST ceiling destroyed the whole
  upload. Now only a representation bound (a known length, the policy's total
  `maxSize`) invalidates, and it reports the new `UploadOverrunError` carrying
  the bound that was crossed; a request ceiling keeps the accepted prefix,
  leaves the resource healthy, and throws the new `UploadAppendBoundError` with
  the durable offset. The orchestrator answers the first as a `400` when the
  bound was the client's declared length and a `413` when it was the policy
  maximum, and the second as a `413` the client resumes from. Both classes,
  their `isUploadOverrunError` / `isUploadAppendBoundError` matchers and the
  `FatalBoundReason` type reach you from `partial-content/tus` and
  `partial-content/upload`; the classes are additionally re-exported from every
  storage subpath, and all of them are matched by `name`.

  ```typescript
  // doc-check: fragment
  if (crossedBound !== undefined && opts.maxBytesFatal) {
    await backend.markInvalidated(uploadToken);   // terminal
    throw new UploadOverrunError(uploadToken, crossedBound);
  } else if (crossedBound !== undefined) {
    throw new UploadAppendBoundError(uploadToken, durableOffset);  // resumable
  }
  ```

  A store that keeps invalidating unconditionally still compiles and is still
  safe, but it keeps the old behavior of losing an upload over a per-request
  cap.

- **Behavior, source-compatible and silent: the audit key SUBSTITUTES for the
  token on every reporting surface.** When a caller supplies an `auditKey`,
  `onUploadEvent` receives `uploadToken: undefined`, and so does the context
  passed to `onError`. Nothing stops compiling, because `uploadToken` was always
  optional on both, so a consumer that joins upload events or error records to
  its own records on the token gets silence rather than a type error. Both
  surfaces carry the `auditKey` in its place, and `UploadOrchestratorOptions`
  declares it on the `onError` context.
  Join on the `auditKey` you supply, or stop supplying one and accept that the
  capability lands in your log records: the token is the whole authorization a
  resumable upload carries, so handing it out beside an audit-safe identifier
  would put it in the exact records the identifier exists to keep it out of.

- **Behavior, no code change required**: an unknown-length body that runs past
  `maxAppendSize` now answers `413` with the upload intact and its accepted
  prefix durable, instead of terminally invalidating the resource. A client
  that retries in smaller chunks now succeeds where it previously had to start
  over.

- **Behavior, no code change required**: a creation rejected AFTER its resource
  was allocated now answers with a `Location`, so a client whose
  creation-with-upload body was refused mid-stream can resume or `DELETE` the
  prefix that landed instead of stranding it. Your `location()` callback is
  called on that path too. `Location` is already in `TUS_EXPOSED_HEADERS` and
  `UPLOAD_EXPOSED_HEADERS`, so a CORS layer built from those needs no change.

- **Behavior, no code change required**: `DELETE` on an invalidated or expired
  upload now frees its bytes and answers `204` instead of `410`/`404`. If you
  treated that `410` as "already gone", you now get the success you were
  inferring. Probes and appends on a dead resource are unchanged.

- **Behavior, no code change required**: the tus dialect's `413` reason phrase
  is "Content Too Large", the name RFC 9110 Section 15.5.14 gives the status.
  The status code, the `Tus-Max-Size` header and the body are unchanged, and
  RFC 9110 Section 15 has clients act on the code rather than the phrase. Only a
  test asserting the literal string "Request Entity Too Large" needs updating.

- **Behavior, no code change required**: a throwing `key`/`mime`/`filename`/
  `auditKey` extractor in the Hono adapter now becomes a hardened `500` and is
  reported to `onError` with `operation: "context"`, which is what the Node
  adapter already did. If you relied on that rejection reaching Hono's own error
  handler, the extractor's failure now reaches `onError` instead.

- **Custom `ResumableWriteStore`, optional cleanup**: `atomicCompletion` and
  `enforcesOffsetCheck` are typed `true` rather than `boolean`. Only a store
  that annotated them as `boolean` (via an explicit type or a widened literal)
  needs a change, and `createUploadOrchestrator` was already refusing `false` at
  construction, so nothing that worked stops working. `as const` or a
  `ResumableWriteStore` annotation on the object keeps the literal type.

- **Optional cleanup**: `await store.sweepExpired(cutoff)` on a built-in store
  no longer needs `?.`. The factories return `SweepingWriteStore`, which is
  `ResumableWriteStore` with `sweepExpired` required. An existing `?.` still
  compiles; dropping it is what stops a future refactor from turning your
  retention job into a silent no-op.

- **Custom `ResumableWriteStore`, optional cleanup**: `exactOffsetRecovery` is
  now optional, joining `appendGranularity` and `uniformPartSize`. Declaring it
  is still the honest thing to do, since it tells whoever picks your store
  whether a crash can leave the offset a few bytes behind the last acknowledged
  write, but nothing branches on it and you may drop it.

- **Custom `ResumableWriteStore`, optional cleanup**: `maxBytesFatal` is now
  optional on `AppendChunkOptions`, and absent whenever `maxBytes` is. A store
  that destructures it as required needs no change, since the field is present
  whenever there is a bound to cross; a store that narrowed it to `boolean`
  in its own signature widens that to `boolean | undefined`, and treats absent
  the way it treats `false`.

- **Custom `ResumableWriteStore`, run the harness once you are done.** Three of
  the changes above are obligations nothing can verify at construction:
  `createUploadOrchestrator` sees that you DECLARE `enforcesOffsetCheck: true`,
  not whether `appendChunk` refuses a stale offset, and a store that declares
  the check without performing it serves uploads correctly until a lock is
  stolen from a holder that stalled past its TTL.

  ```typescript
  // doc-check: fragment
  import { checkResumableWriteStore, formatConformanceReport } from "partial-content/conformance";

  const report = await checkResumableWriteStore(() => myUploadStore());
  console.log(formatConformanceReport(report));
  if (!report.ok) throw new Error(`store failed ${report.failed} conformance check(s)`);
  ```

  It needs no test framework and no dependencies, so the same call works as a
  CI step or a startup self-test. Pass `restartable: false` if your store is
  in-process by construction, which SKIPS the two cross-instance checks rather
  than passing them.

- **Optional**: `UploadOrchestratorOptions.lockTimeoutMs` bounds how long a
  request waits for a contended upload resource before the dialect answers
  `423`, and `memoryUploadLocker({ acquireTimeoutMs })` sets the in-process
  locker's own default. Both were previously fixed at 15 s:
  `AcquireOptions.timeoutMs` was public but unreachable, since the orchestrator
  is the only caller of `acquire` on a served request and passed nothing. The
  dialect factories do not expose `lockTimeoutMs`, so changing it means
  building the orchestrator directly.

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
  // doc-check: fragment
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
no dotfile policy, no SPA `single` fallback. Those are directory-tree
concerns; put them in your router or keep `sirv` for that route. A hybrid is
normal: `sirv` for the SPA shell, partial-content for user files.

Precompressed sibling lookup is NOT on that list: `precompressed: true`
negotiates `<key>.br` / `<key>.zst` / `<key>.gz` over `Accept-Encoding`
(RFC 9110 Section 12.5.3) on every store, not just the filesystem. See the
row in the option table below for what it does that a static middleware's
`gzip`/`brotli` flags do not.

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
| `acceptRanges` | always on; bound multi-range fan-out with `maxRanges` (set `1` to degrade multi-range to a full 200, which is the behavior you are migrating from) |
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
  validator on BOTH sides (RFC 9110 §13.1.5) and refuses the range when only a
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
| `gzip`, `brotli` | `precompressed: true` (or an explicit `["br", "zstd", "gzip"]` preference), on every store rather than the local directory only. It negotiates with `Accept-Encoding` per RFC 9110 Section 12.5.3, then treats the sibling as the DISTINCT representation it is: the variant's own ETag and `Last-Modified` drive conditionals and `If-Range`, `Content-Range` addresses the encoded bytes (so a resumed download of a `.br` variant is byte-correct instead of being clamped against the identity size), and `Vary: Accept-Encoding` rides every success response for a compressible type so shared caches key on the request coding |
| `single`, `extensions`, `ignores`, `dotfiles` | no equivalent, router/CDN concerns here |

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
