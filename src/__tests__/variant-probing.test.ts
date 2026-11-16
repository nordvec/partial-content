import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { memoryStore } from "../memory";
import { ObjectNotFoundError, type ObjectStore } from "../index";
import { serveObject } from "../web";

const PLAIN = new TextEncoder().encode("plain-identity-bytes-".repeat(20));
const BR = new TextEncoder().encode("brotli-bytes-".repeat(5));
const GZ = new TextEncoder().encode("gzip-bytes-".repeat(5));

const ASK = { "accept-encoding": "gzip, deflate, br, zstd" };
const run = (handler: ReturnType<typeof serveObject>, headers: Record<string, string> = ASK) =>
    handler({ method: "GET", headers: new Headers(headers) }, { key: "app.json", mime: "application/json" });

/**
 * A store that records every key it is asked about (HEADs, and GETs with the
 * bodies later cancelled) and how many HEADs ran at once.
 */
function probed(inner: ObjectStore, delayMs = 0) {
    const heads: string[] = [];
    const gets: string[] = [];
    const cancelled: string[] = [];
    const calls: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const store: ObjectStore = {
        ...inner,
        async getObject(key, opts) {
            gets.push(key);
            calls.push(`GET ${key}`);
            const got = await inner.getObject(key, opts);
            const source = got.body instanceof Uint8Array ? new Response(got.body).body! : got.body;
            const reader = source.getReader();
            const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
                async pull(controller) {
                    const next = await reader.read();
                    if (next.done) controller.close();
                    else controller.enqueue(next.value as Uint8Array<ArrayBuffer>);
                },
                async cancel(reason) {
                    cancelled.push(key);
                    await reader.cancel(reason);
                },
            });
            return { ...got, body };
        },
        async headObject(key, opts) {
            heads.push(key);
            calls.push(`HEAD ${key}`);
            inFlight++;
            peak = Math.max(peak, inFlight);
            try {
                if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
                return await inner.headObject(key, opts);
            } finally {
                inFlight--;
            }
        },
    };
    return { store, heads, gets, cancelled, calls, peak: () => peak };
}

afterEach(() => setSystemTime());

