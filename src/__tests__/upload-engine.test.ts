import { describe, test, expect } from "bun:test";
import {
    evaluateUploadCreation,
    evaluateUploadIntent,
    remainingLifetimeSeconds,
    type UploadState,
    type UploadPolicy,
} from "../upload-engine";

const NOW = 1_800_000_000_000;

function state(over: Partial<UploadState> = {}): UploadState {
    return {
        offset: 0,
        isComplete: false,
        isInvalidated: false,
        createdAt: NOW - 10_000,
        ...over,
    };
}

const opts = (over: Partial<{ now: number }> = {}) =>
    ({ now: NOW, ...over });

// ─── Creation ────────────────────────────────────────────────────────────────

describe("evaluateUploadCreation", () => {
    test("plain incomplete creation is accepted and records the declared length", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 100, contentLength: 10, hasContent: true, complete: false },
            {},
        );
        expect(v.kind).toBe("create-accepted");
        if (v.kind !== "create-accepted") return;
        expect(v.declaredLength).toBe(100);
        expect(v.completes).toBe(false);
        expect(v.events).toEqual([{ kind: "created", declaredLength: 100 }]);
    });

    test("a completing single-shot creation derives the total from its content size", () => {
        const v = evaluateUploadCreation(
            { kind: "create", contentLength: 42, hasContent: true, complete: true },
            {},
        );
        expect(v.kind).toBe("create-accepted");
        if (v.kind !== "create-accepted") return;
        expect(v.declaredLength).toBe(42);
        expect(v.completes).toBe(true);
    });

    test("two disagreeing length indicators in one request are inconsistent", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 100, contentLength: 42, hasContent: true, complete: true },
            {},
        );
        expect(v.kind).toBe("length-inconsistent");
    });

    test("agreeing indicators pass", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 42, contentLength: 42, hasContent: true, complete: true },
            {},
        );
        expect(v.kind).toBe("create-accepted");
    });

    test("declared length above maxSize is rejected before any byte moves", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 1001, hasContent: false, complete: false },
            { maxSize: 1000 },
        );
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("size-exceeded");
    });

    test("undeclared length with oversized first content is rejected via the content lower bound", () => {
        const v = evaluateUploadCreation(
            { kind: "create", contentLength: 1001, hasContent: true, complete: false },
            { maxSize: 1000 },
        );
        expect(v.kind).toBe("limit-violation");
    });

    test("declared length below minSize is rejected", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 3, hasContent: false, complete: false },
            { minSize: 10 },
        );
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("below-min-size");
    });

    test("minSize is not enforceable when the total is still unknown", () => {
        const v = evaluateUploadCreation(
            { kind: "create", contentLength: 3, hasContent: true, complete: false },
            { minSize: 10 },
        );
        expect(v.kind).toBe("create-accepted");
    });

    test("content above maxAppendSize is rejected", () => {
        const v = evaluateUploadCreation(
            { kind: "create", contentLength: 65, hasContent: true, complete: false },
            { maxAppendSize: 64 },
        );
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("append-too-large");
    });

    test("minAppendSize exemption: a creation with NO content passes regardless of completeness", () => {
        for (const complete of [true, false]) {
            const v = evaluateUploadCreation(
                { kind: "create", declaredLength: 100, hasContent: false, complete },
                { minAppendSize: 1024, maxSize: 1000000 },
            );
            expect(v.kind).toBe("create-accepted");
        }
    });

    test("minAppendSize exemption: a completing creation passes with small content", () => {
        const v = evaluateUploadCreation(
            { kind: "create", contentLength: 5, hasContent: true, complete: true },
            { minAppendSize: 1024 },
        );
        expect(v.kind).toBe("create-accepted");
    });

    test("a small NON-completing creation with content fails the min-append floor", () => {
        const v = evaluateUploadCreation(
            { kind: "create", contentLength: 5, hasContent: true, complete: false },
            { minAppendSize: 1024 },
        );
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("append-too-small");
    });

    test("creation maxBytes is the tightest of length, maxSize, and maxAppendSize", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 100, hasContent: true, complete: false },
            { maxSize: 1000, maxAppendSize: 64 },
        );
        expect(v.kind).toBe("create-accepted");
        if (v.kind !== "create-accepted") return;
        expect(v.maxBytes).toBe(64);
    });

    test("creation with no bounds at all has no maxBytes", () => {
        const v = evaluateUploadCreation(
            { kind: "create", hasContent: true, complete: false },
            {},
        );
        expect(v.kind).toBe("create-accepted");
        if (v.kind !== "create-accepted") return;
        expect(v.maxBytes).toBeUndefined();
    });

    test("malformed request numbers (negative, fractional, unsafe) reject rather than throw", () => {
        for (const declaredLength of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            const v = evaluateUploadCreation(
                { kind: "create", declaredLength, hasContent: false, complete: false },
                {},
            );
            expect(v.kind).toBe("length-inconsistent");
        }
    });
});

