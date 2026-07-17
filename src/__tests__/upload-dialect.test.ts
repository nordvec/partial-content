import { describe, test, expect } from "bun:test";
import { createUploadHandler, type UploadHandlerOptions } from "../upload.ts";
import { memoryUploadStore, type MemoryObject } from "../memory.ts";
import { UploadLockTimeoutError, type UploadLocker } from "../upload-locker.ts";
import type { ResumableWriteStore } from "../upload-store.ts";

const NOW = 1_800_000_000_000;
const VERSION_HEADER = "Upload-Draft-Interop-Version";

/**
 * Independent statement of each version's wire facts (hardcoded, never
 * derived through the implementation's own mapping): interop 3 signals
 * completeness through Upload-Incomplete with inverted polarity, 5 and 6
 * through Upload-Complete, and only 6 requires the partial-upload media
 * type and speaks problem+json on 409.
 */
const WIRE = {
    3: {
        header: "Upload-Incomplete",
        other: "Upload-Complete",
        complete: "?0",
        incomplete: "?1",
        patchType: undefined as string | undefined,
        problem409: false,
        headLength: false,
    },
    5: {
        header: "Upload-Complete",
        other: "Upload-Incomplete",
        complete: "?1",
        incomplete: "?0",
        patchType: undefined as string | undefined,
        problem409: false,
        headLength: false,
    },
    6: {
        header: "Upload-Complete",
        other: "Upload-Incomplete",
        complete: "?1",
        incomplete: "?0",
        patchType: "application/partial-upload" as string | undefined,
        problem409: true,
        headLength: true,
    },
} as const;

type Version = keyof typeof WIRE;
const VERSIONS: Version[] = [3, 5, 6];

function bytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

async function sha256Base64(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes(text));
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function harness(over: Partial<UploadHandlerOptions> = {}, store?: ResumableWriteStore) {
    const writeStore = store ?? memoryUploadStore({ objects: {} });
    let clock = NOW;
    const handler = createUploadHandler(writeStore, {
        key: () => "doc.bin",
        location: (t) => `/uploads/${t}`,
        now: () => clock,
        graceMs: 0,
        ...over,
    });
    return { handler, store: writeStore, tick: (ms: number) => { clock += ms; } };
}

function createRequest(
    version: number,
    opts: {
        completeness?: string;
        body?: Uint8Array;
        headers?: Record<string, string>;
        omitVersion?: boolean;
    } = {},
): Request {
    const headers: Record<string, string> = { ...opts.headers };
    if (!opts.omitVersion) headers[VERSION_HEADER] = String(version);
    if (opts.completeness !== undefined) {
        headers[WIRE[version as Version].header] = opts.completeness;
    }
    return new Request("http://test/upload", { method: "POST", headers, body: opts.body });
}

function patchRequest(
    version: Version,
    opts: { offset?: string; completeness?: string; body?: Uint8Array; headers?: Record<string, string> } = {},
): Request {
    const w = WIRE[version];
    const headers: Record<string, string> = {
        [VERSION_HEADER]: String(version),
        ...(opts.offset !== undefined ? { "Upload-Offset": opts.offset } : {}),
        ...(w.patchType !== undefined ? { "Content-Type": w.patchType } : {}),
        ...opts.headers,
    };
    if (opts.completeness !== undefined) headers[w.header] = opts.completeness;
    return new Request("http://test/uploads/x", { method: "PATCH", headers, body: opts.body });
}

function resourceRequest(version: Version, method: string, headers: Record<string, string> = {}): Request {
    return new Request("http://test/uploads/x", {
        method,
        headers: { [VERSION_HEADER]: String(version), ...headers },
    });
}

/** Create an incomplete 10-byte upload holding "hello" and return its token. */
async function createIncomplete(handler: ReturnType<typeof harness>["handler"], version: Version) {
    const res = await handler(createRequest(version, {
        completeness: WIRE[version].incomplete,
        body: bytes("hello"),
        headers: { "Upload-Length": "10", "Content-Length": "5" },
    }));
    expect(res.status).toBe(201);
    const location = res.headers.get("Location")!;
    return { token: location.slice("/uploads/".length), location };
}

function expectErrorHardening(res: Response) {
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
}

