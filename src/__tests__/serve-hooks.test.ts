import { describe, expect, test } from "bun:test";
import { memoryStore } from "../memory";
import type { ObjectStore } from "../index";
import { serveObject } from "../web";

const BYTES = new Uint8Array(2000).map((_, i) => i % 251);

const get = (
    handler: ReturnType<typeof serveObject>,
    ctx: { key: string; mime: string; filename?: string },
    headers: Record<string, string> = {},
) => handler({ method: "GET", headers: new Headers(headers) }, ctx);

describe("the sandbox policy on inline active content", () => {
    const store = memoryStore({ objects: { "a.svg": { body: new TextEncoder().encode("<svg/>") } } });
    const ctx = { key: "a.svg", mime: "image/svg+xml" };
    const csp = async (opts: Parameters<typeof serveObject>[1]) =>
        (await get(serveObject(store, { disposition: "inline", ...opts }), ctx)).headers.get("content-security-policy");

    test("is the default", async () => {
        expect(await csp({})).toBe("sandbox");
    });

    test("stays when a caller policy is added", async () => {
        expect(await csp({ securityHeaders: () => ({ "Content-Security-Policy": "frame-ancestors 'none'" }) })).toBe(
            "frame-ancestors 'none', sandbox",
        );
    });

    test("stays when the caller spells the header name in lower case", async () => {
        expect(await csp({ securityHeaders: () => ({ "content-security-policy": "default-src 'none'" }) })).toBe(
            "default-src 'none', sandbox",
        );
    });

    test("is not doubled when the caller policy already sandboxes", async () => {
        expect(
            await csp({
                securityHeaders: () => ({ "Content-Security-Policy": "default-src 'none'; sandbox allow-scripts" }),
            }),
        ).toBe("default-src 'none'; sandbox allow-scripts");
    });

    test("is absent on a download, where nothing renders", async () => {
        expect(await csp({ disposition: "attachment" })).toBeNull();
    });

    test("leaves other caller headers alone", async () => {
        const res = await get(
            serveObject(store, { disposition: "inline", securityHeaders: () => ({ "X-Frame-Options": "DENY" }) }),
            ctx,
        );
        expect(res.headers.get("x-frame-options")).toBe("DENY");
        expect(res.headers.get("content-security-policy")).toBe("sandbox");
    });
});

describe("a throwing onTiming", () => {
    /** Streams the object and records whether each body was cancelled. */
    function streaming() {
        const inner = memoryStore({ objects: { "big.bin": { body: BYTES } } });
        const opened: { cancelled: boolean; read: boolean }[] = [];
        const store: ObjectStore = {
            ...inner,
            authoritativeRange: false,
            async getObject(key, opts) {
                const s = await inner.getObject(key, opts);
                const bytes = s.body as Uint8Array<ArrayBuffer>;
                const state = { cancelled: false, read: false };
                opened.push(state);
                return {
                    ...s,
                    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
                        pull(controller) {
                            state.read = true;
                            controller.enqueue(bytes);
                            controller.close();
                        },
                        cancel() {
                            state.cancelled = true;
                        },
                    }),
                };
            },
        };
        return { store, opened };
    }
    const throwing = () => {
        throw new Error("metrics sink down");
    };
    const ctx = { key: "big.bin", mime: "application/octet-stream" };

    test("does not turn a timed 200 into a 502", async () => {
        const errors: { operation: string }[] = [];
        const res = await get(
            serveObject(streaming().store, {
                timing: true,
                onTiming: throwing,
                onError: (_e, context) => errors.push(context),
            }),
            ctx,
        );
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
        expect(errors.map((e) => e.operation)).toEqual(["audit"]);
    });

    test("does not turn a timed multi-range 206 into a 502", async () => {
        const { store, opened } = streaming();
        const res = await get(serveObject(store, { timing: true, onTiming: throwing }), ctx, {
            range: "bytes=0-9,1000-1009",
        });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-type")).toContain("multipart/byteranges");
        await res.arrayBuffer();
        expect(opened).toHaveLength(2);
        expect(opened.every((o) => o.read)).toBe(true);
    });

    test("a multipart response that fails while assembling releases its first part", async () => {
        const { store, opened } = streaming();
        // A caller header of the wrong runtime type makes the header merge throw
        // after the first part was already opened.
        const res = await get(
            serveObject(store, {
                precompressed: true,
                securityHeaders: () => ({ Vary: 5 as unknown as string }),
            }),
            { key: "big.bin", mime: "application/json" },
            { range: "bytes=0-9,1000-1009" },
        );
        expect(res.status).toBe(502);
        expect(opened).toHaveLength(1);
        expect(opened[0]!.cancelled).toBe(true);
    });
});
