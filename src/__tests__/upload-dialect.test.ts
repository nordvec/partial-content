import { describe, test, expect } from "bun:test";
import { createUploadHandler, UPLOAD_EXPOSED_HEADERS, type UploadHandlerOptions } from "../upload.ts";
import { memoryUploadStore, type MemoryObject } from "../memory.ts";
import { UploadLockTimeoutError, type UploadLocker } from "../upload-locker.ts";
import { UploadDestinationConflictError, type ResumableWriteStore } from "../upload-store.ts";
import type { UploadPolicy } from "../upload-engine.ts";

/** Handler options a test overrides; its policy may omit the required maxSize. */
type UploadOverrides = Omit<Partial<UploadHandlerOptions>, "policy"> & { policy?: UploadPolicy };

const NOW = 1_800_000_000_000;
const VERSION_HEADER = "Upload-Draft-Interop-Version";

/**
 * Independent statement of each version's wire facts (hardcoded, never
 * derived through the implementation's own mapping): interop 3 signals
 * completeness through Upload-Incomplete with inverted polarity, 5 and 6
 * through Upload-Complete, and 6 onward require the partial-upload media
 * type and speak problem+json on 409.
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
    9: {
        header: "Upload-Complete",
        other: "Upload-Incomplete",
        complete: "?1",
        incomplete: "?0",
        patchType: "application/partial-upload" as string | undefined,
        problem409: true,
        headLength: true,
    },
    10: {
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
const VERSIONS: Version[] = [3, 5, 6, 9, 10];

function bytes(text: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(text);
}

async function sha256Base64(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes(text));
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function harness(over: UploadOverrides = {}, store?: ResumableWriteStore) {
    const objects: Record<string, MemoryObject> = {};
    const writeStore = store ?? memoryUploadStore({ objects });
    let clock = NOW;
    const handler = createUploadHandler(writeStore, {
        key: () => "doc.bin",
        location: (t) => `/uploads/${t}`,
        now: () => clock,
        graceMs: 0,
        ...over,
        policy: { maxSize: Infinity, ...over.policy },
    });
    return {
        handler,
        store: writeStore,
        objects,
        tick: (ms: number) => {
            clock += ms;
        },
    };
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
    const res = await handler(
        createRequest(version, {
            completeness: WIRE[version].incomplete,
            body: bytes("hello"),
            headers: { "Upload-Length": "10", "Content-Length": "5" },
        }),
    );
    expect(res.status).toBe(201);
    const location = res.headers.get("Location")!;
    return { token: location.slice("/uploads/".length), location };
}

/** A creation POST whose 5-byte body also completes the upload. */
function completingCreate(version: Version): Request {
    return createRequest(version, {
        completeness: WIRE[version].complete,
        body: bytes("hello"),
        headers: { "Content-Length": "5" },
    });
}

