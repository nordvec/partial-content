import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { memoryStore } from "../memory";
import { StoreUnavailableError, type ObjectStore } from "../index";
import { serveObject, type ServeContext, type ServeObjectOptions } from "../web";

const BYTES = new Uint8Array(2000).map((_, i) => i % 251);
const CTX: ServeContext = { key: "a.bin", mime: "application/octet-stream" };
const store = memoryStore({ objects: { "a.bin": { body: BYTES } } });

const get = (
    handler: ReturnType<typeof serveObject>,
    ctx: ServeContext = CTX,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
) => handler({ method: "GET", headers: new Headers(headers), signal }, ctx);

describe("async consumer callbacks", () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
    };
    beforeEach(() => {
        unhandled.length = 0;
        process.on("unhandledRejection", onUnhandled);
    });
    afterEach(() => {
        process.off("unhandledRejection", onUnhandled);
    });
    /** Lets a rejected promise surface as an unhandledRejection event. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
    const reject = async () => {
        throw new Error("audit store down");
    };

    test("a rejecting onServe is routed to onError once and leaves no unhandled rejection", async () => {
        const errors: string[] = [];
        const res = await get(
            serveObject(store, { onServe: reject, onError: (_e, c) => void errors.push(c.operation) }),
        );
        expect(res.status).toBe(200);
        await res.arrayBuffer();
        await settle();
        expect(errors).toEqual(["audit"]);
        expect(unhandled).toEqual([]);
    });

    test("a rejecting onTransfer is routed to onError and leaves no unhandled rejection", async () => {
        const errors: string[] = [];
        const res = await get(
            serveObject(store, { onTransfer: reject, onError: (_e, c) => void errors.push(c.operation) }),
        );
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
        await settle();
        expect(errors).toEqual(["audit"]);
        expect(unhandled).toEqual([]);
    });

    test("a rejecting onTiming is routed to onError and leaves no unhandled rejection", async () => {
        const errors: string[] = [];
        const res = await get(
            serveObject(store, { timing: true, onTiming: reject, onError: (_e, c) => void errors.push(c.operation) }),
        );
        expect(res.status).toBe(200);
        await settle();
        expect(errors).toEqual(["audit"]);
        expect(unhandled).toEqual([]);
    });

    test("a rejecting onError is swallowed: there is no sink for the sink", async () => {
        const res = await get(serveObject(store, { onServe: reject, onError: reject }));
        expect(res.status).toBe(200);
        await settle();
        expect(unhandled).toEqual([]);
    });

    test("a throwing onError does not escape the handler on a store failure", async () => {
        const failing: ObjectStore = {
            ...store,
            async getObject() {
                throw new Error("read failed");
            },
        };
        const res = await get(
            serveObject(failing, {
                onError: () => {
                    throw new Error("sink down");
                },
            }),
        );
        expect(res.status).toBe(502);
    });
});

describe("a store failure after the headers", () => {
    /** A store whose read delivers 5 bytes and then errors, whatever span was asked for. */
    function tearing(err: Error): ObjectStore {
        return {
            ...store,
            authoritativeRange: false,
            async getObject(key, opts) {
                const s = await store.getObject(key, opts);
                const span = opts?.range ? opts.range.end! - opts.range.start + 1 : BYTES.length;
                let sent = false;
                return {
                    ...s,
                    contentLength: span,
                    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
                        pull(controller) {
                            if (sent) controller.error(err);
                            else controller.enqueue(new Uint8Array(5));
                            sent = true;
                        },
                    }),
                };
            },
        };
    }

    test("a body that fails mid-stream reaches onError with operation get", async () => {
        const reported: { err: unknown; operation: string }[] = [];
        const boom = new Error("backend reset");
        const res = await get(
            serveObject(tearing(boom), { onError: (err, c) => void reported.push({ err, operation: c.operation }) }),
        );
        expect(res.status).toBe(200);
        await res.arrayBuffer().catch(() => undefined);
        expect(reported).toEqual([{ err: boom, operation: "get" }]);
    });

    test("a lazy multipart part that fails reaches onError with operation get", async () => {
        let reads = 0;
        const flaky: ObjectStore = {
            ...store,
            async getObject(key, opts) {
                if (++reads === 2) throw new StoreUnavailableError(key);
                return store.getObject(key, opts);
            },
        };
        const reported: string[] = [];
        const res = await get(serveObject(flaky, { onError: (_e, c) => void reported.push(c.operation) }), CTX, {
            range: "bytes=0-9,1000-1009",
        });
        expect(res.status).toBe(206);
        await res.arrayBuffer().catch(() => undefined);
        expect(reported).toEqual(["get"]);
    });

    test("a lazy multipart part whose span changed reaches onError with operation get", async () => {
        let reads = 0;
        const changing: ObjectStore = {
            ...store,
            async getObject(key, opts) {
                const s = await store.getObject(key, opts);
                if (++reads === 2) return { ...s, range: { start: 0, end: 3 }, contentLength: 4 };
                return s;
            },
        };
        const reported: string[] = [];
        const res = await get(serveObject(changing, { onError: (_e, c) => void reported.push(c.operation) }), CTX, {
            range: "bytes=0-9,1000-1009",
        });
        expect(res.status).toBe(206);
        await res.arrayBuffer().catch(() => undefined);
        expect(reported).toEqual(["get"]);
    });

    test("a client that aborted is not a store failure", async () => {
        const controller = new AbortController();
        const reported: unknown[] = [];
        const res = await get(
            serveObject(tearing(new Error("aborted read")), { onError: (e) => void reported.push(e) }),
            CTX,
            {},
            controller.signal,
        );
        controller.abort();
        await res.arrayBuffer().catch(() => undefined);
        expect(reported).toEqual([]);
    });
});

