/**
 * Completion-time integrity speaks more than SHA-256: a client may assert any
 * RFC 9530 algorithm the store verifies, keyed by its registered name, and a
 * mismatch names the algorithm that disagreed. Memory and fs verify sha-256
 * and sha-512.
 */
import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryUploadStore } from "../memory.ts";
import { fsUploadStore } from "../fs.ts";
import { createUploadHandler } from "../upload.ts";
import { isUploadDigestMismatchError, type ResumableWriteStore } from "../upload-shared.ts";

const enc = new TextEncoder();

async function b64(algorithm: "SHA-256" | "SHA-512", text: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest(algorithm, enc.encode(text)));
    return btoa(String.fromCharCode(...digest));
}

async function verifiesBoth(store: ResumableWriteStore) {
    expect(store.digestOnComplete).toEqual(["sha-256", "sha-512"]);
    const ok = await store.createUpload({ key: "ok.bin", now: 1 });
    await store.appendChunk(ok.uploadToken, 0, enc.encode("payload"), { now: 2 });
    const done = await store.completeUpload(ok.uploadToken, {
        expectedDigests: { "sha-512": await b64("SHA-512", "payload"), "sha-256": await b64("SHA-256", "payload") },
        expectedLength: 7,
        now: 3,
    });
    expect(done.digest).toBe(await b64("SHA-256", "payload"));

    const bad = await store.createUpload({ key: "bad.bin", now: 1 });
    await store.appendChunk(bad.uploadToken, 0, enc.encode("payload"), { now: 2 });
    const wrong = await b64("SHA-512", "other");
    const err = await store
        .completeUpload(bad.uploadToken, { expectedDigests: { "sha-512": wrong }, expectedLength: 7, now: 3 })
        .then(
            () => undefined,
            (e: unknown) => e,
        );
    expect(isUploadDigestMismatchError(err)).toBe(true);
    if (!isUploadDigestMismatchError(err)) return;
    expect(err.algorithm).toBe("sha-512");
    expect(err.expectedDigest).toBe(wrong);
    expect((await store.getUploadState(bad.uploadToken)).status).toBe("incomplete");
}

describe("digest algorithms at completion", () => {
    test("memory verifies sha-256 and sha-512", async () => {
        await verifiesBoth(memoryUploadStore({ objects: {} }));
    });

    test("fs verifies sha-256 and sha-512", async () => {
        const root = await mkdtemp(join(tmpdir(), "pc-digest-"));
        try {
            await verifiesBoth(fsUploadStore({ root }));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("IETF: a Repr-Digest sha-512 assertion is enforced", async () => {
        const handler = createUploadHandler(memoryUploadStore({ objects: {} }), {
            key: () => "k",
            location: (t) => `/u/${t}`,
            policy: { maxSize: 1024 },
        });
        const create = async (digest: string) =>
            handler(
                new Request("http://test/u", {
                    method: "POST",
                    headers: {
                        "Upload-Draft-Interop-Version": "9",
                        "Upload-Complete": "?1",
                        "Repr-Digest": `sha-512=:${digest}:`,
                    },
                    body: "payload",
                }),
            );
        expect((await create(await b64("SHA-512", "other"))).status).toBe(400);
        expect((await create(await b64("SHA-512", "payload"))).status).toBe(201);
        // Padding is optional on the wire: an unpadded byte sequence verifies too.
        expect((await create((await b64("SHA-512", "payload")).replace(/=+$/, ""))).status).toBe(201);
        // A byte sequence whose length is not the algorithm's is not an assertion.
        expect((await create(await b64("SHA-256", "other"))).status).toBe(201);
    });
});
