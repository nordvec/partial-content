import { describe, test, expect } from "bun:test";
import { serveObject } from "../hono";
import type { ObjectStore } from "../index";

// ─── Minimal Hono-shaped context ────────────────────────────────────────────

function honoContext(opts: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
}) {
    const method = opts.method ?? "GET";
    const raw = new Request(opts.url ?? "http://localhost/files/test.bin", {
        method,
        headers: opts.headers,
    });
    return {
        req: {
            raw,
            param: (name: string) => opts.params?.[name] ?? "",
            header: (name: string) => raw.headers.get(name) ?? undefined,
            method,
        },
    };
}

const CONTENT = new TextEncoder().encode("hono-serve-test-1234"); // 20 bytes

function memoryStore(): ObjectStore {
    return {
        supportsRange: true,
        headObject: async () => ({
            contentLength: CONTENT.length,
            etag: '"hono-etag"',
        }),
        getObject: async (_key, getOpts) => {
            const range = getOpts?.range;
            const slice = range ? CONTENT.slice(range.start, range.end + 1) : CONTENT;
            return {
                body: new ReadableStream<Uint8Array>({
                    start(c) { c.enqueue(slice); c.close(); },
                }),
                contentLength: slice.length,
                totalSize: CONTENT.length,
                range: range ? { start: range.start, end: range.end } : undefined,
                etag: '"hono-etag"',
            };
        },
    };
}

describe("hono adapter", () => {
    test("extracts the key from route params and serves 200", async () => {
        const keys: string[] = [];
        const store = memoryStore();
        const origGet = store.getObject.bind(store);
        store.getObject = (key, getOpts) => {
            keys.push(key);
            return origGet(key, getOpts);
        };

        const handler = serveObject(store, {
            key: (c) => c.req.param("key"),
            mime: () => "application/pdf",
        });
        const res = await handler(honoContext({ params: { key: "reports/q4.pdf" } }));

        expect(res.status).toBe(200);
        expect(keys).toEqual(["reports/q4.pdf"]);
        expect(res.headers.get("Content-Type")).toBe("application/pdf");
    });

    test("range requests flow through to 206", async () => {
        const handler = serveObject(memoryStore(), { key: () => "k" });
        const res = await handler(honoContext({ headers: { Range: "bytes=0-4" } }));

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("hono-");
    });

    test("HEAD is detected from the context method", async () => {
        const handler = serveObject(memoryStore(), { key: () => "k" });
        const res = await handler(honoContext({ method: "HEAD" }));

        expect(res.status).toBe(200);
        expect(res.body).toBeNull();
        expect(res.headers.get("Content-Length")).toBe("20");
    });

    test("conditional GET returns 304", async () => {
        const handler = serveObject(memoryStore(), { key: () => "k" });
        const res = await handler(
            honoContext({ headers: { "If-None-Match": '"hono-etag"' } }),
        );
        expect(res.status).toBe(304);
    });
});