describe("policy callbacks and context values of the wrong shape", () => {
    const signing: ObjectStore = {
        ...store,
        createSignedUrl: async () => ({ ok: true, url: "https://signed.invalid/" }),
    };

    async function served(opts: ServeObjectOptions, ctx: unknown) {
        const reported: { operation: string; err: unknown }[] = [];
        const res = await serveObject(signing, {
            ...opts,
            onError: (err, c) => void reported.push({ err, operation: c.operation }),
        })({ method: "GET", headers: new Headers() }, ctx as ServeContext);
        return { res, reported };
    }

    const cases: [string, ServeObjectOptions][] = [
        ["an async disposition", { disposition: (async () => "inline") as unknown as () => "inline" }],
        ["a disposition outside the allowed values", { disposition: (() => "download") as unknown as () => "inline" }],
        [
            "an async securityHeaders",
            { securityHeaders: (async () => ({})) as unknown as () => Record<string, string> },
        ],
        [
            "a securityHeaders returning nothing",
            { securityHeaders: (() => undefined) as unknown as () => Record<string, string> },
        ],
        ["an async preferSignedUrl", { preferSignedUrl: (async () => false) as unknown as () => boolean }],
    ];
    for (const [name, opts] of cases) {
        test(`${name} answers 500 with operation context`, async () => {
            const { res, reported } = await served(opts, CTX);
            expect(res.status).toBe(500);
            expect(reported.map((r) => r.operation)).toEqual(["context"]);
        });
    }

    test("a numeric ctx.cacheControl is the caller's bug: 500 context, not a store 502", async () => {
        const { res, reported } = await served({}, { ...CTX, cacheControl: 60 });
        expect(res.status).toBe(500);
        expect(reported.map((r) => r.operation)).toEqual(["context"]);
    });

    test("a missing ctx answers 500 instead of rejecting", async () => {
        const { res, reported } = await served({}, undefined);
        expect(res.status).toBe(500);
        expect(reported.map((r) => r.operation)).toEqual(["context"]);
    });

    test("a wrong-shape callback result under an auditKey reports the projection", async () => {
        const { res, reported } = await served(
            { securityHeaders: (async () => ({})) as unknown as () => Record<string, string> },
            { ...CTX, auditKey: "audit-1" },
        );
        expect(res.status).toBe(500);
        expect(reported).toEqual([{ err: { name: "TypeError", operation: "context" }, operation: "context" }]);
    });
});

