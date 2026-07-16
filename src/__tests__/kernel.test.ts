import { describe, test, expect, setSystemTime } from "bun:test";
import {
    OPEN_ENDED,
    parseRangeHeader,
    parseRanges,
    buildRangeResponseHeaders,
    build416Headers,
    build412Headers,
    build304Headers,
    buildMultipartHeaders,
    buildMultipartPartHeader,
    multipartEpilogue,
    generateMultipartBoundary,
    isConditionalFresh,
    isPreconditionFailure,
    isRangeFresh,
    evaluateConditionalRequest,
    evaluateConditionalWrite,
    fromNodeHeaders,
    generateETag,
} from "../index";

// ─── Shared Test Helper ─────────────────────────────────────────────────────

/** Create a minimal Headers-like object for testing. */
function mockHeaders(h: Record<string, string>): { get(name: string): string | null } {
    const lower = Object.fromEntries(
        Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

// ── parseRangeHeader ────────────────────────────────────────────────────────

describe("parseRangeHeader", () => {
    const TOTAL = 10_000; // 10KB file

    // ── Valid ranges ────────────────────────────────────────────────────

    test("parses standard range: bytes=0-499", () => {
        const r = parseRangeHeader("bytes=0-499", TOTAL);
        expect(r).toEqual({ start: 0, end: 499 });
    });

    test("parses open-ended range: bytes=500-", () => {
        const r = parseRangeHeader("bytes=500-", TOTAL);
        expect(r).toEqual({ start: 500, end: 9999 });
    });

    test("parses suffix range: bytes=-500", () => {
        const r = parseRangeHeader("bytes=-500", TOTAL);
        expect(r).toEqual({ start: 9500, end: 9999 });
    });

    test("clamps end to file boundary", () => {
        const r = parseRangeHeader("bytes=0-99999", TOTAL);
        expect(r).toEqual({ start: 0, end: 9999 });
    });

    test("parses single byte: bytes=0-0", () => {
        const r = parseRangeHeader("bytes=0-0", TOTAL);
        expect(r).toEqual({ start: 0, end: 0 });
    });

    test("parses last byte: bytes=9999-9999", () => {
        const r = parseRangeHeader("bytes=9999-9999", TOTAL);
        expect(r).toEqual({ start: 9999, end: 9999 });
    });

    test("suffix range larger than file returns full file", () => {
        const r = parseRangeHeader("bytes=-20000", TOTAL);
        expect(r).toEqual({ start: 0, end: 9999 });
    });

    test("handles whitespace around values", () => {
        const r = parseRangeHeader("bytes= 100 - 200 ", TOTAL);
        expect(r).toEqual({ start: 100, end: 200 });
    });

    test("handles leading zeros in positions", () => {
        // parsePos accepts pure digit strings; Number("00100") = 100
        const r = parseRangeHeader("bytes=00000-00100", TOTAL);
        expect(r).toEqual({ start: 0, end: 100 });
    });

    // ── Returns null (not a range request, degrade to 200) ──────────────

    test("returns null for missing header", () => {
        expect(parseRangeHeader(null, TOTAL)).toBeNull();
        expect(parseRangeHeader(undefined, TOTAL)).toBeNull();
        expect(parseRangeHeader("", TOTAL)).toBeNull();
    });

    test("returns null for non-byte unit", () => {
        expect(parseRangeHeader("items=0-10", TOTAL)).toBeNull();
    });

    test("handles case-insensitive range unit per RFC 9110 Section 14.1", () => {
        // RFC 9110 Section 14.1: "Range units are case-insensitive."
        expect(parseRangeHeader("Bytes=0-499", TOTAL)).toEqual({ start: 0, end: 499 });
        expect(parseRangeHeader("BYTES=0-499", TOTAL)).toEqual({ start: 0, end: 499 });
        expect(parseRangeHeader("bYtEs=500-", TOTAL)).toEqual({ start: 500, end: 9999 });
    });

    test("returns null for multi-range", () => {
        expect(parseRangeHeader("bytes=0-100,200-300", TOTAL)).toBeNull();
    });

    test("returns null for malformed values", () => {
        expect(parseRangeHeader("bytes=abc-def", TOTAL)).toBeNull();
        expect(parseRangeHeader("bytes=-", TOTAL)).toBeNull();
        expect(parseRangeHeader("bytes=", TOTAL)).toBeNull();
        expect(parseRangeHeader("bytes", TOTAL)).toBeNull();
    });

    test("bytes=-1-500 is rejected by strict parsePos (not a pure digit string)", () => {
        // parsePos("1-500") returns NaN (contains non-digit '-'), so this is null.
        // Old parseInt("1-500") = 1 behavior was lenient; strict parsePos rejects it.
        const r = parseRangeHeader("bytes=-1-500", TOTAL);
        expect(r).toBeNull();
    });

    test("returns \"unsatisfiable\" for zero-length suffix", () => {
        // bytes=-0 is valid Range syntax but requests zero bytes,
        // which is unsatisfiable per RFC 7233
        expect(parseRangeHeader("bytes=-0", TOTAL)).toBe("unsatisfiable");
    });

    test("returns null when totalSize is 0", () => {
        expect(parseRangeHeader("bytes=0-0", 0)).toBeNull();
    });

    test("returns null when totalSize is negative", () => {
        expect(parseRangeHeader("bytes=0-0", -1)).toBeNull();
    });

    // ── Strict parsePos (rejects non-pure-digit strings) ─────────────

    test("rejects float start: bytes=1.5-500", () => {
        expect(parseRangeHeader("bytes=1.5-500", TOTAL)).toBeNull();
    });

    test("rejects scientific notation: bytes=1e3-", () => {
        expect(parseRangeHeader("bytes=1e3-", TOTAL)).toBeNull();
    });

    test("rejects float end: bytes=0-1.5", () => {
        expect(parseRangeHeader("bytes=0-1.5", TOTAL)).toBeNull();
    });

    test("rejects negative start: bytes=-5-100 is treated as suffix", () => {
        // Starts with empty string before dash, so "5-100" is the suffix length.
        // parsePos("5-100") returns NaN (non-digit), so null.
        expect(parseRangeHeader("bytes=-5-100", TOTAL)).toBeNull();
    });

    // ── Returns "unsatisfiable" (valid syntax, out of bounds -> 416) ────

    test('returns "unsatisfiable" when start >= totalSize', () => {
        expect(parseRangeHeader("bytes=10000-", TOTAL)).toBe("unsatisfiable");
        expect(parseRangeHeader("bytes=99999-", TOTAL)).toBe("unsatisfiable");
    });

    test("returns null for inverted range (start > end) per RFC 9110 Section 14.1.2", () => {
        // RFC 9110: "A server that receives a byte-range-spec with a
        // first-byte-pos that is greater than its last-byte-pos MUST
        // ignore the invalid range." Ignore = serve full 200.
        expect(parseRangeHeader("bytes=500-100", TOTAL)).toBeNull();
    });

    test("caps MAX_SAFE_INTEGER+1 end value to MAX_SAFE_INTEGER (Go/curl compatibility)", () => {
        // Go net/http and curl -r send max-uint64 for open-ended ranges:
        // bytes=500-18446744073709551615
        // parsePos caps this to MAX_SAFE_INTEGER, then Math.min clamps to file boundary
        const r = parseRangeHeader("bytes=500-18446744073709551615", TOTAL);
        expect(r).toEqual({ start: 500, end: 9999 });
    });
});

// ── buildRangeResponseHeaders ───────────────────────────────────────────────

describe("buildRangeResponseHeaders", () => {
    test("returns 200 with full-content headers when no range", () => {
        const { status, headers } = buildRangeResponseHeaders({
            totalSize: 5000,
            range: null,
            contentType: "application/pdf",
            etag: '"abc123"',
            lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
        });

        expect(status).toBe(200);
        expect(headers["Content-Length"]).toBe("5000");
        expect(headers["Accept-Ranges"]).toBe("bytes");
        expect(headers["Content-Type"]).toBe("application/pdf");
        expect(headers["ETag"]).toBe('"abc123"');
        expect(headers["Last-Modified"]).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
        expect(headers["Content-Range"]).toBeUndefined();
    });

    test("returns 206 with range headers", () => {
        const { status, headers } = buildRangeResponseHeaders({
            totalSize: 5000,
            range: { start: 0, end: 999 },
            contentType: "video/mp4",
            etag: '"xyz789"',
            lastModified: undefined,
        });

        expect(status).toBe(206);
        expect(headers["Content-Length"]).toBe("1000");
        expect(headers["Content-Range"]).toBe("bytes 0-999/5000");
        expect(headers["Accept-Ranges"]).toBe("bytes");
        expect(headers["Content-Type"]).toBe("video/mp4");
    });

    test("omits Content-Type, ETag, Last-Modified when undefined", () => {
        const { headers } = buildRangeResponseHeaders({
            totalSize: 100,
            range: null,
            contentType: undefined,
            etag: undefined,
            lastModified: undefined,
        });

        expect(headers["Content-Type"]).toBeUndefined();
        expect(headers["ETag"]).toBeUndefined();
        expect(headers["Last-Modified"]).toBeUndefined();
    });

    test("single byte range has Content-Length of 1", () => {
        const { status, headers } = buildRangeResponseHeaders({
            totalSize: 1000,
            range: { start: 500, end: 500 },
            contentType: "audio/mpeg",
            etag: undefined,
            lastModified: undefined,
        });

        expect(status).toBe(206);
        expect(headers["Content-Length"]).toBe("1");
        expect(headers["Content-Range"]).toBe("bytes 500-500/1000");
    });

    test("always includes Accept-Ranges", () => {
        const full = buildRangeResponseHeaders({
            totalSize: 100,
            range: null,
            contentType: undefined,
            etag: undefined,
            lastModified: undefined,
        });
        const partial = buildRangeResponseHeaders({
            totalSize: 100,
            range: { start: 0, end: 49 },
            contentType: undefined,
            etag: undefined,
            lastModified: undefined,
        });

        expect(full.headers["Accept-Ranges"]).toBe("bytes");
        expect(partial.headers["Accept-Ranges"]).toBe("bytes");
    });

    test("normalizes ISO 8601 lastModified to IMF-fixdate", () => {
        // S3/R2/Supabase return ISO strings like "2025-06-28T12:00:00.000Z"
        // which are NOT valid HTTP-dates. The library should normalize to
        // IMF-fixdate for correct If-Modified-Since revalidation.
        const { headers } = buildRangeResponseHeaders({
            totalSize: 100,
            range: null,
            contentType: undefined,
            etag: undefined,
            lastModified: "2025-06-28T12:00:00.000Z",
        });

        expect(headers["Last-Modified"]).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
    });

    test("preserves already-valid IMF-fixdate lastModified", () => {
        const { headers } = buildRangeResponseHeaders({
            totalSize: 100,
            range: null,
            contentType: undefined,
            etag: undefined,
            lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
        });

        expect(headers["Last-Modified"]).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
    });

    test("throws RangeError for NaN totalSize", () => {
        expect(() =>
            buildRangeResponseHeaders({
                totalSize: NaN, range: null, contentType: "text/plain",
                etag: undefined, lastModified: undefined,
            }),
        ).toThrow(RangeError);
    });

    test("throws RangeError for negative totalSize", () => {
        expect(() =>
            buildRangeResponseHeaders({
                totalSize: -1, range: null, contentType: undefined,
                etag: undefined, lastModified: undefined,
            }),
        ).toThrow("totalSize must be a non-negative safe integer");
    });

    test("accepts zero totalSize", () => {
        const { status, headers } = buildRangeResponseHeaders({
            totalSize: 0, range: null, contentType: "text/plain",
            etag: undefined, lastModified: undefined,
        });
        expect(status).toBe(200);
        expect(headers["Content-Length"]).toBe("0");
    });

    test("emits Content-Range with '*' for an unknown total (bytes a-b/*)", () => {
        // A streaming origin that does not know its full length answers
        // `bytes a-b/*` (RFC 7233 Section 4.2). We must repeat `*` honestly,
        // never fabricate a total. Content-Length is still the range span.
        const { status, headers } = buildRangeResponseHeaders({
            totalSize: undefined,
            range: { start: 0, end: 9 },
            contentType: "application/octet-stream",
            etag: undefined, lastModified: undefined,
        });
        expect(status).toBe(206);
        expect(headers["Content-Range"]).toBe("bytes 0-9/*");
        expect(headers["Content-Length"]).toBe("10");
    });

    test("throws for an unknown total on a full (non-range) response", () => {
        // A bodyful 200 cannot be sized without a known total; `undefined`
        // here is an adapter bug, not a valid streaming case.
        expect(() =>
            buildRangeResponseHeaders({
                totalSize: undefined, range: null, contentType: "text/plain",
                etag: undefined, lastModified: undefined,
            }),
        ).toThrow("a full (non-range) response requires a known totalSize");
    });

    test("emits Repr-Digest and Content-Digest on 200 when digest provided", () => {
        const { headers } = buildRangeResponseHeaders({
            totalSize: 1000, range: null, contentType: "application/pdf",
            etag: undefined, lastModified: undefined, digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
        });
        expect(headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
        expect(headers["Content-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
    });

    test("emits Repr-Digest but omits Content-Digest on 206", () => {
        const { headers } = buildRangeResponseHeaders({
            totalSize: 1000, range: { start: 0, end: 499 },
            contentType: "application/pdf",
            etag: undefined, lastModified: undefined, digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
        });
        expect(headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
        expect(headers["Content-Digest"]).toBeUndefined();
    });

    test("omits digest headers when no digest provided", () => {
        const { headers } = buildRangeResponseHeaders({
            totalSize: 1000, range: null, contentType: "application/pdf",
            etag: undefined, lastModified: undefined,
        });
        expect(headers["Repr-Digest"]).toBeUndefined();
        expect(headers["Content-Digest"]).toBeUndefined();
    });

    test("emits Cache-Control on 200 when cacheControl provided", () => {
        const { headers } = buildRangeResponseHeaders({
            totalSize: 1000, range: null, contentType: "application/pdf",
            etag: undefined, lastModified: undefined,
            cacheControl: "private, max-age=3600",
        });
        expect(headers["Cache-Control"]).toBe("private, max-age=3600");
    });

    test("emits Cache-Control on 206 when cacheControl provided", () => {
        const { headers } = buildRangeResponseHeaders({
            totalSize: 1000, range: { start: 0, end: 499 },
            contentType: "application/pdf",
            etag: undefined, lastModified: undefined,
            cacheControl: "private, no-cache",
        });
        expect(headers["Cache-Control"]).toBe("private, no-cache");
    });

    test("omits Cache-Control when not provided", () => {
        const { headers } = buildRangeResponseHeaders({
            totalSize: 1000, range: null, contentType: "application/pdf",
            etag: undefined, lastModified: undefined,
        });
        expect(headers["Cache-Control"]).toBeUndefined();
    });
});

// ── build416Headers ─────────────────────────────────────────────────────────

describe("build416Headers", () => {
    test("returns 416 with unsatisfied Content-Range", () => {
        const { status, headers } = build416Headers(5000);

        expect(status).toBe(416);
        expect(headers["Content-Range"]).toBe("bytes */5000");
        expect(headers["Accept-Ranges"]).toBe("bytes");
    });

    test("omits representation metadata (ETag, Last-Modified, Content-Type)", () => {
        // Error responses must not leak caching headers that could
        // poison shared caches.
        const { headers } = build416Headers(1000);

        expect(headers["Content-Type"]).toBeUndefined();
        expect(headers["ETag"]).toBeUndefined();
        expect(headers["Last-Modified"]).toBeUndefined();
    });

    test("only contains Accept-Ranges, Content-Length, and Content-Range", () => {
        const { headers } = build416Headers(42);
        expect(Object.keys(headers).toSorted()).toEqual(["Accept-Ranges", "Content-Length", "Content-Range"]);
        expect(headers["Content-Length"]).toBe("0");
    });
});

// ── build412Headers ─────────────────────────────────────────────────────────

describe("build412Headers", () => {
    test("returns 412 status with Content-Length: 0", () => {
        const { status, headers } = build412Headers();

        expect(status).toBe(412);
        // Content-Length: 0 for enterprise proxies (HAProxy, Envoy)
        expect(headers["Content-Length"]).toBe("0");
        expect(Object.keys(headers)).toHaveLength(1);
    });

    test("omits all representation metadata", () => {
        // Error responses strip caching/representation headers.
        const { headers } = build412Headers();

        expect(headers["Content-Type"]).toBeUndefined();
        expect(headers["ETag"]).toBeUndefined();
        expect(headers["Last-Modified"]).toBeUndefined();
        expect(headers["Content-Range"]).toBeUndefined();
        expect(headers["Accept-Ranges"]).toBeUndefined();
    });
});

// ── isConditionalFresh (RFC 7232) ───────────────────────────────────────────

describe("isConditionalFresh", () => {
    test("returns false when no conditional headers", () => {
        expect(isConditionalFresh(mockHeaders({}), '"abc"', undefined)).toBe(false);
    });

    test("If-None-Match: matching ETag -> fresh (304)", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"abc123"' }),
                '"abc123"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-None-Match: mismatching ETag -> not fresh", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"old"' }),
                '"new"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-None-Match: wildcard * -> fresh", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": "*" }),
                '"anything"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-None-Match: multi-value list with match -> fresh", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"aaa", "bbb", "ccc"' }),
                '"bbb"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-None-Match: multi-value list without match -> not fresh", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"aaa", "bbb"' }),
                '"ccc"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-None-Match: weak ETag comparison strips W/ prefix", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": 'W/"abc"' }),
                '"abc"',
                undefined,
            ),
        ).toBe(true);

        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"abc"' }),
                'W/"abc"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-None-Match: returns false when server has no ETag", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"abc"' }),
                undefined,
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Modified-Since: not modified -> fresh", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": "Sun, 29 Jun 2025 12:00:00 GMT" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(true);
    });

    test("If-Modified-Since: modified since -> not fresh", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": "Sat, 28 Jun 2025 12:00:00 GMT" }),
                undefined,
                "Sun, 29 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Modified-Since: same time -> fresh (boundary: lastModified === sinceDate)", () => {
        // Code uses `modifiedDate <= sinceDate`, so equal dates mean fresh.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": "Sat, 28 Jun 2025 12:00:00 GMT" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(true);
    });

    test("If-Modified-Since: ISO 8601 date -> ignored (not a valid HTTP-date)", () => {
        // RFC 9110 Section 13.1.3: MUST ignore If-Modified-Since when the
        // value is not one of the three HTTP-date formats. Date.parse would
        // happily accept this string; the kernel must not.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": "2025-06-29T12:00:00Z" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Modified-Since: obsolete RFC 850 format -> honored", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": "Sunday, 29-Jun-25 12:00:00 GMT" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(true);
    });

    test("If-Modified-Since: asctime format -> honored and read as UTC", () => {
        // "Sun Jun 29 12:00:00 2025" carries no zone; RFC 9110 says it is
        // UTC. A naive Date.parse would read it as server-local time and
        // skew the comparison by the host's offset.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": "Sun Jun 29 12:00:00 2025" }),
                undefined,
                "Sun, 29 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(true);
    });

    test("If-Unmodified-Since: ISO 8601 date -> ignored, no 412", () => {
        // Same MUST-ignore rule for If-Unmodified-Since (Section 13.1.4).
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Unmodified-Since": "2025-06-01T00:00:00Z" }),
                undefined,
                "Sun, 29 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Range: ISO 8601 date -> stale (never validates a range)", () => {
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": "2025-06-29T12:00:00Z" }),
                undefined,
                "Sun, 29 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Modified-Since: unparseable date -> not fresh (ignores header)", () => {
        // Malformed If-Modified-Since: both Date.parse() calls produce NaN,
        // the condition fails, and we fall through to return false.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": "not-a-date" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Modified-Since: future date -> not fresh (RFC 9110 Section 13.1.3)", () => {
        // RFC 9110 Section 13.1.3: "A recipient MUST ignore If-Modified-Since
        // if the field value is not a valid HTTP-date, or if it is a date in
        // the future." A future date would cause false freshness (always 304).
        const futureDate = new Date(Date.now() + 86400_000).toUTCString(); // tomorrow
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": futureDate }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-None-Match takes precedence over If-Modified-Since", () => {
        // ETag matches (fresh), but date says modified -> should still be fresh
        expect(
            isConditionalFresh(
                mockHeaders({
                    "If-None-Match": '"match"',
                    "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT",
                }),
                '"match"',
                "Mon, 01 Jan 2025 00:00:00 GMT", // Modified after since-date
            ),
        ).toBe(true);
    });

    // ── Request Cache-Control is ignored (matches Go stdlib / nginx) ─────
    // RFC 9111 aims request cache directives at CACHES, not origin
    // conditional evaluation; a 304 IS the revalidation the client asked
    // for. Spec-compliant fetch clients (undici, browsers) auto-append
    // `Cache-Control: no-cache` to requests carrying manual conditional
    // headers, so honoring it would make 304 unreachable for every
    // programmatic revalidation. Verified live against Node/undici.

    test("Cache-Control: no-cache without conditional headers -> not a conditional request", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "Cache-Control": "no-cache" }),
                undefined,
                undefined,
            ),
        ).toBe(false);
    });

    test("Cache-Control: no-cache does NOT defeat a matching If-None-Match (undici revalidation)", () => {
        expect(
            isConditionalFresh(
                mockHeaders({
                    "Cache-Control": "no-cache",
                    Pragma: "no-cache",
                    "If-None-Match": '"foo"',
                }),
                '"foo"',
                undefined,
            ),
        ).toBe(true);
    });

    test("Cache-Control: no-cache does NOT defeat a matching If-Modified-Since", () => {
        expect(
            isConditionalFresh(
                mockHeaders({
                    "Cache-Control": "no-cache",
                    "If-Modified-Since": "Sat, 01 Jan 2000 01:00:00 GMT",
                }),
                undefined,
                "Sat, 01 Jan 2000 00:00:00 GMT",
            ),
        ).toBe(true);
    });

    test("Cache-Control: max-age=0 with matching ETag -> fresh (normal reload)", () => {
        expect(
            isConditionalFresh(
                mockHeaders({
                    "Cache-Control": "max-age=0",
                    "If-None-Match": '"foo"',
                }),
                '"foo"',
                undefined,
            ),
        ).toBe(true);
    });

    test("hard reload needs no special case: browsers omit validators entirely", () => {
        // Ctrl+Shift+R sends Cache-Control: no-cache WITHOUT If-None-Match /
        // If-Modified-Since -- which is already "not a conditional request".
        expect(
            isConditionalFresh(
                mockHeaders({ "Cache-Control": "no-cache", Pragma: "no-cache" }),
                '"foo"',
                "Sat, 01 Jan 2000 00:00:00 GMT",
            ),
        ).toBe(false);
    });

    // ── Quote-aware ETag parsing ────────────────────────────────────────

    test("If-None-Match: ETag containing comma is parsed correctly", () => {
        // RFC 7232 Section 2.3: commas (%x2C) are valid etagc characters.
        // A naive .split(",") would split "ver,1" into ["\"ver", "1\""].
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"ver,1"' }),
                '"ver,1"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-None-Match: multiple ETags with commas inside values", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"a,b", "c,d", "e,f"' }),
                '"c,d"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-None-Match: comma-containing ETag does not match different value", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"a,b"' }),
                '"a"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-None-Match: weak ETag with comma inside value", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": 'W/"x,y"' }),
                '"x,y"',
                undefined,
            ),
        ).toBe(true);
    });

    // ── etagc ABNF character validation (RFC 9110 Section 8.8.3) ────

    test("If-None-Match: rejects ETag with control character (null byte)", () => {
        // etagc does not include 0x00. An ETag like "\0bad" is malformed.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"' + "\x00bad" + '"' }),
                '"\x00bad"',
                undefined,
            ),
        ).toBe(false); // malformed ETag is rejected, so no match -> not fresh
    });

    test("If-None-Match: rejects ETag with space (0x20)", () => {
        // 0x20 (space) is NOT a valid etagc. Valid range starts at 0x21.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"has space"' }),
                '"has space"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-None-Match: rejects ETag with DEL (0x7F)", () => {
        // 0x7F (DEL) is excluded from etagc.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"del' + "\x7F" + '"' }),
                '"del\x7F"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-None-Match: accepts ETag with high-byte obs-text (>= 0x80)", () => {
        // obs-text (0x80-0xFF) is valid in etagc. Common with non-ASCII hashes.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"abc\x80\xFF"' }),
                '"abc\x80\xFF"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-None-Match: accepts ETag with exclamation mark (0x21)", () => {
        // 0x21 is the first valid etagc character.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"!ok"' }),
                '"!ok"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-None-Match: malformed ETag in list does not prevent matching valid ones", () => {
        // If one ETag in the list has invalid chars, the others should still match.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"bad\x00one", "good"' }),
                '"good"',
                undefined,
            ),
        ).toBe(true);
    });
});

