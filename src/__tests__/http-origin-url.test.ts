import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { encodeKeyPath, httpStore, StoreUnavailableError } from "../http";
import { type ObjectBody, ObjectNotFoundError } from "../index";
import { serveObject } from "../web";

/**
 * The origin URL of an http store can be a bearer credential (a presigned query
 * string). A transport failure must not carry it across the store boundary,
 * because the error goes to the consumer's `onError` sink.
 */
const SIGNATURE = "X-Amz-Signature=deadbeefSECRET";
const URL_WITH_SECRET = `https://origin.example/bucket/docs/q1.pdf?X-Amz-Credential=AKIAEXAMPLE&${SIGNATURE}`;

/** The rejection a connection failure produces on a runtime that names the request. */
function transportFailure(): Error {
    return Object.assign(
        new TypeError(`Unable to connect. Is the computer able to access the url? ${URL_WITH_SECRET}`),
        {
            code: "ECONNREFUSED",
            path: URL_WITH_SECRET,
            cause: Object.assign(new Error(`connect failed for ${URL_WITH_SECRET}`), { code: "ECONNREFUSED" }),
        },
    );
}

const failingFetch = (async () => {
    throw transportFailure();
}) as unknown as typeof fetch;

const store = () => httpStore({ url: () => URL_WITH_SECRET, fetch: failingFetch });

function streamOf(body: ObjectBody): ReadableStream<Uint8Array<ArrayBuffer>> {
    if (body instanceof Uint8Array) throw new Error("expected a streamed body");
    return body;
}

describe("httpStore failure after the headers", () => {
    test("a reset mid-body errors the stream without the origin URL", async () => {
        const server = createServer((req, res) => {
            if (req.method === "HEAD") {
                res.writeHead(200, { "content-length": "100000", etag: '"e"' });
                res.end();
                return;
            }
            res.writeHead(200, { "content-length": "100000", etag: '"e"' });
            res.write(Buffer.alloc(10));
            setTimeout(() => req.socket.destroy(), 20);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const { port } = server.address() as AddressInfo;
            const url = `http://127.0.0.1:${port}/tok=SECRETPATH/q1.pdf?${SIGNATURE}`;
            const stream = await httpStore({ url: () => url }).getObject("q1.pdf");
            const reader = streamOf(stream.body).getReader();
            let failure: unknown;
            try {
                for (;;) if ((await reader.read()).done) break;
            } catch (err) {
                failure = err;
            }
            expect(failure).toBeDefined();
            expect(inspect(failure, { depth: 10, showHidden: true })).not.toContain("SECRET");
        } finally {
            server.closeAllConnections();
            server.close();
        }
    });

    test("cancelling the served body cancels the origin body", async () => {
        let onCancel!: () => void;
        const cancelled = new Promise<boolean>((resolve) => {
            onCancel = () => resolve(true);
        });
        const origin = (async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull(controller) {
                        controller.enqueue(new Uint8Array(4));
                    },
                    cancel() {
                        onCancel();
                    },
                }),
                { headers: { "content-length": "1000" } },
            )) as unknown as typeof fetch;
        const stream = await httpStore({ url: () => URL_WITH_SECRET, fetch: origin }).getObject("k");
        const reader = streamOf(stream.body).getReader();
        await reader.read();
        await reader.cancel();
        expect(await Promise.race([cancelled, new Promise<boolean>((r) => setTimeout(() => r(false), 1000))])).toBe(
            true,
        );
    });
});

