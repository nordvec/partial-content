/**
 * Both upload handlers refuse construction without a size ceiling: an omitted
 * `policy.maxSize` is a TypeError, and `maxSize: Infinity` is the explicit
 * opt-out, under which nothing advertises a maximum.
 */
import { describe, test, expect } from "bun:test";
import { createUploadHandler, type UploadHandlerOptions } from "../upload.ts";
import { createTusHandler, type TusHandlerOptions } from "../tus.ts";
import { memoryUploadStore } from "../memory.ts";

const store = () => memoryUploadStore({ objects: {} });

describe("policy.maxSize is required", () => {
    test("IETF: an omitted policy or maxSize is a TypeError", () => {
        const base = { key: () => "k", location: (t: string) => `/u/${t}` };
        expect(() => createUploadHandler(store(), base as unknown as UploadHandlerOptions)).toThrow(TypeError);
        expect(() =>
            createUploadHandler(store(), { ...base, policy: { maxAgeSeconds: 60 } } as unknown as UploadHandlerOptions),
        ).toThrow(/policy\.maxSize is required/);
    });

    test("tus: an omitted policy or maxSize is a TypeError", () => {
        const base = { key: () => "k", location: (t: string) => `/f/${t}` };
        expect(() => createTusHandler(store(), base as unknown as TusHandlerOptions)).toThrow(TypeError);
        expect(() =>
            createTusHandler(store(), { ...base, policy: { maxAgeSeconds: 60 } } as unknown as TusHandlerOptions),
        ).toThrow(/policy\.maxSize is required/);
    });

    test("Infinity opts out: IETF advertises no max-size", async () => {
        const handler = createUploadHandler(store(), {
            key: () => "k",
            location: (t) => `/u/${t}`,
            policy: { maxSize: Infinity },
        });
        const res = await handler(
            new Request("http://test/u", { method: "OPTIONS", headers: { "Upload-Draft-Interop-Version": "9" } }),
        );
        expect(res.headers.get("Upload-Limit") ?? "").not.toContain("max-size");
    });

    test("Infinity opts out: tus advertises no Tus-Max-Size", async () => {
        const handler = createTusHandler(store(), {
            key: () => "k",
            location: (t) => `/f/${t}`,
            policy: { maxSize: Infinity },
        });
        const res = await handler(new Request("http://test/f", { method: "OPTIONS" }));
        expect(res.status).toBe(204);
        expect(res.headers.get("Tus-Max-Size")).toBeNull();
    });
});
