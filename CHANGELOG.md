# Changelog

## 5.0.0 (2026-10-27)

The write path stops inferring facts it can observe. Forty-five changes are
breaking; `docs/UPGRADING.md` walks each one, and "Changed (breaking)" below
lists the ones no other section carries. A 4.0.1 patch was prepared and never
published; its five corrections ship here, under "Upload responses 4.0.0 sent
that were never conformant".

### License

This release changes the license from MIT to Apache License 2.0. Versions up
to and including 4.0.0, the last published release, remain under the MIT
License exactly as published; 5.0.0 and every later version are licensed under
Apache-2.0. The tarball now carries the full `LICENSE` text and a `NOTICE`
file, and `package.json` declares `"license": "Apache-2.0"`. Apache-2.0 adds an
express patent grant; redistributions must keep the license text and the
`NOTICE` contents (section 4).

### Security

Every defect below is present in **4.0.0**, the published release under
support, and several are older than that release; each is fixed in 5.0.0. The
supported-version policy is the latest published release, so upgrading to
5.0.0 is the remedy whichever version is deployed; there is no patch release.
Each entry names the deployments it reaches. A deployment serving only reads,
with no upload store, is reached only by the entries marked "read path".

- **A holder whose lock was stolen mid-body could place bytes where the new
  holder had already written** (`s3UploadStore`, `gcsUploadStore`,
  `azureUploadStore`, `fsUploadStore`). The upload lock serializes writers but expires, and a
  body can stream for longer than the lock lives. The write that lands after
  such a stall was computed from state read before it: the S3 adapter parked
  its sub-part remainder unconditionally, so a stale remainder was counted
  after the parts the winner had since committed and published at an offset
  the client never sent it for; the GCS adapter wrote its chunk object under
  an index the winner already held, replacing the winner's bytes; the Azure
  adapter staged its block under an index the winner already held, and Azure
  replaces a staged block under an existing id. All three now fence the
  write. The S3 park lands only where no tail exists (`If-None-Match: *`)
  and carries the offset its bytes belong at, and a tail is counted only at
  that offset. The GCS chunk write is conditional on the object's absence
  (`ifGenerationMatch: 0`). The Azure adapter records every accepted block in
  its info blob under the same conditional write as the rest of the record,
  re-reads that record before each stage, and refuses an index the record
  already counts; a listing that disagrees with the record inside the accepted
  prefix invalidates the upload rather than publishing it. The one window
  the Azure fence cannot close lies between a stale holder's read of the
  record and its stage of the same index: if the winner stages that index in
  between, the stale block replaces the winner's, and the listing still
  agrees with the record when the two blocks are the same size, because the
  record counts blocks and bytes, not the content of each block. The record
  admits one acknowledgement per index, so only one of the two holders is
  told its block was accepted; the block that holds the index on the blob is
  whichever staged last. The filesystem adapter tested the signal that
  reports a lost lease only before each read of the body, so a read already
  in flight when the lease went resolved afterwards and its bytes were
  written at an offset the new holder had since made durable; it is tested on
  both sides of the read now.
- **The bookkeeping record was written unconditionally** (`gcsUploadStore`,
  `azureUploadStore`, `fsUploadStore`, `s3UploadStore`, `r2UploadStore`). The record is the
  only place an upload's invalidation lives, and a writer wrote it back with
  nothing pinning it to the version it had read, so a record that changed in
  between was overwritten: the GCS, Azure and filesystem adapters wrote a
  whole snapshot taken before the new holder's changes, and the S3 adapter
  re-read and merged but could still write over an invalidation recorded
  after its read. Either way the flag was cleared and a terminally dead
  upload was appendable again. Every record write is now conditional on the
  version it read (GCS `ifGenerationMatch`, with `0` at creation; Azure and
  S3 the ETag; R2 `onlyIf`; the filesystem keeps each fact in its own
  write-once file, so only `progress.json` is ever replaced), a refused S3,
  GCS or Azure write re-reads, merges the terminal flags one-way and retries,
  failing after three refused attempts, and the length and published ETag
  are taken from the fresh copy. A read the merge cannot make fails the write
  rather than falling back to the caller's snapshot. The mechanism is
  described under "Adapter bookkeeping is written conditionally".
- **An upload reaped while an append was in flight came back** (`s3UploadStore`,
  `gcsUploadStore`, `azureUploadStore`, `r2UploadStore`, `fsUploadStore`).
  The append's closing record write
  recreated the bookkeeping the abort or sweep had just deleted, from the
  snapshot the append held, so a cancelled or expired upload was reachable and
  appendable again under its old token. (On R2 and the filesystem the
  recreated record named a multipart upload or a data file that was already
  gone, so it was inert, but it still read as a live upload.) A record write
  now requires the record
  to exist: a missing one answers the append `UploadNotFoundError`, and the
  bytes that append had already written are discarded (the S3 part belongs to
  a multipart upload that was aborted, and S3 discards it; the GCS chunk object
  is deleted; the Azure blob's staged state is discarded under the same
  condition as an abort). The S3 sub-part tail is a separate object that
  outlived the reap: the append that observes the reap deletes it, and
  `sweepExpired` reclaims a tail whose sidecar is gone, judged on its own last
  write, so no upload bytes remain once the record is gone. The conformance harness gains
  `swept-resource-is-not-resurrected`, so a custom store is held to it.
- **A completion was attributed to whatever object sat at the key**
  (`s3UploadStore`, `r2UploadStore`). When the multipart upload was gone, the adapter read the
  object at the destination key and, if one existed, reported it as this
  upload's, ETag included. A key that another writer published in the meantime,
  or that held an object before the upload began, was reported as a completed
  upload, and `onUploadComplete` fired for bytes this upload never wrote.
  Completion now records a random publication id and stamps it on the object
  it publishes (S3 object metadata, R2 `customMetadata`), and a later probe
  or completion retry adopts the object at the key only when it carries that
  id, never by size or part count. A record written before the id was minted
  holds none: a publish it had in flight attributes nothing, and only a
  completion it had already recorded is adopted, by its stamped ETag or the
  length it fixed. The R2 adapter read the object at the key the same way
  (`head`, then reported its ETag) with no check on what it was, and a 5.0 R2
  store cannot adopt a pre-5.0 publication. A custom R2 bucket `head()` must
  return `customMetadata`.
- **A completion that crashed between the rename and the sidecar write read
  as an invalidated upload** (`fsUploadStore`). The retry found the data file
  gone and recorded the upload invalidated, although the object had been
  published, so the client's only recovery for a lost completion response
  answered 410 for an object that existed. The staged copy's identity is now
  recorded in `publication.json` before the copy is linked at the key, and a
  retry adopts the object at the key by file identity.
- **A partial chunk cleanup after the compose recomposed a suffix onto the
  key** (`gcsUploadStore`). Completion deleted the chunk objects before
  recording the upload complete; a crash or a refused delete partway left a
  live record over the surviving chunks, and the retry composed those onto the
  destination key, a shorter object over the complete one. The record is
  written before any chunk is deleted, and a retry answers from it.
- **Two uploads to one Azure key shared a block namespace** (`azureUploadStore`).
  Block ids carried a sequence number and nothing else, so a second upload to
  the same key summed the first one's staged blocks into its offset, committed
  them into its object, and overwrote them with its own sequence numbers.
  Block ids now carry a segment of the upload id, and an upload counts,
  commits and heals from its own segment only. The raw id width is unchanged,
  so a blob still holding blocks from a 4.x upload accepts the new ids; those
  blocks carry no segment and belong to no upload, so an upload in flight
  across the upgrade reads as lost, never as another upload's bytes.
- **The Azure discard checked, then deleted** (`azureUploadStore`). Abort and
  sweep read the destination blob's properties to tell staged-only state from
  a published object and deleted unconditionally; a commit landing between the
  two requests was the object the delete removed. By default the discard now
  writes nothing at the destination key: staged blocks are left to Azure's own
  seven-day collection of uncommitted blocks, so no blob, event or version
  appears at the key. `discardStaged: "commit-empty"` reclaims them at once by
  committing an empty block list create-only (`If-None-Match: *`), which drops
  every unlisted staged block and which the service refuses when a committed
  blob is already there, and then deleting the zero-byte blob it left pinned to
  the ETag that commit returned, so a writer that commits in between keeps its
  blob; a delete the service refuses (a retention policy) throws. With that
  option the zero-byte blob is briefly visible at the key and raises a
  `BlobCreated` event, and a container with versioning or soft delete may keep
  a copy of it.