describe("httpStore transport failures", () => {
    for (const [name, call] of [
        ["HEAD", () => store().headObject("docs/q1.pdf")],
        ["GET", () => store().getObject("docs/q1.pdf")],
    ] as const) {
        test(`${name} rejects with a fixed message, the original name and code, and a projected cause`, async () => {
            const err = (await call().then(
                () => undefined,
                (e: unknown) => e,
            )) as Error & { code: string };
            expect(err.message).toBe(`httpStore ${name}: origin request failed`);
            expect(err.name).toBe("TypeError");
            expect(err.code).toBe("ECONNREFUSED");
            expect(err.cause).toStrictEqual({
                name: "TypeError",
                code: "ECONNREFUSED",
                cause: { name: "Error", code: "ECONNREFUSED" },
            });
            // Nothing the runtime wrote survives, in any property, in any spelling.
            expect(inspect(err, { depth: 10, showHidden: true })).not.toContain("SECRET");
            expect(inspect(err, { depth: 10, showHidden: true })).not.toContain("origin.example");
        });
    }

    test("onError receives no text of the original failure", async () => {
        const seen: unknown[] = [];
        const res = await serveObject(store(), { onError: (e) => seen.push(e) })(
            { method: "GET", headers: new Headers() },
            { key: "docs/q1.pdf", mime: "application/pdf" },
        );
        expect(res.status).toBe(502);
        expect(seen).toHaveLength(1);
        expect(inspect(seen[0], { depth: 10, showHidden: true })).not.toContain("SECRET");
    });

    test("an abort keeps its name, so the handler still reads it as a client abort", async () => {
        const controller = new AbortController();
        controller.abort();
        const aborting = httpStore({
            url: () => URL_WITH_SECRET,
            fetch: (async (_u: unknown, init?: RequestInit) => {
                init?.signal?.throwIfAborted();
                return new Response();
            }) as unknown as typeof fetch,
        });
        const err = await aborting.headObject("k", { signal: controller.signal }).catch((e: unknown) => e);
        expect((err as Error).name).toBe("AbortError");
    });

    test("a DOMException keeps its name and is never cloned into an object with throwing getters", async () => {
        // The path is quoted in the message and the stack, which is where a clone-and-rewrite would have touched it.
        const timeout = new DOMException("timed out fetching /bucket/docs/q1.pdf", "TimeoutError");
        const failing = httpStore({
            url: () => URL_WITH_SECRET,
            fetch: (async () => {
                throw timeout;
            }) as unknown as typeof fetch,
        });
        const err = (await failing.headObject("k").catch((e: unknown) => e)) as Error;
        expect(err.name).toBe("TimeoutError");
        expect(err.message).toBe("httpStore HEAD: origin request failed");
        expect(err.cause).toStrictEqual({ name: "TimeoutError", code: 23 }); // the legacy DOMException code of TimeoutError
        const seen: unknown[] = [];
        const res = await serveObject(failing, { onError: (e) => seen.push(e) })(
            { method: "GET", headers: new Headers() },
            { key: "docs/q1.pdf", mime: "application/pdf" },
        );
        expect(res.status).toBe(502);
        expect((seen[0] as Error).name).toBe("TimeoutError");
    });
});

describe("httpStore keeps the text-free classifiers of a transport failure", () => {
    function throwing(thrown: unknown) {
        return httpStore({
            url: () => URL_WITH_SECRET,
            fetch: (async () => {
                throw thrown;
            }) as unknown as typeof fetch,
        });
    }
    const serve = (store: ReturnType<typeof httpStore>) =>
        serveObject(store)({ method: "GET", headers: new Headers() }, { key: "docs/q1.pdf", mime: "application/pdf" });

    test("a numeric retryAfterSeconds survives and reaches Retry-After", async () => {
        const store = throwing(new StoreUnavailableError("docs/q1.pdf", { retryAfterSeconds: 30 }));
        const err = (await store.headObject("docs/q1.pdf").catch((e: unknown) => e)) as Error & {
            retryAfterSeconds?: number;
        };
        expect(err.name).toBe("StoreUnavailableError");
        expect(err.retryAfterSeconds).toBe(30);
        const res = await serve(store);
        expect(res.status).toBe(503);
        expect(res.headers.get("Retry-After")).toBe("30");
    });

    test("a numeric status survives: a thrown 503 is served as 503, not 502", async () => {
        const store = throwing(Object.assign(new Error(`overloaded ${URL_WITH_SECRET}`), { status: 503 }));
        const err = (await store.headObject("docs/q1.pdf").catch((e: unknown) => e)) as Error & { status?: number };
        expect(err.status).toBe(503);
        expect(err.message).toBe("httpStore HEAD: origin request failed");
        expect((await serve(store)).status).toBe(503);
    });

    test("a non-numeric status or retryAfterSeconds is dropped", async () => {
        const store = throwing(Object.assign(new Error("x"), { status: "503", retryAfterSeconds: "later" }));
        const err = (await store.headObject("docs/q1.pdf").catch((e: unknown) => e)) as Record<string, unknown>;
        expect("status" in err).toBe(false);
        expect("retryAfterSeconds" in err).toBe(false);
    });

    test("a numeric-string retryAfterSeconds and an out-of-range or fractional status are dropped", async () => {
        for (const extra of [
            { status: Number.NaN, retryAfterSeconds: "30" },
            { status: 99 },
            { status: 600 },
            { status: 503.5 },
        ]) {
            const err = (await throwing(Object.assign(new Error("x"), extra))
                .headObject("docs/q1.pdf")
                .catch((e: unknown) => e)) as Record<string, unknown>;
            expect("status" in err).toBe(false);
            expect("retryAfterSeconds" in err).toBe(false);
        }
    });

    test("a throwing getter or Proxy trap never puts its text on the failure or into onError", async () => {
        const getterThrows = (field: string) =>
            Object.defineProperty(new Error("x"), field, {
                get() {
                    throw new Error(`getter for ${URL_WITH_SECRET}`);
                },
            });
        const proxy = new Proxy(new Error("x"), {
            get() {
                throw new Error(`trap for ${URL_WITH_SECRET}`);
            },
        });
        const thrownValues = [
            ...["name", "code", "status", "cause", "retryAfterSeconds"].map(getterThrows),
            proxy,
            // A name or code that is free text, not an identifier, is not projected.
            Object.assign(new Error("x"), { name: `https://h/${SIGNATURE}` }),
            Object.assign(new Error("x"), { code: `failed ${URL_WITH_SECRET}` }),
        ];
        for (const thrown of thrownValues) {
            const store = throwing(thrown);
            const err = await store.headObject("docs/q1.pdf").catch((e: unknown) => e);
            expect(err).toBeInstanceOf(Error);
            expect(inspect(err, { depth: 10 })).not.toContain("SECRET");
            const seen: unknown[] = [];
            const res = await serveObject(store, { onError: (e) => void seen.push(e) })(
                { method: "GET", headers: new Headers() },
                { key: "docs/q1.pdf", mime: "application/pdf" },
            );
            expect(res.status).toBe(502);
            expect(seen.length).toBe(1);
            expect(inspect(seen, { depth: 10 })).not.toContain("SECRET");
        }
    });
});

