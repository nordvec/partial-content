import { describe, test, expect } from "bun:test";
import { evaluateUploadCreation, evaluateUploadIntent, type UploadState, type UploadPolicy } from "../upload-engine";

const NOW = 1_800_000_000_000;

function state(over: Partial<UploadState> = {}): UploadState {
    return {
        offset: 0,
        status: "incomplete",
        createdAt: NOW - 10_000,
        ...over,
    };
}

const opts = (over: Partial<{ now: number }> = {}) => ({ now: NOW, ...over });

// ─── Creation ────────────────────────────────────────────────────────────────

describe("evaluateUploadCreation", () => {
    test("plain incomplete creation is accepted and records the declared length", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 100, contentLength: 10, complete: false },
            {},
        );
        expect(v.kind).toBe("create-accepted");
        if (v.kind !== "create-accepted") return;
        expect(v.declaredLength).toBe(100);
        expect(v.completes).toBe(false);
        expect(v.events).toEqual([{ kind: "created", declaredLength: 100 }]);
    });

    test("a completing single-shot creation derives the total from its content size", () => {
        const v = evaluateUploadCreation({ kind: "create", contentLength: 42, complete: true }, {});
        expect(v.kind).toBe("create-accepted");
        if (v.kind !== "create-accepted") return;
        expect(v.declaredLength).toBe(42);
        expect(v.completes).toBe(true);
    });

    test("two disagreeing length indicators in one request are inconsistent", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 100, contentLength: 42, complete: true },
            {},
        );
        expect(v.kind).toBe("length-inconsistent");
    });

    test("agreeing indicators pass", () => {
        const v = evaluateUploadCreation({ kind: "create", declaredLength: 42, contentLength: 42, complete: true }, {});
        expect(v.kind).toBe("create-accepted");
    });

    test("declared length above maxSize is rejected before any byte moves", () => {
        const v = evaluateUploadCreation({ kind: "create", declaredLength: 1001, complete: false }, { maxSize: 1000 });
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("size-exceeded");
    });

    test("undeclared length with oversized first content is rejected via the content lower bound", () => {
        const v = evaluateUploadCreation({ kind: "create", contentLength: 1001, complete: false }, { maxSize: 1000 });
        expect(v.kind).toBe("limit-violation");
    });

    test("declared length below minSize is rejected", () => {
        const v = evaluateUploadCreation({ kind: "create", declaredLength: 3, complete: false }, { minSize: 10 });
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("below-min-size");
    });

    test("minSize is not enforceable when the total is still unknown", () => {
        const v = evaluateUploadCreation({ kind: "create", contentLength: 3, complete: false }, { minSize: 10 });
        expect(v.kind).toBe("create-accepted");
    });

    test("content above maxAppendSize is rejected", () => {
        const v = evaluateUploadCreation({ kind: "create", contentLength: 65, complete: false }, { maxAppendSize: 64 });
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("append-too-large");
    });

    test("minAppendSize exemption: a creation with NO content passes regardless of completeness", () => {
        for (const complete of [true, false]) {
            const v = evaluateUploadCreation(
                { kind: "create", declaredLength: 100, complete },
                { minAppendSize: 1024, maxSize: 1000000 },
            );
            expect(v.kind).toBe("create-accepted");
        }
    });

    test("minAppendSize exemption: a completing creation passes with small content", () => {
        const v = evaluateUploadCreation({ kind: "create", contentLength: 5, complete: true }, { minAppendSize: 1024 });
        expect(v.kind).toBe("create-accepted");
    });

    test("a small NON-completing creation with content fails the min-append floor", () => {
        const v = evaluateUploadCreation(
            { kind: "create", contentLength: 5, complete: false },
            { minAppendSize: 1024 },
        );
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("append-too-small");
    });

    test("creation maxBytes is the tightest of length, maxSize, and maxAppendSize", () => {
        const v = evaluateUploadCreation(
            { kind: "create", declaredLength: 100, complete: false },
            { maxSize: 1000, maxAppendSize: 64 },
        );
        expect(v.kind).toBe("create-accepted");
        if (v.kind !== "create-accepted") return;
        expect(v.maxBytes).toBe(64);
    });

    test("creation with no bounds at all has no maxBytes", () => {
        const v = evaluateUploadCreation({ kind: "create", complete: false }, {});
        expect(v.kind).toBe("create-accepted");
        if (v.kind !== "create-accepted") return;
        expect(v.maxBytes).toBeUndefined();
    });

    test("malformed request numbers (negative, fractional, unsafe) reject rather than throw", () => {
        for (const declaredLength of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            const v = evaluateUploadCreation({ kind: "create", declaredLength, complete: false }, {});
            expect(v.kind).toBe("length-inconsistent");
        }
    });
});

