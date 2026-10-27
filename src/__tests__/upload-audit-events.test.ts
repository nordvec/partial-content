/**
 * The audit stream reports what a write made durable, not only that it was
 * permitted: an `appended` outcome carries the bytes and whether the body was
 * interrupted, a lock timeout is its own event, and a completion refused for
 * its digest names that reason.
 */
import { describe, test, expect } from "bun:test";
import { memoryUploadStore } from "../memory.ts";
import {
    createUploadOrchestrator,
    UploadLockTimeoutError,
    type UploadAuditEvent,
    type UploadLocker,
} from "../upload-shared.ts";

const enc = new TextEncoder();

function setup(locker?: UploadLocker) {
    const events: UploadAuditEvent[] = [];
    const orch = createUploadOrchestrator(memoryUploadStore({ objects: {} }), {
        now: () => 1_000,
        graceMs: 0,
        locker,
        onUploadEvent: (e) => events.push(e.event),
    });
    return { orch, events };
}

describe("upload audit events", () => {
    test("a creation body and an append each report what they made durable", async () => {
        const { orch, events } = setup();
        const created = await orch.create({ key: () => "k", complete: false, body: enc.encode("abc") });
        if (created.kind !== "created") throw new Error(created.kind);
        expect(events).toContainEqual({ kind: "appended", atOffset: 0, bytes: 3, interrupted: false });
        await orch.append(created.uploadToken, { offset: 3, complete: true, body: enc.encode("de") });
        expect(events).toContainEqual({ kind: "appended", atOffset: 3, bytes: 2, interrupted: false });
        expect(events.at(-1)).toEqual({ kind: "completed", length: 5 });
    });

    test("a lock timeout is reported as lock-contended", async () => {
        const locker: UploadLocker = {
            acquire: (token) => Promise.reject(new UploadLockTimeoutError(token)),
        };
        const { orch, events } = setup(locker);
        const out = await orch.append("missing", { offset: 0, complete: false, body: enc.encode("x") });
        expect(out.kind).toBe("contended");
        expect(events).toEqual([{ kind: "lock-contended" }]);
    });

    test("a completion refused for its digest is rejected with reason digest-mismatch", async () => {
        const { orch, events } = setup();
        const out = await orch.create({
            key: () => "k",
            complete: true,
            body: enc.encode("abc"),
            expectedDigests: { "sha-256": btoa(String.fromCharCode(...new Uint8Array(32))) },
        });
        expect(out.kind).toBe("digest-mismatch");
        expect(events).toContainEqual({ kind: "append-rejected", reason: "digest-mismatch" });
    });
});