// ── isPreconditionFailure (RFC 7232 Section 3.1 + 3.4) ─────────────────────

describe("isPreconditionFailure", () => {

    // ── No precondition headers ───────────────────────────────────────────

    test("returns false when no precondition headers", () => {
        expect(isPreconditionFailure(mockHeaders({}), '"abc"', undefined)).toBe(false);
    });

    // ── If-Match (RFC 7232 Section 3.1) ───────────────────────────────

    test("If-Match: wildcard * -> no failure (always matches)", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": "*" }),
                '"abc"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Match: matching ETag -> no failure", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"abc"' }),
                '"abc"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Match: mismatching ETag -> failure (412)", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"abc"' }),
                '"xyz"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-Match: no server ETag -> failure (cannot confirm match)", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"abc"' }),
                undefined,
                undefined,
            ),
        ).toBe(true);
    });

    test("If-Match: multi-value list with match -> no failure", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"aaa", "bbb", "ccc"' }),
                '"bbb"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Match: multi-value list without match -> failure", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"aaa", "bbb"' }),
                '"ccc"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-Match: W/ client ETag does not match strong server ETag (strict strong comparison)", () => {
        // RFC 9110 Section 13.1.1: If-Match uses STRONG comparison.
        // A weak client ETag W/"abc" MUST NOT match strong server "abc"
        // because weak validators only assert semantic equivalence, not byte equality.
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": 'W/"abc"' }),
                '"abc"',
                undefined,
            ),
        ).toBe(true); // Precondition fails: weak cannot match under strong comparison
    });

    test("If-Match: weak server ETag cannot satisfy strong comparison", () => {
        // If the server only has a weak ETag, it cannot satisfy If-Match at all.
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"abc"' }),
                'W/"abc"',
                undefined,
            ),
        ).toBe(true); // Precondition fails: server's weak ETag cannot satisfy strong comparison
    });

    // ── If-Unmodified-Since (RFC 7232 Section 3.4) ───────────────────

    test("If-Unmodified-Since: unmodified -> no failure", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Unmodified-Since": "Sun, 29 Jun 2025 12:00:00 GMT" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Unmodified-Since: modified after -> failure (412)", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Unmodified-Since": "Sat, 28 Jun 2025 12:00:00 GMT" }),
                undefined,
                "Sun, 29 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(true);
    });

    test("If-Unmodified-Since: same time -> no failure", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Unmodified-Since": "Sat, 28 Jun 2025 12:00:00 GMT" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Unmodified-Since: no server Last-Modified -> ignored (RFC 9110 Section 13.1.4)", () => {
        // RFC 9110 Section 13.1.4: "A recipient MUST ignore the
        // If-Unmodified-Since header field if the resource does not have
        // a modification date available."
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Unmodified-Since": "Sat, 28 Jun 2025 12:00:00 GMT" }),
                undefined,
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Unmodified-Since: unparseable date -> ignored (RFC 9110 Section 13.1.4)", () => {
        // RFC 9110 Section 13.1.4: "A recipient MUST ignore the
        // If-Unmodified-Since header field if the received field-value
        // is not a valid HTTP-date."
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Unmodified-Since": "not-a-date" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    // ── Precedence: If-Match over If-Unmodified-Since ────────────────

    test("If-Match takes precedence over If-Unmodified-Since", () => {
        // ETag matches (no failure), but date says modified (would be failure)
        // If-Match wins -> no failure
        expect(
            isPreconditionFailure(
                mockHeaders({
                    "If-Match": '"abc"',
                    "If-Unmodified-Since": "Mon, 01 Jan 2024 00:00:00 GMT",
                }),
                '"abc"',
                "Mon, 01 Jan 2025 00:00:00 GMT", // Modified after since-date
            ),
        ).toBe(false);
    });

    test("If-Match failure takes precedence over If-Unmodified-Since success", () => {
        // ETag mismatch (failure), but date says unmodified (no failure)
        // If-Match wins -> failure
        expect(
            isPreconditionFailure(
                mockHeaders({
                    "If-Match": '"wrong"',
                    "If-Unmodified-Since": "Mon, 01 Jan 2026 00:00:00 GMT",
                }),
                '"abc"',
                "Mon, 01 Jan 2025 00:00:00 GMT",
            ),
        ).toBe(true);
    });

    // ── Quote-aware ETag parsing for If-Match ────────────────────────

    test("If-Match: ETag containing comma is parsed correctly", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"ver,1"' }),
                '"ver,1"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Match: multi ETags with commas inside values", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"a,b", "c,d"' }),
                '"c,d"',
                undefined,
            ),
        ).toBe(false);
    });
});

