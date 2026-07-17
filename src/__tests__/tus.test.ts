import { describe, test, expect } from "bun:test";
import {
    createTusHandler, parseUploadMetadata, webCryptoChecksum,
    TUS_EXPOSED_HEADERS, UPLOAD_EXPOSED_HEADERS, type TusHandlerOptions,
} from "../tus";
import { UploadNotFoundError, type ResumableWriteStore, type StoredUploadState } from "../upload-store";
import { UploadLockTimeoutError } from "../upload-locker";
import type { UploadResourceEvent } from "../upload-orchestrator";

const NOW = 1_800_000_000_000;
const BASE = "http://localhost/files";
const OFFSET_TYPE = "application/offset+octet-stream";

// ─── In-test store (same harness shape as the orchestrator suite) ───────────

interface FakeUpload {
    key: string;
    bytes: Uint8Array;
    length?: number;
    isComplete: boolean;
    isInvalidated: boolean;
    createdAt: number;
    lastAppendAt?: number;
    metadata?: Record<string, string>;
}

function fakeStore(over: Partial<ResumableWriteStore> = {}) {
    const uploads = new Map<string, FakeUpload>();
    let seq = 0;
    const base: ResumableWriteStore = {
        exactOffsetRecovery: true,
        atomicCompletion: true,
        digestOnComplete: "sha256",
        async createUpload(opts) {
            const uploadToken = `u${++seq}`;
            uploads.set(uploadToken, {
                key: opts.key, bytes: new Uint8Array(0), length: opts.length,
                isComplete: false, isInvalidated: false, createdAt: opts.now,
                metadata: opts.metadata,
            });
            return { uploadToken };
        },
        async getUploadState(token): Promise<StoredUploadState> {
            const u = uploads.get(token);
            if (!u) throw new UploadNotFoundError(token);
            return {
                offset: u.bytes.byteLength, length: u.length, isComplete: u.isComplete,
                isInvalidated: u.isInvalidated, createdAt: u.createdAt,
                lastAppendAt: u.lastAppendAt, metadata: u.metadata,
            };
        },
        async appendChunk(token, offset, body, opts) {
            const u = uploads.get(token);
            if (!u) throw new UploadNotFoundError(token);
            let written = 0;
            const chunks: Uint8Array[] = [];
            if (body instanceof Uint8Array) {
                chunks.push(body);
                written = body.byteLength;
            } else {
                const reader = body.getReader();
                try {
                    for (;;) {
                        if (opts.signal?.aborted) break;
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        written += value.byteLength;
                    }
                } catch {
                    // torn body: keep the flushed prefix
                }
            }
            const merged = new Uint8Array(u.bytes.byteLength + written);
            merged.set(u.bytes, 0);
            let at = u.bytes.byteLength;
            for (const c of chunks) { merged.set(c, at); at += c.byteLength; }
            u.bytes = merged;
            u.lastAppendAt = opts.now;
            if (opts.signal?.aborted) throw new Error("aborted mid-append");
            return { bytesWritten: written };
        },
        async completeUpload(token) {
            const u = uploads.get(token);
            if (!u) throw new UploadNotFoundError(token);
            u.isComplete = true;
            u.length = u.bytes.byteLength;
            return { etag: '"done"' };
        },
        async abortUpload(token) {
            uploads.delete(token);
        },
    };
    return { store: { ...base, ...over } as ResumableWriteStore, uploads };
}

// ─── Request helpers ─────────────────────────────────────────────────────────

function bodyOf(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

function b64(text: string): string {
    return Buffer.from(text, "utf-8").toString("base64");
}

interface ReqOpts {
    headers?: Record<string, string>;
    body?: Uint8Array | ReadableStream<Uint8Array>;
    noVersion?: boolean;
    url?: string;
    signal?: AbortSignal;
}

function tusRequest(method: string, opts: ReqOpts = {}): Request {
    const headers: Record<string, string> = {
        ...(opts.noVersion ? {} : { "Tus-Resumable": "1.0.0" }),
        ...opts.headers,
    };
    const init: RequestInit & { duplex?: "half" } = { method, headers, signal: opts.signal };
    if (opts.body !== undefined) {
        init.body = opts.body;
        if (opts.body instanceof ReadableStream) init.duplex = "half";
    }
    return new Request(opts.url ?? BASE, init);
}

/** A stream the test releases chunk by chunk. */
function controlledStream() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    return {
        stream,
        push: (text: string) => controller.enqueue(bodyOf(text)),
        close: () => controller.close(),
        error: (e: unknown) => controller.error(e),
    };
}

function makeHandler(
    opts: Partial<TusHandlerOptions> = {},
    storeOver: Partial<ResumableWriteStore> = {},
) {
    const { store, uploads } = fakeStore(storeOver);
    const handler = createTusHandler(store, {
        key: () => "server-key.bin",
        location: (token) => `/files/${token}`,
        now: () => NOW,
        graceMs: 0,
        ...opts,
    });
    return { handler, uploads, store };
}

function locationToken(res: Response): string {
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    return location!.split("/").pop()!;
}

/** Create an upload through the wire (Upload-Length given) and return its token. */
async function createUpload(
    handler: (req: Request, ctx?: { uploadToken?: string }) => Promise<Response>,
    headers: Record<string, string>,
    body?: Uint8Array,
): Promise<string> {
    const res = await handler(tusRequest("POST", { headers, body }));
    expect(res.status).toBe(201);
    return locationToken(res);
}

// ─── Version negotiation (core, Tus-Resumable) ───────────────────────────────

describe("version negotiation", () => {
    test("missing Tus-Resumable answers 412 with Tus-Version", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("POST", { noVersion: true, headers: { "Upload-Length": "5" } }));
        expect(res.status).toBe(412);
        expect(res.headers.get("tus-version")).toBe("1.0.0");
        expect(res.headers.get("tus-resumable")).toBe("1.0.0");
        expect(await res.text()).toBe("unsupported Tus-Resumable version");
    });

    test("an unsupported version answers 412 and the request is not processed", async () => {
        const { handler, uploads } = makeHandler();
        const res = await handler(tusRequest("POST", {
            noVersion: true,
            headers: { "Tus-Resumable": "0.2.2", "Upload-Length": "5" },
        }));
        expect(res.status).toBe(412);
        expect(uploads.size).toBe(0);
    });

    test("OPTIONS ignores Tus-Resumable entirely", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("OPTIONS", { noVersion: true, headers: { "Tus-Resumable": "9.9.9" } }));
        expect(res.status).toBe(204);
    });

    test("412 carries the hardening headers", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("PATCH", { noVersion: true }));
        expect(res.status).toBe(412);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    });
});

// ─── OPTIONS (core) ──────────────────────────────────────────────────────────