describe("variant probing", () => {
    test("the candidate variants are probed together, not one after another", async () => {
        const p = probed(memoryStore({ objects: { "app.json": { body: PLAIN } } }), 25);
        const res = await run(serveObject(p.store, { precompressed: true }));
        expect(res.status).toBe(200);
        expect(p.heads.toSorted()).toEqual(["app.json", "app.json.br", "app.json.gz", "app.json.zst"]);
        // Concurrency is read from the store's in-flight count, never from
        // wall-clock time, which a loaded machine stretches past any bound.
        expect(p.peak()).toBe(4);
    });

    test("the best-ranked hit wins whichever probe answers first", async () => {
        const inner = memoryStore({
            objects: { "app.json": { body: PLAIN }, "app.json.br": { body: BR }, "app.json.gz": { body: GZ } },
        });
        const res = await run(serveObject(inner, { precompressed: true }));
        expect(res.headers.get("content-encoding")).toBe("br");
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(BR);
    });

    test("a miss is remembered, so the next request does not probe again", async () => {
        const p = probed(memoryStore({ objects: { "app.json": { body: PLAIN } } }));
        const handler = serveObject(p.store, { precompressed: true });
        await run(handler);
        const afterFirst = p.heads.length;
        expect(afterFirst).toBe(4);
        const second = await run(handler);
        expect(second.status).toBe(200);
        expect(p.heads.length).toBe(afterFirst);
    });

    test("a hit does not stop the lower-ranked misses probed alongside it from being remembered", async () => {
        const p = probed(memoryStore({ objects: { "app.json": { body: PLAIN }, "app.json.br": { body: BR } } }));
        const handler = serveObject(p.store, { precompressed: true });
        expect((await run(handler)).headers.get("content-encoding")).toBe("br");
        expect(p.heads).toHaveLength(4);
        expect((await run(handler)).headers.get("content-encoding")).toBe("br");
        // Only the variant that exists and the identity that authorizes it are asked about again,
        // the variant by its read: a plain GET needs no HEAD of it first.
        expect(p.heads.slice(4)).toEqual(["app.json"]);
        expect(p.gets.slice(1)).toEqual(["app.json.br"]);
    });

    test("a remembered winner ends the probing at it, while a better-ranked unknown is still probed", async () => {
        const p = probed(
            memoryStore({
                objects: { "app.json": { body: PLAIN }, "app.json.zst": { body: BR }, "app.json.gz": { body: GZ } },
            }),
        );
        const handler = serveObject(p.store, { precompressed: true });
        expect((await run(handler)).headers.get("content-encoding")).toBe("zstd");
        p.heads.length = 0;
        p.gets.length = 0;
        // br is a remembered miss, zstd a remembered winner: gz ranks below and is never asked about.
        expect((await run(handler)).headers.get("content-encoding")).toBe("zstd");
        expect(p.heads).toEqual(["app.json"]);
        expect(p.gets).toEqual(["app.json.zst"]);
        p.heads.length = 0;
        p.gets.length = 0;
        // A client that accepts only gzip learns gz on its own, whatever zstd's memo says.
        expect((await run(handler, { "accept-encoding": "gzip" })).headers.get("content-encoding")).toBe("gzip");
        expect(p.heads.toSorted()).toEqual(["app.json", "app.json.gz"]);
    });

    test("a key too long to remember is probed every time", async () => {
        const key = `${"d".repeat(2000)}.json`;
        const p = probed(memoryStore({ objects: { [key]: { body: PLAIN } } }));
        const handler = serveObject(p.store, { precompressed: true });
        const ask = () => handler({ method: "GET", headers: new Headers(ASK) }, { key, mime: "application/json" });
        await ask();
        await ask();
        expect(p.heads).toHaveLength(8);
    });

    test("a remembered miss expires, and a variant uploaded since is served", async () => {
        const objects: Record<string, { body: Uint8Array }> = { "app.json": { body: PLAIN } };
        const handler = serveObject(memoryStore({ objects }), { precompressed: true });
        const now = Date.now();
        setSystemTime(new Date(now));
        expect((await run(handler)).headers.get("content-encoding")).toBeNull();
        objects["app.json.br"] = { body: BR };
        // Inside the window the miss still stands: identity is a correct answer.
        expect((await run(handler)).headers.get("content-encoding")).toBeNull();
        setSystemTime(new Date(now + 31_000));
        expect((await run(handler)).headers.get("content-encoding")).toBe("br");
    });

    test("a probe failure other than not-found serves identity and reports once", async () => {
        const inner = memoryStore({ objects: { "app.json": { body: PLAIN } } });
        const errors: unknown[] = [];
        const outage: ObjectStore = {
            ...inner,
            async headObject(key, opts) {
                if (key.endsWith(".br")) throw new Error("backend down");
                return inner.headObject(key, opts);
            },
        };
        const res = await run(serveObject(outage, { precompressed: true, onError: (e) => errors.push(e) }));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(errors).toHaveLength(1);
    });
});

