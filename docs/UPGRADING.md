# Upgrading

Version-to-version migration. For moving to this package from another file
server, see [MIGRATION.md](./MIGRATION.md), which is a different document.

## 4.x to 5.0

Forty-five breaking changes. Which of them reach you depends on what you implement:

| If you | Read |
|---|---|
| write a custom `ResumableWriteStore` | 1, 2, 3, 21, 22, 39, 42, 43 |
| call `sweepExpired` | 2 |
| read `UploadOutcome` from `orchestrator.append` directly | 4, 6, 22, 23 |
| call `generateETag`, or write a custom `ObjectStore` | 5, 15, 34 |
| have a client that keys on upload response statuses | 6, 9, 37 |
| read `UploadOutcome` from `orchestrator.probe` directly | 40 |
| set `minAppendSize` | 7 |
| use `s3UploadStore` against an S3-compatible backend | 8, 17, 30 |
| use `azureUploadStore` | 10, 29 |
| use `httpStore` in front of an upload store's bucket | 11 |
| use `r2UploadStore` | 30, 31 |
| use `createUploadHandler` or `createTusHandler` | 18, 19, 23, 24, 25, 36, 37, 38, 45 |
| use `fsStore` or `fsUploadStore` | 14, 44 |
| use `gcsStore` | 15, 16 |
| use `serveObject` (any adapter) | 15, 26, 32, 33, 35 |
| run more than one server with `redisUploadLocker`, or write a custom `UploadLocker` | 20, 38, 43 |
| parse `Content-Range` or branch on a conditional write's status | 27, 28 |
| only serve files (no uploads) | 5, 11, 14, 15, 16, 26, 27, 32, 33 |
| run on Node.js older than 24 | 12 |
| read a key out of a store error's message | 13 |
| branch on a literal union this package exports | 35 |
| set a policy bound of 16 digits or more, or a `maxAgeSeconds` reaching past the year 9999 | 41 |

### 1. `appendChunk` returns `interrupted`

```typescript
// doc-check: fragment
// Before
return { bytesWritten };
// After
return { bytesWritten, interrupted };
```

`interrupted` is `true` when the call stopped before the body was exhausted,
`false` when it drained it. If your store already flushes what it has when a
signal fires, that branch returns `true` and the normal exit returns `false`.

Return `false` if you genuinely cannot tell: it is what the caller previously
inferred for you. Do not derive it from the abort signal, which is what this
change exists to stop; the signal says that something asked the write to yield
and nothing about whether the body was finished.

### 2. `sweepExpired` takes a cutoff object

```typescript
// doc-check: fragment
// Before
await store.sweepExpired(Date.now() - 24 * 60 * 60 * 1000);
// After
const now = Date.now();
await store.sweepExpired({
  idleSinceMs: now - 4 * 60 * 60 * 1000,
  createdBeforeMs: now - MAX_AGE_SECONDS * 1000,
});
```

Passing neither field throws. The two clocks are independent: `idleSinceMs`
reaps abandoned transfers, `createdBeforeMs` reaps resources past the lifetime
your policy already refuses them for. A resource matching either is reaped.

If you were passing the policy's max age as the old single argument, you were
reaping on the wrong clock: a client trickling one byte a minute kept the
resource out of the sweep forever while every request refused it. Set both.

The result is `{ removed, failed }`. A resource the pass condemned but could not
remove stays in place, is counted in `failed`, and is retried next pass; the
sweep no longer rejects for it, only for an unreadable listing or an aborted
signal. If you alerted on a rejected sweep, alert on `failed > 0` as well.

Implementers: honor whichever fields you are given, and return `failed`.

### 3. Capability flags are `boolean`

`enforcesOffsetCheck` and `atomicCompletion` were typed as the literal `true`.
If you wrote `true` because the compiler demanded it rather than because you
implemented the behavior, this is the moment to find out: run
`partial-content/conformance` against your store, which now exercises the
behavior behind both flags. Declaring `false` is honest and the orchestrator
will refuse the store at construction, which is the point.

### 4. `offset-mismatch` no longer carries `complete`

