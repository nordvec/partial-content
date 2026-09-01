# Changelog

## 4.0.0 (2026-09-01)

Four security fixes, upload-path correctness, conformance harnesses for read and
write stores, and a round of contract gaps closed. Three changes are breaking
for custom `ResumableWriteStore` implementers (`enforcesOffsetCheck`,
`maxBytesFatal`, and the new `StoredUploadState.key`), and four reach consumers
of the built-ins: the tus handler takes its bounds only as a `policy` object,
its `auditKey` callback takes one parameter, the storage contract's cancel
signal is the platform `AbortSignal`, and an append to an already-complete
upload is now refused `400` on interop versions 3, 5 and 6 as those revisions
require. Separately, the tokens the built-in object stores issue change shape,
so an upload in flight across the upgrade has to restart; the token stays opaque
to callers, so no code changes with it.

### Security

All four fixes below apply to every published version that shipped the
resumable-upload object stores, **2.0.0 through 3.0.1**. Upgrading to 4.0.0 is
the remedy; there is no patch release for the 3.x line, whose supported-version
policy is the latest published release. The first and third concern deployments
using `s3UploadStore`, `r2UploadStore`, `gcsUploadStore` or `azureUploadStore`,
which are the stores that encoded the destination key into the token. The second
reaches those four and `fsUploadStore`, which names its files after the token.
The fourth concerns any deployment pointing a read store and an upload store at
one root or bucket. A deployment serving only reads, with no upload store, is
unaffected by all four.

- **An upload token is now the resource id and nothing else.** The S3, R2, GCS
  and Azure tokens were base64url JSON carrying the destination key alongside
  the id, which had two consequences. The key was disclosed to whoever held the
  token, and it routinely embeds a filename or a tenant identifier, so an
  application minting uploads server-side under keys its users were never meant
  to see was publishing them in the token. And the key could arrive FROM the
  client: in `s3UploadStore`, where the metadata sidecar is named after the
  whole token, one path did not require the sidecar, so `getUploadState` and
  `completeUpload` fell through to reading the final object under the key taken
  straight from the token. Anyone who could reach the upload endpoint could mint
  `{"key":"<any key>","uploadId":"x"}` and read back existence, exact byte
  length and last-modified for arbitrary objects in the bucket using the
  application's own credentials, and `completeUpload` would report an unrelated
  object's ETag as that upload's. Writes were never reachable this way, since S3
  binds the multipart id to the key.

  The token is now an opaque UUID, and the destination is held only in the
  server-side record, so a key can neither travel to a client nor arrive from
  one. The forgery class disappears rather than being guarded: there is no key
  in a token to tamper with, and the per-adapter comparison that used to catch a
  tampered key is gone with it. A token that is not one the store minted is
  refused before any backend call. Two further effects fall out: one resource
  now has exactly one token string, since a UUID has a single spelling; and an
  S3 sidecar name no longer grows with the destination key, which could push it
  past the 1024-byte object-key limit for a long key.

  To keep a retried completion idempotent under the stricter rule, the S3
  sidecar is MARKED completed at publication rather than deleted, and the sweep
  reaps it once idle like any other bookkeeping. A resource whose bookkeeping is
  already gone answers 404 rather than reporting the published object, matching
  what R2, GCS and Azure have always done.

  Tokens issued by any earlier version do not resolve against this release, so
  an upload in flight across the upgrade must be restarted. Deploy when a
  restart is acceptable, or drain the in-flight uploads first.
- **The upload token no longer reaches the error sink `auditKey` redacts it
  from.** Possession of an upload token authorizes appending to, probing and
  cancelling that upload, and `auditKey` is the promise that a caller supplying
  a safe identifier never receives the capability on a log surface. Only half of
  it was kept: the orchestrator blanked the token from the reported context and
  passed the error object through untouched, while twenty-two adapter messages
  interpolated the token, and the filesystem store names its files after the
  token so every errno message and `path` carried it too. A log reader could
  resume another caller's upload. Those messages no longer name the token, and
  the orchestrator now replaces it wherever it appears in a reported error's
  message, errno `path` or stack; the replacement keeps the prototype and every
  own property, so `instanceof`, `code`, `status` and `cause` still work.
- **One upload resource, one token string.** The old JSON token had many
  spellings of one upload: reordering its fields, adding a property, or padding
  the base64 all decoded to the same resource while producing different strings.
  Appends are serialized by locking on the token string, so a second spelling
  was a second lock over one resource: two appends could clear the same offset
  preflight and write the same slot, leaving the offset acknowledged to a client
  diverged from the bytes that are durable, and a cancel racing an append could
  be undone by it. An opaque id has one spelling, so the ambiguity is gone by
  construction rather than rejected by a check.
- **A read store no longer serves an upload store's bookkeeping.** Pointing a
  read store and an upload store at the same root or bucket is the documented
  arrangement, and it is what makes a completed upload servable without copying
  it. It also put the upload store's own namespace inside the read store's:
  a request for the right key served the in-flight bytes of an upload nobody
  had published yet, and the sidecar naming the key it is destined for, which
  commonly embeds a filename. An upload token is the only handle meant to reach
  any of that, and a read handler holds none, so the effect was that the
  resource the upload protocol guards behind an unguessable token was also
  reachable through a path the read handler authorizes by key. `fsStore`,
  `s3Store`, `r2Store`, `gcsStore` and `azureStore` now take `reservedPrefix?`
  and refuse a key at or under it with the same `ObjectNotFoundError` a missing
  object gets, on `headObject`, `getObject` and `createSignedUrl`. It DEFAULTS
  to the sibling upload store's own prefix (`.uploads/` for fs and s3,
  `.partial-content-uploads/` for r2, gcs and azure), because the safe posture
  has to be what a consumer gets without knowing to ask for it. Pass
  `reservedPrefix: ""` to serve the whole namespace where no upload store shares
  the location, or your own value where you changed `uploadPrefix`.
  `memoryStore` is unaffected: its in-flight uploads live in a separate map,
  never in `objects`. The guard is exported from the package root as
  `reservedKeyGuard(prefix)` for custom stores in the same arrangement.

### Changed (breaking)
- **`createTusHandler` takes its bounds only as `policy`.** `TusHandlerOptions`
  accepted the same five bounds twice, spelled flat on the options object and
  again inside a `policy` object, with the flat spelling winning on collision.
  Two spellings for one setting is a silent-misconfiguration surface: a caller
  who set `maxSize` flat and the rest under `policy` got a policy assembled from
  both halves, and nothing said which of the two a given bound came from.
  `policy` is the only form now, which is what the IETF dialect's
  `createUploadHandler` already required, so the two dialects configure
  identically. Move the bounds inside: `{ maxSize: n }` becomes
  `{ policy: { maxSize: n } }`. TypeScript flags the flat form as an unknown
  property, so this does not fail silently.
- **`TusHandlerOptions.auditKey` takes one parameter.** The signature declared a
  second `metadata` argument that no call site ever passed: the callback runs on
  resource requests (HEAD/PATCH/DELETE), which carry no creation metadata, and
  creation happens before a token exists to map. A parameter that is always
  `undefined` is a promise the code cannot keep, and one an implementer can
  reasonably branch on. It is now `(uploadToken: string) => string`. Breaking
  only for a caller that declared the second parameter; a caller that needs an
  audit id derived from creation metadata correlates it in its own
  `onUploadEvent`, which is what the parameter was pointing at without doing.
