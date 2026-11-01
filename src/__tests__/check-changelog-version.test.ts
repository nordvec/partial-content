import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error - a repo-tooling .mjs with no declarations; the package ships neither.
import { checkChangelogShape, checkChangelogVersion } from "../../scripts/check-changelog-version.mjs";

const check = checkChangelogVersion as (version: string, changelog: string) => string | null;
const shape = checkChangelogShape as (version: string, changelog: string, upgrading: string) => string | null;

describe("checkChangelogVersion", () => {
    it("accepts a dated first heading naming the manifest version", () => {
        expect(check("4.0.0", "# Changelog\n\n## 4.0.0 (2026-09-01)\n\nNotes.\n\n## 3.0.1 (2026-07-21)\n")).toBeNull();
        expect(check("5.0.0-rc.1", "## 5.0.0-rc.1 (2026-10-01)\n")).toBeNull();
    });

    it("refuses a drafted newer section above the version being published", () => {
        expect(check("4.0.1", "# Changelog\n\n## 5.0.0\n\nDraft.\n\n## 4.0.1 (2026-09-21)\n")).toMatch(
            /announces 5\.0\.0 first, but package\.json is at 4\.0\.1/,
        );
    });

    it("refuses an undated heading, a non-date, and a file with no heading", () => {
        expect(check("5.0.0", "## 5.0.0\n\nDraft.\n")).toMatch(/carries no release date/);
        expect(check("5.0.0", "## 5.0.0 (2026-13-40)\n")).toMatch(/not a calendar date/);
        expect(check("5.0.0", "# Changelog\n\nProse only.\n")).toMatch(/no version heading/);
    });

    it("refuses a day the month does not have, which Date.parse would roll into the next month", () => {
        expect(check("5.0.0", "## 5.0.0 (2026-02-30)\n")).toMatch(/not a calendar date/);
        expect(check("5.0.0", "## 5.0.0 (2026-04-31)\n")).toMatch(/not a calendar date/);
        expect(check("5.0.0", "## 5.0.0 (2025-02-29)\n")).toMatch(/not a calendar date/);
        expect(check("5.0.0", "## 5.0.0 (2028-02-29)\n")).toBeNull();
    });

    it("reads the first version heading, not a version mentioned in prose or a deeper heading first", () => {
        expect(
            check("4.0.0", "# Changelog\n\nSee 3.0.0 for context.\n\n### Not a version\n\n## 4.0.0 (2026-09-01)\n"),
        ).toBeNull();
    });
});

const UPGRADING =
    "# Upgrading\n\n## 4.x to 5.0\n\n### 1. One\n\n### 2. Two\n\n## 3.x to 4.0\n\n### 1. Old\n\n### 2. Older\n\n### 3. Oldest\n";
const GHSA = "- **GHSA-2c4f-hjm6-pq7r** (Low; `< 5.0.0`): impact. [Details](#d)";
const LINES = "- First. [1](docs/UPGRADING.md#1-one)\n- Second. [2](docs/UPGRADING.md#2-two)";

/** A 5.0.0 entry in the release shape, with each tier overridable. */
function entry(
    over: {
        summary?: string;
        highlights?: string;
        upgrading?: string | null;
        security?: string | null;
        details?: string | null;
        extra?: string;
    } = {},
): string {
    const parts = [`## 5.0.0 (2026-10-27)\n\n${over.summary ?? "Two breaking changes."}\n`];
    parts.push(`### Highlights\n\n${over.highlights ?? "- A thing to rely on."}\n`);
    if (over.upgrading !== null) parts.push(`### Upgrading\n\n${over.upgrading ?? LINES}\n`);
    if (over.security !== null) parts.push(`### Security\n\n${over.security ?? GHSA}\n`);
    if (over.details !== null) parts.push(`### Details\n\n${over.details ?? "#### Subject\n\nMechanism."}\n`);
    if (over.extra) parts.push(over.extra);
    return `# Changelog\n\n${parts.join("\n")}\n## 4.0.0 (2026-09-01)\n\n### Fixed\n\n- Old shape stays.\n`;
}