// ─── State sanity gate ───────────────────────────────────────────────────────

describe("state sanity gate (adapter bugs fail loudly)", () => {
    test("negative or fractional state offset throws RangeError", () => {
        for (const offset of [-1, 3.5, NaN]) {
            expect(() => evaluateUploadIntent({ kind: "probe" }, state({ offset }), {}, opts()))
                .toThrow(RangeError);
        }
    });

    test("state offset past a known length throws unless the adapter invalidated", () => {
        expect(() => evaluateUploadIntent({ kind: "probe" }, state({ offset: 11, length: 10 }), {}, opts()))
            .toThrow(RangeError);
        const v = evaluateUploadIntent(
            { kind: "probe" },
            state({ offset: 11, length: 10, isInvalidated: true }),
            {},
            opts(),
        );
        expect(v.kind).toBe("gone");
    });

    test("non-finite createdAt throws", () => {
        expect(() => evaluateUploadIntent({ kind: "probe" }, state({ createdAt: NaN }), {}, opts()))
            .toThrow(RangeError);
    });
});

// ─── Terminal states ─────────────────────────────────────────────────────────

describe("terminal states answer everything first", () => {
    test("invalidated resources refuse probes, appends, and cancels", () => {
        const dead = state({ isInvalidated: true });
        for (const intent of [
            { kind: "probe" } as const,
            { kind: "append", offset: 0, complete: false } as const,
            { kind: "cancel" } as const,
        ]) {
            const v = evaluateUploadIntent(intent, dead, {}, opts());
            expect(v.kind).toBe("gone");
            if (v.kind !== "gone") return;
            expect(v.reason).toBe("invalidated");
        }
    });

    test("expiry is enforced from policy + injected clock", () => {
        const old = state({ createdAt: NOW - 61_000 });
        const v = evaluateUploadIntent({ kind: "probe" }, old, { maxAgeSeconds: 60 }, opts());
        expect(v.kind).toBe("gone");
        if (v.kind !== "gone") return;
        expect(v.reason).toBe("expired");
        expect(v.events).toEqual([{ kind: "expired" }]);
    });

    test("a resource inside its lifetime still answers, with the remaining lifetime", () => {
        const young = state({ createdAt: NOW - 10_000 });
        const v = evaluateUploadIntent({ kind: "probe" }, young, { maxAgeSeconds: 60 }, opts());
        expect(v.kind).toBe("probe-result");
        if (v.kind !== "probe-result") return;
        expect(v.remainingLifetimeSeconds).toBe(50);
    });

    test("no max age means no expiry and no advertised lifetime", () => {
        const ancient = state({ createdAt: 0 });
        const v = evaluateUploadIntent({ kind: "probe" }, ancient, {}, opts());
        expect(v.kind).toBe("probe-result");
        if (v.kind !== "probe-result") return;
        expect(v.remainingLifetimeSeconds).toBeUndefined();
    });

    test("remainingLifetimeSeconds floors at zero", () => {
        expect(remainingLifetimeSeconds({ createdAt: NOW - 120_000 }, { maxAgeSeconds: 60 }, NOW)).toBe(0);
    });
});