- **An Azure record could outgrow the metadata ceiling after creation**
  (`azureUploadStore`). The info blob's record lives in blob metadata, which
  Azure caps at 8 KiB, and it grows after creation by the append timestamp, the
  published ETag and now the block ledger. A key and caller metadata that fit
  at creation put the first append's write over the cap, leaving a live upload
  no append could advance and no completion could record. Creation measures
  the record with every later field at its widest and refuses one that could
  cross a 7 KiB ceiling.
- **A first-time length below the durable offset was recorded** (engine). A
  deferred-length upload whose first length-fixing request declared a total
  smaller than the bytes already durable persisted it, and every later probe
  and append answered `length-inconsistent` forever. The total is refused
  before it is fixed.
- **An undeclared-size append bypassed `minAppendSize`** (engine).
  The floor exempts a completing append, and the exemption keyed on the
  client's statement alone, so a client stating completion on a request that
  declared no size, at an offset with room left to a known length, sent a body
  of any size below the floor and kept the upload open. A non-completing
  request that declared no size passed the floor too, because the test
  required a declared content size to run at all. The exemption now
  applies only where the engine can hold the statement to the post-condition
  before the write: a declared content size, a deferred length, or a zero
  bound at the durable end.
- **A creation that failed after publishing lost its token** (orchestrator).
  A creation carrying the whole body that published its object and then failed
  in the completion hook, or failed mid-body after a durable prefix landed,
  reported a store error with no token, so the client had no `Location` to
  repeat its completing request against and the at-least-once delivery that
  `onUploadComplete` documents was unreachable. The outcome carries the token,
  which the dialect renders as `Location`.
- **A completion could publish an object short of what the upload held**
  (`gcsUploadStore`, `s3UploadStore`). Both adapters assembled from a listing
  taken under a record read that was already stale. On GCS a completion that
  had lost its lock composed whatever chunks its listing returned, and the
  winner had by then published the whole object and reaped the chunks it
  consumed, so the loser composed the survivors, or nothing, over the
  complete object and reported that as its own completion. On S3 two
  completers reach the commit from separate part listings, and the loser's
  can be short by the tail the winner has since lifted into a part, which
  publishes a truncated object over the complete one; the backend cannot
  catch it, because it was never told what the total should be. The GCS
  record is re-read after the listing and a settled completion is answered
  from rather than composed over, and the S3 assembled size is checked
  against `expectedLength` and the length the upload declared after the
  seal, and the GCS listing is likewise taken after the seal.
- **A reclaim deleted the record that named the objects it was reclaiming**
  (`gcsUploadStore`). Abort and sweep listed an upload's chunks, deleted
  them, and deleted the record last. An append landing in that window wrote a
  chunk the listing had not seen, and the record that was the only thing
  naming it was then deleted, so the bytes stayed in the bucket with nothing
  able to reach or reclaim them: a deletion that reported success while
  retaining data. The record delete is now pinned to the generation read
  before the listing, so an append that moved it has the delete refused and
  the pass repeats over what it had not seen.
- **Damaged upload bookkeeping was read on trust and reported as nothing**
  (`fsUploadStore`, with the not-found it shares with `gcsUploadStore`,
  `r2UploadStore`, `azureUploadStore` and `s3UploadStore`, whose damaged
  record was a plain error answered as a server failure). The filesystem sidecar was parsed
  and used without a shape check, so a record holding a wrong-typed field fed
  it into offset math, and the sweep compared a non-numeric clock that never
  ages; it is now validated like every other adapter's record and, when it
  fails, aged by modification time like a torn one. A record of a completion
  without its size is damaged the same way, where it was a plain error. A torn sidecar's parse
  error was carried as the not-found's `cause`, and its text quotes the
  record, object key included. Every adapter now answers damaged bookkeeping
  with an `UploadNotFoundError` whose `cause` is an error named
  `UploadStateCorruptError` carrying nothing read from storage; the client
  still receives not-found (a resource nobody can resume is unknown to the
  protocol), and the orchestrator reports it to `onError`, where an
  expired token stays silent, so corruption on disk is no longer
  indistinguishable from a resource that ended.
- **A filesystem error named the file to every caller** (`fsStore`,
  `fsUploadStore`). An operating-system error such as `EACCES`, `EISDIR` or
  `EIO` carries the resolved path in its message, stack, `path` and `dest`,
  and that path holds the object key or the upload token; only an error that
  reached `onError` was redacted, so a direct caller logging a rejection
  printed both. Every method of both stores now rejects with each such path
  replaced by `<path>`, along the whole `cause` chain; `code` and the class
  are kept, and a not-found still carries its key on `key`.
- **The storage key reached the error sink past `auditKey`** (read path, both
  upload dialects, `s3UploadStore`, `fsUploadStore`). `auditKey` substitutes an opaque id for
  the filename-bearing key in the reported context, and the error handed over
  beside that context still carried the key: in a store error's message and
  `key` property, in an fs errno's `path`, in the backend error carried as
  `cause`, and, on the tus handler's outermost seam, as the raw upload token.
  A tus creation was worse: its events and errors, including those of the
  publish of an implicitly complete creation, carried the raw upload token
  with an `auditKey` set, because no key was asked for until a token
  existed.
  Four more seams reported without the identifiers they already held: a
  throttled S3 state read and a failing cancel-abort, whose errors name the
  destination key, and a throwing resumption hook, whose error quotes the
  location built from the token. Under an `auditKey` the read path and both
  upload dialects now hand `onError` a `ProjectedError` (`name`, `code?`,
  `status?`, `operation?`, `cause?`, with the `cause` chain projected the same
  way; exported from `partial-content/web`) instead of the raw error. What
  reaches the sink is an allow-list of fields that name a failure class, so
  the message, the stack and every other property, any of which can carry the
  token or the key in any spelling, stay behind. A throwing context extractor
  in the hono and node adapters is projected the same way, and the tus
  creation asks `auditKey` for the token the store minted before any event or
  error names the resource. Without an `auditKey` the raw error is handed
  over unchanged. An `onError` that branched on the error's message, class or
  properties under an `auditKey` must branch on `name`, `code` or `status`.
  For a custom store's own sink, `redactErrorText` scrubs a whole error,
  searching both spellings of a key (a filesystem adapter resolves the
  forward-slash spelling a consumer writes through the platform path module
  first, so on a backslash platform the errno's `path` and `dest` carried the
  filename past a single-spelling search).
- **An error message named the object key wherever the error went** (read
  path, every store). `ObjectNotFoundError`, `ObjectChangedError` and
  `StoreUnavailableError` spliced the key into their message, as did the
  adapters' own failures (a missing `ContentLength`, an empty body, an
  unparseable `Content-Range`, an origin status), the web adapter's
  served-range and byte-count refusals, and the upload store's reserved-prefix
  refusal. The `onError` scrub reaches only what passes through `onError`; an
  error a consumer catches from a store call, or logs from its own framework,
  carried the key in free text that no field-level redaction reaches. The
  upload stores' conflict and missing-generation failures named their
  bookkeeping objects, whose names embed the upload token, a bearer
  credential for the upload. A message now names the failure alone. The key stays on the error's `key`
  field and in the `onError` context, where it can be dropped, hashed or
  redacted by name. The backend error carried as `cause` is the backend's own
  and is not rewritten; `redactErrorText` scrubs a whole chain for a sink that
  needs it.
- **Multipart bytes past a part's range reached the wire** (read path). A
  chunk that crossed the part's span was framed and written before the span
  check ran, so the tail of a representation that changed under the read was
  delivered inside a well-formed part before the response errored. The chunk
  is withheld.
