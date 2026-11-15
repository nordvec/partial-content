import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { bytesToBase64 } from "../base64.ts";

describe("bytesToBase64", () => {
    const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

    test("standard base64 is RFC 4648's, padding included", () => {
        // The RFC 4648 Section 10 test vectors.
        expect(bytesToBase64(ascii(""))).toBe("");
        expect(bytesToBase64(ascii("f"))).toBe("Zg==");
        expect(bytesToBase64(ascii("fo"))).toBe("Zm8=");
        expect(bytesToBase64(ascii("foo"))).toBe("Zm9v");
        expect(bytesToBase64(ascii("foobar"))).toBe("Zm9vYmFy");
    });

    test("agrees with the platform encoder on any bytes", () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
                expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
            }),
            { numRuns: 300 },
        );
    });
});