/** A PATCH at offset whose body, sent with its Content-Length, completes the upload. */
function completingPatch(version: Version, offset: number, text: string): Request {
    return patchRequest(version, {
        offset: String(offset),
        completeness: WIRE[version].complete,
        body: bytes(text),
        headers: { "Content-Length": String(text.length) },
    });
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
            const res = await handler(
                createRequest(version, {
                    completeness: w.incomplete,
                    body: bytes("hello"),
                    headers: { "Upload-Length": "10", "Content-Length": "5" },
                }),
            );
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
            const res = await handler(completingCreate(version));
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
            // 204: the append stored bytes into a resource that already
            // existed. 201 would claim this request created what the URI names
            // (RFC 9110 Section 15.3.2), and it carries no Location either.
            expect(res.status).toBe(204);
            expect(res.headers.get(VERSION_HEADER)).toBe(String(version));
            expect(res.headers.get("Upload-Offset")).toBe("8");
            expect(res.headers.get(w.header)).toBe(w.incomplete);
            expect(res.headers.get(w.other)).toBeNull();
        });

        test("completing append reaches the declared length and flips completeness", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(completingPatch(version, 5, "world"), { uploadToken: token });
            // 200 on the append that completes the upload, 204 on one that
            // does not; neither creates the resource.
            expect(res.status).toBe(200);
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
                const body = (await res.json()) as Record<string, unknown>;
                expect(body.type).toBe("https://iana.org/assignments/http-problem-types#mismatching-upload-offset");
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
            await handler(completingPatch(version, 5, "world"), { uploadToken: token });
            const res = await handler(resourceRequest(version, "HEAD"), { uploadToken: token });
            expect(res.status).toBe(204);
            expect(res.headers.get(w.header)).toBe(w.complete);
            expect(res.headers.get("Upload-Offset")).toBe("10");
        });

        test("HEAD carrying upload-state headers is refused where the version says so", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(resourceRequest(version, "HEAD", { "Upload-Offset": "5" }), {
                uploadToken: token,
            });
            // The restriction is a row in the wire table, not a rule the
            // handler applies to every version: interop 3, 5 and 6 impose it
            // and interop 9 and 10 do not, so admitting a later version cannot
            // inherit a refusal that version never asked for.
            if (version >= 9) {
                expect(res.status).toBe(204);
                expect(res.headers.get("Upload-Offset")).toBe("5");
            } else {
                expect(res.status).toBe(400);
                expectErrorHardening(res);
            }
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

        test("DELETE carrying a completeness header is refused where the version says so", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(resourceRequest(version, "DELETE", { [w.header]: w.incomplete }), {
                uploadToken: token,
            });
            expect(res.status).toBe(version >= 9 ? 204 : 400);
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
            const res = await handler(
                createRequest(version, {
                    body: bytes("hi"),
                    headers: { [w.other]: "?1" },
                }),
            );
            expect(res.status).toBe(400);
        });

        test("creation tolerates Upload-Offset: 0 and rejects a non-zero offset", async () => {
            const { handler } = harness();
            const ok = await handler(
                createRequest(version, {
                    completeness: w.incomplete,
                    body: bytes("hi"),
                    headers: { "Upload-Offset": "0" },
                }),
            );
            expect(ok.status).toBe(201);
            const bad = await handler(
                createRequest(version, {
                    completeness: w.incomplete,
                    body: bytes("hi"),
                    headers: { "Upload-Offset": "3" },
                }),
            );
            expect(bad.status).toBe(400);
        });

        test("size-exceeded answers 413, floor violations answer 400", async () => {
            const { handler } = harness({ policy: { maxSize: 4, minSize: 2 } });
            const tooBig = await handler(
                createRequest(version, {
                    completeness: w.incomplete,
                    headers: { "Upload-Length": "10" },
                }),
            );
            expect(tooBig.status).toBe(413);
            expect(tooBig.headers.get(VERSION_HEADER)).toBe(String(version));
            expectErrorHardening(tooBig);
            const tooSmall = await handler(
                createRequest(version, {
                    completeness: w.incomplete,
                    headers: { "Upload-Length": "1" },
                }),
            );
            expect(tooSmall.status).toBe(400);
        });

        test("a completion whose DURABLE size is under the floor never publishes", async () => {
            // Distinct from the declared-length check above: nothing is
            // declared here, so the floor can only be judged from the bytes
            // that actually landed, at the moment of completion. Publishing an
            // undersized object is the failure this refuses.
            const objects: Record<string, { body: Uint8Array }> = {};
            const { handler } = harness({ policy: { minSize: 5 } }, memoryUploadStore({ objects }));
            const create = await handler(
                createRequest(version, {
                    completeness: w.incomplete,
                    body: bytes("ab"),
                    headers: { "Content-Length": "2" },
                }),
            );
            expect(create.status).toBe(201);
            const token = create.headers.get("Location")!.slice("/uploads/".length);

            const done = await handler(completingPatch(version, 2, "c"), { uploadToken: token });

            expect(done.status).toBe(400);
            expectErrorHardening(done);
            // Nothing reached the published namespace.
            expect(Object.keys(objects)).toHaveLength(0);
        });

        test("contended resource answers 423, distinct from the 409 re-anchor", async () => {
            // The setup creation legitimately holds the lock (it streams a
            // body); arm the timeout only afterward so the CONTENTION path
            // (a later append/probe that cannot acquire) is what returns 423.
            let armed = false;
            const locker: UploadLocker = {
                async acquire(uploadToken) {
                    if (armed) throw new UploadLockTimeoutError(uploadToken);
                    return {
                        release() {
                            /* no-op setup lock */
                        },
                        signal: new AbortController().signal,
                        lease: new AbortController().signal,
                    };
                },
            };
            const { handler } = harness({ locker });
            const created = await handler(
                createRequest(version, {
                    completeness: w.incomplete,
                    body: bytes("hello"),
                }),
            );
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

        test("a completing retry on a completed upload answers per the version", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            await handler(completingPatch(version, 5, "world"), { uploadToken: token });
            const replay = await handler(patchRequest(version, { offset: "10", completeness: w.complete }), {
                uploadToken: token,
            });
            if (version >= 9) {
                // Interop 9 and 10 permit replaying the completion answer, which is
                // the case a client hits when the original response was lost.
                expect(replay.status).toBe(200);
                expect(replay.headers.get("Upload-Offset")).toBe("10");
                expect(replay.headers.get(w.header)).toBe(w.complete);
            } else {
                // Interop 3, 5 and 6 require the refusal, and a client written
                // against them uses it to learn the upload finished. Answering
                // 200 there would be this package inventing a wire behaviour
                // under a version number that means something else.
                expect(replay.status).toBe(400);
            }
        });

        test("an append carrying content to a completed upload is refused as inconsistent", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            await handler(completingPatch(version, 5, "world"), { uploadToken: token });
            const res = await handler(completingPatch(version, 10, "more"), { uploadToken: token });
            // The total is fixed at completion and the offset may never exceed
            // it, so the content has nowhere to land. A completion answer here
            // would report success for bytes no store received. Every version
            // names the LENGTH fault, which is what separates this answer from
            // the plain "already complete" refusal on 3, 5 and 6.
            expect(res.status).toBe(400);
            if (version >= 9) {
                expect(res.headers.get("Content-Type")).toBe("application/problem+json");
                expect(await res.json()).toMatchObject({
                    type: "https://iana.org/assignments/http-problem-types#inconsistent-upload-length",
                });
            } else {
                expect(await res.text()).toContain("inconsistent");
            }
            // Nothing durable moved: the resource still reads as the completed
            // ten bytes, so a client that re-probes learns the real state.
            const probe = await handler(resourceRequest(version, "HEAD"), { uploadToken: token });
            expect(probe.status).toBe(204);
            expect(probe.headers.get("Upload-Offset")).toBe("10");
            expect(probe.headers.get(w.header)).toBe(w.complete);
        });

        test("an undeclared size carrying content at the completed end is refused at every version", async () => {
            const { handler, objects } = harness();
            const { token } = await createIncomplete(handler, version);
            await handler(completingPatch(version, 5, "world"), { uploadToken: token });
            // No Content-Length, so only the body says whether this request
            // carries content: it is read as far as its first byte, which has
            // nowhere to go once the length is fixed. A body with no byte is
            // the replayable retry instead (upload-completed-chunked-append).
            const res = await handler(
                patchRequest(version, {
                    offset: "10",
                    completeness: w.complete,
                    body: bytes("more"),
                }),
                { uploadToken: token },
            );
            expect(res.status).toBe(400);
            // The published object is untouched: the request's bytes reached
            // no store on any version.
            expect(objects["doc.bin"]?.body).toEqual(bytes("helloworld"));
        });

        test("expired resource answers 404", async () => {
            const { handler, tick } = harness({ policy: { maxAgeSeconds: 60 } });
            const { token } = await createIncomplete(handler, version);
            tick(61_000);
            const res = await handler(resourceRequest(version, "HEAD"), { uploadToken: token });
            expect(res.status).toBe(404);
        });

        test("GET on the upload resource probes or is refused, per the version", async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(resourceRequest(version, "GET"), { uploadToken: token });
            if (version >= 9) {
                // Interop 9 and 10 admit GET as an offset probe, noting HEAD is
                // preferred because resumption needs no response content.
                expect(res.status).toBe(204);
                expect(res.headers.get("Upload-Offset")).toBe("5");
            } else {
                expect(res.status).toBe(405);
                expect(res.headers.get("Allow")).not.toContain("GET");
                expect(res.headers.get("Allow")).toContain("HEAD");
                expect(res.headers.get("Allow")).toContain("PATCH");
                expect(res.headers.get("Allow")).toContain("DELETE");
            }
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

    test("interop 6 reads the media type by its grammar: parameters pass, a list does not", async () => {
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 6);
        const append = (contentType: string) =>
            handler(
                new Request("http://test/uploads/x", {
                    method: "PATCH",
                    headers: {
                        [VERSION_HEADER]: "6",
                        "Upload-Offset": "5",
                        "Upload-Complete": "?0",
                        "Content-Type": contentType,
                    },
                    body: bytes("x"),
                }),
                { uploadToken: token },
            );
        expect((await append("application/partial-upload, text/html")).status).toBe(400);
        expect((await append("Application/Partial-Upload; charset=binary")).status).not.toBe(400);
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
            expect(res.status).toBe(204);
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
        expect(res.status).toBe(204);
    });
});

