import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkResumableWriteStore, checkObjectStore, formatConformanceReport } from "../conformance";
import type { ConformanceReport } from "../conformance";
import { memoryUploadStore, memoryStore } from "../memory";
import { fsUploadStore, fsStore } from "../fs";
import type { ResumableWriteStore } from "../upload-store";
import type { ObjectStore } from "../index";

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pc-conformance-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const failedNames = (checks: { name: string; ok: boolean; skipped?: boolean }[]) =>
    checks.filter((c) => !c.ok && !c.skipped).map((c) => c.name);

describe("the built-in stores satisfy the contract they document", () => {
    test("fsUploadStore passes every check, restart obligations included", async () => {
        const report = await checkResumableWriteStore(() => fsUploadStore({ root }));
        expect(failedNames(report.checks)).toEqual([]);
        expect(report.skipped).toBe(0);
        expect(report.ok).toBe(true);
    });

    test("memoryUploadStore passes, with the cross-instance checks reported as unverified", async () => {
        const objects = {};
        const report = await checkResumableWriteStore(
            () => memoryUploadStore({ objects }),
            { restartable: false },
        );
        expect(failedNames(report.checks)).toEqual([]);
        // Skipped, not passed: an in-process store cannot demonstrate durability
        // across instances, and the report says so rather than implying it did.
        expect(report.skipped).toBeGreaterThan(0);
        expect(report.ok).toBe(true);
    });
});

describe("the harness catches a store that does not do what it declares", () => {
    /**
     * A store that reports `enforcesOffsetCheck: true` and ignores the claimed
     * offset. This is the dangerous shape, because it presents as working: every
     * append lands and every upload completes, and the guarantee is absent only
     * when a lock is stolen from a holder that stalled past its TTL.
     */
    function storeThatSkipsTheOffsetCheck(): ResumableWriteStore {
        const real = memoryUploadStore({ objects: {} });
        return {
            ...real,
            enforcesOffsetCheck: true,
            async appendChunk(token, _offset, body, opts) {
                const state = await real.getUploadState(token);
                return real.appendChunk(token, state.offset, body, opts);
            },
        };
    }

    test("a declared offset check that is not performed fails, on both directions", async () => {
        const report = await checkResumableWriteStore(
            storeThatSkipsTheOffsetCheck,
            { restartable: false },
        );
        expect(report.ok).toBe(false);
        expect(failedNames(report.checks)).toEqual(["refuses-stale-offset", "refuses-future-offset"]);
        // The message has to say what the consequence is, not just that a check
        // failed, because the author reading it believes their store is correct.
        const stale = report.checks.find((c) => c.name === "refuses-stale-offset");
        expect(stale?.detail).toContain("declared but not implemented");
    });

    test("tokens minted from a counter fail, however long they are", async () => {
        const real = memoryUploadStore({ objects: {} });
        const map = new Map<string, string>();
        let n = 0;
        const guessable: ResumableWriteStore = {
            ...real,
            async createUpload(opts) {
                const { uploadToken } = await real.createUpload(opts);
                // Long enough to clear a length check, ordered enough to be guessed.
                const pretty = `upload-from-a-counter-not-a-csprng-${String(n++).padStart(6, "0")}`;
                map.set(pretty, uploadToken);
                return { uploadToken: pretty };
            },
            getUploadState: (t, o) => real.getUploadState(map.get(t) ?? t, o),
            appendChunk: (t, off, b, o) => real.appendChunk(map.get(t) ?? t, off, b, o),
            completeUpload: (t, o) => real.completeUpload(map.get(t) ?? t, o),
            abortUpload: (t, o) => real.abortUpload(map.get(t) ?? t, o),
        };

        const report = await checkResumableWriteStore(() => guessable, { restartable: false });
        expect(failedNames(report.checks)).toContain("token-is-unguessable");
        expect(report.checks.find((c) => c.name === "token-is-unguessable")?.detail)
            .toContain("counter or a timestamp");
    });

    test("a store that returns normally after crossing a representation bound fails", async () => {
        const real = memoryUploadStore({ objects: {} });
        const swallowing: ResumableWriteStore = {
            ...real,
            async appendChunk(token, offset, body, opts) {
                try {
                    return await real.appendChunk(token, offset, body, opts);
                } catch {
                    // The pre-4.0 shape: invalidate, then answer as if it worked.
                    return { bytesWritten: opts.maxBytes ?? 0 };
                }
            },
        };
        const report = await checkResumableWriteStore(() => swallowing, { restartable: false });
        expect(failedNames(report.checks)).toContain("representation-bound-invalidates");
    });
});

