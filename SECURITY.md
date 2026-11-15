# Security Policy

Last reviewed: 2026-11-15.

## Supported versions

**The latest published release, and only that one.** A fix ships forward; there
are no backports to an earlier major or minor, so upgrading is the remedy for
every advisory this package issues.

Stating it plainly is the point. This is a small project, and a supported-branch
promise it could not keep would be worse than none: you would be waiting for a
patch that was never coming. If you pin a version, plan on moving off it when an
advisory names it, and read `docs/UPGRADING.md`, which exists so that a major is
a morning of work rather than a reason to stay exposed.

**Support period: security fixes are published until at least 2031-12-31.**
Until then every vulnerability reported against the latest release is fixed in
a new release, with a GitHub security advisory naming the affected range. The
date is reviewed with each major and only ever moves later; if the project is
ever wound down, the end date is announced here and in the README at least 12
months ahead. A superseded release stops receiving fixes the day its successor
is published, which is why the advisory names the range and the upgrade path.

Each published tarball carries a CycloneDX software bill of materials at
`dist/sbom.cdx.json`. The package has no runtime dependencies, so the bill
names the package itself.

## Reporting a vulnerability

Email **oss@nordvec.com** with the details. Please include:

- The affected module (`partial-content`, a store adapter, or a framework adapter)
- A minimal reproduction (a failing request/response pair is ideal)
- The impact you believe it has (header injection, cache poisoning, path traversal, byte-splicing, DoS)

You will receive an acknowledgement within 72 hours. Please do not open a
public issue for undisclosed vulnerabilities.

## Threat model (what this library defends against)

`partial-content` sits between attacker-controlled request headers and
storage-backend metadata. Defenses under test:

- **Header injection (CWE-113) and header-write crashes:** every
  metadata-derived or caller-per-request response header value (ETag,
  Last-Modified, Content-Type, digest, Cache-Control, and the signed-URL
  `Location`) is stripped of ALL bytes outside RFC 9110 field-value grammar
  -- not just CRLF, but every control byte that Node `writeHead`, undici
  `Headers`, and Workers reject by throwing, so a poisoned backend value can
  neither inject nor crash the process. ETag values are additionally held to
  `etagc` grammar (interior DQUOTE removed) so a backend hash can never emit
  a structurally-broken entity-tag. Content-Disposition filenames AND the
  disposition type are fully sanitized (controls, bidi overrides, path
  components; the type is coerced to `inline`/`attachment`).
- **Path traversal / null bytes:** the fs adapter resolves keys against a
  fixed root and rejects `..`, absolute paths (including Windows cross-drive
  `D:\...` keys), and `\0`. On Windows it also rejects reserved device names
  (`NUL`, `CON`, `COM1`, ...) and alternate-data-stream keys (`file::$DATA`),
  neither of which resolves to a file under the root.
- **Cache poisoning / byte splicing:** strong-validator enforcement for
  `If-Match` and `If-Range`, exact-match If-Range dates, pinned reads with
  one re-validation, and truthful Content-Range derived from the backend's
  actual response.
- **Range-amplification DoS (CWE-400):** multi-range requests are served as
  `multipart/byteranges`, but overlapping and adjacent ranges are coalesced
  first, and a request whose coalesced parts exceed `maxRanges` (default 8)
  degrades to a single full 200. A set that coalesces to one range, the whole
  representation included, is served as one `206`. Past `maxBackendReads`
  (default 8) the parts are cut from one buffered read of the covering span
  when it is under 256 KiB (a full `200` otherwise), so the backend reads one
  request can issue stay bounded.
  A client cannot force a large or redundant multipart response by sending
  many tiny or overlapping ranges. RFC 9110 Section 14.2 lets a server ignore
  a `Range` field and answer `200`, which is what makes the cap conformant, and
  Section 15.3.7.2 sanctions coalescing the parts it does serve. The
  multipart `Content-Length` is computed exactly, never chunked, so the
  response size is known and bounded up front.
