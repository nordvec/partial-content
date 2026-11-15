import { describe, test, expect } from "bun:test";
import { serveObject } from "../web";
import type { ObjectStore, ObjectStream, ReadRange } from "../index";

/**
 * A store that cannot pin a read: it ignores `ifMatch`, and the object it holds
 * is replaced after the first HEAD, so the GET describes newer bytes than the
 * HEAD that validated the request.
 */
const DIGEST_OLD = btoa("o".repeat(32));
const DIGEST_NEW = btoa("n".repeat(32));
const BODY = "0123456789".repeat(100);

interface Version {
    etag?: string;
    lastModified?: string;
    digest?: string;
}

function replacedAfterFirstHead(first: Version, later: Version, getOverride?: Version): ObjectStore {
    let heads = 0;
    const bytes = new TextEncoder().encode(BODY);
    return {
        supportsRange: true,
        async headObject() {
            const v = heads++ === 0 ? first : later;
            return { contentLength: bytes.length, ...v };
        },
        async getObject(_key: string, opts?: { range?: ReadRange }): Promise<ObjectStream> {
            const v = getOverride ?? later;
            const r = opts?.range;
            const slice = r ? bytes.slice(r.start, (r.end ?? bytes.length - 1) + 1) : bytes;
            return {
                body: slice,
                contentLength: slice.length,
                totalSize: bytes.length,
                range: r ? { start: r.start, end: r.end ?? bytes.length - 1 } : undefined,
                ...v,
            };
        },
    };
}

const url = "http://localhost/f";
const get = (headers: Record<string, string>) => new Request(url, { headers });

describe("a body read is accepted against the validating HEAD on every path", () => {
    test("a multipart response never claims the representation the HEAD described", async () => {
        const store = replacedAfterFirstHead(
            { etag: '"v1"', digest: DIGEST_OLD },
            { etag: '"v2"', digest: DIGEST_NEW },
        );
        const res = await serveObject(store)(get({ Range: "bytes=0-1,900-901" }), { key: "f" });
        expect(res.status).toBe(206);
        expect(res.headers.get("ETag")).toBe('"v2"');
        expect(res.headers.get("Repr-Digest")).toContain(DIGEST_NEW);
    });

    test("a multipart response over a Last-Modified-only store re-validates too", async () => {
        const store = replacedAfterFirstHead(
            { lastModified: "Sat, 28 Jun 2025 12:00:00 GMT" },
            { lastModified: "Sun, 29 Jun 2025 12:00:00 GMT" },
        );
        const res = await serveObject(store)(get({ Range: "bytes=0-1,900-901" }), { key: "f" });
        expect(res.status).toBe(206);
        expect(res.headers.get("Last-Modified")).toBe("Sun, 29 Jun 2025 12:00:00 GMT");
    });

    test("a full 200 never pairs the HEAD's Repr-Digest with bytes from a newer read", async () => {
        const store = replacedAfterFirstHead({ etag: '"v1"', digest: DIGEST_OLD }, { etag: '"v2"' });
        const res = await serveObject(store)(get({ "If-None-Match": '"other"' }), { key: "f" });
        expect(res.status).toBe(200);
        expect(res.headers.get("ETag")).toBe('"v2"');
        expect(res.headers.get("Repr-Digest")).toBeNull();
    });

    test("a full 200 whose read reports no validators asserts none of the HEAD's", async () => {
        const store = replacedAfterFirstHead(
            { etag: 'W/"v1"', digest: DIGEST_OLD },
            { etag: 'W/"v1"', digest: DIGEST_OLD },
            {},
        );
        const res = await serveObject(store)(get({ "If-None-Match": '"other"' }), { key: "f" });
        expect(res.status).toBe(200);
        expect(res.headers.get("Repr-Digest")).toBeNull();
    });

    test("a sent ifMatch is no proof of a pinned read from a store that ignores it", async () => {
        // HEAD names "v1", the object is overwritten with same-length bytes, and
        // the read (ifMatch ignored) names nothing: the 206 must not carry "v1".
        const old = new TextEncoder().encode("AAAAAAAAAA");
        const replaced = new TextEncoder().encode("BBBBBBBBBB");
        const store: ObjectStore = {
            supportsRange: true,
            async headObject() {
                return { contentLength: old.length, etag: '"v1"', digest: DIGEST_OLD };
            },
            async getObject(_key, opts): Promise<ObjectStream> {
                const r = opts?.range ?? { start: 0, end: replaced.length - 1 };
                return {
                    body: replaced.slice(r.start, (r.end ?? replaced.length - 1) + 1),
                    contentLength: (r.end ?? replaced.length - 1) - r.start + 1,
                    totalSize: replaced.length,
                    range: opts?.range ? { start: r.start, end: r.end ?? replaced.length - 1 } : undefined,
                };
            },
        };
        const res = await serveObject(store)(get({ Range: "bytes=5-9", "If-Range": '"v1"' }), { key: "f" });
        expect(res.status).toBe(206);
        expect(await res.text()).toBe("BBBBB");
        expect(res.headers.get("ETag")).toBeNull();
        expect(res.headers.get("Repr-Digest")).toBeNull();
        // The same store declaring that it enforces the pin is believed.
        const pinning = serveObject({ ...store, pinsReads: true });
        const pinned = await pinning(get({ Range: "bytes=5-9", "If-Range": '"v1"' }), { key: "f" });
        expect(pinned.headers.get("ETag")).toBe('"v1"');
    });

    test("an unchanged object keeps its HEAD digest on a full 200 and a multipart 206", async () => {
        const v = { etag: '"v1"', digest: DIGEST_OLD };
        const full = await serveObject(replacedAfterFirstHead(v, v))(get({ "If-None-Match": '"other"' }), { key: "f" });
        expect(full.headers.get("Repr-Digest")).toContain(DIGEST_OLD);
        const multi = await serveObject(replacedAfterFirstHead(v, v))(get({ Range: "bytes=0-1,900-901" }), {
            key: "f",
        });
        expect(multi.status).toBe(206);
        expect(multi.headers.get("Repr-Digest")).toContain(DIGEST_OLD);
    });
});
