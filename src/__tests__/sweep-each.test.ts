import { describe, test, expect } from "bun:test";
import { sweepEach } from "../sweep-each";

async function* listing<T>(items: T[]): AsyncGenerator<T> {
    for (const item of items) yield item;
}

describe("sweepEach", () => {
    test("counts removals, skips what is not due, and isolates each failure", async () => {
        const seen: string[] = [];
        const result = await sweepEach(["due", "fresh", "denied", "due-2"], async (item) => {
            seen.push(item);
            if (item === "denied") throw new Error("403");
            return item.startsWith("due");
        });
        expect(result).toEqual({ removed: 2, failed: 1 });
        // A failure does not end the scan: the resource behind it is still reclaimed.
        expect(seen).toEqual(["due", "fresh", "denied", "due-2"]);
    });

    test("walks an async listing", async () => {
        expect(await sweepEach(listing([1, 2, 3]), async (n) => n !== 2)).toEqual({ removed: 2, failed: 0 });
    });

    test("an abort during a reclaim rejects with the reason instead of being counted", async () => {
        const controller = new AbortController();
        const seen: number[] = [];
        const swept = sweepEach(
            [1, 2],
            async (n) => {
                seen.push(n);
                controller.abort(new Error("shutdown"));
                throw new Error("request aborted");
            },
            { signal: controller.signal },
        );
        await expect(swept).rejects.toThrow("shutdown");
        expect(seen).toEqual([1]);
    });

    test("an already-aborted signal reclaims nothing", async () => {
        const controller = new AbortController();
        controller.abort(new Error("shutdown"));
        let calls = 0;
        await expect(sweepEach([1], async () => (calls += 1) > 0, { signal: controller.signal })).rejects.toThrow(
            "shutdown",
        );
        expect(calls).toBe(0);
    });

    test("options without a signal sweep and isolate failures like no options at all", async () => {
        const result = await sweepEach(
            ["due", "denied"],
            async (item) => {
                if (item === "denied") throw new Error("403");
                return true;
            },
            {},
        );
        expect(result).toEqual({ removed: 1, failed: 1 });
    });

    test("a listing that cannot be enumerated propagates: there is no resource to count it against", async () => {
        async function* broken(): AsyncGenerator<number> {
            yield 1;
            throw new Error("list denied");
        }
        await expect(sweepEach(broken(), async () => true)).rejects.toThrow("list denied");
    });
});
