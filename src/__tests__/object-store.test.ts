/**
 * Tests for object-store.ts primitives: the typed store errors and the
 * `nodeStreamToWeb` adapter that bridges Node async iterables to a Web
 * ReadableStream with abort propagation and deterministic teardown.
 *
 * Focus areas (precision that the adapter-level suites don't pin):
 *   - Error `cause` wiring: set when provided, ABSENT (not undefined-valued)
 *     when omitted, so error-chain walkers see a clean prototype.
 *   - Abort-listener lifecycle: registered only when there is something to
 *     tear down, and always detached on settle (no per-transfer leak).
 *   - Optional-chaining safety: a signal without removeEventListener, an
 *     absent destroy, and an iterator without return must never crash.
 */
import { describe, test, expect } from "bun:test";
import {
    ObjectNotFoundError,
    ObjectChangedError,
    StoreUnavailableError,
    classifyStoreRead,
    nodeStreamToWeb,
    guardStreamLength,
    resolveServedRange,
    parseRetryAfterSeconds,
    type StoreErrorClassifiers,
} from "../object-store";

// ─── classifyStoreRead: shared error-classification pipeline ─────────────────

describe("classifyStoreRead", () => {
    const classifiers: StoreErrorClassifiers = {
        notFound: (e) => (e as { kind?: string }).kind === "notFound",
        changed: (e) => (e as { kind?: string }).kind === "changed",
        throttled: (e) => (e as { kind?: string }).kind === "throttled",
    };

    test("returns the operation result on success", async () => {
        const out = await classifyStoreRead("k", async () => 42, classifiers);
        expect(out).toBe(42);
    });

    test("maps each classified failure to its contract error with cause + key", async () => {
        const cases = [
            { kind: "notFound", ctor: ObjectNotFoundError, status: 404 },
            { kind: "changed", ctor: ObjectChangedError, status: 412 },
            { kind: "throttled", ctor: StoreUnavailableError, status: 503 },
        ] as const;
        for (const c of cases) {
            const raw = { kind: c.kind };
            const caught = await classifyStoreRead("doc.pdf", async () => { throw raw; }, classifiers)
                .then(() => null, (e: unknown) => e);
            expect(caught).toBeInstanceOf(c.ctor);
            expect((caught as { status: number }).status).toBe(c.status);
            expect((caught as { key: string }).key).toBe("doc.pdf");
            expect((caught as Error).cause).toBe(raw);
        }
    });

    test("an unclassified error is rethrown untouched (never masked)", async () => {
        const raw = new Error("auth failure");
        const caught = await classifyStoreRead("k", async () => { throw raw; }, classifiers)
            .then(() => null, (e: unknown) => e);
        expect(caught).toBe(raw);
    });

    test("precedence is notFound -> changed -> throttled when predicates overlap", async () => {
        const greedy: StoreErrorClassifiers = {
            notFound: () => true,
            changed: () => true,
            throttled: () => true,
        };
        const caught = await classifyStoreRead("k", async () => { throw new Error("x"); }, greedy)
            .then(() => null, (e: unknown) => e);
        expect(caught).toBeInstanceOf(ObjectNotFoundError);
    });

    test("a missing optional `changed` predicate is skipped, not a crash", async () => {
        const noChanged: StoreErrorClassifiers = {
            notFound: () => false,
            throttled: (e) => (e as { kind?: string }).kind === "throttled",
        };
        const caught = await classifyStoreRead("k", async () => { throw { kind: "throttled" }; }, noChanged)
            .then(() => null, (e: unknown) => e);
        expect(caught).toBeInstanceOf(StoreUnavailableError);
    });

    test("a throttle returning { retryAfterSeconds } surfaces it on the 503", async () => {
        const withHint: StoreErrorClassifiers = {
            notFound: () => false,
            throttled: () => ({ retryAfterSeconds: 45 }),
        };
        const caught = await classifyStoreRead("k", async () => { throw new Error("busy"); }, withHint)
            .then(() => null, (e: unknown) => e);
        expect(caught).toBeInstanceOf(StoreUnavailableError);
        expect((caught as StoreUnavailableError).retryAfterSeconds).toBe(45);
    });

    test("a bare `true` throttle emits a 503 with no retryAfterSeconds", async () => {
        const noHint: StoreErrorClassifiers = {
            notFound: () => false,
            throttled: () => true,
        };
        const caught = await classifyStoreRead("k", async () => { throw new Error("busy"); }, noHint)
            .then(() => null, (e: unknown) => e);
        expect(caught).toBeInstanceOf(StoreUnavailableError);
        expect((caught as StoreUnavailableError).retryAfterSeconds).toBeUndefined();
    });
});