// ─── State sanity gate ───────────────────────────────────────────────────────

describe("state sanity gate (adapter bugs fail loudly)", () => {
    test("negative or fractional state offset throws RangeError", () => {
        for (const offset of [-1, 3.5, NaN]) {
            expect(() => evaluateUploadIntent({ kind: "probe" }, state({ offset }), {}, opts())).toThrow(RangeError);
        }
    });

    test("state offset past a known length throws unless the adapter invalidated", () => {
        expect(() => evaluateUploadIntent({ kind: "probe" }, state({ offset: 11, length: 10 }), {}, opts())).toThrow(
            RangeError,
        );
        const v = evaluateUploadIntent(
            { kind: "probe" },
            state({ offset: 11, length: 10, status: "invalidated" }),
            {},
            opts(),
        );
        expect(v.kind).toBe("gone");
    });

    test("non-finite createdAt throws", () => {
        expect(() => evaluateUploadIntent({ kind: "probe" }, state({ createdAt: NaN }), {}, opts())).toThrow(
            RangeError,
        );
    });
});

// ─── Terminal states ─────────────────────────────────────────────────────────

describe("terminal states answer everything first", () => {
    test("invalidated resources refuse probes and appends", () => {
        const dead = state({ status: "invalidated" });
        for (const intent of [{ kind: "probe" } as const, { kind: "append", offset: 0, complete: false } as const]) {
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

    test("a resource inside its lifetime still answers", () => {
        const young = state({ createdAt: NOW - 10_000 });
        const v = evaluateUploadIntent({ kind: "probe" }, young, { maxAgeSeconds: 60 }, opts());
        expect(v.kind).toBe("probe-result");
    });

    test("the deadline is createdAt plus the max age, to the millisecond", () => {
        // The instant a dialect advertises as the expiry is the instant the
        // resource dies: one millisecond short of it still answers.
        const probe = (createdAt: number) =>
            evaluateUploadIntent({ kind: "probe" }, state({ createdAt }), { maxAgeSeconds: 60 }, opts()).kind;
        expect(probe(NOW - 59_999)).toBe("probe-result");
        expect(probe(NOW - 60_000)).toBe("gone");
    });

    test("no max age means no expiry", () => {
        const ancient = state({ createdAt: 0 });
        const v = evaluateUploadIntent({ kind: "probe" }, ancient, {}, opts());
        expect(v.kind).toBe("probe-result");
    });

    test("a COMPLETED upload does not expire: its answer is what makes a lost response recoverable", () => {
        // Regression: expiry was evaluated ahead of completeness, so a
        // completed upload past its max age answered `gone` and the
        // orchestrator discarded the resource over it. The client's idempotent
        // completing retry then answered not-found for an upload that had
        // succeeded, and the at-least-once completion report became
        // permanently undeliverable for that token.
        const done = state({ offset: 10, length: 10, status: "complete", createdAt: NOW - 61_000 });
        const probed = evaluateUploadIntent({ kind: "probe" }, done, { maxAgeSeconds: 60 }, opts());
        expect(probed.kind).toBe("probe-result");
        if (probed.kind !== "probe-result") return;
        expect(probed.complete).toBe(true);
        expect(
            evaluateUploadIntent({ kind: "append", offset: 10, complete: true }, done, { maxAgeSeconds: 60 }, opts()),
        ).toEqual({ kind: "already-complete", length: 10, events: [] });
    });

    test("an UNFINISHED upload past its max age is still gone", () => {
        const abandoned = state({ offset: 4, length: 10, createdAt: NOW - 61_000 });
        const v = evaluateUploadIntent(
            { kind: "append", offset: 4, complete: false },
            abandoned,
            { maxAgeSeconds: 60 },
            opts(),
        );
        expect(v.kind).toBe("gone");
        if (v.kind !== "gone") return;
        expect(v.reason).toBe("expired");
    });
});

// ─── Probe ───────────────────────────────────────────────────────────────────

describe("probe", () => {
    test("returns the adapter-derived truth verbatim", () => {
        const v = evaluateUploadIntent(
            { kind: "probe" },
            state({ offset: 512, length: 1024, status: "incomplete" }),
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

    test("a length fixed for the first time below the durable offset is refused before it is recorded", () => {
        // Four bytes are durable under a deferred length; a request now naming
        // the total as two bytes names a total the resource can never reach.
        // The size ceiling refuses it only with a declared content size, so a
        // bodiless or chunked request has to be refused on the length itself,
        // or the store records a state every later probe treats as impossible.
        for (const contentLength of [undefined, 0]) {
            const v = evaluateUploadIntent(
                { kind: "append", offset: 4, declaredLength: 2, contentLength, complete: true, completeInferred: true },
                state({ offset: 4 }),
                {},
                opts(),
            );
            expect(v.kind).toBe("length-inconsistent");
        }
        // Naming exactly the durable offset is a valid total: nothing more lands.
        const exact = evaluateUploadIntent(
            { kind: "append", offset: 4, declaredLength: 4, contentLength: 0, complete: true },
            state({ offset: 4 }),
            {},
            opts(),
        );
        expect(exact.kind).toBe("append-allowed");
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

    test("the min-append exemption follows the client's assertion, not an inference", () => {
        // An inferred completion on a known-length upload holds for every body
        // whose size the request did not declare. Exempting it left the floor
        // binding on requests that state a size and on nothing else, so a
        // client could send one-byte appends without limit.
        const inferred = evaluateUploadIntent(
            { kind: "append", offset: 0, complete: true, completeInferred: true },
            state({ length: 10_000 }),
            { minAppendSize: 1024 },
            opts(),
        );
        expect(inferred.kind).toBe("limit-violation");
        if (inferred.kind !== "limit-violation") return;
        expect(inferred.reason).toBe("append-too-small");

        // The same request, stated by the client rather than derived, is held
        // to the same floor on a KNOWN length: the assertion costs the client
        // nothing when it is false and the short body would stay durable, so
        // an exemption here is the inferred loophole under another header.
        const asserted = evaluateUploadIntent(
            { kind: "append", offset: 0, complete: true, completeInferred: false },
            state({ length: 10_000 }),
            { minAppendSize: 1024 },
            opts(),
        );
        expect(asserted.kind).toBe("limit-violation");
        if (asserted.kind !== "limit-violation") return;
        expect(asserted.reason).toBe("append-too-small");
    });

    test("the asserted exemption holds where the engine can verify the completion before the write", () => {
        // A declared content size fixes what the body delivers.
        const sized = evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 5, complete: true, completeInferred: false },
            state({ length: 5 }),
            { minAppendSize: 1024 },
            opts(),
        );
        expect(sized.kind).toBe("append-allowed");
        // A deferred length makes the delivered bytes the representation: a
        // client that cannot size its body can still finish.
        const deferred = evaluateUploadIntent(
            { kind: "append", offset: 0, complete: true, completeInferred: false },
            state(),
            { minAppendSize: 1024 },
            opts(),
        );
        expect(deferred.kind).toBe("append-allowed");
        // At the durable end of a known length the bound is zero, so no byte
        // can land: the completing retry is an ordinary lost-response retry.
        const atEnd = evaluateUploadIntent(
            { kind: "append", offset: 10, complete: true, completeInferred: false },
            state({ offset: 10, length: 10 }),
            { minAppendSize: 1024 },
            opts(),
        );
        expect(atEnd.kind).toBe("append-allowed");
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
    test("zero-content completion at the declared length is an append that may publish", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1024, contentLength: 0, complete: true },
            state({ offset: 1024, length: 1024 }),
            {},
            opts(),
        );
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.completes).toBe(true);
        // The permission to publish is conditional on the bytes, and the
        // engine states the condition instead of assuming an answer: it never
        // sees the body.
        expect(v.postCondition).toEqual({ completesAt: 1024 });
        expect(v.maxBytes).toBe(0);
        // The verdict decides; it does not claim the publication happened. The
        // `completed` event is the orchestrator's, emitted after completeUpload
        // returns, so a store that throws records no completion.
        expect(v.events).toEqual([{ kind: "append-accepted", atOffset: 1024, completes: true }]);
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
            state({ offset: 1024, length: 1024, status: "complete" }),
            {},
            opts(),
        );
        expect(v.kind).toBe("already-complete");
        if (v.kind !== "already-complete") return;
        expect(v.length).toBe(1024);
    });

    test("an append to a completed upload at a WRONG offset reports the durable offset, and no completeness", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 0, complete: false },
            state({ offset: 1024, length: 1024, status: "complete" }),
            {},
            opts(),
        );
        // A conflict is resumable at the offset named beside it, and the draft
        // makes the incomplete assertion mandatory on a 409: a verdict that
        // carried the resource's completeness would be a field its one
        // consumer must never read, so there is none to read.
        expect(v).toEqual({
            kind: "offset-mismatch",
            claimedOffset: 0,
            correctOffset: 1024,
            events: [{ kind: "append-rejected", reason: "offset-mismatch", atOffset: 0 }],
        });
    });
});

