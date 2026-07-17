# Benchmarks

Two suites: kernel micro-benchmarks (library overhead only) and end-to-end HTTP serving against `send` and `sirv`. Reproduce with `bun bench.ts` and `npm run bench`.

## Kernel micro-benchmarks

Representative throughput measured on Bun 1.3 (single core, 2M iterations). These measure library overhead only -- they do not include network or storage latency.

| Function | Throughput |
|----------|-----------|
| `parseRangeHeader` | 10.1M ops/sec |
| `isPreconditionFailure` | 10.2M ops/sec |
| `isRangeFresh` | 13.9M ops/sec |
| `isConditionalFresh` | 4.7M ops/sec |
| `buildRangeResponseHeaders` | 4.2M ops/sec |
| `evaluateConditionalRequest` | 1.7M ops/sec |
| `buildContentDisposition` | 1.7M ops/sec |

## End-to-end vs `send` and `sirv`

Full HTTP serving (Node 24, `http.createServer`, loopback, 40 connections,
autocannon, identical fixtures; every cell correctness-verified before
timing; the load generator runs in a separate process so its parse cost
never throttles the server column). partial-content runs its shipped dist
through the node adapter + fsStore. Reproduce with `npm run bench`.

| Scenario | partial-content | + `cache` | send | sirv |
|---|---|---|---|---|
| GET 4 KB (200) | 13,185 req/s | **22,594 req/s** | 12,876 req/s | 13,014 req/s |
| GET 1 MB (200) | 117 req/s | 115 req/s | 117 req/s | 120 req/s |
| Range 64 KB of 1 MB (206) | **1,566 req/s** | 1,552 req/s | 1,532 req/s | 1,456 req/s |
| Revalidation (304) | 20,014 req/s | **22,838 req/s** | 19,931 req/s | 33,165 req/s* |

Each cell is the per-cell MEDIAN of three consecutive runs on an otherwise
idle machine (Node 24.11, 1.4.0 build): single-run cells on a shared dev box
swing 10-20% with background load, and medians keep one contaminated cell
from flattering either side. The full conditional chain, digest negotiation,
disposition hardening, and the disabled-by-default 1.2.0 additions (encoding
negotiation gate, inline-CSP check, offload hooks) are all in the measured
column. The 206 row leads because `fsStore` declares `authoritativeRange`:
one open handle stats, clamps, and reads, so a plain range is a single
round-trip with bounds, validators, and bytes coherent by construction --
strictly stronger than a validating HEAD, and faster than it too.

The `cache` column is `fsStore({ root, cache: { ttlMs: 1000 } })`: an opt-in
hot-object cache (TTL revalidation,
metadata + bytes captured atomically, bodies only at or below 128 KiB,
LRU-evicted under both an entry cap (`maxEntries`, default 1024) and a body
byte budget (`maxBytes`, default 64 MiB; `0` = metadata-only)). Hot small
files and their ranges serve from memory with zero syscalls. The trade is
explicit: after an overwrite, responses (including 304 revalidations) can
affirm the previous representation for up to `ttlMs`; size it against
acceptable staleness (see DESIGN.md).

\* sirv's 304 figure buys throughput with a different contract: at
`dev: false` it pre-renders complete header sets for a directory snapshot
taken at boot, so a file created after startup is a 404. In the
configuration that CAN see runtime-created files (`dev: true`), the same
runs measure sirv at 5,676 req/s (median) -- a quarter of the `cache`
column. For a fixed directory of immutable assets sirv's trade is exactly
right; for object storage (where uploads happen while the server runs) it
is disqualifying, which is why the boot-snapshot design stays a non-goal
here. On the rows where server code matters (4 KB bodies, revalidations),
the `cache` column is the fastest contender that can serve a file uploaded
a second ago; at 1 MB, all four columns converge on I/O parity.

## Bun runtime

Same code on Bun 1.3 (`Bun.serve`, same machine, same out-of-process
client -- the web adapter's Request/Response ARE the runtime's native
primitives there, no node bridge): GET 4 KB 9,418 req/s plain and
22,898 req/s with the cache; revalidation 12,538 plain and **38,090 req/s**
with the cache -- a TTL-revalidating cache serving runtime uploads,
outrunning even sirv's boot-frozen Node figure by 60%. `send` and `sirv`
are node-stream libraries and cannot ride `Bun.serve` natively. Reproduce:
`bun bench/bun-server.ts` (plain :18778, cache :18779) + autocannon.

## Read this fairly in both directions

- At payload sizes where file serving actually spends its time (1 MB
  bodies), the contenders are at parity: I/O dominates.
- Small-body transfers, ranged serves, and revalidations run at
  parity-to-modest-lead against `send` and `sirv` while doing strictly
  more per request: RFC 9530 digest negotiation, audit hooks, pinned-read
  plumbing, and storage abstraction. Five things make that possible:
  plain ranges are a single round-trip (`authoritativeRange`: the fs
  store's one open handle stats, clamps, and reads), transfers at or
  below 128 KiB take a single positional-read fast path, small bodies
  travel as plain bytes (no stream machinery), the node adapter consumes
  `serveObjectRaw` (zero fetch primitives constructed on the Node hot
  path), and validators are derived once at stat time instead of
  re-parsing dates on every request.
- Correctness note found while building this benchmark: `send` honors a
  request `Cache-Control: no-cache` during conditional evaluation, and
  spec-compliant fetch clients (undici, browsers) auto-append exactly that
  header to manually-conditional requests -- so `send` never answers 304 to
  a fetch()-based revalidation. partial-content deliberately ignores request
  cache directives here (they address caches, not origin conditional
  evaluation; see DESIGN.md).