- **MIME sniffing / encoding-sniffing XSS:** `X-Content-Type-Options: nosniff`
  on every success + error response (the `200`/`206`/`404`/`502`/`503` bodies
  and the bodyless `412`/`416` denials; `304`/`302` carry none), `charset=utf-8`
  enforcement on textual types, `text/html`
  deliberately absent from the built-in MIME map. Note that `svg` IS in the
  map (`image/svg+xml`) and SVG is active content: served `inline` from your
  own origin it can run same-origin script. The adapter therefore adds
  `Content-Security-Policy: sandbox` to SVG, HTML and XSLT-capable XML served
  `inline`, and composes it with a policy you add through `securityHeaders`
  (`<yours>, sandbox`), never replacing it. Serving such content as
  `attachment` (per-MIME `disposition` hook) removes the exposure entirely.
- **A 5.x upload store's bookkeeping reachable through the read path:** a
  location a partial-content 5.x upload store shared holds that store's
  in-flight bytes and the sidecars naming each upload's destination key, which
  commonly embeds a filename. `fsStore`, `s3Store`, `r2Store`, `gcsStore`,
  `azureStore` and `httpStore` refuse keys at or under a `reservedPrefix` with
  `ObjectNotFoundError` on `headObject`, `getObject`, and `createSignedUrl`.
  It defaults to the namespace the 5.x upload store for that backend used
  (`httpStore`, which cannot know which one sits behind its origin, defaults to
  both), so the refusal is what a consumer gets without asking;
  `reservedPrefix: ""` opts out of the prefix for a location no upload store ever shared;
  `s3Store`, `azureStore` and `httpStore` also refuse a key with an empty segment unless `keys: "verbatim"` is passed, and a dot segment under either policy.
  `httpStore`, which hands the raw key to a URL the consumer builds, also
  refuses under either policy a key that starts with `/` or `\`, with a special scheme such as `https:` or `file:`, or with a C0 control or a space at either end, fetches only an `http:` or `https:` URL from `url()` and never one carrying a user name or password (credentials go in `headers`), and looks for a dot segment and the reserved prefixes in the part of the key before any `?` or `#` as well, both as written and after one round of percent-decoding (an origin that decodes `.uploads%3Fx` and then cuts at the `?` reads `.uploads`). Dot segments and reserved prefixes are also looked for in Unicode normal form NFKC, where a fullwidth full stop is a dot and a fullwidth solidus or reverse solidus a separator. A key that begins with `?` or `#`, or has a segment that does (`#1 Invoice.pdf`, `inbox/#1 report.pdf`), is an ordinary name and is served when `url()` encodes it.
  Every store that builds a URL or a request path from the key (`s3Store`, `r2Store`, `gcsStore`, `azureStore`, `httpStore`) answers `ObjectNotFoundError` for a key longer than its backend can hold before reading it further: 1,024 UTF-8 bytes, 4,096 on `azureStore` (whose limit is 1,024 characters), `maxKeyBytes` on `httpStore` (default 1,024). Every reading of a key is linear in its length, so the cap bounds the guard's cost per call.
  A key holding `?`, `#`, `\`, a tab, a CR or an LF, which a URL parser rewrites or cuts the path at, is judged on the parsed URL and is fetched only when that URL's path, percent-decoded, holds the key (`encodeKeyPath(key)` puts it there). Every other URL answers `404` for such a key, including one that carries the key in a query value and one from a builder that maps the key to another name (a lookup, a hash), since a URL whose path does not carry the key shows nothing about the object it names. `httpStore` does not find a key with a lone surrogate, which a URL parser replaces, and a key the builder cannot turn into a URL at all is not found.
  The fs guard is applied to the path the key resolves to, with case and
  normal form folded on every platform (both belong to the volume, not the
  runtime) and a generated short-name alias refused within the prefix's own
  depth, so mixed separators, a different case or normal form, an alias and
  dot segments cannot reach the reserved directory by another spelling. The
  http guard is best effort: it tests the spellings a URL parser, a
  percent-decoder, a case or compatibility folding volume and a trailing-dot
  or trailing-space stripping volume can resolve the key to. Each well-formed
  percent-escape is decoded on its own, so a malformed escape elsewhere in the
  key hides none of them. An origin that
  maps URLs onto a filesystem should deny the reserved directory itself;
  the guard does not replace that.
- **Identifiers in error sinks (log data minimization):** `auditKey`
  substitutes an opaque id for the filename-bearing storage key in every event
  and error context. The error handed to `onError` beside that context is
  then a `ProjectedError`, whatever failed (the store, a policy callback, or
  your own `onServe`, `onTransfer` or `onTiming` hook): only `name`, `code`,
  `status`, `operation` and the `cause` chain projected the same way, with a
  `name` or `code` kept only when it is identifier-shaped. The message, the
  stack and every other property stay behind, because a key can sit in any of
  them in any spelling (a percent-encoded request path, a resolved filesystem
  path). Branch on those fields, not on the message. Without an `auditKey` the
  error arrives as it was thrown, except that `httpStore` never carries text it
  did not write (a presigned query string is a bearer credential, and some
  runtimes put the whole URL on the rejection): apart from the three contract
  errors, every error it throws, whether the cause is `url()`, `headers()`,
  `fetch`, a refused redirect or a body read, has a message of the store's own
  wording, whose only variable part is a number the store read (the origin's
  status code, a declared length). One that
  stands in for an error the store caught also has that error's `name` and
  `code` when they are well-formed, and its `ProjectedError` as the `cause`.
  A transport failure (`fetch`, a body read) also keeps a `status` (an integer
  100 to 599) and a numeric `retryAfterSeconds`; a failure of `url()` or
  `headers()` keeps neither, and a `name` the handler classifies by
  (`NotFound`, `ObjectNotFoundError`, `ObjectChangedError`,
  `StoreUnavailableError`) is replaced by `Error`, so a callback's failure is
  served as `502`, never as a miss or a throttle. A callback that means one of
  those throws the class itself (`ObjectNotFoundError`, or
  `StoreUnavailableError` with its `retryAfterSeconds`); a
  refusal the store decides itself (a redirect, an origin status, a response
  it cannot account for) has no `cause`. `url()` is called once per store call, so the URL that was fetched
  is the only one built.
- **Precompressed variants are sibling keys the deployer controls:** with
  `precompressed` on, the handler serves `<key>.br`, `<key>.zst` or `<key>.gz`
  for a request it was told to serve as `<key>`, so the authorization you check
  for `<key>` covers every sibling. A party who can write such a sibling next
  to a served key (user-named uploads under a shared prefix) replaces what every
  client that accepts that coding receives. Enable the option only for a
  namespace only you write. A variant is served only while the identity object
  exists and is not newer than the variant, so deleting the identity (GDPR
  Art. 17 erasure) stops its variants being served, and a variant that predates
  a replaced identity is skipped.
- **Parser robustness:** the range/Content-Range/disposition parsers are
  covered by seeded randomized invariant tests (never throw; bounds always
  valid; output always header-safe).
- **Transparent-compression corruption:** the http adapter requests
  `Accept-Encoding: identity` and refuses (fails loudly) any response that
  still carries a non-identity `Content-Encoding`, so a decompressed body can
  never be served under compressed-size headers. The runtime that decodes a
  body also controls whether the header survives, so the cross-runtime smoke
  check drives a compressing loopback origin through each runtime's own
  `fetch` (Node, Deno, Bun; the Workers runtime is not exercised).
- **Conditional-date strictness:** client-supplied `If-Modified-Since`,
  `If-Unmodified-Since`, and `If-Range` dates are honored only in the three
  RFC 9110 HTTP-date formats; anything else (including ISO 8601) is ignored,
  as the spec mandates.

## Server-side request forgery (httpStore)

`partial-content/http` fetches whatever your `url(key)` returns; the origin
is part of YOUR trust boundary:

- **Build the URL with `encodeKeyPath(key)`.** The store refuses the keys a
  URL parser would resolve somewhere else (dot segments, a leading `/`, a
  scheme), and a key holding `?`, `#`, `\`, a tab or a line break is fetched
  only when the built URL's decoded path holds it; an interpolated
  `report?v=2.pdf` would otherwise fetch `report`. A builder that puts the key
  in a query value, or maps it to another name (a lookup, a hash), answers `404`
  for such a key and serves every other key it maps; what it maps a key to
  is its own to validate. A key is the object's name, never URL text: a
  builder that interpolates it unencoded fetches `%70rivate/x` as
  `private/x`, so a consumer that receives keys from a request path decodes
  them first and authorizes the decoded key.
  The injected `fetch` receives the URL as a string.
