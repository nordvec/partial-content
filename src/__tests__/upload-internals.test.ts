/**
 * The adapter-shared upload internals, tested where they live.
 *
 * Every adapter reaches these through its own suite, but a gate exercised only
 * through a backend's own paths proves the inputs that backend happens to
 * produce. These cases pin each helper's whole contract by name: the refusals a
 * forged or corrupt record must meet, the stop reasons a pump distinguishes,
 * and both sides of every cutoff comparison.
 */
import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
    admitAppend,
    assertUploadWritable,
    base64UrlToBytes,
    bytesToBase64,
    bytesToBase64Url,
    cancelUploadBody,
    isSweepable,
    openUploadBody,
    publishKeyGuard,
    pumpUploadBody,
    requireSweepCutoff,
    toStoredState,
    uploadIdForDiscard,
    validatePersistedUploadShape,
    UPLOAD_ID_RE,
} from "../upload-internals.ts";
import { UploadOverrunError } from "../upload-store.ts";

const VALID_ID = "0198f0b4-1c2d-7e3f-8a4b-5c6d7e8f9a0b";

/** A stream that records whether the consumer cancelled it. */
function trackedStream(chunks: Uint8Array[]): {
    body: ReadableStream<Uint8Array>;
    cancelled: () => boolean;
} {
    let cancelled = false;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (index >= chunks.length) controller.close();
            else controller.enqueue(chunks[index++]!);
        },
        cancel() {
            cancelled = true;
        },
    });
    return { body, cancelled: () => cancelled };
}