describe("version gate", () => {
    test("unlisted version answers 400 naming the supported set and echoing the newest", async () => {
        const { handler } = harness();
        for (const bad of ["11", "4", "0", "-3", "abc", "6.0"]) {
            const res = await handler(
                createRequest(6, {
                    completeness: "?0",
                    omitVersion: true,
                    headers: { [VERSION_HEADER]: bad },
                }),
            );
            expect(res.status).toBe(400);
            // The newest version this endpoint serves, so a client that can
            // upgrade learns what to ask for next.
            expect(res.headers.get(VERSION_HEADER)).toBe("10");
            expect(await res.text()).toContain("3, 5, 6, 9, 10");
            expectErrorHardening(res);
        }
    });

    test("missing version header answers 400 for creation and resource requests", async () => {
        const { handler } = harness();
        const creation = await handler(createRequest(6, { completeness: "?0", omitVersion: true }));
        expect(creation.status).toBe(400);
        const probe = await handler(new Request("http://test/uploads/x", { method: "HEAD" }), { uploadToken: "t" });
        expect(probe.status).toBe(400);
        expect(await probe.text()).toContain("3, 5, 6, 9, 10");
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
        expect(() =>
            createUploadHandler(store, {
                policy: { maxSize: Infinity },
                key: () => "k",
                location: (t) => `/u/${t}`,
                interopVersions: [11],
            }),
        ).toThrow(TypeError);
        expect(() =>
            createUploadHandler(store, {
                policy: { maxSize: Infinity },
                key: () => "k",
                location: (t) => `/u/${t}`,
                interopVersions: [],
            }),
        ).toThrow(TypeError);
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
        const created = await handler(
            createRequest(6, {
                completeness: "?0",
                body: bytes("hello"),
                headers: { "Upload-Length": "10" },
            }),
        );
        const location = created.headers.get("Location")!;
        const res = await handler(
            new Request(`http://test${location}`, {
                method: "HEAD",
                headers: { [VERSION_HEADER]: "6" },
            }),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("Upload-Offset")).toBe("5");
    });

    test("onResumptionSupported fires with token, location, and version", async () => {
        const seen: Array<{ uploadToken: string; location: string; interopVersion: number }> = [];
        const { handler } = harness({
            onResumptionSupported: (info) => {
                seen.push(info);
            },
        });
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
            onResumptionSupported: () => {
                throw new Error("hook boom");
            },
            onError: (_err, ctx) => {
                errors.push(ctx);
            },
        });
        const res = await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(201);
        expect(errors.some((e) => e.operation === "resumption-hook")).toBe(true);
    });

    test("a throwing resumption hook is projected when an auditKey is in force", async () => {
        // The hook is handed the token and the location built from it, so what it
        // throws routinely quotes one. This seam reaches the same sink as every
        // other failure and owes the same substitution.
        const reports: Array<{ err: unknown; ctx: { uploadToken?: string; auditKey?: string; operation: string } }> =
            [];
        const { handler } = harness({
            auditKey: () => "doc-7",
            onResumptionSupported: (info) => {
                throw new Error(`hook rejected ${info.location}`);
            },
            onError: (err, ctx) => {
                reports.push({ err, ctx });
            },
        });
        const res = await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(201);
        const token = res.headers.get("Location")!.split("/").pop()!;
        const report = reports.find((r) => r.ctx.operation === "resumption-hook");
        expect(report).toBeDefined();
        expect(report!.err).toEqual({ name: "Error", operation: "resumption-hook" });
        expect(JSON.stringify(report)).not.toContain(token);
        expect(report!.ctx.uploadToken).toBeUndefined();
        expect(report!.ctx.auditKey).toBe("doc-7");
    });

    test("creation records representation metadata for the store", async () => {
        const { handler, store } = harness();
        const res = await handler(
            createRequest(6, {
                completeness: "?0",
                body: bytes("x"),
                headers: {
                    "Content-Type": "text/markdown",
                    "Content-Disposition": 'attachment; filename="notes.md"',
                },
            }),
        );
        const token = res.headers.get("Location")!.slice("/uploads/".length);
        const state = await store.getUploadState(token);
        expect(state.metadata).toMatchObject({
            contentType: "text/markdown",
            contentDisposition: 'attachment; filename="notes.md"',
        });
    });

    test("an off-grammar creation Content-Type is stored as an octet-stream", async () => {
        const { handler, store } = harness();
        const res = await handler(
            createRequest(6, {
                completeness: "?0",
                body: bytes("x"),
                headers: { "Content-Type": "image/png, text/html" },
            }),
        );
        const token = res.headers.get("Location")!.slice("/uploads/".length);
        const state = await store.getUploadState(token);
        expect(state.metadata).toMatchObject({ contentType: "application/octet-stream" });
    });

    test("audit events carry the auditKey instead of the storage key", async () => {
        const events: Array<{ auditKey?: string }> = [];
        const { handler } = harness({
            auditKey: () => "audit-42",
            onUploadEvent: (e) => {
                events.push(e);
            },
        });
        await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.auditKey === "audit-42")).toBe(true);
    });

    test("a store failure surfaces as a hardened 500, reported to onError", async () => {
        const store = memoryUploadStore({ objects: {} });
        const broken: ResumableWriteStore = {
            ...store,
            async getUploadState() {
                throw new Error("disk on fire");
            },
        };
        const errors: unknown[] = [];
        const { handler } = harness(
            {
                onError: (err) => {
                    errors.push(err);
                },
            },
            broken,
        );
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
            key: () => {
                throw new Error("key derivation boom");
            },
            onError: (_err, ctx) => {
                errors.push(ctx);
            },
        });
        const res = await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(500);
        expectErrorHardening(res);
        expect(errors.some((e) => e.operation === "handler")).toBe(true);
    });

    // The token is the capability, and onError is a log surface. `auditKey`
    // promises the capability never reaches it, which has to hold for the ERROR
    // as well as for the context: adapters and the filesystem store both put
    // the token into error text.
    const CAPABILITY = "tok-abc-123";

    function storeThrowingWithToken(): ResumableWriteStore {
        const store = memoryUploadStore({ objects: {} });
        return {
            ...store,
            async getUploadState() {
                throw new Error(`disk on fire for ${CAPABILITY}`);
            },
        };
    }

    test("a store error carrying the token reports the auditKey in its place", async () => {
        const seen: Array<{ err: unknown; ctx: { uploadToken?: string; auditKey?: string } }> = [];
        const { handler } = harness(
            {
                auditKey: () => "audit-42",
                onError: (err, ctx) => {
                    seen.push({ err, ctx });
                },
            },
            storeThrowingWithToken(),
        );

        const res = await handler(resourceRequest(6, "HEAD"), { uploadToken: CAPABILITY });

        expect(res.status).toBe(500);
        expect(seen).toHaveLength(1);
        // Gone from BOTH halves of the report, not just the context.
        expect(seen[0]!.ctx.uploadToken).toBeUndefined();
        expect(seen[0]!.ctx.auditKey).toBe("audit-42");
        expect(seen[0]!.err).toMatchObject({ operation: "head" });
        expect(JSON.stringify(seen[0])).not.toContain(CAPABILITY);
    });

    test("without an auditKey the error reaches onError unchanged", async () => {
        // Substitution is opted into. Absent one, rewriting the error would
        // strip the only identifier the report carries.
        const seen: Array<{ err: unknown; ctx: { uploadToken?: string } }> = [];
        const { handler } = harness(
            {
                onError: (err, ctx) => {
                    seen.push({ err, ctx });
                },
            },
            storeThrowingWithToken(),
        );

        const res = await handler(resourceRequest(6, "HEAD"), { uploadToken: CAPABILITY });

        expect(res.status).toBe(500);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.ctx.uploadToken).toBe(CAPABILITY);
        expect((seen[0]!.err as Error).message).toContain(CAPABILITY);
    });

    test("an auditKey callback that throws cannot break the never-throw contract", async () => {
        // This seam exists BECAUSE caller callbacks throw, so deriving the
        // audit key inside it has to be guarded too; an unguarded re-derivation
        // would throw straight out of the handler.
        const seen: Array<{ operation: string; uploadToken?: string; auditKey?: string }> = [];
        const { handler } = harness({
            auditKey: () => {
                throw new Error("audit boom");
            },
            onError: (_err, ctx) => {
                seen.push(ctx);
            },
        });

        const res = await handler(resourceRequest(6, "HEAD"), { uploadToken: CAPABILITY });

        expect(res.status).toBe(500);
        expectErrorHardening(res);
        const handled = seen.filter((c) => c.operation === "handler");
        expect(handled).toHaveLength(1);
        // No usable audit key, and a configured auditKey promised the token
        // never reaches the sink: the failure is reported unattributed rather
        // than with the capability beside it.
        expect(handled[0]!.auditKey).toBeUndefined();
        expect(handled[0]!.uploadToken).toBeUndefined();
    });

    /**
     * Reach the last-resort catch against a REAL upload: create one with a
     * working clock, then break the clock so the probe throws inside dispatch.
     * A token that names nothing answers 404 long before anything can throw.
     */
    async function catchAllReport(over: UploadOverrides) {
        const seen: Array<{ err: unknown; ctx: { operation: string; uploadToken?: string; auditKey?: string } }> = [];
        // The thrown error CARRIES the token, so the reported error shows
        // whether the capability was scrubbed from it and not only from the
        // context beside it.
        let boom = "";
        const { handler } = harness({
            now: () => {
                if (boom !== "") throw new Error(`clock boom for ${boom}`);
                return NOW;
            },
            onError: (err, ctx) => {
                seen.push({ err, ctx });
            },
            ...over,
        });
        const { token } = await createIncomplete(handler, 6);
        boom = token;
        const res = await handler(resourceRequest(6, "HEAD"), { uploadToken: token });
        const handled = seen.filter((s) => s.ctx.operation === "handler");
        return { res, token, handled: handled.map((s) => s.ctx), errors: handled.map((s) => s.err) };
    }

    test("the last-resort catch reports the auditKey in the token's place", async () => {
        const { res, token, handled, errors } = await catchAllReport({ auditKey: () => "audit-42" });

        expect(res.status).toBe(500);
        expectErrorHardening(res);
        expect(handled).toHaveLength(1);
        expect(handled[0]!.auditKey).toBe("audit-42");
        expect(handled[0]!.uploadToken).toBeUndefined();
        // Projected, so the message that quotes the token stays behind too.
        expect(errors[0]).toMatchObject({ operation: "handler" });
        expect(JSON.stringify(errors[0])).not.toContain(token);
    });

    test("a configured auditKey that throws at the last-resort catch still projects the error", async () => {
        const { res, token, handled, errors } = await catchAllReport({
            auditKey: ({ request }) => {
                if (request.method === "HEAD") throw new Error("audit derivation failed");
                return "audit-42";
            },
        });

        expect(res.status).toBe(500);
        expect(handled).toHaveLength(1);
        expect(handled[0]!.uploadToken).toBeUndefined();
        expect(errors[0]).toMatchObject({ operation: "handler" });
        expect(JSON.stringify(errors[0])).not.toContain(token);
    });
    test("with no auditKey at all the last-resort catch reports the token", async () => {
        const { res, token, handled, errors } = await catchAllReport({});

        expect(res.status).toBe(500);
        expect(handled).toHaveLength(1);
        expect(handled[0]!.uploadToken).toBe(token);
        expect(handled[0]!.auditKey).toBeUndefined();
        // Nothing to substitute, so the error is passed through as thrown.
        expect((errors[0] as Error).message).toContain(token);
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
        const res = await handler(
            createRequest(6, {
                completeness: "?1",
                body: bytes("hello"),
                headers: { "Repr-Digest": `sha-256=:${digest}:` },
            }),
        );
        expect(res.status).toBe(201);
        expect(res.headers.get("Upload-Complete")).toBe("?1");
    });

    test("a mismatching Repr-Digest sha-256 is rejected 400 and nothing publishes", async () => {
        const wrong = await sha256Base64("goodbye");
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { handler } = harness({}, store);
        const res = await handler(
            createRequest(6, {
                completeness: "?1",
                body: bytes("hello"),
                headers: { "Repr-Digest": `sha-256=:${wrong}:` },
            }),
        );
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("digest");
        expect(Object.keys(objects)).toHaveLength(0);
    });

    test("unsupported digest algorithms are ignored per RFC 9530", async () => {
        const { handler } = harness();
        const res = await handler(
            createRequest(6, {
                completeness: "?1",
                body: bytes("hello"),
                headers: { "Repr-Digest": "sha-512=:AAAA:" },
            }),
        );
        expect(res.status).toBe(201);
    });
});

