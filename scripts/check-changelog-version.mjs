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
 * mark this file uses to tell a shipped section from a drafted one. The entry
 * is also held to the release-body shape: a summary, Highlights, Upgrading,
 * Security, Details, in that order.
 *
 * Usage: `node scripts/check-changelog-version.mjs` (chained in `prepublishOnly`).
 */
import { readFileSync } from "node:fs";
import { PKG_DIR, invokedDirectly } from "./script-entry.mjs";
import path from "node:path";
import { releaseInstantOf } from "./release-date.mjs";

const HEADING = /^#{1,6}\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/m;
const NO_HEADING = "CHANGELOG.md has no version heading (expected `## x.y.z (YYYY-MM-DD)`)";

/**
 * The defect in a CHANGELOG about to be published as `version`, or null when
 * its first version heading announces that version with a date.
 * @param {string} version
 * @param {string} changelog
 * @returns {string | null}
 */
export function checkChangelogVersion(version, changelog) {
    const m = HEADING.exec(changelog);
    if (!m) return NO_HEADING;
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

/** The tiers of a release entry, in the only order they may appear. */
const TIERS = ["Highlights", "Upgrading", "Security", "Details"];

/** The numbered `### N.` sections of UPGRADING.md's `## <prev>.x to <major>.0` part, or null when it has none. */
function upgradingSectionCount(upgrading, major) {
    const start = new RegExp(`^## ${major - 1}\\.x to ${major}\\.0\\s*$`, "m").exec(upgrading);
    if (!start) return null;
    const rest = upgrading.slice(start.index + start[0].length);
    const end = /^## /m.exec(rest);
    const part = end ? rest.slice(0, end.index) : rest;
    return (part.match(/^### \d+\. /gm) ?? []).length;
}

/**
 * The top entry split into its summary and its `###` sections, or the defect
 * that stops it splitting: a section outside the four tiers, or one given twice.
 * @param {string} heading the entry's version
 * @param {string} body the text between the entry's heading and the next `## `
 * @returns {{ summary: string, sections: Map<string, string>, seen: string[] } | string}
 */
function splitEntry(heading, body) {
    const parts = body.split(/^### +(.+?)\s*$/m);
    /** @type {Map<string, string>} */
    const sections = new Map();
    for (let i = 1; i < parts.length; i += 2) {
        const name = parts[i];
        if (!TIERS.includes(name))
            return `CHANGELOG.md's ${heading} entry has a top-level \`### ${name}\`: only ${TIERS.map((t) => `\`### ${t}\``).join(", ")} may sit at that level, so move it under \`### Details\` as \`#### ${name}\``;
        if (sections.has(name)) return `CHANGELOG.md's ${heading} entry has two \`### ${name}\` sections`;
        sections.set(name, parts[i + 1]);
    }
    return { summary: parts[0].trim(), sections, seen: [...sections.keys()] };
}

/**
 * The CHANGELOG's first entry: its version, its date and its split body, or
 * the defect that stops it reading as one.
 * @param {string} changelog
 * @returns {{ version: string, date: string | undefined, summary: string, sections: Map<string, string>, seen: string[] } | string}
 */
export function topEntry(changelog) {
    const m = HEADING.exec(changelog);
    if (!m) return NO_HEADING;
    const afterHeading = changelog.slice(m.index + m[0].length);
    const next = /^## /m.exec(afterHeading);
    const entry = splitEntry(m[1], next ? afterHeading.slice(0, next.index) : afterHeading);
    return typeof entry === "string" ? entry : { version: m[1], date: m[2], ...entry };
}

/** The defect in which tiers are present, in what order and how full, or null. */
function checkTiers(heading, major, { summary, sections, seen }) {
    if (!summary) return `CHANGELOG.md's ${heading} entry has no summary paragraph before its first \`###\` section`;
    const required = TIERS.filter((t) => t === "Highlights" || t === "Details" || (t === "Upgrading" && major > 0));
    const missing = required.find((t) => !sections.has(t));
    if (missing) return `CHANGELOG.md's ${heading} entry has no \`### ${missing}\` section`;
    const order = TIERS.filter((t) => sections.has(t));
    if (seen.join() !== order.join())
        return `CHANGELOG.md's ${heading} entry lists its sections as ${seen.join(", ")}: the order is ${TIERS.join(", ")}`;
    const empty = ["Highlights", "Details"].find((t) => !sections.get(t)?.trim());
    return empty ? `CHANGELOG.md's ${heading} \`### ${empty}\` section is empty` : null;
}

/** The top-level bullet lines of a section's text. */
const bulletsOf = (text) => text.split("\n").filter((l) => /^[-*] /.test(l));

/** The defect in a `### Security` section's bullets, or null. */
function checkSecurity(text) {
    const items = bulletsOf(text);
    if (items.length === 0)
        return "CHANGELOG.md's `### Security` has no bullets: drop the section when nothing was fixed";
    // An id is GHSA plus three groups of four from GitHub's 27-letter alphabet, so
    // a placeholder such as GHSA-TBD fails, and a bullet names exactly one advisory.
    const bare = items.find((l) => (l.match(/GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/g) ?? []).length !== 1);
    return bare
        ? `CHANGELOG.md's \`### Security\` bullet must name exactly one well-formed GHSA id: ${bare.slice(0, 60)}`
        : null;
}

/** The defect in a major's `### Upgrading` checklist against UPGRADING.md's part for it, or null. */
function checkUpgrading(text, major, upgrading) {
    const lines = bulletsOf(text);
    const part = `## ${major - 1}.x to ${major}.0`;
    const sectionsInDoc = upgradingSectionCount(upgrading, major);
    if (sectionsInDoc === null)
        return `docs/UPGRADING.md has no \`${part}\` section to count the Upgrading checklist against`;
    if (lines.length !== sectionsInDoc)
        return `CHANGELOG.md's \`### Upgrading\` has ${lines.length} lines but docs/UPGRADING.md numbers ${sectionsInDoc} sections under \`${part}\`: write exactly one line per section`;
    const unlinked = lines.find((l) => !l.includes("UPGRADING.md#"));
    return unlinked
        ? `CHANGELOG.md's \`### Upgrading\` has a line with no link into docs/UPGRADING.md: ${unlinked.slice(0, 60)}`
        : null;
}

/**
 * The defect in the top entry's shape, or null when it is the two-tier release
 * body: a summary, then `### Highlights`, `### Upgrading` (required on a
 * major), an optional `### Security` whose every bullet names a `GHSA-` id, and
 * `### Details`. A major's Upgrading checklist has one linked line per numbered
 * section of its UPGRADING.md part.
 * @param {string} version
 * @param {string} changelog
 * @param {string} upgrading the text of docs/UPGRADING.md
 * @returns {string | null}
 */
export function checkChangelogShape(version, changelog, upgrading) {
    const entry = topEntry(changelog);
    if (typeof entry === "string") return entry;
    const major = Number(/^(\d+)\.0\.0(?:-|$)/.exec(entry.version)?.[1] ?? 0);
    const tiers = checkTiers(entry.version, major, entry);
    if (tiers) return tiers;
    const security = entry.sections.get("Security");
    const securityProblem = security === undefined ? null : checkSecurity(security);
    if (securityProblem) return securityProblem;
    return major > 0 ? checkUpgrading(entry.sections.get("Upgrading") ?? "", major, upgrading) : null;
}

if (invokedDirectly(import.meta.url)) {
    const pkgDir = PKG_DIR;
    const { version } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const changelog = readFileSync(path.join(pkgDir, "CHANGELOG.md"), "utf8");
    const problem =
        checkChangelogVersion(version, changelog) ??
        checkChangelogShape(version, changelog, readFileSync(path.join(pkgDir, "docs", "UPGRADING.md"), "utf8"));
    if (problem) {
        console.error(`check-changelog-version: ${problem}`);
        process.exit(1);
    }
    console.log(`check-changelog-version: CHANGELOG.md announces ${version} first, in the release shape`);
}