- **`CancelSignal` is removed; the storage contract's `signal` is
  `AbortSignal`.** `HeadObjectOptions.signal` and `GetObjectOptions.signal` were
  typed as a hand-written structural stand-in for `AbortSignal`, which every
  built-in store already declared as the real thing and every caller already
  passed a real `AbortSignal` to. The stand-in was narrower than the platform
  type it mirrored, so it could drift from it while looking authoritative.
  Breaking for a consumer who imported the `CancelSignal` type, or who passed a
  hand-rolled object that satisfies the old four members and is not an
  `AbortSignal`; pass an `AbortController`'s signal instead.
- **Crossing a per-request byte ceiling no longer destroys the upload.**
  `maxBytes` collapsed three different constraints into one number whose breach
  always meant invalidation: room toward a known length, the policy's total
  `maxSize`, and `maxAppendSize`. The first two bound the REPRESENTATION, and
  bytes past either really are the spec's terminal fault. The third bounds only
  the REQUEST, so a chunked client with no `Content-Length` that streamed past
  it lost its entire upload over what is a server nicety. `appendChunk` now
  receives `maxBytesFatal` next to `maxBytes`, and the two outcomes now have
  their own error classes. Both classes, their matchers and the new
  `FatalBoundReason` type reach consumers from either dialect subpath, and the
  classes are re-exported from every storage subpath as well; the matchers
  compare `name`, so a store that throws an equivalently named error is
  recognized without importing anything. A representation bound invalidates the resource durably
  and raises the new `UploadOverrunError` (with `isUploadOverrunError`) carrying
  the bound that was crossed, which the dialects answer `400` when the bound
  was the client's declared length and `413` when it was the policy maximum. A
  request ceiling keeps the accepted prefix, leaves the resource healthy, and
  throws the new `UploadAppendBoundError` (with `isUploadAppendBoundError`)
  carrying the durable offset; both dialects answer it `413`, and the client
  resumes in smaller chunks instead of starting over. A known content size
  never reaches this path: the engine still refuses an oversized append up
  front. Breaking for custom stores, which must read the new field to stop
  invalidating unconditionally.
- **A store must declare `enforcesOffsetCheck: true`.** The store contract
  asked adapters to verify a claimed offset against durable state at write time
  only where the check was "cheap", which made the sole protection against a
  two-writer race optional in the one deployment shape that needs it. Every
  expiry-based distributed lock can be stolen from a holder that stalls past
  its TTL and then resumes, and this check is what turns that holder's late
  append into a loud `UploadOffsetConflictError` instead of silent
  interleaving; the lock cannot carry the guarantee, because it serializes
  writers without proving the writer still holds it. The check is now a MUST at
  the start of every `appendChunk`, declared through a required capability
  flag, and `createUploadOrchestrator` refuses a store reporting `false` the
  same way it already refuses `atomicCompletion: false`. Every built-in store
  already performed the check and now declares it. A custom store adds the
  flag, and the check itself if it was relying on the lock alone. Single-process
  deployments are not exempt: the store is where the deployment shape stops
  being knowable, since the same store runs behind the in-process locker today
  and a distributed one tomorrow with no code change to notice. The flag claims
  a preflight per call, not one atomic step with the bytes: a holder that
  stalls mid-call and resumes can still land the flush it was performing,
  because these backends accept their writes unconditionally. That residual is
  bounded by the lock signal every adapter tests at each chunk boundary, with a
  ceiling of one stale write, and closing it entirely needs a backend-enforced
  fencing token. Documented rather than implied, so nobody reads the flag as
  "stale writes are impossible".
- **An append to an already-complete upload is refused `400` on interop 3, 5
  and 6.** It answered `200` on every version. draft-05 Section 4.4.2 is
  explicit that the server "MUST NOT modify the upload resource and MUST
  respond with a 400 (Bad Request) status code", and the refusal is not
  pedantry: it is how a client written against those revisions learns that the
  upload it is retrying already finished. Answering a success there tells it
  the append landed, which is a different fact. Interop 9 is the revision that
  changes the answer, and it is served too, so a consumer that wants the
  completion replayed asks for interop 9 rather than losing the behavior. The
  engine reaches this case only when the claimed offset IS the durable offset,
  so both answers concern the same request, a retry of a completion whose
  response the client never received. Breaking for a client that treated the
  `200` as confirmation on an older version; it now sees the status its own
  revision defines.
- **`StoredUploadState` carries `key`.** Every store now reports the storage
  key its upload publishes to, which every backend already persists in order
  to publish at all. Without it there was no supported way to learn which
  object an upload became: the key is produced by the `key()` callback before
  a token exists, and pairing that callback's return with the token by
  position across the creation call is a race rather than an answer. Breaking
  for a custom `ResumableWriteStore`, whose `getUploadState` must return it;
  the compiler reports the omission. Consumers of the built-in stores need no
  change.

### Changed
- **Store factories validate their options at construction.**
  `memoryStore`/`memoryUploadStore` require `objects`, `fsStore`/`fsUploadStore`
  require an absolute `root`, and `s3Store`/`s3UploadStore` require `client` and
  `bucket`. Each throws a `TypeError` naming what to change. A missing `objects`
  map used to surface as a `502` at publication, after the whole body had
  transferred, which is the most expensive possible moment to learn about a
  typo in a constructor call. A relative `root` was documented as forbidden and
  accepted anyway, silently anchoring to `process.cwd()`, which differs between
  an interactive shell and a service manager, so one configuration pointed at
  two directories.
- **`atomicCompletion` and `enforcesOffsetCheck` are typed `true`.**
  `createUploadOrchestrator` has always refused a store reporting `false` for
  either, so `boolean` invited an author to write a value the runtime rejects
  and find out at server boot instead of at the keystroke.
- **`AppendChunkOptions.maxBytesFatal` is optional, and absent whenever
  `maxBytes` is.** With no bound there is nothing to cross, so nothing can be
  fatal, and a caller should not have to state a consequence for a limit it
  never set. The orchestrator derives the two from one decision, so it is
  present whenever `maxBytes` is; an adapter reading it absent treats a
  crossing as non-fatal, the direction that keeps the resource.
- **`ResumableWriteStore.exactOffsetRecovery` is optional.** It sits with
  `appendGranularity` and `uniformPartSize`, which were already optional: all
  three are disclosures about the backend, and nothing in the engine or the
  orchestrator branches on any of them. A store that omits it declines to make
  the claim rather than being forced to assert one, and the documentation no
  longer says the orchestrator reads these flags to decide what it may promise
  on the wire, or that `appendGranularity` forces orchestrator-side buffering.
  Neither was true: every adapter must accept an append of any size and buffer
  to its backend's real granularity itself, so the orchestrator never
  re-chunks. `atomicCompletion` and `enforcesOffsetCheck` are the two flags that
  do gate construction, and both stay required.
