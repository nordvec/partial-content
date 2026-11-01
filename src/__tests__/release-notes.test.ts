import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error - a repo-tooling .mjs with no declarations; the package ships neither.
import { absolutizeLinks, releaseNotes, repoUrlOf } from "../../scripts/release-notes.mjs";

type Manifest = { version: string; repository: string | { url: string } };
const notes = releaseNotes as (
    manifest: Manifest,
    changelog: string,
    upgrading: string,
    ref?: string,
) => { notes: string } | { problem: string };
const absolutize = absolutizeLinks as (text: string, blobBase: string) => string;
const repoUrl = repoUrlOf as (repository: string | { url: string }) => string;

const REPO = { url: "git+https://github.com/acme/widget.git" };
const UPGRADING = "# Upgrading\n\n## 4.x to 5.0\n\n### 1. One\n";
const CHANGELOG = [
    "# Changelog\n",
    "## 5.0.0 (2026-10-27)\n\nOne breaking change ([why](#the-mechanism)).\n",
    "### Highlights\n\n- A thing to rely on.\n",
    "### Upgrading\n\n- First. [1](docs/UPGRADING.md#1-one)\n",
    "### Security\n\n- **GHSA-2c4f-hjm6-pq7r** (Low): impact. [Details](#the-mechanism)\n",
    "### Details\n\n#### The mechanism\n\nInternal prose stays out of the release body.\n",
    "## 4.0.0 (2026-09-01)\n\n### Fixed\n\n- Old.\n",
].join("\n");

describe("releaseNotes", () => {
    it("carries the summary and the first-tier sections, never Details or an older entry", () => {
        const result = notes({ version: "5.0.0", repository: REPO }, CHANGELOG, UPGRADING);
        if ("problem" in result) throw new Error(result.problem);
        expect(result.notes).toContain("One breaking change");
        expect(result.notes).toContain("### Highlights\n\n- A thing to rely on.");
        expect(result.notes).toContain("### Upgrading");
        expect(result.notes).toContain("### Security");
        expect(result.notes).not.toContain("### Details");
        expect(result.notes).not.toContain("Internal prose");
        expect(result.notes).not.toContain("Old.");
    });

    it("pins every relative link to the release's own tag", () => {
        const result = notes({ version: "5.0.0", repository: REPO }, CHANGELOG, UPGRADING);
        if ("problem" in result) throw new Error(result.problem);
        const base = "https://github.com/acme/widget/blob/v5.0.0";
        expect(result.notes).toContain(`(${base}/CHANGELOG.md#the-mechanism)`);
        expect(result.notes).toContain(`(${base}/docs/UPGRADING.md#1-one)`);
        expect(result.notes).toContain(`(${base}/CHANGELOG.md#500-2026-10-27)`);
        expect([...result.notes.matchAll(/\]\(([^)]+)\)/g)].every((m) => m[1].startsWith("https://"))).toBe(true);
    });

    it("pins the links to another ref when asked", () => {
        const result = notes({ version: "5.0.0", repository: REPO }, CHANGELOG, UPGRADING, "main");
        if ("problem" in result) throw new Error(result.problem);
        expect(result.notes).toContain("(https://github.com/acme/widget/blob/main/docs/UPGRADING.md#1-one)");
        expect(result.notes).not.toContain("/blob/v5.0.0/");
    });

    it("refuses notes for a version the manifest does not name, and an entry out of shape", () => {
        expect(notes({ version: "5.0.1", repository: REPO }, CHANGELOG, UPGRADING)).toEqual({
            problem: expect.stringMatching(/announces 5\.0\.0 first, but package\.json is at 5\.0\.1/),
        });
        const noDetails = CHANGELOG.replace(/### Details[\s\S]*?(?=## 4\.0\.0)/, "");
        expect(notes({ version: "5.0.0", repository: REPO }, noDetails, UPGRADING)).toEqual({
            problem: expect.stringMatching(/no `### Details`/),
        });
    });
});

describe("absolutizeLinks", () => {
    it("leaves absolute and scheme links alone and drops a leading ./", () => {
        const base = "https://x.test/blob/v1.0.0";
        expect(absolutize("[a](https://e.test/p) [b](mailto:a@b.test)", base)).toBe(
            "[a](https://e.test/p) [b](mailto:a@b.test)",
        );
        expect(absolutize("[c](./docs/API.md#x)", base)).toBe(`[c](${base}/docs/API.md#x)`);
    });
});

describe("repoUrlOf", () => {
    it("reads the GitHub repository from either manifest shape, and refuses another host", () => {
        expect(repoUrl(REPO)).toBe("https://github.com/acme/widget");
        expect(repoUrl("https://github.com/acme/widget")).toBe("https://github.com/acme/widget");
        expect(() => repoUrl("https://gitlab.test/acme/widget.git")).toThrow(/not a GitHub repository/);
    });
});

/** GitHub's anchors for a markdown file's headings, with `-1`, `-2` suffixes on repeats. */
function anchorsOf(markdown: string): Set<string> {
    const seen = new Map<string, number>();
    const anchors = new Set<string>();
    for (const [, text] of markdown.matchAll(/^#{1,6} +(.+?)\s*$/gm)) {
        const slug = text
            .toLowerCase()
            .replace(/[^\p{L}\p{N} _-]/gu, "")
            .replaceAll(" ", "-");
        const n = seen.get(slug) ?? 0;
        seen.set(slug, n + 1);
        anchors.add(n === 0 ? slug : `${slug}-${n}`);
    }
    return anchors;
}

describe("the real release body", () => {
    it("renders, and every link into the tag lands on a heading that exists", () => {
        const dir = join(import.meta.dir, "..", "..");
        const read = (...p: string[]) => readFileSync(join(dir, ...p), "utf8");
        const manifest = JSON.parse(read("package.json")) as Manifest;
        const result = notes(manifest, read("CHANGELOG.md"), read("docs", "UPGRADING.md"));
        if ("problem" in result) throw new Error(result.problem);
        const base = `${repoUrl(manifest.repository)}/blob/v${manifest.version}/`;
        const targets = [...result.notes.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]).filter((t) => t.startsWith(base));
        expect(targets.length).toBeGreaterThan(0);
        const missing = targets.filter((t) => {
            const [file, anchor] = t.slice(base.length).split("#");
            return anchor !== undefined && !anchorsOf(read(...file.split("/"))).has(anchor);
        });
        expect(missing).toEqual([]);
    });
});
