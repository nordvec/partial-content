import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsStore } from "../fs";
import { removeTree } from "./temp-cleanup";
import { azureStore } from "../azure";
import { isAzureNotFound, isAzurePreconditionFailed } from "../azure-errors";
import { gcsStore } from "../gcs";
import { isGcsNotFound, isGcsPreconditionFailed } from "../gcs-errors";
import { encodeKeyPath, httpStore, StoreUnavailableError } from "../http";
import { ObjectNotFoundError } from "../index";
import { classifyStoreRead, reservedKeyGuard, urlKeyGuard } from "../object-store";
import { r2Store } from "../r2";
import { s3Store } from "../s3";
import { isNotFoundError, isPreconditionFailedError } from "../s3-errors";
import { serveObject } from "../web";

const okFetch = (seen: string[] = []) =>
    (async (input: string | URL) => {
        seen.push(String(input));
        return new Response(null, { status: 200, headers: { "content-length": "3" } });
    }) as unknown as typeof fetch;

/** A backend client whose every method call is counted and answers another such client. */
function untouchable(): { client: never; calls: () => number } {
    let calls = 0;
    const node = (): object =>
        new Proxy(() => {}, {
            get: (_target, prop) => (prop === "then" ? undefined : node()),
            apply: () => {
                calls++;
                return node();
            },
        });
    const root = new Proxy({}, { get: (_target, prop) => (prop === "then" ? undefined : node()) });
    return { client: root as never, calls: () => calls };
}

describe("the key guard is linear in the key's length", () => {
    // A run of spaces inside a segment: a trailing-space trim retried from every space is quadratic.
    const spaced = `a${" ".repeat(64_000)}b`;
    test("urlKeyGuard judges a 64,000-space run in bounded time", () => {
        const guard = urlKeyGuard(".uploads/");
        const started = performance.now();
        guard(spaced);
        expect(performance.now() - started).toBeLessThan(250);
    });

    test("httpStore judges the same key in bounded time when its cap admits it", async () => {
        const seen: string[] = [];
        const store = httpStore({
            url: (k) => `https://o.example/${encodeKeyPath(k)}`,
            maxKeyBytes: 70_000,
            fetch: okFetch(seen),
        });
        const started = performance.now();
        expect((await store.headObject(spaced)).contentLength).toBe(3);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(seen.length).toBe(1);
    });
});

describe("a key over the backend's length cap is not found before any other reading", () => {
    test("httpStore: 1024 UTF-8 bytes is fetched, 1025 is not", async () => {
        const seen: string[] = [];
        const store = httpStore({ url: (k) => `https://o.example/${encodeKeyPath(k)}`, fetch: okFetch(seen) });
        expect((await store.headObject("a".repeat(1024))).contentLength).toBe(3);
        await expect(store.headObject("a".repeat(1025))).rejects.toBeInstanceOf(ObjectNotFoundError);
        // Bytes, not UTF-16 units: 342 three-byte characters are 1026 bytes.
        await expect(store.headObject("€".repeat(342))).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(seen.length).toBe(1);
    });

    test("httpStore: maxKeyBytes sets the cap, and an invalid one is a TypeError", async () => {
        const seen: string[] = [];
        const store = httpStore({ url: (k) => `https://o.example/${k}`, maxKeyBytes: 8, fetch: okFetch(seen) });
        expect((await store.headObject("abcdefgh")).contentLength).toBe(3);
        await expect(store.headObject("abcdefghi")).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(seen.length).toBe(1);
        for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => httpStore({ url: (k) => `https://o.example/${k}`, maxKeyBytes: bad })).toThrow(TypeError);
        }
    });

    test("reservedKeyGuard: an invalid maxKeyBytes is a TypeError", () => {
        expect(() => reservedKeyGuard(".uploads/", { maxKeyBytes: 0 })).toThrow(TypeError);
        expect(() => reservedKeyGuard(".uploads/", { maxKeyBytes: 2 })("abc")).toThrow(ObjectNotFoundError);
    });

    const stores: Record<string, (client: never) => { headObject(key: string): Promise<unknown> }> = {
        s3: (client) => s3Store({ client, bucket: "b" }),
        r2: (client) => r2Store({ bucket: client }),
        gcs: (client) => gcsStore({ storage: client, bucket: "b" }),
        azure: (client) => azureStore({ containerClient: client }),
    };
    for (const [name, build] of Object.entries(stores)) {
        const cap = name === "azure" ? 4096 : 1024;
        test(`${name}: a key over ${cap} bytes never reaches the backend`, async () => {
            const { client, calls } = untouchable();
            // A constructor may resolve a handle (gcs: storage.bucket), so count from here.
            const store = build(client);
            const before = calls();
            await expect(store.headObject("k".repeat(cap + 1))).rejects.toBeInstanceOf(ObjectNotFoundError);
            expect(calls()).toBe(before);
        });
    }
});