- **An `auditKey` now substitutes for the upload token on every reporting
  surface instead of accompanying it.** The documentation already said the key
  is reported "instead of the raw token"; the code emitted both. The token is
  the capability (possession authorizes appending, probing and cancelling,
  because nothing re-authenticates a resumable upload's follow-up requests) and
  `onUploadEvent` is the most log-adjacent surface in the package, so a caller
  that went to the trouble of supplying a safe identifier was still handed the
  credential to write beside it. Events carry `uploadToken` only when no
  `auditKey` was given, which keeps them correlatable either way, and the
  context handed to `onError` follows the same rule: an error sink is at least
  as log-adjacent as an event sink. `UploadOrchestratorOptions` declares
  `auditKey?` on that context alongside `uploadToken?` and `operation`.
  Nothing stops compiling, since `uploadToken` is optional on
  both, so a consumer correlating on it while supplying an `auditKey`
  correlates on the key instead.
- **`DELETE` now frees an invalidated or expired upload instead of refusing
  it.** Terminal state answered every verb, including cancellation, so a client
  told its upload was dead had no way to release the partial bytes: they sat
  until a sweep, which never runs at all for a deployment with no `maxAgeSeconds`.
  Cancellation is now decided ahead of the terminal refusals, so `DELETE` on a
  dead resource discards the bytes and answers `204` (tus termination) rather
  than `410`/`404`. Probes and appends on a dead resource are unchanged. A
  consumer that treated a `410` on `DELETE` as "already gone" now sees the
  success it was inferring.
- **`UploadLockTimeoutError`'s message covers both of its causes.** It reads
  "Upload lock was not acquired in time" rather than naming an unyielding
  holder, since a server-backed locker also raises it when the server does not
  answer. The class, its `name`, and `isUploadLockTimeoutError` are unchanged,
  and those remain the supported way to recognize it.

### Added
- **Interop version 9 (draft-12) on the IETF dialect.** `interopVersions`
  defaults to `[3, 5, 6, 9]`, and every difference lands as a named field in
  the one per-version wire table rather than as a version comparison somewhere
  in the handler. Interop 9 emits `Upload-Limit` (an RFC 8941 dictionary of
  `max-size`, `min-size`, `max-append-size`, `min-append-size`, `max-age`,
  serialized from the effective policy) on offset-retrieval responses and on
  any rejection a limit caused, so a refused client retries at a stated number
  instead of halving its chunk size until something sticks. `min-size` is
  always present, defaulting to `0`: an empty structured-field value is not a
  valid dictionary, and a server enforcing no limits still has to say so
  rather than send nothing. `GET` becomes an offset probe beside `HEAD`, and
  the `Allow` on a `405` names `GET` only where the version admits it. And an
  append to a completed upload replays the completion answer, which is the
  behavior change above, read from the other side. `Repr-Digest` verification
  (RFC 9530) stays available on interop 9, whose draft revision carries no
  upload-digest text of its own: RFC 9530 defines the field independently of
  any upload protocol, honoring an assertion the client volunteered cannot
  break a client that sends none, and withdrawing it would remove an integrity
  guarantee from the consumers most likely to want one in exchange for nothing
  a client can observe.
- **`partial-content/conformance`: a contract harness for custom stores.**
  `checkResumableWriteStore(makeStore, opts?)` runs 15 checks over a write
  store's own public surface and returns a `ConformanceReport`;
  `formatConformanceReport(report)` renders it as plain lines and prints
  nothing, so the caller picks the sink. It exists because two of the
  capability flags are checked at construction and both are CLAIMS:
  `createUploadOrchestrator` can see that a store declares
  `enforcesOffsetCheck: true`, and nothing there can tell that store from one
  which returns `true` and writes anyway. The second presents as working,
  since appends land and uploads complete, and the guarantee is missing only
  when a lock is stolen from a holder that stalled past its TTL, which nobody
  exercises by hand. No test framework and no dependencies, so the same call
  is a CI step, a startup self-test against a staging bucket, or a script. A
  factory is taken rather than a store, because two obligations are only
  observable across instances: a backend-derived offset and one held in
  process memory look identical until a second instance reads the same upload.
  `restartable: false` SKIPS those checks rather than passing them, and the
  report counts skips separately from passes, so an unverified guarantee reads
  as unverified.

  `checkObjectStore(store, opts)` runs the read contract the same way, over
  the same report shape, against an object the store already serves
  (`{ key, content, missingKey? }`). Two of its six checks cover what a custom
  read store most often gets subtly wrong while looking correct: an honest
  total size on a partial read, and a not-found distinguishable from a
  failure. Neither shows up on the happy path, and both corrupt a client when
  wrong, one by handing it a `Content-Range` total it sizes its remaining
  requests against, the other by turning a missing object into a backend error
  a caching layer retries. The rest pin the head length, a byte-identical full
  read, the exact window a ranged read was asked for, and a reported digest
  being the whole representation's rather than a window's. It takes a store
  rather than a factory, since nothing here is observed across instances, and
  it is strictly read-only: it never creates and never deletes, because an
  `ObjectStore` has no vocabulary for either and a read store may front
  something immutable, which is what makes it safe against a staging bucket.
  A store declaring `supportsRange: false` has the two range checks skipped
  rather than passed, as does an object too short to slice a window from.
- **`UploadOrchestratorOptions.onUploadComplete`**, the one hook that carries
  the storage key. It fires once per publication with
  `{ uploadToken, auditKey?, key, length, metadata?, etag?, digest? }` and is
  AWAITED before the response goes out, so a consumer that records the object
  in its own database has that write happen before the client is told the
  upload succeeded, and a hook that throws fails the request rather than
  acknowledging an object the consumer's records never saw. Deliberately not
  part of `onUploadEvent`, which is content-free by design while a key
  commonly embeds a filename. It is an orchestrator option, so reaching it
  means constructing the orchestrator directly; the dialect factories do not
  forward it.
- **`UploadOrchestratorOptions.lockTimeoutMs`**, and `acquireTimeoutMs` on
  `memoryUploadLocker`. `AcquireOptions.timeoutMs` was public and unreachable:
  the orchestrator is the only caller of `UploadLocker.acquire` on a served
  request and passed nothing, so the documented per-call deadline could not be
  set by anyone, and the in-process locker's 15 s default could not be changed
  at all. `lockTimeoutMs` threads a deadline into whichever locker is
  installed, and `memoryUploadLocker({ acquireTimeoutMs })` sets the default
  for callers outside the orchestrator, matching what `redisUploadLocker`
  already accepted.
- **The backend shim interfaces are exported as types.** `AzureContainerClient`,
  `AzureBlobClient`, `AzureGenerateSasUrlOptions`, `AzureBlobProperties` and
  `AzureBlobDownloadResponse` from `/azure`; `GcsStorage`, `GcsBucket`,
  `GcsFile`, `GcsSignedUrlConfig` and `GcsFileMetadata` from `/gcs`;
  `R2Bucket`, `R2Object`, `R2ObjectBody`, `R2GetOptions`, `R2Range`,
  `R2Checksums` and `R2HttpMetadata` from `/r2`. Each is the narrow structural
  slice the store actually calls, which is exactly the surface an adapter shim
  has to satisfy: a consumer whose client is wrapped, mocked, or a compatible
  non-SDK implementation had to reach for a cast to describe it.
- **`SweepingWriteStore`, returned by every built-in upload-store factory.**
  `sweepExpired` stays optional on `ResumableWriteStore`, since a backend with
  native lifecycle rules may document those instead, but the built-ins all
  implement it and their factories now say so in the type. A scheduled sweep no
  longer needs a `?.` that would quietly make a retention obligation a no-op.
  The type is `ResumableWriteStore` plus a required `sweepExpired`, so it is
  assignable anywhere the wider type is expected and a custom store that leaves
  the method out still fits.
- **Every store subpath re-exports the write contract's types.**
  `/memory`, `/fs`, `/s3`, `/r2`, `/gcs` and `/azure` now export
  `ResumableWriteStore`, `SweepingWriteStore`, `StoredUploadState`,
  `CreateUploadOptions`, `AppendChunkOptions`, `CompleteUploadOptions` and
  `CompletedUpload` next to the error classes they already re-exported. A custom
  store author was told to take the error classes from a store subpath and then
  had nowhere to take the contract type from, so the store could only be checked
  structurally at the handler call site rather than against the contract where
  it is written.
- **`partial-content/node` re-exports `ServeObjectOptions`, `ServeContext`,
  `ObjectStore`, and the three object error classes**, so an adapter-only
  consumer types its handler and matches store errors from a single import.
- **`reservedKeyGuard` is exported from the package root**, so a custom
  `ObjectStore` sharing a root or bucket with an upload store applies the same
  refusal the built-in read stores do.
- **`isUploadLockTimeoutError` reaches consumers from both dialect subpaths.**
  Every other error the upload path can raise ships its `name`-comparing matcher
  from `partial-content/tus` and `partial-content/upload`; this one shipped only
  its class, so recognizing the 423 case meant either an `instanceof` (which
  fails across duplicated module instances, the exact failure the matchers
  exist to avoid) or hand-comparing `err.name`.
- **The read-side store errors ship name-based matchers.**
  `isObjectNotFoundError`, `isObjectChangedError` and `isStoreUnavailableError`
  are exported from the package root, mirroring the matchers the write side
  already shipped. The classes were exported without them, so recognizing a
  404, a pinned-read change, or a retryable 503 meant either an `instanceof`
  (which fails across duplicated module instances: a consumer with two copies
  of the package in its tree, or a store built against a different install,
  throws an error that is structurally right and fails the check) or a
  hand-rolled `err.name` comparison at every call site. The `name` is the
  stable identity, which is also what lets a custom store throw an
  equivalently-named error and be recognized.
- **`isSha256Base64` is exported from the package root.** The predicate for "is
  this the raw base64 of a 32-byte SHA-256" existed in four places that
  disagreed about whether `=` padding was required, so the same digest could be
  accepted on one path and dropped on another. There is now one definition, and
  it takes padding as optional: an unpadded 43-character encoding decodes to the
  same 32 bytes, and rejecting it would discard a valid digest over a formatting
  difference. What the package emits is unchanged and always padded, since
  RFC 9530 carries the digest as a Structured Fields Byte Sequence. Exported so
  a custom store can validate the digest it is about to report against the same
  gate the emitter applies.
- **`HEAD` reports the metadata the creation carried** (tus creation
  extension), re-encoded through the same grammar the creation parser accepts,
  so a client resuming from a cold start recovers the filename and type it no
  longer holds. A key the grammar cannot express (a comma, a space, a control
  byte, none of which this dialect can produce but another caller can store) is
  omitted rather than emitted, since the grammar has no escaping.
- **`abortUpload` may never touch an object the upload already published**, now
  stated in the store contract rather than left adapter-defined. Every built-in
  store already behaved this way; the guarantee is what makes it safe for a
  `DELETE` to arrive late, be retried, or be replayed, since abort is
  idempotent and the destructive reading would delete live data on the second
  call. Delete published objects through your own storage API.

### Fixed
- **The tus dialect's 413 reason phrase is "Content Too Large".** It sent
  "Request Entity Too Large", the name RFC 2616 gave the status; RFC 9110
  Section 15.5.14 renamed it, and the obsolete phrase advertised a bound as
  being about the request entity when the one that matters here is about the
  representation. The status code, the `Tus-Max-Size` header and the body are
  unchanged, and a client that reads the code rather than the phrase (which
  RFC 9110 Section 15 requires) sees no difference.
- **A throwing extractor in the Hono adapter becomes a 500 instead of a rejected
  handler.** The `key`/`mime`/`filename`/`auditKey` callbacks are consumer code
  and can throw; the Hono handler let that escape, so the failure surfaced as
  whatever the surrounding framework does with a rejected promise and never
  reached the consumer's own error sink. It now answers the same hardened 500
  the Node adapter answers (`no-store`, `nosniff`, an empty CSP, and a body that
  says nothing) and reports `onError(err, { key: "", operation: "context" })`.
  `ServeObjectOptions.onError` documents the `context` operation for every
  server adapter, so a consumer's telemetry no longer depends on which adapter
  they mounted.
- **A creation rejected after its resource was allocated now carries a
  `Location`.** A creation-with-upload whose body is refused mid-stream has
  already created the resource and made a prefix durable, but the rejection
  named no resource, so those bytes were unreachable: the client could neither
  resume them nor `DELETE` them, and only a sweep reclaimed them, which is
  optional and does nothing at all for a deployment with no `maxAgeSeconds`.
  Both dialects now emit the `Location` on such a rejection, built by the same
  `location()` callback and header-sanitized the same way. Rejections from
  before allocation are unchanged and carry no `Location`, since there is
  nothing to point at.
- **A terminal audit event is emitted only after the store action it
  describes.** The zero-content completing append and the cancellation path
  emitted `completed`/`cancelled` from the decision, before `completeUpload`/
  `abortUpload` ran, so a store that threw left an outcome in the audit trail
  that never happened, and a completion refused by the `minSize` floor recorded
  a completion followed by a rejection. Verdicts now carry decision events
  only; the orchestrator emits the outcome event after the store returns,
  matching the creation and streaming-append paths.
- **The Redis locker's acquire timeout bounds every round trip, not just the
  polling.** Each command was awaited without a bound, so a server that
  accepted a command and never answered (a partitioned socket, a client
  queueing through a reconnect) parked the caller forever: the timeout only
  ever governed the gaps between commands. The `SET`, the preempt `PUBLISH`
  and the `subscribe` are now each bounded by what remains of the acquire
  budget, so an unresponsive server surfaces as the retryable `423` the
  documentation always promised. Since the protocol has no client-side cancel,
  an abandoned `SET` is followed by a compare-and-delete on its hold id, so
  a late arrival cannot hold the resource for the full TTL. The watchdog is
  bounded the same way: a renewal that has not answered by the time the next
  one is due no longer counts as confirmation of the hold, which had let a
  holder write straight through its own TTL believing its lock was good.
- **`redisUploadLocker` construction errors name the option and its value.**
  `ttlMs`, `acquireTimeoutMs` and `pollIntervalMs` must each be a positive safe
  integer, and the `TypeError` now says which one was wrong and what it was
  given. A rejection that named neither left the caller to bisect three
  numbers, at construction time, where the whole point of failing early is
  that the fix should be obvious.
- **A very large acquire timeout no longer times out immediately.** A delay
  past the maximum a timer accepts overflows and fires at once, so the most
  generous budget a caller could express became the least generous behavior
  available. Timer delays are clamped, and a timeout far in the future now
  means what it says.
- **A Redis locker `subscribe` failure releases the key it just took.** Between
  winning the `SET` and constructing the lock, a failing `subscribe` (a
  subscriber connection lost to a failover) left the key held with no watchdog
  and no release closure, so the resource was dead-locked for the full TTL and
  every waiter drained into a `423`. The just-taken key is now released via the
  same compare-and-delete script before the error is rethrown, so the resource
  is immediately reacquirable.
- **The tus creation response anchors `Upload-Expires` at creation start.** The
  deadline was computed as `now() + maxAgeSeconds` after the request body had
  drained, so a slow streaming create advertised an expiry inflated by its own
  duration, and a client honoring the header resumed past the real expiry into
  a `404`. Creation time is captured once, up front, and reported on the
  created outcome's new optional `expiresAt` (epoch ms); the dialect renders
  that instead of recomputing. The tus `HEAD` and `PATCH` responses already
  derived the deadline from the resource's own creation time and are unchanged,
  and the IETF resumable-uploads dialect sends no expiry header at all.

## 3.0.1 (2026-07-21)

Two correctness fixes; no API change.

### Fixed
- **Calendar/clock-invalid conditional dates are ignored, not rolled over.** A
  client `If-Modified-Since` / `If-Unmodified-Since` / `If-Range` value whose
  digits form an impossible date or time (e.g. `31 Feb`, `12:00:99`) was
  silently shifted to a real instant (`31 Feb` became Mar 3) instead of being
  rejected, which could fabricate a spurious `304` or `412`. RFC 9110
  Sections 13.1.3/13.1.4/13.1.5 require an invalid HTTP-date to be ignored, so
  such values are now rejected across all three HTTP-date formats (IMF-fixdate,
  RFC 850, asctime) via a round-trip validation of the parsed components.
- **An interrupted upload append no longer downgrades to a store error.** When
  an append was interrupted by the client disconnect itself, the durable
  offset re-read was gated on the (now-aborted) request signal, so the truthful
  interrupted response became a spurious store error and emitted a mislabeled
  abort into the error hook. The re-read now completes independently of the
  client signal, reporting the bytes that were durably flushed.

## 3.0.0 (2026-07-17)

A concurrency-ownership cleanup: the locker owns preemption end to end, via a
cancellation signal rather than a callback. Breaking only for custom
`UploadLocker` or `ResumableWriteStore` implementers; consumers using the
built-in lockers, dialects, and stores are unaffected.

### Changed (breaking)
- **`UploadLocker` preempts through a returned `AbortSignal`.** `acquire` drops
  its `onPreemptRequested` callback parameter (`acquire(token, opts?)`), and the
  returned `UploadLock` is now `{ signal: AbortSignal; release(): void }`. A
  later acquirer aborts `lock.signal` (reason `UPLOAD_PREEMPTED`); the holder
  threads it into its store write and yields at the next boundary. Because an
  `AbortSignal` carries latched state, a preempt landing during hand-over is
  never lost, which retires the internal "was I preempted" flag entirely. A
  custom locker now creates an `AbortController` at acquire time, aborts it when
  a later acquirer arrives, and exposes its `signal`. `UPLOAD_PREEMPTED` is
  exported for distinguishing a preempt from a client disconnect on the
  composed signal.
- **`ResumableWriteStore.digestOnComplete` narrows to `"sha256" | false`.** The
  `"crc32c"` member is removed: SHA-256 is the only algorithm verified end to
  end, so a custom store must report `false` rather than `"crc32c"`.

### Removed
- The engine's unreachable concurrency surface (`UploadEvaluateOptions`'s
  `hasInFlight`/`preemptInFlight` and the `preempt-then-retry` verdict). These
  were internal; the locker has owned contention since the orchestrator landed.