describe("CORS exposed headers", () => {
    test("TUS_EXPOSED_HEADERS covers the resume-critical headers, immutably", () => {
        for (const h of ["Location", "Upload-Offset", "Upload-Length", "Upload-Expires", "Tus-Resumable"]) {
            expect(TUS_EXPOSED_HEADERS).toContain(h);
        }
        // Frozen: a caller cannot accidentally mutate the shared list.
        expect(Object.isFrozen(TUS_EXPOSED_HEADERS)).toBe(true);
    });

    test("UPLOAD_EXPOSED_HEADERS covers the IETF dialect's resume-critical headers", () => {
        for (const h of ["Location", "Upload-Offset", "Upload-Limit", "Upload-Draft-Interop-Version"]) {
            expect(UPLOAD_EXPOSED_HEADERS).toContain(h);
        }
        expect(Object.isFrozen(UPLOAD_EXPOSED_HEADERS)).toBe(true);
    });

    test("every header actually emitted by a full upload flow is in the exposed list", async () => {
        // Drive create -> HEAD -> PATCH-complete with expiration on and collect
        // every response header; each must be exposable or a CORS client breaks.
        const { handler } = makeHandler({ maxAgeSeconds: 3600 });
        const seen = new Set<string>();
        const collect = (res: Response) => res.headers.forEach((_v, k) => seen.add(k.toLowerCase()));

        const created = await handler(tusRequest("POST", { headers: { "Upload-Length": "4" } }));
        collect(created);
        const token = locationToken(created);
        collect(await handler(tusRequest("HEAD", {}), { uploadToken: token }));
        collect(await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4" },
            body: bodyOf("abcd"),
        }), { uploadToken: token }));

        const exposable = new Set(TUS_EXPOSED_HEADERS.map((h) => h.toLowerCase()));
        // Transport/generic headers a browser reads without CORS exposure.
        const alwaysReadable = new Set([
            "content-type", "content-length", "cache-control", "date",
            "x-content-type-options", "content-security-policy",
        ]);
        const protocolHeaders = [...seen].filter((h) => h.startsWith("tus-") || h.startsWith("upload-") || h === "location");
        for (const h of protocolHeaders) {
            expect(exposable.has(h) || alwaysReadable.has(h)).toBe(true);
        }
    });
});

describe("OPTIONS", () => {
    test("advertises version, base extensions, and echoes Tus-Resumable", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("OPTIONS", { noVersion: true }));
        expect(res.status).toBe(204);
        expect(res.headers.get("tus-resumable")).toBe("1.0.0");
        expect(res.headers.get("tus-version")).toBe("1.0.0");
        // Honest advertising: no max age configured, so `expiration` is absent.
        expect(res.headers.get("tus-extension"))
            .toBe("creation,creation-with-upload,creation-defer-length,termination");
        expect(res.headers.get("tus-max-size")).toBeNull();
    });

    test("advertises `expiration` only when a max age is configured", async () => {
        const { handler: withAge } = makeHandler({ maxAgeSeconds: 3600 });
        const withRes = await withAge(tusRequest("OPTIONS", { noVersion: true }));
        expect(withRes.headers.get("tus-extension")).toContain("expiration");

        const { handler: without } = makeHandler();
        const withoutRes = await without(tusRequest("OPTIONS", { noVersion: true }));
        expect(withoutRes.headers.get("tus-extension")).not.toContain("expiration");
    });

    test("advertises Tus-Max-Size when a maximum size is configured", async () => {
        const { handler } = makeHandler({ maxSize: 1024 });
        const res = await handler(tusRequest("OPTIONS", { noVersion: true }));
        expect(res.headers.get("tus-max-size")).toBe("1024");
    });

    test("a policy object works like flat fields, and flat fields win", async () => {
        const { handler } = makeHandler({ policy: { maxSize: 512 } });
        const res = await handler(tusRequest("OPTIONS", { noVersion: true }));
        expect(res.headers.get("tus-max-size")).toBe("512");

        const { handler: overridden } = makeHandler({ policy: { maxSize: 512 }, maxSize: 2048 });
        const res2 = await overridden(tusRequest("OPTIONS", { noVersion: true }));
        expect(res2.headers.get("tus-max-size")).toBe("2048");
    });
});

// ─── Creation (extension: creation) ──────────────────────────────────────────

describe("creation", () => {
    test("POST with Upload-Length answers 201 with Location and no Upload-Offset", async () => {
        const { handler, uploads } = makeHandler();
        const res = await handler(tusRequest("POST", { headers: { "Upload-Length": "10" } }));
        expect(res.status).toBe(201);
        expect(res.headers.get("location")).toBe("/files/u1");
        expect(res.headers.get("tus-resumable")).toBe("1.0.0");
        expect(res.headers.get("upload-offset")).toBeNull();
        expect(uploads.get("u1")).toMatchObject({ key: "server-key.bin", length: 10, isComplete: false });
        expect(uploads.get("u1")!.metadata).toBeUndefined(); // no header, no empty record
    });

    test("Upload-Length: 0 creates an immediately complete empty upload", async () => {
        const { handler, uploads } = makeHandler();
        const res = await handler(tusRequest("POST", { headers: { "Upload-Length": "0" } }));
        expect(res.status).toBe(201);
        expect(uploads.get("u1")!.isComplete).toBe(true);
    });

    test("both Upload-Length and Upload-Defer-Length answers 400", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("POST", {
            headers: { "Upload-Length": "10", "Upload-Defer-Length": "1" },
        }));
        expect(res.status).toBe(400);
    });

    test("neither length header answers 400", async () => {
        const { handler } = makeHandler();
        expect((await handler(tusRequest("POST"))).status).toBe(400);
    });

    test("malformed Upload-Length and Upload-Defer-Length answer 400", async () => {
        const { handler } = makeHandler();
        // "0x10" is the discriminating case: Number() would accept it, the
        // digits-only grammar must not.
        for (const value of ["abc", "-1", "1.5", "0x10", "1e2"]) {
            const res = await handler(tusRequest("POST", { headers: { "Upload-Length": value } }));
            expect(res.status).toBe(400);
            expect(await res.text()).toBe("invalid Upload-Length header");
        }
        const defer = await handler(tusRequest("POST", { headers: { "Upload-Defer-Length": "2" } }));
        expect(defer.status).toBe(400);
        expect(await defer.text()).toBe("invalid Upload-Defer-Length header");
    });

    test("a malformed Content-Length on a creation with content answers 400", async () => {
        const { handler, uploads } = makeHandler();
        const res = await handler(tusRequest("POST", {
            headers: { "Upload-Length": "10", "Content-Type": OFFSET_TYPE, "Content-Length": "0x10" },
            body: bodyOf("hello"),
        }));
        expect(res.status).toBe(400);
        expect(await res.text()).toBe("invalid Content-Length header");
        expect(uploads.size).toBe(0);
    });

    test("Upload-Length above the maximum answers 413 with Tus-Max-Size", async () => {
        const { handler } = makeHandler({ maxSize: 4 });
        const res = await handler(tusRequest("POST", { headers: { "Upload-Length": "100" } }));
        expect(res.status).toBe(413);
        expect(res.headers.get("tus-max-size")).toBe("4");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await res.text()).toBe("maximum size exceeded");
    });

    test("decoded metadata reaches the key callback and the stored resource", async () => {
        const seen: Array<Record<string, string>> = [];
        const { handler, uploads } = makeHandler({
            key: ({ metadata }) => { seen.push(metadata); return "k1"; },
        });
        const res = await handler(tusRequest("POST", {
            headers: {
                "Upload-Length": "5",
                "Upload-Metadata": `filename ${b64("plan.pdf")},empty`,
            },
        }));
        expect(res.status).toBe(201);
        expect(seen[0]).toEqual({ filename: "plan.pdf", empty: "" });
        expect(uploads.get("u1")!.metadata).toEqual({ filename: "plan.pdf", empty: "" });
    });

    test("malformed Upload-Metadata answers 400 before any store call", async () => {
        const { handler, uploads } = makeHandler();
        for (const value of [
            "filename ###",             // not base64
            `k ${b64("a")} extra`,      // three tokens in one pair
            `k ${b64("a")},k ${b64("b")}`, // duplicate key
            `bad,key ${b64("a")}`.replace("bad", "sp ace x"), // key with space
            "k /w==",                   // valid base64, not UTF-8
            ",",                        // empty pair
        ]) {
            const res = await handler(tusRequest("POST", {
                headers: { "Upload-Length": "5", "Upload-Metadata": value },
            }));
            expect(res.status).toBe(400);
        }
        expect(uploads.size).toBe(0);
    });
});