- **`httpStore` served the sibling upload store's namespace** (read path). The
  five other read stores refuse keys under their upload store's prefix; the
  http adapter, which cannot know which store sits behind its origin, refused
  nothing, so an origin fronting any of them served in-flight bytes and
  key-bearing sidecars to a read handler. It now refuses both prefixes by
  default (`reservedPrefix` overrides), and refuses them on every spelling an
  origin can resolve the key to: a key there becomes a URL path, and a path
  is percent-decoded and its dot segments resolved before it names anything,
  so `%2Euploads/x` and `a/../.uploads/x` both arrive at the workspace past a
  literal compare. The store's own encoder leaves none of that reachable, but
  `url` belongs to the consumer. The documented `url` example also
  interpolated the key into the request line unencoded; `encodeKeyPath` is
  exported and the example uses it.
- **The fs reserved-prefix guard checked the key, not the path** (read path,
  `fsStore`). A key spelled with mixed separators, a different case or dot
  segments resolved into the reserved directory past the guard. The guard is
  applied to the path the key resolves to, and the compare folds case and
  normal form on every platform: both belong to the volume, not the runtime,
  so a case-insensitive volume under a POSIX runtime opens the workspace as
  `.Uploads/` and a normalizing one opens it decomposed. Where the reserved
  prefix carries a segment that does not fit the 8.3 shape, a path segment of
  the generated-alias shape is refused within the prefix's own depth, since
  such an alias answers to the directory under a name no folding relates to
  the prefix. `fsUploadStore` refuses a publish key into its own workspace
  through the same guard, where it folded case on Windows only and accepted
  a generated alias such as `UPLOAD~1/`.
- **`fsStore` followed symbolic links out of its root by default** (read path,
  `fsStore`). 4.0.0 documented that links under the root were followed by
  design, so a link planted in the served tree (an upload tree, an extracted
  archive) served any file the process could read. The store now contains
  every key to the root's real path: the key's links are resolved and the
  result must sit inside the real root, and the open itself refuses a link in
  the final component (`O_NOFOLLOW`) where the platform has it. A link from one
  place in the root to another still serves; one that leaves it, or that
  reaches the reserved upload workspace, answers `ObjectNotFoundError`.
  `symlinks: "follow"` restores the old resolution for a root whose layout
  links to content kept elsewhere on purpose, and any other value contains.
  The check and the open are two steps, so a writer that can swap a directory
  under the root for a link between them is outside what the option defends
  against. This is a breaking default: see `docs/UPGRADING.md`.
- **A FIFO at a served path blocked the thread pool** (read path, `fsStore`,
  POSIX). The store opened the path before it checked that it was a regular
  file, and opening a FIFO parks a thread until a writer appears, so a few
  requests for a planted FIFO exhausted the pool the whole process shares. The
  open is non-blocking and a path that is not a regular file is refused.
- **Uploads were published through a link outside the root** (`fsUploadStore`).
  The workspace directory and the publish destination were created and
  renamed into with no check of where their links led, so a directory link
  under the root, or a linked `.uploads`, redirected a completed upload to
  any location the process could write. Creation and publication now resolve
  the real root first and publish only inside it.
- **The S3 offset a client had been told could go down** (`s3UploadStore`).
  Lifting the sub-part tail into a part deleted the tail before the part that
  replaced it was committed, so a transient failure between the two lowered
  the durable offset below what the client had been acknowledged, and the
  client, resuming from the lower offset, wrote different bytes over ones it
  had been told were safe. Completion lifted the tail before it checked the
  assembled size, so a refusal left a short part behind. A parked tail now
  leaves its slot only after its bytes are durable in a part or in a replacing
  tail, and the assembled size is checked before the tail is lifted, so the
  derived offset never falls below an acknowledged one. The one exception is
  an unstamped tail written by a 4.x store, which is removed before its part
  is sent.
- **A GCS read committed its status before the first byte** (read path,
  `gcsStore`). `getObject` returned a stream at once, so an object deleted or
  replaced between the metadata read and the first chunk was answered `200`
  and then failed mid-body, a truncated success the client could not tell from
  a complete one. The first chunk is awaited before the status is committed: a
  pinned read that finds the object missing or replaced raises
  `ObjectChangedError`, and an unpinned one that finds it missing raises
  `ObjectNotFoundError`, each answered as its status.
- **R2 wrote an unaligned remainder as a short multipart part**
  (`r2UploadStore`). R2 requires every part but the last to be the same size,
  and a part written short for a remainder can never be followed by another,
  so an upload whose chunks were not a multiple of the part size could not
  complete. The remainder is now a tail object (`<prefix>/<id>.<uuid>.part`)
  that the manifest names (`tail: { id, size }`); the manifest's conditional
  write is the fence, the previous tail is deleted only after the manifest
  that replaces it is durable, and completion uploads a tail still parked as
  the one short final part R2 permits. `sweepExpired` reaps tails.
- **Active XML content rendered inline without the sandbox** (read path).
  4.0.0 added `Content-Security-Policy: sandbox` to inline SVG, HTML, XHTML and
  generic XML only. Every `+xml` structured-syntax type (RFC 6839 Section 4.1)
  and `text/xsl` can run a stylesheet or script when opened as a top-level
  document, and all of them now get the sandbox when served `inline`.
- **A multi-range request cost one backend read per part, and a `NaN` cap
  disabled the cap** (read path). Each part of a `multipart/byteranges`
  response was its own ranged `getObject`, so one request with 50 ranges, the
  old `maxRanges` default, drove 50 reads against a metered backend. A
  `maxRanges` of `NaN` compared false against every count and so allowed
  unlimited ranges. `maxRanges` now defaults to 8 and fails closed:
  `serveObject` throws a `TypeError` for a value that is not a safe integer of
  at least 1, and `parseRanges` answers the full `200` for a `NaN` cap. The new
  `maxBackendReads` (default 8) bounds the pinned per-part reads; past it the
  parts are cut from one buffered read of the span covering them when that span
  is under 256 KiB, and the response is the full `200` otherwise.
- **A tokenless `DELETE` or `GET` could create and publish an empty object**
  (`createUploadHandler`). Every request without an upload token was routed to
  creation, and creation was gated on the completeness header alone, so a
  `DELETE` or `GET` carrying `Upload-Complete: ?1` created an empty upload and
  published it at whatever key `key()` chose. Only `POST`, `PUT` and `PATCH`
  create (draft-ietf-httpbis-resumable-upload Section 4.2.1); any other method
  without a token answers `405` with `Allow: POST, PUT, PATCH, OPTIONS`.
- **`Upload-Metadata` was unbounded** (`createTusHandler`). Every pair was
  decoded and handed to `key()` and the store, so the header size was work and
  storage a client chose, and a pair named `__proto__` or `constructor`
  landed on an object with a prototype. The header is now limited to 4096
  bytes and 32 pairs (`400` beyond, configurable with `metadataLimits`), and
  the parsed result has a null prototype, so those names are ordinary entries.
  Configured checksum algorithm names are matched case-insensitively: a
  configured `SHA1` never matched a request before.