## 2.3.1 (2026-07-17)

Documentation only; no code change from 2.3.0. Corrects changelog and
doc wording. Prefer this over 2.3.0.

## 2.3.0 (2026-07-17)

Operational hardening for self-hosted and multi-instance deployments: CORS,
reverse-proxy body streaming, honest capability advertising, and safer failure
modes on the filesystem and S3 stores.

### Added
- **`TUS_EXPOSED_HEADERS` / `UPLOAD_EXPOSED_HEADERS`**: the exact response
  headers a cross-origin browser upload must be allowed to read, published as
  frozen `string[]` for `Access-Control-Expose-Headers`. The package ships no
  CORS middleware (the policy is yours), but assembling this list by hand is
  the step that silently drops `Upload-Offset` and breaks every resume.
- **`isInlineSafeMediaType(mediaType)`**: an allow-list predicate for choosing
  `inline` vs `attachment` when serving untrusted content, excluding the
  script-capable types (`text/html`, `image/svg+xml`, `application/pdf`) that
  a deny-list forgets. Stored-XSS hardening for the download path.
- **`docs/DEPLOYMENT.md`**: reverse-proxy configuration (nginx/Apache/Caddy)
  that streams `PATCH` bodies instead of buffering them (the most common
  self-host failure), CORS, multi-instance locking, and object-storage part
  limits.