describe("admitAppend", () => {
    const yielded = (): AbortSignal => {
        const controller = new AbortController();
        controller.abort();
        return controller.signal;
    };
    const open = async (): Promise<string> => "opened";

    test("admits an append when nothing yielded and leaves the body unread", async () => {
        const { body, cancelled } = trackedStream([]);
        expect(await admitAppend(body, {}, open)).toEqual({ admitted: "opened" });
        expect(await admitAppend(body, { signal: new AbortController().signal }, open)).toEqual({
            admitted: "opened",
        });
        expect(cancelled()).toBe(false);
    });

    test("refuses an already-yielded append without raising or opening", async () => {
        // Reported, never thrown: a caller must not have to read an exception to
        // tell a yield from a failure.
        const { body } = trackedStream([new Uint8Array([1])]);
        let opened = false;
        const admission = await admitAppend(body, { signal: yielded() }, async () => {
            opened = true;
        });
        expect(admission).toEqual({ refused: { bytesWritten: 0, interrupted: true } });
        expect(opened).toBe(false);
    });

    test("cancels the body it refuses, so no stream is left locked", async () => {
        const { body, cancelled } = trackedStream([new Uint8Array([1])]);
        await admitAppend(body, { signal: yielded() }, open);
        expect(cancelled()).toBe(true);
    });

    test("a failed open rethrows and releases the body through the caller's handle", async () => {
        const { body, cancelled } = trackedStream([new Uint8Array([1])]);
        let released = 0;
        const failure = new Error("offset conflict");
        const releaseBody = async (): Promise<void> => {
            released++;
        };
        await expect(
            admitAppend(body, { releaseBody }, async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
        expect(released).toBe(1);
        expect(cancelled()).toBe(false);
    });

    test("a buffered body needs no cancelling and is refused either way", async () => {
        expect(await admitAppend(new Uint8Array([1, 2]), { signal: yielded() }, open)).toEqual({
            refused: { bytesWritten: 0, interrupted: true },
        });
    });
});

describe("uploadIdForDiscard", () => {
    test("answers the id for a token that names a resource", () => {
        expect(UPLOAD_ID_RE.test(VALID_ID)).toBe(true);
        expect(uploadIdForDiscard(VALID_ID)).toBe(VALID_ID);
    });

    test("answers null rather than the raw token for anything else", () => {
        // The id is interpolated into backend object names, so handing back an
        // unvalidated token would let a discard address a path the server never
        // minted. Idempotent-abort is the reason for null, not the excuse.
        for (const token of ["", "not-a-uuid", "../escape", `${VALID_ID}/extra`, VALID_ID.toUpperCase()]) {
            expect(uploadIdForDiscard(token)).toBeNull();
        }
    });
});

describe("pumpUploadBody", () => {
    const noOverrun = async (): Promise<void> => {};

    async function drain(
        body: ReadableStream<Uint8Array> | Uint8Array,
        opts: Parameters<typeof pumpUploadBody>[2] & {
            uploadToken: string;
            onOverrun: Parameters<typeof pumpUploadBody>[3];
        },
    ): Promise<{ seen: Uint8Array[]; outcome: ReturnType<typeof pumpUploadBody>["outcome"] }> {
        const { uploadToken, onOverrun, ...appendOpts } = opts;
        const { chunks, outcome, finalize } = pumpUploadBody(body, uploadToken, appendOpts, onOverrun);
        const seen: Uint8Array[] = [];
        for await (const chunk of chunks) seen.push(chunk);
        await finalize();
        return { seen, outcome };
    }

    test("a body that ends reports endedCleanly and nothing else", async () => {
        const { body } = trackedStream([new Uint8Array([1, 2]), new Uint8Array([3])]);
        const { seen, outcome } = await drain(body, { uploadToken: VALID_ID, onOverrun: noOverrun });
        expect(seen.map((c) => [...c])).toEqual([[1, 2], [3]]);
        expect(outcome).toEqual({ interrupted: false, ceilingHit: false, endedCleanly: true });
    });

    test("an already-yielded signal stops before the first chunk", async () => {
        const controller = new AbortController();
        controller.abort();
        const { body } = trackedStream([new Uint8Array([1])]);
        const { seen, outcome } = await drain(body, {
            uploadToken: VALID_ID,
            signal: controller.signal,
            onOverrun: noOverrun,
        });
        expect(seen).toEqual([]);
        expect(outcome).toEqual({ interrupted: true, ceilingHit: false, endedCleanly: false });
    });

    test("a body that dies is an interruption, not a failure", async () => {
        // The prefix already delivered stays delivered; the caller flushes it and
        // reports the truth rather than raising.
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
            },
            pull() {
                throw new Error("client disconnected");
            },
        });
        const { seen, outcome } = await drain(body, { uploadToken: VALID_ID, onOverrun: noOverrun });
        expect(seen.map((c) => [...c])).toEqual([[1, 2]]);
        expect(outcome).toEqual({ interrupted: true, ceilingHit: false, endedCleanly: false });
    });

    test("the request ceiling stops the read and keeps the resource healthy", async () => {
        const { body } = trackedStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
        let overruns = 0;
        const { seen, outcome } = await drain(body, {
            uploadToken: VALID_ID,
            maxBytes: 3,
            onOverrun: async () => {
                overruns += 1;
            },
        });
        // The chunk that crossed is NOT yielded: the accepted prefix is what the
        // caller may make durable.
        expect(seen.map((c) => [...c])).toEqual([[1, 2]]);
        expect(outcome).toEqual({ interrupted: false, ceilingHit: true, endedCleanly: false });
        expect(overruns).toBe(0);
    });

    test("exactly maxBytes is under the ceiling, not over it", async () => {
        const { body } = trackedStream([new Uint8Array([1, 2, 3])]);
        const { seen, outcome } = await drain(body, {
            uploadToken: VALID_ID,
            maxBytes: 3,
            onOverrun: noOverrun,
        });
        expect(seen.map((c) => [...c])).toEqual([[1, 2, 3]]);
        expect(outcome.ceilingHit).toBe(false);
        expect(outcome.endedCleanly).toBe(true);
    });

    test("a representation bound records the invalidation BEFORE it throws", async () => {
        // Ordering is the point: a throw that outran the durable write would leave
        // an upload that accepts the next append as if nothing had happened.
        const order: string[] = [];
        const { body } = trackedStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
        const { chunks, finalize } = pumpUploadBody(body, VALID_ID, { maxBytes: 3, maxBytesFatal: true }, async () => {
            order.push("invalidated");
        });
        await expect(
            (async () => {
                for await (const _ of chunks) {
                    /* consume until it throws */
                }
            })(),
        ).rejects.toThrow(UploadOverrunError);
        order.push("threw");
        await finalize();
        expect(order).toEqual(["invalidated", "threw"]);
    });

    test("finalize after an early stop cancels the unread rest of the body", async () => {
        // Nothing downstream reads past the ceiling, so the producer is told to
        // stop rather than left streaming into a released reader.
        // A third chunk keeps the source open past the crossing read: pull runs
        // one chunk ahead, so two chunks would already have closed it.
        const stopped = trackedStream([new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])]);
        await drain(stopped.body, { uploadToken: VALID_ID, maxBytes: 3, onOverrun: noOverrun });
        expect(stopped.body.locked).toBe(false);
        expect(stopped.cancelled()).toBe(true);

        const ended = trackedStream([new Uint8Array([1])]);
        await drain(ended.body, { uploadToken: VALID_ID, onOverrun: noOverrun });
        expect(ended.cancelled()).toBe(false);
    });

    test("no ceiling means no ceiling", async () => {
        const { body } = trackedStream([new Uint8Array(1024)]);
        const { outcome } = await drain(body, { uploadToken: VALID_ID, onOverrun: noOverrun });
        expect(outcome.ceilingHit).toBe(false);
        expect(outcome.endedCleanly).toBe(true);
    });
});