// ─── Probe ───────────────────────────────────────────────────────────────────

describe("probe", () => {
    test("returns the adapter-derived truth verbatim", () => {
        const v = evaluateUploadIntent(
            { kind: "probe" },
            state({ offset: 512, length: 1024, isComplete: false }),
            {},
            opts(),
        );
        expect(v).toMatchObject({ kind: "probe-result", offset: 512, length: 1024, complete: false });
    });

    test("deferred length stays undefined in the answer", () => {
        const v = evaluateUploadIntent({ kind: "probe" }, state({ offset: 5 }), {}, opts());
        expect(v.kind).toBe("probe-result");
        if (v.kind !== "probe-result") return;
        expect(v.length).toBeUndefined();
    });
});

// ─── Append: offsets ─────────────────────────────────────────────────────────

describe("append offset rules", () => {
    test("matching offset is allowed and reports the durable offset", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 512, contentLength: 100, complete: false },
            state({ offset: 512, length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.atOffset).toBe(512);
        expect(v.events).toEqual([{ kind: "append-accepted", atOffset: 512, completes: false }]);
    });

    test("mismatched offset carries the CORRECT offset back (retry mechanism)", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 100, complete: false },
            state({ offset: 512 }),
            {},
            opts(),
        );
        expect(v).toMatchObject({
            kind: "offset-mismatch",
            claimedOffset: 100,
            correctOffset: 512,
            complete: false,
        });
    });

    test("stale zero-offset retry after a partial write mismatches, never rewinds", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 0, complete: false },
            state({ offset: 8192 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("offset-mismatch");
    });

    test("negative or fractional claimed offsets reject rather than throw", () => {
        for (const offset of [-1, 2.5]) {
            const v = evaluateUploadIntent(
                { kind: "append", offset, complete: false },
                state({ offset: 0 }),
                {},
                opts(),
            );
            expect(v.kind).toBe("length-inconsistent");
        }
    });
});

// ─── Append: length rules ────────────────────────────────────────────────────

describe("append length rules", () => {
    test("a known length is immutable: restating a different one is inconsistent", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 0, declaredLength: 2048, complete: false },
            state({ length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("length-inconsistent");
    });

    test("restating the SAME length is fine", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 0, declaredLength: 1024, contentLength: 10, complete: false },
            state({ length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
    });

    test("a deferred length is fixed by the first append that declares it", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 0, declaredLength: 1024, contentLength: 10, complete: false },
            state(),
            {},
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.declaredLength).toBe(1024);
    });

    test("length inconsistency outranks offset mismatch (learn the shape first)", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 999, declaredLength: 2048, complete: false },
            state({ offset: 512, length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("length-inconsistent");
    });

    test("a completing append whose content does not land exactly on the length is inconsistent", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 512, contentLength: 100, complete: true },
            state({ offset: 512, length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("length-inconsistent");
    });

    test("a completing append landing exactly on the length is allowed", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 512, contentLength: 512, complete: true },
            state({ offset: 512, length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.completes).toBe(true);
    });

    test("content crossing a known length is rejected BEFORE writing (resource stays valid)", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1000, contentLength: 100, complete: false },
            state({ offset: 1000, length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("length-inconsistent");
    });

    test("unknown content size gets a hard maxBytes bound toward the known length", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1000, complete: false },
            state({ offset: 1000, length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.maxBytes).toBe(24);
    });
});

// ─── Append: policy bounds ───────────────────────────────────────────────────