### Changed
- **Honest extension advertising.** The tus handler advertises the
  `expiration` extension on `OPTIONS` only when a max age is configured;
  claiming it with nothing to expire was a false capability.
- The filesystem store retries transient file-open failures (`EMFILE`,
  `ENFILE`, `EBUSY`, `EAGAIN`) with a short backoff, so a momentary share
  violation on a network volume, or descriptor exhaustion under load, no
  longer sinks a whole `PATCH`. The `wx`/`r+` open semantics are unchanged
  (a real collision or missing file still fails on the first attempt).

### Fixed
- The S3 store now fails loudly at the append that would cross S3's 10,000-part
  limit, naming the `minPartSize` knob to raise, instead of letting
  `CompleteMultipartUpload` reject the finished object with an opaque error.
  (The R2 store already guarded this.)

## 2.2.0 (2026-07-17)

### Added
- **tus checksum extension** (opt-in via `checksum` on `createTusHandler`):
  `Upload-Checksum` verified per request, advertised via `Tus-Extension` and
  `Tus-Checksum-Algorithm`. A checksummed request is buffered (hard-capped;
  construction refuses an unbounded buffer), verified, and only then
  appended, so a mismatch (`460 Checksum Mismatch`) leaves durable state
  untouched, the only honest reading of the extension's
  discard-on-mismatch. Hashing is caller-injected (`TusChecksumOptions`);
  `webCryptoChecksum()` ships ready-made `sha1`/SHA-2 over `crypto.subtle`
  on every supported runtime. Unconfigured, an unsolicited `Upload-Checksum`
  is ignored, mirroring the completion-digest posture for assertions nothing
  can verify.
- **`partial-content/redis-locker`**: multi-instance upload locking over any
  Redis-protocol server (Redis, Valkey, KeyDB, Dragonfly) with the same
  cooperative-preemption semantics as the in-process locker. Zero
  dependencies: the caller passes a client behind a four-command interface
  (`RedisLockerClient`). `SET NX PX` with a per-acquire fencing id, watchdog
  renewal at ttl/3 (a renewal that cannot confirm the hold preempts the
  holder), waiter-republished preempt pub/sub (level-triggered, so a
  subscribe-gap request is never lost), and compare-and-delete release that
  can only ever release its own hold.

