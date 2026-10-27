/**
 * `digestPolicy` decides what a request does with a digest assertion (RFC 9530
 * `Repr-Digest`) in an algorithm the store cannot verify: dropped under the
 * default "advisory", refused before anything is allocated under
 * "require-verifiable".
 */
import { describe, test, expect } from "bun:test";
import { memoryUploadStore } from "../memory.ts";
import { createUploadHandler } from "../upload.ts";
import { createTusHandler } from "../tus.ts";
import {
    UploadDigestUnverifiableError,
    createUploadOrchestrator,
    isUploadDigestUnverifiableError,
    type ResumableWriteStore,
    type UploadAuditEvent,
    type UploadPolicy,
} from "../upload-shared.ts";

const enc = new TextEncoder();

async function b64(algorithm: "SHA-256" | "SHA-512", text: string): Promise<string> {
    return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest(algorithm, enc.encode(text)))));
}

/** A memory store reporting `verifies`, counting every allocation and write. */
function spiedStore(verifies: ResumableWriteStore["digestOnComplete"]) {
    const base = memoryUploadStore({ objects: {} });
    const calls = { createUpload: 0, appendChunk: 0 };
    const store: ResumableWriteStore = {
        ...base,
        digestOnComplete: verifies,
        createUpload: (opts) => {
            calls.createUpload++;
            return base.createUpload(opts);
        },
        appendChunk: (token, offset, body, opts) => {
            calls.appendChunk++;
            return base.appendChunk(token, offset, body, opts);
        },
    };
    return { store, calls };
}

function harness(verifies: ResumableWriteStore["digestOnComplete"], policy: Partial<UploadPolicy> = {}) {
    const { store, calls } = spiedStore(verifies);
    const events: UploadAuditEvent[] = [];
    const orch = createUploadOrchestrator(store, {
        now: () => 1_000,
        graceMs: 0,
        policy: { maxSize: 1024, ...policy },
        onUploadEvent: (e) => events.push(e.event),
    });
    return { orch, calls, events };
}

const REQUIRE = { digestPolicy: "require-verifiable" } as const;

describe("digestPolicy at the orchestrator", () => {
    test("advisory (the default) drops an unverifiable assertion and publishes", async () => {
        for (const policy of [{}, { digestPolicy: "advisory" as const }]) {
            const { orch } = harness(false, policy);
            const out = await orch.create({
                key: () => "k",
                complete: true,
                body: enc.encode("payload"),
                expectedDigests: { "sha-256": await b64("SHA-256", "other") },
            });
            expect(out).toMatchObject({ kind: "created", complete: true });
        }
    });

    test("require-verifiable refuses a creation before anything is allocated or written", async () => {
        const { orch, calls, events } = harness(false, REQUIRE);
        const out = await orch.create({
            key: () => "k",
            complete: true,
            body: enc.encode("payload"),
            expectedDigests: { "sha-256": await b64("SHA-256", "payload") },
        });
        expect(out).toEqual({ kind: "digest-unverifiable" });
        expect(calls).toEqual({ createUpload: 0, appendChunk: 0 });
        expect(events).toEqual([{ kind: "append-rejected", reason: "digest-unverifiable" }]);
    });

    test("require-verifiable refuses an append before any byte is written", async () => {
        const { orch, calls, events } = harness(false, REQUIRE);
        const created = await orch.create({ key: () => "k", complete: false });
        if (created.kind !== "created") throw new Error(created.kind);
        const out = await orch.append(created.uploadToken, {
            offset: 0,
            complete: true,
            body: enc.encode("payload"),
            expectedDigests: { "sha-512": await b64("SHA-512", "payload") },
        });
        expect(out).toEqual({ kind: "digest-unverifiable" });
        expect(calls.appendChunk).toBe(0);
        expect(events.at(-1)).toEqual({ kind: "append-rejected", reason: "digest-unverifiable" });
    });

    test("require-verifiable leaves a request that asserts nothing alone", async () => {
        const { orch } = harness(false, REQUIRE);
        const out = await orch.create({ key: () => "k", complete: true, body: enc.encode("payload") });
        expect(out).toMatchObject({ kind: "created", complete: true });
    });

    test("a mixed assertion keeps the verifiable member and proceeds", async () => {
        const { orch } = harness(["sha-256"], REQUIRE);
        const out = await orch.create({
            key: () => "k",
            complete: true,
            body: enc.encode("payload"),
            expectedDigests: { "sha-256": await b64("SHA-256", "payload"), "sha-512": await b64("SHA-512", "x") },
        });
        expect(out).toMatchObject({ kind: "created", complete: true });
    });

    test("a store that verifies sha-256 still verifies it under require-verifiable", async () => {
        const { orch } = harness(["sha-256"], REQUIRE);
        const bad = await orch.create({
            key: () => "k",
            complete: true,
            body: enc.encode("payload"),
            expectedDigests: { "sha-256": await b64("SHA-256", "other") },
        });
        expect(bad.kind).toBe("digest-mismatch");
        const good = await orch.create({
            key: () => "k",
            complete: true,
            body: enc.encode("payload"),
            expectedDigests: { "sha-256": await b64("SHA-256", "payload") },
        });
        expect(good).toMatchObject({ kind: "created", complete: true });
    });

    test("an unknown digestPolicy is a TypeError at construction", () => {
        const { store } = spiedStore(false);
        expect(() =>
            createUploadOrchestrator(store, { policy: { digestPolicy: "strict" as UploadPolicy["digestPolicy"] } }),
        ).toThrow(/digestPolicy/);
    });
});