- **Redirects are refused by default** (`redirect: "error"`). A serving layer
  whose `url()` may carry untrusted keys must not let a compromised or
  misconfigured origin bounce the store to internal endpoints such as cloud
  metadata IPs, so a 3xx fails the read unless you opt in. Object-storage
  origins answer GET/HEAD with a direct 200, so the default costs nothing
  there. The store never hands a redirect to the runtime: it sends every
  request with `redirect: "manual"`, which every supported runtime accepts,
  and reads the 3xx itself.
- **`redirect: "follow"` follows inside the store.** Each hop goes through
  your `fetch`, so a validating `fetch` sees every URL that is requested. At
  most 10 hops are followed, only to `http:` or `https:`, never from `https:`
  to `http:`, and a hop to another origin carries none of your `headers`
  (credentials included), only the store's own `Accept-Encoding`, `Range` and
  `If-Match`. A hop may name any host, so a deployment that promises where
  its bytes are fetched from (a data-residency commitment) keeps the default,
  or refuses other hosts in the injected `fetch`.
- **`Retry-After` from the origin is bounded.** Only delay-seconds or an
  RFC 9110 HTTP-date is read, and the value relayed to the client is capped at
  one day.
- **Network-level SSRF defenses are deliberately not built in** (DNS pinning
  and IP allowlists are deployment-specific). Supply them via the `fetch`
  option, which every request goes through.

