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
            const locker: UploadLocker = {
                async acquire(uploadToken) {
                    throw new UploadLockTimeoutError(uploadToken);
                },
            };
            const { handler } = harness({ locker });
            // Creation takes no resource lock; appends and probes do.
            const created = await handler(createRequest(version, {
                completeness: w.incomplete,
                body: bytes("hello"),
            }));
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

    test("append without a completeness header is a completing request", async () => {
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
                },
                body: bytes("world"),
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(201);
        expect(res.headers.get("Upload-Complete")).toBe("?1");
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