A 409 always reports the upload as incomplete, so the field had no correct
reader. Delete any use; the compiler will find them.

### 5. `ETagSource` uses `ObjectMetadata`'s field names

```typescript
// doc-check: fragment
// Before
generateETag({ hash: meta.etag, size: meta.contentLength, mtime: meta.lastModified });
// After
generateETag(meta);
```

`hash` becomes `etag`, `size` becomes `contentLength`, `mtime` becomes
`lastModified`. Passing a retired name throws a `TypeError` naming its
replacement, deliberately: an unrecognized property is not an error in
JavaScript, so the old name would have read as absent and your server would
have served no `ETag` at all, with no revalidation and no resumable downloads,
and nothing to notice but a cache-hit rate that was never there.

Note the mapping is to `etag`, not to `digest`. `digest` is the RFC 9530
content hash and is absent on most stores; feeding it in place of the version
identifier would silently downgrade strong validators to weak ones.

### 6. Appends answer 204, or 200 on completion

Creation still answers `201` with `Location`. A client that treated `201` as
"the append landed" should accept any 2xx, which is what the specification
describes.

### 7. `minAppendSize` binds on requests that declare no size

A non-completing append with no `Content-Length` is now refused rather than
slipping past the floor. Completing appends remain exempt, so a client uploading
with chunked transfer encoding must either declare a length or reach a
completion the wire can express. Over the IETF dialect it can: `Upload-Limit`
advertises `min-append-size`, and the request's completeness header states
completion outright rather than leaving it to be inferred.
Over tus it cannot, because completion there is inferred from a known total
length and `Upload-Defer-Length` leaves none, so `createTusHandler` refuses a
`minAppendSize` policy at construction instead of serving an endpoint whose
deferred-length uploads can never progress.

### 8. `s3UploadStore` writes its sidecar conditionally

`sidecarCas` defaults to `true`: every sidecar write carries `If-Match` (or
`If-None-Match: *` at creation). A backend that answers `NotImplemented` to the precondition now fails
every upload operation with a message naming the option; pass
`sidecarCas: false` for it, accepting that its sidecar writes are protected only
by the re-read and the one-way terminal flags. Item 17 covers a backend that
accepts the header and ignores it.

### 9. Terminal outcomes reclaim storage

A digest mismatch, an expired resource and an invalidated one now discard the
staged bytes on the request that refuses them. A later `DELETE` for such a
resource answers 404 rather than 204. If you were relying on a second call to
free the bytes, you no longer need it.

### 10. Azure block ids carry the upload's segment

`azureUploadStore` names its staged blocks after the upload as well as the
sequence number, so two uploads to one key no longer share a block namespace.
An Azure upload that was in flight when you deploy reads as invalidated on its
next request and has to restart; nothing else changes for callers. Blocks the
old scheme left staged age out on Azure's own seven-day schedule and do not
block the new ids, which keep the same width. The adapter now also refuses at
creation a key plus caller metadata whose record could cross a 7 KiB ceiling
once appended to; a creation that used to succeed and then wedge on its first
append now fails at creation with a message naming the ceiling.

### 11. `httpStore` refuses the upload prefixes by default

`httpStore` now refuses keys under `.uploads/` and `.partial-content-uploads/`
with `ObjectNotFoundError`, as every other read store refuses its sibling
upload store's prefix. An origin that legitimately serves keys under either
name passes `reservedPrefix: ""` (or the one prefix it does front).

### 12. Node.js 24 or later

`engines.node` is `>=24.0.0`. On Node.js 20 or 22, upgrade the runtime before
taking 5.0; npm warns on install below the floor (and refuses it under
`engine-strict`). Bun, Deno and edge runtimes need nothing.

### 13. Error messages no longer name the object key

`ObjectNotFoundError`, `ObjectChangedError`, `StoreUnavailableError` and every
built-in adapter's own failures name the failure, not the key: `"Object not
found"` rather than `"Object not found: <key>"`. A key is commonly a user's
filename, and a message is free text a log line prints whole. Code that parsed
the key out of a message reads it from the error's `key` field, or from the
`key` on the `onError` context:

```typescript
import { isObjectNotFoundError } from "partial-content";

function missingKey(err: unknown): string | undefined {
    return isObjectNotFoundError(err) ? err.key : undefined;
}
```

### 14. `fsStore` stays inside the real root, and the fs options are validated

`fsStore` resolves every key's symbolic links and junctions and serves it only
when the result is inside the root's real path (and it opens a final-component
link with `O_NOFOLLOW` where the platform has it). A link from one place in the
root to another still serves. One that leaves the root, or reaches the
reserved upload workspace, answers `ObjectNotFoundError` where 4.0.0 followed
it. A root whose layout links out on purpose opts back in:

```typescript
// doc-check: fragment
// Before: links were followed, wherever they led.
const store = fsStore({ root: "/srv/media" });
// After: say so when the links leaving the root are deliberate.
const store = fsStore({ root: "/srv/media", symlinks: "follow" });
```

Any value other than `"follow"` contains. `fsUploadStore` always publishes
inside the real root, and now refuses to write through a directory link that
leaves it or through a linked `.uploads`. A FIFO at a served path is refused
instead of blocking a thread.

`fsStore` and `fsUploadStore` throw one `TypeError` for a missing or relative
`root`, and the `fsStore` `cache` options `ttlMs`, `maxEntries` and `maxBytes`
throw for `NaN`, an infinity or a negative number. A value that used to
disable the bound it named now fails at construction.

### 15. `createSignedUrl` declines or throws, and the two are different

```typescript
// doc-check: fragment
const result = await store.createSignedUrl(key, { expiresInSeconds: 60 });
if (!result.ok) {
  // A decline: this store cannot sign. result.code is "no-credential" or
  // "unsupported" when the store says why; result.cause is its own error.
  // Serve the bytes yourself. Declined by 4.0.0 as a 502, now streamed.
}
// A throw is a real failure: reported with operation "sign" and answered 502
// (499 once the client has gone).
```

The signer receives the request's `signal` and is called at most once per
request. `s3Store` throws a signing failure and returns `ok: false` only when
`@aws-sdk/s3-request-presigner` cannot be loaded; `azureStore` without a
shared-key credential and `gcsStore` without a `client_email` return `ok: false`
with `code: "no-credential"`. Two things to change: catch the throw from a direct
`s3Store().createSignedUrl()` call, and make a custom store throw where it
returned `ok: false` for a failure it did not expect. `code` may gain a member:
give a `switch` over it a default branch (item 35).

### 16. `gcsStore` reads fail before the status is committed

`gcsStore.getObject` awaits the first chunk. A pinned read that finds the object
gone or replaced throws `ObjectChangedError`, an unpinned one that finds it
gone throws `ObjectNotFoundError`, and the web adapter answers each as its own
status. 4.0.0 had committed `200` and failed mid-body. Nothing to change unless
you caught a mid-stream error from a GCS read to detect a deletion.

### 17. `s3UploadStore` proves the backend honours conditional writes

Before its first conditional write the store creates a canary object under
`uploadPrefix` with `If-None-Match: *` twice, deletes it, and trusts the
backend only when the second create answered `412`. A backend that accepts the
header and ignores it now fails the first upload with an error naming
`sidecarCas: false`, where 4.0.0 wrote its sidecar unprotected:

```typescript
// doc-check: fragment
const uploads = s3UploadStore({ client, bucket, sidecarCas: false });
```

Set the option for such a backend, accepting what item 8 says it costs. The
canary needs `PutObject` and `DeleteObject` under `uploadPrefix`, which the
store already uses; the sweep reclaims one a failed delete left behind.

The multipart commit is conditional too. `publishCas` (default `true`) makes it
conditional on the destination state the completion sealed, and a second canary
probe fails the first completion on a backend that ignores the condition, with
an error naming `publishCas: false`. Set it for such a backend, accepting that
a key written between the seal and the commit is overwritten:

```typescript
// doc-check: fragment
const uploads = s3UploadStore({ client, bucket, sidecarCas: false, publishCas: false });
```