// ─── Boundary equalities (bounds are inclusive where the spec says so) ──────

describe("boundary equalities", () => {
    test("a total exactly AT maxSize is accepted", () => {
        const v = evaluateUploadCreation({ kind: "create", declaredLength: 1000, complete: false }, { maxSize: 1000 });
        expect(v.kind).toBe("create-accepted");
    });

    test("a total exactly AT minSize is accepted", () => {
        const v = evaluateUploadCreation({ kind: "create", declaredLength: 10, complete: false }, { minSize: 10 });
        expect(v.kind).toBe("create-accepted");
    });

    test("content exactly AT maxAppendSize is accepted (create and append)", () => {
        expect(
            evaluateUploadCreation({ kind: "create", contentLength: 64, complete: false }, { maxAppendSize: 64 }).kind,
        ).toBe("create-accepted");
        expect(
            evaluateUploadIntent(
                { kind: "append", offset: 0, contentLength: 64, complete: false },
                state(),
                { maxAppendSize: 64 },
                opts(),
            ).kind,
        ).toBe("append-allowed");
    });

    test("content exactly AT minAppendSize is accepted (create and append)", () => {
        expect(
            evaluateUploadCreation({ kind: "create", contentLength: 1024, complete: false }, { minAppendSize: 1024 })
                .kind,
        ).toBe("create-accepted");
        expect(
            evaluateUploadIntent(
                { kind: "append", offset: 0, contentLength: 1024, complete: false },
                state(),
                { minAppendSize: 1024 },
                opts(),
            ).kind,
        ).toBe("append-allowed");
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
            { kind: "create", contentLength: 0, complete: false },
            { minAppendSize: 1024 },
        );
        expect(v.kind).toBe("create-accepted");
    });
});

