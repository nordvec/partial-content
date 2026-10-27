/**
 * Interop 9 creation responses carry Upload-Limit wherever limits exist, so a
 * client that skipped OPTIONS learns its append ceiling before its first 413,
 * with the max-age that remains on the resource it just created.
 */
import { describe, test, expect } from "bun:test";
import { createUploadHandler } from "../upload.ts";
import { memoryUploadStore } from "../memory.ts";

const NOW = 1_800_000_000_000;

function creation(version: number, clock: { t: number }) {
    const handler = createUploadHandler(memoryUploadStore({ objects: {} }), {
        key: () => "k",
        location: (t) => `/uploads/${t}`,
        policy: { maxSize: 1024, maxAppendSize: 256, maxAgeSeconds: 3600 },
        now: () => clock.t,
        graceMs: 0,
    });
    const completeness: Record<string, string> =
        version >= 5 ? { "Upload-Complete": "?0" } : { "Upload-Incomplete": "?1" };
    return handler(
        new Request("http://localhost/uploads", {
            method: "POST",
            headers: { "Upload-Draft-Interop-Version": String(version), ...completeness },
        }),
    );
}

describe("Upload-Limit on a creation response", () => {
    test("interop 9 announces the limits and the remaining lifetime", async () => {
        const res = await creation(9, { t: NOW });
        expect(res.status).toBe(201);
        expect(res.headers.get("Upload-Limit")).toBe("max-size=1024, min-size=0, max-append-size=256, max-age=3600");
    });

    test("versions that ask for it only on OPTIONS leave it off", async () => {
        const res = await creation(6, { t: NOW });
        expect(res.status).toBe(201);
        expect(res.headers.get("Upload-Limit")).toBeNull();
    });
});