describe("httpStore serves a key whose name holds ? or #", () => {
    const served = ["#1 Invoice.pdf", "#general/x.json", "?what.txt", "inbox/#1 report.pdf", "tags/?/x"];
    for (const key of served) {
        test(`${JSON.stringify(key)} is fetched as the object it names`, async () => {
            const seen: string[] = [];
            const store = httpStore({ url: (k) => `https://o.example/b/${encodeKeyPath(k)}`, fetch: okFetch(seen) });
            expect((await store.headObject(key)).contentLength).toBe(3);
            expect(seen).toEqual([`https://o.example/b/${encodeKeyPath(key)}`]);
            expect(decodeURIComponent(new URL(seen[0]!).pathname)).toBe(`/b/${key}`);
        });
    }

    for (const key of [
        ".uploads?x",
        "a/..?x",
        ".uploads#x",
        "a/..#x",
        // Decoded, then cut at the ? or #, then trimmed or folded.
        ".uploads%20%3F",
        ".UPLOADS%20%3F",
        ".uploads%20%23x",
        "．uploads%3F",
        "a/..%3Fx",
        "a/..%23x",
        "%2e%2e%3F",
        // A fullwidth solidus or reverse solidus is a separator in normal form NFKC.
        "x／..／.uploads／y",
        "x＼..＼.uploads＼y",
        // Decoded, then read in NFKC, then trimmed, cut or resolved.
        ".uploads．/x",
        ".uploads　/x",
        ".uploads․/x",
        ".uploads？",
        ".uploads＃x",
        ".uploads﹟",
        "..？",
        "..＃",
        "．．？",
        "..﹖",
        "..%EF%BC%9F",
        "a/..？x",
        "%2euploads%2E＼",
    ]) {
        test(`${JSON.stringify(key)} stays refused, encoded or not`, async () => {
            for (const url of [
                (k: string) => `https://o.example/${encodeKeyPath(k)}`,
                (k: string) => `https://o.example/${k}`,
            ]) {
                const seen: string[] = [];
                const store = httpStore({ url, fetch: okFetch(seen) });
                await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
                expect(seen).toEqual([]);
            }
        });
    }

    test("a byte-order mark inside a key does not hide a ? from the gate", async () => {
        const seen: string[] = [];
        const store = httpStore({ url: (k) => `https://o.example/${encodeKeyPath(k)}`, fetch: okFetch(seen) });
        expect((await store.headObject("a﻿?b")).contentLength).toBe(3);
        expect(seen).toEqual(["https://o.example/a%EF%BB%BF%3Fb"]);
    });

    test("encodeKeyPath keeps an empty segment only under verbatim keys", () => {
        expect(encodeKeyPath("a//b", { keys: "verbatim" })).toBe("a//b");
        expect(encodeKeyPath("a/b")).toBe("a/b");
    });

    test("encodeKeyPath refuses a leading empty segment under every policy", () => {
        for (const keys of ["plain", "verbatim"] as const) {
            expect(() => encodeKeyPath("/a", { keys })).toThrow(ObjectNotFoundError);
            expect(() => encodeKeyPath("//a", { keys })).toThrow(ObjectNotFoundError);
        }
    });

    test("a key that names an object with an encoded ? past its stem is still served", async () => {
        const seen: string[] = [];
        const store = httpStore({ url: (k) => `https://o.example/${encodeKeyPath(k)}`, fetch: okFetch(seen) });
        expect((await store.headObject("report%3Fv2.pdf")).contentLength).toBe(3);
        expect(seen).toEqual(["https://o.example/report%253Fv2.pdf"]);
    });
});