describe("append policy bounds", () => {
    test("append above maxAppendSize is refused", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 65, complete: false },
            state(),
            { maxAppendSize: 64 },
            opts(),
        );
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("append-too-large");
    });

    test("append below minAppendSize is refused unless it completes the upload", () => {
        const small = evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 5, complete: false },
            state(),
            { minAppendSize: 1024 },
            opts(),
        );
        expect(small.kind).toBe("limit-violation");
        if (small.kind !== "limit-violation") return;
        expect(small.reason).toBe("append-too-small");

        const tail = evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 5, complete: true },
            state(),
            { minAppendSize: 1024 },
            opts(),
        );
        expect(tail.kind).toBe("append-allowed");
    });

    test("zero-content NON-completing append is measured against the floor (third branch)", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 0, complete: false },
            state(),
            { minAppendSize: 1 },
            opts(),
        );
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("append-too-small");
    });

    test("content crossing maxSize is refused as size-exceeded", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 900, contentLength: 200, complete: false },
            state({ offset: 900 }),
            { maxSize: 1000 },
            opts(),
        );
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("size-exceeded");
    });

    test("maxBytes combines remaining length, remaining maxSize, and maxAppendSize", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 100, complete: false },
            state({ offset: 100, length: 1000 }),
            { maxSize: 500, maxAppendSize: 64 },
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        // remaining length 900, remaining maxSize 400, per-append 64.
        expect(v.maxBytes).toBe(64);
    });
});

// ─── Completion ──────────────────────────────────────────────────────────────

describe("completion", () => {
    test("zero-content completion at the declared length completes now", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1024, contentLength: 0, complete: true },
            state({ offset: 1024, length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("complete-now");
        if (v.kind !== "complete-now") return;
        expect(v.length).toBe(1024);
        expect(v.events).toEqual([{ kind: "completed", length: 1024 }]);
    });

    test("zero-content completion below the declared length is inconsistent, not silent truncation", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 512, contentLength: 0, complete: true },
            state({ offset: 512, length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("length-inconsistent");
    });

    test("zero-content completion with a DEFERRED length completes at the durable offset", () => {
        // No declared length: completing now fixes the total at whatever is
        // durable, which is the deferred-length flow's whole point.
        const v = evaluateUploadIntent(
            { kind: "append", offset: 512, contentLength: 0, complete: true },
            state({ offset: 512 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.completes).toBe(true);
    });

    test("retrying the completing request idempotently answers already-complete", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1024, contentLength: 0, complete: true },
            state({ offset: 1024, length: 1024, isComplete: true }),
            {},
            opts(),
        );
        expect(v.kind).toBe("already-complete");
        if (v.kind !== "already-complete") return;
        expect(v.length).toBe(1024);
    });

    test("an append to a completed upload at a WRONG offset reports mismatch with complete: true", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 0, complete: false },
            state({ offset: 1024, length: 1024, isComplete: true }),
            {},
            opts(),
        );
        expect(v).toMatchObject({ kind: "offset-mismatch", correctOffset: 1024, complete: true });
    });
});

// ─── Boundary equalities (bounds are inclusive where the spec says so) ──────

describe("boundary equalities", () => {
    test("a total exactly AT maxSize is accepted", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 1000, hasContent: false, complete: false },
            { maxSize: 1000 },
        );
        expect(v.kind).toBe("create-accepted");
    });

    test("a total exactly AT minSize is accepted", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 10, hasContent: false, complete: false },
            { minSize: 10 },
        );
        expect(v.kind).toBe("create-accepted");
    });

    test("content exactly AT maxAppendSize is accepted (create and append)", () => {
        expect(evaluateUploadCreation(
            { kind: "create", contentLength: 64, hasContent: true, complete: false },
            { maxAppendSize: 64 },
        ).kind).toBe("create-accepted");
        expect(evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 64, complete: false },
            state(),
            { maxAppendSize: 64 },
            opts(),
        ).kind).toBe("append-allowed");
    });

    test("content exactly AT minAppendSize is accepted (create and append)", () => {
        expect(evaluateUploadCreation(
            { kind: "create", contentLength: 1024, hasContent: true, complete: false },
            { minAppendSize: 1024 },
        ).kind).toBe("create-accepted");
        expect(evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 1024, complete: false },
            state(),
            { minAppendSize: 1024 },
            opts(),
        ).kind).toBe("append-allowed");
    });

    test("an append landing exactly ON maxSize is accepted", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 900, contentLength: 100, complete: false },
            state({ offset: 900 }),
            { maxSize: 1000 },
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
    });

    test("a zero-lifetime policy does not expire a resource born this instant", () => {
        const born = state({ createdAt: NOW });
        const v = evaluateUploadIntent({ kind: "probe" }, born, { maxAgeSeconds: 0 }, opts());
        expect(v.kind).toBe("probe-result");
    });

    test("an empty creation carrying an explicit zero Content-Length stays exempt from the floor", () => {
        const v = evaluateUploadCreation(
            { kind: "create", contentLength: 0, hasContent: false, complete: false },
            { minAppendSize: 1024 },
        );
        expect(v.kind).toBe("create-accepted");
    });
});

