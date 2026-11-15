import { describe, expect, test } from "bun:test";
import { VariantHits, VariantMisses } from "../variant-misses";

describe("VariantMisses", () => {
    test("a miss holds for the window and not after it", () => {
        const misses = new VariantMisses(1000, 10, 100);
        misses.add("a.br", 0);
        expect(misses.has("a.br", 999)).toBe(true);
        expect(misses.has("a.br", 1000)).toBe(false);
        expect(misses.size).toBe(0); // the expired entry went with the lookup
    });

    test("adding purges every expired entry, so a quiet key does not pin memory", () => {
        const misses = new VariantMisses(1000, 100, 100);
        for (let i = 0; i < 50; i++) misses.add(`k${i}.br`, 0);
        expect(misses.size).toBe(50);
        misses.add("fresh.br", 5000);
        expect(misses.size).toBe(1);
    });

    test("the count is bounded and the oldest entry goes first", () => {
        const misses = new VariantMisses(1_000_000, 3, 100);
        for (const key of ["a", "b", "c", "d"]) misses.add(key, 1);
        expect(misses.size).toBe(3);
        expect(misses.has("a", 2)).toBe(false);
        expect(misses.has("d", 2)).toBe(true);
    });

    test("a key past the length bound is not held", () => {
        const misses = new VariantMisses(1000, 10, 8);
        misses.add("123456789", 0);
        expect(misses.size).toBe(0);
        misses.add("12345678", 0);
        expect(misses.size).toBe(1);
    });

    test("a found variant is forgotten", () => {
        const misses = new VariantMisses(1000, 10, 100);
        misses.add("a.br", 0);
        misses.delete("a.br");
        expect(misses.has("a.br", 1)).toBe(false);
    });
});

describe("VariantHits", () => {
    test("holds the same bounds as the misses: window, count and key length", () => {
        const hits = new VariantHits(1000, 2, 8);
        hits.add("a.br", 0);
        hits.add("b.br", 1);
        hits.add("c.br", 2);
        expect(hits.has("a.br", 3)).toBe(false);
        expect(hits.has("c.br", 999)).toBe(true);
        expect(hits.has("c.br", 1002)).toBe(false);
        hits.add("too-long-a-key.br", 3);
        expect(hits.has("too-long-a-key.br", 4)).toBe(false);
    });
});