// ─── Repr-Digest parsing precision ──────────────────────────────────────────
// The parser is exercised through completing creations: a WELL-FORMED sha-256
// that does not match the body's real digest is rejected 400 (parsed + used);
// any input the parser cannot read is IGNORED, so the upload completes 201.

describe("Repr-Digest parsing", () => {
    /** Complete a creation of "hello" carrying the given Repr-Digest header. */
    async function withReprDigest(reprDigest: string): Promise<Response> {
        const { handler } = harness();
        return handler(
            new Request("http://test/upload", {
                method: "POST",
                headers: { [VERSION_HEADER]: "6", "Upload-Complete": "?1", "Repr-Digest": reprDigest },
                body: bytes("hello"),
            }),
        );
    }

    // A well-formed 44-char base64 that is NOT the digest of "hello".
    let WRONG: string;
    // Not floating: the promise is held in `wrongReady` and awaited by each
    // test that needs it. (The directive that used to sit here named a
    // type-aware rule this config does not enable, so it suppressed nothing.)
    const wrongReady = sha256Base64("a-different-payload-entirely").then((d) => {
        WRONG = d;
    });

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

// ─── Content-Length parsing precision ───────────────────────────────────────

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

// ─── Completeness fail-closed at every version ──────────────────────────────

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
        expect(res.status).toBe(204);
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

// ─── Handler plumbing precision ─────────────────────────────────────────────

describe("handler plumbing edges", () => {
    test("interopVersions are sorted so the newest echoed version is the true maximum", async () => {
        // Passed out of order: the echo on an unsupported version must be the
        // sorted maximum (6), not the last one supplied.
        const { handler } = harness({ interopVersions: [6, 3] });
        const res = await handler(
            createRequest(6, {
                completeness: "?0",
                omitVersion: true,
                headers: { [VERSION_HEADER]: "11" },
            }),
        );
        expect(res.status).toBe(400);
        expect(res.headers.get(VERSION_HEADER)).toBe("6");
    });

    test("the construction error names the wire-mapped versions it knows", () => {
        const store = memoryUploadStore({ objects: {} });
        expect(() =>
            createUploadHandler(store, {
                policy: { maxSize: Infinity },
                key: () => "k",
                location: (t) => `/u/${t}`,
                interopVersions: [11],
            }),
        ).toThrow(/3, 5, 6, 9, 10/);
    });

    test("an oversized single append answers 413 (append-too-large), distinct from a 400 floor", async () => {
        const { handler } = harness({ policy: { maxAppendSize: 2 } });
        // A bare incomplete upload (no creation body, so the append bound is not
        // tripped at creation); the oversized append is what must 413.
        const created = await handler(
            createRequest(6, {
                completeness: "?0",
                headers: { "Upload-Length": "10" },
            }),
        );
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
        const res = await handler(resourceRequest(6, "HEAD", { "Upload-Length": "10" }), { uploadToken: token });
        expect(res.status).toBe(400);
    });

    test("a creation with no representation metadata records none (not an empty object)", async () => {
        const { handler, store } = harness();
        // A completing creation with neither Content-Type nor Content-Disposition.
        const res = await handler(
            new Request("http://test/upload", {
                method: "POST",
                headers: { [VERSION_HEADER]: "6", "Upload-Complete": "?0" },
            }),
        );
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
        await handler(
            createRequest(6, {
                completeness: "?1",
                body: bytes("hi"),
                headers: { "Upload-Length": "2" },
            }),
        );
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
            onResumptionSupported: () => {
                throw new Error("hook boom");
            },
        });
        const res = await handler(createRequest(6, { completeness: "?0", body: bytes("x") }));
        expect(res.status).toBe(201);
    });

    test("a throwing key callback with NO onError answers a hardened 500, never an escaped throw", async () => {
        const { handler } = harness({
            key: () => {
                throw new Error("key boom");
            },
        });
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

// ─── A rejected creation that already allocated bytes names them ────────────

describe("creation refused after the resource exists", () => {
    test("a body over the per-request ceiling answers 413 WITH a Location", async () => {
        // maxAppendSize bounds this request only, so the prefix that landed is
        // durable and the resource is healthy: the client resumes it.
        const { handler } = harness({ policy: { maxAppendSize: 4 } });
        const res = await handler(
            createRequest(6, {
                completeness: "?0",
                body: bytes("0123456789"),
            }),
        );

        expect(res.status).toBe(413);
        const location = res.headers.get("Location");
        // Without it the four durable bytes are unreachable: not resumable, not
        // deletable, reclaimed only by a sweep that may never run.
        expect(location).toMatch(/^\/uploads\/./);

        const token = location!.slice("/uploads/".length);
        const head = await handler(resourceRequest(6, "HEAD"), { uploadToken: token });
        expect(head.status).toBe(204);
        expect(head.headers.get("Upload-Offset")).toBe("4");
    });

    test("a creation whose content exceeds the length it declares is refused outright", async () => {
        const { handler } = harness();
        const res = await handler(
            new Request("http://test/upload", {
                method: "POST",
                headers: {
                    [VERSION_HEADER]: "6",
                    [WIRE[6].header]: "?0",
                    "Upload-Length": "4",
                    "Content-Length": "10",
                },
                body: bytes("0123456789"),
            }),
        );

        // Refused before allocation, so there is nothing to point at: reaching
        // the store would truncate at the bound and destroy an upload the
        // client was about to be told it had created.
        expect(res.status).toBe(400);
        expect(res.headers.get("Location")).toBeNull();
    });
});

// ─── Upload-Limit carries exactly the bounds that are set ───────────────────

describe("Upload-Limit serialization", () => {
    const limitFor = async (policy: Record<string, number>) => {
        const { handler } = harness({ policy });
        const created = await handler(createRequest(9, { completeness: "?0" }));
        const token = created.headers.get("Location")!.slice("/uploads/".length);
        const probe = await handler(resourceRequest(9, "HEAD"), { uploadToken: token });
        return probe.headers.get("Upload-Limit");
    };

    test("every configured bound appears, and nothing else does", async () => {
        expect(
            await limitFor({
                maxSize: 1024,
                minSize: 2,
                maxAppendSize: 64,
                minAppendSize: 1,
                maxAgeSeconds: 3600,
            }),
        ).toBe("max-size=1024, min-size=2, max-append-size=64, min-append-size=1, max-age=3600");
    });

    test("a bound that is not set is absent rather than guessed", async () => {
        expect(await limitFor({ maxSize: 1024 })).toBe("max-size=1024, min-size=0");
        expect(await limitFor({ maxAppendSize: 64 })).toBe("min-size=0, max-append-size=64");
        expect(await limitFor({ minAppendSize: 1 })).toBe("min-size=0, min-append-size=1");
        expect(await limitFor({ maxAgeSeconds: 60 })).toBe("min-size=0, max-age=60");
    });

    test("a server applying no limits still says so", async () => {
        // An empty value is not a valid structured-field dictionary, and
        // silence about limits is what makes a client guess a chunk size.
        expect(await limitFor({})).toBe("min-size=0");
    });

    test("a configured minimum is reported rather than the zero default", async () => {
        expect(await limitFor({ minSize: 7 })).toBe("min-size=7");
    });

    test("a rejection caused by a limit carries the limits", async () => {
        // The client's retry then aims at a number instead of guessing.
        const { handler } = harness({ policy: { maxSize: 4, maxAppendSize: 2 } });
        const res = await handler(
            createRequest(9, {
                completeness: "?0",
                headers: { "Upload-Length": "99" },
            }),
        );
        expect(res.status).toBe(413);
        expect(res.headers.get("Upload-Limit")).toBe("max-size=4, min-size=0, max-append-size=2");
    });

    test("a creation refused before allocating states the configured lifetime", async () => {
        // No resource exists, so the lifetime describes the one a retry makes.
        const { handler } = harness({ policy: { maxSize: 4, maxAgeSeconds: 60 } });
        const res = await handler(createRequest(9, { completeness: "?0", headers: { "Upload-Length": "99" } }));
        expect(res.status).toBe(413);
        expect(res.headers.get("Upload-Limit")).toBe("max-size=4, min-size=0, max-age=60");
    });

    test("a limit rejection about an existing upload states the lifetime it has left", async () => {
        // Restating the configured lifetime would move the deadline the client
        // already holds forward, and its next probe would move it back.
        const { handler, tick } = harness({ policy: { maxAppendSize: 2, maxAgeSeconds: 60 } });
        const created = await handler(createRequest(10, { completeness: "?0" }));
        const token = created.headers.get("Location")!.slice("/uploads/".length);
        tick(30_000);
        const res = await handler(
            patchRequest(10, {
                offset: "0",
                completeness: "?0",
                body: bytes("world"),
                headers: { "Content-Length": "5" },
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(413);
        expect(res.headers.get("Upload-Limit")).toBe("min-size=0, max-append-size=2, max-age=30");
    });

    test("max-age is the whole seconds left until the deadline, never more", async () => {
        // The field is the REMAINING lifetime counted from the response: 10.5 s
        // after creation, 49.5 s remain, and rounding up would promise half a
        // second the resource does not have.
        const { handler, tick } = harness({ policy: { maxAgeSeconds: 60 } });
        const created = await handler(createRequest(9, { completeness: "?0" }));
        const token = created.headers.get("Location")!.slice("/uploads/".length);
        tick(10_500);
        const probe = await handler(resourceRequest(9, "HEAD"), { uploadToken: token });
        expect(probe.headers.get("Upload-Limit")).toBe("min-size=0, max-age=49");
        tick(60_000);
        // Past the deadline the resource is gone, not answered with a zero.
        const late = await handler(resourceRequest(9, "HEAD"), { uploadToken: token });
        expect(late.status).toBe(404);
    });

    for (const version of [9, 10] as const) {
        test(`interop ${version}: a creation that leaves the upload incomplete carries the limits`, async () => {
            // The client continues the upload it just created, so the answer says
            // how large its appends may be and how long the resource lives.
            const { handler, tick } = harness({ policy: { maxAppendSize: 64, maxAgeSeconds: 60 } });
            const res = await handler(createRequest(version, { completeness: "?0" }));
            expect(res.status).toBe(201);
            expect(res.headers.get("Upload-Limit")).toBe("min-size=0, max-append-size=64, max-age=60");
            tick(1);
            // Anchored at the creation instant: the next answer counts down from it.
            const token = res.headers.get("Location")!.slice("/uploads/".length);
            const probe = await handler(resourceRequest(version, "HEAD"), { uploadToken: token });
            expect(probe.headers.get("Upload-Limit")).toBe("min-size=0, max-append-size=64, max-age=59");
        });

        test(`interop ${version}: a creation whose content streams counts down from the instant it began`, async () => {
            // The deadline was fixed when the creation started; ten seconds of
            // streaming are ten seconds the resource no longer has.
            const { handler, tick } = harness({ policy: { maxAgeSeconds: 60 } });
            let sent = false;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (sent) {
                            controller.close();
                            return;
                        }
                        sent = true;
                        tick(10_000);
                        controller.enqueue(bytes("abc"));
                    },
                    // A default queue pulls at construction, before the creation starts.
                },
                { highWaterMark: 0 },
            );
            const res = await handler(
                new Request("http://test/upload", {
                    method: "POST",
                    headers: { [VERSION_HEADER]: String(version), "Upload-Complete": "?0" },
                    body,
                    duplex: "half",
                } as RequestInit),
            );
            expect(res.status).toBe(201);
            expect(res.headers.get("Upload-Offset")).toBe("3");
            expect(res.headers.get("Upload-Limit")).toBe("min-size=0, max-age=50");
        });

        test(`interop ${version}: a creation that streams past its whole lifetime states none left`, async () => {
            // The deadline passed while the content arrived: zero, never a
            // negative integer a client would read as a malformed field.
            const { handler, tick } = harness({ policy: { maxAgeSeconds: 5 } });
            let sent = false;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (sent) {
                            controller.close();
                            return;
                        }
                        sent = true;
                        tick(7_500);
                        controller.enqueue(bytes("abc"));
                    },
                    // A default queue pulls at construction, before the creation starts.
                },
                { highWaterMark: 0 },
            );
            const res = await handler(
                new Request("http://test/upload", {
                    method: "POST",
                    headers: { [VERSION_HEADER]: String(version), "Upload-Complete": "?0" },
                    body,
                    duplex: "half",
                } as RequestInit),
            );
            expect(res.status).toBe(201);
            expect(res.headers.get("Upload-Limit")).toBe("min-size=0, max-age=0");
        });

        test(`interop ${version}: the resumption hook carries the limits a 104 must state`, async () => {
            const seen: Array<{ headers: Record<string, string> }> = [];
            const { handler } = harness({
                policy: { maxAppendSize: 64, maxAgeSeconds: 60 },
                onResumptionSupported: (info) => {
                    seen.push(info);
                },
            });
            // A creation that completes is still announced by its 104, which the
            // server sends before it knows the content will finish.
            await handler(createRequest(version, { completeness: "?1", body: bytes("x") }));
            expect(seen).toHaveLength(1);
            expect(seen[0]!.headers["Upload-Limit"]).toBe("min-size=0, max-append-size=64, max-age=60");
        });
    }

    test("versions whose 104 predates the field hand the hook no limits", async () => {
        for (const version of [3, 5, 6] as const) {
            const seen: object[] = [];
            const { handler } = harness({
                policy: { maxAppendSize: 64 },
                onResumptionSupported: (info) => {
                    seen.push(info);
                },
            });
            await handler(createRequest(version, { completeness: WIRE[version].incomplete, body: bytes("x") }));
            expect(seen).toHaveLength(1);
            expect(seen[0]).not.toHaveProperty("uploadLimit");
        }
    });

    test("a bound longer than a structured-field integer is refused at construction", () => {
        // A parser refuses the whole field on a 16-digit integer, so the client
        // would lose every limit, not only this one.
        expect(() => harness({ policy: { maxSize: Number.MAX_SAFE_INTEGER } })).toThrow(
            "policy.maxSize must be an integer from -999999999999999 to 999999999999999",
        );
        expect(() => harness({ policy: { maxAgeSeconds: 1e15 } })).toThrow("policy.maxAgeSeconds");
        expect(() => harness({ policy: { maxSize: 999_999_999_999_999 } })).not.toThrow();
        // A store's own append ceiling is a bound the field states too.
        const ceiling: ResumableWriteStore = { ...memoryUploadStore({ objects: {} }), maxAppendSize: 1e15 };
        expect(() => harness({}, ceiling)).toThrow("policy.maxAppendSize");
    });

    test("a bound spelled undefined is no bound, not a malformed one", async () => {
        // A policy built from optional configuration carries its absent bounds
        // as undefined keys; the field omits them like keys never written.
        const { handler } = harness({ policy: { maxAppendSize: undefined, maxAgeSeconds: 60 } });
        const res = await handler(createRequest(9, { completeness: "?0" }));
        expect(res.status).toBe(201);
        expect(res.headers.get("Upload-Limit")).toBe("min-size=0, max-age=60");
    });

    test("a creation that completed carries no limits: there is nothing left to append", async () => {
        const { handler } = harness({ policy: { maxAppendSize: 64 } });
        const res = await handler(createRequest(10, { completeness: "?1", body: bytes("hello") }));
        expect(res.status).toBe(201);
        expect(res.headers.get("Upload-Limit")).toBeNull();
    });

    for (const version of [3, 5, 6] as const) {
        test(`interop ${version}: a creation carries no limits`, async () => {
            const { handler } = harness({ policy: { maxAppendSize: 64 } });
            const res = await handler(createRequest(version, { completeness: WIRE[version].incomplete }));
            expect(res.status).toBe(201);
            expect(res.headers.get("Upload-Limit")).toBeNull();
        });
    }

    test("versions that do not define the field do not emit it", async () => {
        const { handler } = harness({ policy: { maxSize: 1024 } });
        const created = await handler(createRequest(6, { completeness: "?0" }));
        const token = created.headers.get("Location")!.slice("/uploads/".length);
        const probe = await handler(resourceRequest(6, "HEAD"), { uploadToken: token });
        expect(probe.headers.get("Upload-Limit")).toBeNull();
    });
});

// ─── Discovery answers what it will enforce ─────────────────────────────────

describe("OPTIONS", () => {
    test("announces the limits, so a client sizes its first request", async () => {
        const { handler } = harness({ policy: { maxSize: 1024, maxAppendSize: 64 } });
        const res = await handler(new Request("http://test/upload", { method: "OPTIONS" }));

        expect(res.status).toBe(204);
        // Asking is the whole point: without this a client learns the ceiling
        // by being refused at it.
        expect(res.headers.get("Upload-Limit")).toBe("max-size=1024, min-size=0, max-append-size=64");
        expect(res.headers.get("Allow")).toContain("POST");
    });

    test("a server applying no limits still answers the field", async () => {
        const { handler } = harness();
        const res = await handler(new Request("http://test/upload", { method: "OPTIONS" }));
        expect(res.headers.get("Upload-Limit")).toBe("min-size=0");
    });
});

// ─── A registered problem type where the version defines one ────────────────

describe("inconsistent length answers", () => {
    const inconsistent = (version: Version) => {
        const { handler } = harness();
        return handler(
            createRequest(version, {
                completeness: WIRE[version].complete,
                headers: { "Upload-Length": "4", "Content-Length": "10" },
                body: bytes("0123456789"),
            }),
        );
    };

    for (const version of [9, 10] as const) {
        test(`interop ${version} carries the registered problem type as problem+json`, async () => {
            const res = await inconsistent(version);
            expect(res.status).toBe(400);
            expect(res.headers.get("Content-Type")).toBe("application/problem+json");
            const body = (await res.json()) as { type: string; title: string };
            expect(body.type).toBe("https://iana.org/assignments/http-problem-types#inconsistent-upload-length");
            expect(body.title).toBe("inconsistent length values for upload");
        });
    }

    test("versions predating the registration name the same fault in plain text", async () => {
        for (const version of [3, 5, 6] as const) {
            const res = await inconsistent(version);
            expect(res.status).toBe(400);
            // A type they cannot resolve would be worse than prose.
            expect(res.headers.get("Content-Type")).toContain("text/plain");
            expect(await res.text()).toBe("inconsistent length values for upload");
        }
    });
});

// ─── A 2xx acknowledges the whole content (draft-13) ────────────────────────

describe("content the server did not wholly process", () => {
    /** A body that yields `prefix`, then dies the way a dropped connection does. */
    function tornBody(prefix: string): ReadableStream<Uint8Array> {
        let sent = false;
        return new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent) {
                    controller.error(new Error("connection reset"));
                    return;
                }
                sent = true;
                controller.enqueue(bytes(prefix));
            },
        });
    }

    function tornPatch(version: Version, completeness: string): Request {
        return new Request("http://test/uploads/x", {
            method: "PATCH",
            headers: {
                [VERSION_HEADER]: String(version),
                "Upload-Offset": "5",
                "Content-Type": "application/partial-upload",
                [WIRE[version].header]: completeness,
            },
            body: tornBody("wor"),
            duplex: "half",
        } as RequestInit);
    }

    for (const completeness of ["?0", "?1"]) {
        test(`interop 10: an interrupted append (${completeness}) is a 409 carrying the durable offset`, async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, 10);
            const res = await handler(tornPatch(10, completeness), { uploadToken: token });
            // A 2xx with the upload incomplete tells a draft-13 client every byte
            // it sent arrived, so it would resume past the two that did not.
            expect(res.status).toBe(409);
            expect(res.headers.get("Upload-Offset")).toBe("8");
            expect(res.headers.get("Upload-Complete")).toBe("?0");
            expect(res.headers.get(VERSION_HEADER)).toBe("10");
            expectErrorHardening(res);
            const probe = await handler(resourceRequest(10, "HEAD"), { uploadToken: token });
            expect(probe.headers.get("Upload-Offset")).toBe("8");
        });
    }

    test("interop 9 answers the same interruption 204 with the durable offset", async () => {
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 9);
        const res = await handler(tornPatch(9, "?0"), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("Upload-Offset")).toBe("8");
    });

    test("interop 10: a completing append short of the declared length is a 400, never a 2xx", async () => {
        const { handler, objects } = harness();
        const { token } = await createIncomplete(handler, 10);
        // No Content-Length, so the shortfall is visible only once the body ends.
        const res = await handler(patchRequest(10, { offset: "5", completeness: "?1", body: bytes("wor") }), {
            uploadToken: token,
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("Content-Type")).toBe("application/problem+json");
        expect(await res.json()).toMatchObject({
            type: "https://iana.org/assignments/http-problem-types#inconsistent-upload-length",
        });
        expect(res.headers.get("Upload-Offset")).toBe("8");
        expect(res.headers.get("Upload-Complete")).toBe("?0");
        expect(Object.keys(objects)).toHaveLength(0);
        // The prefix is durable and the upload resumable: the rest completes it.
        const rest = await handler(
            patchRequest(10, {
                offset: "8",
                completeness: "?1",
                body: bytes("ld"),
                headers: { "Content-Length": "2" },
            }),
            { uploadToken: token },
        );
        expect(rest.status).toBe(200);
        expect(objects["doc.bin"]?.body).toEqual(bytes("helloworld"));
    });

    test("interop 9 answers the same shortfall 400 with the durable offset", async () => {
        const { handler } = harness();
        const { token } = await createIncomplete(handler, 9);
        const res = await handler(patchRequest(9, { offset: "5", completeness: "?1", body: bytes("wor") }), {
            uploadToken: token,
        });
        // A 2xx would tell the client its completion took; the prefix stays resumable.
        expect(res.status).toBe(400);
        expect(res.headers.get("Upload-Offset")).toBe("8");
        expect(res.headers.get("Upload-Complete")).toBe("?0");
    });

    test("interop 10: a completing creation short of its declared length still hands back the resource", async () => {
        const { handler } = harness();
        const res = await handler(
            createRequest(10, {
                completeness: "?1",
                body: bytes("hello"),
                headers: { "Upload-Length": "10" },
            }),
        );
        expect(res.status).toBe(400);
        expect(res.headers.get("Upload-Offset")).toBe("5");
        expect(res.headers.get("Upload-Complete")).toBe("?0");
        // The bytes are durable; without the Location they are unreachable.
        expect(res.headers.get("Location")).toMatch(/^\/uploads\/.+/);
    });

    test("interop 10: an interrupted creation is a 409 that still hands back the resource", async () => {
        const { handler } = harness();
        const res = await handler(
            new Request("http://test/upload", {
                method: "POST",
                headers: { [VERSION_HEADER]: "10", "Upload-Complete": "?0" },
                body: tornBody("hel"),
                duplex: "half",
            } as RequestInit),
        );
        expect(res.status).toBe(409);
        expect(res.headers.get("Upload-Offset")).toBe("3");
        expect(res.headers.get("Upload-Complete")).toBe("?0");
        expectErrorHardening(res);
        // The prefix is durable, and the Location is the only way back to it.
        const location = res.headers.get("Location");
        expect(location).toMatch(/^\/uploads\/.+/);
        const probe = await handler(resourceRequest(10, "HEAD"), {
            uploadToken: location!.slice("/uploads/".length),
        });
        expect(probe.headers.get("Upload-Offset")).toBe("3");
    });
});

