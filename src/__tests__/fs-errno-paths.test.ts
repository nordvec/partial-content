import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsStore, fsUploadStore } from "../fs";
import { isObjectNotFoundError } from "../index";

const SECRET = "tax-return-2026";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pc-fs-errno-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/** Every string an error chain exposes: message, stack, path, dest, at each link. */
function chainText(err: unknown): string[] {
    const out: string[] = [];
    let link: unknown = err;
    for (let depth = 0; depth < 8 && link instanceof Error; depth++) {
        const { message, stack, path, dest } = link as Error & { path?: unknown; dest?: unknown };
        for (const v of [message, stack, path, dest]) if (typeof v === "string") out.push(v);
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

    test("an upload whose bytes cannot be snapshotted names no token, and keeps its code", async () => {
        const store = fsUploadStore({ root });
        const { uploadToken } = await store.createUpload({ key: `${SECRET}.pdf`, now: 0 });
        const data = join(root, ".uploads", uploadToken, "data");
        await rm(data, { force: true });
        await mkdir(data);
        await writeFile(join(data, "pinned"), "x");
        const err = await rejection(store.completeUpload(uploadToken, { expectedLength: 0, now: 1 }));
        expect(err).toBeInstanceOf(Error);
        for (const text of chainText(err)) expect(text).not.toContain(uploadToken);
        for (const text of chainText(err)) expect(text).not.toContain(SECRET);
        expect((err as { path?: unknown }).path).toBe("<path>");
        // The copy's refusal of a directory is platform-specific (EPERM on
        // Windows, EISDIR elsewhere); what must survive the redaction is that
        // it is still an errno code an operator can act on.
        expect(String((err as { code?: unknown }).code)).toMatch(/^E[A-Z]+$/);
    });
});
