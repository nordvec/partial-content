import { describe, test, expect } from "bun:test";
import { serveObject } from "../web";
import type { ObjectStore, ObjectStream, ParsedRange } from "../index";

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
        async getObject(_key: string, opts?: { range?: ParsedRange }): Promise<ObjectStream> {
            const v = getOverride ?? later;
            const r = opts?.range;
            const slice = r ? bytes.slice(r.start, r.end + 1) : bytes;
            return {
                body: slice,
                contentLength: slice.length,
                totalSize: bytes.length,
                range: r ? { start: r.start, end: r.end } : undefined,
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
