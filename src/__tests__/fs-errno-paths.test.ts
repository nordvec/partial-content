import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { removeTree } from "./temp-cleanup.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsStore } from "../fs";
import { isObjectNotFoundError } from "../index";

const SECRET = "tax-return-2026";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pc-fs-errno-"));
});

afterEach(async () => {
    await removeTree(root);
});

/** Every string an error chain exposes: message, stack, path, at each link. */
function chainText(err: unknown): string[] {
    const out: string[] = [];
    let link: unknown = err;
    for (let depth = 0; depth < 8 && link instanceof Error; depth++) {
        const { message, stack, path } = link as Error & { path?: unknown };
        for (const v of [message, stack, path]) if (typeof v === "string") out.push(v);
        link = link.cause;
    }
    return out;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => {
            throw new Error("expected a rejection");
        },
        (err: unknown) => err,
    );
}

describe("fs adapters never name a resolved path in a rejection", () => {
    test("a missing object's not-found keeps its key but its errno cause names no path", async () => {
        const store = fsStore({ root });
        const err = await rejection(store.headObject(`${SECRET}.pdf`));
        expect(isObjectNotFoundError(err)).toBe(true);
        expect((err as { key?: unknown }).key).toBe(`${SECRET}.pdf`);
        expect((err as Error).cause).toBeInstanceOf(Error);
        for (const text of chainText(err)) expect(text).not.toContain(SECRET);
        expect(chainText(err).some((t) => t.includes("<path>"))).toBe(true);
    });

    test("an errno other than not-found names no path", async () => {
        // A file standing where a directory is expected: reading below it fails
        // with an errno that is not a plain absence on every platform.
        await writeFile(join(root, SECRET), "x");
        const store = fsStore({ root });
        const err = await rejection(store.getObject(`${SECRET}/inner.pdf`));
        expect(err).toBeInstanceOf(Error);
        for (const text of chainText(err)) expect(text).not.toContain(SECRET);
    });
});