describe("option validation at construction", () => {
    test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("signedUrlExpiresSeconds %p is refused", (n) => {
        expect(() => serveObject(store, { signedUrlExpiresSeconds: n })).toThrow(TypeError);
    });

    test("an unknown disposition string is refused", () => {
        expect(() => serveObject(store, { disposition: "download" as "inline" })).toThrow(TypeError);
    });

    test.each(["constructor", "toString", "__proto__"])("precompressed [%p] is refused", (name) => {
        expect(() => serveObject(store, { precompressed: [name as "br"] })).toThrow(TypeError);
    });
});

describe("a ctx.key that is not a string is the caller's bug", () => {
    test.each([[undefined], [null], [7], [{}], [["a.bin"]]])(
        "ctx.key %p answers 500 with operation context",
        async (key) => {
            const reported: { operation: string; key: string; name: string }[] = [];
            let reads = 0;
            const counting: ObjectStore = {
                ...store,
                headObject: (...args) => {
                    reads++;
                    return store.headObject(...args);
                },
                getObject: (...args) => {
                    reads++;
                    return store.getObject(...args);
                },
            };
            const res = await serveObject(counting, {
                onError: (err, c) =>
                    void reported.push({ operation: c.operation, key: c.key, name: (err as Error).name }),
            })({ method: "GET", headers: new Headers() }, { ...CTX, key } as unknown as ServeContext);
            expect(res.status).toBe(500);
            expect(reported).toEqual([{ operation: "context", key: "", name: "TypeError" }]);
            expect(reads).toBe(0);
        },
    );
});

describe("a thrown value that cannot be read is still classified", () => {
    const throwing = (label: string) => ({
        get(): never {
            throw new Error(label);
        },
    });
    const hostile = () =>
        Object.defineProperties(new Error("origin said no"), {
            status: throwing("status getter"),
            name: throwing("name getter"),
            retryAfterSeconds: throwing("retry getter"),
        });

    test("a store error whose fields throw answers 502 and reaches onError once", async () => {
        const failing: ObjectStore = {
            ...store,
            getObject: async () => {
                throw hostile();
            },
        };
        const operations: string[] = [];
        const res = await get(serveObject(failing, { onError: (_e, c) => void operations.push(c.operation) }));
        expect(res.status).toBe(502);
        expect(res.headers.get("retry-after")).toBeNull();
        expect(operations).toHaveLength(1);
    });

    test("a Proxy that traps every read answers 502", async () => {
        const failing: ObjectStore = {
            ...store,
            getObject: async () => {
                // Typed unknown: a store can throw any value, and this one is not an Error on purpose.
                const hostile: unknown = new Proxy(
                    {},
                    { get: throwing("trap").get, getPrototypeOf: throwing("trap").get },
                );
                throw hostile;
            },
        };
        const res = await get(serveObject(failing, {}));
        expect(res.status).toBe(502);
    });
});

describe("under an auditKey every error reaching onError is the projection", () => {
    const AUDITED: ServeContext = { ...CTX, auditKey: "audit-1" };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
    const leak = async () => {
        throw Object.assign(new Error("row for a.bin could not be written"), { code: "E_AUDIT", detail: "a.bin" });
    };

    test.each(["onServe", "onTransfer", "onTiming"] as const)(
        "a failing %s hook is reported projected",
        async (hook) => {
            const seen: unknown[] = [];
            const res = await get(
                serveObject(store, { timing: true, [hook]: leak, onError: (err) => void seen.push(err) }),
                AUDITED,
            );
            await res.arrayBuffer();
            await settle();
            expect(seen).toEqual([{ name: "Error", code: "E_AUDIT", operation: "audit" }]);
            expect(JSON.stringify(seen)).not.toContain("a.bin");
        },
    );

    test("without an auditKey the hook's own error is passed through", async () => {
        const seen: unknown[] = [];
        const res = await get(serveObject(store, { onServe: leak, onError: (err) => void seen.push(err) }));
        await res.arrayBuffer();
        await settle();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBeInstanceOf(Error);
    });
});