- **A checksummed request was buffered and hashed before it was admitted**
  (`createTusHandler` with `checksum`, since 2.2.0). The Checksum extension
  verifies content before it is stored, which means buffering and hashing up
  to `checksum.maxBufferBytes`, and any client could make the server do that
  work for a request it would refuse: a `PATCH` under a token naming nothing
  or refused by `authorize`, or a creation-with-upload `POST` the policy or
  the `key` callback refuses, times concurrency. A `PATCH` is now judged by
  the new lock-free `orchestrator.admit(uploadToken, { authorize })` first
  (so `authorize` can run twice for one checksummed `PATCH`, on the same key
  and metadata, while the offset stays the append's to judge under the lock),
  and a creation verifies only after the policy and `key` admit it and before
  anything is allocated, so a mismatch leaves no resource behind. A declared
  `Content-Length` over the cap is refused `413` from the header alone on
  both.
- **A completion could overwrite a key written after it began, adopt a
  same-shape foreign object, or omit an acknowledged append** (every upload
  store). 4.0.0 composed the object from a listing and committed it
  unconditionally, so a key another writer published in the meantime was
  overwritten, an object at the key that merely matched the upload's size was
  taken for its own, and an append acknowledged after the listing was left out
  of the published object. Completion is now a sealed plan: it durably seals
  the upload at the `expectedLength` the caller acknowledged and records the
  state of the destination key, refuses every later append, takes the
  assembly plan only after the seal, and publishes under the provider's own
  precondition on the recorded destination state. A key written after the seal
  raises `UploadDestinationConflictError`, which the orchestrator answers from
  any store call and both dialects map to `409`; nothing is published and the
  upload stays sealed for an operator to reconcile. Two windows remain. The R2
  multipart `complete()` takes no precondition, so an object written in the
  instant between the check of the key and the publish is overwritten (a
  zero-byte upload has no such window). The filesystem adapter replaces an
  existing object by moving it aside and linking the new one, so a reader sees
  the key empty briefly.
- **A comma-separated media type could skip the sandbox** (read path). In
  `>= 1.2.0, < 5.0.0` a stored type such as `image/png, text/html` was judged
  by its first member, so `isInlineSafeMediaType` (2.3.0 and later) called it
  inline-safe and the read handler added no `Content-Security-Policy:
  sandbox`, while a browser extracting a MIME type (WHATWG Fetch) renders the
  last member, here HTML. Every media type is now parsed by one RFC 9110
  parser (`media-type.ts`); an off-grammar value, any comma included, is
  served as `application/octet-stream` and is never inline-safe.

One item in this section rests on a trust that ends with the upgrade window: a
4.x S3 tail carries no offset stamp and is counted where it is found, until the
first append after the upgrade replaces it. A 4.x S3 completion record is not in
that class, because completion is terminal and no later write restamps it; such
a record is held to the length it fixed for as long as it lives, and only one
that fixed no length is taken on the key's existence, as it always was. The
Cloudflare Workers runtime is not exercised by the cross-runtime smoke check, so
the transparent-compression refusal is observed against Node, Deno and Bun only.

### Node.js 24 or later

`engines.node` is `>=24.0.0` (was `>=20.0.0`). Node.js 20 reached end of life
in April 2026, and the repository that builds and tests the package requires
Node.js 24, so a lower floor was a claim nothing verified. Bun, Deno and the
edge runtimes are unaffected.

### The engine no longer guesses whether a request carries content

A request that declares no content size is an unknown, and the old code
resolved that unknown in opposite directions in two branches of one function.
No resolution was right for every client, because the question cannot be
answered before the body is read.

`AppendIntent.hasContent`, `CreateIntent.hasContent` and the internal
fast path for completing an upload already at its declared length are gone. The
engine now returns a bound and a post-condition, and the post-condition is
evaluated against the bytes the store reports as durable. A completing append
at the declared end is an ordinary append whose bound is zero further bytes, so
a body carrying content is refused by the same mechanism that refuses every
other over-append, with the registered `inconsistent-upload-length` problem
type on the revisions that define one.

One consequence is worth stating on its own: **`minAppendSize` now binds.** It
was advertised in `Upload-Limit` and enforced only for a request that declared
its size, so any chunked request slipped past the floor entirely. A
non-completing append that declares no size is now refused before any byte
moves. A completing append stays exempt, so a client that cannot state a size
can still finish.

That exemption needs a wire on which a request can assert its own completion,
and tus is not one: it infers completion from a known total, so a deferred
length can never claim it and every chunked append would meet a floor it can
neither escape nor discover. **`createTusHandler` now refuses `minAppendSize`
at construction** rather than serving an endpoint that answers 400 forever. Set
it on the IETF dialect, which advertises `min-append-size` and lets a request
say it is finished.

### Refusals that cost no more than a refusal

- **A size floor is checked before any byte moves**, on the total the request
  would fix, so a first completing append below the server's `minSize` is
  refused without recording a length the upload could never publish.
- **A duplicate completing retry leaves a byte-complete upload intact.** A
  completing request that arrives again at the declared end, with or without a
  `Content-Length`, crosses a zero bound, and a zero bound is not terminal: the
  retry is refused with the upload still completable. A body that does carry
  bytes into that zero bound is answered as the representation's inconsistency
  it is (`length-inconsistent` for a declared length, `size-exceeded` for the
  policy ceiling), never as this request's ceiling, which a client would try to
  meet with a smaller chunk that can never fit.
- **A completed upload no longer expires.** `maxAgeSeconds` bounds partial
  bytes nothing will finish and the right to keep appending, and a finished
  upload has neither. Expiring it answered `not-found` to the client's
  idempotent completing retry, which is the only recovery a resumable protocol
  has for a lost response, and permanently stranded a completion report whose
  first delivery failed. Reaping the finished resource's bookkeeping stays
  `sweepExpired`'s job. Invalidation still overrides completion.

### `appendChunk` reports whether it ran to the end of the body

`AppendChunkResult` gains `interrupted`. Only the code draining the body knows
whether it stopped early, and the caller was previously inferring it from an
abort signal, which says that something asked the write to yield and nothing
about what happened to the bytes. Every store must now return the field.

### `sweepExpired` takes two clocks and requires one

`sweepExpired(cutoff)` accepts `idleSinceMs`, `createdBeforeMs`, or both, and
throws when given neither. Reclamation previously keyed on idleness alone while
the lifetime limit is measured from creation, so a resource could sit past the
lifetime that every request refused it for and remain invisible to the sweep
indefinitely: a client sending one byte a minute kept it alive for the sweep
while being refused by the protocol, and nothing could ever reclaim the bytes.

`sweepExpired` resolves `{ removed, failed }`. A resource the pass condemned but
could not remove (a denied delete, a throttled backend, a file held open) stays
in place, is counted in `failed`, and is retried on the next pass; it no longer
rejects the whole sweep. The sweep still rejects on an unreadable listing or an
aborted signal. **Alert on `failed`**: a monitor that alerted on a rejected
sweep no longer hears about a resource it cannot remove. A custom store must
return the field.

The upload path also discards a resource on the terminal outcomes it produces
itself: a digest mismatch, and a resource refused as expired or invalidated. A
failed digest previously left a fully staged representation that no client
could reach or delete.

### Capability flags can be wrong, and the harness checks them

`enforcesOffsetCheck` and `atomicCompletion` were typed as the literal `true`,
so a store could not declare anything else and the checks that refuse a store
reporting `false` could never run. Both widen to `boolean`, and
`partial-content/conformance` goes from 15 write-side checks to 28, exercising
the behavior behind them rather than the declaration: that a stale write leaves
the durable offset AND the bytes alone, that a failed completion publishes
nothing at the destination key, that completion publishes exactly what was
appended, that an abort spares an object already published, that a store
which stops mid-body says so (a short append, a torn body, an abort mid-read),
and that a request ceiling stops a streaming body. `swept-resource-is-not-resurrected`
holds a sweeping store to the reaped-upload rule under "Security": an append
whose body was in flight when the sweep ran must not write the resource back.

`runConformanceCheck`, `tallyConformance` and `ConformanceAssert` are exported,
so a store author can add backend-specific checks to a run and score them with
the built-in ones. A check that makes no assertion fails rather than passes.

Several of those have to look at what was actually published, so
`ConformanceOptions` gains `readObject?: (key) => Uint8Array | undefined`, which
may also return a promise.
**Without it they are reported SKIPPED with the reason, never passed.** An
obligation nothing could observe has gone unverified rather than been met, and
a harness that scored it as a pass would be worth less than the flag it
replaced, because it would look like proof.

### Appends answer 204, or 200 on completion

`201 Created` is the status for creating the upload resource, which still
answers 201 with `Location`. A 201 carrying no `Location` asserts that the
request created what the target URI names, which an append to an existing
resource did not.

### Smaller protocol corrections

- A completing append that declares a content size now fixes and records the
  representation's total, which was derived at creation and nowhere else.
- The completion hook is not re-delivered once a delivery has resolved, so a
  repeated bodiless request cannot drive unbounded awaited callbacks.
- A reported store error is withheld under the caller's `auditKey` (a
  `ProjectedError`, described under "Security"). `redactErrorText` is exported
  from the package root for a custom store's error sink; it covers the storage
  key as well as the token, and reaches an error's own properties and its
  `cause` chain.
