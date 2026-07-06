import { describe, test, expect } from "bun:test";
import { parseRangeHeader, parseContentRange } from "../index";
import { buildContentDisposition } from "../content-disposition";

/**
 * Randomized invariant tests for the public parsers.
 *
 * These functions face raw attacker-controlled header bytes on every
 * request, so beyond example-based tests we assert structural invariants
 * over a large randomized corpus:
 *
 *   1. Never throw, whatever the input.
 *   2. When a range parses, its bounds are internally consistent and
 *      within the representation.
 *   3. Content-Disposition output is always header-safe (no CR/LF).
 *
 * The PRNG is seeded so failures reproduce deterministically.
 */

// ─── Deterministic PRNG (mulberry32) ────────────────────────────────────────

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rand = mulberry32(0xC0FFEE);

/** Characters likely to stress the parsers: digits, separators, controls, unicode. */
const ALPHABET = "0123456789-,=bytesBYTES */\t\r\n\0%\"'W/\\..‮😀abcxyz";

function randomString(maxLen: number): string {
    const len = Math.floor(rand() * maxLen);
    let s = "";
    for (let i = 0; i < len; i++) {
        s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
    }
    return s;
}

/** Bias half the corpus toward almost-valid range syntax to reach deep branches. */
function almostValidRange(): string {
    const start = Math.floor(rand() * 2000) - 500;
    const end = Math.floor(rand() * 2000) - 500;
    const forms = [
        `bytes=${start}-${end}`,
        `bytes=${start}-`,
        `bytes=-${end}`,
        `bytes=${start}-${end},${end}-${start}`,
        `Bytes=${start} - ${end}`,
        `bytes${start}-${end}`,
        `bytes=${start}.5-${end}`,
        `bytes=${"9".repeat(Math.floor(rand() * 25) + 1)}-`,
    ];
    return forms[Math.floor(rand() * forms.length)];
}

const ITERATIONS = 5000;

// ─── Invariants ─────────────────────────────────────────────────────────────

describe("parseRangeHeader invariants", () => {
    test("never throws; parsed bounds are always consistent and in-range", () => {
        for (let i = 0; i < ITERATIONS; i++) {
            const header = i % 2 === 0 ? randomString(40) : almostValidRange();
            const totalSize = Math.floor(rand() * 10_000);

            const result = parseRangeHeader(header, totalSize);

            if (result !== null && result !== "unsatisfiable") {
                // Invariant: 0 <= start <= end < totalSize
                expect(result.start).toBeGreaterThanOrEqual(0);
                expect(result.end).toBeGreaterThanOrEqual(result.start);
                expect(result.end).toBeLessThan(totalSize);
                expect(Number.isSafeInteger(result.start)).toBe(true);
                expect(Number.isSafeInteger(result.end)).toBe(true);
            }
        }
    });

    test("never throws on hostile totalSize values", () => {
        const sizes = [NaN, Infinity, -Infinity, -1, 0.5, 2 ** 53, -0, Number.MAX_VALUE];
        for (const size of sizes) {
            expect(parseRangeHeader("bytes=0-499", size)).toBeNull();
        }
    });
});

describe("parseContentRange invariants", () => {
    test("never throws; parsed values are always consistent", () => {
        for (let i = 0; i < ITERATIONS; i++) {
            const header = i % 2 === 0
                ? randomString(40)
                : `bytes ${Math.floor(rand() * 1000)}-${Math.floor(rand() * 1000)}/${rand() < 0.5 ? "*" : Math.floor(rand() * 2000)}`;

            const result = parseContentRange(header);

            if (result !== null) {
                expect(result.start).toBeGreaterThanOrEqual(0);
                expect(result.end).toBeGreaterThanOrEqual(result.start);
                if (result.totalSize !== -1) {
                    expect(result.end).toBeLessThan(result.totalSize);
                }
            }
        }
    });
});

describe("buildContentDisposition invariants", () => {
    test("output is always header-safe for arbitrary filenames", () => {
        for (let i = 0; i < ITERATIONS; i++) {
            const filename = randomString(60);

            const value = buildContentDisposition(filename, {
                type: rand() < 0.5 ? "inline" : "attachment",
            });

            // Invariant: no header injection vectors survive.
            expect(value).not.toContain("\r");
            expect(value).not.toContain("\n");
            expect(value).not.toContain("\0");
            // Invariant: always starts with the disposition type.
            expect(/^(inline|attachment)/.test(value)).toBe(true);
        }
    });

    test("lone surrogates from mid-emoji truncation never crash encoding", () => {
        // .slice() on UTF-16 code units can split an emoji pair.
        const truncated = "report-\uD83D".slice(0, 8); // lone high surrogate
        expect(() => buildContentDisposition(truncated + ".pdf")).not.toThrow();
    });
});