// ─── parseRetryAfterSeconds: shared Retry-After hygiene ──────────────────────

describe("parseRetryAfterSeconds", () => {
    test("numbers: floors non-negative finite, keeps 0, drops hostile", () => {
        expect(parseRetryAfterSeconds(30)).toBe(30);
        expect(parseRetryAfterSeconds(2.9)).toBe(2);
        expect(parseRetryAfterSeconds(0)).toBe(0);
        expect(parseRetryAfterSeconds(-5)).toBeUndefined();
        expect(parseRetryAfterSeconds(NaN)).toBeUndefined();
        expect(parseRetryAfterSeconds(Infinity)).toBeUndefined();
        // A huge finite hint whose floor exceeds MAX_SAFE_INTEGER must be dropped,
        // not emitted as `1e+21` (which violates the delay-seconds DIGIT+ grammar).
        expect(parseRetryAfterSeconds(1e21)).toBeUndefined();
    });

    test("delay-seconds strings parse; non-numeric/out-of-range drop", () => {
        expect(parseRetryAfterSeconds("7")).toBe(7);
        expect(parseRetryAfterSeconds("  12  ")).toBe(12);
        expect(parseRetryAfterSeconds("soon")).toBeUndefined();
        expect(parseRetryAfterSeconds("99999999999999999999")).toBeUndefined();
        expect(parseRetryAfterSeconds(null)).toBeUndefined();
        expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
    });

    test("HTTP-date form only parses when allowHttpDate is set", () => {
        const future = new Date(Date.now() + 60_000).toUTCString();
        expect(parseRetryAfterSeconds(future)).toBeUndefined();
        const secs = parseRetryAfterSeconds(future, { allowHttpDate: true });
        expect(secs).toBeGreaterThan(50);
        expect(secs).toBeLessThanOrEqual(60);
        // A past date clamps to 0, never negative.
        expect(parseRetryAfterSeconds(new Date(Date.now() - 60_000).toUTCString(), { allowHttpDate: true })).toBe(0);
    });
});

// ─── resolveServedRange: shared Content-Range parsing + sentinel mapping ─────

describe("resolveServedRange", () => {
    test("parses served bounds and a concrete total", () => {
        expect(resolveServedRange("bytes 0-499/10000")).toEqual({
            served: { start: 0, end: 499 },
            totalSize: 10000,
        });
    });

    test("maps the unknown-total sentinel (bytes a-b/*) to undefined", () => {
        expect(resolveServedRange("bytes 0-499/*")).toEqual({
            served: { start: 0, end: 499 },
            totalSize: undefined,
        });
    });

    test("returns null for an unparseable header (the tear-down-and-throw signal)", () => {
        expect(resolveServedRange("bytes garbage")).toBeNull();
        expect(resolveServedRange("")).toBeNull();
        // The unsatisfied-range form carries no bounds and must not resolve.
        expect(resolveServedRange("bytes */1000")).toBeNull();
    });
});

// ─── guardStreamLength: committed-length enforcement on web streams ──────────