describe("base64 codecs", () => {
    const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

    test("standard base64 is RFC 4648's, padding included", () => {
        // The RFC 4648 Section 10 test vectors.
        expect(bytesToBase64(ascii(""))).toBe("");
        expect(bytesToBase64(ascii("f"))).toBe("Zg==");
        expect(bytesToBase64(ascii("fo"))).toBe("Zm8=");
        expect(bytesToBase64(ascii("foo"))).toBe("Zm9v");
        expect(bytesToBase64(ascii("foobar"))).toBe("Zm9vYmFy");
    });

    test("base64url swaps every + and / and drops all padding", () => {
        // 0xfb 0xff 0xbf is "+/+/" in the standard alphabet, so a repeat proves
        // every occurrence is swapped, not the first.
        expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff, 0xbf, 0xfb, 0xff, 0xbf]))).toBe("-_-_-_-_");
        expect(bytesToBase64Url(new Uint8Array([0xfb]))).toBe("-w");
        expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    });

    test("base64url decodes with or without its padding", () => {
        expect([...base64UrlToBytes("-_-_-_-_")]).toEqual([0xfb, 0xff, 0xbf, 0xfb, 0xff, 0xbf]);
        expect([...base64UrlToBytes("-w")]).toEqual([0xfb]);
        expect([...base64UrlToBytes("-_8")]).toEqual([0xfb, 0xff]);
        expect([...base64UrlToBytes("-w==")]).toEqual([0xfb]);
        expect([...base64UrlToBytes("-_8=")]).toEqual([0xfb, 0xff]);
        expect([...base64UrlToBytes("")]).toEqual([]);
    });

    test("base64url round-trips any bytes", () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
                const encoded = bytesToBase64Url(bytes);
                expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
                expect([...base64UrlToBytes(encoded)]).toEqual([...bytes]);
            }),
            { numRuns: 300 },
        );
    });
});

