/**
 * Render the GitHub release body from the CHANGELOG's top entry.
 *
 * The body is the entry's first tier: its summary, `### Highlights`,
 * `### Upgrading` and `### Security`. `### Details` stays in the CHANGELOG, and
 * the body ends with a link to it. A release page resolves a relative link
 * against the releases URL, where `#anchor` and `docs/UPGRADING.md#x` lead
 * nowhere, so every relative link is rewritten to the file at the release's
 * own tag: the notes keep pointing at the text that shipped with them.
 *
 * The entry must pass the same checks `prepublishOnly` runs, so a release
 * cannot carry notes for another version or an entry out of shape.
 *
 * Usage: `node scripts/release-notes.mjs [--ref <git ref>] > notes.md` (the
 * public repo's release workflow passes the file to `gh release create
 * --notes-file`). `--ref` pins the links somewhere other than the release's
 * tag, for re-rendering the body of a release whose tagged CHANGELOG predates
 * the entry being rendered.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkChangelogShape, checkChangelogVersion, topEntry } from "./check-changelog-version.mjs";
import { PKG_DIR, invokedDirectly } from "./script-entry.mjs";

/** The tiers a release body carries; Details is left to the CHANGELOG. */
const BODY_TIERS = ["Highlights", "Upgrading", "Security"];

/**
 * The `https://github.com/<owner>/<repo>` a manifest's `repository` names.
 * @param {string | { url: string }} repository
 * @returns {string}
 */
export function repoUrlOf(repository) {
    const url = typeof repository === "string" ? repository : repository.url;
    const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    if (!m) throw new Error(`package.json's repository is not a GitHub repository: ${url}`);
    return `https://github.com/${m[1]}`;
}

/** GitHub's anchor for a heading's text: lower case, punctuation dropped, spaces to hyphens. */
const anchorOf = (text) =>
    text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .replaceAll(" ", "-");

/**
 * Rewrite each relative markdown link target to the file at `blobBase`; an
 * in-page `#anchor` points into the CHANGELOG, which is where it was written.
 * @param {string} text
 * @param {string} blobBase `https://github.com/<owner>/<repo>/blob/<tag>`
 * @returns {string}
 */
export function absolutizeLinks(text, blobBase) {
    return text.replace(/(\]\()([^)\s]+)(\))/g, (whole, open, target, close) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole;
        const resolved = target.startsWith("#") ? `CHANGELOG.md${target}` : target.replace(/^\.\//, "");
        return `${open}${blobBase}/${resolved}${close}`;
    });
}

/**
 * The release body for the CHANGELOG's top entry, or the defect that refuses it.
 * @param {{ version: string, repository: string | { url: string } }} manifest
 * @param {string} changelog
 * @param {string} upgrading the text of docs/UPGRADING.md
 * @param {string} [ref] the git ref the links point at; the release's tag by default
 * @returns {{ notes: string } | { problem: string }}
 */
export function releaseNotes(manifest, changelog, upgrading, ref = `v${manifest.version}`) {
    const problem =
        checkChangelogVersion(manifest.version, changelog) ??
        checkChangelogShape(manifest.version, changelog, upgrading);
    if (problem) return { problem };
    const entry = topEntry(changelog);
    if (typeof entry === "string") return { problem: entry };
    const blobBase = `${repoUrlOf(manifest.repository)}/blob/${ref}`;
    const parts = [entry.summary];
    for (const tier of BODY_TIERS) {
        const text = entry.sections.get(tier);
        if (text !== undefined) parts.push(`### ${tier}\n\n${text.trim()}`);
    }
    const heading = `${entry.version} (${entry.date})`;
    parts.push(`The mechanism behind each change is in [the full entry](CHANGELOG.md#${anchorOf(heading)}).`);
    return { notes: `${absolutizeLinks(parts.join("\n\n"), blobBase)}\n` };
}

if (invokedDirectly(import.meta.url)) {
    const read = (...p) => readFileSync(path.join(PKG_DIR, ...p), "utf8");
    const args = process.argv.slice(2);
    const ref = args[0] === "--ref" && args.length === 2 ? args[1] : undefined;
    if (args.length > 0 && ref === undefined) {
        console.error("usage: node scripts/release-notes.mjs [--ref <git ref>]");
        process.exit(2);
    }
    const manifest = JSON.parse(read("package.json"));
    const result = releaseNotes(manifest, read("CHANGELOG.md"), read("docs", "UPGRADING.md"), ref);
    if ("problem" in result) {
        console.error(`release-notes: ${result.problem}`);
        process.exit(1);
    }
    process.stdout.write(result.notes);
}