describe("checkChangelogShape", () => {
    it("accepts a major entry in the release shape, and its Security section is optional", () => {
        expect(shape("5.0.0", entry(), UPGRADING)).toBeNull();
        expect(shape("5.0.0", entry({ security: null }), UPGRADING)).toBeNull();
    });

    it("does not judge the entries below the top one", () => {
        expect(entry()).toContain("### Fixed");
        expect(shape("5.0.0", entry(), UPGRADING)).toBeNull();
    });

    it("refuses an entry with no summary before its first section", () => {
        expect(shape("5.0.0", entry({ summary: "" }), UPGRADING)).toMatch(/no summary paragraph/);
    });

    it("refuses a missing Highlights, Upgrading on a major, or Details", () => {
        const noHighlights = entry().replace(/### Highlights\n\n- A thing to rely on\.\n\n/, "");
        expect(shape("5.0.0", noHighlights, UPGRADING)).toMatch(/no `### Highlights`/);
        expect(shape("5.0.0", entry({ upgrading: null }), UPGRADING)).toMatch(/no `### Upgrading`/);
        expect(shape("5.0.0", entry({ details: null }), UPGRADING)).toMatch(/no `### Details`/);
    });

    it("requires Upgrading only on a major", () => {
        const minor = entry({ upgrading: null }).replace("## 5.0.0", "## 5.1.0");
        expect(shape("5.1.0", minor, UPGRADING)).toBeNull();
        const patch = entry({ upgrading: null }).replace("## 5.0.0", "## 5.0.1");
        expect(shape("5.0.1", patch, UPGRADING)).toBeNull();
    });

    it("refuses a long-form section left at the top level", () => {
        expect(shape("5.0.0", entry({ extra: "### Changed\n\n- Old shape.\n" }), UPGRADING)).toMatch(
            /top-level `### Changed`.*`#### Changed`/,
        );
    });

    it("refuses sections out of order and a section given twice", () => {
        const swapped = entry()
            .replace("### Highlights", "### TMP")
            .replace("### Upgrading", "### Highlights")
            .replace("### TMP", "### Upgrading");
        expect(shape("5.0.0", swapped, UPGRADING)).toMatch(/the order is Highlights, Upgrading, Security, Details/);
        expect(shape("5.0.0", entry({ extra: "### Details\n\n- again.\n" }), UPGRADING)).toMatch(/two `### Details`/);
    });

    it("refuses an empty Highlights or Details", () => {
        expect(shape("5.0.0", entry({ highlights: " " }), UPGRADING)).toMatch(/`### Highlights` section is empty/);
        expect(shape("5.0.0", entry({ details: " " }), UPGRADING)).toMatch(/`### Details` section is empty/);
    });

    it("refuses a Security bullet with no GHSA id, and a Security section with no bullets", () => {
        const sec = `${GHSA}\n- A fix with no advisory.`;
        expect(shape("5.0.0", entry({ security: sec }), UPGRADING)).toMatch(
            /exactly one well-formed GHSA id: - A fix with no advisory/,
        );
        for (const bad of [
            "- **GHSA-TBD**: impact.",
            "- **GHSA-aaaa-bbbb-cccc**: letters outside the id alphabet.",
            `${GHSA} and **GHSA-3v5w-x8c9-f2g4**`,
        ]) {
            expect(shape("5.0.0", entry({ security: bad }), UPGRADING)).toMatch(/exactly one well-formed GHSA id/);
        }
        expect(shape("5.0.0", entry({ security: "Prose only." }), UPGRADING)).toMatch(/no bullets/);
    });

    it("refuses an Upgrading checklist whose line count differs from UPGRADING.md's part", () => {
        expect(shape("5.0.0", entry({ upgrading: "- First. [1](docs/UPGRADING.md#1-one)" }), UPGRADING)).toMatch(
            /has 1 lines but docs\/UPGRADING\.md numbers 2 sections under `## 4\.x to 5\.0`/,
        );
        const three = `${LINES}\n- Third. [3](docs/UPGRADING.md#3-three)`;
        expect(shape("5.0.0", entry({ upgrading: three }), UPGRADING)).toMatch(/has 3 lines.*numbers 2 sections/);
    });

    it("counts against the major's own part, and refuses a major with none", () => {
        const six = "# Upgrading\n\n## 5.x to 6.0\n\n### 1. A\n";
        const six0 = entry({ upgrading: "- A. [1](docs/UPGRADING.md#1-a)" }).replaceAll("5.0.0", "6.0.0");
        expect(shape("6.0.0", six0, six)).toBeNull();
        expect(shape("6.0.0", six0, UPGRADING)).toMatch(/no `## 5\.x to 6\.0` section/);
    });

    it("refuses an Upgrading line that links nowhere", () => {
        expect(shape("5.0.0", entry({ upgrading: "- First.\n- Second." }), UPGRADING)).toMatch(
            /line with no link into docs\/UPGRADING\.md: - First\./,
        );
    });

    it("passes the real CHANGELOG against the real UPGRADING.md", () => {
        const dir = join(import.meta.dir, "..", "..");
        const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
        const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
        const upgrading = readFileSync(join(dir, "docs", "UPGRADING.md"), "utf8");
        expect(check(version, changelog)).toBeNull();
        expect(shape(version, changelog, upgrading)).toBeNull();
    });
});