### 18. Both upload dialects take one `auditKey` shape

```typescript
// doc-check: fragment
// Before, tus:  auditKey: (uploadToken) => hash(uploadToken)
// Before, IETF: auditKey: (request) => request.headers.get("x-request-id") ?? undefined
// After, both:
auditKey: ({ request, uploadToken }) =>
  uploadToken === undefined ? requestId(request) : hash(uploadToken),
```

`uploadToken` is absent on a creation refused before a resource exists; a
creation that allocated one is asked again with the token the store minted,
before any event or error names it. Return `undefined` to report without a key.

### 19. `policy.maxSize` is required

`createUploadHandler` and `createTusHandler` throw a `TypeError` at construction
when `policy.maxSize` is missing. An endpoint with no size ceiling is a
storage-exhaustion surface, so state that choice:

```typescript
// doc-check: fragment
policy: { maxSize: Infinity }
```

### 20. The Redis locker's key and channel names changed

`redisUploadLocker` names a lock by the SHA-256 of the token in hex (under
`keyPrefix`) and publishes preempt requests on one `<keyPrefix>preempt`
channel, with one subscriber connection per locker where there was one per
acquisition. The server therefore never sees a token, and a mixed fleet cannot
see each other's locks: **drain in-flight uploads before switching versions**,
or take the brief window in which a 4.x instance and a 5.0 instance do not
exclude each other. A `subscribe` adapter that called `redis.duplicate()` per
call is now called once per locker.

### 21. Upload state reports `status`

```typescript
// doc-check: fragment
// Before
if (state.isInvalidated) refuse();
if (state.isComplete) replay();
// After
if (state.status === "invalidated") refuse();
if (state.status === "complete") replay();
```

`StoredUploadState.status` is `"incomplete" | "complete" | "invalidated"`. A
custom store returns it from `getUploadState` and reads and writes whatever
bookkeeping it likes; only the returned state changed. The union may gain a
member (item 35).

### 22. Completion digests are keyed by algorithm

```typescript
// doc-check: fragment
// Before
await store.completeUpload(token, { expectedDigest: x, now });
digestOnComplete: "sha256",
orchestrator.canVerifyDigest
// After
await store.completeUpload(token, { expectedDigests: { "sha-256": x }, expectedLength, now });
digestOnComplete: ["sha-256"], // or false
orchestrator.verifiedDigests.includes("sha-256")
```

`digestOnComplete` is `readonly UploadDigestAlgorithm[] | false`, where the
algorithms are `"sha-256"` and `"sha-512"`. The orchestrator hands a store only
the algorithms it lists, and a mismatch in any must throw
`UploadDigestMismatchError`, which now carries the `algorithm`. The memory and
filesystem stores verify `sha-512` as well. A `Repr-Digest` member whose value
is not the length its algorithm produces is ignored.

### 23. `key()` runs after the policy, and uploads take `authorize`