// ── isRangeFresh (RFC 7233 Section 3.2) ─────────────────────────────────────

describe("isRangeFresh", () => {
    test("returns true when no If-Range header (always honor range)", () => {
        expect(isRangeFresh(mockHeaders({}), '"abc"', undefined)).toBe(true);
    });

    test("If-Range ETag matches -> range is fresh (honor it)", () => {
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": '"abc123"' }),
                '"abc123"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-Range ETag mismatch -> range is stale (ignore it)", () => {
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": '"old-etag"' }),
                '"new-etag"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Range ETag with no server ETag -> stale", () => {
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": '"abc"' }),
                undefined,
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Range weak ETag: rejected per RFC 7233 Section 3.2 (strong comparison required)", () => {
        // RFC 7233 Section 3.2 requires strong comparison for If-Range.
        // Weak validators on either side -> ignore range, serve full 200.
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": 'W/"abc"' }),
                '"abc"',
                undefined,
            ),
        ).toBe(false);

        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": '"abc"' }),
                'W/"abc"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Range date: older Last-Modified -> stale (RFC 9110 requires exact match)", () => {
        // RFC 9110 Section 13.1.5: an HTTP-date If-Range is true only when it
        // EXACTLY matches Last-Modified. An older Last-Modified (clock skew,
        // restored backup) means the bytes may differ from the client's cache;
        // honoring the range would splice mismatched content.
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": "Sun, 29 Jun 2025 12:00:00 GMT" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Range date: modified after -> stale (ignore range)", () => {
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": "Sat, 28 Jun 2025 12:00:00 GMT" }),
                undefined,
                "Sun, 29 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Range date: same time -> fresh (boundary: lastMod === ifRangeDate)", () => {
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": "Sat, 28 Jun 2025 12:00:00 GMT" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(true);
    });

    test("If-Range date: no server Last-Modified -> stale", () => {
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": "Sat, 28 Jun 2025 12:00:00 GMT" }),
                undefined,
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Range: empty string -> treated as absent (honor range)", () => {
        // Empty string from mockHeaders.get() returns "" which is falsy,
        // but our mockHeaders returns null for missing keys. This tests
        // the case where a proxy strips the value but preserves the header.
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": "" }),
                '"abc"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-Range unparseable date -> stale (cannot validate, return full resource)", () => {
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": "not-a-date-and-no-quotes" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });
});

// ── build304Headers (RFC 7232 Section 4.1) ──────────────────────────────────

describe("build304Headers", () => {
    test("returns 304 status with ETag, omits Last-Modified when both present (RFC 7232 4.1)", () => {
        const { status, headers } = build304Headers(
            '"abc123"',
            "Sat, 28 Jun 2025 12:00:00 GMT",
            "private, no-cache",
        );

        expect(status).toBe(304);
        expect(headers["ETag"]).toBe('"abc123"');
        // RFC 7232 Section 4.1: "Last-Modified might be useful if the response
        // does not have an ETag field" -- when ETag IS present, Last-Modified
        // is redundant and SHOULD NOT be included.
        expect(headers["Last-Modified"]).toBeUndefined();
        expect(headers["Cache-Control"]).toBe("private, no-cache");
    });

    test("includes Last-Modified when no ETag is present", () => {
        const { status, headers } = build304Headers(
            undefined,
            "Sat, 28 Jun 2025 12:00:00 GMT",
            "private, no-cache",
        );

        expect(status).toBe(304);
        expect(headers["ETag"]).toBeUndefined();
        expect(headers["Last-Modified"]).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
        expect(headers["Cache-Control"]).toBe("private, no-cache");
    });

    test("omits Content-Type, Content-Length, Content-Range (representation headers)", () => {
        const { headers } = build304Headers('"abc"', undefined, "private, no-cache");

        expect(headers["Content-Type"]).toBeUndefined();
        expect(headers["Content-Length"]).toBeUndefined();
        expect(headers["Content-Range"]).toBeUndefined();
        expect(headers["Content-Encoding"]).toBeUndefined();
        expect(headers["Accept-Ranges"]).toBeUndefined();
    });

    test("omits all headers when none provided", () => {
        const { status, headers } = build304Headers(undefined, undefined);

        expect(status).toBe(304);
        expect(Object.keys(headers)).toHaveLength(0);
    });

    test("omits Cache-Control when not provided", () => {
        const { headers } = build304Headers('"abc"', undefined);

        expect(headers["ETag"]).toBe('"abc"');
        expect(headers["Cache-Control"]).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Additional edge-case test vectors covering:
//   - RFC 7232 conditional GET edge cases (malformed lists, whitespace, precedence)
//   - RFC 7233 range parsing edge cases (boundary values, malformed input)
//   - Integration-level conditional + range interactions
// ═══════════════════════════════════════════════════════════════════════════

// ── parseRangeHeader: RFC 7233 edge cases ───────────────────────────────────

describe("parseRangeHeader (RFC 7233 edge cases)", () => {
    const TOTAL = 200;

    test("returns null for empty value after bytes=", () => {
        // range-parser: bytes= -> -2 (malformed)
        expect(parseRangeHeader("bytes=", TOTAL)).toBeNull();
    });

    test("returns null for missing dash: bytes=100200", () => {
        // range-parser: returns -2 (no dash found)
        expect(parseRangeHeader("bytes=100200", TOTAL)).toBeNull();
    });

    test("returns null for double dash: bytes=--100", () => {
        // range-parser: returns -2 (invalid)
        // Our parser: startStr="" (suffix range), endStr="-100",
        // parsePos("-100") = NaN (not pure digits) -> null
        expect(parseRangeHeader("bytes=--100", TOTAL)).toBeNull();
    });

    test("returns null for triple range value: bytes=100-200-300", () => {
        // range-parser: returns -2 (multiple dashes)
        // Our parser: finds first dash at index 3, endStr="200-300",
        // parsePos("200-300") = NaN -> null
        expect(parseRangeHeader("bytes=100-200-300", TOTAL)).toBeNull();
    });

    test("returns null for partial digit start: bytes=01a-150", () => {
        // range-parser: returns -2 (non-digit character in position)
        // parsePos("01a") = NaN (fails /^\d+$/ test)
        expect(parseRangeHeader("bytes=01a-150", TOTAL)).toBeNull();
    });

    test("returns null for partial digit end: bytes=100-15b0", () => {
        // parsePos("15b0") = NaN
        expect(parseRangeHeader("bytes=100-15b0", TOTAL)).toBeNull();
    });

    test("returns null for dash-only: bytes=-", () => {
        // startStr="" (suffix), endStr="" -> parsePos("") = NaN (empty doesn't match /^\d+$/) -> null
        expect(parseRangeHeader("bytes=-", TOTAL)).toBeNull();
    });

    test("returns null for whitespace-only: bytes= - ", () => {
        expect(parseRangeHeader("bytes= - ", TOTAL)).toBeNull();
    });

    test("returns \"unsatisfiable\" for zero suffix: bytes=-0", () => {
        // bytes=-0 requests zero bytes from the end, which is unsatisfiable
        expect(parseRangeHeader("bytes=-0", 200)).toBe("unsatisfiable");
    });

    test("suffix range larger than file clamps to start=0", () => {
        const r = parseRangeHeader("bytes=-201", TOTAL);
        expect(r).toEqual({ start: 0, end: 199 });
    });

    test("bytes=0- returns entire file", () => {
        // range-parser explicit test
        const r = parseRangeHeader("bytes=0-", TOTAL);
        expect(r).toEqual({ start: 0, end: 199 });
    });

    test("last byte via suffix: bytes=-1", () => {
        // range-parser: last byte
        const r = parseRangeHeader("bytes=-1", TOTAL);
        expect(r).toEqual({ start: 199, end: 199 });
    });

    test("start equals totalSize is unsatisfiable", () => {
        // range-parser: bytes=200- on 200-byte file -> -1 (unsatisfiable)
        expect(parseRangeHeader("bytes=200-", TOTAL)).toBe("unsatisfiable");
    });

    test("start > end (after no clamping needed) is ignored per RFC 9110 Section 14.1.2", () => {
        // RFC 9110: inverted ranges MUST be ignored (serve full 200)
        expect(parseRangeHeader("bytes=150-100", TOTAL)).toBeNull();
    });

    test("non-byte unit is ignored (not unsatisfiable)", () => {
        // range-parser supports non-byte units; we explicitly reject them
        // This is intentional: browser media elements only use bytes
        expect(parseRangeHeader("items=0-5", TOTAL)).toBeNull();
    });
});

// ── isConditionalFresh: RFC 7232 edge cases ────────────────────────────────

describe("isConditionalFresh (RFC 7232 edge cases)", () => {

    test("If-None-Match: tab-separated list matches", () => {
        // fresh test: '"bar",\t"foo"' with etag "foo" -> fresh
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"bar",\t"foo"' }),
                '"foo"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-None-Match: list with spaces and empty entries", () => {
        // Sparse list: ' "foo",, "bar" ,' with none matching -> 412 path
        // For freshness: this list should be parseable
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": ' "foo",, "bar" ,' }),
                '"bar"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-None-Match: list with spaces and empty entries, no match", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": ' "foo",, "bar" ,' }),
                '"baz"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-None-Match: wildcard * with no server ETag -> fresh", () => {
        // RFC 9110 Section 8.8.3: wildcard "*" validates resource existence,
        // independent of ETag presence. If the server has any representation
        // at all, the wildcard matches. Checked before the !etag guard.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": "*" }),
                undefined,
                undefined,
            ),
        ).toBe(true);
    });

    test("If-Modified-Since: invalid server Last-Modified -> stale", () => {
        // fresh test: unparseable Last-Modified -> stale
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": "Sat, 01 Jan 2000 00:00:00 GMT" }),
                undefined,
                "foo", // invalid server date
            ),
        ).toBe(false);
    });

    test("If-Modified-Since: no server Last-Modified -> stale", () => {
        // fresh test: missing Last-Modified -> stale
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": "Sat, 01 Jan 2000 00:00:00 GMT" }),
                undefined,
                undefined,
            ),
        ).toBe(false);
    });

    test("If-None-Match + If-Modified-Since: only ETag matches -> fresh (INM wins)", () => {
        // fresh test: when only ETag matches -> fresh (INM takes precedence)
        expect(
            isConditionalFresh(
                mockHeaders({
                    "If-None-Match": '"foo"',
                    "If-Modified-Since": "Sat, 01 Jan 2000 00:00:00 GMT",
                }),
                '"foo"',
                "Sat, 01 Jan 2000 01:00:00 GMT", // modified AFTER since-date
            ),
        ).toBe(true);
    });

    test("If-None-Match + If-Modified-Since: only date matches -> stale (INM wins)", () => {
        // fresh test: when only Last-Modified matches -> stale (INM takes precedence)
        expect(
            isConditionalFresh(
                mockHeaders({
                    "If-None-Match": '"foo"',
                    "If-Modified-Since": "Sat, 01 Jan 2000 01:00:00 GMT",
                }),
                '"bar"', // ETag mismatch
                "Sat, 01 Jan 2000 00:00:00 GMT", // unmodified
            ),
        ).toBe(false);
    });

    test("If-None-Match + If-Modified-Since: neither matches -> stale", () => {
        // fresh test: both mismatch -> stale
        expect(
            isConditionalFresh(
                mockHeaders({
                    "If-None-Match": '"foo"',
                    "If-Modified-Since": "Sat, 01 Jan 2000 00:00:00 GMT",
                }),
                '"bar"',
                "Sat, 01 Jan 2000 01:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("request Cache-Control never affects conditional evaluation (any directive shape)", () => {
        // Matching Go stdlib / nginx: cache directives address caches, not
        // origin conditional evaluation. A matching validator is fresh no
        // matter what Cache-Control says (undici auto-appends no-cache to
        // manually-conditional requests; honoring it would kill 304s).
        const shapes = [
            "no-cache",
            "max-age=0,no-cache",
            "public, no-cache , max-age=0",
            "no-store",
            "no-cache-transform",
        ];
        for (const cacheControl of shapes) {
            expect(
                isConditionalFresh(
                    mockHeaders({
                        "Cache-Control": cacheControl,
                        "If-None-Match": '"foo"',
                    }),
                    '"foo"',
                    undefined,
                ),
            ).toBe(true);
        }
    });
});

// ── isPreconditionFailure: RFC 7232 edge cases ─────────────────────────────

describe("isPreconditionFailure (RFC 7232 edge cases)", () => {

    test("If-Match: sparse list with empty entries ' \"foo\",, \"bar\" ,' -> failure when none match", () => {
        // Sparse comma-separated list with empty entries
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": ' "foo",, "bar" ,' }),
                '"baz"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-Match: sparse list with match -> no failure", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": ' "foo",, "bar" ,' }),
                '"bar"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Match: multi-value list with extra entry matching -> no failure", () => {
        // Multi-value If-Match where the target ETag is the last entry
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"foo", "bar", "target-etag"' }),
                '"target-etag"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Unmodified-Since: invalid date string -> ignored (RFC 9110 Section 13.1.4)", () => {
        // RFC 9110 Section 13.1.4: unparseable dates MUST be ignored.
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Unmodified-Since": "foo" }),
                undefined,
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Unmodified-Since: invalid server Last-Modified -> ignored", () => {
        // Both parseable client date + unparseable server date: isNaN check
        // catches the invalid server date, falls through to return false.
        // RFC 9110 behavior: unparseable dates are ignored.
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Unmodified-Since": "Sat, 28 Jun 2025 12:00:00 GMT" }),
                undefined,
                "not-a-valid-date",
            ),
        ).toBe(false);
    });

    test("If-Unmodified-Since: both dates unparseable -> ignored", () => {
        // Both dates unparseable: isNaN check catches both, falls through.
        // RFC 9110 Section 13.1.4: unparseable dates are ignored.
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Unmodified-Since": "garbage" }),
                undefined,
                "also-garbage",
            ),
        ).toBe(false);
    });

    test("If-Match with tabs in list -> parsed correctly", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"aaa",\t"bbb"' }),
                '"bbb"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Match with W/ on both sides -> failure (weak ETags cannot satisfy strong comparison)", () => {
        // RFC 9110 Section 13.1.1: both sides weak = no match under strong comparison.
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": 'W/"abc"' }),
                'W/"abc"',
                undefined,
            ),
        ).toBe(true); // Precondition fails: weak on both sides, strong comparison required
    });
});