describe("parseUploadMetadata", () => {
    test("absent and empty headers parse to no metadata", () => {
        expect(parseUploadMetadata(null)).toEqual({});
        expect(parseUploadMetadata("")).toEqual({});
        expect(parseUploadMetadata("   ")).toEqual({});
    });

    test("pairs decode, bare keys carry empty values, whitespace around pairs is tolerated", () => {
        expect(parseUploadMetadata(`a ${b64("x")}, b ${b64("æøå")} ,c`))
            .toEqual({ a: "x", b: "æøå", c: "" });
    });

    test("malformed input returns null", () => {
        expect(parseUploadMetadata("k not-base64!")).toBeNull();
        expect(parseUploadMetadata(`k ${b64("v")},k ${b64("v")}`)).toBeNull();
        expect(parseUploadMetadata("k v w")).toBeNull();
        expect(parseUploadMetadata("k" + String.fromCharCode(1) + " " + b64("v"))).toBeNull(); // control byte in key
        expect(parseUploadMetadata(String.fromCharCode(1) + "k " + b64("v"))).toBeNull(); // control byte starting a key
        expect(parseUploadMetadata("k AAA")).toBeNull(); // truncated base64 quantum
    });
});

// ─── Creation with upload (extension: creation-with-upload) ──────────────────

describe("creation-with-upload", () => {
    test("a partial body is accepted and the 201 reports the applied offset", async () => {
        const { handler, uploads } = makeHandler();
        const res = await handler(tusRequest("POST", {
            headers: { "Upload-Length": "10", "Content-Type": OFFSET_TYPE, "Content-Length": "5" },
            body: bodyOf("hello"),
        }));
        expect(res.status).toBe(201);
        expect(res.headers.get("upload-offset")).toBe("5");
        expect(uploads.get("u1")!.isComplete).toBe(false);
    });

    test("a full body completes the upload at creation", async () => {
        const { handler, uploads } = makeHandler();
        const res = await handler(tusRequest("POST", {
            headers: { "Upload-Length": "10", "Content-Type": OFFSET_TYPE, "Content-Length": "10" },
            body: bodyOf("0123456789"),
        }));
        expect(res.status).toBe(201);
        expect(res.headers.get("upload-offset")).toBe("10");
        expect(uploads.get("u1")!.isComplete).toBe(true);
    });

    test("a body under any other Content-Type is not upload content", async () => {
        const { handler, uploads } = makeHandler();
        const res = await handler(tusRequest("POST", {
            headers: { "Upload-Length": "10", "Content-Type": "text/plain", "Content-Length": "5" },
            body: bodyOf("hello"),
        }));
        expect(res.status).toBe(201);
        expect(res.headers.get("upload-offset")).toBeNull();
        expect(uploads.get("u1")!.bytes.byteLength).toBe(0);
    });
});

// ─── HEAD (core) ─────────────────────────────────────────────────────────────

describe("HEAD", () => {
    test("reports offset, length, no-store, and the version echo", async () => {
        const { handler } = makeHandler();
        const token = await createUpload(handler, { "Upload-Length": "10" });
        await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4" },
            body: bodyOf("abcd"),
        }), { uploadToken: token });

        const res = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(res.status).toBe(200);
        expect(res.headers.get("upload-offset")).toBe("4");
        expect(res.headers.get("upload-length")).toBe("10");
        expect(res.headers.get("upload-defer-length")).toBeNull();
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("tus-resumable")).toBe("1.0.0");
        expect(await res.text()).toBe("");
    });

    test("a deferred-length upload answers Upload-Defer-Length: 1 and no Upload-Length", async () => {
        const { handler } = makeHandler();
        const token = await createUpload(handler, { "Upload-Defer-Length": "1" });
        const res = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(res.status).toBe(200);
        expect(res.headers.get("upload-offset")).toBe("0");
        expect(res.headers.get("upload-defer-length")).toBe("1");
        expect(res.headers.get("upload-length")).toBeNull();
    });

    test("an unknown upload answers 404 without Upload-Offset and without a body", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("HEAD"), { uploadToken: "nope" });
        expect(res.status).toBe(404);
        expect(res.headers.get("upload-offset")).toBeNull();
        expect(await res.text()).toBe("");
        expect(res.headers.get("cache-control")).toBe("no-store");
    });

    test("a missing token answers 404", async () => {
        const { handler } = makeHandler();
        expect((await handler(tusRequest("HEAD"))).status).toBe(404);
    });

    test("resolveToken supplies the token when the caller passes no ctx", async () => {
        const { handler } = makeHandler({
            resolveToken: (req) => new URL(req.url).pathname.split("/").pop(),
        });
        const token = await createUpload(handler, { "Upload-Length": "5" });
        const res = await handler(tusRequest("HEAD", { url: `${BASE}/${token}` }));
        expect(res.status).toBe(200);
        expect(res.headers.get("upload-offset")).toBe("0");
    });
});

// ─── PATCH (core + creation-defer-length) ────────────────────────────────────