describe("httpStore callback failures never classify the read", () => {
    const cases: Record<string, unknown> = {
        "status 404": Object.assign(new Error("x"), { status: 404 }),
        "name NotFound": Object.assign(new Error("x"), { name: "NotFound" }),
        "status 503": Object.assign(new Error("x"), { status: 503, retryAfterSeconds: 7 }),
    };
    for (const [label, thrown] of Object.entries(cases)) {
        for (const where of ["url", "headers"] as const) {
            test(`a ${where}() throwing ${label} is served as 502`, async () => {
                const store = httpStore({
                    url: where === "url" ? () => Promise.reject(thrown) : (k) => `https://o.example/${k}`,
                    headers:
                        where === "headers"
                            ? () => {
                                  throw thrown;
                              }
                            : undefined,
                    fetch: okFetch(),
                });
                const response = await serveObject(store, { onError: () => {} })(new Request("https://app.example/x"), {
                    key: "x.pdf",
                });
                expect(response.status).toBe(502);
                expect(response.headers.get("retry-after")).toBeNull();
            });
        }
    }

    test("a url() outage for a key no URL parser reads is still a 502, not the object's 404", async () => {
        const store = httpStore({
            url: () => {
                throw new Error("presigner down");
            },
            keys: "verbatim",
            fetch: okFetch(),
        });
        const response = await serveObject(store, { onError: () => {} })(new Request("https://app.example/x"), {
            key: "a://[/x.pdf",
        });
        expect(response.status).toBe(502);
    });

    test("a StoreUnavailableError from url() is served as 503 with its Retry-After", async () => {
        const store = httpStore({
            url: () => {
                throw new StoreUnavailableError("x.pdf", { retryAfterSeconds: 9 });
            },
            fetch: okFetch(),
        });
        const response = await serveObject(store, { onError: () => {} })(new Request("https://app.example/x"), {
            key: "x.pdf",
        });
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("9");
    });

    // Another copy of this package (one ESM, one CommonJS) throws errors of the same name and another class.
    test("the contract errors from url() are recognised by name", async () => {
        const named = (name: string, extra: object = {}) => Object.assign(new Error("x"), { name }, extra);
        for (const [thrown, status, retryAfter] of [
            [named("ObjectNotFoundError"), 404, null],
            [named("StoreUnavailableError", { retryAfterSeconds: 4 }), 503, "4"],
        ] as const) {
            const store = httpStore({ url: () => Promise.reject(thrown), fetch: okFetch() });
            const response = await serveObject(store, { onError: () => {} })(new Request("https://app.example/x"), {
                key: "x.pdf",
            });
            expect(response.status).toBe(status);
            expect(response.headers.get("retry-after")).toBe(retryAfter);
        }
    });
});

describe("httpStore refuses credentials in a URL", () => {
    test("a url() that returns userinfo is refused before any fetch", async () => {
        const seen: string[] = [];
        const store = httpStore({ url: (k) => `https://user:pw@o.example/${k}`, fetch: okFetch(seen) });
        const failure = await store.headObject("x.pdf").catch((err: unknown) => err);
        expect(failure).toBeInstanceOf(TypeError);
        expect(String(failure)).not.toContain("pw");
        expect(seen).toEqual([]);
    });

    test("a redirect hop to a URL with userinfo is refused", async () => {
        const seen: string[] = [];
        const store = httpStore({
            url: (k) => `https://o.example/${k}`,
            redirect: "follow",
            fetch: (async (input: string | URL) => {
                seen.push(String(input));
                return new Response(null, { status: 302, headers: { location: "https://u:p@o.example/y" } });
            }) as unknown as typeof fetch,
        });
        await expect(store.headObject("x.pdf")).rejects.toThrow("redirect was refused");
        expect(seen.length).toBe(1);
    });
});

describe("httpStore redirect chains", () => {
    const chain = (hops: number, last = 200) => {
        const seen: string[] = [];
        const fetchImpl = (async (input: string | URL) => {
            seen.push(String(input));
            const n = seen.length;
            if (n <= hops) {
                return new Response(null, { status: 302, headers: { location: `https://o.example/hop${n}` } });
            }
            return new Response(null, { status: last, headers: { "content-length": "3" } });
        }) as unknown as typeof fetch;
        return { seen, fetchImpl };
    };

    test("ten redirects then a 200 is served", async () => {
        const { seen, fetchImpl } = chain(10);
        const store = httpStore({ url: (k) => `https://o.example/${k}`, redirect: "follow", fetch: fetchImpl });
        expect((await store.headObject("x.pdf")).contentLength).toBe(3);
        expect(seen.length).toBe(11);
    });

    test("an eleventh redirect is refused", async () => {
        const { fetchImpl } = chain(11);
        const store = httpStore({ url: (k) => `https://o.example/${k}`, redirect: "follow", fetch: fetchImpl });
        await expect(store.headObject("x.pdf")).rejects.toThrow("redirect was refused");
    });

    test("an http to https hop counts as another origin, so caller headers are dropped", async () => {
        const sent: Headers[] = [];
        const store = httpStore({
            url: (k) => `http://o.example/${k}`,
            redirect: "follow",
            headers: { authorization: "Bearer t" },
            fetch: (async (input: string | URL, init?: RequestInit) => {
                sent.push(new Headers(init?.headers));
                if (String(input).startsWith("http:")) {
                    return new Response(null, { status: 301, headers: { location: "https://o.example/x.pdf" } });
                }
                return new Response(null, { status: 200, headers: { "content-length": "3" } });
            }) as unknown as typeof fetch,
        });
        expect((await store.headObject("x.pdf")).contentLength).toBe(3);
        expect(sent[0]!.get("authorization")).toBe("Bearer t");
        expect(sent[1]!.get("authorization")).toBeNull();
    });

    test("an abort mid-chain stops the chain", async () => {
        const controller = new AbortController();
        let calls = 0;
        const store = httpStore({
            url: (k) => `https://o.example/${k}`,
            redirect: "follow",
            fetch: (async (_input: string | URL, init?: RequestInit) => {
                calls++;
                if (calls === 2) controller.abort();
                if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
                return new Response(null, { status: 302, headers: { location: `https://o.example/h${calls}` } });
            }) as unknown as typeof fetch,
        });
        const failure = await store.getObject("x.pdf", { signal: controller.signal }).catch((err: unknown) => err);
        expect((failure as Error).name).toBe("AbortError");
        expect(calls).toBe(2);
    });
});

