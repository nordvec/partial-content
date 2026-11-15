import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { removeTree } from "./temp-cleanup.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkObjectStore, formatConformanceReport, runConformanceCheck, tallyConformance } from "../conformance";
import type { ConformanceAssert, ConformanceReport } from "../conformance";
import { memoryStore } from "../memory";
import { fsStore } from "../fs";
import type { ObjectStore } from "../index";

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pc-conformance-"));
});
afterEach(async () => {
    await removeTree(root);
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
    return memoryStore({
        objects: {
            "docs/sample.bin": { body: CONTENT, etag: '"v1"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" },
        },
    });
}

describe("checkObjectStore", () => {
    test("memoryStore satisfies every read obligation", async () => {
        const report = await checkObjectStore(servedMemoryStore(), {
            key: "docs/sample.bin",
            content: CONTENT,
        });
        expect(report.checks.filter((c) => !c.ok && !c.skipped).map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
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
        expect(report.checks.find((c) => c.name === "range-reports-an-honest-total")?.detail).toContain(
            "Content-Range total",
        );
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
        expect(report.checks.find((c) => c.name === "missing-object-is-not-found")?.detail).toContain(
            "backend failure",
        );
    });

    test("a store that maps not-found on head only is caught on the read path", async () => {
        // A plain GET calls getObject with no HEAD first, so a getObject that
        // surfaces the backend's own error answers 502 for a missing object.
        const inner = servedMemoryStore();
        const headOnly: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                try {
                    return await inner.getObject(key, opts);
                } catch {
                    throw new Error("backend said no");
                }
            },
        };
        const report = await checkObjectStore(headOnly, { key: "docs/sample.bin", content: CONTENT });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => c.name === "missing-object-is-not-found-on-read")?.detail).toContain(
            "backend failure",
        );
        expect(report.checks.find((c) => c.name === "missing-object-is-not-found")?.ok).toBe(true);
    });

    test("a store that fails the ranged read of an absent key only is caught", async () => {
        const inner = servedMemoryStore();
        const rangeOnly: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                try {
                    return await inner.getObject(key, opts);
                } catch (err) {
                    if (opts?.range) throw new Error("backend said no");
                    throw err;
                }
            },
        };
        const report = await checkObjectStore(rangeOnly, { key: "docs/sample.bin", content: CONTENT });
        expect(report.checks.find((c) => c.name === "missing-object-is-not-found-on-read")?.ok).toBe(false);
    });

    // Each store below serves the wrong thing through the serving path while every
    // pre-existing obligation holds; the named check is the one that must fail.
    const failedChecks = async (store: ObjectStore): Promise<string[]> => {
        const report = await checkObjectStore(store, { key: "docs/sample.bin", content: CONTENT });
        return report.checks.filter((c) => !c.ok && !c.skipped).map((c) => c.name);
    };

    test("a store that shifts the served bounds is caught", async () => {
        const inner = servedMemoryStore();
        const shifted: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                const s = await inner.getObject(key, opts);
                return s.range ? { ...s, range: { start: s.range.start - 1, end: s.range.end - 1 } } : s;
            },
        };
        expect(await failedChecks(shifted)).toContain("range-serves-the-requested-window");
    });

    const last = CONTENT.byteLength - 1;
    const windows: [name: string, hit: (r: { start: number; end: number | undefined }) => boolean][] = [
        ["start-anchored", (r) => r.start === 0],
        ["end-anchored", (r) => r.end === last && r.start < last],
        ["last-byte", (r) => r.start === last && r.end === last],
    ];
    for (const [name, hit] of windows) {
        test(`a store that mislabels only the ${name} window is caught`, async () => {
            const inner = servedMemoryStore();
            const mislabels: ObjectStore = {
                ...inner,
                getObject: async (key, opts) => {
                    const s = await inner.getObject(key, opts);
                    return opts?.range && hit(opts.range) && s.range
                        ? { ...s, range: { start: s.range.start, end: s.range.end - 1 } }
                        : s;
                },
            };
            expect(await failedChecks(mislabels)).toContain("range-serves-the-requested-window");
        });
    }

    test("a store that reports a window's digest on a ranged read is caught", async () => {
        const inner = servedMemoryStore();
        const windowDigest: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                const s = await inner.getObject(key, opts);
                return opts?.range ? { ...s, digest: Buffer.alloc(32, 9).toString("base64") } : s;
            },
        };
        expect(await failedChecks(windowDigest)).toContain("digest-is-the-whole-representation");
    });

    test("a store that reports no total on a full read is caught", async () => {
        const inner = servedMemoryStore();
        const noTotal: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                const s = await inner.getObject(key, opts);
                return opts?.range ? s : { ...s, totalSize: undefined };
            },
        };
        expect(await failedChecks(noTotal)).toContain("full-read-returns-every-byte");
    });

    test("a store whose HEAD and GET spell Last-Modified differently is caught", async () => {
        const inner = servedMemoryStore();
        const respelled: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                const s = await inner.getObject(key, opts);
                return { ...s, lastModified: "Wed, 1 Jan 2025 00:00:00 +0000" };
            },
        };
        expect(await failedChecks(respelled)).toContain("get-validators-agree-with-head");
    });

    test("an authoritative store that misreads an open range is caught", async () => {
        const inner = servedMemoryStore();
        const misreads: ObjectStore = {
            ...inner,
            getObject: async (key, opts) =>
                inner.getObject(
                    key,
                    opts?.range && opts.range.end === undefined
                        ? { ...opts, range: { start: opts.range.start, end: opts.range.start } }
                        : opts,
                ),
        };
        expect(await failedChecks(misreads)).toContain("open-ended-range-reads-to-the-end");
    });

    test("an authoritative store that does not clamp a past-EOF end is caught", async () => {
        const inner = servedMemoryStore();
        const unclamped: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                const s = await inner.getObject(key, opts);
                const asked = opts?.range?.end;
                return asked !== undefined && s.range && asked >= CONTENT.byteLength
                    ? { ...s, range: { start: s.range.start, end: asked } }
                    : s;
            },
        };
        expect(await failedChecks(unclamped)).toContain("past-eof-end-is-clamped");
    });

    test("a store that ignores the pin and serves other bytes is caught", async () => {
        const inner = servedMemoryStore();
        const ignoresPin: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                const s = await inner.getObject(key, opts);
                return opts?.ifMatch ? { ...s, body: new Uint8Array(s.contentLength) } : s;
            },
        };
        expect(await failedChecks(ignoresPin)).toContain("pinned-read-serves-the-heads-representation");
    });

    test("a store that ignores ifMatch and reports no validator on the read is caught", async () => {
        // The HEAD names "v1"; the read is served from whatever the object is
        // now and says nothing, so the serving path would label it "v1".
        const inner = servedMemoryStore();
        const silent: ObjectStore = {
            ...inner,
            pinsReads: undefined,
            getObject: async (key, opts) => {
                const s = await inner.getObject(key, { ...opts, ifMatch: undefined });
                return { ...s, etag: undefined, lastModified: undefined };
            },
        };
        const report = await checkObjectStore(silent, { key: "docs/sample.bin", content: CONTENT });
        const probe = report.checks.find((c) => c.name === "mismatched-pin-is-refused-or-named");
        expect(probe?.ok).toBe(false);
        expect(probe?.detail).toContain("neither pins a read nor names the representation it served");
    });

    test("a store that ignores ifMatch but names the representation it served passes the probe", async () => {
        const inner = servedMemoryStore();
        const naming: ObjectStore = {
            ...inner,
            pinsReads: undefined,
            getObject: (key, opts) => inner.getObject(key, { ...opts, ifMatch: undefined }),
        };
        expect(await failedChecks(naming)).toEqual([]);
    });

    test("a store declaring pinsReads that serves a mismatching pin is caught", async () => {
        const inner = servedMemoryStore();
        const liar: ObjectStore = {
            ...inner,
            pinsReads: true,
            getObject: (key, opts) => inner.getObject(key, { ...opts, ifMatch: undefined }),
        };
        const probe = (await checkObjectStore(liar, { key: "docs/sample.bin", content: CONTENT })).checks.find(
            (c) => c.name === "mismatched-pin-is-refused-or-named",
        );
        expect(probe?.ok).toBe(false);
        expect(probe?.detail).toContain("pinsReads is declared");
    });

    test("a store that refuses a mismatching pin with another error is caught", async () => {
        const inner = servedMemoryStore();
        const wrongError: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                if (opts?.ifMatch === '"partial-content-conformance-mismatch"') throw new Error("412 from backend");
                return inner.getObject(key, opts);
            },
        };
        expect(await failedChecks(wrongError)).toContain("mismatched-pin-is-refused-or-named");
    });

    test("a store that resolves a read of the missing key has the stream released", async () => {
        const inner = servedMemoryStore();
        let cancelled = 0;
        const resolves: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                if (key === "docs/sample.bin") return inner.getObject(key, opts);
                return {
                    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
                        cancel() {
                            cancelled++;
                        },
                    }),
                    contentLength: 0,
                    totalSize: 0,
                };
            },
        };
        const check = (await checkObjectStore(resolves, { key: "docs/sample.bin", content: CONTENT })).checks.find(
            (c) => c.name === "missing-object-is-not-found-on-read",
        );
        expect(check?.ok).toBe(false);
        // The first unmet obligation ends the check, so the stream the whole read opened is the one released.
        expect(cancelled).toBe(1);
    });

    test("a store whose call never settles fails that check instead of hanging the run", async () => {
        const inner = servedMemoryStore();
        const hangs: ObjectStore = {
            ...inner,
            getObject: (key, opts) => (opts?.range ? new Promise<never>(() => undefined) : inner.getObject(key, opts)),
        };
        const report = await checkObjectStore(hangs, { key: "docs/sample.bin", content: CONTENT, timeoutMs: 100 });
        const stuck = report.checks.find((c) => c.name === "range-serves-the-requested-window");
        expect(stuck?.ok).toBe(false);
        expect(stuck?.detail).toContain("did not settle");
        expect(report.checks.find((c) => c.name === "head-reports-the-true-length")?.ok).toBe(true);
    });

    test("the call a timed-out check abandoned is aborted, and a body that arrives late is cancelled", async () => {
        const inner = servedMemoryStore();
        const seen: Array<AbortSignal | undefined> = [];
        let lateBodyCancelled = false;
        let release: (() => void) | undefined;
        const slow: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => {
                if (!opts?.range) return inner.getObject(key, opts);
                seen.push(opts.signal);
                // Answers only once the harness has given up on it.
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                return {
                    ...(await inner.getObject(key, opts)),
                    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
                        cancel() {
                            lateBodyCancelled = true;
                        },
                    }),
                };
            },
        };
        const pending = checkObjectStore(slow, { key: "docs/sample.bin", content: CONTENT, timeoutMs: 100 });
        while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(seen[0]?.aborted).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(seen[0]?.aborted).toBe(true);
        release?.();
        const report = await pending;
        expect(report.checks.find((c) => c.name === "range-serves-the-requested-window")?.detail).toContain(
            "did not settle",
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(lateBodyCancelled).toBe(true);
    });

    test("a body that never ends is cancelled when its check times out", async () => {
        const inner = servedMemoryStore();
        let cancelled = 0;
        const endless: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => ({
                ...(await inner.getObject(key, opts)),
                body: new ReadableStream<Uint8Array<ArrayBuffer>>({
                    pull: () => new Promise<void>(() => undefined),
                    cancel() {
                        cancelled++;
                    },
                }),
            }),
        };
        await checkObjectStore(endless, { key: "docs/sample.bin", content: CONTENT, timeoutMs: 100 });
        expect(cancelled).toBeGreaterThan(0);
    });

    test("a body that never ends fails its check", async () => {
        const inner = servedMemoryStore();
        const endless: ObjectStore = {
            ...inner,
            getObject: async (key, opts) => ({
                ...(await inner.getObject(key, opts)),
                body: new ReadableStream<Uint8Array<ArrayBuffer>>({ pull: () => new Promise<void>(() => undefined) }),
            }),
        };
        const report = await checkObjectStore(endless, { key: "docs/sample.bin", content: CONTENT, timeoutMs: 100 });
        expect(report.checks.find((c) => c.name === "full-read-returns-every-byte")?.detail).toContain(
            "did not settle",
        );
    });

    test("a store that reports contentEncoding on HEAD only is caught", async () => {
        const inner = servedMemoryStore();
        const headOnly: ObjectStore = {
            ...inner,
            headObject: async (key, opts) => ({ ...(await inner.headObject(key, opts)), contentEncoding: "gzip" }),
        };
        const check = (await checkObjectStore(headOnly, { key: "docs/sample.bin", content: CONTENT })).checks.find(
            (c) => c.name === "get-validators-agree-with-head",
        );
        expect(check?.ok).toBe(false);
        expect(check?.detail).toContain("contentEncoding");
    });

    test("a store that reports a coding in a non-normal form is caught on both sides", async () => {
        const inner = servedMemoryStore();
        const spelled: ObjectStore = {
            ...inner,
            headObject: async (key, opts) => ({ ...(await inner.headObject(key, opts)), contentEncoding: "GZip" }),
            getObject: async (key, opts) => ({ ...(await inner.getObject(key, opts)), contentEncoding: "GZip" }),
        };
        const check = (await checkObjectStore(spelled, { key: "docs/sample.bin", content: CONTENT })).checks.find(
            (c) => c.name === "get-validators-agree-with-head",
        );
        expect(check?.ok).toBe(false);
        expect(check?.detail).toContain("representationCoding");
    });

    test("a store declaring no range support has those checks reported unverified", async () => {
        const inner = servedMemoryStore();
        const noRange: ObjectStore = { ...inner, supportsRange: false };
        const report = await checkObjectStore(noRange, { key: "docs/sample.bin", content: CONTENT });
        expect(report.ok).toBe(true);
        // Skipped rather than passed: the obligation went unverified and the
        // report says which and why.
        expect(report.skipped).toBe(4);
    });
});

