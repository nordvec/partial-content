import { describe, expect, test } from "bun:test";
import type { ObjectMetadata, ObjectStore, ObjectStream, ParsedRange, ReadRange } from "../index";
import { serveObject } from "../web";

/**
 * A read to the end of the object reaches a store as a range with no `end`.
 * The contract is enforced by the compiler: a store written for the closed
 * range (`end: number`) must stop compiling, because it would otherwise send
 * `bytes=3-undefined` to its backend.
 */
const HEAD: ObjectMetadata = { contentLength: 10, etag: '"x"' };

describe("an open range", () => {
    test("a store typed for a closed range does not satisfy ObjectStore", () => {
        const closedOnly = {
            supportsRange: true,
            authoritativeRange: true,
            async headObject(): Promise<ObjectMetadata> {
                return HEAD;
            },
            async getObject(_key: string, opts?: { range?: ParsedRange }): Promise<ObjectStream> {
                const length = opts?.range ? opts.range.end - opts.range.start + 1 : 10;
                return { body: new Uint8Array(length), contentLength: length, totalSize: 10 };
            },
        };
        // @ts-expect-error getObject assumes a numeric `end`, which an open read does not have
        const store: ObjectStore = closedOnly;
        expect(store.supportsRange).toBe(true);
    });

    test("a store that handles the open end compiles and receives it as absent", async () => {
        const seen: (ReadRange | undefined)[] = [];
        const store: ObjectStore = {
            supportsRange: true,
            authoritativeRange: true,
            async headObject(): Promise<ObjectMetadata> {
                return HEAD;
            },
            async getObject(_key, opts): Promise<ObjectStream> {
                seen.push(opts?.range);
                const start = opts?.range?.start ?? 0;
                const end = opts?.range?.end ?? 9;
                return {
                    body: new Uint8Array(end - start + 1),
                    contentLength: end - start + 1,
                    totalSize: 10,
                    range: { start, end },
                    etag: '"x"',
                };
            },
        };
        const res = await serveObject(store)(
            { method: "GET", headers: new Headers({ range: "bytes=3-" }) },
            { key: "k", mime: "application/octet-stream" },
        );
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe("bytes 3-9/10");
        expect(seen[0]).toEqual({ start: 3, end: undefined });
    });
});