// ── isRangeFresh: RFC 7233 Section 3.2 edge cases ──────────────────────────

describe("isRangeFresh (RFC 7233 edge cases)", () => {

    test("If-Range with mutated ETag (one char changed) -> stale", () => {
        // Mutated first character of ETag value should not match
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": '"0abc123"' }),
                '"abc123"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Range with date earlier than Last-Modified -> stale", () => {
        // Client cached 20 seconds before the resource was last modified
        const lastMod = "Sun, 29 Jun 2025 12:00:00 GMT";
        const earlier = new Date(Date.parse(lastMod) - 20000).toUTCString();
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": earlier }),
                undefined,
                lastMod,
            ),
        ).toBe(false);
    });

    test("If-Range with invalid value 'foo' -> stale (serve full resource)", () => {
        // Invalid If-Range value (not an ETag, not a date) -> ignore range
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": "foo" }),
                '"abc"',
                "Sat, 28 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(false);
    });

    test("If-Range with W/ on client, strong on server -> stale (RFC 7233 strong comparison)", () => {
        // RFC 7233 Section 3.2: weak validator on If-Range -> ignore range, serve full.
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": 'W/"abc"' }),
                '"abc"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Range with strong on client, W/ on server -> stale (RFC 7233 strong comparison)", () => {
        // RFC 7233 Section 3.2: weak server ETag -> cannot honor range safely.
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": '"abc"' }),
                'W/"abc"',
                undefined,
            ),
        ).toBe(false);
    });

    test("If-Range with W/ on both -> stale (RFC 7233 strong comparison)", () => {
        // Both weak -> definitely cannot honor range.
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": 'W/"abc"' }),
                'W/"abc"',
                undefined,
            ),
        ).toBe(false);
    });
});

// ── RFC 7232 Section 6: Full evaluation chain ordering ──────────────────────

describe("RFC 7232 Section 6: evaluation chain ordering", () => {

    test("412 must be evaluated before 304: If-Match fails even when If-None-Match would match", () => {
        // The route checks isPreconditionFailure BEFORE isConditionalFresh.
        // If both headers are present and If-Match fails, 412 takes priority.
        const headers = mockHeaders({
            "If-Match": '"wrong"',
            "If-None-Match": '"correct"',
        });

        // Step 1: precondition check -> should fail (412)
        expect(isPreconditionFailure(headers, '"correct"', undefined)).toBe(true);

        // Step 2: freshness check -> would be fresh (304)
        // But in the route, we never reach this because step 1 short-circuits
        expect(isConditionalFresh(headers, '"correct"', undefined)).toBe(true);
    });

    test("When If-Match passes, If-None-Match still evaluated for 304", () => {
        const headers = mockHeaders({
            "If-Match": '"correct"',
            "If-None-Match": '"correct"',
        });

        // Step 1: precondition check -> passes (no failure)
        expect(isPreconditionFailure(headers, '"correct"', undefined)).toBe(false);

        // Step 2: freshness check -> fresh (304)
        expect(isConditionalFresh(headers, '"correct"', undefined)).toBe(true);
    });

    test("If-Unmodified-Since fails -> 412, even when If-Modified-Since says fresh", () => {
        const headers = mockHeaders({
            "If-Unmodified-Since": "Mon, 01 Jan 2024 00:00:00 GMT",
            "If-Modified-Since": "Mon, 01 Jan 2026 00:00:00 GMT",
        });
        const serverDate = "Mon, 01 Jan 2025 00:00:00 GMT";

        // Step 1: precondition -> fails (modified AFTER If-Unmodified-Since)
        expect(isPreconditionFailure(headers, undefined, serverDate)).toBe(true);

        // Step 2: freshness -> would be fresh (not modified since If-Modified-Since)
        expect(isConditionalFresh(headers, undefined, serverDate)).toBe(true);
    });

    test("Range request with If-Range: validates before serving partial", () => {
        // If-Range ETag matches -> serve partial (206)
        // If-Range ETag mismatches -> serve full (200), NOT 206
        const etag = '"abc123"';

        // Valid If-Range -> honor the range
        expect(isRangeFresh(mockHeaders({ "If-Range": etag }), etag, undefined)).toBe(true);

        // Invalid If-Range -> ignore the range (serve full 200)
        expect(isRangeFresh(mockHeaders({ "If-Range": '"different"' }), etag, undefined)).toBe(false);
    });
});

// ── parseETagList: internal helper validated through public API ──────────────

describe("ETag list parsing edge cases (via public API)", () => {

    test("empty ETag list -> no match", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": "" }),
                '"abc"',
                undefined,
            ),
        ).toBe(false);
    });

    test("only commas -> no match", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": ",,," }),
                '"abc"',
                undefined,
            ),
        ).toBe(false);
    });

    test("malformed ETag (no quotes) -> no match", () => {
        // parseETagList skips entries that don't start with a quote
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": "abc" }),
                '"abc"',
                undefined,
            ),
        ).toBe(false);
    });

    test("unclosed quote -> still captured as ETag", () => {
        // parseETagList scans to end of string if no closing quote
        // The tag includes everything from start to end
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"abc' }),
                '"abc',
                undefined,
            ),
        ).toBe(true);
    });

    test("mixed valid and malformed entries", () => {
        // Only properly quoted entries are parsed
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": 'invalid, "valid", also-invalid' }),
                '"valid"',
                undefined,
            ),
        ).toBe(true);
    });

    test("ETag with special characters inside quotes", () => {
        // RFC 7232 etagc allows 0x21, 0x23-0x7E, 0x80+
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '"abc!@#$%^&*()"' }),
                '"abc!@#$%^&*()"',
                undefined,
            ),
        ).toBe(true);
    });

    test("W/ prefix on malformed entry (no quote after W/) -> skipped", () => {
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": 'W/abc, "valid"' }),
                '"valid"',
                undefined,
            ),
        ).toBe(true);
    });

    test("If-Match: empty list -> no failure (empty header treated as absent)", () => {
        // An empty If-Match header value is falsy in JS, so it's treated
        // as absent (no precondition to evaluate). This matches HTTP semantics:
        // an empty field-value is not a valid If-Match precondition.
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": "" }),
                '"abc"',
                undefined,
            ),
        ).toBe(false);

    });

    test("If-Match: only commas -> failure (no valid entries)", () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": ",,," }),
                '"abc"',
                undefined,
            ),
        ).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// RFC 9110 Coverage Completion
//
// Tests added from a line-by-line audit of RFC 9110 sections:
//   - §5.6.7  Date/Time Formats (obsolete format acceptance)
//   - §8.8.3  ETag comparison (strong vs weak, empty ETag)
//   - §13.1   Conditional request precedence and edge cases
//   - §13.1.5 If-Range date comparison semantics
//   - §14.1.2 Zero-length representation range behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("RFC 9110 coverage completion", () => {

    // ── §8.8.3.2: Strong vs Weak Comparison (Table 3) ────────────────────

    test("§8.8.3.2: If-Match correctly rejects W/ (strict strong comparison per Table 3)", () => {
        // RFC 9110 Table 3: W/"1" vs "1" under strong comparison is NO MATCH.
        // A weak validator cannot assert byte equality, which is what If-Match requires.
        // This is correct behavior, not a deviation.

        // Per strict RFC: W/"abc" MUST NOT match "abc" under strong comparison (If-Match).
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '"abc"' }),
                'W/"abc"', // server sends weak, client sends strong
                undefined,
            ),
        ).toBe(true); // Correct: weak server ETag fails strong comparison
    });

    // ── §8.8.3: Empty-String ETag ────────────────────────────────────────

    test('§8.8.3: empty-string ETag "" matches correctly in If-None-Match', () => {
        // Per ABNF: entity-tag = [ weak ] opaque-tag; opaque-tag = DQUOTE *etagc DQUOTE
        // An empty etagc sequence is valid, so "" is a valid ETag.
        expect(
            isConditionalFresh(
                mockHeaders({ "If-None-Match": '""' }),
                '""',
                undefined,
            ),
        ).toBe(true);
    });

    test('§8.8.3: empty-string ETag "" matches in If-Match', () => {
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": '""' }),
                '""',
                undefined,
            ),
        ).toBe(false);
    });

    // ── §13.1.1: If-Match Wildcard with No Server ETag ───────────────────

    test("§13.1.1: If-Match * with no server ETag -> failure when exists is unknown", () => {
        // RFC 9110 §13.1.1: "the condition is true if the origin server has
        // a current representation for the target resource."
        // With no ETag and no explicit exists flag, existence is inferred as
        // false (no etag -> no representation). This is the correct default.
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": "*" }),
                undefined, // no server ETag available
                undefined,
            ),
        ).toBe(true); // no etag + no exists -> infers non-existence -> 412
    });

    test("§13.1.1: If-Match * with exists=true but no ETag -> no failure", () => {
        // Explicit exists flag overrides the etag-based inference.
        // The read orchestrator passes exists: true after successful HEAD.
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Match": "*" }),
                undefined,
                undefined,
                true, // explicitly mark as existing
            ),
        ).toBe(false);
    });

    // ── §13.1.3: If-Modified-Since Ignored When If-None-Match Present ────

    test("§13.1.3: INM mismatch + IMS fresh -> stale (INM fully supersedes IMS)", () => {
        // RFC 9110 §13.1.3: "A recipient MUST ignore If-Modified-Since if
        // the request contains an If-None-Match header field."
        // This means when INM is present but does NOT match, the result is
        // "not fresh" regardless of what IMS says.
        expect(
            isConditionalFresh(
                mockHeaders({
                    "If-None-Match": '"wrong-etag"',
                    "If-Modified-Since": "Mon, 01 Jan 2030 00:00:00 GMT", // far future, would be "fresh"
                }),
                '"server-etag"',
                "Mon, 01 Jan 2020 00:00:00 GMT", // unmodified since 2020
            ),
        ).toBe(false); // INM mismatch -> stale, IMS completely ignored
    });

    // ── §13.1.5: If-Range Date Requires Exact Match ──────────────────────

    test("§13.1.5: If-Range date requires exact match (not <=)", () => {
        // RFC 9110 §13.1.5: "Note that this comparison by exact match,
        // including when the validator is an HTTP-date, differs from the
        // 'earlier than or equal to' comparison used when evaluating an
        // If-Unmodified-Since conditional." Go stdlib checkIfRange enforces
        // the same equality. A lenient <= would honor the range whenever the
        // dates differ -- which is exactly when byte identity cannot be
        // guaranteed, risking spliced content in the client's cache. A
        // well-behaved client echoes our emitted IMF-fixdate verbatim, so
        // exact match never misfires for correct revalidation.

        // Case: If-Range date is 1 second AFTER Last-Modified -> stale.
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": "Sun, 29 Jun 2025 12:00:01 GMT" }),
                undefined,
                "Sun, 29 Jun 2025 12:00:00 GMT", // 1 second earlier
            ),
        ).toBe(false);

        // Case: dates match exactly -> fresh (honor the range).
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": "Sun, 29 Jun 2025 12:00:00 GMT" }),
                undefined,
                "Sun, 29 Jun 2025 12:00:00 GMT",
            ),
        ).toBe(true);
    });

    // ── §14.1.2: Zero-Length Representation ──────────────────────────────

    test("§14.1.2: bytes=0-0 on zero-length file returns null (not a range request)", () => {
        // RFC 9110 §14.1.2: "When a selected representation has zero length,
        // the only satisfiable form of range-spec in a GET request is a
        // suffix-range with a non-zero suffix-length."
        // Our code: totalSize <= 0 -> returns null (treat as non-range request).
        // This is correct: a 200 with empty body is the right response.
        expect(parseRangeHeader("bytes=0-0", 0)).toBeNull();
    });

    test("§14.1.2: bytes=-1 on zero-length file returns null", () => {
        // Even a suffix range on a zero-length file: totalSize <= 0 -> null.
        // The RFC says suffix-range with non-zero suffix-length is the ONLY
        // satisfiable form, but since there are zero bytes to serve, our
        // early return of null is semantically equivalent.
        expect(parseRangeHeader("bytes=-1", 0)).toBeNull();
    });

    // ── §5.6.7: Obsolete Date Format Acceptance ─────────────────────────

    test("§5.6.7: asctime date format parsed for If-Modified-Since", () => {
        // RFC 9110 §5.6.7: "A recipient that parses a timestamp value in an
        // HTTP field MUST accept all three HTTP-date formats."
        // asctime format: "Sun Nov  6 08:49:37 1994"
        const asctime = "Sun Nov  6 08:49:37 1994";
        const imfFixdate = "Mon, 01 Jan 2024 00:00:00 GMT"; // way after 1994

        // If-Modified-Since with asctime: resource modified in 2024,
        // client says "not modified since 1994" -> resource IS modified -> not fresh
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": asctime }),
                undefined,
                imfFixdate,
            ),
        ).toBe(false);
    });

    test("§5.6.7: RFC 850 date format parsed for If-Modified-Since", () => {
        // RFC 9110 §5.6.7 obsolete format: "Sunday, 06-Nov-94 08:49:37 GMT"
        const rfc850 = "Sunday, 06-Nov-94 08:49:37 GMT";
        const imfFixdate = "Mon, 01 Jan 2024 00:00:00 GMT";

        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": rfc850 }),
                undefined,
                imfFixdate,
            ),
        ).toBe(false);
    });
});