// ─── What a pass costs ──────────────────────────────────────────────────────

describe("a check body that observes nothing cannot report a pass", () => {
    // The failure this guard deletes is not a wrong verdict, it is an invented
    // one: a check with a name, an obligation, a green mark, and a body that
    // asked the store nothing. It is indistinguishable from coverage, which is
    // why it has to be impossible to write rather than something review catches.

    test("an empty body fails, and says that is why", async () => {
        const check = await runConformanceCheck("observes-nothing", "an obligation", async () => {
            // Deliberately empty: this is the shape under test.
        });
        expect(check.ok).toBe(false);
        expect(check.skipped).toBeUndefined();
        expect(check.detail).toContain("made no assertion");
        expect(formatConformanceReport(tallyConformance([check]))).toContain("FAIL  observes-nothing");
    });

    test("a body that does the work and reports none of it fails the same way", async () => {
        // Closer to how one is really written: the body exercises the store,
        // states its property in a comment, and reads nothing back.
        const worked: string[] = [];
        const check = await runConformanceCheck("looks-and-says-nothing", "an obligation", async () => {
            worked.push("published, then aborted");
        });
        expect(worked).toEqual(["published, then aborted"]);
        expect(check.ok).toBe(false);
        expect(check.detail).toContain("made no assertion");
    });

    test("one observation that holds is what a pass costs", async () => {
        const check = await runConformanceCheck(
            "observes-one-thing",
            "an obligation",
            async (assert: ConformanceAssert) => {
                assert(true, "unreachable detail");
            },
        );
        expect(check).toEqual({ name: "observes-one-thing", obligation: "an obligation", ok: true });
    });

    test("the first unmet obligation ends the body", async () => {
        // Later assertions would run against state the first failure already
        // invalidated, and the report can only carry one detail anyway.
        const reached: string[] = [];
        const check = await runConformanceCheck(
            "stops-at-the-first",
            "an obligation",
            async (assert: ConformanceAssert) => {
                assert(reached.length > 0, "the obligation that went unmet");
                reached.push("kept going");
            },
        );
        expect(check.detail).toBe("the obligation that went unmet");
        expect(reached).toEqual([]);
    });

    test("a body that throws is a failed check carrying what it threw", async () => {
        const check = await runConformanceCheck("throws", "an obligation", async () => {
            throw new TypeError("the backend went away");
        });
        expect(check.ok).toBe(false);
        expect(check.detail).toBe("threw TypeError: the backend went away");
    });

    test("no check in the harness reports a verdict it did not look for", async () => {
        // The harness builds every verdict from runConformanceCheck, so a check that passes is a check that
        // asserted. This run passes every obligation it executes, which is what proves no body returns green
        // without observing the store.
        const read = await checkObjectStore(servedMemoryStore(), {
            key: "docs/sample.bin",
            content: CONTENT,
        });
        expect(read.checks.length).toBeGreaterThan(5);
        expect(read.checks.filter((c) => !c.ok || c.skipped)).toEqual([]);
    });

    test("an obligation of the caller's own folds into the report under the same rule", async () => {
        // A store author with backend-specific obligations extends a run this
        // way, and an empty one of theirs is caught exactly as an empty one of
        // ours is.
        const report = await checkObjectStore(servedMemoryStore(), {
            key: "docs/sample.bin",
            content: CONTENT,
        });
        const mine = await runConformanceCheck("my-own-obligation", "an obligation", async () => {
            // Deliberately empty: an added check gets no exemption.
        });
        const extended = tallyConformance([...report.checks, mine]);
        expect(extended.ok).toBe(false);
        expect(extended.failed).toBe(1);
        expect(extended.passed).toBe(report.passed);
    });
});