### Changed
- **The PATCH/append hot path costs one state read instead of three.** The
  tus dialect no longer pre-probes before every PATCH: implicit-completion
  inference moved into the orchestrator (`AppendUploadRequest.complete`
  accepts `"infer"`), computed against the fresh state read under the
  append's own lock, which is also strictly more accurate than a pre-probe
  whose answer can go stale before the lock. And a clean append no longer
  re-reads state afterwards: the store contract pins `getUploadState` to
  agree with the write's own return, so the outcome derives from it; only an
  interrupted write still re-reads for the durable prefix.

Resumable-upload hardening from an external adversarial review of the
protocol core and both wire dialects. Every fix is additive or a bug fix; no
breaking changes.

### Fixed
- **Deferred-length uploads now work end to end.** A length first declared on
  a later append (tus `creation-defer-length`, or `Upload-Length` on an IETF
  PATCH) is persisted durably by every write store, so the upload completes,
  the length becomes immutable, and HEAD stops reporting a deferred length
  forever. Previously such uploads stranded and could not complete.
- **IETF append completeness fails closed.** An absent or malformed
  completeness header on an append is no longer treated as "completing"
  (which could publish a truncated object): it is a 400 where the revision
  requires the header (interop 5/6) and treated as incomplete where it does
  not (interop 3), never as complete.
- **Cooperative preemption is level-triggered.** A preempt that arrives
  during lock handover or before a write starts is no longer lost, so a
  contended resume hands over in milliseconds instead of waiting out the lock
  timeout.
- **Unverifiable client digests are ignored, not refused.** A `Repr-Digest` a
  store cannot verify (non-sha256 backends) is dropped per RFC 9530 rather
  than answered with a false integrity-mismatch error.
- **`minSize` is enforced at completion**, closing a bypass where a
  deferred-length upload could publish under the floor.
- **Creation runs under the resource lock**, so a client resuming via an
  early `Location` cannot race a still-flushing creation.
- **tus HEAD heals an implicit completion**: an upload whose completing
  request died after its bytes were durable is published on the next probe
  instead of remaining a permanently unpublished 404.
- The IETF `Location` header is sanitized; raw upload tokens are kept off
  error messages (they remain on the error property); `Upload-Expires` is an
  absolute deadline a long append cannot inflate.

### Added
- `AppendChunkOptions.length`: the write-store contract field carrying a
  late-declared length for adapters to persist.
- Construction-time validation: `createUploadOrchestrator` throws on a policy
  with NaN/negative/fractional bounds or inverted floor/ceiling pairs, and on
  a store reporting `atomicCompletion: false`.
- `createUploadOrchestrator` and the write-store contract types are now
  re-exported from both `partial-content/tus` and `partial-content/upload`
  (via a shared module), so custom stores and dialects need no internal
  import paths.

### Changed
- Capability-flag docs corrected to describe what the orchestrator actually
  requires: stores must accept any append size and buffer internally;
  `exactOffsetRecovery: false` means a resume may re-send its last chunk (a
  durable lower bound), never corruption.

## 2.0.0 (2026-07-16)

The write side. One resumable-upload engine, two wire dialects, and write
support across every storage adapter, alongside the existing read-side
serving. Built to the tus 1.0 spec and the current IETF resumable-uploads
draft, and to the write primitives each storage backend actually provides.

### Added
- **`partial-content/tus`**: a tus 1.0 server handler (`createTusHandler`)
  speaking core + creation + creation-with-upload + creation-defer-length +
  termination + expiration. Framework-agnostic (Fetch Request/Response),
  never-throw, hardened error responses.
- **`partial-content/upload`**: an IETF resumable-uploads draft handler
  (`createUploadHandler`) supporting draft interop versions 3, 5, and 6
  (the versions deployed clients actually speak), with the per-version
  completeness-header polarity handled explicitly, 409 offset-mismatch
  responses carrying the correct offset (and problem+json at interop 6),
  and 423 for lock contention as a distinct retry-later signal.
- **Upload engine + orchestrator (shared by both dialects)**: a pure,
  wire-agnostic state machine (offset monotonicity, length immutability,
  limit enforcement BEFORE bytes move, expiry, terminal invalidation) under
  an orchestrator that always re-derives state from storage inside the
  resource lock, preempts hung holders cooperatively (the disconnect-resume
  race), grants aborted appends a grace window so received bytes still
  flush, and emits content-free, auditKey-aware upload events.
- **`ResumableWriteStore`** contract with honest per-backend capability
  flags, implemented by every storage adapter: `memoryUploadStore` and
  `fsUploadStore` (fsync-before-ack offsets, atomic rename publish,
  sha-256 verification at completion), `s3UploadStore` (multipart with
  sub-minimum tail buffering, offsets derived from part listings, error
  translation for S3-compatibles), `azureUploadStore` (uncommitted blocks
  with a creation sentinel, byte-exact offset recovery),
  `gcsUploadStore` (object-per-chunk with batched composition, exact
  offsets, stateless recovery), `r2UploadStore` (manifest-tracked parts,
  uniform part size, honest `exactOffsetRecovery: false`).
- Upload policy limits (max/min size, per-append bounds, max age) enforced
  in the engine and advertised per dialect; `sweepExpired` on stores for
  abandoned-upload cleanup.

### Changed (breaking)
- `evaluateConditionalRequest` `opts.method` is typed `"GET" | "HEAD"`
  (writes belong to `evaluateConditionalWrite`).
- `preferSignedUrl` receives `method: "GET"` only (HEAD never offloads).
- `onError` `operation` union gains `"sign"`: signed-URL minting failures
  report truthfully instead of as `"get"`/`"head"`.
- The onServe/onTransfer hooks are deliberately UNCHANGED: grant-time and
  settle-time events have different lifecycles, and unifying them was
  evaluated and rejected.

### Fixed
- `s3UploadStore` checksum posture: multipart SHA-256 checksums are
  composite-only, so the `checksums` option provides per-part transport
  integrity (verified at part-upload time, restated at completion) and
  `digestOnComplete` is honestly `false`; whole-object digest assertions
  are refused loudly instead of laundered.

## 1.5.0 (2026-07-16)

Gap-removal release from a full-package adversarial audit (protocol core,
serving layer, all seven storage adapters, RFC-currency re-verification
against the live spec texts, and a compliance-mapping review).

### Fixed
- `httpStore` builds request headers through a `Headers` instance:
  case-variant consumer spellings of the reserved fields (`accept-encoding`,
  `range`, `if-match`) are now REPLACED instead of merged. Previously a
  lowercase `accept-encoding` in `opts.headers` survived alongside the
  adapter's `Accept-Encoding: identity` and fetch joined the duplicates
  ("gzip, identity"), letting the origin compress and every request then
  fail through the non-identity guard. Consumer `Range`/`If-Match` values
  are cleared on requests that carry neither.
- `Want-Content-Digest` and `Want-Repr-Digest` now negotiate fully
  independently (RFC 9530 Section 4), in the kernel orchestrator and the
  web adapter both: declining `Repr-Digest` no longer suppresses a wanted
  `Content-Digest` on a full 200.
