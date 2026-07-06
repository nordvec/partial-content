# Security Policy

## Supported versions

The latest published minor release receives security fixes.

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
  first, and a request whose coalesced parts exceed `maxRanges` (default 50)
  or already cover the whole representation degrades to a single full 200.
  A client cannot force a large or redundant multipart response by sending
  many tiny or overlapping ranges (the mitigation in Go `net/http.ServeContent`
  and nginx `max_ranges`). The multipart `Content-Length` is computed exactly,
  never chunked, so the response size is known and bounded up front.
- **MIME sniffing / encoding-sniffing XSS:** `X-Content-Type-Options: nosniff`
  on every success + error response (the `200`/`206`/`404`/`502`/`503` bodies
  and the bodyless `412`/`416` denials; `304`/`302` carry none), `charset=utf-8`
  enforcement on textual types, `text/html`
  deliberately absent from the built-in MIME map. Note that `svg` IS in the
  map (`image/svg+xml`) and SVG is active content: served `inline` from your
  own origin it can run same-origin script. For untrusted uploads, serve SVG
  as `attachment` (per-MIME `disposition` hook) or add a sandboxing CSP via
  `securityHeaders`.
- **Parser robustness:** the range/Content-Range/disposition parsers are
  covered by seeded randomized invariant tests (never throw; bounds always
  valid; output always header-safe).
- **Transparent-compression corruption:** the http adapter requests
  `Accept-Encoding: identity` and refuses (fails loudly) any response that
  still carries a non-identity `Content-Encoding`, so a decompressed body can
  never be served under compressed-size headers.
- **Conditional-date strictness:** client-supplied `If-Modified-Since`,
  `If-Unmodified-Since`, and `If-Range` dates are honored only in the three
  RFC 9110 HTTP-date formats; anything else (including ISO 8601) is ignored,
  as the spec mandates.

## Server-side request forgery (httpStore)

`partial-content/http` fetches whatever your `url(key)` returns; the origin
is part of YOUR trust boundary:

- **Never interpolate untrusted input into `url()` unencoded.** A key like
  `../other-bucket/secret` changes the fetched path. Encode path segments or
  validate keys before they reach the store.
- **Redirects error by default** (`redirect: "error"`). A serving layer whose
  `url()` may carry untrusted keys must not let a compromised or misconfigured
  origin bounce the store to internal endpoints such as cloud metadata IPs, so
  a 3xx is refused unless you opt in. Object-storage origins answer GET/HEAD
  with a direct 200, so the default costs nothing there. Set `redirect: "follow"`
  for origins that legitimately redirect, and pair it with a validating `fetch`
  when keys are untrusted.
- **Network-level SSRF defenses are deliberately not built in** (DNS pinning
  and IP allowlists are deployment-specific). Supply them via the `fetch`
  option, which every request goes through.

Out of scope: authentication/authorization (gate access before calling the
handler) and rate limiting (deploy-level concern).