describe("PATCH", () => {
    async function withUpload(opts: Partial<TusHandlerOptions> = {}, length = "10") {
        const made = makeHandler(opts);
        const token = await createUpload(made.handler, { "Upload-Length": length });
        return { ...made, token };
    }

    test("happy path: 204 with the new Upload-Offset", async () => {
        const { handler, token } = await withUpload();
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4" },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-offset")).toBe("4");
        expect(res.headers.get("tus-resumable")).toBe("1.0.0");
    });

    test("a clean non-final PATCH costs exactly one state read (no dialect pre-probe)", async () => {
        let reads = 0;
        const { store, uploads } = fakeStore();
        const spy: ResumableWriteStore = {
            ...store,
            getUploadState: (t, opts) => { reads++; return store.getUploadState(t, opts); },
        };
        const handler = createTusHandler(spy, {
            key: () => "server-key.bin",
            location: (tok) => `/files/${tok}`,
            now: () => NOW,
            graceMs: 0,
        });
        const token = await createUpload(handler, { "Upload-Length": "10" });
        reads = 0;
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4" },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-offset")).toBe("4");
        // The orchestrator's single locked pre-evaluation read is the whole
        // per-PATCH state cost: completion inference happens there, and the
        // clean write derives the response offset from its own return.
        expect(reads).toBe(1);
        expect(uploads.get(token)!.isComplete).toBe(false);
    });

    test("the final PATCH publishes the upload", async () => {
        const { handler, token, uploads } = await withUpload();
        await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "6" },
            body: bodyOf("abcdef"),
        }), { uploadToken: token });
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "6", "Content-Length": "4" },
            body: bodyOf("ghij"),
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-offset")).toBe("10");
        expect(uploads.get(token)!.isComplete).toBe(true);
    });

    test("a retried final PATCH is answered idempotently with 204", async () => {
        const { handler, token, uploads } = await withUpload({}, "4");
        await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4" },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(uploads.get(token)!.isComplete).toBe(true);
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "4", "Content-Length": "0" },
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-offset")).toBe("4");
    });

    test("a wrong Content-Type answers 415", async () => {
        const { handler, token } = await withUpload();
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": "application/json", "Upload-Offset": "0", "Content-Length": "2" },
            body: bodyOf("{}"),
        }), { uploadToken: token });
        expect(res.status).toBe(415);
    });

    test("a missing Content-Type answers 415", async () => {
        const { handler, token } = await withUpload();
        const req = tusRequest("PATCH", { headers: { "Upload-Offset": "0" } });
        req.headers.delete("content-type");
        expect((await handler(req, { uploadToken: token })).status).toBe(415);
    });

    test("a missing or malformed Upload-Offset answers 400", async () => {
        const { handler, token } = await withUpload();
        for (const headers of [
            { "Content-Type": OFFSET_TYPE },
            { "Content-Type": OFFSET_TYPE, "Upload-Offset": "abc" },
            { "Content-Type": OFFSET_TYPE, "Upload-Offset": "-1" },
            { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0x2" },
        ]) {
            const res = await handler(tusRequest("PATCH", { headers }), { uploadToken: token });
            expect(res.status).toBe(400);
            expect(await res.text()).toBe("missing or invalid Upload-Offset header");
        }
    });

    test("a malformed Content-Length answers 400", async () => {
        const { handler, token } = await withUpload();
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "0x4" },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(400);
        expect(await res.text()).toBe("invalid Content-Length header");
    });

    test("the content type is matched by essence: parameters and casing do not matter", async () => {
        const { handler, token } = await withUpload();
        const res = await handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": "Application/Offset+Octet-Stream ; part=1",
                "Upload-Offset": "0",
                "Content-Length": "4",
            },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-offset")).toBe("4");
    });

    test("a PATCH without a token answers 404 with a plain-text body", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0" },
        }));
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("upload not found");
    });

    test("a stale offset answers 409 without an offset header and without writing", async () => {
        const { handler, token, uploads } = await withUpload();
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "5", "Content-Length": "2" },
            body: bodyOf("xy"),
        }), { uploadToken: token });
        expect(res.status).toBe(409);
        expect(res.headers.get("upload-offset")).toBeNull();
        expect(uploads.get(token)!.bytes.byteLength).toBe(0);
    });

    test("an append crossing the maximum size answers 413", async () => {
        const { handler } = makeHandler({ maxSize: 4 });
        const token = await createUpload(handler, { "Upload-Defer-Length": "1" });
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "10" },
            body: bodyOf("0123456789"),
        }), { uploadToken: token });
        expect(res.status).toBe(413);
        expect(res.headers.get("tus-max-size")).toBe("4");
    });

    test("a contended resource answers 423", async () => {
        // Arm the lock timeout only after the setup creation has taken (and
        // released) the resource lock, so the 423 comes from the PATCH's
        // failed acquire, not from creation.
        let armed = false;
        const { handler, token } = await withUpload({
            locker: {
                acquire: async (uploadToken) => {
                    if (armed) throw new UploadLockTimeoutError(uploadToken);
                    return { release() { /* no-op setup lock */ } };
                },
            },
        });
        armed = true;
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "1" },
            body: bodyOf("x"),
        }), { uploadToken: token });
        expect(res.status).toBe(423);
    });

    test("an unknown upload answers 404", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "1" },
            body: bodyOf("x"),
        }), { uploadToken: "nope" });
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("upload not found");
    });

    test("a store failure answers a hardened 502 and reports to onError", async () => {
        const operations: string[] = [];
        const { handler } = makeHandler(
            { onError: (_e, ctx) => operations.push(ctx.operation) },
            { appendChunk: async () => { throw new Error("backend down"); } },
        );
        const token = await createUpload(handler, { "Upload-Length": "5" });
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "1" },
            body: bodyOf("x"),
        }), { uploadToken: token });
        expect(res.status).toBe(502);
        expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
        expect(operations).toContain("append");
        expect(await res.text()).toBe("storage backend error");
    });

    test("an interrupted PATCH answers 204 with the durable flushed offset", async () => {
        // The wire protocol has no status for a torn request body (the
        // connection is usually gone): the core protocol's guidance is to
        // keep as much transferred data as possible. The dialect maps the
        // interrupted append outcome to a normal 204 carrying the durable
        // offset, so a client that CAN still read the response resumes
        // without an extra HEAD, and one that cannot re-probes and sees the
        // same offset.
        const { handler, token, uploads } = await withUpload();
        const ctl = new AbortController();
        const body = controlledStream();
        const pending = handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0" },
            body: body.stream,
            signal: ctl.signal,
        }), { uploadToken: token });
        body.push("abc");
        await new Promise((r) => setTimeout(r, 5));
        ctl.abort();
        body.error(new Error("socket gone"));
        const res = await pending;
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-offset")).toBe("3");
        expect(uploads.get(token)!.isComplete).toBe(false);
    });

    test("an interrupted PATCH whose bytes all flushed still publishes the upload", async () => {
        // tus completion is implicit (offset reaches length). When the abort
        // lands after every declared byte flushed, the upload must still be
        // published; otherwise the client sees offset == length, stops, and
        // the object never becomes readable.
        const { handler, token, uploads } = await withUpload({}, "3");
        const ctl = new AbortController();
        const body = controlledStream();
        const pending = handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0" },
            body: body.stream,
            signal: ctl.signal,
        }), { uploadToken: token });
        body.push("abc");
        await new Promise((r) => setTimeout(r, 5));
        ctl.abort();
        body.error(new Error("socket gone"));
        const res = await pending;
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-offset")).toBe("3");
        expect(uploads.get(token)!.isComplete).toBe(true);
    });
});

// ─── Deferred length (extension: creation-defer-length) ─────────────────────

describe("creation-defer-length", () => {
    test("a PATCH carrying Upload-Length fixes the length and can complete", async () => {
        const { handler, uploads } = makeHandler();
        const token = await createUpload(handler, { "Upload-Defer-Length": "1" });
        const res = await handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": OFFSET_TYPE, "Upload-Offset": "0",
                "Upload-Length": "5", "Content-Length": "5",
            },
            body: bodyOf("hello"),
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-offset")).toBe("5");
        expect(uploads.get(token)!.isComplete).toBe(true);
    });

    test("changing an already-set length answers 400", async () => {
        const { handler, token } = await (async () => {
            const made = makeHandler();
            const token = await createUpload(made.handler, { "Upload-Length": "10" });
            return { ...made, token };
        })();
        const res = await handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": OFFSET_TYPE, "Upload-Offset": "0",
                "Upload-Length": "12", "Content-Length": "2",
            },
            body: bodyOf("ab"),
        }), { uploadToken: token });
        expect(res.status).toBe(400);
        expect(await res.text()).toBe("inconsistent upload length");
    });

    test("a partial PATCH on a deferred-length upload does not complete it", async () => {
        const { handler, uploads } = makeHandler();
        const token = await createUpload(handler, { "Upload-Defer-Length": "1" });
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4" },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(uploads.get(token)!.isComplete).toBe(false);
        const head = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(head.headers.get("upload-defer-length")).toBe("1");
    });

    test("a malformed Upload-Length on PATCH answers 400", async () => {
        const { handler } = makeHandler();
        const token = await createUpload(handler, { "Upload-Defer-Length": "1" });
        const res = await handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": OFFSET_TYPE, "Upload-Offset": "0",
                "Upload-Length": "five", "Content-Length": "2",
            },
            body: bodyOf("ab"),
        }), { uploadToken: token });
        expect(res.status).toBe(400);
        expect(await res.text()).toBe("invalid Upload-Length header");
    });
});