- `reservedKeyGuard` takes a list of prefixes as well as one.
- A request body the store never took is cancelled rather than abandoned.
- Whether offset retrieval and cancellation refuse upload-state header fields
  is a per-version fact in the wire table, so the newest revision no longer
  inherits a restriction it does not impose.
- Interop 3, 5 and 6 answer an inconsistent length with the registered problem
  type's title, `inconsistent length values for upload`, as plain text; the
  body read `inconsistent upload length indicators`.
- `createTusHandler` refuses at construction a `maxAgeSeconds` whose deadline
  falls past the year 9999: `Upload-Expires` is an IMF-fixdate (RFC 9110
  Section 5.6.7) with a four-digit year, and the header read a five-digit year
  or `Invalid Date` instead.
- The tus `PATCH` gate and the IETF append gate read `Content-Type` with
  `parseMediaType` (RFC 9110 Section 8.3.1). tus now refuses a comma list or
  an off-grammar value that 4.0.0 admitted, and the IETF gate accepts
  `application/partial-upload` with parameters, which 4.0.0 refused.
- A tus `HEAD` that heals an upload stalled at offset equal to its length
  (it publishes the upload) runs under the `authorize` hook with
  `operation: "append"`, so a caller admitted only to probe receives the
  hook's append refusal.

### `Upload-Limit` counted to one deadline

`max-age` is derived from one deadline, the one recorded at creation, on every answer about a resource: the whole seconds left,
rounded down. A creation whose body streamed has already spent part of it. A
probe rounded the elapsed time down instead, so it could promise up to a
second the resource did not have, and a limit rejection about an existing
upload stated the configured lifetime, moving forward the deadline its client
already held. The `probed` orchestrator outcome drops
`remainingLifetimeSeconds` for the `expiresAt` it already carried, and a
`limit-violation` outcome about an existing resource carries `expiresAt` as
well. A creation that completed the upload carries no `Upload-Limit`: nothing
is left to append. `createUploadHandler` refuses at construction a policy
bound longer than 15 digits, the most an RFC 8941 integer has: a parser
refuses the whole field on a longer one, which cost the client every limit,
not only that one.

### A completing upload response names what it published

`Repr-Digest` and `ETag` now ride the response that reports an upload
complete, on both dialects and on both completing paths. A store configured to
hash the published representation computed the digest, the orchestrator carried
it, and both dialects dropped it, while the CORS exposure list advertised
`Repr-Digest` as readable: a list naming a header nothing sent.

That list is now honest in both directions. `ETag` is exposed, because it is
not a CORS-safelisted response header and emitting it unexposed would be the
same defect one field over. `Upload-Checksum` is removed from the tus list: the
extension defines it as a request header and no response carries it. **A
deployment that copies that list into its CORS configuration should update the
string.**

The idempotent replay of an already-complete request deliberately carries
neither header, because that answer is synthesized from durable facts and holds
no representation to describe. It is an omission rather than a claim.

### Adapter bookkeeping is written conditionally

A store's own metadata record is the only place an upload's invalidation
lives, and a holder whose lock was stolen while its body streamed used to write
that record back from a snapshot taken before the new holder's changes, which
could clear the flag and resurrect a terminally dead upload. The four adapters
that keep such a record now pin every write to the version they read: `If-Match`
on the S3 sidecar `PutObject` (`If-None-Match: *` at creation), `onlyIf` on the
R2 manifest, `ifMatch` on the Azure info blob's metadata, `ifGenerationMatch`
on the GCS bookkeeping object (`0` at creation). A refused S3, GCS or Azure
write re-reads, merges with the terminal flags one-way, and retries, failing
after three refused attempts; a refused R2 write is answered with the winner's durable
offset, as every stale writer is. The data writes that can collide are fenced
too, and the completions that can be misattributed are recorded; both are
described under "Security".

The Azure record grows by the accepted-block ledger and the completion seal
fields, and the filesystem adapter keeps each fact in its own file under one
directory per upload; neither changes a public type. A persisted S3
sidecar field of the wrong shape (`length`, `partSize`, `invalidated`,
`completed`, `metadata`) is damaged bookkeeping (see "Security") rather than
read as absent and written back. Two changes are breaking for an upload in
flight: the Azure block-id scheme, so **an Azure upload in flight across the
upgrade reads as invalidated** and must restart, and the filesystem layout
(see "Changed (breaking)"), so a 4.x filesystem upload in flight answers 404
and must restart.

`s3UploadStore` gains `sidecarCas` (default `true`). An S3-compatible backend
that answers `NotImplemented` to the precondition fails the operation naming the
option rather than degrading in place; pass `false` for such a backend, accepting
that its sidecar writes are protected by the re-read and the monotonic flags
alone.

Some S3-compatible backends accept the precondition headers and ignore them,
which no single write reveals. Before its first conditional write the store
therefore creates a canary object under `uploadPrefix` with `If-None-Match: *`
twice, deletes it, and trusts the backend only when the second create answered
`412`. The verdict is kept for the store's lifetime; a probe that fails for
another reason decides nothing and is asked again. A backend that accepted both
creates fails the first upload with an error naming `sidecarCas: false`, as
one answering `NotImplemented` does. The canary is shaped like a tail no
sidecar names, so the sweep reclaims one a failed delete left behind.

`s3UploadStore` also gains `publishCas` (default `true`), which makes the
multipart commit conditional on the destination state the completion sealed. A
canary probe fails the first completion on a backend that ignores the
condition, with an error naming `publishCas: false`.

### A size the backend did not report is never counted

A backend reply that lacks a size, or carries one that is not a decimal count,
now fails the call. `azureUploadStore` counted a block listed without a size as
zero bytes and `gcsUploadStore` did the same for a chunk object, which handed a
resuming client an offset short of the bytes it had made durable; `gcsStore`
read an unparseable object size by its leading digits.

A completed Azure or GCS upload records its size, a deferred length included.
The state of a completed upload whose published object was later deleted is
answered from that record; with the length deferred it used to be answered
with an offset of zero. A completed record written without the size fails that
read instead, as does an fs sidecar marked complete without one.

`azureUploadStore` records the empty accepted-block ledger at creation, so the
ledger tells an upload that accepted nothing from one whose bytes were lost. A
deferred-length upload whose staged blocks were lost under a blob that lists no
blocks is invalidated; it used to read as a completed empty upload, and a
completion retry committed an empty blob over the one at the key.

### Read side

- The served body is held to the committed `Content-Length`. A stream body
  that closes short of it, or produces bytes past it, errors the response (a
  reset the client sees as a failed transfer) and reports the transfer as
  `completed: false` with the bytes actually delivered; a byte body whose
  length disagrees with the store's `contentLength` is refused with 502
  before headers commit. Both route to `onError` with `operation: "get"`.
  Until now a backend that ended a body early was delivered as a truncated
  200 or 206 that a client could not tell from a complete one, and the
  transfer was logged as completed. The multipart path already held each part
  to its span; single-range and full responses now do the same. Byte bodies
  with no transfer hook keep the static-body fast path; every stream body is
  counted.
- `ETagSource` uses `ObjectMetadata`'s field names (`etag`, `contentLength`,
  `lastModified`), so `generateETag(await store.headObject(key))` is a
  supported call. The retired names throw a `TypeError` naming their
  replacement rather than reading as absent, which would have served no
  validator at all. `etag` decides the validator; `digest` is never read.
- `toObjectBody` narrows a `Buffer`, a bare `Uint8Array` or a
  `ReadableStream<Uint8Array>` to the `ObjectBody` a store returns, copying a
  `SharedArrayBuffer`-backed view, so a store reading with `readFile` returns
  `toObjectBody(await readFile(path))` without a cast. `ObjectBody` and
  `ObjectBodySource` are exported. The narrow, `ArrayBuffer`-backed type stays
  in return position, where it is what makes a body assignable to
  `new Response(...)` under the DOM lib.
- Media types added for HLS playlists, WebVTT, SubRip, source maps and YAML.
- `onTiming` is called once per served body, with the figures its
  `Server-Timing` header carries. A single-range or full read that was
  refused afterwards (the object changed under it, or the store returned
  bounds or a byte count the response cannot carry) reported its timing
  anyway, so a re-validated request was counted twice and a 502 reported a
  timing no response carried.

