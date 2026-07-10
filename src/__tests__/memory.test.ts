import { describe, test, expect } from "bun:test";
import { memoryStore, ObjectNotFoundError, ObjectChangedError } from "../memory";

async function drain(body: ReadableStream<Uint8Array> | Uint8Array): Promise<string> {
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

describe("memoryStore", () => {
    const objects = {
        "hello.txt": {
            body: "0123456789abcdefghij",
            etag: '"v1"',
            lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
        },
        "empty.bin": { body: new Uint8Array(0) },
    };

    test("headObject reports size and validators (string body as UTF-8)", async () => {
        const store = memoryStore({ objects });
        const meta = await store.headObject("hello.txt");

        expect(meta.contentLength).toBe(20);
        expect(meta.etag).toBe('"v1"');
        expect(meta.lastModified).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
    });

    test("getObject streams the full body", async () => {
        const store = memoryStore({ objects });
        const result = await store.getObject("hello.txt");

        expect(await drain(result.body)).toBe("0123456789abcdefghij");
        expect(result.totalSize).toBe(20);
        expect(result.range).toBeUndefined();
    });

    test("mutating a string body between requests serves fresh bytes (encode cache invalidates)", async () => {
        // The objects map is mutable by reference (the documented way to
        // simulate overwrites); the encode cache must not serve stale bytes.
        const mutable = { "doc.txt": { body: "original", etag: '"v1"' } };
        const store = memoryStore({ objects: mutable });

        expect(await drain((await store.getObject("doc.txt")).body)).toBe("original");
        expect((await store.headObject("doc.txt")).contentLength).toBe("original".length);

        mutable["doc.txt"].body = "a much longer replacement body";
        expect(await drain((await store.getObject("doc.txt")).body)).toBe("a much longer replacement body");
        expect((await store.headObject("doc.txt")).contentLength).toBe("a much longer replacement body".length);
    });

    test("ranged read fabricates a correct Content-Range", async () => {
        const store = memoryStore({ objects });
        const result = await store.getObject("hello.txt", { range: { start: 15, end: 19 } });

        expect(await drain(result.body)).toBe("fghij");
        expect(result.contentLength).toBe(5);
        expect(result.range).toEqual({ start: 15, end: 19 });
    });

    test("zero-byte objects stream an empty body", async () => {
        const store = memoryStore({ objects });
        const result = await store.getObject("empty.bin");

        expect(await drain(result.body)).toBe("");
        expect(result.contentLength).toBe(0);
    });

    test("missing keys throw ObjectNotFoundError", async () => {
        const store = memoryStore({ objects });
        await expect(store.headObject("nope")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject("nope")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("inherited prototype keys are honest 404s, not truthy non-entries", async () => {
        // Keys are attacker-controlled in the demo setups; a plain-object map
        // resolves "constructor"/"__proto__"/"toString" to prototype members.
        const store = memoryStore({ objects });
        for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
            await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
    });

    test("ifMatch pin: etag mismatch throws ObjectChangedError", async () => {
        const store = memoryStore({ objects });
        await expect(
            store.getObject("hello.txt", { ifMatch: '"stale"' }),
        ).rejects.toBeInstanceOf(ObjectChangedError);
    });

    test("mutating the map between requests simulates an overwrite (retry testing)", async () => {
        const live = { "doc.txt": { body: "version-one", etag: '"v1"' } };
        const store = memoryStore({ objects: live });

        const before = await store.headObject("doc.txt");
        expect(before.etag).toBe('"v1"');

        live["doc.txt"] = { body: "version-two!", etag: '"v2"' };

        // Pinned read against the old validator now fails, as a real backend would.
        await expect(
            store.getObject("doc.txt", { ifMatch: '"v1"' }),
        ).rejects.toBeInstanceOf(ObjectChangedError);

        // Unpinned read sees the new version.
        const after = await store.getObject("doc.txt");
        expect(await drain(after.body)).toBe("version-two!");
    });
});

describe("memoryStore contract edges", () => {
    test("range start beyond EOF throws a loud RangeError (direct-caller contract)", async () => {
        const store = memoryStore({ objects: { k: { body: "hello" } } });
        await expect(
            store.getObject("k", { range: { start: 10, end: 20 } }),
        ).rejects.toThrow(RangeError);
    });

    test("range end beyond EOF is clamped and the SERVED bounds are reported", async () => {
        const store = memoryStore({ objects: { k: { body: "hello" } } });
        const res = await store.getObject("k", { range: { start: 2, end: 999 } });
        expect(res.range).toEqual({ start: 2, end: 4 });
        expect(res.contentLength).toBe(3);
        expect(res.totalSize).toBe(5);
    });
});