describe("validatePersistedUploadShape", () => {
    const valid = {
        key: "a/b.bin",
        createdAt: 0,
        isComplete: false,
        isInvalidated: false,
    };

    test("a well-formed record passes as itself, optional fields included", () => {
        expect(validatePersistedUploadShape(valid)).toBe(valid);
        const full = {
            ...valid,
            length: 0,
            lastAppendAt: Number.MAX_SAFE_INTEGER,
            etag: '"e"',
            metadata: { filename: "b.bin" },
        };
        expect(validatePersistedUploadShape(full)).toBe(full);
        const emptyMetadata = { ...valid, metadata: {} };
        expect(validatePersistedUploadShape(emptyMetadata)).toBe(emptyMetadata);
    });

    test("anything that is not an object is refused", () => {
        for (const parsed of [null, undefined, "record", 7, true, []]) {
            expect(validatePersistedUploadShape(parsed)).toBeNull();
        }
    });

    test("every field is checked, each on its own", () => {
        // One bad field at a time, so a check dropped from the conjunction is
        // the only way the record could pass.
        const bad: Array<Record<string, unknown>> = [
            { key: "" },
            { key: 1 },
            { key: undefined },
            { length: -1 },
            { length: 1.5 },
            { length: "3" },
            { length: Number.NaN },
            { length: 2 ** 53 },
            { createdAt: undefined },
            { createdAt: -1 },
            { lastAppendAt: -1 },
            { lastAppendAt: "1" },
            { isComplete: "false" },
            { isComplete: undefined },
            { isInvalidated: 0 },
            { isInvalidated: undefined },
            { etag: 5 },
            { metadata: null },
            { metadata: "filename=b.bin" },
            { metadata: { size: 3 } },
            { metadata: { filename: "b.bin", size: 3 } },
        ];
        for (const override of bad) {
            expect(validatePersistedUploadShape({ ...valid, ...override })).toBeNull();
        }
    });
});

describe("toStoredState", () => {
    test("projects the bookkeeping plus the backend's offset, and nothing else", () => {
        const state = toStoredState(
            {
                key: "a/b.bin",
                length: 10,
                metadata: { filename: "b.bin" },
                createdAt: 1,
                lastAppendAt: 2,
                isComplete: true,
                isInvalidated: false,
                etag: '"e"',
            },
            7,
        );
        expect(state).toEqual({
            key: "a/b.bin",
            offset: 7,
            length: 10,
            status: "complete",
            createdAt: 1,
            lastAppendAt: 2,
            metadata: { filename: "b.bin" },
        });
        expect("etag" in state).toBe(false);
    });
});

describe("requireSweepCutoff", () => {
    test("a cutoff naming neither clock is refused", () => {
        expect(() => requireSweepCutoff({})).toThrow(
            new TypeError("sweepExpired: cutoff must name idleSinceMs, createdBeforeMs, or both"),
        );
    });

    test("each clock must be a finite instant, whichever the other is", () => {
        expect(() => requireSweepCutoff({ idleSinceMs: Number.NaN })).toThrow(
            new TypeError("sweepExpired: cutoff.idleSinceMs must be a finite epoch-ms instant, got NaN"),
        );
        expect(() => requireSweepCutoff({ idleSinceMs: 5, createdBeforeMs: Number.POSITIVE_INFINITY })).toThrow(
            new TypeError("sweepExpired: cutoff.createdBeforeMs must be a finite epoch-ms instant, got Infinity"),
        );
    });

    test("either clock alone, or both, is a cutoff", () => {
        expect(() => requireSweepCutoff({ idleSinceMs: 5 })).not.toThrow();
        expect(() => requireSweepCutoff({ createdBeforeMs: 0 })).not.toThrow();
        expect(() => requireSweepCutoff({ idleSinceMs: 5, createdBeforeMs: 5 })).not.toThrow();
    });
});

describe("isSweepable", () => {
    test("the idle clock reads the last append, or the creation when nothing was appended", () => {
        expect(isSweepable({ idleSinceMs: 10 }, 1, 9)).toBe(true);
        expect(isSweepable({ idleSinceMs: 10 }, 1, 10)).toBe(false);
        // A recent append keeps an old upload alive.
        expect(isSweepable({ idleSinceMs: 10 }, 1, 20)).toBe(false);
        expect(isSweepable({ idleSinceMs: 10 }, 9)).toBe(true);
        expect(isSweepable({ idleSinceMs: 10 }, 10)).toBe(false);
    });

    test("the lifetime clock reads the creation only", () => {
        expect(isSweepable({ createdBeforeMs: 10 }, 9, 50)).toBe(true);
        expect(isSweepable({ createdBeforeMs: 10 }, 10)).toBe(false);
    });

    test("either clock is enough on its own", () => {
        expect(isSweepable({ idleSinceMs: 10, createdBeforeMs: 5 }, 8)).toBe(true);
        expect(isSweepable({ idleSinceMs: 5, createdBeforeMs: 10 }, 8, 20)).toBe(true);
        expect(isSweepable({ idleSinceMs: 5, createdBeforeMs: 5 }, 8, 20)).toBe(false);
    });
});