for (const version of VERSIONS) {
    const w = WIRE[version];

    describe(`interop version ${version}`, () => {
        test("incomplete creation round trip: 201, Location, completeness polarity, offset", async () => {
            const { handler } = harness();
            const res = await handler(createRequest(version, {
                completeness: w.incomplete,
                body: bytes("hello"),
                headers: { "Upload-Length": "10", "Content-Length": "5" },
            }));
            expect(res.status).toBe(201);
            expect(res.headers.get(VERSION_HEADER)).toBe(String(version));
            expect(res.headers.get("Location")).toMatch(/^\/uploads\//);
            expect(res.headers.get("Upload-Offset")).toBe("5");
            expect(res.headers.get(w.header)).toBe(w.incomplete);
            // The polarity flip is a header RENAME: the other version family's
            // header must not appear at all.
            expect(res.headers.get(w.other)).toBeNull();
        });

        test("completing creation publishes and answers the complete polarity", async () => {
            const objects: Record<string, MemoryObject> = {};
            const store = memoryUploadStore({ objects });
            const { handler } = harness({}, store);
            const res = await handler(createRequest(version, {
                completeness: w.complete,
                body: bytes("hello"),
                headers: { "Content-Length": "5" },
            }));
            expect(res.status).toBe(201);
            expect(res.headers.get(w.header)).toBe(w.complete);
            expect(res.headers.get("Upload-Offset")).toBe("5");
            expect(res.headers.get("Location")).toMatch(/^\/uploads\//);
            expect(Object.keys(objects)).toEqual(["doc.bin"]);
        });

        test("append happy path advances the offset and stays incomplete", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(
                patchRequest(version, {
                    offset: "5",
                    completeness: w.incomplete,
                    body: bytes("wor"),
                    headers: { "Content-Length": "3" },
                }),
                { uploadToken: token },
            );
            expect(res.status).toBe(201);
            expect(res.headers.get(VERSION_HEADER)).toBe(String(version));
            expect(res.headers.get("Upload-Offset")).toBe("8");
            expect(res.headers.get(w.header)).toBe(w.incomplete);
            expect(res.headers.get(w.other)).toBeNull();
        });

        test("completing append reaches the declared length and flips completeness", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(
                patchRequest(version, {
                    offset: "5",
                    completeness: w.complete,
                    body: bytes("world"),
                    headers: { "Content-Length": "5" },
                }),
                { uploadToken: token },
            );
            expect(res.status).toBe(201);
            expect(res.headers.get("Upload-Offset")).toBe("10");
            expect(res.headers.get(w.header)).toBe(w.complete);
        });

        test("append at a stale offset answers 409 with the correct offset and completeness", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(
                patchRequest(version, {
                    offset: "2",
                    completeness: w.incomplete,
                    body: bytes("XY"),
                    headers: { "Content-Length": "2" },
                }),
                { uploadToken: token },
            );
            expect(res.status).toBe(409);
            expect(res.headers.get(VERSION_HEADER)).toBe(String(version));
            expect(res.headers.get("Upload-Offset")).toBe("5");
            expect(res.headers.get(w.header)).toBe(w.incomplete);
            expectErrorHardening(res);
            if (w.problem409) {
                expect(res.headers.get("Content-Type")).toBe("application/problem+json");
                const body = await res.json() as Record<string, unknown>;
                expect(body.type).toBe(
                    "https://iana.org/assignments/http-problem-types#mismatching-upload-offset",
                );
                expect(body["expected-offset"]).toBe(5);
                expect(body["provided-offset"]).toBe(2);
            } else {
                expect(res.headers.get("Content-Length")).toBe("0");
                expect(await res.text()).toBe("");
            }
        });

        test("HEAD probes the offset with no-store and the version's completeness header", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(resourceRequest(version, "HEAD"), { uploadToken: token });
            expect(res.status).toBe(204);
            expect(res.headers.get(VERSION_HEADER)).toBe(String(version));
            expect(res.headers.get("Upload-Offset")).toBe("5");
            expect(res.headers.get(w.header)).toBe(w.incomplete);
            expect(res.headers.get("Cache-Control")).toBe("no-store");
            if (w.headLength) {
                expect(res.headers.get("Upload-Length")).toBe("10");
            } else {
                expect(res.headers.get("Upload-Length")).toBeNull();
            }
        });

        test("HEAD on a completed upload reports the complete polarity", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            await handler(
                patchRequest(version, {
                    offset: "5", completeness: w.complete, body: bytes("world"),
                    headers: { "Content-Length": "5" },
                }),
                { uploadToken: token },
            );
            const res = await handler(resourceRequest(version, "HEAD"), { uploadToken: token });
            expect(res.status).toBe(204);
            expect(res.headers.get(w.header)).toBe(w.complete);
            expect(res.headers.get("Upload-Offset")).toBe("10");
        });

        test("HEAD carrying upload-state headers is rejected 400", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(
                resourceRequest(version, "HEAD", { "Upload-Offset": "5" }),
                { uploadToken: token },
            );
            expect(res.status).toBe(400);
            expectErrorHardening(res);
        });

        test("DELETE cancels: 204, then the resource answers 404", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(resourceRequest(version, "DELETE"), { uploadToken: token });
            expect(res.status).toBe(204);
            expect(res.headers.get(VERSION_HEADER)).toBe(String(version));
            const probe = await handler(resourceRequest(version, "HEAD"), { uploadToken: token });
            expect(probe.status).toBe(404);
            expect(probe.headers.get("Content-Length")).toBe("0");
            expectErrorHardening(probe);
        });

        test("DELETE carrying a completeness header is rejected 400", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(
                resourceRequest(version, "DELETE", { [w.header]: w.incomplete }),
                { uploadToken: token },
            );
            expect(res.status).toBe(400);
        });

        test("malformed Upload-Offset is ignored, so the append lacks an offset: 400", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            for (const bad of ["banana", "1.5", "?1", "1e3"]) {
                const res = await handler(
                    patchRequest(version, { offset: bad, completeness: w.incomplete, body: bytes("x") }),
                    { uploadToken: token },
                );
                expect(res.status).toBe(400);
                expectErrorHardening(res);
            }
        });

        test("creation without the version's completeness header is rejected 400 naming it", async () => {
            const { handler } = harness();
            const res = await handler(createRequest(version, { body: bytes("hi") }));
            expect(res.status).toBe(400);
            expect(await res.text()).toContain(w.header);
        });

        test("creation ignores the other version family's completeness header", async () => {
            const { handler } = harness();
            const res = await handler(createRequest(version, {
                body: bytes("hi"),
                headers: { [w.other]: "?1" },
            }));
            expect(res.status).toBe(400);
        });

        test("creation tolerates Upload-Offset: 0 and rejects a non-zero offset", async () => {
            const { handler } = harness();
            const ok = await handler(createRequest(version, {
                completeness: w.incomplete,
                body: bytes("hi"),
                headers: { "Upload-Offset": "0" },
            }));
            expect(ok.status).toBe(201);
            const bad = await handler(createRequest(version, {
                completeness: w.incomplete,
                body: bytes("hi"),
                headers: { "Upload-Offset": "3" },
            }));
            expect(bad.status).toBe(400);
        });

        test("size-exceeded answers 413, floor violations answer 400", async () => {
            const { handler } = harness({ policy: { maxSize: 4, minSize: 2 } });
            const tooBig = await handler(createRequest(version, {
                completeness: w.incomplete,
                headers: { "Upload-Length": "10" },
            }));
            expect(tooBig.status).toBe(413);
            expect(tooBig.headers.get(VERSION_HEADER)).toBe(String(version));
            expectErrorHardening(tooBig);
            const tooSmall = await handler(createRequest(version, {
                completeness: w.incomplete,
                headers: { "Upload-Length": "1" },
            }));
            expect(tooSmall.status).toBe(400);
        });

        test("contended resource answers 423, distinct from the 409 re-anchor", async () => {
            // The setup creation legitimately holds the lock (it streams a
            // body); arm the timeout only afterward so the CONTENTION path
            // (a later append/probe that cannot acquire) is what returns 423.
            let armed = false;
            const locker: UploadLocker = {
                async acquire(uploadToken) {
                    if (armed) throw new UploadLockTimeoutError(uploadToken);
                    return { release() { /* no-op setup lock */ } };
                },
            };
            const { handler } = harness({ locker });
            const created = await handler(createRequest(version, {
                completeness: w.incomplete,
                body: bytes("hello"),
            }));
            armed = true;
            expect(created.status).toBe(201);
            const token = created.headers.get("Location")!.slice("/uploads/".length);
            const append = await handler(
                patchRequest(version, { offset: "5", completeness: w.incomplete, body: bytes("x") }),
                { uploadToken: token },
            );
            expect(append.status).toBe(423);
            const probe = await handler(resourceRequest(version, "HEAD"), { uploadToken: token });
            expect(probe.status).toBe(423);
        });

        test("unknown token answers 404 for probe, append, and cancel", async () => {
            const { handler } = harness();
            for (const req of [
                resourceRequest(version, "HEAD"),
                patchRequest(version, { offset: "0", completeness: w.incomplete, body: bytes("x") }),
                resourceRequest(version, "DELETE"),
            ]) {
                const res = await handler(req, { uploadToken: "missing" });
                expect(res.status).toBe(404);
                expect(res.headers.get(VERSION_HEADER)).toBe(String(version));
            }
        });

        test("restating a different total length is rejected 400 as inconsistent", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(
                patchRequest(version, {
                    offset: "5",
                    completeness: w.incomplete,
                    body: bytes("x"),
                    headers: { "Upload-Length": "20" },
                }),
                { uploadToken: token },
            );
            expect(res.status).toBe(400);
            expect(await res.text()).toContain("inconsistent");
        });

        test("zero-content completing retry on a completed upload replays 200", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            await handler(
                patchRequest(version, {
                    offset: "5", completeness: w.complete, body: bytes("world"),
                    headers: { "Content-Length": "5" },
                }),
                { uploadToken: token },
            );
            const replay = await handler(
                patchRequest(version, { offset: "10", completeness: w.complete }),
                { uploadToken: token },
            );
            expect(replay.status).toBe(200);
            expect(replay.headers.get("Upload-Offset")).toBe("10");
            expect(replay.headers.get(w.header)).toBe(w.complete);
        });

        test("expired resource answers 404", async () => {
            const { handler, tick } = harness({ policy: { maxAgeSeconds: 60 } });
            const { token } = await createIncomplete(handler, version);
            tick(61_000);
            const res = await handler(resourceRequest(version, "HEAD"), { uploadToken: token });
            expect(res.status).toBe(404);
        });

        test("GET on the upload resource answers 405 with Allow", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(resourceRequest(version, "GET"), { uploadToken: token });
            expect(res.status).toBe(405);
            expect(res.headers.get("Allow")).toContain("HEAD");
            expect(res.headers.get("Allow")).toContain("PATCH");
            expect(res.headers.get("Allow")).toContain("DELETE");
        });
    });
}