`key(creation)` is called only once the policy accepts the creation and before
anything is allocated, so a refused creation spends none of your allocation. It
may be async and returns a string, `{ key, metadata? }` (the metadata is
recorded and handed to `onUploadComplete` in place of the client's), or a
`Response` that refuses the creation as it stands. The creation now carries the
effective `policy` (tus also `declaredLength`).

```typescript
// doc-check: fragment
// Before: key({ request }) was the only place to look at a creation, and
// follow-up requests (probe, append, cancel) were checked by hand.
// After:
key: async ({ request, policy }) => {
  const tenant = await authenticate(request);
  if (!tenant) return new Response(null, { status: 401 });
  return { key: `${tenant.id}/${crypto.randomUUID()}`, metadata: { tenant: tenant.id } };
},
authorize: ({ request, key, metadata, operation }) =>
  metadata?.tenant === tenantOf(request) ? undefined : new Response(null, { status: 404 }),
```

`authorize` runs for probe, append and cancel under the upload's lock with the
stored key and metadata; return a `Response` to refuse. Move per-upload
ownership checks there. If you drive the orchestrator directly,
`CreateUploadRequest.key` is a thunk (`key: () => k`) and an outcome may be
`{ kind: "refused", response }`.

### 24. Timing options are validated at construction

`graceMs` outside 0 to 2147483647, and `lockTimeoutMs` outside 1 to 2147483647,
throw a `TypeError` from `createUploadOrchestrator`, `createUploadHandler` and
`createTusHandler`. `NaN`, a negative, a fractional or an oversized value
previously reached `setTimeout`, which fires at once for the oversized.

### 25. tus `Upload-Metadata` is bounded, and checksum names are matched without case

A creation whose `Upload-Metadata` header exceeds 4096 bytes or 32 pairs is
answered `400`. Raise the limits if clients legitimately send more:

```typescript
// doc-check: fragment
createTusHandler(store, { metadataLimits: { maxBytes: 16_384, maxPairs: 64 }, /* ... */ });
```

`parseUploadMetadata` returns an object with a null prototype, so `__proto__`
and `constructor` are ordinary entries: read with `Object.hasOwn(metadata, k)`,
and do not call `metadata.hasOwnProperty`. Configured checksum algorithms must
be distinct header tokens ignoring case; one that is not throws at
construction, and a configured `SHA1` now matches a request for `sha1`.

### 26. Multipart responses are bounded at 8 ranges and 8 backend reads

`maxRanges` defaults to 8 (was 50), and a request with more coalesced ranges is
answered with the full `200`. `maxBackendReads` (default 8) bounds the pinned
per-part reads of a multipart response: past it the parts are cut from one
buffered read of the span when the span is under 256 KiB, and the full `200` is
served otherwise. If you raised `maxRanges` above 8, raise `maxBackendReads` with
it, knowing that each part is then one backend request. An invalid value
(`NaN`, below 1, not a safe integer) throws a `TypeError` from `serveObject`
at construction.

### 27. `ParsedContentRange.totalSize` is `undefined` when unknown

```typescript
// doc-check: fragment
// Before
if (parsed.totalSize === -1) { /* bytes a-b/* */ }
// After
if (parsed.totalSize === undefined) { /* bytes a-b/* */ }
```

Replace every `=== -1` and `< 0` test; `totalSize` is `number | undefined`.

### 28. `EvaluatedWrite.status` admits `428`

`status` is `412 | 428`. `evaluateConditionalWrite` itself still produces
`412`; the `428` (RFC 6585 Section 3) is for a caller that refuses an
unconditional write. An exhaustive `switch` over the status needs the new case.

### 29. The Azure discard, and what it leaves

`azureUploadStore` abort and sweep no longer read the blob's properties and then
delete. By default (`discardStaged: "age-out"`) they write nothing at the key
and leave staged blocks to Azure's own seven-day collection of uncommitted
blocks. `discardStaged: "commit-empty"` reclaims them at once: it commits an
empty block list create-only (`If-None-Match: *`), which the service refuses
when a committed blob is at the key, and deletes the empty blob pinned to the
ETag the commit returned. With that option three behaviours differ from 4.0.0:

- the zero-byte blob is briefly visible at the key, and only when blocks were
  staged, and it raises a `BlobCreated` event;
- on a container with blob versioning or soft delete, a version or a soft-deleted
  copy of that empty blob can be kept, which your retention rules govern;
- a delete the service refuses (a retention policy) throws.

An upload that was overwriting an existing blob leaves its staged blocks to the
seven-day collection under either setting, because the create-only commit is
refused.

### 30. A part ceiling is a `RangeError`, or a `413`

A known length above 10,000 parts of 5 GiB is a `RangeError` from
`createUpload` on `s3UploadStore` and `r2UploadStore`. A deferred-length upload
that reaches part 10,001 gets a non-fatal `413` (`UploadAppendBoundError`),
where the R2 adapter had failed fatally. A known length now also sizes the
parts to fit 10,000 of them; a deferred length can only assume `minPartSize`
(S3) or `partSize` (R2). Nothing to change unless you matched the old R2
failure.

### 31. A custom R2 bucket's `head()` must return `customMetadata`

`r2UploadStore` stamps a random publication id on the object its completion
publishes and attributes the object at a key to a completed upload only when
its `customMetadata` carries that id. A shim passed as the bucket whose `head()`
returns only an `etag` must add `customMetadata`:
`head(key): Promise<{ etag: string; customMetadata?: Record<string, string> } | null>`.
The native binding already does. A 5.0 R2 store cannot adopt a pre-5.0
publication.

### 32. Under an `auditKey`, `onError` receives a `ProjectedError`

```typescript
// doc-check: fragment
// Before: err was the raw error, whose message could carry the key.
onError: (err, ctx) => log.error({ msg: (err as Error).message, ...ctx }),
// After, with an auditKey set: err is { name, code?, status?, operation?, cause? }.
onError: (err, ctx) => log.error({ ...(err as ProjectedError), ...ctx }),
```

Branch on `name`, `code` or `status`, not on the message, `instanceof`, or any
other property: a projected error is a plain object. `ProjectedError` is
exported from `partial-content/web`. Without an `auditKey` the raw error is
handed over unchanged. This covers the read path, both upload dialects, and a
throwing context extractor in the hono and node adapters.

### 33. `lookupMime` no longer returns web asset types by default

`lookupMime("app.js")`, `.mjs`, `.css` and `.wasm` return `undefined`. A static
asset server that serves its own build output opts in:

```typescript
// doc-check: fragment
mime: (req) => lookupMime(req.params.key, { webAssets: true }),
```

Leave the option off for stored uploads, where a script served with a script
type is an XSS vector.

### 34. Custom stores: extra metadata is fine, only three fields feed the ETag

A custom `ObjectStore` may return more fields on `ObjectMetadata`; `generateETag`
reads `etag`, `contentLength` and `lastModified` and ignores the rest. A retired
name (`hash`, `size`, `mtime`) throws only when it is an own property and its
replacement is absent, so custom metadata that happens to carry a field named
`size`, `mtime` or `hash` beside the current names is accepted, and no longer
rejects `HEAD`, conditional or `Range` requests. Only a store whose metadata
carries a retired name and lacks its replacement still throws, which is the
mistake item 5 exists to catch.

### 35. Closed unions may gain members: give each `switch` a default

These are documented "may gain a member in a minor release": `ServeErrorContext.operation`,
`ServeAuditEvent` `method` and `status`, `TransferEvent.status`,
`RangeResponseHeaders.status`, `EvaluatedWrite.status`, the `createSignedUrl`
`code`, the upload event, status and reject-reason unions, `UploadRejectReason`
and `FatalBoundReason`. A `switch` that handles every member today and has no
`default` will stop compiling, or stop being exhaustive at run time, in a
release that adds one. Add a `default` that logs and refuses.

### 36. The tus checksum extension requires `sha1`

```typescript
// doc-check: fragment
// Before: constructed, advertised "checksum", then answered a sha1 request 400.
createTusHandler(store, { checksum: { algorithms: ["sha256"], digest }, /* ... */ });
// After: add sha1 (webCryptoChecksum() already has it).
createTusHandler(store, { checksum: webCryptoChecksum(), /* ... */ });
```

tus 1.0 requires every server offering the extension to support `sha1`; a
configuration without it throws a `TypeError` at construction (matched without
case). The verification buffer must also be bounded: when neither
`checksum.maxBufferBytes` nor `policy.maxAppendSize` is set the handler throws a
`TypeError` naming those two options. If you matched the old single message,
match the two.

### 37. A content-bearing chunked append to a completed upload is refused

An append that carries content to an upload the server has already finished
answers `400` (`inconsistent-upload-length`) on both dialects and every
interop version. Interop 9 had answered a request with no `Content-Length`
`200` with the completion while cancelling its body unread; for such a request
the orchestrator now reads as far as the first byte, and a byte means the
refusal. A content-free retry of a completing request is still the idempotent
replay on interop 9 and 10, and `400` on 3, 5 and 6. A client that resent the
whole body after a lost completion response must send the completing request
without the body.

### 38. The CORS exposure lists come from their own dialect

```typescript
// doc-check: fragment
// Before: either list was importable from either subpath.
import { TUS_EXPOSED_HEADERS } from "partial-content/upload";
// After: each lives where its handler does.
import { TUS_EXPOSED_HEADERS } from "partial-content/tus";
import { UPLOAD_EXPOSED_HEADERS } from "partial-content/upload";
```

A custom `UploadLocker` receives `timeoutMs` and `auditKey` as possibly
`undefined` fields on every `acquire`, rather than omitted keys; a locker that
tests `"timeoutMs" in options` should test `options.timeoutMs !== undefined`.
The lock it returns must also carry `lease` (item 43).

### 39. A reaped append surfaces a failed discard

When an upload is reaped while an append streams, the append removes the bytes
it wrote (the GCS chunk, and the Azure staged block under `discardStaged:
"commit-empty"`; by default the block ages out) and fails with
`UploadNotFoundError`. If that removal itself fails, the removal's error is
thrown in its place, reported to `onError` and answered as a server error; the
next request still gets a truthful `404`. 4.0.0 swallowed the failure and left
an orphan no sweep finds. A custom store that discards in the same situation
should throw the discard's failure rather than the not-found.

### 40. A probed outcome states its lifetime as a deadline only

The `probed` outcome drops `remainingLifetimeSeconds` and keeps `expiresAt`,
the deadline in epoch milliseconds. The seconds left are
`Math.floor((expiresAt - now) / 1000)`, computed when you answer: the dropped
field was measured when the lock was taken and rounded the elapsed time down,
so it could promise up to a second the resource did not have.

### 41. The upload handlers refuse a bound their wire cannot state

`createUploadHandler` requires every policy bound, after a store's own
`maxAppendSize` is folded in, to be at most `999999999999999`, the largest
RFC 8941 integer; a larger one throws a `TypeError` at construction. A
client's parser refuses the whole `Upload-Limit` field on a 16-digit member,
so such a bound used to cost the client every limit the field carries.

`createTusHandler` throws on a `maxAgeSeconds` whose deadline, for an upload
created at construction, falls past the year 9999. `Upload-Expires` is an
IMF-fixdate with a four-digit year, and such a lifetime used to send a
five-digit year or `Invalid Date`.

If you passed `Number.MAX_SAFE_INTEGER` to mean "no limit", pass `Infinity`
for `maxSize` and omit any other bound: an absent bound is not enforced. `createUploadOrchestrator` keeps
accepting any non-negative safe integer.

### 42. `completeUpload` takes `expectedLength` and seals at it

```typescript
// doc-check: fragment
// Before
await store.completeUpload(token, { expectedDigests, now });
// After: the length the caller judged complete, which it acknowledged
await store.completeUpload(token, { expectedDigests, expectedLength: offset, now });
```

`CompleteUploadOptions.expectedLength` is required. The orchestrator passes the
durable offset it observed under the lock. A custom store seals its completion
at that length, refuses every later append from the seal on, and throws
`UploadOffsetConflictError` carrying the length its assembly actually holds
rather than publishing any other length, so an acknowledged append cannot be
left out of the published object. It publishes under the provider's own
precondition on the destination state the seal recorded, and throws
`UploadDestinationConflictError` when the key changed; every dialect answers
that `409`.

### 43. `UploadLock.lease` is required

```typescript
// doc-check: fragment
// Before
return { signal, release };
// After
return { signal, lease, release };
```

`lease` is an `AbortSignal` that aborts, with reason `UPLOAD_LEASE_LOST`, when
the locker can no longer prove the hold (an expired or unrenewed lease), and
that stays distinct from `signal`, which also aborts when a later acquirer asks
the holder to yield. A locker whose holds cannot be lost passes a signal that
never aborts. A 4.x custom locker returns no `lease`, so every completion
throws where the orchestrator reads `lock.lease.aborted`.

### 44. `fsUploadStore` keeps one directory per upload

Each upload is `<root>/.uploads/<token>/` with one file per fact, and
completion publishes a copy of the data with a hard link, refusing an existing
name. The workspace and every key must be on one volume, and the filesystem
must support hard links (every POSIX filesystem and NTFS). The flat files a 4.x
store wrote are only swept by age and are not read, so a 4.x filesystem upload
in flight across the upgrade answers 404 and has to restart: drain uploads
before deploying. Replacing an object that already sits at the key leaves the
key empty for an instant.

### 45. The IETF dialect's `onError` operation is `"handler"`

The IETF handler reports a failure of the dialect itself to `onError` with
`operation: "handler"`; 4.0.0 sent `"handle"`. Match the new spelling in a
branch on `ctx.operation`.

### Not breaking, but worth a line

- **Per-request policy.** `policy` also accepts a resolver,
  `(request) => policy | Promise<policy>`. Each request is judged by the size
  and append bounds it resolves; the lifetime is fixed by the policy that
  created the upload, whose deadline the store records. An invalid resolved policy is a `500` reported to
  `onError` as a `TypeError`.
- **Recorded expiry (store authors).** `CreateUploadOptions.expiresAt` carries
  the deadline the creating policy fixes; record it and report it unchanged as
  `StoredUploadState.expiresAt` (the harness check
  `state-reports-the-recorded-expiry`). A store that drops it leaves each request
  to judge expiry by the max age it resolves, as before.
- **Unlocked state reads (store authors).** `admit()` and `resourceExists()`
  read state with `repair: false` (`UploadStateReadOptions`), from a caller that
  holds no lock. Honour it: a store that heals bookkeeping on read skips the
  write and reports the state it derived.
- **Store fencing and body release (store authors).** `claimUpload()`, the
  `epoch` passed to `appendChunk`, `completeUpload` and `abortUpload`, and
  `AppendChunkOptions.releaseBody` are optional. Implement `claimUpload` to
  refuse a superseded writer with `UploadOffsetConflictError`, and call
  `opts.releaseBody?.()` at every early exit so the unread body is cancelled.
- **`onAllocated` and `onResumptionSupported`.** `onResumptionSupported` fires
  when the resource is allocated, before the creation body is read, with the
  interim response's `headers`. On the orchestrator,
  `CreateUploadRequest.onAllocated(uploadToken)` runs under the lock.
- **Error codes and guards.** Upload errors carry a stable `code`
  (`UPLOAD_NOT_FOUND` and its siblings), the matchers are type guards, and
  `UPLOAD_STORE_CONTRACT_VERSION` is exported.
- **New audit events.** `appended`, `lock-contended`, and the reject reason
  `digest-mismatch`. An event consumer with a `switch` handles them under
  item 35.
- **Interop 10.** The IETF handler also serves draft-13 and -14 and its default
  `interopVersions` are `[3, 5, 6, 9, 10]`. Pass an explicit list to keep
  serving only the versions you have tested.
- **`metadataLimits`**, **`maxBackendReads`** and **`symlinks`** are options
  with the defaults items 25, 26 and 14 describe.
- **The SBOM.** `dist/sbom.cdx.json`, a CycloneDX bill of materials, ships in
  the tarball.

- **CORS exposure lists.** `TUS_EXPOSED_HEADERS` and `UPLOAD_EXPOSED_HEADERS`
  expose `ETag`, and `TUS_EXPOSED_HEADERS` drops `Upload-Checksum`. A deployment that copied either list into
  its CORS configuration as a string should copy it again.
- **Read stores returning `readFile` output.** `toObjectBody` narrows a
  `Buffer` or bare `Uint8Array` to the `ObjectBody` a store returns, so
  `body: toObjectBody(await readFile(path))` replaces a cast. The type in return
  position is unchanged, so a consumer passing a body to `new Response(...)` is
  unaffected.

## 3.x to 4.0

See the 4.0.0 entry in [CHANGELOG.md](../CHANGELOG.md). Upload tokens issued by
any earlier version do not resolve against 4.0.0 or later, so drain in-flight
uploads before deploying, or deploy when a restart is acceptable.