// ─── Termination (extension: termination) ────────────────────────────────────

describe("checksum extension", () => {
    async function sha1b64(text: string): Promise<string> {
        const digest = await crypto.subtle.digest("SHA-1", bodyOf(text));
        return Buffer.from(digest).toString("base64");
    }

    function checksumHandler(opts: Partial<TusHandlerOptions> = {}) {
        return makeHandler({ checksum: webCryptoChecksum(), maxAppendSize: 1024, ...opts });
    }

    test("OPTIONS advertises the extension and its algorithms", async () => {
        const { handler } = checksumHandler();
        const res = await handler(tusRequest("OPTIONS", { noVersion: true }));
        expect(res.headers.get("tus-extension")).toContain("checksum");
        expect(res.headers.get("tus-checksum-algorithm")).toBe("sha1,sha256,sha384,sha512");
    });

    test("OPTIONS without checksum config advertises neither", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("OPTIONS", { noVersion: true }));
        expect(res.headers.get("tus-extension")).not.toContain("checksum");
        expect(res.headers.get("tus-checksum-algorithm")).toBeNull();
    });

    test("a PATCH with a matching sha1 checksum appends normally", async () => {
        const { handler, uploads } = checksumHandler();
        const token = await createUpload(handler, { "Upload-Length": "4" });
        const res = await handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4",
                "Upload-Checksum": `sha1 ${await sha1b64("abcd")}`,
            },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-offset")).toBe("4");
        expect(uploads.get(token)!.isComplete).toBe(true);
    });

    test("a mismatch answers 460 and the chunk never reaches the store", async () => {
        const { handler, uploads } = checksumHandler();
        const token = await createUpload(handler, { "Upload-Length": "4" });
        const res = await handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4",
                "Upload-Checksum": `sha1 ${await sha1b64("NOT-abcd")}`,
            },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(460);
        expect(res.statusText).toBe("Checksum Mismatch");
        // Discarded means DISCARDED: durable state is untouched, the client's
        // next probe sees the pre-PATCH offset.
        expect(uploads.get(token)!.bytes.byteLength).toBe(0);
        expect(uploads.get(token)!.isComplete).toBe(false);
    });

    test("an unadvertised algorithm answers 400", async () => {
        const { handler } = checksumHandler();
        const token = await createUpload(handler, { "Upload-Length": "4" });
        const res = await handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4",
                "Upload-Checksum": "md5 1B2M2Y8AsgTpgAmY7PhCfg==",
            },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(400);
        expect(await res.text()).toBe("unsupported checksum algorithm");
    });

    test("malformed Upload-Checksum headers answer 400", async () => {
        const { handler } = checksumHandler();
        const token = await createUpload(handler, { "Upload-Length": "4" });
        for (const value of ["sha1", "sha1 ", " sha1", "sha1 not-base64!!", "sha1 ===="]) {
            const res = await handler(tusRequest("PATCH", {
                headers: {
                    "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4",
                    "Upload-Checksum": value,
                },
                body: bodyOf("abcd"),
            }), { uploadToken: token });
            expect(res.status).toBe(400);
            expect(await res.text()).toBe("invalid Upload-Checksum header");
        }
    });

    test("content over the verification buffer cap answers 413 before hashing", async () => {
        let digested = 0;
        const { handler, uploads } = checksumHandler({
            checksum: {
                algorithms: ["sha1"],
                maxBufferBytes: 3,
                digest: (_a, bytes) => { digested++; return bytes; },
            },
        });
        const token = await createUpload(handler, { "Upload-Length": "8" });
        const res = await handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "8",
                "Upload-Checksum": `sha1 ${await sha1b64("abcdefgh")}`,
            },
            body: bodyOf("abcdefgh"),
        }), { uploadToken: token });
        expect(res.status).toBe(413);
        expect(digested).toBe(0);
        expect(uploads.get(token)!.bytes.byteLength).toBe(0);
    });

    test("without checksum config an Upload-Checksum header is ignored, not enforced", async () => {
        // Mirrors the completion-digest posture: an assertion nothing can
        // verify is dropped, never answered as if the bytes were compared.
        const { handler, uploads } = makeHandler();
        const token = await createUpload(handler, { "Upload-Length": "4" });
        const res = await handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4",
                "Upload-Checksum": `sha1 ${await sha1b64("SOMETHING-ELSE")}`,
            },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(uploads.get(token)!.isComplete).toBe(true);
    });

    test("creation-with-upload content verifies too, mismatch included", async () => {
        const { handler, uploads } = checksumHandler();
        const good = await handler(tusRequest("POST", {
            headers: {
                "Upload-Length": "4", "Content-Type": OFFSET_TYPE, "Content-Length": "4",
                "Upload-Checksum": `sha1 ${await sha1b64("abcd")}`,
            },
            body: bodyOf("abcd"),
        }));
        expect(good.status).toBe(201);
        expect(good.headers.get("upload-offset")).toBe("4");

        const bad = await handler(tusRequest("POST", {
            headers: {
                "Upload-Length": "4", "Content-Type": OFFSET_TYPE, "Content-Length": "4",
                "Upload-Checksum": `sha1 ${await sha1b64("WRONG")}`,
            },
            body: bodyOf("abcd"),
        }));
        expect(bad.status).toBe(460);
        // Only the good creation produced a resource with bytes.
        const withBytes = [...uploads.values()].filter((u) => u.bytes.byteLength > 0);
        expect(withBytes).toHaveLength(1);
    });

    test("a torn body under a checksum answers 400 with durable state untouched", async () => {
        const { handler, uploads } = checksumHandler();
        const token = await createUpload(handler, { "Upload-Length": "8" });
        const body = controlledStream();
        const pending = handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": OFFSET_TYPE, "Upload-Offset": "0",
                "Upload-Checksum": `sha1 ${await sha1b64("abcdefgh")}`,
            },
            body: body.stream,
        }), { uploadToken: token });
        body.push("abcd");
        body.error(new Error("connection reset"));
        const res = await pending;
        expect(res.status).toBe(400);
        expect(uploads.get(token)!.bytes.byteLength).toBe(0);
    });

    test("construction refuses an unbounded verification buffer and empty algorithms", () => {
        const { store } = fakeStore();
        expect(() => createTusHandler(store, {
            key: () => "k", location: (t) => `/f/${t}`, checksum: webCryptoChecksum(),
        })).toThrow(TypeError);
        expect(() => createTusHandler(store, {
            key: () => "k", location: (t) => `/f/${t}`, maxAppendSize: 1024,
            checksum: { algorithms: [], digest: (_a, b) => b },
        })).toThrow(TypeError);
    });

    test("a throwing digest is a hardened 500 to onError, never a mismatch", async () => {
        const errors: string[] = [];
        const { handler, uploads } = checksumHandler({
            checksum: {
                algorithms: ["sha1"],
                maxBufferBytes: 64,
                digest: () => { throw new Error("hasher exploded"); },
            },
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const token = await createUpload(handler, { "Upload-Length": "4" });
        const res = await handler(tusRequest("PATCH", {
            headers: {
                "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4",
                "Upload-Checksum": `sha1 ${await sha1b64("abcd")}`,
            },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(500);
        expect(errors).toEqual(["handler"]);
        expect(uploads.get(token)!.bytes.byteLength).toBe(0);
    });
});

describe("termination", () => {
    test("DELETE answers 204 and the resource then answers 404", async () => {
        const { handler } = makeHandler();
        const token = await createUpload(handler, { "Upload-Length": "5" });
        const res = await handler(tusRequest("DELETE"), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("tus-resumable")).toBe("1.0.0");
        expect((await handler(tusRequest("HEAD"), { uploadToken: token })).status).toBe(404);
    });

    test("DELETE on an unknown upload answers 404", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("DELETE"), { uploadToken: "nope" });
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("upload not found");
    });
});

// ─── Expiration (extension: expiration) ──────────────────────────────────────

describe("expiration", () => {
    const MAX_AGE = 3600;
    const EXPECTED = new Date(NOW + MAX_AGE * 1000).toUTCString();
    const IMF_RE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

    test("creation, HEAD, and PATCH carry Upload-Expires in IMF-fixdate format", async () => {
        const { handler } = makeHandler({ maxAgeSeconds: MAX_AGE });
        const createRes = await handler(tusRequest("POST", { headers: { "Upload-Length": "10" } }));
        expect(createRes.headers.get("upload-expires")).toBe(EXPECTED);
        expect(createRes.headers.get("upload-expires")).toMatch(IMF_RE);
        const token = locationToken(createRes);

        const headRes = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(headRes.headers.get("upload-expires")).toBe(EXPECTED);

        const patchRes = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4" },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(patchRes.status).toBe(204);
        expect(patchRes.headers.get("upload-expires")).toBe(EXPECTED);
    });

    test("a completed upload carries no Upload-Expires", async () => {
        const { handler } = makeHandler({ maxAgeSeconds: MAX_AGE });
        const token = await createUpload(handler, { "Upload-Length": "4" });
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4" },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-expires")).toBeNull();
    });

    test("no Upload-Expires anywhere when no max age is configured", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("POST", { headers: { "Upload-Length": "10" } }));
        expect(res.headers.get("upload-expires")).toBeNull();
        const token = locationToken(res);
        const head = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(head.headers.get("upload-expires")).toBeNull();
        const patch = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4" },
            body: bodyOf("abcd"),
        }), { uploadToken: token });
        expect(patch.headers.get("upload-expires")).toBeNull();
    });

    test("a completed upload's HEAD carries no Upload-Expires", async () => {
        const { handler } = makeHandler({ maxAgeSeconds: MAX_AGE });
        const token = await createUpload(handler, { "Upload-Length": "0" });
        const head = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(head.status).toBe(200);
        expect(head.headers.get("upload-expires")).toBeNull();
    });

    test("the object policy form drives Upload-Expires too", async () => {
        const { handler } = makeHandler({ policy: { maxAgeSeconds: MAX_AGE } });
        const res = await handler(tusRequest("POST", { headers: { "Upload-Length": "10" } }));
        expect(res.headers.get("upload-expires")).toBe(EXPECTED);
    });

    test("an expired upload answers 410", async () => {
        let clock = NOW;
        const { handler } = makeHandler({ maxAgeSeconds: MAX_AGE, now: () => clock });
        const token = await createUpload(handler, { "Upload-Length": "10" });
        clock = NOW + (MAX_AGE + 1) * 1000;
        const head = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(head.status).toBe(410);
        expect(await head.text()).toBe(""); // HEAD is bodyless, errors included
        const patch = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "1" },
            body: bodyOf("x"),
        }), { uploadToken: token });
        expect(patch.status).toBe(410);
    });
});