// ─── Completed-retry exception and bound arithmetic ──────────────────────────

describe("completion retry and bound arithmetic", () => {
    test("replaying the completing request WITH its content is answered idempotently", () => {
        // The original completing PATCH crashed after commit: the client
        // retries the same request (same offset, same content). The length
        // consistency check must not re-reject it; the exact-offset retry is
        // answered already-complete.
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1024, contentLength: 100, complete: true },
            state({ offset: 1024, length: 1024, isComplete: true }),
            {},
            opts(),
        );
        expect(v.kind).toBe("already-complete");
    });

    test("declaredLength is only surfaced when the state had none", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 0, declaredLength: 1024, contentLength: 10, complete: false },
            state({ length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.declaredLength).toBeUndefined();
    });

    test("maxBytes from maxSize alone is the exact remaining room", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 100, complete: false },
            state({ offset: 100 }),
            { maxSize: 500 },
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.maxBytes).toBe(400);
    });

    test("an unbounded append has no maxBytes at all", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 100, complete: false },
            state({ offset: 100 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.maxBytes).toBeUndefined();
    });

    test("streaming completion below a known length is allowed with the exact remaining bound", () => {
        // complete: true with UNKNOWN content size: the tail streams and the
        // orchestrator enforces the bound; this must never collapse into an
        // instant complete-now below the declared length.
        const v = evaluateUploadIntent(
            { kind: "append", offset: 512, complete: true },
            state({ offset: 512, length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.completes).toBe(true);
        expect(v.maxBytes).toBe(512);
    });

    test("malformed state length throws RangeError", () => {
        expect(() => evaluateUploadIntent({ kind: "probe" }, state({ length: -1 }), {}, opts()))
            .toThrow(RangeError);
    });
});

// ─── Audit event contract (every verdict site emits its exact events) ───────