describe("httpStore refuses a key the URL parser would trim", () => {
    // The parser strips C0 controls and spaces from both ends of its whole input, so a key that
    // starts or ends with one resolves to a different path than the one the guard checked.
    const shapes: Record<string, (key: string) => string> = {
        template: (key) => `https://origin.example/${key}`,
        "new URL(key, base)": (key) => new URL(key, "https://origin.example/bucket/").href,
    };
    const keys = [
        " ../.uploads/secret",
        "..\x01",
        "a/..\x00",
        "\x1f../x",
        "photos/.. ",
        "\t../.uploads/x",
        // A special scheme, an authority, an absolute path.
        "https:.uploads/x",
        "HTTPS:../.uploads/x",
        "https:%2e%2e/.uploads/x",
        "http:evil.example/x",
        "file:/etc/passwd",
        "ht\ttps:.uploads/x",
        "WSS:evil.example/x",
        "//evil.example/x",
        "\\\\evil.example\\x",
        "/other/x",
        // A dot segment ends at `?` or `#`, and a bare query names the base location itself.
        "a/..?x",
        "a/%2e%2e?x",
        "a/..#x",
        "?x",
    ];
    // Other scheme-shaped keys: a template keeps them a path, but `new URL` builds a URL of their own
    // scheme, which a runtime's fetch may act on (`localhost:8080/x` as plain HTTP to that port).
    const notHttpOnceBuilt = [
        "data:text/html,x",
        "blob:x",
        "localhost:8080/internal/secret",
        "metadata.google.internal:80/computeMetadata/v1/",
        "s3://bucket/x",
        "s3:bucket/x",
        "tenant:42/a.pdf",
    ];
    for (const [shape, build] of Object.entries(shapes)) {
        for (const policy of ["plain", "verbatim"] as const) {
            for (const key of shape === "template" ? keys : [...keys, ...notHttpOnceBuilt]) {
                test(`${shape}, keys "${policy}": ${JSON.stringify(key)} is refused before any fetch`, async () => {
                    let fetched = 0;
                    const store = httpStore({
                        url: build,
                        keys: policy,
                        fetch: (async () => {
                            fetched++;
                            return new Response("served");
                        }) as unknown as typeof fetch,
                    });
                    await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
                    await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
                    expect(fetched).toBe(0);
                });
            }
        }
    }

    for (const [shape, build] of Object.entries(shapes)) {
        test(`${shape}: ordinary keys with an interior space, colon or empty segment are still fetched`, async () => {
            const fetched: string[] = [];
            const store = httpStore({
                url: build,
                keys: "verbatim",
                fetch: (async (input: string | URL) => {
                    fetched.push(String(input));
                    return new Response(null, { status: 404 });
                }) as unknown as typeof fetch,
            });
            const ordinary = ["docs/q 1.pdf", "2026:q1.pdf", "reports//q1.pdf", "x/a%3F"];
            for (const key of ordinary) {
                await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            }
            expect(fetched.length).toBe(ordinary.length);
            // The path that was requested names the key, not only the host.
            for (const [index, url] of fetched.entries()) {
                const requested = new URL(url);
                expect(requested.origin).toBe("https://origin.example");
                expect(requested.search + requested.hash).toBe("");
                expect(requested.pathname.endsWith(ordinary[index]!.replaceAll(" ", "%20"))).toBe(true);
            }
        });

        // Interpolated, each of these names another object: the query and the
        // fragment are cut off the path, `\` becomes `/`, a tab or line break vanishes.
        const rewritten = [
            "a?b.pdf",
            "docs/a#1.pdf",
            "private/contract.pdf#.thumb.jpg",
            "report.json?v=2.br",
            "a\\b.pdf",
            "a\tb.pdf",
            "a\nb.pdf",
        ];
        for (const key of rewritten) {
            test(`${shape}: ${JSON.stringify(key)} would be rewritten by the URL parser, so nothing is fetched`, async () => {
                let fetches = 0;
                const store = httpStore({
                    url: build,
                    keys: "verbatim",
                    fetch: (async () => {
                        fetches++;
                        return new Response(null, { status: 200, headers: { "content-length": "3" } });
                    }) as unknown as typeof fetch,
                });
                await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
                await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
                expect(fetches).toBe(0);
            });
        }
    }

    test("encodeKeyPath: a key holding ?, #, a backslash, a tab or a line break is fetched as the object it names", async () => {
        const fetched: string[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/bucket/${encodeKeyPath(key)}`,
            fetch: (async (input: string | URL) => {
                fetched.push(String(input));
                return new Response(null, { status: 200, headers: { "content-length": "3" } });
            }) as unknown as typeof fetch,
        });
        for (const key of ["a?b.pdf", "docs/a#1.pdf", "a\\b.pdf", "a\tb.pdf", "a\nb.pdf", "é?ü.pdf"]) {
            expect((await store.headObject(key)).contentLength).toBe(3);
        }
        expect(fetched).toEqual([
            "https://origin.example/bucket/a%3Fb.pdf",
            "https://origin.example/bucket/docs/a%231.pdf",
            "https://origin.example/bucket/a%5Cb.pdf",
            "https://origin.example/bucket/a%09b.pdf",
            "https://origin.example/bucket/a%0Ab.pdf",
            "https://origin.example/bucket/%C3%A9%3F%C3%BC.pdf",
        ]);
    });

    test("a variant of a key with a query is never read as the identity object", async () => {
        // `report.json?v=2` + `.br` interpolates to the object `report.json` with query `v=2.br`.
        let fetches = 0;
        const handler = serveObject(
            httpStore({
                url: (key) => `https://origin.example/${key}`,
                fetch: (async () => {
                    fetches++;
                    return new Response("{}", { headers: { "content-length": "2" } });
                }) as unknown as typeof fetch,
            }),
            { precompressed: ["br"] },
        );
        const response = await handler(new Request("https://app.example/x", { headers: { "accept-encoding": "br" } }), {
            key: "report.json?v=2",
        });
        expect(response.status).toBe(404);
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(fetches).toBe(0);
    });
});