Out of scope: authentication/authorization (gate access before calling the
handler) and rate limiting (deploy-level concern).

## Standards mapping

The library surface against common audit requirements (SOC 2 Type II, ISO 27001, EU regulatory frameworks). Authentication, authorization and per-tenant quotas are the caller's responsibility: the serving handlers assume the request was already authorized.

| Requirement | Standard | Feature |
|---|---|---|
| Integrity verification | RFC 9530, GDPR Art. 32 (integrity of processing) | `Repr-Digest` (SHA-256) on 200/206 responses whenever the backend supplies a representation digest (S3 checksummed uploads, `digest` in metadata, `gcsStore` `digestMetadataKey`) |
| Content integrity | RFC 9530 Section 2 | `Content-Digest` on 200 (content = full representation) |
| Digest negotiation | RFC 9530 Section 4 | `Want-Repr-Digest` / `Want-Content-Digest` parsing |
| Audit trail | SOC 2 CC7.2, ISO 27001 A.8.15 | `onServe` callback with structured audit events (bytes granted); feeds the monitoring/detection layer DORA Art. 10 and EU AI Act Art. 12 ask for once wired to your alerting stack |
| Log data minimization | ISO 27001 A.8.15, OWASP ASVS (no PII in logs) | `auditKey` substitutes an opaque id for the filename-bearing storage key in every hook event, and hands `onError` an allow-listed `ProjectedError` (`name`, `code`, `status`, `operation`, `cause`) in place of the raw error, so the key never reaches the sink |
| Egress accounting / abandonment | operational | `onTransfer` callback with true bytes transferred and a `completed` flag; a body that ends short of, or runs past, the committed `Content-Length` errors the response instead of passing as complete |
| Encoding-sniffing XSS prevention | OWASP | `charset=utf-8` enforcement on textual MIME types |
| MIME-sniffing prevention | OWASP | `X-Content-Type-Options: nosniff` on every success and error response (`200`/`206`, the `404`/`502`/`503` bodies, and the bodyless `412`/`416` denials); `304`/`302` carry none |
| Header injection prevention | OWASP, CWE-113 | CRLF stripping in ETag, Last-Modified, filename |
| Content-Disposition hardening | RFC 6266, RFC 8187 | Bidi override stripping, path traversal prevention |
| Conditional request compliance | RFC 9110 Section 13 | Full precondition evaluation chain (412, 304, 416) |
| Retryable backend failures | RFC 9110 Sections 15.6.4 and 10.2.3 | Transient store throttling/overload maps to `503 Service Unavailable` + `Retry-After` (`StoreUnavailableError`), distinct from `502` for malformed upstream responses |
| OCC for writes | RFC 9110 Sections 13.1.1, 13.1.2 | `evaluateConditionalWrite` (If-Match, If-None-Match) |
| Range request compliance | RFC 9110 Section 14 | Single- and multi-range (`multipart/byteranges`) serving with TOCTOU guards and range-amplification defense |
| Cross-origin resource policy | CORP | `Cross-Origin-Resource-Policy` header support |
| Performance observability | W3C Server-Timing | `Server-Timing` metrics with `onTiming` callback |
| Cache control | RFC 9111 / RFC 5861 | Verbatim `Cache-Control` passthrough (`s-maxage`, `must-revalidate`, `stale-while-revalidate`, `stale-if-error`); auto-`immutable` for content-addressed keys |