- Range-incapable stores with `createSignedUrl` no longer redirect
  unconditionally: HEAD serves real metadata headers, conditional requests
  revalidate at the origin (304/412 from real validators), and only a
  body-bearing GET answers 302, so client caching works again on these
  stores. Plain GETs keep the zero-round-trip immediate redirect.
- `preferSignedUrl` never consults the predicate for HEAD: a metadata probe
  answered with a bare 302 defeats exactly the clients that send HEAD
  (PDF.js size probing).
- `buildMultipartHeaders` enforces the same bounds contract as
  `buildRangeResponseHeaders` (RangeError on inverted/negative/past-EOF
  parts and on the OPEN_ENDED sentinel) and rejects boundaries outside the
  RFC 2046 grammar instead of interpolating them into header + framing.
- `decodeGcsPin` validates what its hostile-token defense claims: negative
  or fractional sizes, non-string validators, and malformed digests in a
  forged pin now fall back to revalidation.
- Signed-URL redirect failures report `operation: "head"` for HEAD requests.

### Added
- `auditKey` (`ServeContext` field; extractor on the node and hono
  adapters): an opaque identifier substituted for the storage key in every
  `onServe`/`onTransfer`/`onError` event, keeping filename-bearing keys
  (personal data) out of consumer logs while the store reads by the real key.
- `createSignedUrl` on `gcsStore` (V4 signed READ URLs; GCS offers no
  Cache-Control response override, documented) and `azureStore` (read-only
  SAS with disposition/type/cache-control response overrides), so
  `preferSignedUrl` egress offload works on all three cloud stores.
- `digestMetadataKey` on `gcsStore`: surfaces a caller-stored raw-base64
  SHA-256 from custom object metadata as the RFC 9530 digest (GCS has no
  native SHA-256; `x-goog-hash` is crc32c/md5 only).
- `httpStore` refuses a bodyless response that declares a non-zero
  Content-Length instead of serving a clean-looking empty stream.
- The fs hot-object cache's byte-budget eviction skips metadata-only
  entries (they free zero bytes); stat-elision entries now survive body
  pressure and are bounded by the entry cap alone.

### Docs
- `gcsStore` signature corrected in the API reference (`{ storage, bucket }`).
- The `ObjectMetadata.digest` contract no longer instructs an impossible
  GCS mapping; it points at `digestMetadataKey` and names the fields that
  really are SHA-256s.
- Scope section updated: encoding negotiation over stored siblings is in
  scope (shipped in 1.2.0); the non-goal is serve-time compression.
- RFC 8941 citations annotated: RFC 9530 pins to 8941 by DOI, so they must
  not be "modernized" to RFC 9651.
- Compliance table: integrity verification cites GDPR Art. 32 (CC6.1 is a
  logical-access control and was the wrong citation); the `nosniff` row no
  longer cites SOC 2 CC6.6 (a network-boundary control); new log
  data-minimization row for `auditKey`.
- Option-precedence table for the serve handler's routing options.

## 1.4.0 (2026-07-12)

- `fsStore` and `memoryStore` now declare `authoritativeRange`: plain range
  requests (no conditionals, no `If-Range`) serve in a single round-trip with
  no validating HEAD. Both adapters already satisfied the contract -- the fs
  store stats, clamps, and reads from ONE open handle (bounds, validators,
  and bytes are coherent by construction; a start beyond EOF is rejected
  natively and becomes a correct 416 via the fallback path), and a memory
  read is atomic by definition. This removes the extra stat on the hottest
  local-serving path (media seeks, PDF.js chunked loading) and makes ranged
  serving MORE coherent, not less: one handle is a true pin, where
  HEAD-then-GET needed the drift guard.
- New fuzzed totality suite for the adapter's never-throw contract
  (`fast-check` over `serveObjectRaw`): arbitrary methods, adversarial
  protocol-header soup (malformed ranges, header-splitting attempts, control
  bytes, hostile qvalues), and arbitrary filename/MIME contexts must always
  resolve to structurally sound response parts -- integer status, CR/LF/NUL-free
  header names and values, numeric Content-Length, bodyless HEAD.
- Mutation-testing floor for `web.ts` (83; baseline 85.07 after a
  survivor-driven sweep added 35 behavior-pinning tests).

## 1.3.0 (2026-07-12)

- `accessControlExposeHeaders` serve option (+ exported
  `PROTOCOL_EXPOSE_HEADERS`): one flag exposes the protocol's
  non-CORS-safelisted response headers (`Accept-Ranges`, `Content-Range`,
  `Content-Encoding`, `ETag`, `Content-Disposition`, digest fields,
  `Server-Timing`) so cross-origin readers like pdf.js stop silently
  degrading to full downloads.
- Mutation-testing floors for the 1.2.0 modules (`encoding.ts` 86,
  `cache-control.ts` 96).

Docs: "Behind a CDN" interop guide (verified against vendor docs,
July 2026) covering which CDNs forward ranges vs fetch-and-slice, the
Content-Length requirement for edge 206s (and the Bun chunked-stream
interaction), Accept-Encoding normalization (`.zst` unreachable through
Cloudflare/CloudFront defaults), Cloudflare's strong-ETag downgrade on
encoding mismatch, RFC 5861 support at Fastly, pdf.js identity-coding
requirements, and the `Access-Control-Expose-Headers` list cross-origin
range/digest readers need.

## 1.2.0 (2026-07-10)

Feature release: content-coding negotiation, per-request egress offload, and
serving-policy primitives.

### Precompressed variant negotiation
- `precompressed: true | ["br", "zstd", "gzip"]` on the serve options: probes
  `<key>.br` / `<key>.zst` / `<key>.gz` siblings, negotiates via
  `Accept-Encoding` (RFC 9110 12.5.3 with real qvalue handling, `*`, and
  `identity` preference), and serves the variant with `Content-Encoding` +
  `Vary: Accept-Encoding`.
- The variant is treated as its own representation end to end: its validators
  drive 304/If-Range, its size drives Range/416 bounds (`Content-Range`
  describes the encoded bytes), its digest rides `Repr-Digest`, and the
  TOCTOU pin + drift guard apply to it. Selection only -- the library never
  compresses at serve time (that would corrupt ranges and digests).
- Negotiation is gated on compressible MIME types (new `isCompressibleMime`)
  and skipped for multi-range requests, which serve the identity bytes.
  Probe failures other than not-found fall back to identity and report to
  `onError`.
- New kernel exports: `parseAcceptEncoding`, `negotiateEncoding`,
  `isCompressibleMime`.

### Serving policy
- `preferSignedUrl` predicate: per-request 302 offload to `createSignedUrl`
  for stores that support it (e.g. proxy ranges + revalidations, redirect
  full-file downloads). `signedUrlExpiresSeconds` configures the lifetime.
- `createSignedUrl` gains a `cacheControl` response-override, honored by the
  S3 adapter (`response-cache-control`), so a private document redirected to
  the bucket origin cannot be cached under the object's baked-in public
  Cache-Control. The contract now documents the STS-credential expiry cap
  and the CloudFront canned-policy `filename*` trap.
- `buildCacheControl()`: typed Cache-Control composer (RFC 9111 + RFC 5861
  `stale-while-revalidate`/`stale-if-error`) with validation and a
  `no-transform` default -- intermediary transforms break byte-exact ranges,
  digests, and strong validators.