describe("a variant is served only under the identity object's authority", () => {
    const OLD = "Sat, 01 Jan 2022 00:00:00 GMT";
    const NEW = "Sun, 01 Jan 2023 00:00:00 GMT";

    test("a variant whose identity object does not exist is a 404, not a 200", async () => {
        const store = memoryStore({ objects: { "app.json.br": { body: BR } } });
        const res = await run(serveObject(store, { precompressed: true }));
        expect(res.status).toBe(404);
        expect(res.headers.get("content-encoding")).toBeNull();
    });

    test("deleting the identity stops its variants being served", async () => {
        const objects: Record<string, { body: Uint8Array }> = {
            "app.json": { body: PLAIN },
            "app.json.br": { body: BR },
        };
        const handler = serveObject(memoryStore({ objects }), { precompressed: true });
        expect((await run(handler)).headers.get("content-encoding")).toBe("br");
        delete objects["app.json"];
        expect((await run(handler)).status).toBe(404);
    });

    test("a variant older than the identity is skipped and the identity is served", async () => {
        const store = memoryStore({
            objects: {
                "app.json": { body: PLAIN, lastModified: NEW },
                "app.json.br": { body: BR, lastModified: OLD },
            },
        });
        const res = await run(serveObject(store, { precompressed: true }));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PLAIN);
    });

    test("a variant as new as the identity is served", async () => {
        const store = memoryStore({
            objects: {
                "app.json": { body: PLAIN, lastModified: OLD },
                "app.json.br": { body: BR, lastModified: NEW },
            },
        });
        expect((await run(serveObject(store, { precompressed: true }))).headers.get("content-encoding")).toBe("br");
    });

    test("a failing identity HEAD fails the request as a store error, reported once", async () => {
        const inner = memoryStore({ objects: { "app.json": { body: PLAIN }, "app.json.br": { body: BR } } });
        const errors: unknown[] = [];
        const outage: ObjectStore = {
            ...inner,
            async headObject(key, opts) {
                if (key === "app.json") throw new Error("backend down");
                return inner.headObject(key, opts);
            },
        };
        const res = await run(serveObject(outage, { precompressed: true, onError: (e) => errors.push(e) }));
        expect(res.status).toBe(502);
        expect(errors).toHaveLength(1);
    });

    test("a remembered variant that vanished falls back to the identity and is forgotten", async () => {
        const objects: Record<string, { body: Uint8Array }> = {
            "app.json": { body: PLAIN },
            "app.json.br": { body: BR },
        };
        const p = probed(memoryStore({ objects }));
        const handler = serveObject(p.store, { precompressed: true });
        expect((await run(handler)).headers.get("content-encoding")).toBe("br");
        delete objects["app.json.br"];
        const res = await run(handler);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PLAIN);
    });
});

describe("a remembered variant is read in the round of the identity HEAD", () => {
    const OLD = "Sat, 01 Jan 2022 00:00:00 GMT";
    const NEW = "Sun, 01 Jan 2023 00:00:00 GMT";

    /** Both objects present and the variant remembered by a first request; the call log starts empty. */
    async function remembered(extra: Partial<Parameters<typeof serveObject>[1]> = {}) {
        const objects: Record<string, { body: Uint8Array; lastModified?: string }> = {
            "app.json": { body: PLAIN, lastModified: OLD },
            "app.json.br": { body: BR, lastModified: NEW },
        };
        const p = probed(memoryStore({ objects }));
        const handler = serveObject(p.store, { precompressed: true, ...extra });
        expect((await run(handler)).headers.get("content-encoding")).toBe("br");
        p.calls.length = 0;
        p.cancelled.length = 0;
        return { objects, p, handler };
    }

    test("the identity HEAD and the variant GET are sent together, and nothing else is", async () => {
        const objects = {
            "app.json": { body: PLAIN, lastModified: OLD },
            "app.json.br": { body: BR, lastModified: NEW },
        };
        const inner = probed(memoryStore({ objects }));
        let held: (() => void) | undefined;
        let gate: Promise<void> | undefined;
        const arm = (): void => {
            gate = new Promise<void>((resolve) => {
                held = resolve;
            });
        };
        const store: ObjectStore = {
            ...inner.store,
            async headObject(key, opts) {
                // Once the variant is remembered, the identity HEAD cannot answer until the
                // variant GET has been sent: a HEAD-then-GET sequence would never finish.
                if (gate && key === "app.json") await gate;
                return inner.store.headObject(key, opts);
            },
            async getObject(key, opts) {
                held?.();
                return inner.store.getObject(key, opts);
            },
        };
        const handler = serveObject(store, { precompressed: true });
        expect((await run(handler)).headers.get("content-encoding")).toBe("br");
        inner.calls.length = 0;
        arm();
        const res = await run(handler);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBe("br");
        expect(res.headers.get("vary")).toContain("Accept-Encoding");
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(BR);
        expect(inner.calls.toSorted()).toEqual(["GET app.json.br", "HEAD app.json"]);
    });

    test("the variant's own validators drive the response", async () => {
        const { handler } = await remembered();
        const res = await run(handler);
        expect(res.headers.get("last-modified")).toBe(NEW);
        expect(res.headers.get("content-length")).toBe(String(BR.length));
    });

    test("an identity newer than the variant is served, the variant body is released and the variant is forgotten", async () => {
        const { objects, p, handler } = await remembered();
        objects["app.json"] = { body: PLAIN, lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" };
        const res = await run(handler);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PLAIN);
        expect(p.calls).toEqual(["HEAD app.json", "GET app.json.br", "GET app.json"]);
        expect(p.cancelled).toEqual(["app.json.br"]);
        p.calls.length = 0;
        await run(handler);
        expect(p.calls).toEqual(["GET app.json"]);
    });

    test("a missing identity is a 404 and the variant body is released", async () => {
        const { objects, p, handler } = await remembered();
        delete objects["app.json"];
        const res = await run(handler);
        expect(res.status).toBe(404);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(p.cancelled).toEqual(["app.json.br"]);
    });

    test("a variant answered not-found clears the memo and the identity is served", async () => {
        const { objects, p, handler } = await remembered();
        delete objects["app.json.br"];
        const res = await run(handler);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PLAIN);
        expect(p.calls).toEqual(["HEAD app.json", "GET app.json.br", "GET app.json"]);
        p.calls.length = 0;
        await run(handler);
        expect(p.calls).toEqual(["GET app.json"]);
    });

    test("a variant read that fails otherwise is reported as a get and the identity is served", async () => {
        const errors: Array<{ key: string; operation: string }> = [];
        const { p, handler } = await (async () => {
            const objects = { "app.json": { body: PLAIN }, "app.json.br": { body: BR } };
            const inner = memoryStore({ objects });
            let down = false;
            const store: ObjectStore = {
                ...inner,
                async getObject(key, opts) {
                    if (down && key.endsWith(".br")) throw new Error("backend down");
                    return inner.getObject(key, opts);
                },
            };
            const p = probed(store);
            const handler = serveObject(p.store, { precompressed: true, onError: (_e, ctx) => errors.push(ctx) });
            expect((await run(handler)).headers.get("content-encoding")).toBe("br");
            down = true;
            return { p, handler };
        })();
        p.calls.length = 0;
        const res = await run(handler);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(errors).toEqual([{ key: "app.json.br", operation: "get" }]);
        expect(p.calls).toEqual(["HEAD app.json", "GET app.json.br", "GET app.json"]);
    });

    test("a range request still evaluates against the variant's HEAD before any body is opened", async () => {
        const { p, handler } = await remembered();
        const res = await run(handler, { ...ASK, range: "bytes=0-4" });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-encoding")).toBe("br");
        expect(p.calls.toSorted()).toEqual(["GET app.json.br", "HEAD app.json", "HEAD app.json.br"]);
    });

    test("a conditional request answered 304 opens no variant body", async () => {
        const { p, handler } = await remembered();
        const first = await run(handler);
        const etag = first.headers.get("etag")!;
        p.calls.length = 0;
        const res = await run(handler, { ...ASK, "if-none-match": etag });
        expect(res.status).toBe(304);
        expect(p.calls.filter((c) => c.startsWith("GET"))).toEqual([]);
    });
});