// ── Sub-second Timestamp Precision ──────────────────────────────────────────
// Regression: conditional-date comparisons must preserve millisecond precision
// (see the sub-second cases below), not truncate to whole seconds.

describe("sub-second timestamp precision", () => {
    // Storage backends (Postgres, S3) return ISO-8601 with milliseconds.
    // The library emits Last-Modified floored to whole seconds via toUTCString().
    // When the client echoes back the floored date in If-Modified-Since, the
    // comparison must also floor the server's timestamp to avoid permanent
    // false-stale results.

    const isoWithMs = "2025-06-29T12:00:00.500Z";  // .500 sub-second
    const clientEcho = "Sun, 29 Jun 2025 12:00:00 GMT";  // floored by client

    test("isConditionalFresh: ISO-8601 with milliseconds matches floored client date", () => {
        // Without the fix: Date.parse(.500) = 1751..500 <= Date.parse(.000) = 1751..000 -> false (WRONG)
        // With the fix: floor(500) = 0 <= floor(0) = 0 -> true (correct 304)
        expect(
            isConditionalFresh(
                mockHeaders({ "If-Modified-Since": clientEcho }),
                undefined,
                isoWithMs,
            ),
        ).toBe(true);
    });

    test("isPreconditionFailure: ISO-8601 with milliseconds does not spuriously fail", () => {
        // Without the fix: .500 > .000 -> true (spurious 412)
        // With the fix: 0 > 0 -> false (correct, no failure)
        expect(
            isPreconditionFailure(
                mockHeaders({ "If-Unmodified-Since": clientEcho }),
                undefined,
                isoWithMs,
            ),
        ).toBe(false);
    });

    test("isRangeFresh: ISO-8601 with milliseconds does not break If-Range date validation", () => {
        // Without the fix: .500 <= .000 -> false (range rejected, full download)
        // With the fix: 0 <= 0 -> true (range honored, seeking works)
        expect(
            isRangeFresh(
                mockHeaders({ "If-Range": clientEcho }),
                undefined,
                isoWithMs,
            ),
        ).toBe(true);
    });
});

// ── evaluateConditionalRequest (Orchestrator) ───────────────────────────────

describe("evaluateConditionalRequest", () => {
    const meta = {
        totalSize: 10_000,
        contentType: "application/pdf",
        etag: '"abc123"',
        lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
    };

    test("returns 200 with full content when no conditional headers", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            meta,
        );
        expect(result.status).toBe(200);
        expect(result.range).toBeNull();
        expect(result.headers["Content-Length"]).toBe("10000");
    });

    test("returns 304 when ETag matches via If-None-Match", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "if-none-match": '"abc123"' }),
            meta,
        );
        expect(result.status).toBe(304);
        expect(result.range).toBeNull();
    });

    test("returns 412 when ETag does not match via If-Match", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "if-match": '"wrong"' }),
            meta,
        );
        expect(result.status).toBe(412);
        expect(result.range).toBeNull();
    });

    test("returns 206 with valid range", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "range": "bytes=0-999" }),
            meta,
        );
        expect(result.status).toBe(206);
        expect(result.range).toEqual({ start: 0, end: 999 });
        expect(result.headers["Content-Range"]).toBe("bytes 0-999/10000");
    });

    test("returns 416 when range is unsatisfiable", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "range": "bytes=99999-" }),
            meta,
        );
        expect(result.status).toBe(416);
        expect(result.range).toBeNull();
    });

    test("412 takes precedence over 304 (RFC 7232 Section 6 order)", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({
                "if-match": '"wrong"',
                "if-none-match": '"abc123"',
            }),
            meta,
        );
        expect(result.status).toBe(412);
    });

    test("304 takes precedence over range processing", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({
                "if-none-match": '"abc123"',
                "range": "bytes=0-999",
            }),
            meta,
        );
        expect(result.status).toBe(304);
        expect(result.range).toBeNull();
    });

    test("If-Range mismatch ignores Range (serves full 200)", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({
                "if-range": '"stale-etag"',
                "range": "bytes=0-999",
            }),
            meta,
        );
        expect(result.status).toBe(200);
        expect(result.range).toBeNull();
        expect(result.headers["Content-Length"]).toBe("10000");
    });
});

// ── evaluateConditionalRequest: Header Value Assertions ─────────────────────

describe("evaluateConditionalRequest header values", () => {
    test("normalizes ISO-8601 lastModified to IMF-fixdate in 200 headers", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 100,
                contentType: "text/plain",
                etag: '"abc"',
                lastModified: "2025-06-28T12:00:00.000Z", // ISO input
            },
        );
        expect(result.status).toBe(200);
        expect(result.headers["Last-Modified"]).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
    });

    test("normalizes ISO-8601 lastModified to IMF-fixdate in 206 headers", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "range": "bytes=0-9" }),
            {
                totalSize: 100,
                contentType: "text/plain",
                etag: '"abc"',
                lastModified: "2025-06-28T12:00:00.000Z",
            },
        );
        expect(result.status).toBe(206);
        expect(result.headers["Last-Modified"]).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
    });

    test("normalizes ISO-8601 lastModified to IMF-fixdate in 304 headers", () => {
        // ETag is absent so Last-Modified is emitted as the cache-update hint.
        // (When ETag is present, Last-Modified is omitted per RFC 7232 Section 4.1.)
        const result = evaluateConditionalRequest(
            mockHeaders({ "if-modified-since": "Sat, 28 Jun 2025 12:00:00 GMT" }),
            {
                totalSize: 100,
                contentType: "text/plain",
                lastModified: "2025-06-28T12:00:00.000Z",
            },
        );
        expect(result.status).toBe(304);
        expect(result.headers["Last-Modified"]).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
    });

    test("strips sub-second precision from ISO-8601 lastModified", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 100,
                lastModified: "2025-06-28T12:00:00.999Z", // sub-second
            },
        );
        // toUTCString floors to whole seconds
        expect(result.headers["Last-Modified"]).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
    });

    test("strips CRLF from unparseable lastModified fallback", () => {
        // Regression test: orchestrator must strip CRLF like the standalone builders.
        // An attacker-controlled unparseable date with CRLF should not inject headers.
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 100,
                lastModified: "bad-date\r\nX-Injected: evil",
            },
        );
        expect(result.status).toBe(200);
        // CRLF must be stripped; the raw fallback is used for unparseable dates
        expect(result.headers["Last-Modified"]).toBe("bad-dateX-Injected: evil");
        // Crucially, no newline characters should be present
        expect(result.headers["Last-Modified"]).not.toContain("\r");
        expect(result.headers["Last-Modified"]).not.toContain("\n");
    });

    test("strips ALL control bytes the runtime rejects, from every metadata-derived header", () => {
        // Node writeHead / undici Headers throw on any control byte, not just
        // CRLF (\x01, \x0B, \x7F...). Surviving sanitization would turn a
        // poisoned backend value into a runtime crash instead of a response.
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 100,
                contentType: "text/\x01plain\x7F; charset=utf-8",
                etag: '"abc\x0Bdef"',
                lastModified: "bad\x0Cdate",
                digest: "hash\x00value",
            },
        );
        expect(result.status).toBe(200);
        expect(result.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
        expect(result.headers["ETag"]).toBe('"abcdef"');
        expect(result.headers["Last-Modified"]).toBe("baddate");
        // A digest that is not the raw base64 of a 32-byte SHA-256 is never
        // emitted: a sanitized-but-wrong value framed as sha-256=:...: would
        // be a false integrity assertion, worse than none.
        expect(result.headers["Repr-Digest"]).toBeUndefined();
        expect(result.headers["Content-Digest"]).toBeUndefined();
    });

    test("passes IMF-fixdate through unchanged", () => {
        const imf = "Sat, 28 Jun 2025 12:00:00 GMT";
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 100,
                lastModified: imf,
            },
        );
        expect(result.headers["Last-Modified"]).toBe(imf);
    });

    test("omits Last-Modified when not provided", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 100,
            },
        );
        expect(result.headers["Last-Modified"]).toBeUndefined();
    });
});

// ── evaluateConditionalRequest: RFC 9530 Repr-Digest ────────────────────────