describe("digestPolicy error class", () => {
    test("carries a stable code and a guard", () => {
        const err: unknown = new UploadDigestUnverifiableError();
        expect(isUploadDigestUnverifiableError(err) && err.code).toBe("UPLOAD_DIGEST_UNVERIFIABLE");
        expect(isUploadDigestUnverifiableError(new Error("x"))).toBe(false);
    });
});

describe("digestPolicy at the IETF handler", () => {
    const send = async (handler: ReturnType<typeof createUploadHandler>, digest: string) =>
        handler(
            new Request("http://test/u", {
                method: "POST",
                headers: {
                    "Upload-Draft-Interop-Version": "9",
                    "Upload-Complete": "?1",
                    "Repr-Digest": `sha-256=:${digest}:`,
                },
                body: "payload",
            }),
        );
    const handlerFor = (policy: Partial<UploadPolicy>) => {
        const { store, calls } = spiedStore(false);
        const handler = createUploadHandler(store, {
            key: () => "k",
            location: (t) => `/u/${t}`,
            policy: { maxSize: 1024, ...policy },
        });
        return { handler, calls };
    };

    test("advisory publishes despite an unverifiable assertion", async () => {
        const { handler } = handlerFor({});
        expect((await send(handler, await b64("SHA-256", "other"))).status).toBe(201);
    });

    test("require-verifiable answers 400 and touches no store", async () => {
        const { handler, calls } = handlerFor(REQUIRE);
        const res = await send(handler, await b64("SHA-256", "payload"));
        expect(res.status).toBe(400);
        expect(calls).toEqual({ createUpload: 0, appendChunk: 0 });
    });

    test("a per-request policy resolver chooses per tenant", async () => {
        const { store } = spiedStore(false);
        const handler = createUploadHandler(store, {
            key: () => "k",
            location: (t) => `/u/${t}`,
            policy: (req) => ({
                maxSize: 1024,
                ...(req.headers.get("x-tenant") === "strict" ? REQUIRE : {}),
            }),
        });
        const digest = await b64("SHA-256", "payload");
        const post = (tenant: string) =>
            handler(
                new Request("http://test/u", {
                    method: "POST",
                    headers: {
                        "Upload-Draft-Interop-Version": "9",
                        "Upload-Complete": "?1",
                        "Repr-Digest": `sha-256=:${digest}:`,
                        "x-tenant": tenant,
                    },
                    body: "payload",
                }),
            );
        expect((await post("strict")).status).toBe(400);
        expect((await post("lax")).status).toBe(201);
    });
});

describe("digestPolicy at the tus handler", () => {
    test("tus verifies Upload-Checksum itself, so the policy is refused at construction", async () => {
        const { store } = spiedStore(false);
        expect(() =>
            createTusHandler(store, {
                key: () => "k",
                location: (t) => `/u/${t}`,
                policy: { maxSize: 1024, ...REQUIRE },
            }),
        ).toThrow(/digestPolicy/);
    });
});