describe("guardStreamLength", () => {
    function webStreamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
        let i = 0;
        return new ReadableStream<Uint8Array>({
            pull(controller) {
                if (i < chunks.length) controller.enqueue(chunks[i++]);
                else controller.close();
            },
        });
    }

    test("passes through unchanged when the delivered count matches", async () => {
        const guarded = guardStreamLength(webStreamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), 3);
        const chunks = await drain(guarded);
        expect(Buffer.concat(chunks).length).toBe(3);
    });

    test("errors the stream when the source ends short of the committed length", async () => {
        const guarded = guardStreamLength(webStreamOf([new Uint8Array([1, 2])]), 5);
        await expect(drain(guarded)).rejects.toThrow(/delivered 2 bytes, expected 5/);
    });

    test("errors the stream when the source over-runs the committed length", async () => {
        const guarded = guardStreamLength(webStreamOf([new Uint8Array([1, 2, 3, 4])]), 2);
        await expect(drain(guarded)).rejects.toThrow(/delivered 4 bytes, expected 2/);
    });

    test("undefined expectedBytes disables the guard and returns the same stream", () => {
        const source = webStreamOf([new Uint8Array([1])]);
        expect(guardStreamLength(source, undefined)).toBe(source);
    });

    test("cancelling the guarded stream propagates cancel to the source (backend teardown)", async () => {
        // The guard wraps the body in a pipeThrough; a client disconnect must
        // still cancel the underlying backend stream (S3/R2/Azure socket), or
        // the abort-teardown guarantee is silently broken by the wrapper.
        let cancelledReason: unknown;
        const source = new ReadableStream<Uint8Array>({
            pull(controller) { controller.enqueue(new Uint8Array([1, 2])); },
            cancel(reason) { cancelledReason = reason ?? "cancelled"; },
        });
        const guarded = guardStreamLength(source, 100);
        const reader = guarded.getReader();
        await reader.read();
        await reader.cancel("client gone");
        // Cancel propagates through the pipeThrough to the source asynchronously;
        // yield a macrotask so the source's cancel() has run before asserting.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(cancelledReason).toBe("client gone");
    });
});

// ─── Typed Store Errors: cause wiring ───────────────────────────────────────

