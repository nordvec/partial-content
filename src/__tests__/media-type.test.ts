import { describe, test, expect } from "bun:test";
import { buildRangeResponseHeaders, isCompressibleMime, isInlineSafeMediaType } from "../index";
import { memoryStore } from "../memory";
import { parseMediaType, resolveMediaType } from "../media-type";
import { serveObject } from "../web";

/**
 * A comma makes a browser's MIME extraction (WHATWG Fetch) take the LAST member
 * that parses, so a list is never read as its first member.
 */
const COMMA_FORMS = ["image/png, text/html", "image/png;,text/html", "text/plain,text/html", 'image/png;x=",";y=1'];

const serve = (mime: string, disposition: "inline" | "attachment" = "inline") =>
    serveObject(memoryStore({ objects: { k: { body: "<b>x</b>" } } }), { disposition })(
        new Request("http://localhost/k"),
        { key: "k", mime },
    );

describe("parseMediaType", () => {
    test("returns the essence, the emitted value and the charset", () => {
        expect(parseMediaType(' Text/HTML ; Charset="UTF-8" ')).toEqual({
            value: 'Text/HTML ; Charset="UTF-8"',
            essence: "text/html",
            charset: "UTF-8",
        });
        expect(parseMediaType("image/png")?.charset).toBeUndefined();
    });

    test("a charset-looking value inside another parameter is not the charset", () => {
        expect(parseMediaType('text/plain; x="a;charset=b"')?.charset).toBeUndefined();
    });

    test.each(COMMA_FORMS)("a comma is off-grammar: %s", (value) => {
        expect(parseMediaType(value)).toBeNull();
        expect(resolveMediaType(value).value).toBe("application/octet-stream");
    });

    test.each([
        "",
        "text",
        "/html",
        "text/",
        'text/plain; charset="utf-8',
        "text/plain; =x",
        "te xt/plain",
        "a/b\r\nX: y",
    ])("off-grammar value is not interpreted: %p", (value) => {
        expect(parseMediaType(value)).toBeNull();
    });
});

describe("one parse decides every consumer", () => {
    test.each(COMMA_FORMS)("%s is never inline-safe nor compressible", (value) => {
        expect(isInlineSafeMediaType(value)).toBe(false);
        expect(isCompressibleMime(value)).toBe(false);
    });

    test.each(COMMA_FORMS)("%s is served as an octet-stream with nosniff", async (value) => {
        const res = await serve(value);
        expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    test("an active type behind a comma cannot dodge the sandbox decision", async () => {
        const res = await serve("image/png, text/html");
        expect(res.headers.get("Content-Type")).not.toContain("html");
    });

    test("the kernel header builder reads the same parse", () => {
        const { headers } = buildRangeResponseHeaders({
            totalSize: 10,
            range: null,
            contentType: "image/png;,text/html",
            etag: undefined,
            lastModified: undefined,
        });
        expect(headers["Content-Type"]).toBe("application/octet-stream");
    });

    test("charset enforcement reads the parsed parameter, not a substring", async () => {
        const res = await serve("text/plain; x=charset");
        expect(res.headers.get("Content-Type")).toBe("text/plain; x=charset; charset=utf-8");
    });

    test("a declared charset is kept", async () => {
        const res = await serve("text/plain; charset=latin1");
        expect(res.headers.get("Content-Type")).toBe("text/plain; charset=latin1");
    });
});