describe("httpStore reads percent-escapes the way a byte-wise decoder does", () => {
    const counting = () => {
        const state = { fetches: 0 };
        const fetchImpl = (async () => {
            state.fetches++;
            return new Response(null, { status: 200, headers: { "content-length": "3" } });
        }) as unknown as typeof fetch;
        return { state, fetchImpl };
    };

    // One malformed escape must not hide the well-formed ones beside it.
    const hidden = [
        "x%ff%2f..%2f..%2fother-tenant%2fsecret.pdf",
        "x%ff%2f..%2f.uploads%2ftok",
        "x%zz%2f..%2f.uploads%2ftok",
        "x%%2f..%2f.partial-content-uploads%2ftok",
        "%c3%28%2f%2e%2e%2f.uploads/x",
        "100%/%2e%2e/.uploads/x",
    ];
    for (const policy of ["plain", "verbatim"] as const) {
        for (const key of hidden) {
            test(`${policy}: ${key} is refused without a fetch`, async () => {
                const { state, fetchImpl } = counting();
                const store = httpStore({ url: (k) => `https://o.example/${k}`, keys: policy, fetch: fetchImpl });
                await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
                await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
                expect(state.fetches).toBe(0);
            });
        }
    }

    test("a key with a malformed escape and no hidden segment is still fetched", async () => {
        const { state, fetchImpl } = counting();
        const store = httpStore({ url: (k) => `https://o.example/${k}`, fetch: fetchImpl });
        const ordinary = ["docs/a%20b.pdf", "docs/a%zz.pdf", "100%.pdf", "a%ff.bin", "50%25.txt"];
        for (const key of ordinary) expect((await store.headObject(key)).contentLength).toBe(3);
        expect(state.fetches).toBe(ordinary.length);
    });
});