### Hardening
- Active content served `inline` (`image/svg+xml`, `text/html`,
  `application/xhtml+xml`, XML) automatically carries
  `Content-Security-Policy: sandbox`; caller `securityHeaders` overrides.
  `nosniff` never stopped a genuine SVG from executing its embedded script.

### Monorepo/tooling
- The `bun` export condition now points at the TypeScript source: Bun
  runtimes (and Bun-workspace consumers) execute `src/` directly, so a stale
  `dist/` build can never be served or tested.

## 1.1.0 (2026-07-10)

RFC compliance sweep re-verified against the current spec texts (RFC 9110,
9530, 8941, 6266/8187), plus hardening and observability parity.

### Kernel
- `evaluateConditionalRequest` accepts `opts.method`: `"HEAD"` ignores
  `Range`/`If-Range` (RFC 9110 14.2) and suppresses `Content-Digest`
  (RFC 9530 B.2: a HEAD transfers no content).
- `If-Range` HTTP-dates now enforce the 13.1.5 step-1 strong-validator rule:
  a Last-Modified whose second has not fully elapsed never authorizes a
  range resume.
- `parseRanges`: parts are returned in REQUEST order (15.3.7.2 SHOULD), gaps
  smaller than the ~80-byte part overhead coalesce (15.3.7.2 MAY), and a
  single coalesced range serves as a plain 206 instead of degrading to 200.
- Digest layer: values that are not the raw base64 of a 32-byte SHA-256 are
  never emitted; `Want-Repr-Digest` and `Want-Content-Digest` negotiate
  independently (new `clientWantsContentDigest` export) with RFC 8941
  last-wins duplicate keys.
- `build416Headers` / `buildRangeResponseHeaders` validate bounds: `NaN`
  totals and the `OPEN_ENDED` sentinel can no longer serialize into
  `Content-Range`.
- `fromNodeHeaders` uses a null-prototype map (a literal `__proto__` request
  header cannot poison lookups).

### Serving adapters
- 304 responses carry the caller's `securityHeaders` output, so a caller-set
  `Vary` satisfies the RFC 9110 15.4.5 MUST-generate list.
- HEAD-to-GET validator drift guard: on stores that cannot pin reads, a
  partial response whose GET validators disagree with the validating HEAD
  re-validates once instead of splicing bytes across representations.
- multipart/byteranges: honors `Want-Repr-Digest`, reports
  `Server-Timing`/`onTiming`, and verifies each part's actual byte count
  against the committed framing.
- `supportsRange: false` stores without a signed URL now serve the full
  representation with `Accept-Ranges: none` instead of failing 502;
  signed-URL provider rejections and declines are reported to `onError`.
- OPTIONS answers `204` + `Allow`; the disposition type is coerced on the
  no-filename path; new `etag: false` option for deployments with unstable
  derived validators; node adapter is generic over the request type
  (`serveObject<express.Request>`) and reports extractor failures to
  `onError` (`operation: "context"`).

### Store adapters
- `http`: bodies are guarded against silent truncation (`guardStreamLength`);
  `Repr-Digest` extraction is a linear scan (no backtracking regex).
- `fs`: Windows reserved-device check covers trailing dots/spaces and
  superscript COM/LPT digits; the small-read path loops on legal short reads.
- `s3`/`gcs`: throttle classifiers surface the backend's `Retry-After` hint.
- `mime`: null-prototype lookup map (`lookupMime("x.constructor")` is
  `undefined`, not a function).

### Content-Disposition
- Invisible-character stripping extended (U+00AD, U+061C, U+180E,
  U+2060-2064, U+FEFF, U+FFF9-FFFB).
- ASCII fallbacks fold NFKD-decomposable letters to base letters
  ("Årlig" -> "Arlig") before `?`-replacement.
- Filenames containing a double quote gain a `filename*` companion
  (RFC 6266 Appendix D: quoted-pair alone is unreliable across clients).

## 1.0.1 (2026-07-06)

Docs-only release, no code changes.

- README restructured around evaluation flow: quick starts, comparison, and design summary up front.
- Deep-dives moved into the shipped `docs/` folder: full API reference (`docs/API.md`), framework/kernel recipes (`docs/EXAMPLES.md`), and the complete benchmark methodology (`docs/BENCHMARKS.md`).
- The npm tarball now includes the whole `docs/` folder (previously only `DESIGN.md`).

## 1.0.0 (2026-07-06)

Initial public release. Zero-dependency, ESM-only HTTP file-serving protocol layer for any storage backend.

### Kernel (`partial-content`)
- `evaluateConditionalRequest` / `evaluateConditionalWrite`: full RFC 7232/7233/9110 evaluation chain (412 > 304 > If-Range > Range) and write-side OCC.
- Range parsing with `multipart/byteranges` for multi-range requests, overlapping/adjacent coalescing, and range-amplification defense (`maxRanges`).
- ETag generation (strong content-hash, weak size+mtime, safe `undefined` fallback) with sub-second timestamp flooring.
- RFC 9530 `Repr-Digest` / `Content-Digest` with `Want-*` negotiation.
- `buildContentDisposition`: RFC 6266/8187 with CRLF-injection, path-traversal, and bidi-override hardening.

### Storage adapters
- `/s3` (AWS S3, R2 S3-mode, Hetzner, MinIO, Wasabi), `/r2` (native bindings), `/gcs`, `/azure`, `/fs`, `/http` (any range-capable origin), `/memory`.
- `/fs`: opt-in hot-object cache: TTL revalidation, coherent metadata + small-body capture, LRU eviction under both an entry cap (`maxEntries`) and a body byte budget (`maxBytes`; `0` = metadata-only).
- Atomic pinned reads (TOCTOU elimination) via each backend's native conditional read; `authoritativeRange` single-round-trip fast path for media seeking.
- Backend failures map to truthful status: `404` (not found), `503` + `Retry-After` (transient throttle/overload, `StoreUnavailableError`; the `/azure` and `/http` adapters surface the backend's advised `Retry-After`), `502` (malformed upstream).
- `classifyStoreRead` + `StoreErrorClassifiers`: the shared error-classification primitive, exported for custom adapters; a throttle classifier may return `{ retryAfterSeconds }` to propagate a back-off hint.
- `guardStreamLength`: wrap a web `ReadableStream` so a graceful short read errors the body instead of under-running the committed `Content-Length`.
- `resolveServedRange`: parse a backend `Content-Range` into served bounds + honest total (the `bytes a-b/*` unknown-total sentinel maps to `undefined`), the shared primitive behind the S3/Azure/HTTP adapters.

### Runtimes

- Verified in CI on Node, Bun, and Deno (a runtime-agnostic smoke suite over the built package); Cloudflare Workers via the `/r2` adapter's Fetch-standard surface.

### Framework adapters
- `/web` (Fetch API: Next.js, SvelteKit, Remix, Workers, Bun, Deno), `/node` (Express, Fastify, Koa, raw http) with a bounded backpressure stall timeout, `/hono`.

### Security
- `nosniff`, `charset=utf-8` enforcement on textual types, `default-src 'none'` CSP on error responses, CORP, forced-`attachment` signed URLs, SSRF-safe redirect-error default on the http store.