describe("evaluateConditionalRequest Repr-Digest", () => {
    test("emits Repr-Digest on 200 when digest is provided", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 1000,
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.status).toBe(200);
        expect(result.headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
    });

    test("emits Repr-Digest on 206 (stable across ranges)", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ range: "bytes=0-99" }),
            {
                totalSize: 1000,
                digest: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
            },
        );
        expect(result.status).toBe(206);
        // Repr-Digest covers the full representation, not the range
        expect(result.headers["Repr-Digest"]).toBe("sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:");
    });

    test("omits Repr-Digest when not provided", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 1000,
            },
        );
        expect(result.headers["Repr-Digest"]).toBeUndefined();
    });

    test("omits Repr-Digest on 304 (no body)", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "if-none-match": '"abc"' }),
            {
                totalSize: 1000,
                etag: '"abc"',
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.status).toBe(304);
        expect(result.headers["Repr-Digest"]).toBeUndefined();
    });

    test("omits Repr-Digest on 412 (no body)", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "if-match": '"wrong"' }),
            {
                totalSize: 1000,
                etag: '"right"',
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.status).toBe(412);
        expect(result.headers["Repr-Digest"]).toBeUndefined();
    });

    // ── Content-Digest (RFC 9530 Section 2) ─────────────────────────

    test("emits Content-Digest on 200 (equals Repr-Digest when content = full representation)", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 1000,
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.status).toBe(200);
        expect(result.headers["Content-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
        expect(result.headers["Content-Digest"]).toBe(result.headers["Repr-Digest"]);
    });

    test("omits Content-Digest on 206 (range-slice hash would require I/O)", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ range: "bytes=0-99" }),
            {
                totalSize: 1000,
                digest: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
            },
        );
        expect(result.status).toBe(206);
        expect(result.headers["Repr-Digest"]).toBe("sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:");
        expect(result.headers["Content-Digest"]).toBeUndefined();
    });

    // ── Want-Repr-Digest (RFC 9530 Section 4) ───────────────────────

    test("emits digest when Want-Repr-Digest includes sha-256", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "want-repr-digest": "sha-256=5, sha-512=3" }),
            {
                totalSize: 1000,
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
    });

    test("omits Repr-Digest when Want-Repr-Digest excludes sha-256; Content-Digest keeps its own default", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "want-repr-digest": "sha-512=5" }),
            {
                totalSize: 1000,
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.headers["Repr-Digest"]).toBeUndefined();
        // No Want-Content-Digest was sent, and an absent field expresses no
        // preference (unsolicited digests are permitted), so the full-200
        // Content-Digest still goes out: the two fields negotiate
        // independently.
        expect(result.headers["Content-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
    });

    test("omits digest when Want-Repr-Digest sets sha-256 weight to 0", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "want-repr-digest": "sha-256=0" }),
            {
                totalSize: 1000,
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.headers["Repr-Digest"]).toBeUndefined();
    });

    test("emits digest when no Want-* header is present (unsolicited allowed)", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 1000,
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
    });

    test("Want-Content-Digest gates only Content-Digest, not Repr-Digest", () => {
        // Each Want-* field expresses a preference for its corresponding
        // response field (RFC 9530 Section 4): declining Content-Digest must
        // not suppress Repr-Digest.
        const result = evaluateConditionalRequest(
            mockHeaders({ "want-content-digest": "sha-512=5" }),
            {
                totalSize: 1000,
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
        expect(result.headers["Content-Digest"]).toBeUndefined();
    });

    test("Want-Content-Digest: sha-256=0 suppresses Content-Digest on a full 200", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "want-content-digest": "sha-256=0" }),
            {
                totalSize: 1000,
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
        expect(result.headers["Content-Digest"]).toBeUndefined();
    });

    test("Want-Repr-Digest gates only Repr-Digest, not Content-Digest (the vice-versa direction)", () => {
        // The mirror of the test above: a client that declines Repr-Digest
        // but wants Content-Digest gets exactly Content-Digest on a full 200.
        const result = evaluateConditionalRequest(
            mockHeaders({
                "want-repr-digest": "sha-256=0",
                "want-content-digest": "sha-256=5",
            }),
            {
                totalSize: 1000,
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        expect(result.headers["Repr-Digest"]).toBeUndefined();
        expect(result.headers["Content-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
    });

    test("declined Repr-Digest still never yields Content-Digest on 206 or HEAD", () => {
        // Content-Digest's own preconditions (full GET body) keep applying
        // when Repr-Digest is declined: nothing is emitted at all.
        const ranged = evaluateConditionalRequest(
            mockHeaders({
                "want-repr-digest": "sha-256=0",
                "want-content-digest": "sha-256=5",
                range: "bytes=0-99",
            }),
            { totalSize: 1000, digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=" },
        );
        expect(ranged.status).toBe(206);
        expect(ranged.headers["Repr-Digest"]).toBeUndefined();
        expect(ranged.headers["Content-Digest"]).toBeUndefined();

        const head = evaluateConditionalRequest(
            mockHeaders({
                "want-repr-digest": "sha-256=0",
                "want-content-digest": "sha-256=5",
            }),
            { totalSize: 1000, digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=" },
            { method: "HEAD" },
        );
        expect(head.headers["Repr-Digest"]).toBeUndefined();
        expect(head.headers["Content-Digest"]).toBeUndefined();
    });

    test("duplicate Want-Repr-Digest keys: the LAST occurrence wins (RFC 8941 3.2)", () => {
        const suppressed = evaluateConditionalRequest(
            mockHeaders({ "want-repr-digest": "sha-256=5, sha-256=0" }),
            { totalSize: 1000, digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=" },
        );
        expect(suppressed.headers["Repr-Digest"]).toBeUndefined();

        const wanted = evaluateConditionalRequest(
            mockHeaders({ "want-repr-digest": "sha-256=0, sha-256=5" }),
            { totalSize: 1000, digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=" },
        );
        expect(wanted.headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
    });

    test("bare sha-256 key with Structured Fields parameters still counts as wanted", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ "want-repr-digest": "sha-256;x=1" }),
            { totalSize: 1000, digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=" },
        );
        expect(result.headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
    });

    test("HEAD evaluation emits Repr-Digest but never Content-Digest (RFC 9530 B.2)", () => {
        // A HEAD response transfers no content, so a representation-valued
        // Content-Digest would fail any conformant verifier.
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            { totalSize: 1000, digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=" },
            { method: "HEAD" },
        );
        expect(result.status).toBe(200);
        expect(result.headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
        expect(result.headers["Content-Digest"]).toBeUndefined();
    });

    test("HEAD evaluation ignores Range and If-Range (RFC 9110 14.2)", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ range: "bytes=0-99", "if-range": '"whatever"' }),
            { totalSize: 1000, etag: '"v1"' },
            { method: "HEAD" },
        );
        // Never 206/416 for HEAD: the headers mirror the 200 a GET would get.
        expect(result.status).toBe(200);
        expect(result.range).toBeNull();
        expect(result.headers["Content-Length"]).toBe("1000");
        expect(result.headers["Content-Range"]).toBeUndefined();
    });

    test("does not match sha-256-v2 algorithm name (false positive guard)", () => {
        // A hypothetical future algorithm "sha-256-v2" must NOT match "sha-256"
        const result = evaluateConditionalRequest(
            mockHeaders({ "want-repr-digest": "sha-256-v2=5" }),
            {
                totalSize: 1000,
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        );
        // Client wants an algorithm we don't support
        expect(result.headers["Repr-Digest"]).toBeUndefined();
    });

    test("emits Cache-Control on 200 response", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({}),
            {
                totalSize: 1000,
                contentType: "application/pdf",
                cacheControl: "private, max-age=3600",
            },
        );
        expect(result.status).toBe(200);
        expect(result.headers["Cache-Control"]).toBe("private, max-age=3600");
    });

    test("emits Cache-Control on 206 response", () => {
        const result = evaluateConditionalRequest(
            mockHeaders({ range: "bytes=0-499" }),
            {
                totalSize: 1000,
                contentType: "application/pdf",
                cacheControl: "private, no-cache",
            },
        );
        expect(result.status).toBe(206);
        expect(result.headers["Cache-Control"]).toBe("private, no-cache");
    });
});

// ── fromNodeHeaders (Express/Fastify Adapter) ───────────────────────────────

describe("fromNodeHeaders", () => {
    test("reads string header values", () => {
        const headers = fromNodeHeaders({ "content-type": "text/html" });
        expect(headers.get("content-type")).toBe("text/html");
    });

    test("returns null for missing headers", () => {
        const headers = fromNodeHeaders({});
        expect(headers.get("content-type")).toBeNull();
    });

    test("joins array-valued headers with comma-space", () => {
        const headers = fromNodeHeaders({ "set-cookie": ["a=1", "b=2"] });
        expect(headers.get("set-cookie")).toBe("a=1, b=2");
    });

    test("handles case-insensitive lookup", () => {
        const headers = fromNodeHeaders({ "Content-Type": "text/html" });
        expect(headers.get("content-type")).toBe("text/html");
    });

    test("returns null for undefined values", () => {
        const headers = fromNodeHeaders({ "x-custom": undefined });
        expect(headers.get("x-custom")).toBeNull();
    });

    test("works with isConditionalFresh", () => {
        const nodeHeaders = { "if-none-match": '"abc123"' };
        const adapted = fromNodeHeaders(nodeHeaders);
        expect(isConditionalFresh(adapted, '"abc123"', undefined)).toBe(true);
    });

    test("lookup is case-insensitive in both directions", () => {
        const h = fromNodeHeaders({ "If-None-Match": '"abc"' });
        expect(h.get("if-none-match")).toBe('"abc"');
        expect(h.get("If-None-Match")).toBe('"abc"');
    });

    test("joined array works with isConditionalFresh", () => {
        const h = fromNodeHeaders({
            "if-none-match": ['"wrong"', '"abc123"'],
        });
        // The joined value '"wrong", "abc123"' should match '"abc123"'
        expect(isConditionalFresh(h, '"abc123"', undefined)).toBe(true);
    });
});

// ── generateETag ────────────────────────────────────────────────────────────

// generateETag is a FORMATTER, not a hasher. It classifies storage metadata
// into the correct validator strength and NEVER fabricates one it cannot
// stand behind. The dangerous failure mode is emitting a strong/size-only
// validator that ignores modification -> serves stale 304s. Every "undefined"
// case below guards that.

describe("generateETag - strength matrix", () => {
    test("hash present -> STRONG validator", () => {
        expect(generateETag({ hash: "abc123" })).toBe('"abc123"');
    });

    test("hash takes precedence over size+mtime (digest is byte-exact)", () => {
        expect(
            generateETag({ hash: "abc123", size: 1000, mtime: 0 }),
        ).toBe('"abc123"');
    });

    test("no hash, size + mtime -> WEAK validator (RFC 9110 Section 8.8.1)", () => {
        // size 1000 = 0x3e8, mtime 1_000_000ms -> floor(1000s) = 0x3e8
        expect(
            generateETag({ size: 1000, mtime: 1_000_000 }),
        ).toBe('W/"3e8-3e8"');
    });

    test("no hash, size only (no mtime) -> undefined", () => {
        // size alone cannot detect modification -> refuse to emit.
        expect(generateETag({ size: 1000 })).toBeUndefined();
    });

    test("no hash, mtime only (no size) -> undefined", () => {
        expect(generateETag({ mtime: 1_000_000 })).toBeUndefined();
    });

    test("empty source -> undefined", () => {
        expect(generateETag({})).toBeUndefined();
    });
});

describe("generateETag - hash normalization", () => {
    test("strips storage-supplied surrounding quotes, re-wraps once", () => {
        // S3 returns the ETag already quoted. Must not double-quote.
        expect(generateETag({ hash: '"abc123"' })).toBe('"abc123"');
    });

    test("unquoted backend hash is wrapped", () => {
        expect(generateETag({ hash: "abc123" })).toBe('"abc123"');
    });

    test("multipart S3 ETag (hash-partcount) is a valid strong validator", () => {
        // "<md5>-<n>" is still byte-exact for that object; format verbatim.
        expect(generateETag({ hash: '"d41d8cd98f00b204e9800998ecf8427e-7"' }))
            .toBe('"d41d8cd98f00b204e9800998ecf8427e-7"');
    });

    test("backend-marked weak hash STAYS weak (no silent upgrade to strong)", () => {
        expect(generateETag({ hash: 'W/"abc123"' })).toBe('W/"abc123"');
    });

    test("hash that is empty after cleaning falls through to size+mtime", () => {
        expect(generateETag({ hash: '""', size: 1000, mtime: 1_000_000 }))
            .toBe('W/"3e8-3e8"');
    });

    test("whitespace-only hash falls through, not a bare quote pair", () => {
        expect(generateETag({ hash: "   " })).toBeUndefined();
    });

    test("interior DQUOTE is stripped so the emitted ETag is well-formed etagc", () => {
        // A backend hash with an embedded quote must not emit `"abc"def"`,
        // which a cache parses as etag `"abc"` + trailing garbage, silently
        // defeating revalidation. RFC 9110 8.8.3 etagc excludes DQUOTE.
        const etag = generateETag({ hash: 'abc"def' });
        expect(etag).toBe('"abcdef"');
        // Exactly two quotes: the anchoring pair, none in the body.
        expect((etag!.match(/"/g) ?? []).length).toBe(2);
    });

    test("control bytes and DEL are stripped from the ETag body", () => {
        expect(generateETag({ hash: "abc\x00\x7Fdef" })).toBe('"abcdef"');
    });
});

describe("generateETag - mtime input types", () => {
    test("accepts Date", () => {
        expect(generateETag({ size: 16, mtime: new Date(2_000_000) }))
            .toBe('W/"10-7d0"'); // 16=0x10, floor(2000s)=0x7d0
    });

    test("accepts epoch-ms number", () => {
        expect(generateETag({ size: 16, mtime: 2_000_000 })).toBe('W/"10-7d0"');
    });

    test("accepts Date.parse()-able string (ISO)", () => {
        const ms = Date.parse("2025-06-28T12:00:00.000Z");
        const expected = `W/"10-${Math.floor(ms / 1000).toString(16)}"`;
        expect(generateETag({ size: 16, mtime: "2025-06-28T12:00:00.000Z" }))
            .toBe(expected);
    });

    test("unparseable mtime WITH size -> undefined, NOT a size-only ETag", () => {
        // The trap: a validator that floors to size and ignores a broken date
        // would 304 on changed content. Refuse instead.
        expect(generateETag({ size: 1000, mtime: "not-a-date" })).toBeUndefined();
    });
});

describe("generateETag - sub-second consistency (matches Last-Modified flooring)", () => {
    test("millisecond jitter does not churn the weak validator", () => {
        // Both floor to the same whole second -> identical ETag. Prevents the
        // emitted Last-Modified (sec resolution) and the ETag from disagreeing.
        const a = generateETag({ size: 500, mtime: "2025-06-28T12:00:00.100Z" });
        const b = generateETag({ size: 500, mtime: "2025-06-28T12:00:00.900Z" });
        expect(a).toBe(b);
    });

    test("empty file (size 0) is valid, not treated as missing", () => {
        expect(generateETag({ size: 0, mtime: 1_000_000 })).toBe('W/"0-3e8"');
    });

    test("negative size -> undefined (defensive; size is a byte count)", () => {
        expect(generateETag({ size: -1, mtime: 1_000_000 })).toBeUndefined();
    });
});

// ── evaluateConditionalWrite ────────────────────────────────────────────────

// The write orchestrator is the counterpart to evaluateConditionalRequest.
// The critical difference: If-None-Match on writes returns 412, not 304.
// Getting this wrong silently skips OCC protection or creates phantom
// resources.

describe("evaluateConditionalWrite - OCC (If-Match)", () => {
    test("no conditional headers -> proceed", () => {
        const result = evaluateConditionalWrite(mockHeaders({}), {
            etag: '"v1"',
            lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
        });
        expect(result.proceed).toBe(true);
    });

    test("If-Match: matching ETag -> proceed (safe to overwrite)", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-Match": '"v1"' }),
            { etag: '"v1"' },
        );
        expect(result.proceed).toBe(true);
    });

    test("If-Match: mismatching ETag -> 412 (concurrent edit detected)", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-Match": '"v1"' }),
            { etag: '"v2"' },
        );
        expect(result.proceed).toBe(false);
        if (!result.proceed) {
            expect(result.status).toBe(412);
            // Content-Length: 0 for enterprise proxies
            expect(result.headers["Content-Length"]).toBe("0");
            // Include current ETag so client can resync
            expect(result.headers["ETag"]).toBe('"v2"');
        }
    });

    test("If-Match: no server ETag -> 412 (cannot confirm match)", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-Match": '"v1"' }),
            {},
        );
        expect(result.proceed).toBe(false);
    });

    test("If-Match: wildcard * -> proceed (resource exists)", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-Match": "*" }),
            { etag: '"v1"' },
        );
        expect(result.proceed).toBe(true);
    });

    test("If-Match: W/ client ETag fails strong comparison (write-side)", () => {
        // RFC 9110 Section 13.1.1: If-Match requires strong comparison.
        // A weak ETag from the client cannot satisfy the precondition.
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-Match": 'W/"v1"' }),
            { etag: '"v1"' },
        );
        expect(result.proceed).toBe(false); // Weak cannot match under strong comparison
    });
});

