import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The upload token is a bearer capability, so it must stay off `Error.message`
 * and live on a property, as `UploadNotFoundError` already does: store errors
 * reach the consumer's `onError` log sink, and `auditKey` can only redact the
 * context object.
 *
 * Asserted on the CONSTRUCTION rather than the behavior, because driving the
 * error paths would cover the ones that exist today while the defect is a new
 * one being added.
 */
const SRC_DIR = join(import.meta.dir, "..");

/** Shipped source only: the tests themselves may name whatever they need. */
function shippedSources(): string[] {
    return readdirSync(SRC_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
}

/**
 * An `Error(...)` (or `Error(...)`-adjacent) template literal that interpolates
 * a token-named binding. Deliberately narrow: it catches the shape that
 * actually shipped rather than trying to trace a message built elsewhere and
 * thrown later, so a green result means "this shape is absent", not "no message
 * can ever carry a token".
 */
const TOKEN_IN_MESSAGE = /Error\(\s*`[^`]*\$\{\s*[A-Za-z0-9_.]*[Tt]oken[A-Za-z0-9_.]*\s*\}/g;

describe("the upload token never reaches Error.message", () => {
    test("no shipped module interpolates a token into an error message", () => {
        const offenders: string[] = [];
        for (const file of shippedSources()) {
            const source = readFileSync(join(SRC_DIR, file), "utf8");
            for (const match of source.matchAll(TOKEN_IN_MESSAGE)) {
                const line = source.slice(0, match.index).split("\n").length;
                offenders.push(`${file}:${line}  ${match[0].slice(0, 80)}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