describe("the report", () => {
    // The formatter is a pure function of a report, so it is fed one directly.
    // Driving a real store here would spend a filesystem conformance pass to
    // assert string shape, and make a formatting test fail for I/O reasons.
    const report: ConformanceReport = {
        ok: false,
        passed: 1,
        failed: 1,
        skipped: 1,
        checks: [
            { name: "refuses-stale-offset", obligation: "o", ok: true },
            { name: "offset-is-backend-derived", obligation: "o", ok: true, skipped: true, detail: "why" },
            { name: "representation-bound-invalidates", obligation: "o", ok: false, detail: "returned normally" },
        ],
    };

    test("renders a verdict per check, with the detail on the ones that carry it", () => {
        const text = formatConformanceReport(report);
        expect(text).toContain("PASS  refuses-stale-offset");
        expect(text).toContain("SKIP  offset-is-backend-derived");
        expect(text).toContain("FAIL  representation-bound-invalidates");
        // A failure the reader cannot act on is only half a report.
        expect(text).toContain("returned normally");
    });

    test("ends with the tally", () => {
        expect(formatConformanceReport(report)).toContain("1 passed, 1 failed, 1 skipped");
    });
});

// ─── The read contract, and a store that does not meet it ───────────────────

const CONTENT = new TextEncoder().encode("conformance-read-side-sample-bytes");

function servedMemoryStore() {
    return memoryStore({ objects: { "docs/sample.bin": { body: CONTENT } } });
}

describe("checkObjectStore", () => {
    test("memoryStore satisfies every read obligation", async () => {
        const report = await checkObjectStore(servedMemoryStore(), {
            key: "docs/sample.bin",
            content: CONTENT,
        });
        expect(report.checks.filter((c) => !c.ok && !c.skipped).map((c) => `${c.name}: ${c.detail}`))
            .toEqual([]);
        expect(report.ok).toBe(true);
    });

    test("fsStore satisfies them too, over a real filesystem", async () => {
        // The suite already owns a fresh root per test and removes it after,
        // so a second temp directory here would only add a lifecycle to race.
        await mkdir(join(root, "docs"), { recursive: true });
        await writeFile(join(root, "docs", "sample.bin"), CONTENT);

        const report = await checkObjectStore(fsStore({ root }), {
            key: "docs/sample.bin",
            content: CONTENT,
        });

        expect(report.checks.filter((c) => !c.ok && !c.skipped).map((c) => c.name)).toEqual([]);
        expect(report.ok).toBe(true);
    });

    test("a store that overstates the total on a partial read is caught", async () => {
        // The number becomes the Content-Range total, so a client sizes its
        // remaining requests against it and runs off the end of the object.
        const inner = servedMemoryStore();
        const lying: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                const s = await inner.getObject(key, opts);
                return opts?.range ? { ...s, totalSize: CONTENT.byteLength + 100 } : s;
            },
        };
        const report = await checkObjectStore(lying, { key: "docs/sample.bin", content: CONTENT });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => c.name === "range-reports-an-honest-total")?.detail)
            .toContain("Content-Range total");
    });

    test("a store whose absent key is an ordinary failure is caught", async () => {
        const inner = servedMemoryStore();
        const opaque: ObjectStore = {
            ...inner,
            headObject: async (key, opts) => {
                try {
                    return await inner.headObject(key, opts);
                } catch {
                    // The shape that turns a missing object into a 502 the
                    // caller's cache will retry indefinitely.
                    throw new Error("backend said no");
                }
            },
        };
        const report = await checkObjectStore(opaque, { key: "docs/sample.bin", content: CONTENT });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => c.name === "missing-object-is-not-found")?.detail)
            .toContain("backend failure");
    });

    test("a store declaring no range support has those checks reported unverified", async () => {
        const inner = servedMemoryStore();
        const noRange: ObjectStore = { ...inner, supportsRange: false };
        const report = await checkObjectStore(noRange, { key: "docs/sample.bin", content: CONTENT });
        expect(report.ok).toBe(true);
        // Skipped rather than passed: the obligation went unverified and the
        // report says which and why.
        expect(report.skipped).toBe(2);
    });
});