describe("evaluateConditionalWrite - If-Unmodified-Since", () => {
    test("unmodified -> proceed", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-Unmodified-Since": "Sun, 29 Jun 2025 12:00:00 GMT" }),
            { lastModified: "Sat, 28 Jun 2025 12:00:00 GMT" },
        );
        expect(result.proceed).toBe(true);
    });

    test("modified after -> 412", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-Unmodified-Since": "Sat, 28 Jun 2025 12:00:00 GMT" }),
            { lastModified: "Sun, 29 Jun 2025 12:00:00 GMT" },
        );
        expect(result.proceed).toBe(false);
        if (!result.proceed) {
            expect(result.status).toBe(412);
        }
    });

    test("normalizes ISO-8601 lastModified before comparison", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-Unmodified-Since": "Sun, 29 Jun 2025 12:00:00 GMT" }),
            { lastModified: "2025-06-28T12:00:00.000Z" },
        );
        expect(result.proceed).toBe(true);
    });
});

describe("evaluateConditionalWrite - If-None-Match (write semantics: 412, NOT 304)", () => {
    test("If-None-Match: * with existing resource -> 412 (resource already exists)", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": "*" }),
            { etag: '"v1"' },
        );
        expect(result.proceed).toBe(false);
        if (!result.proceed) {
            expect(result.status).toBe(412);
        }
    });

    test("If-None-Match: * with non-existing resource -> proceed (safe to create)", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": "*" }),
            { exists: false },
        );
        expect(result.proceed).toBe(true);
    });

    test("If-None-Match: * infers existence from etag when exists is omitted", () => {
        // Has etag -> exists -> 412
        const withEtag = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": "*" }),
            { etag: '"v1"' },
        );
        expect(withEtag.proceed).toBe(false);
    });

    test("If-None-Match: * with no etag and no exists -> throws (fail closed)", () => {
        // When existence is genuinely unknowable, the library throws
        // rather than guessing and potentially overwriting a resource.
        expect(() =>
            evaluateConditionalWrite(
                mockHeaders({ "If-None-Match": "*" }),
                {},
            ),
        ).toThrow("requires a known existence state");
    });

    test("If-None-Match: * with exists=true overrides missing etag", () => {
        // Resource exists but has no etag (e.g., filesystem) -> still 412
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": "*" }),
            { exists: true },
        );
        expect(result.proceed).toBe(false);
    });

    test("If-None-Match: * with exists=false overrides present etag", () => {
        // Edge case: exists explicitly false but etag provided -> trust exists
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": "*" }),
            { etag: '"v1"', exists: false },
        );
        expect(result.proceed).toBe(true);
    });

    test("If-None-Match: matching ETag -> 412 (not 304)", () => {
        // This is THE critical difference from the read path.
        // isConditionalFresh would return true (304). The write path
        // MUST return 412 instead.
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": '"v1"' }),
            { etag: '"v1"' },
        );
        expect(result.proceed).toBe(false);
        if (!result.proceed) {
            expect(result.status).toBe(412);
        }
    });

    test("If-None-Match: mismatching ETag -> proceed", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": '"v1"' }),
            { etag: '"v2"' },
        );
        expect(result.proceed).toBe(true);
    });

    test("If-None-Match: ETag list with one match -> 412", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": '"v1", "v2", "v3"' }),
            { etag: '"v2"' },
        );
        expect(result.proceed).toBe(false);
    });

    test("If-None-Match: ETag list with no match -> proceed", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": '"v1", "v2"' }),
            { etag: '"v3"' },
        );
        expect(result.proceed).toBe(true);
    });

    test("If-None-Match: W/ comparison for write-side matching", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": 'W/"v1"' }),
            { etag: '"v1"' },
        );
        expect(result.proceed).toBe(false);
    });

    test("If-None-Match: no server etag, specific ETag -> proceed", () => {
        // No server etag means we can't match -> proceed
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-None-Match": '"v1"' }),
            {},
        );
        expect(result.proceed).toBe(true);
    });
});

describe("evaluateConditionalWrite - evaluation order", () => {
    test("If-Match 412 takes precedence over If-None-Match proceed", () => {
        // If-Match fails (412), If-None-Match would pass -> 412 wins
        const result = evaluateConditionalWrite(
            mockHeaders({
                "If-Match": '"wrong"',
                "If-None-Match": '"other"',
            }),
            { etag: '"v1"' },
        );
        expect(result.proceed).toBe(false);
    });

    test("If-Match pass, then If-None-Match evaluated", () => {
        // If-Match passes, but If-None-Match: * with existing resource -> 412
        const result = evaluateConditionalWrite(
            mockHeaders({
                "If-Match": '"v1"',
                "If-None-Match": "*",
            }),
            { etag: '"v1"' },
        );
        expect(result.proceed).toBe(false);
    });

    test("If-Match pass + If-None-Match no match -> proceed", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({
                "If-Match": '"v1"',
                "If-None-Match": '"other"',
            }),
            { etag: '"v1"' },
        );
        expect(result.proceed).toBe(true);
    });

    test("empty meta (new resource) with no headers -> proceed", () => {
        const result = evaluateConditionalWrite(mockHeaders({}), {});
        expect(result.proceed).toBe(true);
    });

    test("discriminated union narrows correctly on proceed=false", () => {
        const result = evaluateConditionalWrite(
            mockHeaders({ "If-Match": '"wrong"' }),
            { etag: '"v1"' },
        );
        if (!result.proceed) {
            // TypeScript should narrow to { proceed: false, status: 412, headers }
            const s: 412 = result.status;
            const h: Record<string, string> = result.headers;
            expect(s).toBe(412);
            expect(h).toBeDefined();
        } else {
            // Should not reach here
            expect(true).toBe(false);
        }
    });
});

// ── Enterprise hardening: totalSize validation ──────────────────────────────

describe("parseRangeHeader - totalSize validation", () => {
    test("returns null for NaN totalSize", () => {
        expect(parseRangeHeader("bytes=0-99", NaN)).toBeNull();
    });

    test("returns null for Infinity totalSize", () => {
        expect(parseRangeHeader("bytes=0-99", Infinity)).toBeNull();
    });

    test("returns null for -Infinity totalSize", () => {
        expect(parseRangeHeader("bytes=0-99", -Infinity)).toBeNull();
    });

    test("returns null for negative totalSize", () => {
        expect(parseRangeHeader("bytes=0-99", -1)).toBeNull();
    });

    test("returns null for zero totalSize (empty file)", () => {
        // Zero-length files: Range is meaningless, serve full 200
        expect(parseRangeHeader("bytes=0-0", 0)).toBeNull();
    });

    test("returns null for fractional totalSize", () => {
        // Content-Length must be an integer (RFC 9110 Section 8.6).
        // Fractional sizes from corrupt adapters must be rejected.
        const result = parseRangeHeader("bytes=0-99", 1000.5);
        expect(result).toBeNull();
    });
});

describe("evaluateConditionalRequest - totalSize validation", () => {
    test("throws RangeError for NaN totalSize", () => {
        expect(() =>
            evaluateConditionalRequest(mockHeaders({}), {
                totalSize: NaN,
                contentType: "application/pdf",
            }),
        ).toThrow(RangeError);
    });

    test("throws RangeError for Infinity totalSize", () => {
        expect(() =>
            evaluateConditionalRequest(mockHeaders({}), {
                totalSize: Infinity,
                contentType: "application/pdf",
            }),
        ).toThrow(RangeError);
    });

    test("throws RangeError for negative totalSize", () => {
        expect(() =>
            evaluateConditionalRequest(mockHeaders({}), {
                totalSize: -1,
                contentType: "application/pdf",
            }),
        ).toThrow(RangeError);
    });

    test("throws with descriptive message", () => {
        expect(() =>
            evaluateConditionalRequest(mockHeaders({}), {
                totalSize: NaN,
            }),
        ).toThrow("totalSize must be a non-negative safe integer");
    });

    test("throws RangeError for fractional totalSize", () => {
        // Content-Length MUST be a non-negative integer (RFC 9110 Section 8.6).
        // A fractional size from a corrupt adapter would produce "Content-Length: 1000.5".
        expect(() =>
            evaluateConditionalRequest(mockHeaders({}), {
                totalSize: 1000.5,
                contentType: "application/pdf",
            }),
        ).toThrow(RangeError);
    });

    test("accepts zero totalSize (empty file)", () => {
        // Empty files are valid -- serve 200 with Content-Length: 0
        const result = evaluateConditionalRequest(mockHeaders({}), {
            totalSize: 0,
            contentType: "text/plain",
        });
        expect(result.status).toBe(200);
        expect(result.headers["Content-Length"]).toBe("0");
    });
});

// ─── Multiple Ranges (parseRanges) ──────────────────────────────────────────

describe("parseRanges", () => {
    test("single range returns a one-element set", () => {
        const r = parseRanges("bytes=0-9", 100);
        expect(r).toEqual({ ranges: [{ start: 0, end: 9 }] });
    });

    test("disjoint ranges are returned in REQUEST order (RFC 9110 15.3.7.2 SHOULD)", () => {
        const r = parseRanges("bytes=500-509,0-9", 1000);
        expect(r).toEqual({ ranges: [{ start: 500, end: 509 }, { start: 0, end: 9 }] });
    });

    test("overlapping ranges are coalesced", () => {
        const r = parseRanges("bytes=0-4,2-8", 1000);
        expect(r).toEqual({ ranges: [{ start: 0, end: 8 }] });
    });

    test("adjacent ranges (touching) are coalesced", () => {
        const r = parseRanges("bytes=0-9,10-19", 1000);
        expect(r).toEqual({ ranges: [{ start: 0, end: 19 }] });
    });

    test("a gap smaller than the part overhead IS bridged (RFC 9110 15.3.7.2)", () => {
        // 70-byte gap < 80-byte framing overhead: the merged part is smaller
        // than two framed parts, so coalescing strictly shrinks the response.
        const r = parseRanges("bytes=0-9,80-89", 1000);
        expect(r).toEqual({ ranges: [{ start: 0, end: 89 }] });
    });

    test("a gap of exactly the 80-byte overhead is bridged; 81 is not", () => {
        expect(parseRanges("bytes=0-9,90-99", 1000))
            .toEqual({ ranges: [{ start: 0, end: 99 }] });
        expect(parseRanges("bytes=0-9,91-99", 1000))
            .toEqual({ ranges: [{ start: 0, end: 9 }, { start: 91, end: 99 }] });
    });

    test("a coalesced part inherits its earliest contributor's request position", () => {
        // 500-509 appears first; 0-9 and 80-89 (later specs) merge into 0-89,
        // whose position is that of 0-9 (second spec) -> after 500-509.
        const r = parseRanges("bytes=500-509,0-9,80-89", 1000);
        expect(r).toEqual({ ranges: [{ start: 500, end: 509 }, { start: 0, end: 89 }] });
    });

    test("all-unsatisfiable ranges yield 416", () => {
        expect(parseRanges("bytes=200-300,400-500", 100)).toBe("unsatisfiable");
    });

    test("a satisfiable range survives even when a sibling is unsatisfiable", () => {
        const r = parseRanges("bytes=0-9,200-300", 100);
        expect(r).toEqual({ ranges: [{ start: 0, end: 9 }] });
    });

    test("a malformed element voids the whole header (serve 200)", () => {
        expect(parseRanges("bytes=0-9,garbage", 100)).toBeNull();
    });

    test("empty list elements are skipped per the RFC list rule", () => {
        const r = parseRanges("bytes=0-9,,200-209", 1000);
        expect(r).toEqual({ ranges: [{ start: 0, end: 9 }, { start: 200, end: 209 }] });
    });

    test("amplification: more coalesced parts than maxRanges degrades to 200", () => {
        // Three disjoint 1-byte ranges beyond bridging distance, cap of 2
        // -> serve full 200 (null).
        expect(parseRanges("bytes=0-0,200-200,400-400", 1000, 2)).toBeNull();
    });

    test("ranges tiling the whole representation coalesce to a single full-span 206", () => {
        // 0-9 + 10-19 merge into 0-19, the entire 20-byte object: served as a
        // plain single 206 (no multipart framing), never degraded to 200 --
        // consistent with how parseRangeHeader treats "bytes=0-".
        expect(parseRanges("bytes=0-9,10-19", 20))
            .toEqual({ ranges: [{ start: 0, end: 19 }] });
    });

    test("a single satisfiable range behaves exactly like parseRangeHeader", () => {
        // Trailing comma routes "bytes=0-" through the multi-range parser;
        // it must still yield the same open-ended seek, not degrade to 200.
        expect(parseRanges("bytes=0-,", 100))
            .toEqual({ ranges: [{ start: 0, end: 99 }] });
    });

    test("non-bytes unit is ignored (serve 200)", () => {
        expect(parseRanges("items=0-9,10-19", 100)).toBeNull();
    });

    // ── totalSize + header guards (kernel.ts parseRanges head) ──────────────
    // A corrupt adapter can report a non-integer or negative size; a zero-length
    // object cannot satisfy any range. Each must be rejected before parsing
    // rather than producing a bogus range or unsatisfiable set.
    test("returns null for NaN totalSize", () => {
        expect(parseRanges("bytes=0-9", NaN)).toBeNull();
    });

    test("returns null for Infinity totalSize", () => {
        expect(parseRanges("bytes=0-9", Infinity)).toBeNull();
    });

    test("returns null for fractional totalSize", () => {
        expect(parseRanges("bytes=0-9", 100.5)).toBeNull();
    });

    test("returns null for negative totalSize", () => {
        expect(parseRanges("bytes=0-9", -1)).toBeNull();
    });

    test("returns null for zero totalSize (empty representation)", () => {
        expect(parseRanges("bytes=0-9", 0)).toBeNull();
    });

    test("returns null for a null range header with a valid size", () => {
        expect(parseRanges(null, 100)).toBeNull();
    });

    test("returns null for an empty range header with a valid size", () => {
        expect(parseRanges("", 100)).toBeNull();
    });
});