// ─── Routing, override, hardening, hooks ─────────────────────────────────────

describe("routing and hardening", () => {
    test("X-HTTP-Method-Override on POST routes as the overridden method", async () => {
        const { handler } = makeHandler();
        const token = await createUpload(handler, { "Upload-Length": "5" });
        // Override to DELETE terminates instead of creating.
        const res = await handler(tusRequest("POST", {
            headers: { "X-HTTP-Method-Override": "DELETE" },
        }), { uploadToken: token });
        expect(res.status).toBe(204);
        expect((await handler(tusRequest("HEAD"), { uploadToken: token })).status).toBe(404);
    });

    test("an overridden PATCH still enforces the PATCH content type", async () => {
        const { handler } = makeHandler();
        const token = await createUpload(handler, { "Upload-Length": "5" });
        const res = await handler(tusRequest("POST", {
            headers: { "X-HTTP-Method-Override": "patch", "Upload-Offset": "0" },
        }), { uploadToken: token });
        expect(res.status).toBe(415);
    });

    test("an unsupported method answers 405 with Allow", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("GET"));
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST, HEAD, PATCH, DELETE, OPTIONS");
    });

    test("error responses carry a truthful Content-Length and plain-text body", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("HEAD", { noVersion: true, headers: { "Tus-Resumable": "0.1" } }));
        // HEAD errors are bodyless; the version gate knows the method.
        expect(res.status).toBe(412);
        expect(res.headers.get("content-length")).toBe("0");
        const res2 = await handler(tusRequest("DELETE"), { uploadToken: "nope" });
        expect(res2.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(res2.headers.get("content-length")).toBe(String((await res2.text()).length));
    });

    test("extraHeaders ride every response but never override protocol headers", async () => {
        const { handler } = makeHandler({
            extraHeaders: { "X-Trace": "abc", "Tus-Resumable": "9.9.9" },
        });
        const options = await handler(tusRequest("OPTIONS", { noVersion: true }));
        expect(options.headers.get("x-trace")).toBe("abc");
        expect(options.headers.get("tus-resumable")).toBe("1.0.0");
        const notFound = await handler(tusRequest("HEAD"), { uploadToken: "nope" });
        expect(notFound.headers.get("x-trace")).toBe("abc");
        expect(notFound.headers.get("tus-resumable")).toBe("1.0.0");
    });

    test("auditKey substitution reaches upload events for resource requests", async () => {
        const events: UploadResourceEvent[] = [];
        const { handler } = makeHandler({
            auditKey: (token) => `audit-${token}`,
            onUploadEvent: (e) => events.push(e),
        });
        const token = await createUpload(handler, { "Upload-Length": "4" });
        await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "2" },
            body: bodyOf("ab"),
        }), { uploadToken: token });
        const appendEvents = events.filter((e) => e.event.kind === "append-accepted");
        expect(appendEvents.length).toBeGreaterThan(0);
        expect(appendEvents.every((e) => e.auditKey === `audit-${token}`)).toBe(true);
    });

    test("a throwing key callback becomes a hardened 500, never an escaped throw", async () => {
        const errors: string[] = [];
        const { handler } = makeHandler({
            key: () => { throw new Error("caller bug"); },
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const res = await handler(tusRequest("POST", { headers: { "Upload-Length": "5" } }));
        expect(res.status).toBe(500);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(errors).toEqual(["handler"]);
    });

    test("the Location value is sanitized before it becomes a header", async () => {
        const { handler } = makeHandler({
            location: (token) => `/files/${token}\r\nX-Evil: 1`,
        });
        const res = await handler(tusRequest("POST", { headers: { "Upload-Length": "5" } }));
        expect(res.status).toBe(201);
        expect(res.headers.get("x-evil")).toBeNull();
        expect(res.headers.get("location")).not.toContain("\r");
    });
});

// ─── Policy bounds (flat fields and the policy object form) ─────────────────

