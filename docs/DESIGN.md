# Design Notes

Implementation details, RFC deviations, and architecture decisions for `partial-content`.

## Scope

`partial-content` is the **protocol layer first**. The kernel decides *what* status and headers a file request deserves and never touches the bytes, the network, or a storage SDK; the optional subpath adapters (`/web`, `/node`, `/hono`, and the store adapters) layer the I/O on top for consumers who want the whole path handled.

**In scope**

- Range parsing and validation (single and multiple ranges)
- `multipart/byteranges` assembly with range coalescing + amplification defense
- The full conditional-request chain (412 → 304 → If-Range → 206/200)
- Write-side preconditions (If-Match / If-None-Match / If-Unmodified-Since)
- ETag derivation from storage metadata
- Security-hardened `Content-Disposition`

**Non-goals** (deliberately the caller's responsibility)

- **I/O.** No reads, writes, streaming, or network calls. You bring the bytes.
- **Authentication / authorization.** The library assumes the request was already deemed allowed. Gate access *before* calling it.
- **Caching policy.** It never emits `Cache-Control` on its own -- it only echoes a value you pass in `meta.cacheControl` (orchestrator) or `opts.cacheControl` (standalone builder). `Vary`, `Expires`, and `Date` are left to your runtime (see the [Response Header Matrix](#response-header-matrix)).
- **Precompressed variant negotiation (`.br` / `.gz` + `Content-Encoding`).**
  That is static-asset serving (sirv, CDN edge config), not object serving.
  Ranges apply to the *encoded* representation and each encoding needs its own
  ETag -- a correctness minefield with no payoff for documents and media,
  which are already compressed formats. Serve pre-compressed web assets from
  a CDN; serve documents through this library.
- **Live / growing representations.** Range serving assumes a representation
  whose length is fixed for the duration of a response (RFC 9110's model).
  Indeterminate-length content (live logs, in-progress transcodes, RFC 8673
  random access to live streams) is out of scope: the guards here treat a
  length change mid-read as corruption, which for stored objects it is.
- **Storage implementation.** `ObjectStore` is an interface; adapters are yours (or a thin wrapper over an SDK). Built-in adapters cover S3-compatible, R2, GCS, Azure, the local filesystem, any range-capable HTTP origin, and memory.

### When you need a protocol layer (and when you don't)

You need this when you **proxy bytes through your own origin** — because each request must be authorized or audited, or because the browser talks to your origin rather than to storage (`<video>`/`<audio>` `Range` requests, PDF.js progressive loading, iframe CORS).

If you can instead hand the client a **short-lived signed URL** and let object storage or a CDN serve the bytes directly, the backend already speaks this protocol for you — and you may not need this library at all. Reach for `partial-content` precisely when that redirect *isn't* an option.

## Evaluation Order

The [RFC 9110 Section 13.2.2](https://www.rfc-editor.org/rfc/rfc9110#section-13.2.2) evaluation chain:

```
1. isPreconditionFailure()     ->  412 Precondition Failed
2. isConditionalFresh()        ->  304 Not Modified
3. isRangeFresh()              ->  Should we honor the Range?
4. parseRangeHeader()          ->  Parse and validate the Range
5. buildRangeResponseHeaders() or build416Headers()
```

`evaluateConditionalRequest()` implements this entire chain in a single call.

## Design Decisions

**Multi-range is served as `multipart/byteranges`, with amplification defense.**
A `Range` with several parts (`bytes=0-100,200-300`) is served as a
`multipart/byteranges` 206. The single-range case keeps its own fast path
(`parseRangeHeader` + the single-round-trip Path B); multi-range takes a
separate path that never touches the hot single-seek code. Two things make this
safe rather than a DoS vector, informed by Go `net/http.ServeContent` and nginx:

- **Coalescing.** Overlapping, adjacent, and near-adjacent ranges are merged
  before serving: gaps smaller than the ~80-byte per-part framing overhead are
  bridged, which RFC 9110 Section 15.3.7.2 sanctions and which strictly shrinks
  the response. A client cannot force redundant bytes or framing by requesting
  the same region many times, and a set that would tile the whole file merges
  into a single plain 206 (no framing at all) -- which is why no separate
  "covers the whole file" check exists.
- **Amplification cap.** If the coalesced set still exceeds `maxRanges` distinct
  parts (default 50), the ranges are ignored and the full 200 is served.
  Cost model: each part is one ranged `getObject`, so a request can drive up
  to `maxRanges` backend reads -- lower it (even to 1) when the backend bills
  per request.
- **Request order.** Parts are emitted in the order their range-specs appeared
  in the request (a coalesced part inherits its earliest contributor's
  position), honoring the Section 15.3.7.2 SHOULD.

The `Content-Length` is computed exactly from the framing and range spans (never
chunked). The first part is fetched eagerly so a pinned-read `ObjectChangedError`
surfaces before headers commit (same one-shot re-validation single-range gets);
the rest stream lazily, each pinned to the same representation. This relies on
each store serving exactly the requested (size-clamped) span per range, which
every bundled adapter does.

**Weak ETag matching for `If-None-Match`.** `If-None-Match` uses weak comparison
per RFC 9110 Section 8.8.3.2 Table 3 (the correct algorithm for this header).
We strip the `W/` prefix from both sides before comparing.

**Strong comparison for `If-Match`.** `If-Match` requires strong comparison per
RFC 9110 Section 8.8.3.2 Table 3. We enforce this strictly: if the server's ETag
is weak-prefixed (`W/`), the precondition always fails (412). This means
`evaluateConditionalWrite` cannot confirm a match for resources with only
weak validators (size+mtime), which is correct -- you cannot guarantee
byte equality with a weak validator, so OCC via `If-Match` requires a
content-hash ETag.

**If-Range requires strong validators.** RFC 7233 Section 3.2 requires If-Range\r
to use strong comparison (same as `If-Match`). If-Range with a weak validator is\r
actively dangerous: it could splice partial bytes from one representation onto a\r
cached body from another. When either the client's `If-Range` or the server's\r
ETag is weak-prefixed, we ignore the range and serve a full 200.

**If-Range date comparison is exact match, plus the strong-validator rule.**
RFC 9110 Section 13.1.5 requires exact match for If-Range HTTP-date comparison
(unlike If-Unmodified-Since which uses `<=`), and Go stdlib enforces the same
equality. The failure modes are asymmetric: a strict mismatch costs at worst
one full 200 re-download, while a lenient `<=` would honor the range precisely
when the dates differ -- the one case where byte identity cannot be
guaranteed -- splicing mismatched bytes onto the client's cached body. Both
sides are floored to whole seconds first, and a well-behaved client echoes our
emitted IMF-fixdate verbatim, so exact match never misfires for correct
revalidation. Step 1 of the 13.1.5 evaluation is enforced too: a Last-Modified
whose second has not yet fully elapsed is not a strong validator (Section
8.8.2.2 -- the representation could have been written twice within that
second), so the range is ignored until the second passes. Go stdlib skips this
step; the cost of honoring it is at worst one full 200 for a file modified
under a second ago.

**Case-insensitive range units.** Per RFC 9110 Section 14.1, range units are
compared case-insensitively. `Bytes=0-499` and `BYTES=0-499` are both valid.

## Parsing Details

**Quote-aware ETag parsing.** Commas inside quoted ETag values are valid per
RFC 7232 Section 2.3. Our parser correctly handles `"ver,1", "ver,2"` as
two ETags, not four fragments. The parser is a single-pass state machine that
tracks quote boundaries rather than splitting on commas.

**Obsolete date format acceptance.** Per RFC 9110 Section 5.6.7, we accept all
three HTTP-date formats in conditional request headers: IMF-fixdate
(`Sun, 06 Nov 1994 08:49:37 GMT`), obsolete RFC 850 format
(`Sunday, 06-Nov-94 08:49:37 GMT`), and ANSI C asctime format
(`Sun Nov  6 08:49:37 1994`, interpreted as UTC per the RFC; naive
`Date.parse` would read it as server-local time). These three are also the
ONLY formats honored in client conditional headers: Sections 13.1.3/13.1.4
require ignoring `If-Modified-Since`/`If-Unmodified-Since` values that are
not valid HTTP-dates, so ISO 8601 and other `Date.parse`-able strings are
rejected on the wire. Backend metadata (`lastModified` from an adapter) stays
lenient -- that is our own input -- and output is always normalized to
IMF-fixdate.

**Sub-second timestamp handling.** Storage backends (S3, R2, Postgres) return
timestamps with millisecond precision (e.g., `2025-06-28T12:00:00.500Z`). HTTP
dates are floored to whole seconds in `Last-Modified`. All conditional request
comparisons (`If-Modified-Since`, `If-Unmodified-Since`, `If-Range`) also floor
both sides to prevent permanent false-stale results from sub-second skew.

The flooring has a FALSE-FRESH twin that date validators cannot escape: two
same-length writes within one second are indistinguishable to a
second-resolution validator, so a revalidating client can receive 304 for
changed bytes. The fs store closes this window by deriving its weak ETag
from the NANOSECOND mtime (`stat({ bigint: true })`); filesystems with
coarse timestamps (FAT: 2 s) retain a residual window, and content-hash
ETags (S3 digests) never had one. With the fs hot-object cache enabled, a
cached validator can additionally lag an overwrite by up to `ttlMs`, so the
stale-304 exposure with the cache on is bounded by `ttlMs`, not by
timestamp resolution -- size the TTL against acceptable staleness for
mutable keys, or reserve the cache for immutable/content-addressed ones.

**Orchestrator date pre-computation.** `evaluateConditionalRequest` pre-computes
the `toHttpDate()` result once and passes the normalized IMF-fixdate string to all
downstream calls (`isPreconditionFailure`, `isConditionalFresh`, `isRangeFresh`,
and the final header builder). Without this, the orchestrator would call
`Date.parse` + `toUTCString` up to 4 times on the same string.

**Zero-length file handling.** When `totalSize` is 0, `parseRangeHeader` returns
`null` (treat as non-range request, serve 200 with empty body). This includes
`bytes=0-0` on a zero-length file. Strictly, RFC 9110 Section 14.1.2 would have
this be unsatisfiable (416), but an empty 200 is the pragmatic response since
there are zero bytes to serve either way.

**Request `Cache-Control` is ignored during conditional evaluation.** Matching
Go stdlib and nginx: request cache directives (RFC 9111 Section 5.2.1) address
caches, not origin conditional evaluation, and a 304 IS the end-to-end
revalidation the client asked for. This matters in practice: spec-compliant
fetch clients (undici, browsers) automatically append `Cache-Control: no-cache`
to any request that carries manually-set conditional headers, so honoring the
directive would make 304 unreachable for every programmatic revalidation
(verified live against Node/undici). Hard reloads need no special case -- they
omit the validators entirely, which already evaluates as "not conditional."
Some legacy middleware treats request `no-cache` as "force 200"; that behavior
silently disables revalidation for exactly the clients that follow the fetch
spec, so we do not reproduce it.

**HEAD ignores `Range` and `If-Range`.** RFC 9110 Section 14.2 defines range
handling for GET only, so a HEAD never yields 206 or 416; conditionals
(304/412) still apply to HEAD exactly as to GET per Section 13.1. The kernel
is method-aware: pass `{ method: "HEAD" }` as the third argument to
`evaluateConditionalRequest` (the bundled adapters do) and it also suppresses
`Content-Digest`, whose representation value would be false over a HEAD's
empty message content.

**Oversized range values are capped, not rejected.** Range positions beyond
`Number.MAX_SAFE_INTEGER` (attackers probing 64-bit parsers) are clamped to
the representation bounds instead of erroring; the response is still a
correct 206/200 for the actual object.

**Suffix ranges larger than the file serve the full body as 206.** RFC 9110
Section 14.1.2 resolves `bytes=-N` where N >= size to the entire
representation; we emit it as a 206 with full bounds rather than degrading
to 200, matching Go stdlib.

**A `Range` on a zero-length representation serves 200, not 416.** A strict
reading of RFC 9110 Section 14.1.2 could call any range on a 0-byte object
unsatisfiable (416), but Go `net/http.ServeContent` and nginx both serve the
empty 200, and returning 416 for `bytes=0-` on an empty file breaks real
clients. We match the battle-tested behavior: the range parser treats a
zero-size representation as "not a range request" and serves the empty 200.

**`Want-Repr-Digest` negotiation is parsed for `sha-256`, not as a full
Structured Fields document.** RFC 9530 digest negotiation is read with a
purpose-built parser that finds `sha-256` and its preference weight (ignoring
Structured Fields parameters, honoring RFC 8941's last-occurrence-wins rule
for duplicate keys, and treating a bare `sha-256` key as wanted); it is not a
general RFC 8941 parser, because the only algorithm we emit is `sha-256`. Any
other `Want-*` member is ignored, which is the correct outcome (we cannot
honor an algorithm we do not produce). `Want-Repr-Digest` and
`Want-Content-Digest` are evaluated independently -- each expresses a
preference for its own response field -- via `clientWantsDigest()` and
`clientWantsContentDigest()`.

**Unknown totals in backend `Content-Range` are passed through as `*`.**
When an origin answers `bytes a-b/*` (RFC 7233 Section 4.2 -- a streaming
origin that does not know its full length), the adapter leaves
`ObjectStream.totalSize` `undefined` and the served 206 repeats `bytes a-b/*`
honestly. Nothing is fabricated: the 206's `Content-Length` is the range span
(known), and the served-range guard trusts the authoritative backend's ordered
bounds since there is no EOF to check against. Object stores (S3, R2, GCS,
Azure) always report a concrete total, so this only ever engages for the `http`
adapter in front of a proxied streaming origin.

## Response Header Matrix

This library generates the following response headers:

| Header | 200 | 206 | 304 | 412 | 416 |
|--------|-----|-----|-----|-----|-----|
| `Accept-Ranges` | yes | yes | - | - | yes |
| `Content-Length` | yes | yes | - | yes¹ | yes¹ |
| `Content-Range` | - | yes | - | - | yes |
| `Content-Type` | yes | yes | - | - | - |
| `ETag` | yes | yes | yes | opt³ | - |
| `Last-Modified` | yes | yes | yes⁶ | - | - |
| `Repr-Digest` | opt⁴ | opt⁴ | - | - | - |
| `Content-Digest` | opt⁵ | - | - | - | - |
| `Cache-Control` | opt² | opt² | opt² | - | - |

¹ `Content-Length: 0` on 412 and 416 for enterprise proxy compatibility.
HAProxy and Envoy require explicit Content-Length on bodyless responses
to avoid chunked-encoding timeouts.

² Included when the caller passes `cacheControl` to `build304Headers`,
`buildRangeResponseHeaders`, or `evaluateConditionalRequest`. This library
never generates cache directives on its own.

³ Included in 412 from `evaluateConditionalWrite` when `meta.etag` is available.
Returning the current ETag on a 412 lets OCC clients resync without a follow-up
GET. The standalone `build412Headers()` omits it (callers add it themselves).

⁴ RFC 9530 `Repr-Digest`. Emitted when `meta.digest` is the raw base64 of a
32-byte SHA-256; any other value is dropped rather than framed as a false
integrity assertion. Uses Structured Fields Dictionary syntax:
`sha-256=:<base64>:`. Covers the full representation (independent of
Content-Range or Content-Encoding), so it remains stable across range
requests. Source it from a backend field that IS a SHA-256 of the bytes: S3
`x-amz-checksum-sha256` (uploads with checksums enabled). GCS `x-goog-hash`
carries only `crc32c` and `md5` and cannot be used; store your own SHA-256 as
object metadata there.

⁵ RFC 9530 `Content-Digest`. Identical to `Repr-Digest` on full 200 GET
responses (content equals full representation). Omitted on 206 because a
range-slice hash would require streaming through crypto (violating the
zero-I/O kernel contract), on HEAD because the message transfers no content
(RFC 9530 Appendix B.2 computes a HEAD `Content-Digest` over empty content),
and when the client declined it via `Want-Content-Digest`.

⁶ Omitted on 304 whenever an `ETag` is emitted: RFC 9110 Section 15.4.5 has a
304 sender generate representation metadata beyond the listed fields only for
cache-update purposes and names `Last-Modified` as useful when there is no
ETag; one strong validator suffices and this matches Go stdlib. Of the
Section 15.4.5 MUST-generate list (`Content-Location`, `Date`, `ETag`,
`Vary`, `Cache-Control`, `Expires`): `ETag` and `Cache-Control` are the
library's job, `Date` is the server runtime's, and `Vary` /
`Content-Location` / `Expires` are the caller's -- the web adapter forwards
its `securityHeaders` output onto 304 responses precisely so a caller-set
`Vary` satisfies the MUST.

The following headers are **not** generated because they are the responsibility
of the HTTP runtime or application layer:

- **`Date`** - Set automatically by Bun, Node.js, Deno, Cloudflare Workers
- **`Vary`** - Application-specific (depends on content negotiation)
- **`Content-Location`** - Application-specific
- **`Expires`** - Use `Cache-Control` instead (per RFC 7234 Section 5.3)

RFC 9110 Section 15.3.7 requires `Date`, `Cache-Control`, `ETag`, `Expires`,
`Content-Location`, and `Vary` on 206 responses "if the field would have been
sent in a 200 (OK) response." This library handles ETag and Cache-Control;
the rest are either runtime-managed or application-specific.

## Content-Disposition Security

**Dual-parameter approach (RFC 6266 Section 4.3).** When a filename contains
non-ASCII characters, `buildContentDisposition` emits both `filename` (ASCII
fallback with lossy transliteration) and `filename*` (UTF-8 percent-encoded
original). Browsers that understand `filename*` MUST prefer it over `filename`.

Security sanitization:

- CRLF injection prevention (strips `\r`, `\n`, control characters)
- Path traversal protection (strips `../`, `..\\`, extracts basename)
- Bidi override stripping (prevents RLO filename spoofing attacks)
- C1 control characters, NBSP, line/paragraph separators stripped
- Surrogate pair safety (handles truncated emoji gracefully)
- RFC 2616 quoted-string escaping (backslash and double-quote)
- RFC 8187 `filename*` encoding for non-ASCII characters

## RFC 9530 Digest Fields (End-to-End Integrity)

`partial-content` ships first-class RFC 9530 (February 2024) support --
emission plus `Want-Repr-Digest` negotiation -- which none of the mainstream
JS file-serving libraries (`send`, `sirv`, the framework static middlewares)
offer. When a storage backend provides a SHA-256 hash of the full
representation, the kernel emits both `Repr-Digest` and `Content-Digest`
headers.

Key properties:

- **Repr-Digest** covers the *full representation*, not the transmitted bytes.
  This means the same digest value appears on both full (200) and partial (206)
  responses, allowing clients to verify integrity regardless of transfer strategy.
- **Content-Digest** is identical to `Repr-Digest` on full 200 GET responses
  (content equals the full representation). On 206 it is omitted because a
  range-slice hash would require streaming through crypto, violating the
  zero-I/O kernel contract; on HEAD it is omitted because the message content
  is empty (RFC 9530 Appendix B.2). This is correct per RFC 9530 Section 2.
- **Want-Repr-Digest / Want-Content-Digest** request header parsing (RFC 9530
  Section 4). The kernel respects client algorithm preferences: if the client
  only wants `sha-512`, we omit our `sha-256` digest rather than sending an
  unwanted algorithm. Weight 0 means explicitly unwanted, duplicate keys
  resolve last-wins (RFC 8941), and each Want-* field gates only its own
  response field. The negotiation is exported as `clientWantsDigest()` /
  `clientWantsContentDigest()` and applied identically by the kernel
  orchestrator and the web adapter (single-range AND multipart), so
  suppression works at every layer.
- Uses **Structured Fields Dictionary** syntax per RFC 8941: `sha-256=:<base64>:`
- **Not emitted** on 304 (no body), on 412 (precondition failure), or when the
  provided digest is not the raw base64 of a 32-byte SHA-256 (a malformed or
  wrong-algorithm value would be a false integrity assertion).
- The library **never computes** digests itself (zero dependencies, no crypto).
  It relies on the storage backend to provide the hash: S3 computes
  `x-amz-checksum-sha256` at upload time when checksums are enabled; on
  backends without a native SHA-256 (GCS exposes only crc32c/md5), store one
  as object metadata at upload.

Enterprise use case: SOC 2 / ISO 27001 compliance audits can verify that the
file delivered to the browser matches the file stored in object storage, using
only standard HTTP headers, with no application-layer checksums required.

## Atomic Reads (HEAD->GET Consistency)

**Plain-range fast path (no HEAD at all).** A range request carrying no
conditional headers and no `If-Range` needs nothing from a HEAD: on stores
declaring `authoritativeRange` (S3, Azure, R2, http -- their 206
bounds/total are parsed from the backend's actual `Content-Range` -- plus
fs and memory, whose served bounds, validators, and bytes come from one
open handle or one slice and are coherent by construction), the
orchestrator issues a single GET. `bytes=a-b` and `bytes=a-` qualify (an
open end travels through the adapters as the `OPEN_ENDED` sentinel and is
emitted in each backend's idiomatic open form -- `bytes=a-` on the wire, an
offset-only read for R2, offset-without-count for Azure -- never as a
literal 16-digit last-byte-pos); suffix, multi-range, and malformed specs
fall back to the validating HEAD path. Validators, bounds, and digest all come from
the GET response itself, so the fast path is inherently TOCTOU-atomic. If
the backend rejects the range natively (start beyond EOF) the request
falls back to the HEAD path, which produces the correct 416 with real
bounds. This halves round-trips on the hottest media paths (video seeking,
PDF.js chunked loading).

For everything else, evaluating conditionals requires metadata (HEAD)
before bytes (GET), which opens a race: the object can change between the
two calls. The web adapter closes it in layers:

1. **Pinned reads.** The GET carries the HEAD's raw ETag as
   `GetObjectOptions.ifMatch`, mapped to each backend's native conditional
   read: S3 `IfMatch`, R2 `onlyIf.etagMatches`, Azure `conditions.ifMatch`,
   GCS generation-pinned stream. Either the exact validated bytes stream,
   or the store throws `ObjectChangedError`.
   Stores whose version identifier is not the ETag also issue an opaque
   `ObjectMetadata.pin` token from `headObject`, which the orchestrator
   round-trips verbatim into `GetObjectOptions.pin`. GCS encodes its
   generation plus the size/validators in it, so a pinned `getObject`
   streams directly from that immutable generation without re-fetching
   metadata -- the HEAD->GET pair costs exactly one metadata round trip.
   Foreign or stale pins are ignored and the adapter revalidates from
   scratch. One narrow divergence: if a GCS pinned generation is *hard*
   deleted mid-flight (an overwrite with both Object Versioning and
   soft-delete off), `createReadStream` errors after the response headers
   commit, so the client sees a torn transfer rather than an
   `ObjectChangedError` + revalidation. Modern buckets default to
   soft-delete, which keeps the pinned generation readable and masks this;
   the outcome is a failed transfer the client retries, never spliced bytes.
2. **One re-validation.** On `ObjectChangedError` the adapter re-runs
   HEAD + evaluation once against the new state, so the client gets a
   coherent answer (a stale `If-Range` now correctly yields a full 200 of
   the new bytes). A second failure returns 502 -- the object is churning.
3. **Response-side guard** (for stores that ignore the pin): validators are
   taken from the GET response, 206 bounds come from the backend's actual
   `Content-Range`, an absent Content-Range degrades to 200, and an
   unparseable one fails loudly with 502.

The fs adapter needs no pin: it stats and streams from a single opened file
handle, and the Azure adapter's single `download()` call makes metadata and
body one response by construction. One caveat: with the opt-in fs cache
enabled, HEAD/conditional evaluation may serve a cached metadata snapshot
while a concurrent GET reads fresh from disk; every disk read writes its
metadata back to the cache so the views converge, and each individual
response remains internally coherent. The divergence is bounded by `ttlMs`
(see Sub-second timestamp handling above).

## Audit Hook (onServe)

The web adapter provides a structured `onServe` callback for compliance
logging. It fires on every response that grants access (200, 206, 304, and
302 signed-URL redirects) AND on protocol denials (412 failed precondition,
416 unsatisfiable range) -- a 412 is an optimistic-concurrency conflict,
exactly the event change-control audit trails need. `bytesServed` is the
GRANTED Content-Length, captured when headers commit (a disconnecting
client may receive fewer bytes); treat it as access volume, not transfer
confirmation. A throwing hook never affects the response: the failure is
routed to `onError` with `operation: "audit"`. Each event carries:

- `key`: Storage key served
- `method`: `GET` or `HEAD` (distinguishes a metadata probe from a byte transfer)
- `status`: HTTP status (200, 206, 302, 304, or a 412/416 denial)
- `mime`: MIME type
- `bytesServed`: Content-Length (0 for 302, 304, 412, 416, and HEAD)
- `rangeStart` / `rangeEnd`: Present only on 206
- `etag`: ETag of the served representation

302 redirects are audited because a signed URL grants the same file access as
a streamed body; omitting them would leave a hole in the access trail exactly
where the storage backend cannot stream ranges.

This satisfies SOC 2 CC7.2 (system operation monitoring) and ISO 27001 A.8.15
(logging) without coupling the library to any specific logging framework.

### Transfer completion (onTransfer)

`onServe` reports bytes *granted* at header-commit time; `onTransfer` reports
bytes *actually transferred* once the response body reaches its terminal
state. It fires once per 200/206 GET with `bytesExpected` (the granted
Content-Length), `bytesTransferred` (bytes read through the body), and
`completed` (`true` on a full drain, `false` when the client disconnected or
cancelled early). Use `bytesTransferred` for true egress billing and
`completed === false` for download-abandonment analytics -- the honest signals
`onServe` structurally cannot give, because it fires before a single byte
leaves the process.

The metering is opt-in and zero-cost when unset: the body is returned
untouched, so byte bodies keep the runtime's static-body fast path. When
`onTransfer` is set, the body is routed through a counting stream (byte bodies
are wrapped too, so a byte store and a streaming store report identically) --
a deliberate cost you pay only when measuring. Like `onServe`, a throwing
`onTransfer` cannot corrupt the transfer: it fires from inside the body's
stream machinery, and its error is routed to `onError` (`operation: "audit"`).

## Charset Enforcement

The web adapter enforces `charset=utf-8` on textual MIME types (`text/*`,
`application/json`, `application/xml`, `*+json`, `*+xml`,
`application/javascript`) by default. This prevents UTF-7 encoding-sniffing XSS
where legacy browsers auto-detect charset when none is declared, allowing
`+ADw-script+AD4-` to execute as JavaScript.

Controlled via `enforceCharset: false` for consumers who need raw MIME types.

## Shared Caches and 206 Responses

Two properties matter when a CDN or shared cache sits in front of a
range-serving origin (RFC 9111 Section 3.3-3.4):

- A cache may only **combine** stored 206 ranges (or a 206 with a stored 200)
  when the responses share the same STRONG validator. The fs store's weak
  `W/"size-mtime"` ETag can never satisfy that, so caches will store ranges
  but re-fetch rather than assemble them; content-hash ETags (S3 digests)
  enable full range reuse.
- Error responses here always carry `Cache-Control: no-store`, so a transient
  404/502/503 can never be heuristically cached into a persistent outage
  (RFC 9111 Section 4.2.2 makes 404s heuristically cacheable by default).

## Behind a CDN

Verified against vendor documentation (July 2026); CDN behavior diverges
sharply from a naive reading of RFC 9110/9111, in ways that change what this
library's output does at the edge.

- **Only CloudFront forwards client Range requests to the origin** (and
  caches the returned ranges, sometimes widening them). Cloudflare, Fastly's
  default readthrough cache, and Bunny all fetch the FULL object and slice
  ranges from their own cache: your origin sees plain GETs, and the edge
  synthesizes 206s. Multi-range `multipart/byteranges` responses therefore
  rarely reach clients through a CDN at all (CloudFront passes them only for
  ascending, non-overlapping viewer ranges; the slicing CDNs answer from
  their own cache). None of this requires changes at the origin -- direct
  clients and CloudFront still exercise the full protocol -- but do not
  expect edge traffic to hit the multipart path.
- **`Content-Length` is the edge's 206 permission slip.** Cloudflare returns
  206 for a range over cached content only when the origin response carried
  `Content-Length`; CloudFront returns the full object when the origin
  responds `Transfer-Encoding: chunked`. This library always computes an
  exact `Content-Length` -- but the RUNTIME can still discard it: Bun.serve
  sends `ReadableStream` bodies chunked (see Runtime Notes), which silently
  disables edge 206 slicing behind Cloudflare/CloudFront for stream bodies.
  Behind those CDNs, prefer byte-body stores/paths for range-hot content or
  front the route with a Node runtime.
- **Encoding negotiation is normalized at the edge.** Cloudflare rewrites
  the origin-bound `Accept-Encoding` to `gzip, br` by default (the visitor's
  real value is forwarded only with "Respect Strong ETags"), and honors an
  origin `Vary: Accept-Encoding` cache key only via the opt-in Cache Rules
  Vary feature (shipped 2026-07). CloudFront normalizes to exactly `br,gzip`
  or `identity`. Consequence: `.br`/`.gz` sibling variants negotiate fine
  through both, but **`.zst` variants are unreachable through either CDN's
  default path** -- zstd is edge-to-visitor only. Direct traffic and other
  proxies still negotiate zstd.
- **Cloudflare downgrades strong ETags to weak on any encoding mismatch**
  between what the origin served and what the visitor accepts, even with
  "Respect Strong ETags" enabled. A weak validator cannot authorize
  `If-Range`, so ranged RESUME of encoded variants through Cloudflare can
  silently degrade to full 200s. Not a correctness bug (the client re-fetches
  cleanly); a throughput caveat to know about.
- **RFC 5861 works at the edge where it is supported**: Fastly natively
  honors `stale-while-revalidate` and `stale-if-error` from
  `buildCacheControl()`.
- **pdf.js requires the identity coding** (it checks
  `Content-Encoding: identity`, `Accept-Ranges: bytes`, and an integer
  `Content-Length` before enabling progressive range loading, and cannot ask
  for identity itself -- `Accept-Encoding` is a forbidden Fetch header).
  This library never negotiates a compressed variant for
  `application/pdf` (`isCompressibleMime` excludes it by design), so pdf.js
  range loading is unaffected by the `precompressed` option.

## Cross-Origin Readers (CORS)

Only seven response headers are CORS-safelisted (`Cache-Control`,
`Content-Language`, `Content-Length`, `Content-Type`, `Expires`,
`Last-Modified`, `Pragma`). Everything else this library's protocol depends
on is INVISIBLE to cross-origin JavaScript until exposed. pdf.js silently
falls back to full-file download when it cannot read `Accept-Ranges` and
`Content-Length` cross-origin. For cross-origin range/conditional/digest
workflows, emit:

```
Access-Control-Expose-Headers: Accept-Ranges, Content-Range, Content-Encoding,
  ETag, Content-Disposition, Repr-Digest, Content-Digest, Server-Timing
```

(the serve adapters emit exactly this list with
`accessControlExposeHeaders: true`; trim via a custom string if the reader
consumes less. `Server-Timing` additionally requires `Timing-Allow-Origin`,
the `timingAllowOrigin` option).

## Precompressed Variants and Content-Encoding

Encoding negotiation (`precompressed`) selects a stored sibling object; it
never compresses at serve time. That boundary is what keeps the rest of the
protocol honest:

- **The variant is the representation.** RFC 9110 makes `Content-Encoding`
  representation metadata, so once `report.json.br` is selected, ITS ETag
  answers `If-None-Match`/`If-Range`, ITS length bounds `Range`, and
  `Content-Range` describes the encoded bytes. A resumed `.br` download is
  byte-correct where naive precompressed servers (which reuse the identity
  file's size or ETag) corrupt caches.
- **`Vary: Accept-Encoding` on every success response for the type** --
  variant hits, identity fallbacks, 304s, and HEAD -- so shared caches key
  compressible objects on the request coding. A caller-supplied `Vary`
  (via `securityHeaders`) is extended, never clobbered.
- **Multi-range requests serve identity.** `multipart/byteranges` over an
  encoded representation has no interoperable framing story, so comma
  ranges skip negotiation entirely rather than emit something undefined.
- **`no-transform` guidance.** If a proxy or CDN re-compresses a response,
  every byte-exact promise (ranges, `Repr-Digest`, strong validators) breaks
  silently. `buildCacheControl()` therefore defaults `no-transform` on; if
  you hand-write `cacheControl` strings for digest- or range-heavy routes,
  add it yourself.

## Runtime Notes

Behaviors owned by the HTTP runtime, observable when serving through
`Response` objects; none can be changed from library code:

- **Bun.serve chunks stream bodies.** A `ReadableStream` body is sent with
  `Transfer-Encoding: chunked` even when a `Content-Length` header was set;
  byte bodies (`Uint8Array`, small fs reads, memory store) keep the exact
  precomputed length. Correctness is unaffected (framing is the runtime's
  job); byte accounting on the wire differs from Node, where the pump writes
  under the declared `Content-Length`. Edge interaction: chunked origin
  responses disable Cloudflare's 206 slicing and CloudFront's range
  passthrough (see Behind a CDN), so range-hot content served from Bun
  behind those CDNs should come from byte-body paths.
- **Bun adds `Content-Length: 0` to bodyless 304s.** RFC 9110 Section 8.6
  allows a 304 `Content-Length` only when it equals the 200's length; the
  header is injected by the runtime after the handler returns.
- **`Date` headers** are added by Node, Bun, Deno, and Workers automatically;
  the library never generates them.