// ─── Completion representation headers (RFC 9530 / RFC 9110) ────────────────

describe("destination conflict at completion", () => {
    for (const version of VERSIONS) {
        test(`interop ${version}: a destination changed under the sealed plan answers 409`, async () => {
            const base = memoryUploadStore({ objects: {} });
            const store: ResumableWriteStore = {
                ...base,
                async completeUpload(token) {
                    throw new UploadDestinationConflictError(token);
                },
            };
            const { handler } = harness({}, store);
            const res = await handler(completingCreate(version));
            expect(res.status).toBe(409);
        });
    }
});
describe("completion representation headers", () => {
    /** A store whose completion reports exactly the given digest and etag. */
    function storeReporting(published: { digest?: string; etag?: string }): ResumableWriteStore {
        const store = memoryUploadStore({ objects: {} });
        return {
            ...store,
            async completeUpload() {
                return published;
            },
        };
    }

    for (const version of VERSIONS) {
        const w = WIRE[version];

        test(`interop ${version}: a creation that completes describes the published object`, async () => {
            const digest = await sha256Base64("hello");
            const { handler } = harness();
            const res = await handler(completingCreate(version));
            expect(res.status).toBe(201);
            // RFC 9530 Section 3: the member value is a Structured Fields Byte
            // Sequence, so the colons are syntax, not decoration.
            expect(res.headers.get("Repr-Digest")).toBe(`sha-256=:${digest}:`);
            expect(res.headers.get("ETag")).toBe(`"${digest}"`);
        });

        test(`interop ${version}: an append that completes describes the published object`, async () => {
            const digest = await sha256Base64("helloworld");
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(completingPatch(version, 5, "world"), { uploadToken: token });
            expect(res.status).toBe(200);
            expect(res.headers.get("Repr-Digest")).toBe(`sha-256=:${digest}:`);
            expect(res.headers.get("ETag")).toBe(`"${digest}"`);
        });

        test(`interop ${version}: an append that leaves the upload incomplete describes nothing`, async () => {
            const { handler } = harness();
            const { token } = await createIncomplete(handler, version);
            const res = await handler(
                patchRequest(version, {
                    offset: "5",
                    completeness: w.incomplete,
                    body: bytes("wo"),
                    headers: { "Content-Length": "2" },
                }),
                { uploadToken: token },
            );
            expect(res.status).toBe(204);
            // Nothing published, so there is no representation to describe.
            expect(res.headers.get("Repr-Digest")).toBeNull();
            expect(res.headers.get("ETag")).toBeNull();
        });
    }

    test("a store that reports no digest sends no Repr-Digest", async () => {
        const { handler } = harness({}, storeReporting({ etag: '"v1"' }));
        const res = await handler(createRequest(6, { completeness: "?1", body: bytes("hello") }));
        expect(res.status).toBe(201);
        // Absence means "not asserted", which is how a client learns its own
        // Repr-Digest assertion was never checked against stored bytes.
        expect(res.headers.get("Repr-Digest")).toBeNull();
        expect(res.headers.get("ETag")).toBe('"v1"');
    });

    test("a store that reports neither sends neither", async () => {
        const { handler } = harness({}, storeReporting({}));
        const res = await handler(createRequest(6, { completeness: "?1", body: bytes("hello") }));
        expect(res.status).toBe(201);
        expect(res.headers.get("Repr-Digest")).toBeNull();
        expect(res.headers.get("ETag")).toBeNull();
    });

    test("an empty etag is an absent ETag, never an empty field", async () => {
        const { handler } = harness({}, storeReporting({ etag: "" }));
        const res = await handler(createRequest(6, { completeness: "?1", body: bytes("hello") }));
        expect(res.headers.get("ETag")).toBeNull();
    });

    test("a digest that is not a 32-byte SHA-256 emits no Repr-Digest at all", async () => {
        // Framing a value the field cannot carry would be a false integrity
        // assertion; the only safe answer is to say nothing.
        for (const bogus of ["not-base64!!", "AAAA", "sha-256=:AAAA:", `${await sha256Base64("x")}EXTRA`]) {
            const { handler } = harness({}, storeReporting({ digest: bogus }));
            const res = await handler(createRequest(6, { completeness: "?1", body: bytes("hello") }));
            expect(res.status).toBe(201);
            expect(res.headers.get("Repr-Digest")).toBeNull();
        }
    });

    test("a hostile digest cannot inject a header or split the response", async () => {
        const clean = await sha256Base64("hello");
        const { handler } = harness(
            {},
            storeReporting({
                digest: `${clean}:\r\nX-Injected: yes`,
                etag: '"v1"\r\nX-Injected: yes',
            }),
        );
        const res = await handler(createRequest(6, { completeness: "?1", body: bytes("hello") }));
        expect(res.status).toBe(201);
        expect(res.headers.get("X-Injected")).toBeNull();
        // The digest fails the sha-256 gate outright, so no field is framed.
        expect(res.headers.get("Repr-Digest")).toBeNull();
        // The etag survives as one line with the CR/LF stripped out of it.
        const etag = res.headers.get("ETag")!;
        expect(etag).not.toContain("\r");
        expect(etag).not.toContain("\n");
        expect(etag).toBe('"v1"X-Injected: yes');
    });

    test("every header a completing flow emits is in UPLOAD_EXPOSED_HEADERS", async () => {
        // The list and the wire must agree in BOTH directions: a name it omits
        // is a header a cross-origin client cannot read, and a name it carries
        // for a header never sent describes a wire that does not exist.
        const { handler } = harness({ policy: { maxAgeSeconds: 3600 } });
        const seen = new Set<string>();
        const collect = (res: Response) => res.headers.forEach((_v, k) => seen.add(k.toLowerCase()));
        const { token } = await createIncomplete(handler, 9);
        collect(await handler(resourceRequest(9, "HEAD"), { uploadToken: token }));
        collect(
            await handler(
                patchRequest(9, {
                    offset: "5",
                    completeness: "?1",
                    body: bytes("world"),
                    headers: { "Content-Length": "5" },
                }),
                { uploadToken: token },
            ),
        );

        const exposable = new Set(UPLOAD_EXPOSED_HEADERS.map((h) => h.toLowerCase()));
        const alwaysReadable = new Set(["content-type", "content-length", "cache-control", "date"]);
        for (const h of seen) {
            expect(exposable.has(h) || alwaysReadable.has(h)).toBe(true);
        }
        // The completing response really did carry the two this fix adds.
        expect(seen.has("repr-digest")).toBe(true);
        expect(seen.has("etag")).toBe(true);
    });

    test("UPLOAD_EXPOSED_HEADERS names nothing the dialect cannot emit", () => {
        // Every name is either a literal in the dialect source or the interop
        // version header it builds from a constant.
        const emittable = new Set([
            "Location",
            "Upload-Offset",
            "Upload-Length",
            "Upload-Complete",
            "Upload-Incomplete",
            "Upload-Draft-Interop-Version",
            "Upload-Limit",
            "ETag",
            "Repr-Digest",
        ]);
        for (const h of UPLOAD_EXPOSED_HEADERS) expect(emittable.has(h)).toBe(true);
    });
});

// draft-ietf-httpbis-resumable-upload-13 Section 4.2.1: creation is a request that
// can carry content (POST, PUT, PATCH). A tokenless request of any other method
// names no resource and creates none.
describe("creation methods", () => {
    for (const method of ["DELETE", "GET"]) {
        test(`a tokenless ${method} with Upload-Complete: ?1 is 405 and publishes nothing`, async () => {
            const { handler, objects } = harness();
            const res = await handler(
                new Request("http://test/upload", {
                    method,
                    headers: { [VERSION_HEADER]: "9", "Upload-Complete": "?1" },
                }),
            );
            expect(res.status).toBe(405);
            expect(res.headers.get("Allow")).toBe("POST, PUT, PATCH, OPTIONS");
            expect(res.headers.get("Location")).toBeNull();
            expect(Object.keys(objects)).toEqual([]);
        });
    }

    for (const method of ["POST", "PUT", "PATCH"]) {
        test(`a tokenless ${method} creates`, async () => {
            const { handler } = harness();
            const res = await handler(
                new Request("http://test/upload", {
                    method,
                    headers: { [VERSION_HEADER]: "9", "Upload-Complete": "?1" },
                    body: bytes("hello"),
                }),
            );
            expect(res.status).toBe(201);
        });
    }
});