describe("store error cause wiring", () => {
    test("cause is preserved when provided (error chaining)", () => {
        const root = new Error("root failure");
        expect(new ObjectNotFoundError("k", root).cause).toBe(root);
        expect(new ObjectChangedError("k", root).cause).toBe(root);
        expect(new StoreUnavailableError("k", { cause: root }).cause).toBe(root);
    });

    test("cause property is ABSENT (not undefined-valued) when omitted", () => {
        // The guard is `if (cause !== undefined)`: omitting a cause must leave
        // the own property unset, not assign an explicit `undefined`. An
        // undefined-valued `cause` still answers true to `"cause" in err` and
        // confuses tools that walk `err.cause` chains.
        const notFound = new ObjectNotFoundError("k");
        const changed = new ObjectChangedError("k");
        const unavailable = new StoreUnavailableError("k");
        expect(Object.prototype.hasOwnProperty.call(notFound, "cause")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(changed, "cause")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(unavailable, "cause")).toBe(false);
    });

    test("status hints and key are carried on every store error", () => {
        expect(new ObjectNotFoundError("a").status).toBe(404);
        expect(new ObjectChangedError("b").status).toBe(412);
        expect(new StoreUnavailableError("c").status).toBe(503);
        expect(new ObjectNotFoundError("a").key).toBe("a");
        expect(new StoreUnavailableError("c", { retryAfterSeconds: 30 }).retryAfterSeconds).toBe(30);
    });

    test("retryAfterSeconds is normalized at construction (floor valid, drop hostile)", () => {
        // A NaN/negative/infinite/out-of-safe-range hint (hostile header, buggy
        // third-party classifier) must never be retained, so a direct reader of
        // `.retryAfterSeconds` off the contract sees `undefined`, not garbage.
        for (const bad of [NaN, -5, -0.1, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            expect(new StoreUnavailableError("k", { retryAfterSeconds: bad }).retryAfterSeconds).toBeUndefined();
        }
        // A non-negative finite hint is floored to whole seconds; zero is valid.
        expect(new StoreUnavailableError("k", { retryAfterSeconds: 2.9 }).retryAfterSeconds).toBe(2);
        expect(new StoreUnavailableError("k", { retryAfterSeconds: 0 }).retryAfterSeconds).toBe(0);
        expect(new StoreUnavailableError("k", { retryAfterSeconds: 30 }).retryAfterSeconds).toBe(30);
    });
});

// ─── Abort-listener lifecycle ────────────────────────────────────────────────

/**
 * A minimal AbortSignal-like harness that records add/remove calls and can
 * fire a synthetic abort. `withRemove: false` omits removeEventListener to
 * exercise the optional-chaining guard.
 */
function createSignalHarness(opts?: { withRemove?: boolean }) {
    const listeners: Array<() => void> = [];
    const calls = { add: 0, remove: 0 };
    const signal: {
        addEventListener(type: "abort", listener: () => void): void;
        removeEventListener?(type: "abort", listener: () => void): void;
    } = {
        addEventListener(_type, listener) {
            calls.add++;
            listeners.push(listener);
        },
    };
    if (opts?.withRemove !== false) {
        signal.removeEventListener = (_type, listener) => {
            calls.remove++;
            const i = listeners.indexOf(listener);
            if (i >= 0) listeners.splice(i, 1);
        };
    }
    return {
        signal,
        calls,
        fireAbort() {
            for (const l of [...listeners]) l();
        },
    };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    return chunks;
}

describe("nodeStreamToWeb abort propagation", () => {
    test("aborting the signal invokes destroy (backend teardown)", async () => {
        const h = createSignalHarness();
        let destroyed = 0;
        async function* gen(): AsyncGenerator<Uint8Array> {
            yield new Uint8Array([1]);
            yield new Uint8Array([2]);
        }
        const stream = nodeStreamToWeb(gen(), {
            signal: h.signal,
            destroy: () => { destroyed++; },
        });
        const reader = stream.getReader();
        await reader.read();
        // The listener is wired at construction, before any pull.
        expect(h.calls.add).toBe(1);
        h.fireAbort();
        expect(destroyed).toBe(1);
        await reader.cancel();
    });

    test("the abort listener is detached once the stream completes (no leak)", async () => {
        const h = createSignalHarness();
        async function* gen(): AsyncGenerator<Uint8Array> {
            yield new Uint8Array([1]);
        }
        await drain(nodeStreamToWeb(gen(), { signal: h.signal, destroy: () => {} }));
        expect(h.calls.add).toBe(1);
        // detach() MUST run on the graceful-end path, or a long-lived signal
        // accumulates one listener per completed transfer.
        expect(h.calls.remove).toBe(1);
    });

    test("no listener is registered when there is nothing to tear down", async () => {
        const h = createSignalHarness();
        async function* gen(): AsyncGenerator<Uint8Array> {
            yield new Uint8Array([1]);
        }
        // No destroy opt and a plain generator has no native .destroy, so
        // abortListener is undefined: the signal must be left untouched on
        // both registration and detach.
        await drain(nodeStreamToWeb(gen(), { signal: h.signal }));
        expect(h.calls.add).toBe(0);
        expect(h.calls.remove).toBe(0);
    });

    test("completes cleanly when the signal has no removeEventListener", async () => {
        // removeEventListener is optional on the signal type. A signal that
        // only supports addEventListener must not crash detach on completion.
        const h = createSignalHarness({ withRemove: false });
        async function* gen(): AsyncGenerator<Uint8Array> {
            yield new Uint8Array([1]);
        }
        const chunks = await drain(nodeStreamToWeb(gen(), { signal: h.signal, destroy: () => {} }));
        expect(chunks.length).toBe(1);
        expect(h.calls.add).toBe(1);
    });
});

// ─── Optional-chaining safety on the error / cancel paths ────────────────────

describe("nodeStreamToWeb teardown without a destroy capability", () => {
    test("a mid-read error rethrows the ORIGINAL error, not a crash", async () => {
        async function* gen(): AsyncGenerator<Uint8Array> {
            yield new Uint8Array([1]);
            throw new Error("backend read failed");
        }
        // No destroy and no native .destroy: the pull catch must rethrow the
        // backend error, never a "destroy is not a function".
        const reader = nodeStreamToWeb(gen()).getReader();
        await reader.read();
        await expect(reader.read()).rejects.toThrow("backend read failed");
    });

    test("cancel resolves cleanly when there is no destroy capability", async () => {
        async function* gen(): AsyncGenerator<Uint8Array> {
            yield new Uint8Array([1]);
            yield new Uint8Array([2]);
        }
        // destroy?.() on the cancel path must be a no-op when absent, so the
        // cancel promise resolves rather than rejecting on an absent destroy().
        await expect(nodeStreamToWeb(gen()).cancel("client gone")).resolves.toBeUndefined();
    });

    test("cancel calls the iterator's return with the cancel reason", async () => {
        const returned: unknown[] = [];
        const iterable: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
                return {
                    next: async () => ({ done: false, value: new Uint8Array([1]) }),
                    return: async (reason?: unknown) => {
                        returned.push(reason);
                        return { done: true, value: undefined };
                    },
                };
            },
        };
        await nodeStreamToWeb(iterable).cancel("client gone");
        expect(returned).toEqual(["client gone"]);
    });
});
