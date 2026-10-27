/**
 * Refuse to publish a version the CHANGELOG does not announce first.
 *
 * Three artifacts name a release: `package.json`'s `version`, the CHANGELOG's
 * topmost `## x.y.z` heading, and the git tag the mirror's workflow cuts from
 * the first. Nothing structural ties them together, so a publish can ship 5.0
 * code under a 4.x number, or a number whose CHANGELOG entry is the one below
 * a newer unreleased section, and both read as fine until a consumer diffs the
 * notes against the behaviour. The rule is deterministic: the FIRST version
 * heading is the release being published, it names exactly the manifest's
 * version, and it carries its release date in `(YYYY-MM-DD)`, which is the
 * mark this file uses to tell a shipped section from a drafted one.
 *
 * Usage: `node scripts/check-changelog-version.mjs` (chained in `prepublishOnly`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { releaseInstantOf } from "./release-date.mjs";

const HEADING = /^#{1,6}\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/m;

/**
 * The defect in a CHANGELOG about to be published as `version`, or null when
 * its first version heading announces that version with a date.
 * @param {string} version
 * @param {string} changelog
 * @returns {string | null}
 */
export function checkChangelogVersion(version, changelog) {
    const m = HEADING.exec(changelog);
    if (!m) return "CHANGELOG.md has no version heading (expected `## x.y.z (YYYY-MM-DD)`)";
    const [, heading, date] = m;
    if (heading !== version) {
        return `CHANGELOG.md announces ${heading} first, but package.json is at ${version}: bump the manifest or move the drafted section`;
    }
    if (!date)
        return `CHANGELOG.md's ${heading} heading carries no release date: write \`## ${heading} (YYYY-MM-DD)\` when it ships`;
    if (!releaseInstantOf(date))
        return `CHANGELOG.md's ${heading} heading dates the release ${date}, which is not a calendar date`;
    return null;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const { version } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const problem = checkChangelogVersion(version, readFileSync(path.join(pkgDir, "CHANGELOG.md"), "utf8"));
    if (problem) {
        console.error(`check-changelog-version: ${problem}`);
        process.exit(1);
    }
    console.log(`check-changelog-version: CHANGELOG.md announces ${version} first`);
}
