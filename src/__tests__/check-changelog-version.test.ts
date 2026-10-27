import { describe, expect, it } from "bun:test";
// @ts-expect-error - a repo-tooling .mjs with no declarations; the package ships neither.
import { checkChangelogVersion } from "../../scripts/check-changelog-version.mjs";

const check = checkChangelogVersion as (version: string, changelog: string) => string | null;

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