// ─── Completed-retry exception and bound arithmetic ──────────────────────────

describe("completion retry and bound arithmetic", () => {
    test("an append carrying content at the durable end of a completed upload is refused", () => {
        // A completed upload sits AT its length, so content claimed at that
        // offset has nowhere to land: the offset may never exceed the length.
        // Answering already-complete would report success for bytes that
        // nothing read and no store received.
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1024, contentLength: 100, complete: true },
            state({ offset: 1024, length: 1024, status: "complete" }),
            {},
            opts(),
        );
        expect(v.kind).toBe("length-inconsistent");
        expect(v.events).toEqual([{ kind: "append-rejected", reason: "length-inconsistent", atOffset: 1024 }]);
    });

    test("a NON-completing append carrying content to a completed upload is refused too", () => {
        // The completeness flag does not change where the bytes would go.
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1024, contentLength: 1, complete: false },
            state({ offset: 1024, length: 1024, status: "complete" }),
            {},
            opts(),
        );
        expect(v.kind).toBe("length-inconsistent");
    });

    test("an undeclared size at the durable end of a completed upload is answered, not guessed at", () => {
        // The refusal above binds on a DECLARED size, which is a fact. An
        // undeclared one states nothing: reading it as content refuses the
        // bodiless retry the replay provision exists for, and reading it as
        // emptiness was never what makes the answer safe. What makes it safe
        // is that the representation is already published, so no byte of this
        // request is read, stored, or reported as stored either way.
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1024, complete: true },
            state({ offset: 1024, length: 1024, status: "complete" }),
            {},
            opts(),
        );
        expect(v.kind).toBe("already-complete");
    });

    test("a bodiless retry declaring no size stays an idempotent replay", () => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1024, complete: true },
            state({ offset: 1024, length: 1024, status: "complete" }),
            {},
            opts(),
        );
        expect(v.kind).toBe("already-complete");
    });

    test("a declared zero size outranks a body the caller reports as present", () => {
        // An explicit Content-Length: 0 is authoritative whatever shape the
        // body arrived in, so an empty buffered body is still a replay.
        const v = evaluateUploadIntent(
            { kind: "append", offset: 1024, contentLength: 0, complete: true },
            state({ offset: 1024, length: 1024, status: "complete" }),
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
        // bound is the room that remains, so a request that delivers less
        // than the declared total simply does not satisfy the post-condition.
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
        expect(() => evaluateUploadIntent({ kind: "probe" }, state({ length: -1 }), {}, opts())).toThrow(RangeError);
    });
});