### Node

`partial-content/node` gains `toWebRequest`, `sendResponse` and `nodeHandler`,
so the upload dialects run on `http.createServer` without a hand-written
bridge. Bodies stream with socket-level backpressure, and `Expect:
100-continue` is surfaced rather than answered, because whether a body is worth
receiving is an authorization decision the bridge cannot make. HTTP/2 request
objects are out of scope.

A request that had already closed before it was converted, or whose socket
closes without the request emitting its own `close`, aborts the converted
request's signal, and a body pull on such a request fails rather than waiting
on a stream nothing will feed. An external signal is unlinked when the
request's own life ends, including an answered request whose body never
arrived complete, so a long-lived caller signal does not accumulate listeners.

`readStallTimeoutMs` bounds the time the sender leaves a read outstanding: it
is armed when the reader asks for a chunk and cleared when one arrives, so it
measures the sender, never the consumer. A store that takes a minute between
reads is not a stalled client, and a body nobody reads arms nothing at all,
which is what keeps a timer from outliving the request that owns it.

Cancelling a request body drains and discards it rather than destroying the
connection, so a handler that stops reading can still answer. That is what lets
an upload refused for crossing a bound reach the client as the status it
deserves instead of a reset, which a resumable client cannot tell from a
network fault and would retry forever. There is deliberately no byte ceiling on
that drain: a ceiling reintroduces the reset for exactly the large bodies most
likely to be refused, and how long a sender may keep pushing a body nobody
reads is already `server.requestTimeout`'s job.

An absolute-form request target never overrides a configured `origin`. The
option exists to avoid trusting a client-sent header, and a request target is
equally client-sent, so only its path and query are taken.

`toWebRequest` refuses a request target the URL parser would rewrite: a leading
`//`, a dot segment (spelled `.`, `..` or with `%2e`), a backslash, or an
absolute form whose path is such a target. A rewritten path would route to a
resource other than the one the client named, and a client-chosen path is what
`key()` and `resolveToken` read. It throws a `TypeError`, and `nodeHandler`
answers it `400` and reports it to `onError`.

### Packaging

The `prepare` script is gone, so installing from the git repository no longer
builds `dist/`. Install from the registry, or run `npm run build` after a git
install.

### Upload responses 4.0.0 sent that were never conformant

Five upload-path corrections, prepared as a 4.0.1 patch that was never
published. Four of them change a response 4.0.0 sent, and each of those four
replaces an answer that was never conformant: a deployment depending on the old
behavior was depending on the server reporting something untrue.

- **An append that carries content to an upload the server has already
  finished is refused `400` rather than acknowledged.** The engine decided the
  case on the offset alone, so a request whose bytes had nowhere to go, the
  total being fixed at completion, was answered as though they had been
  stored. It now carries the registered `inconsistent-upload-length` problem
  type on the revisions that define one.
- **A completing append that declares no content size no longer publishes
  without reading its body.** A request with `Upload-Complete` set, arriving at
  the end of an upload that had reached its length but not yet been published,
  took a fast path that completed the resource and returned success while the
  body was never read, written or cancelled. Chunked requests are the ones that
  declare no size, so the answer a client received depended on whether it sent
  `Content-Length`. Content presence is now judged one way everywhere: a
  request carrying content is bounded at zero further bytes and refused by that
  bound, which is where every other over-append is already decided.
- **A `409` on a mismatched offset reports the upload as incomplete.** It
  echoed the resource's own completeness, so a conflict against a finished
  upload said `Upload-Complete: ?1`. The specification makes the false value
  mandatory there, and a client reads it to tell a conflict it can resume at
  the offset beside it from a representation that failed to process, which it
  cannot. A recoverable conflict was reading as terminal.
- **`Upload-Limit` states the remaining lifetime and the effective bounds.**
  `max-age` is defined as the lifetime left counted from the response and was
  emitting the configured total, so a resource an hour into a one-hour lifetime
  still advertised the full hour. The field is also built from the bounds
  actually in force, including a limit the storage backend imposes, which were
  previously omitted from every response including the `413` that exists to
  tell a client what size to retry with.
- **A storage error raised while another request preempts an append is
  reported, not swallowed.** Preemption is ordinary here, since reading an
  upload's offset asks an in-flight append to yield, and the classification
  asked whether that had happened rather than what the store had raised. An
  append refused for crossing a bound, or for writing at an offset the resource
  had moved past, could be reported as an interruption and answered with an
  offset the client could not resume from.

### Changed (breaking)

Each is walked, with before and after code, in `docs/UPGRADING.md`.

- **One `auditKey` shape on both upload dialects**:
  `({ request, uploadToken }) => string | undefined`. The tus handler took
  `(uploadToken) => string` and the IETF handler `(request) => string |
  undefined`. The callback is asked first without a token on a creation, and
  again with the one the store minted.
- **`policy.maxSize` is required** on `createUploadHandler` and
  `createTusHandler`; `Infinity` states that the endpoint has no size ceiling.
  An omission is a `TypeError` at construction.