describe("httpStore releases a HEAD body", () => {
    for (const status of [200, 404, 500, 503]) {
        test(`a HEAD answered ${status} with a body has that body cancelled`, async () => {
            let cancelled = false;
            const body = new ReadableStream({
                cancel() {
                    cancelled = true;
                },
            });
            const store = httpStore({
                url: (k) => `https://o.example/${k}`,
                fetch: (async () =>
                    new Response(body, { status, headers: { "content-length": "3" } })) as unknown as typeof fetch,
            });
            await store.headObject("x.pdf").catch(() => undefined);
            expect(cancelled).toBe(true);
        });
    }
});

describe("the backend error classifiers are total", () => {
    const hostile = new Proxy(
        {},
        {
            get: () => {
                throw new Error("getter");
            },
            getPrototypeOf: () => {
                throw new Error("trap");
            },
            has: () => {
                throw new Error("trap");
            },
        },
    );
    const throwingGetter = Object.defineProperty(new Error("x"), "statusCode", {
        get: () => {
            throw new Error("getter");
        },
    });
    const values: unknown[] = [null, undefined, 0, "BlobNotFound", hostile, throwingGetter, { $metadata: null }];
    const classifiers = {
        isNotFoundError,
        isPreconditionFailedError,
        isGcsNotFound,
        isGcsPreconditionFailed,
        isAzureNotFound,
        isAzurePreconditionFailed,
    };
    for (const [name, classify] of Object.entries(classifiers)) {
        test(`${name} answers false, never throws, on an unreadable value`, () => {
            for (const value of values) expect(classify(value)).toBe(false);
        });
    }

    test("a RestError whose message is not a string is not read as BlobNotFound", () => {
        const err = Object.assign(new Error("x"), { name: "RestError" });
        Object.defineProperty(err, "message", { value: { includes: () => true } });
        expect(isAzureNotFound(err)).toBe(false);
        expect(isAzurePreconditionFailed(err)).toBe(false);
    });

    test("a store read whose failure is a hostile Proxy leaves with that failure, not a classifier's", async () => {
        // Caught in place: returning the Proxy from a promise would read its `then`.
        let failure: unknown;
        try {
            await classifyStoreRead("k", () => Promise.reject(hostile), {
                notFound: () => {
                    throw new Error("classifier");
                },
                changed: () => false,
                throttled: () => false,
            });
        } catch (err) {
            failure = err;
        }
        expect(failure === hostile).toBe(true);
    });
});

describe("the filesystem store's device-name trim is linear", () => {
    test("a key with a long interior run of dots and spaces is judged in bounded time", async () => {
        const root = await mkdtemp(join(tmpdir(), "pc-trim-"));
        try {
            const store = fsStore({ root });
            const started = performance.now();
            await expect(store.headObject(`a${". ".repeat(400)}b`)).rejects.toBeInstanceOf(ObjectNotFoundError);
            const key = `a${". ".repeat(32_000)}b`;
            await store.headObject(key).catch(() => {});
            expect(performance.now() - started).toBeLessThan(500);
        } finally {
            await removeTree(root);
        }
    });
});

describe("a fullwidth separator does not hide a dot segment from the guard", () => {
    test("reservedKeyGuard under URL-built keys refuses x／..／.uploads／y", () => {
        const guard = urlKeyGuard(".uploads/");
        expect(() => guard("x／..／.uploads／y")).toThrow(ObjectNotFoundError);
        expect(() => guard(".uploads／y")).toThrow(ObjectNotFoundError);
        expect(() => guard("x／y")).not.toThrow();
    });
});
