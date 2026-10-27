# Benchmarks

Two suites: kernel micro-benchmarks (library overhead only) and end-to-end HTTP
serving against `send` and `sirv`. Reproduce with `bun bench.ts` and
`npm run bench`.

## How a number earns its place here

A benchmark that measures the load generator instead of the server is worse
than no benchmark, because it reads as parity and hides both directions of the
truth. Three rules keep that out of this document.

**The load generator runs in its own process.** Run in-process with the server,
the client's own HTTP parser dominates the profile (`Buffer.toString` on every
response body reached 72% of process CPU on the 1 MB scenario), throttling every
column equally.

**A scenario is published only after it is shown to be server-bound.** The test
is to add a second load generator: if throughput rises, the first one was the
bottleneck and the row was measuring it. The 1 MB body and the 64 KB range
scenarios fail that test -- a second generator roughly DOUBLED them for every
server, our own included -- so no throughput figure for them appears here. They
are still run, and still correctness-verified, because a scenario that stops
serving the right bytes has to fail somewhere; their timing is just not a
result. At 1 MB that is the honest finding rather than a missing one: transfers
that size are I/O-bound, and every contender converges there.

**CPU per request is the metric to compare on.** It is client-independent, so it
survives a saturated generator, a noisy machine, and a different network path,
and it is the number that decides whether a change to this package is a win: a
performance change ships only with CPU per request measured before and after,
on top of throughput. Throughput answers "what did this machine do today"; CPU
per request answers "what does the server code cost", which is the part a
library can actually change.

`npm run bench` reports it for every cell, user and system split, alongside the
throughput table. Every server runs inside the harness process and the load
generator is a child process, so `process.cpuUsage()` bracketed around the
measured window counts the serving work and none of the client's; dividing by
the request count that window completed gives the figure. One server is under
load at a time, which is what makes the delta attributable to a column. The
window also contains the harness's idle event-loop polling, identical for every
column, which is why a cell whose generator is saturated reports a CPU figure
inflated by amortizing that cost over fewer requests, and another reason those
cells are not published. For a breakdown of where the microseconds go rather
than how many there are, run `node --cpu-prof bench/profile-server.mjs` under an
external `autocannon`.

## Kernel micro-benchmarks

Throughput of the pure header functions, measured on Bun 1.4.0 against the
current source: single thread, 2M iterations after a 50k warmup, per-row median
of three consecutive runs on a shared development machine. There is no client
here, so these rows are server-bound by construction. They measure library
overhead only -- no network, no storage latency. Read a row as the cost class it
belongs to rather than as a certified peak. Reproduce with `bun bench.ts`.

| Function | Throughput |
|----------|-----------|
| `parseRangeHeader` | 10.4M ops/sec |
| `isPreconditionFailure` | 10.2M ops/sec |
| `isRangeFresh` | 20.6M ops/sec |
| `isConditionalFresh` | 6.5M ops/sec |
| `buildRangeResponseHeaders` | 8.9M ops/sec |
| `evaluateConditionalRequest` (304 path) | 3.1M ops/sec |
| `evaluateConditionalRequest` (206 path) | 1.8M ops/sec |
| `evaluateConditionalRequest` (200, unconditional) | 2.1M ops/sec |
| `buildContentDisposition` (ASCII) | 5.3M ops/sec |
| `buildContentDisposition` (non-ASCII) | 0.9M ops/sec |

`bench.ts` also times `build416Headers`, which is left out of this table: its
argument is loop-invariant and its result unused, so the engine elides the call
and the figure that comes back measures the optimizer rather than the function.

## End-to-end vs `send` and `sirv`

Measured 2026-09-04 on partial-content 5.0.0, Node v24.11.1, Windows 11
(10.0.26200), AMD Ryzen 9 5900X (12 cores / 24 threads), 64 GB,
`http.createServer` over loopback, 40 connections, 5 s per cell, out-of-process
`autocannon`, identical fixtures, every cell correctness-verified (status and
byte count) before timing, per-cell median of three consecutive runs on an
otherwise idle machine. partial-content serves through its shipped `dist` (node
adapter + `fsStore`), which is exactly what an npm consumer runs: conditional
evaluation, ETag derivation, digest negotiation, disposition hardening, and the
audit hooks are all inside the measured column. `send` and `sirv` run with
defaults plus ETags enabled. Reproduce with `npm run bench`.

Two scenarios are server-bound and therefore publishable: a 4 KB body and a
revalidation. `partial-content (cache)` is the same store with the opt-in
hot-object cache enabled at a 1 s TTL, reported as its own column rather than
folded into the default one.

CPU per request, user + system microseconds, the metric these comparisons are
decided on:

| Scenario | partial-content | partial-content (cache) | `send` | `sirv` |
|---|---|---|---|---|
| GET 4 KB (200) | 86.0 + 138.5 | 32.2 + 26.7 | 82.0 + 179.3 | 95.7 + 177.7 |
| Revalidation (304) | 67.0 + 106.1 | 30.9 + 30.8 | 47.2 + 92.4 | 17.9 + 20.5 |

Throughput on the same runs, for the same two scenarios:

| Scenario | partial-content | partial-content (cache) | `send` | `sirv` |
|---|---|---|---|---|
| GET 4 KB (200) | 9,748 req/s | 17,745 req/s | 9,988 req/s | 9,924 req/s |
| Revalidation (304) | 10,453 req/s | 15,065 req/s | 12,854 req/s | 25,435 req/s |

Read together: on the 4 KB body partial-content in its default configuration
costs the least CPU per request of the three libraries (225 us against 261 for
`send` and 273 for `sirv`) at throughput within 3% of both, and its cache column
serves the same bytes for a quarter of that. On the revalidation both
contenders are cheaper than the default column,
`sirv` by a wide margin, and the next section is why that comparison is not the
one it appears to be.

These are Windows figures, where the filesystem system-call share is high: system
time is roughly 60% of the 4 KB cost here and will be a smaller fraction on
Linux. Compare columns within a table, never a number here against a number from
another machine.

### The revalidation row is a scope mismatch, not a loss

`sirv` buys its 304 throughput by pre-rendering complete header sets for a
directory snapshot taken at startup. A file created after the process starts is
a `404` to it. That is a sound trade for a fixed directory of immutable build
assets, and a disqualifying one for anything backed by object storage, where the
file a user uploaded a second ago has to be servable now.

Measured in the configuration that CAN see a runtime-created file (`dev: true`,
per-request lookup), on the same runs as the tables above, the revalidation
scenario puts `sirv` at 4,279 req/s and 68.2 + 162.9 us/req. Against that,
partial-content answers 10,453 req/s at 67.0 + 106.1 us/req, and 15,065 req/s at
30.9 + 30.8 us/req with the cache on: two and a half times the throughput at
three quarters of the CPU, or three and a half times at a quarter of it. Both
`sirv` numbers are real; which one is the comparison depends entirely on whether
your files exist before the server starts.

The boot-snapshot design is a deliberate non-goal here. This package always
consults the backend, because the backend is the only thing that knows.

### Reading the rest fairly

- The 4 KB row is close in both directions while partial-content does strictly
  more per request: RFC 9530 digest negotiation, audit hooks, pinned-read
  plumbing, and a storage abstraction over the filesystem. Five things pay for
  that: a plain range is a single round-trip (`fsStore` declares
  `authoritativeRange`, so one open descriptor stats, clamps, and reads),
  transfers at or below 128 KiB take a single positional-read fast path, that
  path's open, stat, read and close settle through ONE promise instead of four
  (worth 18% of user CPU on the 4 KB cell, measured paired against the
  four-promise form), small bodies travel as plain bytes with no stream
  machinery, and the node adapter consumes `serveObjectRaw`, constructing zero
  fetch primitives on the Node hot path. Validators are derived once at stat
  time rather than re-parsed per request.
- `fsStore({ cache })` (see [API.md](API.md)) removes the per-request syscalls
  for hot small files, at the cost of a bounded staleness window. It is off by
  default because correctness comes first, and it is measured as its own column
  rather than folded into the figures above.
- The optimizations that make the 4 KB rows fast do NOT sum. On Bun the runtime
  provides some of them, and the caching layers overlap with the fast paths
  underneath them. Adding the individual percentages produces a number no
  configuration has ever measured.

### Other runtimes

The web adapter's `Request` and `Response` are native primitives on Bun,
Deno, and Workers, so the same code serves on `Bun.serve` with no Node bridge
in the path. `send` and `sirv` are Node-stream libraries and have no equivalent
there, which makes it a runtime comparison rather than a library one; run
`bun bench/bun-server.ts` (plain on :18778, cached on :18779) with an external
`autocannon` if the figures for your runtime matter.

### A correctness difference found while building this harness

`send` honors a request `Cache-Control: no-cache` during conditional
evaluation, and spec-compliant fetch clients (undici, browsers) auto-append
exactly that header to a manually-conditional request, so `send` never answers
`304` to a `fetch()`-based revalidation. partial-content ignores request cache
directives here: they address caches, not an origin's conditional evaluation
(see [DESIGN.md](DESIGN.md)). Your revalidation rate going up after the switch
is the intended outcome, not a regression.