describe("publishKeyGuard", () => {
    const guard = publishKeyGuard("uploads/");
    const refusal = 'Upload key is inside the reserved upload bookkeeping prefix "uploads/"';

    test("the bookkeeping prefix and everything under it are refused", () => {
        for (const key of ["uploads", "uploads/", "uploads/x", `uploads/${VALID_ID}.info`]) {
            expect(() => guard(key)).toThrow(new TypeError(refusal));
        }
    });

    test("a key that only resembles the prefix is allowed", () => {
        for (const key of ["uploadsx", "upload", "u", "x/uploads/y", "x/uploads", ""]) {
            expect(() => guard(key)).not.toThrow();
        }
    });
});

describe("openUploadBody", () => {
    test("empty chunks are skipped, and a buffered body is one chunk", async () => {
        const { body } = trackedStream([new Uint8Array(0), new Uint8Array([1]), new Uint8Array(0)]);
        const streamed = openUploadBody(body);
        expect([...((await streamed.iterator.next()).value ?? [])]).toEqual([1]);
        expect((await streamed.iterator.next()).done).toBe(true);

        const buffered = openUploadBody(new Uint8Array([2, 3]), () => cancelUploadBody(new Uint8Array([2, 3])));
        expect([...((await buffered.iterator.next()).value ?? [])]).toEqual([2, 3]);
        expect((await buffered.iterator.next()).done).toBe(true);
        await buffered.finalize();

        const empty = openUploadBody(new Uint8Array(0));
        expect((await empty.iterator.next()).done).toBe(true);
    });

    test("finalize after an early stop releases the stream, and runs the release it was given", async () => {
        const kept = trackedStream([new Uint8Array([1]), new Uint8Array([2])]);
        const keep = openUploadBody(kept.body);
        await keep.iterator.next();
        expect(kept.body.locked).toBe(true);
        await keep.finalize();
        expect(kept.body.locked).toBe(false);
        expect(kept.cancelled()).toBe(false);

        const dropped = trackedStream([new Uint8Array([1]), new Uint8Array([2])]);
        const drop = openUploadBody(dropped.body, () => cancelUploadBody(dropped.body));
        await drop.iterator.next();
        await drop.finalize();
        expect(dropped.body.locked).toBe(false);
        expect(dropped.cancelled()).toBe(true);
    });
});

describe("cancelUploadBody", () => {
    test("cancelling a stream that already failed does not raise", async () => {
        const failed = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.error(new Error("disconnected"));
            },
        });
        await expect(cancelUploadBody(failed)).resolves.toBeUndefined();
        await expect(cancelUploadBody(new Uint8Array([1]))).resolves.toBeUndefined();
    });
});

describe("assertUploadWritable", () => {
    test("an invalidated upload refuses both operations, and says so even once complete", () => {
        expect(() => assertUploadWritable({ isInvalidated: true }, "append")).toThrow(
            new Error("Upload is invalidated; nothing may be appended"),
        );
        expect(() => assertUploadWritable({ isInvalidated: true, isComplete: true }, "append")).toThrow(
            new Error("Upload is invalidated; nothing may be appended"),
        );
        expect(() => assertUploadWritable({ isInvalidated: true, isComplete: true }, "complete")).toThrow(
            new Error("Upload is invalidated; it cannot be completed"),
        );
    });

    test("a complete upload refuses an append but not a repeated completion", () => {
        expect(() => assertUploadWritable({ isComplete: true }, "append")).toThrow(
            new Error("Upload is already complete; nothing may be appended"),
        );
        expect(() => assertUploadWritable({ isComplete: true }, "complete")).not.toThrow();
    });

    test("a live upload takes either", () => {
        expect(() => assertUploadWritable({}, "append")).not.toThrow();
        expect(() => assertUploadWritable({ isInvalidated: false, isComplete: false }, "complete")).not.toThrow();
    });
});
