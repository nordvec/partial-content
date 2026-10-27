import { describe, test, expect } from "bun:test";
import { newUploadId, decodeUploadId, UPLOAD_ID_RE } from "../upload-internals.ts";
import { UploadNotFoundError } from "../upload-store.ts";

/**
 * An upload token is the resource id and carries nothing else. The destination
 * key never travels to the client and can never arrive from one, so a request
 * cannot name a backend object the server did not record for this upload, and
 * one resource has exactly one token string.
 */
describe("upload token identity", () => {
    test("a minted id is UUID-shaped and round-trips", () => {
        const id = newUploadId();
        expect(id).toMatch(UPLOAD_ID_RE);
        expect(decodeUploadId(id)).toBe(id);
    });

    test("minted ids do not repeat", () => {
        const ids = new Set(Array.from({ length: 500 }, () => newUploadId()));
        expect(ids.size).toBe(500);
    });

    /** Mint with no `randomUUID`, every random byte set to `fill`. */
    function mintWithoutRandomUUID(fill: number): string {
        const crypto = globalThis.crypto;
        Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
        Object.defineProperty(crypto, "getRandomValues", {
            value: <T extends ArrayBufferView | null>(array: T): T => {
                if (array instanceof Uint8Array) array.fill(fill);
                return array;
            },
            configurable: true,
        });
        try {
            return newUploadId();
        } finally {
            // The own properties shadow the prototype's methods; deleting them
            // restores the real ones.
            Reflect.deleteProperty(crypto, "randomUUID");
            Reflect.deleteProperty(crypto, "getRandomValues");
        }
    }

    test("a runtime without randomUUID still mints a version-4 UUID", () => {
        // The shape is what decodeUploadId accepts, so an id minted in any other
        // shape is an upload that can never be resumed. The version nibble and
        // the variant bits are forced whatever the random bytes were.
        expect(mintWithoutRandomUUID(0xff)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
        expect(mintWithoutRandomUUID(0x00)).toBe("00000000-0000-4000-8000-000000000000");
        const id = mintWithoutRandomUUID(0x5a);
        expect(id).toBe("5a5a5a5a-5a5a-4a5a-9a5a-5a5a5a5a5a5a");
        expect(decodeUploadId(id)).toBe(id);
        expect(typeof globalThis.crypto.randomUUID).toBe("function");
    });

    test("anything that is not a minted id is refused", () => {
        for (const forged of [
            "eyJrZXkiOiJ0ZW5hbnRzL2FjbWUvcGF5cm9sbC5jc3YifQ", // a key-bearing payload
            "00000000-0000-4000-8000-00000000000", // one digit short
            "00000000-0000-4000-8000-0000000000000", // one digit long
            "00000000000040008000000000000000", // undashed
            "00000000-0000-4000-8000-00000000000G", // non-hex
            "../../etc/passwd",
            "",
        ]) {
            expect(() => decodeUploadId(forged)).toThrow(UploadNotFoundError);
        }
    });

    test("the id is the whole token, so there is no second spelling of one resource", () => {
        // Appends are serialized by locking on the token STRING. A format that
        // admitted several encodings of one resource would hand a client a
        // second lock over it, and two appends could then clear the same offset
        // preflight and write the same slot.
        const id = newUploadId();
        expect(decodeUploadId(id)).toBe(id);
        expect(() => decodeUploadId(id.toUpperCase())).toThrow(UploadNotFoundError);
        expect(() => decodeUploadId(` ${id}`)).toThrow(UploadNotFoundError);
        expect(() => decodeUploadId(`${id}=`)).toThrow(UploadNotFoundError);
    });
});
