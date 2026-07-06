import {
  parseRangeHeader,
  buildRangeResponseHeaders,
  build416Headers,
  isConditionalFresh,
  isPreconditionFailure,
  isRangeFresh,
  evaluateConditionalRequest,
  buildContentDisposition,
} from "./src/index";

const ITERATIONS = 2_000_000;

function bench(name: string, fn: () => void): number {
  for (let i = 0; i < 50_000; i++) fn(); // warmup
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) fn();
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round(ITERATIONS / (elapsed / 1000));
  const nsPerOp = Math.round((elapsed / ITERATIONS) * 1_000_000);
  console.log(`  ${name.padEnd(44)} ${(opsPerSec / 1_000_000).toFixed(1).padStart(6)}M ops/sec  ${String(nsPerOp).padStart(5)}ns/op`);
  return opsPerSec;
}

console.log("\n=== Kernel micro-benchmarks ===\n");

const webHeaders304 = new Headers({
  "if-none-match": '"abc123"',
  "if-modified-since": "Sat, 28 Jun 2025 12:00:00 GMT",
});

const webHeaders206 = new Headers({
  "range": "bytes=0-499",
});

const webHeadersFull = new Headers({
  "range": "bytes=0-499",
  "if-none-match": '"abc123"',
  "if-match": '"abc123"',
  "if-modified-since": "Sat, 28 Jun 2025 12:00:00 GMT",
  "if-range": '"abc123"',
});

bench("parseRangeHeader", () => {
  parseRangeHeader("bytes=0-499", 10000);
});

bench("buildRangeResponseHeaders", () => {
  buildRangeResponseHeaders({ totalSize: 10000, range: { start: 0, end: 499 }, contentType: "video/mp4", etag: '"abc123"', lastModified: "2025-06-28T12:00:00.000Z" });
});

bench("isConditionalFresh", () => {
  isConditionalFresh(webHeaders304, '"abc123"', "Sat, 28 Jun 2025 12:00:00 GMT");
});

bench("isPreconditionFailure", () => {
  isPreconditionFailure(webHeadersFull, '"abc123"', "Sat, 28 Jun 2025 12:00:00 GMT");
});

bench("isRangeFresh", () => {
  isRangeFresh(webHeadersFull, '"abc123"', "Sat, 28 Jun 2025 12:00:00 GMT");
});

bench("evaluateConditionalRequest (304 path)", () => {
  evaluateConditionalRequest(webHeaders304, {
    totalSize: 10000,
    contentType: "video/mp4",
    etag: '"abc123"',
    lastModified: "2025-06-28T12:00:00.000Z",
  });
});

bench("evaluateConditionalRequest (206 path)", () => {
  evaluateConditionalRequest(webHeaders206, {
    totalSize: 10000,
    contentType: "video/mp4",
    etag: '"abc123"',
    lastModified: "2025-06-28T12:00:00.000Z",
  });
});

bench("evaluateConditionalRequest (200 no cond)", () => {
  evaluateConditionalRequest(new Headers(), {
    totalSize: 10000,
    contentType: "video/mp4",
    etag: '"abc123"',
    lastModified: "2025-06-28T12:00:00.000Z",
  });
});

bench("buildContentDisposition (ASCII)", () => {
  buildContentDisposition("report.pdf");
});

bench("buildContentDisposition (non-ASCII)", () => {
  buildContentDisposition("Årlig_Rapport.pdf");
});

bench("build416Headers", () => {
  build416Headers(10000);
});
