/**
 * The store contract's fencing seam is additive: a store that implements
 * `claimUpload` is asked for a claim under the lock before the orchestrator
 * writes, and every write made under that claim carries its `epoch`; a store
 * without it is called exactly as before, with no epoch anywhere. A claim is
 * taken only for a request that is about to write, never for a probe or a
 * refused append, and a claim that fails is answered like any store failure.
 */
import { describe, test, expect } from "bun:test";
import { createUploadOrchestrator } from "../upload-orchestrator.ts";
import { memoryUploadStore } from "../memory.ts";
import { UploadOffsetConflictError, type ResumableWriteStore } from "../upload-store.ts";

interface Seen {
    claims: string[];
    epochs: Array<[string, number | undefined]>;
}

function recording(withClaim: boolean, claimFails = false): { store: ResumableWriteStore; seen: Seen } {
    const inner = memoryUploadStore({ objects: {} });
    const seen: Seen = { claims: [], epochs: [] };
    let epoch = 0;
    const store: ResumableWriteStore = {
        ...inner,
        appendChunk: (token, offset, body, opts) => {
            seen.epochs.push(["append", opts.epoch]);
            return inner.appendChunk(token, offset, body, opts);
        },
        completeUpload: (token, opts) => {
            seen.epochs.push(["complete", opts.epoch]);
            return inner.completeUpload(token, opts);
        },
        abortUpload: (token, opts) => {
            seen.epochs.push(["abort", opts?.epoch]);
            return inner.abortUpload(token, opts);
        },
        ...(withClaim && {
            claimUpload: async (token: string) => {
                seen.claims.push(token);
                if (claimFails) throw new Error("claim backend down");
                return { epoch: ++epoch };
            },
        }),
    };
    return { store, seen };
}

async function created(store: ResumableWriteStore) {
    const orch = createUploadOrchestrator(store, { graceMs: 0 });
    const out = await orch.create({ key: () => "k", declaredLength: 3, complete: false });
    if (out.kind !== "created") throw new Error(out.kind);
    return { orch, token: out.uploadToken };
}

describe("claimUpload", () => {
    test("an append and its completion carry the epoch of one claim", async () => {
        const { store, seen } = recording(true);
        const { orch, token } = await created(store);
        const out = await orch.append(token, { offset: 0, contentLength: 3, complete: true, body: new Uint8Array(3) });
        expect(out.kind).toBe("appended");
        expect(seen.claims).toEqual([token]);
        expect(seen.epochs).toEqual([
            ["append", 1],
            ["complete", 1],
        ]);
    });

    test("a cancel claims before it discards", async () => {
        const { store, seen } = recording(true);
        const { orch, token } = await created(store);
        expect((await orch.cancel(token)).kind).toBe("cancelled");
        expect(seen.claims).toEqual([token]);
        expect(seen.epochs).toEqual([["abort", 1]]);
    });

    test("a probe and a refused append take no claim", async () => {
        const { store, seen } = recording(true);
        const { orch, token } = await created(store);
        expect((await orch.probe(token)).kind).toBe("probed");
        const mismatch = await orch.append(token, {
            offset: 2,
            contentLength: 1,
            complete: false,
            body: new Uint8Array(1),
        });
        expect(mismatch.kind).toBe("offset-mismatch");
        expect(seen.claims).toEqual([]);
        expect(seen.epochs).toEqual([]);
    });

    test("a failing claim is a store error and nothing is written", async () => {
        const errors: unknown[] = [];
        const { store, seen } = recording(true, true);
        const orch = createUploadOrchestrator(store, { graceMs: 0, onError: (e) => errors.push(e) });
        const made = await orch.create({ key: () => "k", declaredLength: 3, complete: false });
        if (made.kind !== "created") throw new Error(made.kind);
        const out = await orch.append(made.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: true,
            body: new Uint8Array(3),
        });
        expect(out.kind).toBe("store-error");
        expect(seen.epochs).toEqual([]);
        expect(errors).toHaveLength(1);
    });

    test("a write refused for a superseded epoch is answered as an offset conflict", async () => {
        const { store } = recording(true);
        const fenced: ResumableWriteStore = {
            ...store,
            appendChunk: async (token) => {
                throw new UploadOffsetConflictError(token, 0);
            },
        };
        const { orch, token } = await created(fenced);
        const out = await orch.append(token, { offset: 0, contentLength: 1, complete: false, body: new Uint8Array(1) });
        expect(out.kind).toBe("offset-mismatch");
    });

    test("a store without claimUpload receives no epoch", async () => {
        const { store, seen } = recording(false);
        const { orch, token } = await created(store);
        await orch.append(token, { offset: 0, contentLength: 3, complete: true, body: new Uint8Array(3) });
        const second = await created(store);
        await second.orch.cancel(second.token);
        expect(seen.epochs).toEqual([
            ["append", undefined],
            ["complete", undefined],
            ["abort", undefined],
        ]);
    });
});
