/**
 * Preemption must reach an append whose body has stopped delivering. A
 * half-open connection leaves the store parked in a body read that never
 * settles, and a yield checked only between chunks is never observed there,
 * so every later request on the upload waited out the whole lock timeout.
 */
import { describe, test, expect } from "bun:test";
import { createUploadOrchestrator } from "../upload-orchestrator.ts";
import { memoryUploadStore } from "../memory.ts";
import type { ResumableWriteStore } from "../upload-store.ts";

const NOW = 1_800_000_000_000;

/** A body that never enqueues a chunk and records whether it was cancelled. */
function silentBody() {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        cancel() {
            cancelled = true;
        },
    });
    return { stream, wasCancelled: () => cancelled };
}

/** A store whose own read loop observes the signal only between chunks. */
function betweenChunksStore(): ResumableWriteStore {
    const inner = memoryUploadStore({ objects: {} });
    return {
        ...inner,
        async appendChunk(token, offset, body, opts) {
            if (body instanceof Uint8Array) return inner.appendChunk(token, offset, body, opts);
            const reader = body.getReader();
            const parts: Uint8Array[] = [];
            try {
                for (;;) {
                    if (opts.signal?.aborted) break;
                    const { done, value } = await reader.read();
                    if (done) break;
                    parts.push(value);
                }
            } catch {
                const flushed = await inner.appendChunk(token, offset, concat(parts), { ...opts, signal: undefined });
                return { bytesWritten: flushed.bytesWritten, interrupted: true };
            }
            const flushed = await inner.appendChunk(token, offset, concat(parts), { ...opts, signal: undefined });
            return { bytesWritten: flushed.bytesWritten, interrupted: opts.signal?.aborted === true };
        },
    };
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.byteLength;
    }
    return out;
}

describe("a probe preempts an append parked on a silent body", () => {
    for (const [name, makeStore] of [
        ["memory store", () => memoryUploadStore({ objects: {} })],
        ["a store that checks the signal between chunks", betweenChunksStore],
    ] as const) {
        test(name, async () => {
            const o = createUploadOrchestrator(makeStore(), {
                policy: { maxSize: 1024 },
                now: () => NOW,
                graceMs: 0,
                lockTimeoutMs: 5_000,
            });
            const created = await o.create({ key: () => "k", declaredLength: 10, complete: false });
            if (created.kind !== "created") throw new Error("creation failed");
            const body = silentBody();
            const appending = o.append(created.uploadToken, { offset: 0, complete: false, body: body.stream });
            // Let the append take the lock and park in its first read.
            await new Promise((r) => setTimeout(r, 10));

            const started = performance.now();
            const probed = await o.probe(created.uploadToken);
            const elapsed = performance.now() - started;

            expect(probed).toMatchObject({ kind: "probed", offset: 0 });
            expect(elapsed).toBeLessThan(500);
            expect(await appending).toMatchObject({ kind: "appended", offset: 0, interrupted: true });
            expect(body.wasCancelled()).toBe(true);
        });
    }
});
