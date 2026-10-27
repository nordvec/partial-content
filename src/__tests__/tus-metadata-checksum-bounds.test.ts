/**
 * Creation metadata is bounded and stored without a prototype, and checksum
 * algorithm tokens are case-insensitive and validated when the handler is
 * built.
 */
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { createTusHandler, parseUploadMetadata, type TusCreation, type TusHandlerOptions } from "../tus.ts";
import { memoryUploadStore } from "../memory.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");

function harness(extra: Partial<TusHandlerOptions> = {}) {
    const objects = {};
    const creations: TusCreation[] = [];
    const handler = createTusHandler(memoryUploadStore({ objects }), {
        key: (c) => {
            creations.push(c);
            return "k";
        },
        location: (t) => `/files/${t}`,
        policy: { maxSize: 1024 },
        ...extra,
    });
    return { handler, creations };
}

function creation(headers: Record<string, string>, body?: string): Request {
    return new Request("http://localhost/files", {
        method: "POST",
        headers: {
            "Tus-Resumable": "1.0.0",
            "Upload-Length": String(body?.length ?? 0),
            ...(body === undefined
                ? {}
                : { "Content-Type": "application/offset+octet-stream", "Content-Length": String(body.length) }),
            ...headers,
        },
        body,
    });
}

const pairs = (n: number) => Array.from({ length: n }, (_, i) => `k${i} ${b64("v")}`).join(",");

describe("Upload-Metadata bounds", () => {
    test("more pairs than the default cap is refused with 400 before any resource exists", async () => {
        const { handler, creations } = harness();
        expect((await handler(creation({ "Upload-Metadata": pairs(33) }))).status).toBe(400);
        expect(creations).toHaveLength(0);
        expect((await handler(creation({ "Upload-Metadata": pairs(32) }))).status).toBe(201);
    });

    test("a header longer than the default byte cap is refused with 400", async () => {
        const { handler, creations } = harness();
        const big = `filename ${b64("x".repeat(3100))}`;
        expect(big.length).toBeGreaterThan(4096);
        expect((await handler(creation({ "Upload-Metadata": big }))).status).toBe(400);
        expect(creations).toHaveLength(0);
    });

    test("the caps are configurable on the handler", async () => {
        const { handler } = harness({ metadataLimits: { maxPairs: 2, maxBytes: 64 } });
        expect((await handler(creation({ "Upload-Metadata": pairs(3) }))).status).toBe(400);
        expect((await handler(creation({ "Upload-Metadata": `a ${b64("x".repeat(60))}` }))).status).toBe(400);
        expect((await handler(creation({ "Upload-Metadata": pairs(2) }))).status).toBe(201);
    });

    test("an unusable cap is refused at construction, naming the option", () => {
        for (const bad of [0, -1, 1.5, NaN]) {
            expect(() => harness({ metadataLimits: { maxPairs: bad } })).toThrow(/metadataLimits\.maxPairs/);
            expect(() => harness({ metadataLimits: { maxBytes: bad } })).toThrow(/metadataLimits\.maxBytes/);
        }
    });

    test("parseUploadMetadata applies the same caps", () => {
        expect(parseUploadMetadata(pairs(33))).toBeNull();
        expect(parseUploadMetadata(pairs(3), { maxPairs: 2 })).toBeNull();
        expect(parseUploadMetadata(pairs(3), { maxPairs: 3 })).not.toBeNull();
    });
});

describe("Upload-Metadata storage", () => {
    test("prototype-named keys are stored as plain own entries on a null-prototype object", async () => {
        const { handler, creations } = harness();
        const header = `__proto__ ${b64("p")},constructor ${b64("c")},toString ${b64("t")}`;
        expect((await handler(creation({ "Upload-Metadata": header }))).status).toBe(201);
        const metadata = creations[0]!.metadata;
        expect(Object.getPrototypeOf(metadata)).toBeNull();
        expect(Object.keys(metadata)).toEqual(["__proto__", "constructor", "toString"]);
        expect(metadata["__proto__"]).toBe("p");
        expect(metadata["constructor"]).toBe("c");
        expect(({} as Record<string, unknown>)["p"]).toBeUndefined();
    });

    test("an absent key reads undefined rather than an inherited member", () => {
        const metadata = parseUploadMetadata(`filename ${b64("a.txt")}`)!;
        expect(metadata["constructor"]).toBeUndefined();
        expect(metadata["hasOwnProperty"]).toBeUndefined();
        expect(Object.getPrototypeOf(parseUploadMetadata(null))).toBeNull();
    });
});

describe("checksum algorithm tokens", () => {
    const sha1 = (s: string) => createHash("sha1").update(s).digest();

    test("a configured token matches a request token in any case, and the hook sees the configured spelling", async () => {
        const seen: string[] = [];
        const { handler } = harness({
            checksum: {
                algorithms: ["SHA1"],
                maxBufferBytes: 1024,
                digest: (algorithm, content) => {
                    seen.push(algorithm);
                    return sha1(new TextDecoder().decode(content));
                },
            },
        });
        const options = await handler(new Request("http://localhost/files", { method: "OPTIONS" }));
        expect(options.headers.get("Tus-Checksum-Algorithm")).toBe("sha1");
        const res = await handler(creation({ "Upload-Checksum": `sha1 ${sha1("abc").toString("base64")}` }, "abc"));
        expect(res.status).toBe(201);
        expect(seen).toEqual(["SHA1"]);
    });

    test("a token outside the header grammar or a case-insensitive duplicate is refused at construction", () => {
        const mk = (algorithms: string[]) => () =>
            harness({ checksum: { algorithms, maxBufferBytes: 1024, digest: () => new Uint8Array(20) } });
        expect(mk(["sha 1"])).toThrow(TypeError);
        expect(mk(["md5,crc32"])).toThrow(TypeError);
        expect(mk([""])).toThrow(TypeError);
        expect(mk(["sha1", "SHA1"])).toThrow(TypeError);
        expect(mk(["sha1", "md5"])).not.toThrow();
    });

    test("a list without sha1, which tus 1.0 requires of every checksum server, is refused at construction", () => {
        const mk = (algorithms: string[]) => () =>
            harness({ checksum: { algorithms, maxBufferBytes: 1024, digest: () => new Uint8Array(32) } });
        expect(mk(["sha256"])).toThrow(/sha1/);
        expect(mk(["md5", "sha512"])).toThrow(/sha1/);
        expect(mk(["Sha1", "sha256"])).not.toThrow();
    });
});