// ─── Audit event contract (every verdict site emits its exact events) ───────

describe("audit event contract", () => {
    test("creation rejections carry their reason", () => {
        const cases = [
            {
                v: evaluateUploadCreation({ kind: "create", declaredLength: -1, complete: false }, {}),
                reason: "length-inconsistent",
            },
            {
                v: evaluateUploadCreation(
                    { kind: "create", declaredLength: 100, contentLength: 42, complete: true },
                    {},
                ),
                reason: "length-inconsistent",
            },
            {
                v: evaluateUploadCreation({ kind: "create", declaredLength: 1001, complete: false }, { maxSize: 1000 }),
                reason: "size-exceeded",
            },
            {
                v: evaluateUploadCreation({ kind: "create", declaredLength: 3, complete: false }, { minSize: 10 }),
                reason: "below-min-size",
            },
            {
                v: evaluateUploadCreation(
                    { kind: "create", contentLength: 65, complete: false },
                    { maxAppendSize: 64 },
                ),
                reason: "append-too-large",
            },
            {
                v: evaluateUploadCreation(
                    { kind: "create", contentLength: 5, complete: false },
                    { minAppendSize: 1024 },
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

        const malformed = evaluateUploadIntent({ kind: "append", offset: -1, complete: false }, state(), {}, opts());
        expect((malformed as { events: unknown }).events).toEqual(at("length-inconsistent"));

        const immutable = evaluateUploadIntent(
            { kind: "append", offset: 0, declaredLength: 2048, complete: false },
            state({ length: 1024 }),
            {},
            opts(),
        );
        expect((immutable as { events: unknown }).events).toEqual(at("length-inconsistent"));

        const badTail = evaluateUploadIntent(
            { kind: "append", offset: 512, contentLength: 100, complete: true },
            state({ offset: 512, length: 1024 }),
            {},
            opts(),
        );
        expect((badTail as { events: unknown }).events).toEqual(at("length-inconsistent"));

        const tooLarge = evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 65, complete: false },
            state(),
            { maxAppendSize: 64 },
            opts(),
        );
        expect((tooLarge as { events: unknown }).events).toEqual(at("append-too-large", 0));

        const tooSmall = evaluateUploadIntent(
            { kind: "append", offset: 0, contentLength: 5, complete: false },
            state(),
            { minAppendSize: 1024 },
            opts(),
        );
        expect((tooSmall as { events: unknown }).events).toEqual(at("append-too-small", 0));

        const crossLength = evaluateUploadIntent(
            { kind: "append", offset: 1000, contentLength: 100, complete: false },
            state({ offset: 1000, length: 1024 }),
            {},
            opts(),
        );
        expect((crossLength as { events: unknown }).events).toEqual(at("length-inconsistent", 1000));

        const crossMax = evaluateUploadIntent(
            { kind: "append", offset: 900, contentLength: 200, complete: false },
            state({ offset: 900 }),
            { maxSize: 1000 },
            opts(),
        );
        expect((crossMax as { events: unknown }).events).toEqual(at("size-exceeded", 900));

        const mismatched = evaluateUploadIntent(
            { kind: "append", offset: 100, complete: false },
            state({ offset: 512 }),
            {},
            opts(),
        );
        expect((mismatched as { events: unknown }).events).toEqual(at("offset-mismatch", 100));

        const invalidated = evaluateUploadIntent(
            { kind: "append", offset: 0, complete: false },
            state({ status: "invalidated" }),
            {},
            opts(),
        );
        expect((invalidated as { events: unknown }).events).toEqual(at("invalidated"));
    });

    test("non-mutating verdicts emit no events", () => {
        const probe = evaluateUploadIntent({ kind: "probe" }, state(), {}, opts());
        expect((probe as { events: unknown }).events).toEqual([]);

        const replay = evaluateUploadIntent(
            { kind: "append", offset: 10, complete: true },
            state({ offset: 10, length: 10, status: "complete" }),
            {},
            opts(),
        );
        expect((replay as { events: unknown }).events).toEqual([]);
    });
});

// ─── Content against the length it declares, on both paths ──────────────────

describe("a declared length and a content size that disagree", () => {
    const create = (declaredLength: number | undefined, contentLength: number | undefined, complete = false) =>
        evaluateUploadCreation({ kind: "create", declaredLength, contentLength, complete }, {});

    test("content larger than the declared total is refused, completing or not", () => {
        // Accepting it allocates a resource the body immediately destroys, so
        // the client would be told 201 Created about an upload already dead.
        expect(create(10, 11).kind).toBe("length-inconsistent");
        expect(create(10, 11, true).kind).toBe("length-inconsistent");
    });

    test("content exactly at the declared total is accepted", () => {
        expect(create(10, 10).kind).toBe("create-accepted");
        expect(create(10, 10, true).kind).toBe("create-accepted");
    });

    test("content under the declared total is accepted only when more may follow", () => {
        // A non-completing creation is a prefix; a completing one asserts this
        // content IS the whole representation, so a shortfall contradicts it.
        expect(create(10, 9).kind).toBe("create-accepted");
        expect(create(10, 9, true).kind).toBe("length-inconsistent");
    });

    test("one indicator alone can never be inconsistent with the other", () => {
        expect(create(undefined, 11).kind).toBe("create-accepted");
        expect(create(10, undefined).kind).toBe("create-accepted");
    });
});

// ─── A total declared on an append is still a total ─────────────────────────

describe("a length first declared on an append", () => {
    const append = (declaredLength: number | undefined, policy: UploadPolicy, over: Partial<UploadState> = {}) =>
        evaluateUploadIntent(
            { kind: "append", offset: 0, declaredLength, complete: false },
            state(over),
            policy,
            opts(),
        );

    test("over the policy maximum is refused, as it is at creation", () => {
        const v = append(101, { maxSize: 100 });
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("size-exceeded");
        expect(v.events).toEqual([{ kind: "append-rejected", reason: "size-exceeded", atOffset: 0 }]);
    });

    test("exactly at the policy maximum is accepted", () => {
        expect(append(100, { maxSize: 100 }).kind).toBe("append-allowed");
    });

    test("no maximum means nothing to exceed", () => {
        expect(append(101, {}).kind).toBe("append-allowed");
    });

    test("no declared length means nothing to check", () => {
        expect(append(undefined, { maxSize: 100 }).kind).toBe("append-allowed");
    });

    test("a length already recorded is not being declared now, so the check does not apply", () => {
        // A length accepted under an earlier policy outlives a redeploy that
        // tightens the maximum. Refusing the resumption of an upload already
        // holding bytes would strand them; the bound still stops the write.
        const v = append(101, { maxSize: 100 }, { length: 101 });
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.maxBytes).toBe(100);
        expect(v.fatalReason).toBe("size");
    });
});

