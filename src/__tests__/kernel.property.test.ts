/**
 * Property-based tests for the partial-content kernel.
 *
 * Example-based tests pin the cases we thought of; these pin the INVARIANTS
 * that must hold across the whole input space, which is where header parsers
 * and range math actually break. fast-check generates thousands of inputs
 * (including the control bytes, huge integers, and malformed syntax a fuzzer
 * finds and a human forgets) and shrinks any counterexample to a minimal
 * reproduction.
 *
 * Invariants covered:
 *   - sanitizeHeaderValue: output is always writable header bytes; idempotent;
 *     never grows; a already-clean value is untouched (no header injection,
 *     no runtime write crash, for ANY input).
 *   - Content-Range: build -> parse is a lossless round-trip (known + unknown
 *     total), and parseContentRange never throws and never returns incoherent
 *     bounds for arbitrary input.
 *   - parseRanges: never throws; every satisfiable set is in-bounds, ascending,
 *     coalesced (no touching/overlapping parts), capped, and covers < the whole
 *     representation (the amplification defense).
 *   - generateETag: deterministic and always well-formed (`(W/)?"..."`).
 */
import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
    sanitizeHeaderValue,
    parseContentRange,
    parseRanges,
    buildRangeResponseHeaders,
    buildMultipartHeaders,
    buildMultipartPartHeader,
    multipartEpilogue,
    generateETag,
    MAX_RANGES_DEFAULT,
} from "../kernel";

// Strings spanning the full code-point space (control bytes, obs-text, BMP,
// astral) minus lone surrogates, so the security invariants see the inputs a
// naive `fc.string()` would rarely produce.
const arbitraryText = fc
    .array(fc.integer({ min: 0, max: 0x10ffff }).filter((c) => c < 0xd800 || c > 0xdfff), { maxLength: 48 })
    .map((codes) => String.fromCodePoint(...codes));

// A single char guaranteed to survive sanitizeHeaderValue untouched: TAB, or
// the printable-ASCII / obs-text (0x80-0xff) ranges the RFC 9110 grammar keeps.
const validHeaderChar = fc.oneof(
    fc.constant("\t"),
    fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)),
    fc.integer({ min: 0x80, max: 0xff }).map((c) => String.fromCharCode(c)),
);

// ─── sanitizeHeaderValue ─────────────────────────────────────────────────────

describe("sanitizeHeaderValue properties", () => {
    // Everything outside {HTAB, 0x20-0x7e, 0x80-0xff} is a header-write crash or
    // an injection vector; the output must never contain one.
    const FORBIDDEN = /[^\t\x20-\x7e\x80-ÿ]/;

    test("output contains only writable RFC 9110 field-value bytes", () => {
        fc.assert(
            fc.property(arbitraryText, (s) => !FORBIDDEN.test(sanitizeHeaderValue(s))),
            { numRuns: 500 },
        );
    });

    test("is idempotent (a sanitized value sanitizes to itself)", () => {
        fc.assert(
            fc.property(arbitraryText, (s) => {
                const once = sanitizeHeaderValue(s);
                return sanitizeHeaderValue(once) === once;
            }),
        );
    });

    test("never grows the string (only strips)", () => {
        fc.assert(fc.property(arbitraryText, (s) => sanitizeHeaderValue(s).length <= s.length));
    });

    test("leaves an already-valid value byte-for-byte unchanged", () => {
        const cleanText = fc.array(validHeaderChar, { maxLength: 64 }).map((cs) => cs.join(""));
        fc.assert(fc.property(cleanText, (s) => sanitizeHeaderValue(s) === s));
    });
});

// ─── Content-Range round-trip ────────────────────────────────────────────────

// A valid satisfiable range with a known total: 0 <= start <= end < totalSize,
// all safe integers.
const validRange = fc.integer({ min: 0, max: 2 ** 40 }).chain((end) =>
    fc.record({
        start: fc.integer({ min: 0, max: end }),
        end: fc.constant(end),
        totalSize: fc.integer({ min: end + 1, max: end + 1 + 2 ** 32 }),
    }),
);

describe("Content-Range build/parse round-trip", () => {
    test("a 206 Content-Range parses back to the exact range and total", () => {
        fc.assert(
            fc.property(validRange, ({ start, end, totalSize }) => {
                const res = buildRangeResponseHeaders({ totalSize, range: { start, end } });
                expect(res.status).toBe(206);
                expect(parseContentRange(res.headers["Content-Range"])).toEqual({ start, end, totalSize });
            }),
        );
    });

    test("an unknown total emits `/*` and parses back to the -1 sentinel", () => {
        fc.assert(
            fc.property(validRange, ({ start, end }) => {
                const res = buildRangeResponseHeaders({ totalSize: undefined, range: { start, end } });
                expect(res.headers["Content-Range"]).toBe(`bytes ${start}-${end}/*`);
                expect(parseContentRange(res.headers["Content-Range"])).toEqual({ start, end, totalSize: -1 });
            }),
        );
    });
});

// ─── parseContentRange robustness ────────────────────────────────────────────