describe("appending media type gate", () => {
    test("interop 6 requires application/partial-upload on PATCH", async () => {
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 6);
        const res = await handler(
            new Request("http://test/uploads/x", {
                method: "PATCH",
                headers: {
                    [VERSION_HEADER]: "6",
                    "Upload-Offset": "5",
                    "Upload-Complete": "?0",
                    "Content-Type": "application/octet-stream",
                },
                body: bytes("x"),
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("application/partial-upload");
    });

    test("interop 3 and 5 accept appends with any media type", async () => {
        for (const version of [3, 5] as const) {
            const w = WIRE[version];
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(
                new Request("http://test/uploads/x", {
                    method: "PATCH",
                    headers: {
                        [VERSION_HEADER]: String(version),
                        "Upload-Offset": "5",
                        [w.header]: w.incomplete,
                        "Content-Type": "application/octet-stream",
                    },
                    body: bytes("x"),
                }),
                { uploadToken: token },
            );
            expect(res.status).toBe(201);
        }
    });

    test("interop 6 accepts the media type case-insensitively", async () => {
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 6);
        const res = await handler(
            new Request("http://test/uploads/x", {
                method: "PATCH",
                headers: {
                    [VERSION_HEADER]: "6",
                    "Upload-Offset": "5",
                    "Upload-Complete": "?0",
                    "Content-Type": "Application/Partial-Upload",
                },
                body: bytes("x"),
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(201);
    });
});

describe("version gate", () => {
    test("unlisted version answers 400 naming the supported set and echoing the newest", async () => {
        const { handler } = harness();
        for (const bad of ["9", "4", "0", "-3", "abc", "6.0"]) {
            const res = await handler(createRequest(6, {
                completeness: "?0",
                omitVersion: true,
                headers: { [VERSION_HEADER]: bad },
            }));
            expect(res.status).toBe(400);
            expect(res.headers.get(VERSION_HEADER)).toBe("6");
            expect(await res.text()).toContain("3, 5, 6");
            expectErrorHardening(res);
        }
    });

    test("missing version header answers 400 for creation and resource requests", async () => {
        const { handler } = harness();
        const creation = await handler(createRequest(6, { completeness: "?0", omitVersion: true }));
        expect(creation.status).toBe(400);
        const probe = await handler(
            new Request("http://test/uploads/x", { method: "HEAD" }),
            { uploadToken: "t" },
        );
        expect(probe.status).toBe(400);
        expect(await probe.text()).toContain("3, 5, 6");
    });

    test("interopVersions restricts the allowlist", async () => {
        const { handler } = harness({ interopVersions: [6] });
        const res = await handler(createRequest(5, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(400);
        expect(res.headers.get(VERSION_HEADER)).toBe("6");
        expect(await res.text()).toContain("6");
        const ok = await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(ok.status).toBe(201);
    });

    test("construction rejects versions without a wire mapping, and an empty set", () => {
        const store = memoryUploadStore({ objects: {} });
        expect(() => createUploadHandler(store, {
            key: () => "k",
            location: (t) => `/u/${t}`,
            interopVersions: [9],
        })).toThrow(TypeError);
        expect(() => createUploadHandler(store, {
            key: () => "k",
            location: (t) => `/u/${t}`,
            interopVersions: [],
        })).toThrow(TypeError);
    });
});

describe("handler plumbing", () => {
    test("OPTIONS answers method discovery without touching the protocol", async () => {
        const { handler } = harness();
        const res = await handler(new Request("http://test/upload", { method: "OPTIONS" }));
        expect(res.status).toBe(204);
        expect(res.headers.get("Allow")).toContain("PATCH");
    });

    test("resolveToken routes resource requests without ctx", async () => {
        const { handler } = harness({
            resolveToken: (req) => {
                const path = new URL(req.url).pathname;
                return path.startsWith("/uploads/") ? path.slice("/uploads/".length) : undefined;
            },
        });
        const created = await handler(createRequest(6, {
            completeness: "?0",
            body: bytes("hello"),
            headers: { "Upload-Length": "10" },
        }));
        const location = created.headers.get("Location")!;
        const res = await handler(new Request(`http://test${location}`, {
            method: "HEAD",
            headers: { [VERSION_HEADER]: "6" },
        }));
        expect(res.status).toBe(204);
        expect(res.headers.get("Upload-Offset")).toBe("5");
    });

    test("onResumptionSupported fires with token, location, and version", async () => {
        const seen: Array<{ uploadToken: string; location: string; interopVersion: number }> = [];
        const { handler } = harness({ onResumptionSupported: (info) => { seen.push(info); } });
        const res = await handler(createRequest(5, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(201);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.interopVersion).toBe(5);
        expect(seen[0]!.location).toBe(`/uploads/${seen[0]!.uploadToken}`);
        expect(res.headers.get("Location")).toBe(seen[0]!.location);
    });

    test("a throwing resumption hook is routed to onError and the creation still succeeds", async () => {
        const errors: Array<{ operation: string }> = [];
        const { handler } = harness({
            onResumptionSupported: () => { throw new Error("hook boom"); },
            onError: (_err, ctx) => { errors.push(ctx); },
        });
        const res = await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(201);
        expect(errors.some((e) => e.operation === "resumption-hook")).toBe(true);
    });

    test("creation records representation metadata for the store", async () => {
        const { handler, store } = harness();
        const res = await handler(createRequest(6, {
            completeness: "?0",
            body: bytes("x"),
            headers: {
                "Content-Type": "text/markdown",
                "Content-Disposition": 'attachment; filename="notes.md"',
            },
        }));
        const token = res.headers.get("Location")!.slice("/uploads/".length);
        const state = await store.getUploadState(token);
        expect(state.metadata).toMatchObject({
            contentType: "text/markdown",
            contentDisposition: 'attachment; filename="notes.md"',
        });
    });

    test("audit events carry the auditKey instead of the storage key", async () => {
        const events: Array<{ auditKey?: string }> = [];
        const { handler } = harness({
            auditKey: () => "audit-42",
            onUploadEvent: (e) => { events.push(e); },
        });
        await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.auditKey === "audit-42")).toBe(true);
    });

    test("a store failure surfaces as a hardened 500, reported to onError", async () => {
        const store = memoryUploadStore({ objects: {} });
        const broken: ResumableWriteStore = {
            ...store,
            async getUploadState() { throw new Error("disk on fire"); },
        };
        const errors: unknown[] = [];
        const { handler } = harness({ onError: (err) => { errors.push(err); } }, broken);
        const res = await handler(
            new Request("http://test/uploads/x", {
                method: "HEAD",
                headers: { [VERSION_HEADER]: "6" },
            }),
            { uploadToken: "t" },
        );
        expect(res.status).toBe(500);
        expectErrorHardening(res);
        expect(errors).toHaveLength(1);
    });

    test("a throwing key callback never escapes the handler: hardened 500 + onError", async () => {
        const errors: Array<{ operation: string }> = [];
        const { handler } = harness({
            key: () => { throw new Error("key derivation boom"); },
            onError: (_err, ctx) => { errors.push(ctx); },
        });
        const res = await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(500);
        expectErrorHardening(res);
        expect(errors.some((e) => e.operation === "handle")).toBe(true);
    });

    test("interop 6 append MISSING the required completeness header is a 400, never a silent completion", async () => {
        // Fail closed: defaulting an absent (or malformed) completeness header
        // to "completing" would publish a truncated object as done. Interop
        // 5/6 require the header on append, so absent is a client error.
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 6);
        const res = await handler(
            new Request("http://test/uploads/x", {
                method: "PATCH",
                headers: {
                    [VERSION_HEADER]: "6",
                    "Upload-Offset": "5",
                    "Content-Type": "application/partial-upload",
                    "Content-Length": "5",
                    // no Upload-Complete header
                },
                body: bytes("world"),
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(400);
    });

    test("a malformed completeness value is a 400 at every version, never coerced", async () => {
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 6);
        const res = await handler(
            new Request("http://test/uploads/x", {
                method: "PATCH",
                headers: {
                    [VERSION_HEADER]: "6",
                    "Upload-Offset": "5",
                    "Content-Type": "application/partial-upload",
                    "Content-Length": "5",
                    "Upload-Complete": "true", // not an RFC 8941 boolean
                },
                body: bytes("world"),
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(400);
    });
});

describe("digest verification", () => {
    test("completing creation with a matching Repr-Digest sha-256 succeeds", async () => {
        const digest = await sha256Base64("hello");
        const { handler } = harness();
        const res = await handler(createRequest(6, {
            completeness: "?1",
            body: bytes("hello"),
            headers: { "Repr-Digest": `sha-256=:${digest}:` },
        }));
        expect(res.status).toBe(201);
        expect(res.headers.get("Upload-Complete")).toBe("?1");
    });

    test("a mismatching Repr-Digest sha-256 is rejected 400 and nothing publishes", async () => {
        const wrong = await sha256Base64("goodbye");
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { handler } = harness({}, store);
        const res = await handler(createRequest(6, {
            completeness: "?1",
            body: bytes("hello"),
            headers: { "Repr-Digest": `sha-256=:${wrong}:` },
        }));
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("digest");
        expect(Object.keys(objects)).toHaveLength(0);
    });

    test("unsupported digest algorithms are ignored per RFC 9530", async () => {
        const { handler } = harness();
        const res = await handler(createRequest(6, {
            completeness: "?1",
            body: bytes("hello"),
            headers: { "Repr-Digest": "sha-512=:AAAA:" },
        }));
        expect(res.status).toBe(201);
    });
});

// ─── Repr-Digest parsing precision (audit R534) ─────────────────────────────
// The parser is exercised through completing creations: a WELL-FORMED sha-256
// that does not match the body's real digest is rejected 400 (parsed + used);
// any input the parser cannot read is IGNORED, so the upload completes 201.

describe("Repr-Digest parsing", () => {
    /** Complete a creation of "hello" carrying the given Repr-Digest header. */
    async function withReprDigest(reprDigest: string): Promise<Response> {
        const { handler } = harness();
        return handler(new Request("http://test/upload", {
            method: "POST",
            headers: { [VERSION_HEADER]: "6", "Upload-Complete": "?1", "Repr-Digest": reprDigest },
            body: bytes("hello"),
        }));
    }

    // A well-formed 44-char base64 that is NOT the digest of "hello".
    let WRONG: string;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    const wrongReady = sha256Base64("a-different-payload-entirely").then((d) => { WRONG = d; });

    test("a well-formed but wrong sha-256 is parsed and rejected 400", async () => {
        await wrongReady;
        expect((await withReprDigest(`sha-256=:${WRONG}:`)).status).toBe(400);
    });

    test("a matching sha-256 among several members is picked and verified", async () => {
        const right = await sha256Base64("hello");
        expect((await withReprDigest(`unixsum=:AAAA:, sha-256=:${right}:`)).status).toBe(201);
    });

    test("the sha-256 algorithm name is matched case-insensitively", async () => {
        await wrongReady;
        // Wrong digest under an upper-case name is still recognized as sha-256,
        // parsed, and rejected (never silently ignored on casing).
        expect((await withReprDigest(`SHA-256=:${WRONG}:`)).status).toBe(400);
    });

    test("a wrong digest under a non-sha-256 algorithm name is ignored", async () => {
        await wrongReady;
        // The name gate must hold: a valid 44-char digest labelled sha-512 must
        // NOT be treated as the sha-256 assertion.
        expect((await withReprDigest(`sha-512=:${WRONG}:`)).status).toBe(201);
    });

    test("surrounding whitespace on the algorithm name and the value is tolerated", async () => {
        await wrongReady;
        // A space before '=' (name side) and after '=' (value side) must be
        // trimmed, so the wrong digest is still parsed and rejected.
        expect((await withReprDigest(`sha-256 =:${WRONG}:`)).status).toBe(400);
        expect((await withReprDigest(`sha-256= :${WRONG}:`)).status).toBe(400);
    });

    test("a value missing its colon delimiters is ignored", async () => {
        await wrongReady;
        // Wrapped in arbitrary non-colon characters so the inner 44 chars are a
        // valid digest: only the colon guard keeps it from being used.
        expect((await withReprDigest(`sha-256=x${WRONG}x`)).status).toBe(201);
    });

    test("a value with only ONE colon delimiter is ignored (both ends are required)", async () => {
        await wrongReady;
        // A leading colon but no trailing one, and vice versa: each end is guarded
        // independently, so a half-wrapped 44-char quantum must not be used.
        expect((await withReprDigest(`sha-256=:${WRONG}?`)).status).toBe(201);
        expect((await withReprDigest(`sha-256=x${WRONG}:`)).status).toBe(201);
    });

    test("a value that is not a 44-char base64 quantum is ignored", async () => {
        // Short, syntactically wrong inner value: parsed as no digest, completes.
        expect((await withReprDigest("sha-256=:hello:")).status).toBe(201);
    });

    test("extra characters around a 44-char quantum are rejected by the length anchors", async () => {
        await wrongReady;
        // Leading and trailing junk inside the colons: the ^…$ anchors must
        // reject both, so the assertion is ignored and the upload completes.
        expect((await withReprDigest(`sha-256=:AB${WRONG}:`)).status).toBe(201);
        expect((await withReprDigest(`sha-256=:${WRONG}AB:`)).status).toBe(201);
    });
});

// ─── Content-Length parsing precision (audit R534) ──────────────────────────

describe("Content-Length parsing", () => {
    // A creation-with-upload whose Content-Length crosses maxSize is caught
    // up-front (413) only when Content-Length actually parses.
    async function appendCL(contentLength: string): Promise<Response> {
        const { handler } = harness({ policy: { maxSize: 4 } });
        // Deferred length so the empty creation itself is under the maximum; the
        // append's Content-Length is what the size check must catch.
        const created = await handler(createRequest(6, { completeness: "?0" }));
        const token = created.headers.get("Location")!.slice("/uploads/".length);
        return handler(
            new Request("http://test/uploads/x", {
                method: "PATCH",
                headers: {
                    [VERSION_HEADER]: "6",
                    "Upload-Offset": "0",
                    "Upload-Complete": "?0",
                    "Content-Type": "application/partial-upload",
                    "Content-Length": contentLength,
                },
                body: bytes("0123456789"),
            }),
            { uploadToken: token },
        );
    }

    test("a numeric Content-Length over the maximum is parsed and rejected 413", async () => {
        // Real: parsed as 10 > maxSize 4 -> engine size-exceeded before writing.
        expect((await appendCL("10")).status).toBe(413);
    });

    test("a non-numeric Content-Length is ignored (parsed as absent)", async () => {
        // "abc" is not the digits-only grammar: it parses to undefined, so the
        // up-front size check is skipped and the append is bounded while
        // streaming instead (never a 400 from a NaN Content-Length).
        const res = await appendCL("abc");
        expect(res.status).not.toBe(400);
    });

    test("a Content-Length with trailing or leading non-digits does not parse to NaN", async () => {
        // The ^…$ anchors reject "10x" and "x10" outright rather than letting
        // Number() coerce a NaN into the engine (which would 400 as inconsistent).
        expect((await appendCL("10x")).status).not.toBe(400);
        expect((await appendCL("x10")).status).not.toBe(400);
    });
});

// ─── Completeness fail-closed at every version (audit R534) ─────────────────

describe("append completeness by version", () => {
    async function appendNoCompleteness(version: Version, headers: Record<string, string> = {}): Promise<Response> {
        const { handler } = harness();
        const { token } = await createIncomplete(handler, version);
        const w = WIRE[version];
        const reqHeaders: Record<string, string> = {
            [VERSION_HEADER]: String(version),
            "Upload-Offset": "5",
            ...(w.patchType !== undefined ? { "Content-Type": w.patchType } : {}),
            ...headers,
        };
        return handler(
            new Request("http://test/uploads/x", { method: "PATCH", headers: reqHeaders, body: bytes("world") }),
            { uploadToken: token },
        );
    }

    test("interop 3 treats an ABSENT completeness header as incomplete, never a 400", async () => {
        // draft-01 predates the requirement: absent means "not complete".
        const res = await appendNoCompleteness(3);
        expect(res.status).toBe(201);
        // Incomplete: the response asserts the not-complete polarity, not a publish.
        expect(res.headers.get("Upload-Incomplete")).toBe("?1");
    });

    test("interop 5 REQUIRES the completeness header on append: absent is a 400", async () => {
        const res = await appendNoCompleteness(5);
        expect(res.status).toBe(400);
    });

    test("interop 3 rejects a malformed completeness value, never coercing it", async () => {
        // Present-but-unparseable is a client error at every version.
        const res = await appendNoCompleteness(3, { "Upload-Incomplete": "true" });
        expect(res.status).toBe(400);
    });
});

// ─── Handler plumbing precision (audit R534) ────────────────────────────────

describe("handler plumbing edges", () => {
    test("interopVersions are sorted so the newest echoed version is the true maximum", async () => {
        // Passed out of order: the echo on an unsupported version must be the
        // sorted maximum (6), not the last one supplied.
        const { handler } = harness({ interopVersions: [6, 3] });
        const res = await handler(createRequest(6, {
            completeness: "?0",
            omitVersion: true,
            headers: { [VERSION_HEADER]: "9" },
        }));
        expect(res.status).toBe(400);
        expect(res.headers.get(VERSION_HEADER)).toBe("6");
    });

    test("the construction error names the wire-mapped versions it knows", () => {
        const store = memoryUploadStore({ objects: {} });
        expect(() => createUploadHandler(store, {
            key: () => "k",
            location: (t) => `/u/${t}`,
            interopVersions: [9],
        })).toThrow(/3, 5, 6/);
    });

    test("an oversized single append answers 413 (append-too-large), distinct from a 400 floor", async () => {
        const { handler } = harness({ policy: { maxAppendSize: 2 } });
        // A bare incomplete upload (no creation body, so the append bound is not
        // tripped at creation); the oversized append is what must 413.
        const created = await handler(createRequest(6, {
            completeness: "?0",
            headers: { "Upload-Length": "10" },
        }));
        const token = created.headers.get("Location")!.slice("/uploads/".length);
        const res = await handler(
            patchRequest(6, {
                offset: "0",
                completeness: "?0",
                body: bytes("world"),
                headers: { "Content-Length": "5" },
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(413);
    });

    test("a probe carrying only Upload-Length is rejected 400", async () => {
        // Upload-Length alone must count as an upload-state header on a probe.
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 6);
        const res = await handler(
            resourceRequest(6, "HEAD", { "Upload-Length": "10" }),
            { uploadToken: token },
        );
        expect(res.status).toBe(400);
    });

    test("a creation with no representation metadata records none (not an empty object)", async () => {
        const { handler, store } = harness();
        // A completing creation with neither Content-Type nor Content-Disposition.
        const res = await handler(new Request("http://test/upload", {
            method: "POST",
            headers: { [VERSION_HEADER]: "6", "Upload-Complete": "?0" },
        }));
        expect(res.status).toBe(201);
        const token = res.headers.get("Location")!.slice("/uploads/".length);
        const state = await store.getUploadState(token);
        expect(state.metadata).toBeUndefined();
    });

    test("the key callback receives the request, version, declared length, and completeness", async () => {
        const seen: Array<{ interopVersion: number; declaredLength?: number; complete: boolean }> = [];
        const { handler } = harness({
            key: (creation) => {
                seen.push({
                    interopVersion: creation.interopVersion,
                    declaredLength: creation.declaredLength,
                    complete: creation.complete,
                });
                return "k";
            },
        });
        await handler(createRequest(6, {
            completeness: "?1",
            body: bytes("hi"),
            headers: { "Upload-Length": "2" },
        }));
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({ interopVersion: 6, declaredLength: 2, complete: true });
    });

    test("onResumptionSupported is NOT invoked when the option is absent", async () => {
        // Guard the presence check: an absent hook must not be called (which
        // would surface as a resumption-hook error to onError).
        const operations: string[] = [];
        const { handler } = harness({ onError: (_e, ctx) => operations.push(ctx.operation) });
        const res = await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(201);
        expect(operations).not.toContain("resumption-hook");
    });

    test("a throwing resumption hook with NO onError still completes the creation", async () => {
        const { handler } = harness({
            onResumptionSupported: () => { throw new Error("hook boom"); },
        });
        const res = await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(201);
    });

    test("a throwing key callback with NO onError answers a hardened 500, never an escaped throw", async () => {
        const { handler } = harness({ key: () => { throw new Error("key boom"); } });
        const res = await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(500);
        expectErrorHardening(res);
    });

    test("interop 6 HEAD on a deferred-length upload omits Upload-Length", async () => {
        // probeAnnouncesLength is on, but an unknown length must not surface as
        // "Upload-Length: undefined".
        const { handler } = harness();
        const created = await handler(createRequest(6, { completeness: "?0", body: bytes("hi") }));
        const token = created.headers.get("Location")!.slice("/uploads/".length);
        const res = await handler(resourceRequest(6, "HEAD"), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("Upload-Length")).toBeNull();
    });

    test("interop 6 append with NO Content-Type is rejected 400, not a 500", async () => {
        // The media-type gate must treat an absent Content-Type as a clean 400.
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 6);
        const res = await handler(
            new Request("http://test/uploads/x", {
                method: "PATCH",
                headers: {
                    [VERSION_HEADER]: "6",
                    "Upload-Offset": "5",
                    "Upload-Complete": "?0",
                },
                body: bytes("x"),
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("application/partial-upload");
    });

    test("a probe with an already-aborted request signal surfaces the store abort as 500", async () => {
        // The request signal must reach the store read: an aborted probe fails
        // rather than answering from an unsignalled read.
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 6);
        const res = await handler(
            new Request("http://test/uploads/x", {
                method: "HEAD",
                headers: { [VERSION_HEADER]: "6" },
                signal: AbortSignal.abort(),
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(500);
    });

    test("a cancel with an already-aborted request signal surfaces the store abort as 500", async () => {
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 6);
        const res = await handler(
            new Request("http://test/uploads/x", {
                method: "DELETE",
                headers: { [VERSION_HEADER]: "6" },
                signal: AbortSignal.abort(),
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(500);
    });
});