// ─── The size floor binds where the total becomes immutable ─────────────────

describe("a total first fixed on an append meets the size floor", () => {
    const append = (
        req: { declaredLength?: number; contentLength?: number; complete?: boolean },
        policy: UploadPolicy,
        over: Partial<UploadState> = {},
    ) =>
        evaluateUploadIntent(
            {
                kind: "append",
                offset: over.offset ?? 0,
                declaredLength: req.declaredLength,
                contentLength: req.contentLength,
                complete: req.complete ?? false,
            },
            state(over),
            policy,
            opts(),
        );

    test("a completing append whose content size fixes a sub-floor total is refused before the write", () => {
        // Regression: the derived total was persisted BY the append and only
        // measured against the floor afterwards, so this refusal froze the
        // length at 10. Every later shape then answered `length-inconsistent`
        // or `below-min-size` forever, the bytes stayed durable, and only a
        // DELETE or a sweep could free them. No hostile client is needed: this
        // is the first attempt of anyone who does not know the server's floor.
        expect(append({ contentLength: 10, complete: true }, { minSize: 20 })).toEqual({
            kind: "limit-violation",
            reason: "below-min-size",
            events: [{ kind: "append-rejected", reason: "below-min-size", atOffset: 0 }],
        });
    });

    test("a total the request declares outright is refused the same way", () => {
        const v = append({ declaredLength: 10 }, { minSize: 20 });
        expect(v.kind).toBe("limit-violation");
        if (v.kind !== "limit-violation") return;
        expect(v.reason).toBe("below-min-size");
    });

    test("the floor measures the total, not what this request carries", () => {
        // A chunk smaller than the floor says nothing about the representation
        // it is one part of.
        expect(append({ contentLength: 4, declaredLength: 40 }, { minSize: 20 }).kind).toBe("append-allowed");
    });

    test("exactly at the floor is accepted", () => {
        expect(append({ contentLength: 20, complete: true }, { minSize: 20 }).kind).toBe("append-allowed");
    });

    test("a total nothing fixes is not refused here: the delivered bytes are measured at publication", () => {
        expect(append({ complete: true }, { minSize: 20 }).kind).toBe("append-allowed");
    });

    test("a length already recorded is not being fixed now", () => {
        // The immutable length predates this request, so refusing appends
        // against it would strand the bytes it already holds; the publication
        // gate is what answers for a length a policy change left under-floor.
        expect(append({ complete: true, contentLength: 0 }, { minSize: 20 }, { length: 0 }).kind).toBe(
            "append-allowed",
        );
    });
});

