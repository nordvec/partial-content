import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - a repo-tooling .mjs with no declarations; the package ships neither.
import { selectTests } from "../../scripts/mutation-tests.mjs";
import { removeTrees } from "./temp-cleanup.ts";

const roots: string[] = [];

/** A package layout of `files` (path -> source) under a fresh directory. */
function layout(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "mutation-tests-"));
    roots.push(root);
    for (const [name, source] of Object.entries(files)) {
        mkdirSync(join(root, name, ".."), { recursive: true });
        writeFileSync(join(root, name), source);
    }
    return root;
}

const select = (cwd: string, moduleFile: string): { files: string[] } | { fallback: string } =>
    selectTests({ cwd, moduleFile });

afterEach(async () => {
    await removeTrees(roots.splice(0));
});

describe("selectTests", () => {
    it("selects the tests that load the module, directly or through other modules", () => {
        const cwd = layout({
            "src/leaf.ts": "export const leaf = 1;",
            "src/mid.ts": 'export { leaf } from "./leaf.ts";',
            "src/other.ts": "export const other = 2;",
            "src/__tests__/a.test.ts": 'import { leaf } from "../leaf";',
            "src/__tests__/b.test.ts": 'import { leaf } from "../mid.ts";',
            "src/__tests__/c.test.ts": 'import { other } from "../other";',
        });
        expect(select(cwd, "src/leaf.ts")).toEqual({
            files: ["./src/__tests__/a.test.ts", "./src/__tests__/b.test.ts"],
        });
        expect(select(cwd, "src/other.ts")).toEqual({ files: ["./src/__tests__/c.test.ts"] });
    });

    it("resolves the way Bun does: a .js specifier for a .ts file, a barrel directory, a dynamic import", () => {
        const cwd = layout({
            "src/lib/index.ts": 'export * from "./deep.ts";',
            "src/lib/deep.ts": 'import "./index";\nexport const deep = 1;',
            "src/lazy.ts": "export const lazy = 1;",
            "src/js.ts": "export const js = 1;",
            "src/__tests__/barrel.test.ts": 'import { deep } from "../lib";',
            "src/__tests__/lazy.test.ts": 'await import("../lazy.ts");',
            "src/__tests__/js.test.ts": 'import { js } from "../js.js";',
        });
        expect(select(cwd, "src/lib/deep.ts")).toEqual({ files: ["./src/__tests__/barrel.test.ts"] });
        expect(select(cwd, "src/lazy.ts")).toEqual({ files: ["./src/__tests__/lazy.test.ts"] });
        expect(select(cwd, "src/js.ts")).toEqual({ files: ["./src/__tests__/js.test.ts"] });
    });

    it("follows the package's own name through its exports map", () => {
        const cwd = layout({
            "package.json": JSON.stringify({ name: "self-pkg", exports: { "./adapter": { bun: "./src/adapter.ts" } } }),
            "src/adapter.ts": "export const adapter = 1;",
            "src/__tests__/self.test.ts": 'import { adapter } from "self-pkg/adapter";',
            "src/__tests__/none.test.ts": 'import { expect } from "bun:test";',
        });
        expect(select(cwd, "src/adapter.ts")).toEqual({ files: ["./src/__tests__/self.test.ts"] });
    });

    it("finds tests where bun test does: any depth, .spec and _test names", () => {
        const cwd = layout({
            "src/m.ts": "export const m = 1;",
            "smoke/deep/x.spec.ts": 'import { m } from "../../src/m";',
            "src/__tests__/y_test.ts": 'import { m } from "../m";',
            "src/__tests__/helper.ts": 'import { m } from "../m";',
        });
        expect(select(cwd, "src/m.ts")).toEqual({ files: ["./smoke/deep/x.spec.ts", "./src/__tests__/y_test.ts"] });
    });

    it("ignores a whole-statement type import and keeps an inline-type-only one", () => {
        const cwd = layout({
            "src/t.ts": "export type T = 1;",
            "src/i.ts": "export type I = 1;",
            "src/__tests__/type.test.ts": 'import type { T } from "../t";\nexport type { T } from "../t";',
            "src/__tests__/inline.test.ts": 'import { type I } from "../i";',
        });
        expect(select(cwd, "src/t.ts")).toEqual({ files: [] });
        expect(select(cwd, "src/i.ts")).toEqual({ files: ["./src/__tests__/inline.test.ts"] });
    });

    it("answers with the reason when a specifier does not resolve, never with a guess", () => {
        const cwd = layout({
            "src/m.ts": "export const m = 1;",
            "src/__tests__/a.test.ts": 'import { m } from "../m";',
            "src/__tests__/b.test.ts": 'import { nope } from "some-package-that-is-not-installed";',
        });
        const answer = select(cwd, "src/m.ts");
        expect(answer).toEqual({
            fallback: 'src/__tests__/b.test.ts imports "some-package-that-is-not-installed", which does not resolve',
        });
        const relative = layout({ "src/__tests__/c.test.ts": 'import "../missing";' });
        expect(select(relative, "src/m.ts")).toEqual({
            fallback: 'src/__tests__/c.test.ts imports "../missing", which does not resolve',
        });
    });
});