describe("audit event contract", () => {
    test("creation rejections carry their reason", () => {
        const cases = [
            {
                v: evaluateUploadCreation({ kind: "create", declaredLength: -1, hasContent: false, complete: false }, {}),
                reason: "length-inconsistent",
            },
            {
                v: evaluateUploadCreation(
                    { kind: "create", declaredLength: 100, contentLength: 42, hasContent: true, complete: true }, {},
                ),
                reason: "length-inconsistent",
            },
            {
                v: evaluateUploadCreation(
                    { kind: "create", declaredLength: 1001, hasContent: false, complete: false }, { maxSize: 1000 },
                ),
                reason: "size-exceeded",
            },
            {
                v: evaluateUploadCreation(
                    { kind: "create", declaredLength: 3, hasContent: false, complete: false }, { minSize: 10 },
                ),
                reason: "below-min-size",
            },
            {
                v: evaluateUploadCreation(
                    { kind: "create", contentLength: 65, hasContent: true, complete: false }, { maxAppendSize: 64 },
                ),
                reason: "append-too-large",
            },
            {
                v: evaluateUploadCreation(
                    { kind: "create", contentLength: 5, hasContent: true, complete: false }, { minAppendSize: 1024 },
                ),
                reason: "append-too-small",
            },
        ] as const;
        for (const { v, reason } of cases) {
            expect((v as { events: unknown }).events).toEqual([{ kind: "append-rejected", reason }]);
        }
    });

    test("append rejections carry their reason and the offset where known", () => {
        const at = (reason: string, atOffset?: number) =>
            atOffset === undefined
                ? [{ kind: "append-rejected", reason }]
                : [{ kind: "append-rejected", reason, atOffset }];

        const malformed = evaluateUploadIntent(
            { kind: "append", offset: -1, complete: false }, state(), {}, opts(),
        );
        expect((malformed as { events: unknown }).events).toEqual(at("length-inconsistent"));

        const immutable = evaluateUploadIntent(
            { kind: "append", offset: 0, declaredLength: 2048, complete: false },
            state({ length: 1024 }), {}, opts(),
        );
        expect((immutable as { events: unknown }).events).toEqual(at("length-inconsistent"));

        const badTail = evaluateUploadIntent(
            { kind: "append", offset: 512, contentLength: 100, complete: true },
            state({ offset: 512, length: 1024 }), {}, opts(),
        );
        expect((badTail as { events: unknown }).events).toEqual(at("length-inconsistent"));

        const tooLarge = evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 65, complete: false },
            state(), { maxAppendSize: 64 }, opts(),
        );
        expect((tooLarge as { events: unknown }).events).toEqual(at("append-too-large", 0));

        const tooSmall = evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 5, complete: false },
            state(), { minAppendSize: 1024 }, opts(),
        );
        expect((tooSmall as { events: unknown }).events).toEqual(at("append-too-small", 0));

        const crossLength = evaluateUploadIntent(
            { kind: "append", offset: 1000, contentLength: 100, complete: false },
            state({ offset: 1000, length: 1024 }), {}, opts(),
        );
        expect((crossLength as { events: unknown }).events).toEqual(at("length-inconsistent", 1000));

        const crossMax = evaluateUploadIntent(
            { kind: "append", offset: 900, contentLength: 200, complete: false },
            state({ offset: 900 }), { maxSize: 1000 }, opts(),
        );
        expect((crossMax as { events: unknown }).events).toEqual(at("size-exceeded", 900));

        const mismatched = evaluateUploadIntent(
            { kind: "append", offset: 100, complete: false },
            state({ offset: 512 }), {}, opts(),
        );
        expect((mismatched as { events: unknown }).events).toEqual(at("offset-mismatch", 100));

        const invalidated = evaluateUploadIntent(
            { kind: "append", offset: 0, complete: false },
            state({ isInvalidated: true }), {}, opts(),
        );
        expect((invalidated as { events: unknown }).events).toEqual(at("invalidated"));
    });

    test("non-mutating verdicts emit no events", () => {
        const probe = evaluateUploadIntent({ kind: "probe" }, state(), {}, opts());
        expect((probe as { events: unknown }).events).toEqual([]);

        const replay = evaluateUploadIntent(
            { kind: "append", offset: 10, complete: true },
            state({ offset: 10, length: 10, isComplete: true }), {}, opts(),
        );
        expect((replay as { events: unknown }).events).toEqual([]);
    });
});

// ─── Cancel ──────────────────────────────────────────────────────────────────

describe("cancel", () => {
    test("cancel on a live resource is accepted with a cancelled event", () => {
        const v = evaluateUploadIntent({ kind: "cancel" }, state({ offset: 42 }), {}, opts());
        expect(v.kind).toBe("cancel-accepted");
        if (v.kind !== "cancel-accepted") return;
        expect(v.events).toEqual([{ kind: "cancelled" }]);
    });

    test("cancel on an expired resource reports gone, not a fresh cancellation", () => {
        const v = evaluateUploadIntent(
            { kind: "cancel" },
            state({ createdAt: NOW - 3_600_000 }),
            { maxAgeSeconds: 60 },
            opts(),
        );
        expect(v.kind).toBe("gone");
    });
});