// ─── Which of three bounds binds, and what crossing it means ────────────────

describe("appendBound classification", () => {
    const boundOf = (policy: UploadPolicy, over: Partial<UploadState> = {}, declaredLength?: number) => {
        const v = evaluateUploadIntent(
            { kind: "append", offset: over.offset ?? 0, declaredLength, complete: false },
            state(over),
            policy,
            opts(),
        );
        if (v.kind !== "append-allowed") throw new Error(`expected append-allowed, got ${v.kind}`);
        return { maxBytes: v.maxBytes, fatal: v.maxBytesFatal, reason: v.fatalReason };
    };

    test("room toward a known length is a representation bound", () => {
        expect(boundOf({}, { length: 10, offset: 4 })).toEqual({ maxBytes: 6, fatal: true, reason: "length" });
    });

    test("room under the policy maximum is a representation bound", () => {
        expect(boundOf({ maxSize: 10 }, { offset: 4 })).toEqual({ maxBytes: 6, fatal: true, reason: "size" });
    });

    test("the tighter of the two representation bounds wins, and names itself", () => {
        expect(boundOf({ maxSize: 100 }, { length: 10 })).toEqual({ maxBytes: 10, fatal: true, reason: "length" });
        expect(boundOf({ maxSize: 10 }, { length: 100 })).toEqual({ maxBytes: 10, fatal: true, reason: "size" });
    });

    test("equal representation bounds answer as the client's own declaration", () => {
        // Declaring exactly the maximum is allowed; sending past it breaks the
        // declaration the client made, which is the more specific statement.
        expect(boundOf({ maxSize: 10 }, { length: 10 })).toEqual({ maxBytes: 10, fatal: true, reason: "length" });
    });

    test("a per-request ceiling below both is this request's, and not fatal", () => {
        expect(boundOf({ maxSize: 100, maxAppendSize: 4 }, { length: 50 })).toEqual({
            maxBytes: 4,
            fatal: false,
            reason: undefined,
        });
    });

    test("ties go to the representation bound", () => {
        // At equal values, crossing the per-append cap crosses the total too,
        // and that is the terminal one.
        expect(boundOf({ maxSize: 10, maxAppendSize: 10 }, {})).toEqual({ maxBytes: 10, fatal: true, reason: "size" });
    });

    test("with no bound at all there is nothing to cross", () => {
        expect(boundOf({}, {})).toEqual({ maxBytes: undefined, fatal: false, reason: undefined });
    });

    test("an offset already past a bound clamps to zero rather than going negative", () => {
        expect(boundOf({ maxSize: 4 }, { offset: 10 })).toEqual({ maxBytes: 0, fatal: false, reason: "size" });
    });

    test("a zero bound is never fatal, and still names the representation bound it came from", () => {
        // Regression: a zero bound was classified as fatal, so a request the
        // store admitted no byte from destroyed the resource anyway. Fatality
        // answers bytes that landed past a representation bound; at zero room
        // the store writes nothing, the durable prefix is intact, and the
        // client resumes from the truthful offset. The reason stays: a body that
        // carries bytes into the zero bound is answered as that inconsistency,
        // never as a per-request ceiling a smaller chunk could meet.
        expect(boundOf({}, { length: 10, offset: 10 })).toEqual({ maxBytes: 0, fatal: false, reason: "length" });
        expect(boundOf({ maxSize: 10 }, { offset: 10 })).toEqual({ maxBytes: 0, fatal: false, reason: "size" });
        // A per-append cap above the zero total does not resurrect fatality.
        expect(boundOf({ maxSize: 10, maxAppendSize: 4 }, { offset: 10 })).toEqual({
            maxBytes: 0,
            fatal: false,
            reason: "size",
        });
    });
});

