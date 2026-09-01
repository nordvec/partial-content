import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { buildRangeResponseHeaders, isSha256Base64 } from "../kernel";

/**
 * RFC 9530 publishes worked examples with byte-for-byte field values. Asserting
 * against those rather than against our own expectations is the difference
 * between "this is what we emit" and "this is what the standard says to emit":
 * a shared expectation the specification authors wrote down, which no amount of
 * internally consistent reasoning can substitute for.
 *
 * https://www.rfc-editor.org/rfc/rfc9530.html
 */

/** RFC 9530 Section 2, the running example body used throughout the document. */
const EXAMPLE_BODY = `{"hello": "world"}`;
/** RFC 9530 Section 2: `sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:` */
const EXAMPLE_SHA256_B64 = "X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=";

const sha256Base64 = (text: string) => createHash("sha256").update(text).digest("base64");

describe("RFC 9530 worked vectors", () => {
    test("the document's own example body hashes to the value it publishes", () => {
        // If this fails, our understanding of what the field carries is wrong
        // before any header is built: the value is the raw base64 of the
        // digest bytes, not hex and not the digest of anything encoded.
        expect(sha256Base64(EXAMPLE_BODY)).toBe(EXAMPLE_SHA256_B64);
        expect(isSha256Base64(EXAMPLE_SHA256_B64)).toBe(true);
    });

    test("a full response emits both fields in the spec's sf-binary form", () => {
        const { headers, status } = buildRangeResponseHeaders({
            range: null,
            totalSize: EXAMPLE_BODY.length,
            contentType: "application/json",
            etag: undefined,
            lastModified: undefined,
            digest: EXAMPLE_SHA256_B64,
        });

        // Section 2: the value is a Structured Fields Dictionary whose member
        // is a Byte Sequence, so the digest is wrapped in colons.
        expect(status).toBe(200);
        expect(headers["Repr-Digest"]).toBe(`sha-256=:${EXAMPLE_SHA256_B64}:`);
        expect(headers["Content-Digest"]).toBe(`sha-256=:${EXAMPLE_SHA256_B64}:`);
    });

    test("a 206 carries the representation digest and not a content digest", () => {
        // Appendix B.3 works through exactly this case: on a partial response
        // the two fields diverge, because Content-Digest covers the bytes in
        // THIS message while Repr-Digest covers the whole representation.
        // Emitting the whole-representation value under Content-Digest would
        // assert a digest for content that was never sent.
        const { headers, status } = buildRangeResponseHeaders({
            range: { start: 0, end: 3 },
            totalSize: EXAMPLE_BODY.length,
            contentType: "application/json",
            etag: undefined,
            lastModified: undefined,
            digest: EXAMPLE_SHA256_B64,
        });

        expect(status).toBe(206);
        expect(headers["Repr-Digest"]).toBe(`sha-256=:${EXAMPLE_SHA256_B64}:`);
        expect(headers["Content-Digest"]).toBeUndefined();
        expect(headers["Content-Range"]).toBe(`bytes 0-3/${EXAMPLE_BODY.length}`);
    });

    test("a value that is not a 32-byte digest is not framed as one", () => {
        // Section 2 defines the member as a Byte Sequence of the digest. A
        // malformed value framed as sf-binary is worse than no field: a
        // recipient must discard it at best, and treats it as an integrity
        // assertion at worst.
        for (const bad of ["", "not-base64!!", "c2hvcnQ=", `${EXAMPLE_SHA256_B64}extra`]) {
            const { headers } = buildRangeResponseHeaders({
                range: null,
                totalSize: 18,
                contentType: "application/json",
                etag: undefined,
                lastModified: undefined,
                digest: bad,
            });
            expect(headers["Repr-Digest"]).toBeUndefined();
            expect(headers["Content-Digest"]).toBeUndefined();
        }
    });

    test("the unpadded encoding of the same digest is accepted on input", () => {
        // 43 characters decode to the same 32 bytes, so rejecting the form
        // would discard a valid digest over a formatting difference.
        expect(isSha256Base64(EXAMPLE_SHA256_B64.slice(0, 43))).toBe(true);
    });
});
