/**
 * Accept-Encoding negotiation (RFC 9110 Section 12.5.3), the compressibility
 * gate, and the Cache-Control composer.
 */

import { describe, expect, test } from "bun:test";
import {
  parseAcceptEncoding,
  negotiateEncoding,
  isCompressibleMime,
} from "../encoding.js";
import { buildCacheControl } from "../cache-control.js";

const SERVER_PREF = ["br", "zstd", "gzip"] as const;

describe("parseAcceptEncoding", () => {
  test("parses the standard browser field", () => {
    expect(parseAcceptEncoding("gzip, deflate, br, zstd")).toEqual([
      { coding: "gzip", q: 1 },
      { coding: "deflate", q: 1 },
      { coding: "br", q: 1 },
      { coding: "zstd", q: 1 },
    ]);
  });

  test("parses qvalues with OWS around ; and =", () => {
    expect(parseAcceptEncoding("gzip ; q=0.5 , br;q=1.0")).toEqual([
      { coding: "gzip", q: 0.5 },
      { coding: "br", q: 1 },
    ]);
  });

  test("q=0 is preserved as an exclusion signal", () => {
    expect(parseAcceptEncoding("identity;q=0")).toEqual([{ coding: "identity", q: 0 }]);
  });

  test("skips malformed members without dropping the rest", () => {
    expect(parseAcceptEncoding("gzip;q=2, br, ;q=0.5, gz ip")).toEqual([
      { coding: "br", q: 1 },
    ]);
  });

  test("qvalue beyond three decimals is malformed per RFC 9110", () => {
    expect(parseAcceptEncoding("gzip;q=0.5555")).toEqual([]);
  });

  test("duplicate codings resolve last-wins", () => {
    expect(parseAcceptEncoding("gzip;q=0.1, gzip;q=0.9")).toEqual([
      { coding: "gzip", q: 0.9 },
    ]);
  });

  test("codings are case-insensitive (lowercased)", () => {
    expect(parseAcceptEncoding("GZip;Q=0.8")).toEqual([{ coding: "gzip", q: 0.8 }]);
  });

  test("unknown parameters are ignored per spec", () => {
    expect(parseAcceptEncoding("br;foo=bar;q=0.7")).toEqual([{ coding: "br", q: 0.7 }]);
  });

  test("empty field yields no entries (identity-only)", () => {
    expect(parseAcceptEncoding("")).toEqual([]);
  });
});

describe("negotiateEncoding", () => {
  test("absent header serves identity", () => {
    expect(negotiateEncoding(null, SERVER_PREF)).toEqual([]);
  });

  test("browser default ranks by server preference on tied q", () => {
    expect(negotiateEncoding("gzip, deflate, br, zstd", SERVER_PREF))
      .toEqual(["br", "zstd", "gzip"]);
  });

  test("client q outranks server preference", () => {
    expect(negotiateEncoding("br;q=0.5, gzip;q=0.9", SERVER_PREF))
      .toEqual(["gzip", "br"]);
  });

  test("q=0 excludes a coding", () => {
    expect(negotiateEncoding("br;q=0, gzip", SERVER_PREF)).toEqual(["gzip"]);
  });

  test("wildcard covers unlisted codings", () => {
    expect(negotiateEncoding("*", SERVER_PREF)).toEqual(["br", "zstd", "gzip"]);
  });

  test("wildcard q=0 with one explicit coding", () => {
    expect(negotiateEncoding("gzip, *;q=0", SERVER_PREF)).toEqual(["gzip"]);
  });

  test("identity preferred over lower-q codings", () => {
    expect(negotiateEncoding("identity, gzip;q=0.5", SERVER_PREF)).toEqual([]);
  });

  test("identity tie goes to the listed coding", () => {
    expect(negotiateEncoding("identity;q=0.5, gzip;q=0.5", SERVER_PREF)).toEqual(["gzip"]);
  });

  test("identity;q=0 alone still yields no codings (we never 406)", () => {
    expect(negotiateEncoding("identity;q=0", SERVER_PREF)).toEqual([]);
  });

  test("only offers codings the server has", () => {
    expect(negotiateEncoding("deflate, compress", SERVER_PREF)).toEqual([]);
  });

  test("empty header means identity only", () => {
    expect(negotiateEncoding("", SERVER_PREF)).toEqual([]);
  });
});

describe("isCompressibleMime", () => {
  test.each([
    ["text/plain", true],
    ["text/html; charset=utf-8", true],
    ["text/event-stream", false],
    ["application/json", true],
    ["application/wasm", true],
    ["application/xml", true],
    ["image/svg+xml", true],
    ["application/ld+json", true],
    ["application/atom+xml", true],
    ["font/ttf", true],
    ["font/woff2", false],
    ["image/png", false],
    ["image/bmp", true],
    ["video/mp4", false],
    ["application/pdf", false],
    ["application/zip", false],
    ["application/gzip", false],
    ["application/octet-stream", false],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", false],
    ["TEXT/CSS", true],
  ])("%s -> %p", (mime, expected) => {
    expect(isCompressibleMime(mime)).toBe(expected);
  });
});

describe("buildCacheControl", () => {
  test("private no-cache with default no-transform", () => {
    expect(buildCacheControl({ visibility: "private", noCache: true }))
      .toBe("private, no-cache, no-transform");
  });

  test("public immutable with RFC 5861 staleness windows", () => {
    expect(buildCacheControl({
      visibility: "public", maxAge: 86400, immutable: true,
      staleWhileRevalidate: 604800, staleIfError: 604800,
    })).toBe(
      "public, max-age=86400, immutable, stale-while-revalidate=604800, stale-if-error=604800, no-transform",
    );
  });

  test("no-transform can be opted out", () => {
    expect(buildCacheControl({ visibility: "public", maxAge: 60, noTransform: false }))
      .toBe("public, max-age=60");
  });

  test("no-store short-circuits", () => {
    expect(buildCacheControl({ noStore: true })).toBe("no-store, no-transform");
  });

  test("no-store with freshness directives is a contradiction", () => {
    expect(() => buildCacheControl({ noStore: true, maxAge: 60 })).toThrow(TypeError);
  });

  test("immutable without maxAge is inert and throws", () => {
    expect(() => buildCacheControl({ immutable: true })).toThrow(TypeError);
  });

  test("negative and non-integer seconds throw", () => {
    expect(() => buildCacheControl({ maxAge: -1 })).toThrow(RangeError);
    expect(() => buildCacheControl({ maxAge: Number.NaN })).toThrow(RangeError);
    expect(() => buildCacheControl({ staleIfError: 1.5 })).toThrow(RangeError);
  });

  test("s-maxage and must-revalidate compose", () => {
    expect(buildCacheControl({
      visibility: "public", maxAge: 300, sMaxAge: 3600, mustRevalidate: true,
    })).toBe("public, max-age=300, s-maxage=3600, must-revalidate, no-transform");
  });

  test("empty policy throws instead of composing nothing", () => {
    expect(() => buildCacheControl({ noTransform: false })).toThrow(TypeError);
  });
});