// ─── Reaching the declared end is not the same as saying you are done ───────

describe("a bodyless append at the declared end", () => {
    const atEnd = (complete: boolean, contentLength?: number) =>
        evaluateUploadIntent(
            { kind: "append", offset: 10, contentLength, complete },
            state({ offset: 10, length: 10 }),
            {},
            opts(),
        );

    test("a declared empty body at the end is an append with a zero, non-fatal bound", () => {
        // Regression: this was a verdict of its own that published without the
        // store being called at all, so a request whose content size was
        // unknown published while its body went unread. There is one path now,
        // and the bound is what decides: zero bytes may land, and a byte that
        // arrives anyway stops at the bound without condemning the resource,
        // because none of it was ever admitted.
        expect(atEnd(true, 0)).toEqual({
            kind: "append-allowed",
            atOffset: 10,
            maxBytes: 0,
            maxBytesFatal: false,
            fatalReason: "length",
            declaredLength: undefined,
            completes: true,
            postCondition: { completesAt: 10 },
            events: [{ kind: "append-accepted", atOffset: 10, completes: true }],
        });
    });

    test("an undeclared content size at the end takes the same path, not a guess", () => {
        // Both readings of the unknown were wrong: "carries content" refuses a
        // valid bodiless retry, "carries none" publishes bytes nothing stored.
        // The verdict is identical to the declared-empty case above, and the
        // store's own bound answers the question after the read.
        const v = atEnd(true);
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.maxBytes).toBe(0);
        expect(v.maxBytesFatal).toBe(false);
        expect(v.completes).toBe(true);
        expect(v.postCondition.completesAt).toBe(10);
    });

    test("a request that does not claim completion leaves the upload open", () => {
        // Publishing here would finish an upload on a client that never said
        // it was finished, and the decision is not reversible.
        const v = atEnd(false);
        expect(v.kind).toBe("append-allowed");
        if (v.kind !== "append-allowed") return;
        expect(v.completes).toBe(false);
        // No room left, and a request that fits no byte cannot corrupt one.
        expect(v.maxBytes).toBe(0);
        expect(v.maxBytesFatal).toBe(false);
    });

    test("a completing request that still carries content is inconsistent, not a completion", () => {
        // The content would land past the declared total, so the request
        // contradicts itself and nothing is published.
        expect(atEnd(true, 3)).toEqual({
            kind: "length-inconsistent",
            events: [{ kind: "append-rejected", reason: "length-inconsistent" }],
        });
    });
});

// ─── A refused creation is recorded, not just refused ───────────────────────

describe("rejection events on creation", () => {
    test("content past the declared total records the rejection it answers", () => {
        // The outcome and the audit trail are two different obligations; a
        // rejection nothing recorded is invisible to whoever reviews the log.
        expect(
            evaluateUploadCreation({ kind: "create", declaredLength: 10, contentLength: 50, complete: false }, {}),
        ).toEqual({
            kind: "length-inconsistent",
            events: [{ kind: "append-rejected", reason: "length-inconsistent" }],
        });
    });

    test("a malformed length indicator is recorded the same way", () => {
        expect(evaluateUploadCreation({ kind: "create", declaredLength: -1, complete: false }, {})).toEqual({
            kind: "length-inconsistent",
            events: [{ kind: "append-rejected", reason: "length-inconsistent" }],
        });
    });
});
