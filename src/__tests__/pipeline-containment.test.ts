import { describe, expect, test } from "bun:test";
import { memoryStore } from "../memory";
import type { ObjectStore } from "../index";
import { isObjectChangedError } from "../index";
import { serveObject } from "../web";

const BYTES = new Uint8Array(1000).map((_, i) => i % 251);

const get = (handler: ReturnType<typeof serveObject>, ctx: { key: string; mime: string }, range?: string) =>
    handler({ method: "GET", headers: new Headers(range ? { Range: range } : {}) }, ctx);

describe("a store that ignores Range on a multi-range request", () => {
    function rangeIgnoring() {
        const inner = memoryStore({ objects: { "big.bin": { body: BYTES } } });
        const reads: unknown[] = [];
        const store: ObjectStore = {
            ...inner,
            authoritativeRange: false,
            async getObject(key, opts) {
                reads.push(opts?.range);
                const { range: _range, ...rest } = opts ?? {};
                return inner.getObject(key, rest);
            },
        };
        return { store, reads };
    }

    test("answers the whole representation as a 200 after one read", async () => {
        const { store, reads } = rangeIgnoring();
        const errors: unknown[] = [];
        const res = await get(
            serveObject(store, { onError: (e) => errors.push(e) }),
            { key: "big.bin", mime: "application/octet-stream" },
            "bytes=0-1,500-501",
        );
        expect(res.status).toBe(200);
        expect(new Uint8Array(await new Response(res.body).arrayBuffer())).toEqual(BYTES);
        expect(res.headers.get("content-range")).toBeNull();
        expect(reads).toHaveLength(1);
        expect(errors).toEqual([]);
    });

    test("past the read cap, the coalesced read also answers 200 with the whole body", async () => {
        const { store, reads } = rangeIgnoring();
        const errors: unknown[] = [];
        // Nine parts exceed maxBackendReads (8), so one buffered read of the span serves them all.
        const ranges = Array.from({ length: 9 }, (_, i) => `${i * 100}-${i * 100 + 1}`).join(",");
        const res = await get(
            serveObject(store, { maxRanges: 20, onError: (e) => errors.push(e) }),
            { key: "big.bin", mime: "application/octet-stream" },
            `bytes=${ranges}`,
        );
        expect(res.status).toBe(200);
        expect(new Uint8Array(await new Response(res.body).arrayBuffer())).toEqual(BYTES);
        expect(res.headers.get("content-range")).toBeNull();
        expect(reads).toHaveLength(1);
        expect(errors).toEqual([]);
    });

    test("a served span that disagrees with the first part is still a change", async () => {
        const inner = memoryStore({ objects: { "big.bin": { body: BYTES } } });
        const errors: unknown[] = [];
        const store: ObjectStore = {
            ...inner,
            authoritativeRange: false,
            async getObject(key, opts) {
                const s = await inner.getObject(key, opts);
                return s.range ? { ...s, range: { ...s.range, end: s.range.end + 1 } } : s;
            },
        };
        const res = await get(
            serveObject(store, { onError: (e) => errors.push(e) }),
            { key: "big.bin", mime: "application/octet-stream" },
            "bytes=0-1,500-501",
        );
        expect(res.status).toBe(502);
        expect(errors.some(isObjectChangedError)).toBe(true);
    });
});

describe("a throwing policy callback", () => {
    const store = memoryStore({ objects: { "a.bin": { body: BYTES } } });
    const ctx = { key: "a.bin", mime: "application/octet-stream" };
    const boom = (): never => {
        throw new Error("policy lookup failed");
    };
    const cases: [string, Parameters<typeof serveObject>[1]][] = [
        ["disposition", { disposition: boom }],
        ["securityHeaders", { securityHeaders: boom }],
        ["preferSignedUrl", { preferSignedUrl: boom }],
    ];

    for (const [name, opts] of cases) {
        test(`${name} answers a 500 and reports operation "context"`, async () => {
            const seen: { err: unknown; operation: string }[] = [];
            const handler = serveObject(
                { ...store, createSignedUrl: async () => ({ ok: false, error: "declined" }) },
                { ...opts, onError: (err, c) => seen.push({ err, operation: c.operation }) },
            );
            const res = await get(handler, ctx);
            expect(res.status).toBe(500);
            expect(res.headers.get("x-content-type-options")).toBe("nosniff");
            expect(res.headers.get("cache-control")).toBe("no-store");
            expect(await res.text()).toBe("Internal Server Error");
            expect(seen).toHaveLength(1);
            expect(seen[0]!.operation).toBe("context");
        });
    }

    test("a non-string mime is a 500, not a rejection", async () => {
        const res = await get(serveObject(store), { key: "a.bin", mime: 42 as unknown as string });
        expect(res.status).toBe(500);
    });

    test("a throwing onError does not strand the body of an incoherent read", async () => {
        let cancelled = false;
        const inner = memoryStore({ objects: { "a.bin": { body: BYTES } } });
        const incoherent: ObjectStore = {
            ...inner,
            async getObject() {
                return {
                    // A stream the store still holds open, claiming a length it does not have.
                    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
                        cancel() {
                            cancelled = true;
                        },
                    }),
                    contentLength: 5,
                    totalSize: BYTES.length,
                };
            },
        };
        // A failing error sink is swallowed (there is no sink for the sink); the body is released regardless.
        const outcome = await get(
            serveObject(incoherent, {
                onError: () => {
                    throw new Error("sink is down");
                },
            }),
            ctx,
        );
        expect(outcome.status).toBe(502);
        expect(cancelled).toBe(true);
    });

    test("under an auditKey onError receives the projection", async () => {
        const errors: unknown[] = [];
        const res = await serveObject(store, { securityHeaders: boom, onError: (e) => errors.push(e) })(
            { method: "GET", headers: new Headers() },
            { ...ctx, auditKey: "audit-1" },
        );
        expect(res.status).toBe(500);
        expect(errors).toEqual([{ name: "Error", operation: "context" }]);
    });
});