describe("policy bounds", () => {
    test("flat minSize rejects a too-small declared upload with 400", async () => {
        const { handler } = makeHandler({ minSize: 5 });
        const res = await handler(tusRequest("POST", { headers: { "Upload-Length": "1" } }));
        expect(res.status).toBe(400);
        expect(await res.text()).toBe("upload violates a size policy");
    });

    test("object-form minSize is enforced identically", async () => {
        const { handler } = makeHandler({ policy: { minSize: 5 } });
        const res = await handler(tusRequest("POST", { headers: { "Upload-Length": "1" } }));
        expect(res.status).toBe(400);
    });

    test("flat maxAppendSize rejects an oversized append with 413 and no Tus-Max-Size", async () => {
        const { handler } = makeHandler({ maxAppendSize: 2 });
        const token = await createUpload(handler, { "Upload-Length": "10" });
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "3" },
            body: bodyOf("abc"),
        }), { uploadToken: token });
        expect(res.status).toBe(413);
        // No maximum SIZE is configured, so no Tus-Max-Size rides the 413.
        expect(res.headers.get("tus-max-size")).toBeNull();
    });

    test("object-form maxAppendSize is enforced identically", async () => {
        const { handler } = makeHandler({ policy: { maxAppendSize: 2 } });
        const token = await createUpload(handler, { "Upload-Length": "10" });
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "3" },
            body: bodyOf("abc"),
        }), { uploadToken: token });
        expect(res.status).toBe(413);
    });

    test("minAppendSize rejects a small non-final append but exempts the completing one", async () => {
        const { handler, uploads } = makeHandler({ minAppendSize: 6 });
        const token = await createUpload(handler, { "Upload-Length": "10" });
        const small = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "2" },
            body: bodyOf("ab"),
        }), { uploadToken: token });
        expect(small.status).toBe(400);
        expect(await small.text()).toBe("upload violates a size policy");

        // The completing tail is however small it is (spec exemption): a
        // 4-byte upload completes in one small PATCH despite the floor.
        const tokenSmallFile = await createUpload(handler, { "Upload-Length": "4" });
        const tail = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "4" },
            body: bodyOf("abcd"),
        }), { uploadToken: tokenSmallFile });
        expect(tail.status).toBe(204);
        expect(uploads.get(tokenSmallFile)!.isComplete).toBe(true);
    });

    test("object-form minAppendSize is enforced identically", async () => {
        const { handler } = makeHandler({ policy: { minAppendSize: 6 } });
        const token = await createUpload(handler, { "Upload-Length": "10" });
        const res = await handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0", "Content-Length": "2" },
            body: bodyOf("ab"),
        }), { uploadToken: token });
        expect(res.status).toBe(400);
    });

    test("a small completing creation-with-upload is exempt from minAppendSize", async () => {
        const { handler, uploads } = makeHandler({ minAppendSize: 6 });
        const res = await handler(tusRequest("POST", {
            headers: { "Upload-Length": "4", "Content-Type": OFFSET_TYPE, "Content-Length": "4" },
            body: bodyOf("abcd"),
        }));
        expect(res.status).toBe(201);
        expect(uploads.get("u1")!.isComplete).toBe(true);
    });
});

// ─── HEAD error shapes (bodyless, hardened) ──────────────────────────────────

describe("HEAD error shapes", () => {
    test("a contended HEAD answers a bodyless 423", async () => {
        // Arm the timeout after the setup creation so the 423 is the HEAD's
        // failed acquire, not creation's (which now takes the lock too).
        let armed = false;
        const { handler } = makeHandler({
            locker: {
                acquire: async (uploadToken) => {
                    if (armed) throw new UploadLockTimeoutError(uploadToken);
                    return { release() { /* no-op setup lock */ } };
                },
            },
        });
        const token = await createUpload(handler, { "Upload-Length": "5" });
        armed = true;
        const res = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(res.status).toBe(423);
        expect(await res.text()).toBe("");
        expect(res.headers.get("cache-control")).toBe("no-store");
    });

    test("a store failure on HEAD answers a bodyless 502", async () => {
        const { handler } = makeHandler({}, {
            getUploadState: async () => { throw new Error("backend down"); },
        });
        const res = await handler(tusRequest("HEAD"), { uploadToken: "u1" });
        expect(res.status).toBe(502);
        expect(await res.text()).toBe("");
    });

    test("a HEAD without a token answers a bodyless 404", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("HEAD"));
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("");
    });
});

// ─── Implicit-completion healing ─────────────────────────────────────────────

describe("implicit-completion healing", () => {
    test("an interrupted creation-with-upload whose bytes all flushed still publishes", async () => {
        const { handler, uploads } = makeHandler();
        const ctl = new AbortController();
        const body = controlledStream();
        const pending = handler(tusRequest("POST", {
            headers: { "Upload-Length": "3", "Content-Type": OFFSET_TYPE },
            body: body.stream,
            signal: ctl.signal,
        }));
        body.push("abc");
        await new Promise((r) => setTimeout(r, 5));
        ctl.abort();
        body.error(new Error("socket gone"));
        const res = await pending;
        expect(res.status).toBe(201);
        expect(res.headers.get("upload-offset")).toBe("3");
        expect(uploads.get("u1")!.isComplete).toBe(true);
    });

    test("a healed creation with a max age carries no Upload-Expires (it is complete)", async () => {
        const { handler } = makeHandler({ maxAgeSeconds: 3600 });
        const ctl = new AbortController();
        const body = controlledStream();
        const pending = handler(tusRequest("POST", {
            headers: { "Upload-Length": "3", "Content-Type": OFFSET_TYPE },
            body: body.stream,
            signal: ctl.signal,
        }));
        body.push("abc");
        await new Promise((r) => setTimeout(r, 5));
        ctl.abort();
        body.error(new Error("socket gone"));
        const res = await pending;
        expect(res.status).toBe(201);
        expect(res.headers.get("upload-expires")).toBeNull();
    });

    test("a healed PATCH with a max age carries no Upload-Expires (it is complete)", async () => {
        const { handler } = makeHandler({ maxAgeSeconds: 3600 });
        const token = await createUpload(handler, { "Upload-Length": "3" });
        const ctl = new AbortController();
        const body = controlledStream();
        const pending = handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0" },
            body: body.stream,
            signal: ctl.signal,
        }), { uploadToken: token });
        body.push("abc");
        await new Promise((r) => setTimeout(r, 5));
        ctl.abort();
        body.error(new Error("socket gone"));
        const res = await pending;
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-expires")).toBeNull();
    });

    test("a failing publish during PATCH healing surfaces as a 502, never a false success", async () => {
        const { handler } = makeHandler({}, {
            completeUpload: async () => { throw new Error("publish failed"); },
        });
        const token = await createUpload(handler, { "Upload-Length": "3" });
        const ctl = new AbortController();
        const body = controlledStream();
        const pending = handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0" },
            body: body.stream,
            signal: ctl.signal,
        }), { uploadToken: token });
        body.push("abc");
        await new Promise((r) => setTimeout(r, 5));
        ctl.abort();
        body.error(new Error("socket gone"));
        const res = await pending;
        expect(res.status).toBe(502);
        expect(await res.text()).toBe("storage backend error");
    });

    test("a failing publish during creation healing surfaces as a 502", async () => {
        const { handler } = makeHandler({}, {
            completeUpload: async () => { throw new Error("publish failed"); },
        });
        const ctl = new AbortController();
        const body = controlledStream();
        const pending = handler(tusRequest("POST", {
            headers: { "Upload-Length": "3", "Content-Type": OFFSET_TYPE },
            body: body.stream,
            signal: ctl.signal,
        }));
        body.push("abc");
        await new Promise((r) => setTimeout(r, 5));
        ctl.abort();
        body.error(new Error("socket gone"));
        const res = await pending;
        expect(res.status).toBe(502);
        expect(await res.text()).toBe("storage backend error");
    });
});