- **`key()` runs after the policy accepts, before anything is allocated**, and
  may be async. It returns a string, `{ key, metadata? }` (the metadata recorded
  in place of the client's), or a `Response` that refuses the creation as-is.
  `UploadCreation` and `TusCreation` carry the effective `policy`, and the tus
  one the `declaredLength`. Both dialects gain `authorize`, called for probe,
  append and cancel under the upload's lock with the stored key and metadata,
  where per-upload checks belong. On the orchestrator,
  `CreateUploadRequest.key` is a thunk and an outcome may be `refused`.
- **Upload state reports `status`** (`"incomplete" | "complete" |
  "invalidated"`) in place of `isComplete` and `isInvalidated`. The persisted
  bookkeeping is unchanged.
- **Completion digests are keyed by algorithm.** `expectedDigest` becomes
  `expectedDigests: { "sha-256": value }`; `digestOnComplete` is
  `readonly UploadDigestAlgorithm[] | false` (was `"sha256" | false`); the
  orchestrator's `canVerifyDigest` becomes `verifiedDigests`.
  `UploadDigestMismatchError` gains `algorithm`. The memory and filesystem
  stores verify `sha-512` as well as `sha-256`. A `Repr-Digest` member whose
  value is not the length its algorithm produces is ignored.
- **The Redis locker names resources by digest on one channel.** The key is the
  prefix plus the SHA-256 of the token in hex, and a preempt request is that
  digest published on one `<prefix>preempt` channel that a single subscription
  per locker routes, instead of one channel and one subscriber connection per
  acquisition. Lock and channel names differ from 4.0.0's: drain in-flight
  uploads before switching a fleet over.
- **`createSignedUrl` distinguishes declining from failing.** `{ ok: false }`
  (with an optional `code` of `"no-credential"` or `"unsupported"`, and the
  underlying `cause`) means the store cannot sign and the response streams the
  bytes, unreported. A throw is a real failure, reported with operation
  `"sign"` and answered `502`, or `499` after the client aborted. 4.0.0 answered
  a decline `502`. The signer receives the request's `signal` and is called at
  most once. `s3Store` throws a signing failure and declines only when the
  presigner cannot be loaded (`unsupported`); `azureStore` without a shared-key
  credential and `gcsStore` without a `client_email` decline (`no-credential`).
- **`ParsedContentRange.totalSize` is `undefined`** for `bytes a-b/*` (it was
  `-1`).
- **`EvaluatedWrite.status` admits `428`** (RFC 6585 Section 3). The package's
  own evaluation still produces `412`.
- **`ETagSource` takes extra metadata fields.** Only `etag`, `contentLength` and
  `lastModified` feed the derived validator, so a custom store may carry more
  on its metadata; `generateETag` refuses a retired name only as an own property
  with its replacement absent.
- **A multipart response is bounded at 8 ranges and 8 backend reads** (see
  "Security"): a request with more than 8 coalesced ranges is answered with the
  full `200` until `maxRanges` and `maxBackendReads` are raised, and an
  invalid `maxRanges` is a `TypeError` at construction.
- **`lookupMime` returns no `js`, `mjs`, `css` or `wasm` type** unless called as
  `lookupMime(name, { webAssets: true })`. A static asset server passes the
  option; an upload server leaves it off, so a stored script is served as an
  attachment of no particular type.
- **Timing options are validated.** `graceMs` outside 0 to 2147483647 and
  `lockTimeoutMs` outside 1 to 2147483647 (NaN, negative, fractional or
  oversized) throw a `TypeError` at construction, where a timer would have
  fired at once or never.
- **The fs stores validate their options.** `fsStore` and `fsUploadStore`
  throw one `TypeError` for a missing or relative `root`, and the `fsStore`
  cache's `ttlMs`, `maxEntries` and `maxBytes` throw for `NaN`, an infinity or
  a negative number, each of which had silently disabled the bound it named.
- **A known length past 10,000 parts of 5 GiB is a `RangeError`** at
  `createUpload` on S3 and R2, and a deferred-length upload that reaches part
  10,001 gets a non-fatal `413` (`UploadAppendBoundError`; fatal on R2 in
  4.0.0).
- **tus checksum configuration is checked.** `createTusHandler` throws a
  `TypeError` when `checksum.algorithms` has no `sha1` (tus 1.0 requires every
  server offering the extension to support it), when an entry is not a header
  token or repeats another ignoring case, and, as two separate messages, when
  neither `checksum.maxBufferBytes` nor `policy.maxAppendSize` bounds the
  verification buffer.
- **A content-bearing chunked append to a completed upload is refused**
  (`400`, `inconsistent-upload-length`, both dialects). For a request with no
  declared size the orchestrator reads the body as far as its first byte; a
  byte means the refusal, none means the idempotent replay. Interop 9 had
  answered such a request `200` with the completion while cancelling its body
  unread.
- **The CORS exposure lists come from their own dialect.**
  `TUS_EXPOSED_HEADERS` is exported only from `partial-content/tus` and
  `UPLOAD_EXPOSED_HEADERS` only from `partial-content/upload`; each was also
  re-exported from the other subpath. A lock acquire now passes `timeoutMs` and
  `auditKey` as possibly-undefined fields, which a custom `UploadLocker` that
  tells absent from `undefined` can see, and a few tus refusal texts are
  shorter.
- **A reaped append surfaces the failed discard.** When the resource is reaped
  while an append streams, the append removes what it wrote and fails with
  `UploadNotFoundError`; a removal that failed now throws in place of that
  error (reported through `onError`, answered as a server error), where it was
  swallowed and left an orphan nothing would reclaim.
- **Closed literal unions may gain members.** `ServeErrorContext.operation`,
  the `ServeAuditEvent` method and status, `TransferEvent.status`,
  `RangeResponseHeaders.status`, `EvaluatedWrite.status`, the `createSignedUrl`
  `code`, the upload event, status and reject-reason unions and
  `FatalBoundReason` each say so in their documentation: a `switch` over one
  needs a `default` branch.
- **`CompleteUploadOptions.expectedLength` is required.** A custom store seals
  its completion at that length, refuses every later append, and refuses a
  mismatch by throwing `UploadOffsetConflictError` carrying the length it
  holds (see "Security").
- **`UploadLock.lease` is required.** It is an `AbortSignal` that fires, with
  reason `UPLOAD_LEASE_LOST`, when the lock is lost. A 4.x custom locker has
  no `lease`, so every completion throws where the orchestrator tests
  `lock.lease.aborted`.
- **The filesystem upload layout is one directory per upload.** 4.x flat files
  are only swept by age, so a 4.x filesystem upload in flight across the
  upgrade answers 404 and must restart. `fsUploadStore` needs hard links and
  one volume for the workspace and every key.
- **The IETF dialect reports its own failures to `onError` with operation
  `"handler"`**; 4.0.0 sent `"handle"`.
- **The Azure discard writes nothing at the key by default**
  (`discardStaged: "age-out"`). Abort and sweep leave staged blocks to Azure's
  seven-day collection; `"commit-empty"` reclaims them at once (see
  "Security" for its costs).

### Changed

- A future `Last-Modified` is clamped to the response time (RFC 9110 Section
  8.8.2.1) and a date with no zone is read as UTC. One entity-tag form is
  emitted and compared: an unquoted value, or one with a character outside the
  `etagc` grammar, is requoted (Section 8.8.3).
- A `Content-Disposition` filename is never a dot segment, and is capped at 255
  UTF-8 bytes, keeping a short extension.
- Under an `auditKey`, a precompressed variant's audit events report the
  identity key together with `variantKey` and `contentEncoding`; `variantKey`
  is withheld under an `auditKey`.
- `ObjectMetadata.contentType` is informational: never sent as `Content-Type`,
  it reaches `onServe` and `onTransfer` as `storedContentType`.
- `serveObject` uses `FixedLengthStream` where the runtime has one, so
  `Content-Length` survives on Cloudflare Workers.
- A store failure after the client aborted is answered `499` and not reported.
- A `405`, `412` or `416` carries the deny headers every other refusal carries.

### Added

- `UploadPolicy.digestPolicy`: `"advisory"` (the default) ignores a
  `Repr-Digest` (RFC 9530) asserted only in algorithms the store cannot verify,
  and the upload publishes unverified, as it did; `"require-verifiable"`
  refuses such a request with `400` before anything is allocated or written
  (`UploadDigestUnverifiableError`, code `UPLOAD_DIGEST_UNVERIFIABLE`, guard
  `isUploadDigestUnverifiableError`, outcome kind `digest-unverifiable`, audit
  reason `digest-unverifiable`). A mixed assertion keeps its verifiable
  algorithms; a request with no assertion is unaffected. Being a policy field,
  a per-request resolver can set it per tenant. `createTusHandler` throws a
  `TypeError` at construction when it is set, because tus verifies
  `Upload-Checksum` itself. `UploadRejectReason` and `UploadOutcome` each gain a
  member, under the policy that those unions may gain members in a minor release.
- `fsUploadStore`, `s3UploadStore`, `r2UploadStore`, `gcsUploadStore` and
  `azureUploadStore` return a `PrefixedUploadStore`, which adds
  `readonly uploadPrefix`, so `s3Store({ reservedPrefix: uploads.uploadPrefix })`
  keeps a read store and its write store in step; both defaults come from one
  constant.
- Upload errors carry a stable `code` (`UPLOAD_NOT_FOUND`,
  `UPLOAD_OFFSET_CONFLICT`, `UPLOAD_APPEND_BOUND`, `UPLOAD_OVERRUN`,
  `UPLOAD_DIGEST_MISMATCH`, `UPLOAD_LOCK_TIMEOUT`); `isUploadNotFoundError`,
  `isUploadDigestMismatchError` and `isUploadLockTimeoutError` are type guards
  like their siblings. They match by `name`, not `instanceof`, so a custom
  store can throw an equivalently-named error without importing the class;
  the narrowing trusts such an error to carry the class's fields.
  `UPLOAD_STORE_CONTRACT_VERSION` is exported.
- `UploadDestinationConflictError` (code `UPLOAD_DESTINATION_CONFLICT`, guard
  `isUploadDestinationConflictError`), raised when a completion finds the key
  changed under its sealed plan. The orchestrator answers it with the
  `destination-conflict` outcome and the `append-rejected` reason of the same
  name. `UPLOAD_LEASE_LOST` is the reason `UploadLock.lease` aborts with.
  `UploadStateReadOptions.repair: false` marks a read from a caller that holds
  no lock, which a store must not let write. The orchestrator takes
  `redactErrors`, and `CreateUploadRequest` takes `admitBody`. `uploadExpiry`
  resolves a resource's deadline, and `CreateUploadOptions.expiresAt` and
  `StoredUploadState.expiresAt` carry it through the store.
- Audit events `appended` (`atOffset`, `bytes`, `interrupted`) and
  `lock-contended`; the reject reason `digest-mismatch`; `UploadRejectReason`
  and `ServeErrorContext` are exported.
- The IETF handler serves interop 10 (draft-13 and draft-14); the default `interopVersions`
  are `[3, 5, 6, 9, 10]`. draft-13 reads a `2xx` as "the whole request content
  was processed", so under 10 a creation or append whose body was interrupted
  answers `409` with the durable `Upload-Offset`, and a creation keeps its
  `Location`, the only way back to that prefix. The interop 9 creation response
  carries `Upload-Limit` when limits exist.
- `onResumptionSupported` fires when the resource is allocated, before the
  creation body is read, with the interim response's `headers` (the version
  echo, `Location`, and `Upload-Limit` where the version announces limits). On
  the orchestrator, `CreateUploadRequest.onAllocated(uploadToken)` runs under
  the lock; a throw is reported with operation `allocated-hook` and the
  creation proceeds. Both fire for a creation that fails
  after allocating.