describe("parseContentRange properties", () => {
    // Content-Range-shaped strings with arbitrary (incl. negative / huge / `*`)
    // fields, to stress the parser right at its grammar boundary.
    const contentRangeLike = fc
        .tuple(
            fc.integer({ min: -8, max: 2 ** 20 }),
            fc.integer({ min: -8, max: 2 ** 20 }),
            fc.oneof(fc.integer({ min: -8, max: 2 ** 20 }).map(String), fc.constant("*")),
        )
        .map(([a, b, c]) => `bytes ${a}-${b}/${c}`);

    test("never throws and never returns incoherent bounds", () => {
        fc.assert(
            fc.property(fc.oneof(arbitraryText, contentRangeLike), (s) => {
                const r = parseContentRange(s);
                if (r === null) return;
                expect(r.start).toBeGreaterThanOrEqual(0);
                expect(r.end).toBeGreaterThanOrEqual(r.start);
                if (r.totalSize !== -1) {
                    expect(r.totalSize).toBeGreaterThanOrEqual(0);
                    expect(r.end).toBeLessThan(r.totalSize);
                }
            }),
            { numRuns: 500 },
        );
    });
});

// ─── parseRanges invariants ──────────────────────────────────────────────────

describe("parseRanges properties", () => {
    const safeTotal = fc.integer({ min: 1, max: 2 ** 32 });
    // Real `bytes=a-b,...` headers alongside arbitrary text, so the satisfiable
    // branch (and its coalescing) is actually exercised, not just the reject path.
    const byteRangeHeader = fc
        .array(fc.tuple(fc.integer({ min: 0, max: 2 ** 20 }), fc.integer({ min: 0, max: 2 ** 20 })), {
            minLength: 1,
            maxLength: 8,
        })
        .map((pairs) => "bytes=" + pairs.map(([a, b]) => `${a}-${b}`).join(","));

    test("never throws; a satisfiable set is in-bounds, coalesced, capped, and sub-total", () => {
        fc.assert(
            fc.property(safeTotal, fc.oneof(arbitraryText, byteRangeHeader), (total, header) => {
                const r = parseRanges(header, total);
                if (r === null || r === "unsatisfiable") return;

                expect(r.ranges.length).toBeGreaterThanOrEqual(1);
                expect(r.ranges.length).toBeLessThanOrEqual(MAX_RANGES_DEFAULT);

                let prevEnd = -2; // first part only needs start >= 0
                let covered = 0;
                for (const rg of r.ranges) {
                    expect(rg.start).toBeGreaterThanOrEqual(0);
                    expect(rg.end).toBeGreaterThanOrEqual(rg.start);
                    expect(rg.end).toBeLessThan(total);
                    // Coalesced + ascending: a distinct part starts at least 2 past
                    // the previous end (touching/overlapping parts were merged).
                    expect(rg.start).toBeGreaterThan(prevEnd + 1);
                    prevEnd = rg.end;
                    covered += rg.end - rg.start + 1;
                }
                // Amplification defense: a satisfiable set never covers the whole file.
                expect(covered).toBeLessThan(total);
            }),
            { numRuns: 500 },
        );
    });
});

// ─── buildMultipartHeaders arithmetic ────────────────────────────────────────

describe("buildMultipartHeaders properties", () => {
    // A part span of bounded length (so the placeholder body stays cheap) at an
    // arbitrary offset; buildMultipartHeaders does pure byte arithmetic and does
    // not require in-bounds or non-overlapping ranges.
    const part = fc
        .tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 256 }))
        .map(([start, len]) => ({ start, end: start + len }));

    const multipartCase = fc.record({
        boundary: fc.stringMatching(/^[a-zA-Z0-9]{1,40}$/),
        ranges: fc.array(part, { minLength: 1, maxLength: 8 }),
        totalSize: fc.integer({ min: 1, max: 2 ** 40 }),
        // Include obs-text (0x80-0xff) content types so the UTF-8 byte counting
        // (not code-unit counting) is exercised on both sides.
        contentType: fc.option(
            fc.oneof(fc.constant("text/plain"), fc.constant("application/pdf"), arbitraryText),
            { nil: undefined },
        ),
    });

    test("advertised Content-Length equals the real assembled multipart body length", () => {
        fc.assert(
            fc.property(multipartCase, ({ boundary, ranges, totalSize, contentType }) => {
                const res = buildMultipartHeaders({ boundary, ranges, totalSize, contentType });

                // Independently assemble the exact body a server would emit and
                // measure its UTF-8 bytes: part header + body bytes + CRLF per
                // part, then the closing epilogue. A framing off-by-one (a
                // dropped CRLF, a miscounted epilogue) diverges here.
                let body = "";
                for (const r of ranges) {
                    body += buildMultipartPartHeader(boundary, r, totalSize, contentType);
                    body += "x".repeat(r.end - r.start + 1); // 1 ASCII byte per content byte
                    body += "\r\n";
                }
                body += multipartEpilogue(boundary);
                const realBytes = new TextEncoder().encode(body).byteLength;

                expect(res.contentLength).toBe(realBytes);
                expect(res.headers["Content-Length"]).toBe(String(realBytes));
                expect(res.status).toBe(206);
            }),
            { numRuns: 300 },
        );
    });
});

// ─── generateETag ────────────────────────────────────────────────────────────

describe("generateETag properties", () => {
    const etagSource = fc.record(
        {
            hash: fc.option(arbitraryText, { nil: undefined }),
            size: fc.option(fc.integer({ min: 0, max: 2 ** 40 }), { nil: undefined }),
            mtime: fc.option(
                fc.oneof(fc.date(), fc.integer(), fc.string()),
                { nil: undefined },
            ),
        },
        { requiredKeys: [] },
    );

    test("is deterministic and, when defined, always a well-formed entity-tag", () => {
        fc.assert(
            fc.property(etagSource, (src) => {
                const a = generateETag(src);
                // Pure: the same metadata must always yield the same validator.
                expect(generateETag(src)).toBe(a);
                // Well-formed: optional W/ prefix, quoted body with no interior quote.
                if (a !== undefined) expect(a).toMatch(/^(W\/)?"[^"]*"$/);
            }),
        );
    });
});