// ─── Multipart Builders (multipart/byteranges) ──────────────────────────────

describe("multipart/byteranges builders", () => {
    test("generateMultipartBoundary is hyphen-free and unique", () => {
        const a = generateMultipartBoundary();
        const b = generateMultipartBoundary();
        expect(a).not.toContain("-");
        expect(a).not.toBe(b);
        expect(a.startsWith("partialcontent")).toBe(true);
    });

    test("part header carries Content-Type and Content-Range", () => {
        const h = buildMultipartPartHeader("BOUNDARY", { start: 0, end: 4 }, 100, "text/plain");
        expect(h).toBe("--BOUNDARY\r\nContent-Type: text/plain\r\nContent-Range: bytes 0-4/100\r\n\r\n");
    });

    test("part header omits Content-Type when undefined", () => {
        const h = buildMultipartPartHeader("BOUNDARY", { start: 0, end: 4 }, 100, undefined);
        expect(h).toBe("--BOUNDARY\r\nContent-Range: bytes 0-4/100\r\n\r\n");
    });

    test("top-level headers are multipart/byteranges with an EXACT Content-Length", () => {
        const boundary = "BXYZ";
        const ranges = [{ start: 0, end: 4 }, { start: 10, end: 14 }];
        const { status, headers, contentLength } = buildMultipartHeaders({
            boundary, ranges, totalSize: 100, contentType: "text/plain",
            etag: '"v1"',
        });

        expect(status).toBe(206);
        expect(headers["Content-Type"]).toBe("multipart/byteranges; boundary=BXYZ");
        expect(headers["ETag"]).toBe('"v1"');

        // Independently reconstruct the exact body the streamer will emit and
        // assert the precomputed Content-Length matches byte-for-byte.
        const enc = new TextEncoder();
        let expected = 0;
        for (const r of ranges) {
            expected += enc.encode(buildMultipartPartHeader(boundary, r, 100, "text/plain")).byteLength;
            expected += r.end - r.start + 1;
            expected += 2; // trailing CRLF
        }
        expected += enc.encode(multipartEpilogue(boundary)).byteLength;
        expect(contentLength).toBe(expected);
        expect(headers["Content-Length"]).toBe(String(expected));
    });

    test("Repr-Digest is emitted but Content-Digest is not (partial response)", () => {
        const { headers } = buildMultipartHeaders({
            boundary: "B", ranges: [{ start: 0, end: 4 }], totalSize: 100,
            contentType: "application/pdf", digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
        });
        expect(headers["Repr-Digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
        expect(headers["Content-Digest"]).toBeUndefined();
    });

    // ── totalSize guard (kernel.ts buildMultipartHeaders head) ──────────────
    // The precomputed Content-Length arithmetic assumes a non-negative safe
    // integer; a corrupt size must throw, never silently emit a wrong length.
    test("throws RangeError for NaN totalSize", () => {
        expect(() => buildMultipartHeaders({
            boundary: "B", ranges: [{ start: 0, end: 4 }], totalSize: NaN, contentType: "text/plain",
        })).toThrow(RangeError);
    });

    test("throws RangeError for fractional totalSize", () => {
        expect(() => buildMultipartHeaders({
            boundary: "B", ranges: [{ start: 0, end: 4 }], totalSize: 100.5, contentType: "text/plain",
        })).toThrow(RangeError);
    });

    test("throws RangeError for negative totalSize", () => {
        expect(() => buildMultipartHeaders({
            boundary: "B", ranges: [{ start: 0, end: 4 }], totalSize: -1, contentType: "text/plain",
        })).toThrow(RangeError);
    });

    // ── range-bounds guard (parity with buildRangeResponseHeaders) ──────────
    // A part whose bounds the range parser could never produce must throw
    // rather than serialize an invalid Content-Range into the framing.
    test("throws RangeError for a part end at/past totalSize", () => {
        expect(() => buildMultipartHeaders({
            boundary: "B", ranges: [{ start: 0, end: 999 }], totalSize: 500, contentType: "text/plain",
        })).toThrow(RangeError);
    });

    test("throws RangeError for inverted and negative part bounds", () => {
        expect(() => buildMultipartHeaders({
            boundary: "B", ranges: [{ start: 10, end: 4 }], totalSize: 100, contentType: "text/plain",
        })).toThrow(RangeError);
        expect(() => buildMultipartHeaders({
            boundary: "B", ranges: [{ start: -1, end: 4 }], totalSize: 100, contentType: "text/plain",
        })).toThrow(RangeError);
    });

    test("throws RangeError when the OPEN_ENDED sentinel reaches the framing", () => {
        expect(() => buildMultipartHeaders({
            boundary: "B", ranges: [{ start: 0, end: OPEN_ENDED }], totalSize: 100, contentType: "text/plain",
        })).toThrow(RangeError);
    });

    // ── boundary guard ───────────────────────────────────────────────────────
    // The boundary lands in the Content-Type header AND the body framing the
    // Content-Length was computed against, so an invalid token throws instead
    // of being silently sanitized into a desynced value.
    test("throws RangeError for boundaries outside the RFC 2046 grammar", () => {
        const base = { ranges: [{ start: 0, end: 4 }], totalSize: 100, contentType: "text/plain" };
        expect(() => buildMultipartHeaders({ ...base, boundary: "bad\r\ninjected: yes" })).toThrow(RangeError);
        expect(() => buildMultipartHeaders({ ...base, boundary: "" })).toThrow(RangeError);
        expect(() => buildMultipartHeaders({ ...base, boundary: "ends with space " })).toThrow(RangeError);
        expect(() => buildMultipartHeaders({ ...base, boundary: "x".repeat(71) })).toThrow(RangeError);
        expect(() => buildMultipartHeaders({ ...base, boundary: 'quo"te' })).toThrow(RangeError);
    });

    test("accepts generated boundaries and full-grammar hand-supplied ones", () => {
        const base = { ranges: [{ start: 0, end: 4 }], totalSize: 100, contentType: "text/plain" };
        expect(() => buildMultipartHeaders({ ...base, boundary: generateMultipartBoundary() })).not.toThrow();
        expect(() => buildMultipartHeaders({ ...base, boundary: "a'()+_,-./:=? z" })).not.toThrow();
        expect(() => buildMultipartHeaders({ ...base, boundary: "x".repeat(70) })).not.toThrow();
    });
});

// ─── Hardening additions (RFC re-audit) ─────────────────────────────────────

describe("fromNodeHeaders prototype safety", () => {
    test("get('constructor') returns null, not Object.prototype members", () => {
        const h = fromNodeHeaders({ "x-real": "yes" });
        expect(h.get("constructor")).toBeNull();
        expect(h.get("__proto__")).toBeNull();
        expect(h.get("toString")).toBeNull();
        expect(h.get("x-real")).toBe("yes");
    });

    test("a literal __proto__ header name cannot poison the map", () => {
        // "__proto__" is a legal HTTP field name; on a plain object the
        // assignment would hit the prototype setter instead of storing.
        const h = fromNodeHeaders(JSON.parse('{"__proto__":"evil","range":"bytes=0-1"}') as Record<string, string>);
        expect(h.get("range")).toBe("bytes=0-1");
        expect(h.get("__proto__")).toBe("evil");
        expect(({} as Record<string, unknown>)["evil"]).toBeUndefined();
    });
});

describe("If-Range date strong-validator rule (RFC 9110 13.1.5 step 1)", () => {
    test("a Last-Modified in the current second is weak: range must be ignored", () => {
        setSystemTime(new Date("2025-06-28T12:00:00.500Z"));
        try {
            const date = "Sat, 28 Jun 2025 12:00:00 GMT";
            expect(isRangeFresh(mockHeaders({ "if-range": date }), undefined, date)).toBe(false);
        } finally {
            setSystemTime();
        }
    });

    test("a Last-Modified whose second has fully elapsed is strong: range honored", () => {
        setSystemTime(new Date("2025-06-28T12:00:05.000Z"));
        try {
            const date = "Sat, 28 Jun 2025 12:00:00 GMT";
            expect(isRangeFresh(mockHeaders({ "if-range": date }), undefined, date)).toBe(true);
        } finally {
            setSystemTime();
        }
    });
});

describe("builder input validation (grammar-invalid Content-Range prevention)", () => {
    test("build416Headers rejects NaN / negative / fractional totalSize", () => {
        expect(() => build416Headers(NaN)).toThrow(RangeError);
        expect(() => build416Headers(-1)).toThrow(RangeError);
        expect(() => build416Headers(10.5)).toThrow(RangeError);
    });

    test("buildRangeResponseHeaders rejects the OPEN_ENDED sentinel as a literal bound", () => {
        expect(() =>
            buildRangeResponseHeaders({
                totalSize: undefined,
                range: { start: 0, end: OPEN_ENDED },
                contentType: undefined, etag: undefined, lastModified: undefined,
            }),
        ).toThrow(RangeError);
    });

    test("buildRangeResponseHeaders rejects an end at or past a known total", () => {
        expect(() =>
            buildRangeResponseHeaders({
                totalSize: 100,
                range: { start: 0, end: 100 },
                contentType: undefined, etag: undefined, lastModified: undefined,
            }),
        ).toThrow(RangeError);
    });

    test("buildRangeResponseHeaders rejects inverted or negative bounds", () => {
        expect(() =>
            buildRangeResponseHeaders({
                totalSize: 100,
                range: { start: 10, end: 5 },
                contentType: undefined, etag: undefined, lastModified: undefined,
            }),
        ).toThrow(RangeError);
        expect(() =>
            buildRangeResponseHeaders({
                totalSize: 100,
                range: { start: -1, end: 5 },
                contentType: undefined, etag: undefined, lastModified: undefined,
            }),
        ).toThrow(RangeError);
    });
});

describe("asctime If-Modified-Since (space-padded single-digit day)", () => {
    test("matches its IMF-fixdate equivalent and yields freshness", () => {
        // ANSI C asctime pads days 1-9 with a SPACE; the date must parse to
        // exactly the same instant as the IMF form, not fail silently.
        const lastModified = "Sun, 06 Jul 2025 12:00:00 GMT";
        const fresh = isConditionalFresh(
            mockHeaders({ "if-modified-since": "Sun Jul  6 12:00:00 2025" }),
            undefined,
            lastModified,
        );
        expect(fresh).toBe(true);
    });
});

describe("buildMultipartHeaders top-level metadata", () => {
    test("normalizes ISO Last-Modified to IMF-fixdate and emits Cache-Control", () => {
        const { headers } = buildMultipartHeaders({
            boundary: "B",
            ranges: [{ start: 0, end: 4 }, { start: 100, end: 104 }],
            totalSize: 200,
            contentType: "application/pdf",
            lastModified: "2025-06-28T12:00:00.500Z",
            cacheControl: "private, max-age=60",
        });
        expect(headers["Last-Modified"]).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
        expect(headers["Cache-Control"]).toBe("private, max-age=60");
    });
});

describe("generateMultipartBoundary fallback (no crypto.randomUUID)", () => {
    test("derives a hyphen-free random token from getRandomValues", () => {
        const original = globalThis.crypto.randomUUID;
        try {
            Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
            const boundary = generateMultipartBoundary();
            expect(boundary).toMatch(/^partialcontent[0-9a-f]{32}$/);
            expect(boundary).not.toContain("-");
        } finally {
            Object.defineProperty(globalThis.crypto, "randomUUID", { value: original, configurable: true });
        }
    });
});