// ─── Audit hooks on resource requests ────────────────────────────────────────

describe("audit hooks", () => {
    test("expiry events from probes carry the auditKey", async () => {
        let clock = NOW;
        const events: UploadResourceEvent[] = [];
        const { handler } = makeHandler({
            maxAgeSeconds: 60,
            now: () => clock,
            auditKey: (token) => `audit-${token}`,
            onUploadEvent: (e) => events.push(e),
        });
        const token = await createUpload(handler, { "Upload-Length": "5" });
        clock = NOW + 61_000;
        await handler(tusRequest("HEAD"), { uploadToken: token });
        const expired = events.filter((e) => e.event.kind === "expired");
        expect(expired.length).toBeGreaterThan(0);
        expect(expired[0]!.auditKey).toBe(`audit-${token}`);
    });

    test("cancellation events carry the auditKey", async () => {
        const events: UploadResourceEvent[] = [];
        const { handler } = makeHandler({
            auditKey: (token) => `audit-${token}`,
            onUploadEvent: (e) => events.push(e),
        });
        const token = await createUpload(handler, { "Upload-Length": "5" });
        await handler(tusRequest("DELETE"), { uploadToken: token });
        const cancelled = events.filter((e) => e.event.kind === "cancelled");
        expect(cancelled.length).toBe(1);
        expect(cancelled[0]!.auditKey).toBe(`audit-${token}`);
    });
});

// ─── Override and never-throw edges ──────────────────────────────────────────

describe("override and never-throw edges", () => {
    test("X-HTTP-Method-Override is ignored on non-POST methods", async () => {
        const { handler } = makeHandler();
        const token = await createUpload(handler, { "Upload-Length": "5" });
        const res = await handler(tusRequest("HEAD", {
            headers: { "X-HTTP-Method-Override": "DELETE" },
        }), { uploadToken: token });
        // Still a HEAD: the resource must survive.
        expect(res.status).toBe(200);
        expect((await handler(tusRequest("HEAD"), { uploadToken: token })).status).toBe(200);
    });

    test("an empty override header leaves POST a creation", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("POST", {
            headers: { "X-HTTP-Method-Override": "", "Upload-Length": "5" },
        }));
        expect(res.status).toBe(201);
    });

    test("a creation-with-upload POST with an empty body reports no offset", async () => {
        const { handler } = makeHandler();
        const res = await handler(tusRequest("POST", {
            headers: { "Upload-Length": "10", "Content-Type": OFFSET_TYPE },
        }));
        expect(res.status).toBe(201);
        // No body means no content was applied: no Upload-Offset header.
        expect(res.headers.get("upload-offset")).toBeNull();
    });

    test("a throwing callback without onError configured still answers 500", async () => {
        const { handler } = makeHandler({
            key: () => { throw new Error("caller bug"); },
        });
        const res = await handler(tusRequest("POST", { headers: { "Upload-Length": "5" } }));
        expect(res.status).toBe(500);
        expect(await res.text()).toBe("internal error");
    });
});

// ─── HEAD implicit-completion healing (audit R534) ──────────────────────────
// A completing request whose bytes went durable but whose handler died before
// completion leaves the resource at offset === length, unpublished. A tus
// client seeing offset == length concludes "done" and stops, so the HEAD that
// would otherwise mislead it must publish the assembled object instead.

describe("HEAD implicit-completion healing", () => {
    /** Force the crash-window state: durable offset === length, not completed. */
    function crashWindow(uploads: Map<string, FakeUpload>, token: string, size: number) {
        const rec = uploads.get(token)!;
        rec.bytes = new Uint8Array(size);
        rec.length = size;
        rec.isComplete = false;
    }

    test("HEAD publishes an upload stuck at offset === length and reports it complete", async () => {
        const { handler, uploads } = makeHandler();
        const token = await createUpload(handler, { "Upload-Length": "3" });
        crashWindow(uploads, token, 3);
        const res = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(res.status).toBe(200);
        expect(res.headers.get("upload-offset")).toBe("3");
        expect(res.headers.get("upload-length")).toBe("3");
        // The healing publish ran on the very probe that would have misled the client.
        expect(uploads.get(token)!.isComplete).toBe(true);
    });

    test("a healed HEAD with a max age drops Upload-Expires (the upload is now complete)", async () => {
        const { handler, uploads } = makeHandler({ maxAgeSeconds: 3600 });
        const token = await createUpload(handler, { "Upload-Length": "3" });
        crashWindow(uploads, token, 3);
        const res = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(res.status).toBe(200);
        // Healed to complete: a completed upload no longer expires.
        expect(res.headers.get("upload-expires")).toBeNull();
        expect(uploads.get(token)!.isComplete).toBe(true);
    });

    test("HEAD does NOT heal an upload still short of its length", async () => {
        // offset < length: genuinely incomplete. The heal must not fire, and with
        // a max age Upload-Expires still rides the HEAD.
        const { handler, uploads } = makeHandler({ maxAgeSeconds: 3600 });
        const token = await createUpload(handler, { "Upload-Length": "10" });
        const rec = uploads.get(token)!;
        rec.bytes = new Uint8Array(4);
        rec.length = 10;
        rec.isComplete = false;
        const res = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(res.status).toBe(200);
        expect(res.headers.get("upload-offset")).toBe("4");
        expect(res.headers.get("upload-expires")).not.toBeNull();
        expect(uploads.get(token)!.isComplete).toBe(false);
    });
});

// ─── Completeness derivation on creation and append (audit R534) ────────────

describe("completeness derivation", () => {
    test("a deferred-length creation-with-upload of unknown size stays incomplete", async () => {
        // Upload-Defer-Length + a chunked body (no Content-Length): the total is
        // unknown, so the creation must NOT be marked complete (there is no length
        // to reach yet), and no heal applies while the length is deferred.
        const { handler, uploads } = makeHandler();
        const body = controlledStream();
        const pending = handler(tusRequest("POST", {
            headers: { "Upload-Defer-Length": "1", "Content-Type": OFFSET_TYPE },
            body: body.stream,
        }));
        body.push("abc");
        body.close();
        const res = await pending;
        expect(res.status).toBe(201);
        const token = locationToken(res);
        expect(uploads.get(token)!.isComplete).toBe(false);
        const head = await handler(tusRequest("HEAD"), { uploadToken: token });
        expect(head.headers.get("upload-defer-length")).toBe("1");
    });

    test("a chunked PATCH on a deferred-length upload (no Content-Length) does not complete it", async () => {
        // No known length and no Content-Length: the total is still unknown, so a
        // body-bearing PATCH advances the offset but cannot complete the upload.
        const { handler, uploads } = makeHandler();
        const token = await createUpload(handler, { "Upload-Defer-Length": "1" });
        const body = controlledStream();
        const pending = handler(tusRequest("PATCH", {
            headers: { "Content-Type": OFFSET_TYPE, "Upload-Offset": "0" },
            body: body.stream,
        }), { uploadToken: token });
        body.push("abc");
        body.close();
        const res = await pending;
        expect(res.status).toBe(204);
        expect(res.headers.get("upload-offset")).toBe("3");
        expect(uploads.get(token)!.isComplete).toBe(false);
    });
});