describe("a variant that disappears after the probe", () => {
    /** HEADs of the variant succeed once; every later read of it is not-found. */
    function vanishing() {
        const inner = memoryStore({
            objects: { "app.json": { body: PLAIN, etag: '"id"' }, "app.json.br": { body: BR } },
        });
        let gone = false;
        const store: ObjectStore = {
            ...inner,
            authoritativeRange: false,
            async headObject(key, opts) {
                if (key.endsWith(".br") && gone) throw new ObjectNotFoundError(key);
                const meta = await inner.headObject(key, opts);
                if (key.endsWith(".br")) gone = true;
                return meta;
            },
            async getObject(key, opts) {
                if (key.endsWith(".br") && gone) throw new ObjectNotFoundError(key);
                return inner.getObject(key, opts);
            },
        };
        return store;
    }

    test("a plain GET is answered from the identity object", async () => {
        const res = await run(serveObject(vanishing(), { precompressed: true }));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PLAIN);
    });

    test("a range request is answered from the identity object", async () => {
        const res = await run(serveObject(vanishing(), { precompressed: true }), { ...ASK, range: "bytes=0-4" });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(res.headers.get("content-range")).toBe(`bytes 0-4/${PLAIN.length}`);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PLAIN.subarray(0, 5));
    });

    test("an object that is really gone is still a 404", async () => {
        const res = await serveObject(memoryStore({ objects: {} }), { precompressed: true })(
            { method: "GET", headers: new Headers(ASK) },
            { key: "app.json", mime: "application/json" },
        );
        expect(res.status).toBe(404);
    });
});
