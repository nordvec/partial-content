# Security Policy

Last reviewed: 2026-10-27.

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
  own origin it can run same-origin script. For untrusted uploads, serve SVG
  as `attachment` (per-MIME `disposition` hook) or add a sandboxing CSP via
  `securityHeaders`.
- **Unpublished uploads reachable through the read path:** a read store and an
  upload store are routinely pointed at one root or bucket, which is what makes
  a completed upload servable without copying it. That also places the upload
  store's bookkeeping inside the read store's namespace: the in-flight bytes of
  an upload nobody has published, and the sidecar naming the key it is destined
  for, which commonly embeds a filename. An upload token is the only handle
  meant to reach that namespace and a read handler holds none, so `fsStore`,
  `s3Store`, `r2Store`, `gcsStore`, `azureStore` and `httpStore` refuse keys at
  or under a `reservedPrefix` with `ObjectNotFoundError` on `headObject`,
  `getObject`, and `createSignedUrl`. It defaults to the sibling upload store's
  prefix (`httpStore`, which cannot know which store sits behind its origin,
  defaults to every one of them), so the refusal is what a consumer gets without
  asking; `reservedPrefix: ""` opts out for a location no upload store shares.
  The fs guard is applied to the path the key resolves to, with case and
  normal form folded on every platform (both belong to the volume, not the
  runtime) and a generated short-name alias refused within the prefix's own
  depth, so mixed separators, a different case or normal form, an alias and
  dot segments cannot reach the reserved directory by another spelling. The
  http guard decides on every spelling an origin can resolve the key to,
  since a key there becomes a URL path that is percent-decoded and has its
  dot segments resolved before it names anything.
- **Identifiers in error sinks (log data minimization):** `auditKey`
  substitutes an opaque id for the upload token and the filename-bearing
  storage key in every event and error context, and the error handed to
  `onError` beside that context is scrubbed of both: message, stack, every own
  string property (an errno `path`, a store error's `key`), the entries of
  arrays and plain objects it holds (where a backend client keeps the failing
  request) and the `cause` chain, on the read path, both upload dialects, the
  upload stores' own state and cancel seams, and a throwing resumption hook.
  Both spellings of a key are searched, since a filesystem adapter resolves
  the forward-slash spelling a consumer writes through the platform path
  module first. `redactErrorText` is exported for a custom store's own sink.
- **A stolen upload lock cannot rewrite what the new holder made durable:**
  the lock serializes writers but expires, and a body can stream for longer
  than it lives. Every built-in upload store's bookkeeping write is pinned to
  the version it read (the filesystem record, which no backend versions, is
  merged against the copy on disk; the in-memory store holds one record object
  that every caller reads and mutates, so it has no snapshot to write back),
  with the terminal flags merged one-way, so
  a stale holder cannot resurrect an invalidated or reaped upload; a read the
  merge cannot make fails the write rather than falling back to the caller's
  pre-body snapshot. The data writes that can collide are fenced (the S3
  parked remainder lands only where no tail exists and is counted only at the
  offset it was accepted for, a GCS chunk write is conditional on the object's
  absence, an Azure stage is refused for an index the record already counts,
  and the filesystem append tests the lease signal on both sides of every read
  of the body). A completion is attributed to the object it published by a
  record written around the commit, never by whatever object sits at the key,
  and it publishes only what it can still prove is whole: the GCS compose
  re-reads the record its chunk listing raced, and the S3 commit is held to
  the length the upload declared. The GCS reclaim deletes the record that
  names the objects it is reclaiming only on the version it read before
  listing them, so a chunk that landed in between is reclaimed rather than
  orphaned. The
  conformance harness holds a custom store to the stale-write and
  reaped-resource rules.
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