describe("httpStore url() and headers()", () => {
    const okFetch = (async () =>
        new Response(null, { status: 200, headers: { "content-length": "3" } })) as unknown as typeof fetch;
    const leaks = (err: unknown): string => inspect(err, { depth: 6, showHidden: true });

    test("an async url() is awaited, so a presigner can sign per request", async () => {
        const fetched: string[] = [];
        const store = httpStore({
            url: async (key) => {
                await Promise.resolve();
                return new URL(`https://origin.example/${key}?sig=1`);
            },
            fetch: (async (input: string | URL) => {
                fetched.push(String(input));
                return new Response(null, { status: 200, headers: { "content-length": "3" } });
            }) as unknown as typeof fetch,
        });
        expect((await store.headObject("doc.pdf")).contentLength).toBe(3);
        expect(fetched).toEqual(["https://origin.example/doc.pdf?sig=1"]);
    });

    for (const [what, value] of Object.entries({
        undefined: undefined,
        "a number": 7,
        "a plain object": { href: "x" },
    })) {
        test(`a url() that returns ${what} is a configuration error, not a missing object`, async () => {
            const store = httpStore({ url: (() => value) as unknown as (key: string) => string, fetch: okFetch });
            const err = await store.headObject("doc.pdf").catch((e: unknown) => e);
            expect(err).toBeInstanceOf(TypeError);
            expect(err).not.toBeInstanceOf(ObjectNotFoundError);
            expect((err as Error).message).toBe("httpStore: url() must return a string or a URL");
        });
    }

    test("a url() that throws surfaces no text of its own", async () => {
        const store = httpStore({
            url: () => {
                throw Object.assign(new Error(`presign failed for ${URL_WITH_SECRET}`), { input: URL_WITH_SECRET });
            },
            fetch: okFetch,
        });
        for (const call of [store.headObject("doc.pdf"), store.getObject("doc.pdf")]) {
            const err = await call.catch((e: unknown) => e);
            expect((err as Error).message).toBe("httpStore: url() failed");
            expect(leaks(err)).not.toContain("SECRET");
            expect(err).not.toBeInstanceOf(ObjectNotFoundError);
        }
    });

    test("a rejected url() promise is projected the same way", async () => {
        const store = httpStore({ url: () => Promise.reject(new Error(`down: ${URL_WITH_SECRET}`)), fetch: okFetch });
        const err = await store.getObject("doc.pdf").catch((e: unknown) => e);
        expect((err as Error).message).toBe("httpStore: url() failed");
        expect(leaks(err)).not.toContain("SECRET");
    });

    test("a key the builder cannot parse as a URL reference is not found, not a store failure", async () => {
        const store = httpStore({
            url: (key) => new URL(key, "https://origin.example/bucket/"),
            keys: "verbatim",
            fetch: okFetch,
        });
        await expect(store.headObject("x://a b/c")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject("x://a b/c")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("a static header the runtime refuses fails at construction, without quoting the value", () => {
        const build = (): unknown =>
            httpStore({ url: () => "https://o.example/x", headers: { Authorization: "Bearer SECRET\nx" } });
        expect(build).toThrow(TypeError);
        try {
            build();
        } catch (err) {
            expect(leaks(err)).not.toContain("SECRET");
        }
    });

    test("a headers() value the runtime refuses surfaces no text of the value", async () => {
        const store = httpStore({
            url: () => "https://o.example/x",
            headers: () => ({ Authorization: "Bearer SECRET\nx" }),
            fetch: okFetch,
        });
        for (const call of [store.headObject("doc.pdf"), store.getObject("doc.pdf")]) {
            const err = await call.catch((e: unknown) => e);
            expect((err as Error).message).toBe("httpStore: headers could not be built");
            expect(leaks(err)).not.toContain("SECRET");
        }
    });

    test("a headers() callback that throws is projected", async () => {
        const store = httpStore({
            url: () => "https://o.example/x",
            headers: () => {
                throw new Error("vault said SECRET");
            },
            fetch: okFetch,
        });
        const err = await store.headObject("doc.pdf").catch((e: unknown) => e);
        expect(leaks(err)).not.toContain("SECRET");
    });

    test("a refusal of the origin's response quotes none of its header text", async () => {
        const respond = (headers: Record<string, string>, status = 200) =>
            httpStore({
                url: () => "https://o.example/x",
                fetch: (async () => new Response("x", { status, headers })) as unknown as typeof fetch,
            });
        const encoded = respond({ "content-encoding": "SECRET-coding", "content-length": "1" });
        const ranged = respond({ "content-range": "SECRET 0-0/1" }, 206);
        for (const call of [encoded.headObject("k"), encoded.getObject("k"), ranged.getObject("k")]) {
            const err = await call.catch((e: unknown) => e);
            expect(err).toBeInstanceOf(Error);
            expect(leaks(err)).not.toContain("SECRET");
        }
    });

    for (const key of ["", "#frag", "?x", "ftp:x", "ws://h/x", "wss:x"]) {
        test(`${JSON.stringify(key)} names no object under either policy`, async () => {
            for (const keys of ["plain", "verbatim"] as const) {
                const store = httpStore({ url: (k) => `https://o.example/${k}`, keys, fetch: okFetch });
                await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            }
        });
    }
});

describe("httpStore fetches a parser-rewritten key only from a URL that vouches for it", () => {
    const KEYS = ["Invoice #12.pdf", "Q3?final.pdf", "a\\b.txt", "a?", "tab\there.txt", "x?y#z", "it's?x", "a%3F?b"];
    const CUT = KEYS.filter((key) => !/[\\\t]/.test(key));
    const recording = () => {
        const fetched: unknown[] = [];
        const fetch = (async (input: unknown) => {
            fetched.push(input);
            return new Response(null, { status: 200, headers: { "content-length": "3" } });
        }) as unknown as typeof globalThis.fetch;
        return { fetched, fetch };
    };
    const ids = new Map(KEYS.map((key, index) => [key, `obj-${index}`]));
    const SIGNED = "X-Amz-Credential=AKIA%2F20261112%2Feu&X-Amz-Signature=ab12cd";
    const builders: [string, (key: string) => string, (key: string) => string, string[]][] = [
        [
            "encodeKeyPath under a path that spells the start of a key",
            (key) => `https://origin.example/a/b.txt/tabhere.txt/${encodeKeyPath(key)}`,
            (key) => `https://origin.example/a/b.txt/tabhere.txt/${encodeURIComponent(key)}`,
            CUT,
        ],
        [
            "encodeKeyPath with a signed query",
            (key) => `https://origin.example/base/${encodeKeyPath(key)}?${SIGNED}`,
            (key) => `https://origin.example/base/${encodeURIComponent(key)}?${SIGNED}`,
            KEYS,
        ],
        [
            // encodeURI escapes a backslash and a tab, which is the encoded form of a key holding nothing else rewritten.
            "encodeURI of a key with no query or fragment character",
            (key) => `https://origin.example/base/${encodeURI(key)}`,
            (key) => `https://origin.example/base/${encodeURI(key)}`,
            ["a\\b.txt", "tab\there.txt"],
        ],
    ];
    for (const [name, build, expected, served] of builders) {
        test(`${name} serves the key at the URL it built`, async () => {
            const { fetched, fetch } = recording();
            const store = httpStore({ url: build, fetch });
            for (const key of served) expect((await store.headObject(key)).contentLength).toBe(3);
            expect(fetched).toEqual(served.map(expected));
        });
    }

    // Builders that encode the key some other way, or leave it intact where it sits.
    const strict = (key: string) =>
        encodeKeyPath(key).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const lowerHex = (key: string) => encodeKeyPath(key).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
    const NESTED = ["dir/a?b", "dir/Invoice #12 (1).pdf", "a?b c", "a#b!", "a?b~", "é?x", ...KEYS];
    const serving: [string, (key: string) => string | URL, string[]][] = [
        [
            "a strictly encoded path with a signed query",
            (key) => `https://origin.example/base/${strict(key)}?${SIGNED}`,
            NESTED,
        ],
        // The key is intact in the path, whatever the path goes on to say and whatever it sits under.
        [
            "an encoded path under a further segment",
            (key) => `https://origin.example/base/${encodeKeyPath(key)}/metadata`,
            [...NESTED, "a?a", "a#a", "a?a?a", "data?x", "n?v=2"],
        ],
        [
            "an encoded path under a base that spells the key as a parser would",
            (key) => `https://origin.example/a/a/tables/${encodeKeyPath(key)}`,
            ["a\\a", "a\tb", "a\\b.txt"],
        ],
        [
            "a path encoded with lowercase escapes",
            (key) => `https://origin.example/base/${lowerHex(key)}?${SIGNED}`,
            NESTED,
        ],
        ["an encoded path with a suffix", (key) => `https://origin.example/base/${encodeKeyPath(key)}.json`, NESTED],
        [
            "a path set through the URL's own pathname",
            (key) => {
                const url = new URL("https://origin.example/");
                url.pathname = `/base/${key}`;
                return url;
            },
            ["dir/a?b", "Invoice #12.pdf", "Q3?final.pdf", "x?y#z"],
        ],
    ];
    for (const [name, build, served] of serving) {
        test(`${name} serves the key`, async () => {
            const { fetched, fetch } = recording();
            const store = httpStore({ url: build, fetch });
            for (const key of served) expect((await store.headObject(key)).contentLength).toBe(3);
            expect(fetched).toHaveLength(served.length);
        });
    }

    const TRANSFORMED = [
        "a%?b",
        "a|?b",
        "a?{b",
        "a?`b",
        "a%20?b",
        "a'#b",
        "a{#b",
        "a\t'b",
        "notes#v2.txt",
        "line\nbreak",
        "cr\rhere",
        "dir\\x",
    ];
    const disposition = (key: string) => encodeURIComponent(`attachment; filename="${key}"`);
    const stripped = (key: string, strip: (url: URL) => void) => {
        const url = new URL(key, "https://origin.example/base/");
        strip(url);
        return url;
    };
    const refusing: [string, (key: string) => string | URL, string[]][] = [
        ["a path", (key) => `https://origin.example/base/${key}`, [...KEYS, ...TRANSFORMED]],
        ["a path with a suffix", (key) => `https://origin.example/base/${key}.json`, [...KEYS, ...TRANSFORMED]],
        ["a path behind a name prefix", (key) => `https://origin.example/base/files-${key}`, [...KEYS, ...TRANSFORMED]],
        ["a path behind a colon prefix", (key) => `https://origin.example/base/v1:${key}`, [...KEYS, ...TRANSFORMED]],
        // encodeURI leaves `?` and `#` as delimiters and escapes what a parser would have kept.
        [
            "a partly encoded path",
            (key) => `https://origin.example/base/${encodeURI(key)}`,
            [...CUT, "a%?b", "a|?b", "a?{b", "a?`b", "a%20?b", "a'#b"],
        ],
        // The query is not read: a copy of the key there says nothing about the object the path names.
        ["a raw query value", (key) => `https://origin.example/download?path=${key}`, [...KEYS, ...TRANSFORMED]],
        [
            "a raw query value after another",
            (key) => `https://origin.example/download?b=x/${key}`,
            [...KEYS, ...TRANSFORMED],
        ],
        [
            "an encoded query value",
            (key) => `https://origin.example/download?v=ab&path=${encodeURIComponent(key)}`,
            [...KEYS, ...TRANSFORMED],
        ],
        [
            "a form-encoded query value",
            (key) => {
                const url = new URL("https://origin.example/download");
                url.searchParams.set("key", key);
                return url;
            },
            [...KEYS, ...TRANSFORMED],
        ],
        // The path names another object and the query holds the key: a parser rewrote what the builder left unencoded.
        [
            "a pathname the parser rewrote beside the key as a query value",
            (key) => {
                const url = new URL("https://origin.example/b/");
                url.pathname += key;
                url.searchParams.set("download", key);
                return url;
            },
            ["a\\b?c", "a\tb?c", "a\r\nb?c", "a\\b#c"],
        ],
        [
            "a path with only its query and fragment characters encoded beside a query copy",
            (key) =>
                `https://origin.example/b/${key.replace(/[?#]/g, encodeURIComponent)}?download=${encodeURIComponent(key)}`,
            ["a\\b?c", "a\tb?c", "a\\b#c"],
        ],
        [
            "a partly encoded path beside a query copy",
            (key) => `https://origin.example/b/${encodeURI(key)}?download=${encodeURIComponent(key)}`,
            ["a%41?b", "a%3F?b", "Q3?final.pdf"],
        ],
        // An encoded copy of the key elsewhere in the URL does not vouch for the path.
        [
            "a path beside an encoded copy inside a query value",
            (key) => `https://origin.example/base/${key}?response-content-disposition=${disposition(key)}`,
            [...KEYS, ...TRANSFORMED],
        ],
        [
            "a path beside an encoded copy as a whole query value",
            (key) => `https://origin.example/base/${key}?filename=${encodeURIComponent(key)}`,
            [...KEYS, ...TRANSFORMED],
        ],
        [
            "a path with a suffix beside an encoded copy as a query value",
            (key) => `https://origin.example/base/${key}.json?download=${encodeURIComponent(key)}`,
            [...KEYS, ...TRANSFORMED],
        ],
        [
            "a path under a segment beside an encoded copy as a query value",
            (key) => `https://origin.example/base/${key}/meta?name=${encodeURIComponent(key)}`,
            [...KEYS, ...TRANSFORMED],
        ],
        // A suffix added after the parser cut the key leaves a URL that does not carry the key at all.
        [
            "a parsed key with its query and fragment removed and a suffix added",
            (key) =>
                stripped(key, (url) => {
                    url.search = "";
                    url.hash = "";
                    url.pathname += ".json";
                }),
            [...CUT, ...TRANSFORMED],
        ],
        [
            "the parsed key's path under a base with a suffix",
            (key) => `https://origin.example/base${new URL(key, "https://x.example/").pathname}.json`,
            [...CUT, ...TRANSFORMED, "report?v=2.pdf", "doc#v2"],
        ],
        [
            "a parsed key with a lone surrogate and its query and fragment removed",
            (key) =>
                stripped(key, (url) => {
                    url.search = "";
                    url.hash = "";
                }),
            ["a\uD800?x", "a\uD800#x", "\uDC00b?x", "a\uD800", "\uDFFFx.txt"],
        ],
        [
            "a parsed path with the key added as a query value",
            (key) =>
                stripped(key, (url) => {
                    url.searchParams.set("filename", key);
                }),
            [...CUT, ...TRANSFORMED],
        ],
        [
            "a parsed key with its query and fragment removed",
            (key) =>
                stripped(key, (url) => {
                    url.search = "";
                    url.hash = "";
                }),
            [...CUT, ...TRANSFORMED],
        ],
        [
            "a builder that rewrites the key before interpolating it",
            (key) => `https://origin.example/base/${key.replaceAll(" ", "_")}`,
            CUT,
        ],
        // A URL that does not carry the key proves nothing about it, so a mapped name is refused too.
        ["a lookup to a signed URL", (key) => `https://origin.example/files/${ids.get(key)}?${SIGNED}`, KEYS],
        [
            "a lookup to a URL with no query",
            (key) => `https://origin.example/files/${ids.get(key) ?? "x"}`,
            [...KEYS, "line\nbreak", "cr\rhere"],
        ],
    ];
    for (const [name, build, refused] of refusing) {
        test(`${name} is not fetched for a key the URL does not vouch for`, async () => {
            const { fetched, fetch } = recording();
            const store = httpStore({ url: build, fetch });
            for (const key of refused) {
                await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            }
            expect(fetched).toEqual([]);
        });
    }

    test("fetch is handed the URL as a string, on the first request and on a followed hop", async () => {
        const seen: unknown[] = [];
        const store = httpStore({
            url: (key) => new URL(`https://origin.example/${key}`),
            redirect: "follow",
            fetch: (async (input: unknown) => {
                seen.push(input);
                return seen.length === 1
                    ? new Response(null, { status: 302, headers: { location: "/moved.pdf" } })
                    : new Response(null, { status: 200, headers: { "content-length": "3" } });
            }) as unknown as typeof fetch,
        });
        await store.headObject("doc.pdf");
        expect(seen).toEqual(["https://origin.example/doc.pdf", "https://origin.example/moved.pdf"]);
    });

    test("a null headers option is read as absent", async () => {
        const { fetched, fetch } = recording();
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            headers: null as unknown as undefined,
            fetch,
        });
        await store.headObject("doc.pdf");
        expect(fetched).toHaveLength(1);
    });

    test("encodeKeyPath answers not found for a key with a lone surrogate, which no URL can name", async () => {
        expect(() => encodeKeyPath("a\uD800b")).toThrow(ObjectNotFoundError);
        const { fetched, fetch } = recording();
        const store = httpStore({ url: (key) => `https://origin.example/${encodeKeyPath(key)}`, fetch });
        await expect(store.headObject("a\uD800b")).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(fetched).toEqual([]);
    });
});

describe("httpStore with a url() that signs per call", () => {
    /** A `url()` whose query differs on every call, the way a timestamped or nonce-bearing signer does. */
    function signingUrl() {
        const issued: string[] = [];
        return {
            issued,
            url: (key: string) => {
                const url = `https://origin.example/docs/${key}?sig=SIGNATURE${issued.length + 1}`;
                issued.push(url);
                return url;
            },
        };
    }

    test("url() is called once per store call, and the one URL is what is fetched", async () => {
        const signer = signingUrl();
        const fetched: string[] = [];
        const origin = (async (url: unknown) => {
            fetched.push(String(url));
            return new Response(new Uint8Array(4), { headers: { "content-length": "4" } });
        }) as unknown as typeof fetch;
        const s = httpStore({ url: signer.url, fetch: origin });
        await s.headObject("a.pdf");
        const read = await s.getObject("a.pdf");
        await new Response(read.body as ReadableStream<Uint8Array<ArrayBuffer>>).arrayBuffer();
        expect(signer.issued).toHaveLength(2);
        expect(fetched).toEqual(signer.issued);
    });

    test("a body that fails quoting the fetched URL reaches the consumer without the signature", async () => {
        const signer = signingUrl();
        const origin = (async (url: unknown) =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull() {
                        throw new Error(`socket closed while reading ${String(url)}`);
                    },
                }),
                { headers: { "content-length": "100" } },
            )) as unknown as typeof fetch;
        const stream = await httpStore({ url: signer.url, fetch: origin }).getObject("doc.pdf");
        const reader = streamOf(stream.body).getReader();
        const failure = (await reader.read().catch((e: unknown) => e)) as Error;
        expect(signer.issued).toHaveLength(1);
        expect(failure.message).toBe("httpStore GET body: origin request failed");
        const everything = inspect(failure, { depth: 10, showHidden: true });
        expect(everything).not.toContain("SIGNATURE");
        expect(everything).not.toContain("origin.example");
    });

    test("a response refused after the origin answered releases its body", async () => {
        let cancelled = 0;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled++;
            },
        });
        const refused = {
            status: 200,
            ok: true,
            body,
            headers: {
                get() {
                    throw new Error("a header read failed");
                },
            },
        };
        const s = httpStore({ url: () => URL_WITH_SECRET, fetch: (async () => refused) as unknown as typeof fetch });
        // The failure is not one the store wrote, so its text stays behind the boundary.
        const err = await s.getObject("k").catch((e: unknown) => e);
        expect((err as Error).message).toBe("httpStore GET: origin request failed");
        expect(inspect(err, { depth: 6 })).not.toContain("a header read failed");
        expect(cancelled).toBe(1);
    });
});