- `policy` accepts a resolver, `(request) => policy | Promise<policy>`. Each
  request is judged under, and advertises (`Upload-Limit`; `Tus-Max-Size`,
  expiry, `Upload-Expires` and the checksum buffer bound on tus), the policy it
  resolves. A resolved policy is validated like a static one: an invalid answer
  is a `500` reported to `onError` as a `TypeError`. The policy that
  creates an upload fixes its deadline, which the store records
  (`CreateUploadOptions.expiresAt`); later requests judge expiry by that
  instant (`uploadExpiry`), so a request resolving another policy cannot move
  it. The orchestrator gains
  `effectivePolicy()` and a per-request `policy`.
- A write store may implement `claimUpload()`, returning an `UploadClaim` with
  an `epoch`. The orchestrator claims under the lock before a request that is
  about to write and passes the epoch to `appendChunk`, `completeUpload` and
  `abortUpload`; a store refuses a superseded epoch with
  `UploadOffsetConflictError`. Optional, and the contract version is unchanged;
  no built-in adapter mints claims.
- `AppendChunkOptions.releaseBody` cancels the unread request body even when
  the store has locked the stream. It is idempotent, never rejects, does
  nothing once the body is read, and a read after it fails instead of ending
  clean. The orchestrator calls it once `appendChunk` returns or throws, and
  every built-in store calls it on each refusal.
- `metadataLimits` on the tus handler (`maxBytes`, `maxPairs`).
- `maxBackendReads` on `serveObject`; `symlinks` on `fsStore`.
- `partial-content/conformance` checks that a token does not contain its key
  (`token-is-unguessable`), and refuses percent-encoded, base64 and plain
  spellings of it.
- `dist/sbom.cdx.json`, a CycloneDX software bill of materials, ships in the
  tarball. `docs/API.md` carries regions generated from the source, checked by
  `npm run check:api-docs` before a publish.

### Fixed

- A probe of a complete upload re-delivers a completion hook delivery that
  failed. While the hook throws, the probe answers `500` (IETF) or `502` (tus)
  so the client probes again; a delivery that resolved is not repeated within
  the process, and across processes the hook is at-least-once and must be
  idempotent on `uploadToken`. 4.0.0 re-delivered only on a repeated completing
  request.
- A request that preempts an append answers within milliseconds, not after the
  lock timeout, when the holder's client stopped sending; the interrupted
  append reports its durable offset. This holds on every store adapter, and the
  yielding wrapper errors rather than closes, so no truncated object is
  published.
- `memoryUploadStore` re-checks the claimed offset when it commits.
- A stated completion (`Upload-Complete: ?1`) whose body ends cleanly short of
  the known length answers `400` `inconsistent-upload-length` and leaves the
  bytes resumable, stating the durable `Upload-Offset` so the client resumes
  without a probe; tus still infers completion.
- A tus `HEAD` no longer reports `offset == length` after a failed completion
  heal, which stopped the client with the object unpublished: a failed publish
  answers its own status (5xx or `423`, bodiless on `HEAD`), `offset == length`
  is reported only once the store says complete, and a creation whose heal
  fails carries the resource's `Location`.
- A cancel discards the upload even when the state read fails, so an
  unreadable upload, or one whose multipart upload is gone, can be deleted.
- The pre-append state read and the completion take a derived signal, so the
  grace window can fire on them.
- The ceiling rejection's `durableOffset` is rendered by both dialects.
- S3: abort keeps the state when the sidecar read fails; the sweep reclaims
  orphan multipart uploads under `multipartSweepPrefix` (paging
  `ListMultipartUploads`); a newer holder's tail is never deleted, and a stale
  caller gets `UploadOffsetConflictError` at the tail; a known length grows the
  part size so it fits 10,000 parts, and the size is persisted at
  `createUpload`, so every process cuts the same ranges (a record from before
  that falls back to `minPartSize`; 4.0.0 always cut at `minPartSize`);
  entity tags are compared without `W/`, quotes or case; a part that lands on
  a reaped upload raises `UploadNotFoundError`.
- S3 appends no longer rewrite the sidecar. Idleness comes from the newest part
  or tail, the tail is read beside `ListParts`, a deferred-length write is
  pinned to the ETag already held, and the sweep spares an upload whose newest
  part is younger than the cutoff. An append that does not complete costs
  `5 + N` requests: three for the orchestrator's state read (sidecar `GET`,
  `ListParts`, tail `GET`), `N` `UploadPart`, one conditional tail park, empty
  when nothing is left over, and one sidecar `GET` once the bytes are durable,
  which tests the completion seal, so an append working from a stale state read
  fails at the park's `If-Match` with `UploadOffsetConflictError` carrying the
  true offset. The store honours a handed-over snapshot once.
- S3 and R2 each attribute a lost publish by their own publication id: S3 by
  the object's metadata, R2 by its `customMetadata`.
- Every adapter's append cancels the request body on each refusal before
  reading it. GCS and Azure fail an append whose record read fails with anything but
  not-found. `gcsUploadStore` fails rather than read an object size it cannot
  parse as `0`, its not-found error keeps the underlying cause, and a corrupt
  upload record fails closed as `UploadNotFoundError`.
- R2: abort and sweep swallow only a multipart upload that is gone, and
  `createUpload` aborts the multipart upload when the manifest write fails.
- A multipart boundary outside the token alphabet is quoted;
  `parseAcceptEncoding` reads `x-gzip` as `gzip` (RFC 9110 Section 8.4.1.3); a
  multi-range request that coalesces to one range is a plain `206`; custom
  metadata carrying `size`, `mtime` or `hash` no longer rejects `HEAD`,
  conditional or `Range` requests.
- A declined `createSignedUrl` streams and is not reported.
- `ResumableWriteStore.createUpload` documents that the token must be opaque
  and unguessable, as `checkResumableWriteStore` now checks; the 4.0.0 text
  suggested encoding the key in it.
- The conformance check decodes percent-escape runs as UTF-8, leniently, so a
  malformed escape cannot hide an encoded key.
- The `checksums` option documents that the AWS SDK sends a CRC32 checksum by
  default while `requestChecksumCalculation` is `"WHEN_SUPPORTED"`; construct
  the client with `"WHEN_REQUIRED"` for a backend that rejects checksum
  parameters.

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
  engine reaches this case only when the claimed offset IS the durable offset
  and the request carries no content, so both answers concern the same request,
  a retry of a completion whose response the client never received. Breaking
  for a client that treated the `200` as confirmation on an older version; it
  now sees the status its own revision defines.
- **An append that CARRIES CONTENT to an already-complete upload is refused
  `400` on every version**, with the registered `inconsistent-upload-length`
  problem type where the revision defines one (interop 9), and `400`
  "inconsistent upload length" under tus. It was answered as an idempotent
  retry, which acknowledged a request whose content was never read and never
  stored. An upload's total is fixed at completion and the offset may never
  exceed it, so those bytes have nowhere to land, and only a request carrying
  none of them can be the retry of a completion that draft-12 Section 4.4.2
  permits a server to answer by replaying the final response. A declared
  `Content-Length` decides whether content is present; an append that declares
  no size falls back to whether a body arrived at all. Durable state is
  untouched by the refusal, so a client that re-probes still reads the
  completed upload. Breaking for a client that resent its final chunk at the
  END offset instead of at the offset that chunk began at; the correct retry
  claims the chunk's own offset and is answered by the conflict that carries
  the durable one.
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
