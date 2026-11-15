import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeTree, removeTrees } from "./temp-cleanup.ts";

/**
 * A recursive removal of a tree: the cleanup shape that must go through `removeTree`. A call to `rm`, `rmSync`,
 * `rmdir` or `rmdirSync` (bare or as a member) whose arguments name `recursive`, forced or not, or that takes
 * a plain path and a bare identifier or an object spread (options held elsewhere). Blind spots: an alias of
 * the function (`import { rm as drop }`), a call whose arguments run past a `;`, and options in a variable
 * beside a path that is itself a call (`rm(join(a, b), options)`).
 */
const handRolled =
    /\b(?:rm|rmSync|rmdir|rmdirSync)\((?:[^;]*?\brecursive\b|\s*[\w$.]+\s*,\s*(?:[A-Za-z_$][\w$.]*\s*\)|\{\s*\.\.\.))/;

/** Files that forward a caller's options to the real `rm` inside a fake of it; the forwarded call is not a cleanup. */
const FORWARDS_TO_REAL_RM = new Set(["primitives-fs-race.test.ts", "pending-fs.test.ts"]);

test("removeTree removes a tree and treats a tree that is already gone as removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pc-cleanup-"));
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "f.txt"), "x");
    await removeTree(root);
    expect(readdirSync(tmpdir())).not.toContain(basename(root));
    await removeTree(root);
});

test("removeTrees refuses a root nested under another and removes siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pc-cleanup-"));
    const inner = join(root, "inner");
    await mkdir(inner);
    await expect(removeTrees([root, inner])).rejects.toThrow("nested");
    expect(readdirSync(root)).toContain("inner");
    const sibling = `${root}.uploads`;
    await mkdir(sibling);
    await removeTrees([root, sibling]);
    expect(readdirSync(tmpdir())).not.toContain(basename(sibling));
});

test("no test removes a directory tree on its own:cleanup goes through removeTree, which retries", () => {
    const offenders = readdirSync(import.meta.dir)
        .filter((name) => name.endsWith(".ts") && name !== "temp-cleanup.ts" && name !== basename(import.meta.path))
        .filter((name) => !FORWARDS_TO_REAL_RM.has(name))
        .filter((name) => handRolled.test(readFileSync(join(import.meta.dir, name), "utf8")));
    expect(offenders).toEqual([]);
});

test("the detector finds the hand-rolled shapes and passes the helper", () => {
    expect(handRolled.test("await rm(root, { recursive: true, force: true });")).toBe(true);
    expect(handRolled.test("rmSync(dir, { force: true, recursive: true });")).toBe(true);
    expect(handRolled.test("await rm(root, { recursive: true });")).toBe(true);
    expect(handRolled.test("await rmdir(root, { recursive: true });")).toBe(true);
    expect(handRolled.test("await fs.rm(root, options);")).toBe(true);
    expect(handRolled.test("rmSync(\n    dir,\n    { force: true, recursive: true },\n);")).toBe(true);
    expect(handRolled.test("await realModule.rm(path, { ...options });")).toBe(true);
    expect(handRolled.test("await rm(target, { force: true });")).toBe(false);
    expect(handRolled.test("await real.rmdir(stamps);")).toBe(false);
    expect(handRolled.test("await removeTree(root);")).toBe(false);
});
