/**
 * Mirror this directory, as of one monorepo commit, into a checkout of the
 * public repository, deletions included, so a file removed here cannot linger
 * there and ship in the tarball (`files` publishes all of `src`).
 *
 * The mirrored tree is a function of a commit, never of the working tree: the
 * source set is `git ls-tree` of this directory at the commit (HEAD, or
 * `--rev`) minus the dev-home-only files, every byte is read from the commit's
 * objects, and a source with uncommitted changes is refused. `bunfig.public.toml`
 * lands in the target as `bunfig.toml`. Every file tracked in the target that
 * is neither in the source set nor on the keep-list is deleted. The keep-list
 * is what only the public repository owns: it is never written, replaced or
 * deleted, so a source path under it is refused.
 *
 * A symbolic link or submodule entry on either side is refused, as is a write
 * whose destination is a link or whose parent resolves outside the target.
 *
 * Dry run by default: it prints the commit, then the added, changed and deleted
 * paths, and changes nothing. `--apply` performs them, then re-reads the target
 * and fails unless its names, contents and file modes equal the source set plus
 * the kept files. It never commits or pushes.
 *
 * Usage: `node scripts/sync-public.mjs --to <public checkout> [--rev <commit>] [--apply]`
 */
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    rmdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { PKG_DIR, invokedDirectly } from "./script-entry.mjs";

/** Tracked here, but meaningful only in the dev home. */
const DEV_HOME_ONLY = new Set(["AGENTS.md", "CLAUDE.md", "bunfig.toml", ".gitignore"]);

/** The public file the dev home keeps under another name, and the name it takes there. */
const RENAMED = { source: "bunfig.public.toml", target: "bunfig.toml" };

/**
 * Paths only the public repository owns: the sync never writes, replaces or
 * deletes them. `bunfig.toml` is here because it is written solely from
 * `bunfig.public.toml`; a `/`-terminated entry is a directory prefix.
 */
export const PUBLIC_KEEP_LIST = [
    ".gitignore",
    ".github/",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "bunfig.toml",
    ".git/",
];

/** The one remote the target may have: `origin` at the public repository. */
const PUBLIC_REMOTE =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)nordvec\/partial-content(?:\.git)?\/?$/i;

/** Git's modes for a regular file; anything else (a link 120000, a submodule 160000) is refused. */
const REGULAR_MODES = new Set(["100644", "100755"]);

/** A condition under which the sync refuses to run, reported as `{ problem }`. */
class Refusal extends Error {}

/** @param {string} rel a `/`-separated path relative to the repository root */
export const isKept = (rel) =>
    PUBLIC_KEEP_LIST.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry));

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** NUL-separated git output as paths. */
const lines = (out) => out.split("\0").filter(Boolean);

/**
 * `{ mode, oid, path }` for each entry of NUL-separated `ls-tree` or `ls-files -s`
 * output: `<mode> <type|oid> ... TAB <path>`.
 * @param {string} out
 * @param {"tree" | "index"} kind
 */
function entriesOf(out, kind) {
    return lines(out).map((record) => {
        const tab = record.indexOf("\t");
        const fields = record.slice(0, tab).split(" ");
        return { mode: fields[0], oid: kind === "tree" ? fields[2] : fields[1], path: record.slice(tab + 1) };
    });
}

/**
 * The full commit id `rev` names in `srcDir`.
 * @param {string} srcDir
 * @param {string} rev
 * @returns {string}
 */
function resolveRev(srcDir, rev) {
    if (rev.startsWith("-")) throw new Refusal(`${rev} is not a commit`);
    try {
        return git(srcDir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim();
    } catch {
        throw new Refusal(`${rev} is not a commit in ${srcDir}`);
    }
}

/**
 * The source set at `sha` as `{ target path -> { from, mode, oid } }`, paths
 * `/`-separated and relative to their root.
 * @param {string} srcDir
 * @param {string} sha
 * @returns {Map<string, { from: string, mode: string, oid: string }>}
 */
export function sourceSet(srcDir, sha) {
    const map = new Map();
    const folded = new Map();
    for (const { mode, oid, path: own } of entriesOf(git(srcDir, ["ls-tree", "-r", "-z", sha, "--", "."]), "tree")) {
        if (DEV_HOME_ONLY.has(own)) continue;
        if (!REGULAR_MODES.has(mode)) throw new Refusal(`${own} is mode ${mode} in ${sha}: only regular files mirror`);
        const target = own === RENAMED.source ? RENAMED.target : own;
        if (isKept(target) && own !== RENAMED.source)
            throw new Refusal(`${own} is tracked here but ${target} belongs to the public repository (keep-list)`);
        const key = target.toLowerCase();
        if (folded.has(key)) throw new Refusal(`${folded.get(key)} and ${own} differ only by case`);
        folded.set(key, own);
        map.set(target, { from: own, mode, oid });
    }
    if (!map.has(RENAMED.target)) throw new Refusal(`${RENAMED.source} is not tracked in ${sha}`);
    return map;
}

/**
 * The contents of blobs, by object id, from `srcDir`'s object database.
 * @param {string} srcDir
 * @param {string[]} oids
 * @returns {Map<string, Buffer>}
 */
function readBlobs(srcDir, oids) {
    const unique = [...new Set(oids)];
    const out = execFileSync("git", ["cat-file", "--batch"], {
        cwd: srcDir,
        input: `${unique.join("\n")}\n`,
        maxBuffer: 1 << 30,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const blobs = new Map();
    let at = 0;
    for (const oid of unique) {
        const eol = out.indexOf(10, at);
        const [name, type, size] = out.toString("utf8", at, eol).split(" ");
        if (name !== oid || type !== "blob") throw new Refusal(`object ${oid} is not a readable blob`);
        const start = eol + 1;
        blobs.set(oid, out.subarray(start, start + Number(size)));
        at = start + Number(size) + 1;
    }
    return blobs;
}

/**
 * Why `to` is not a safe target, or undefined when it is one.
 * @param {string} to
 * @returns {string | undefined}
 */
export function refuseTarget(to) {
    if (!existsSync(to)) return `${to} does not exist`;
    let top;
    try {
        top = git(to, ["rev-parse", "--show-toplevel"]).trim();
    } catch {
        return `${to} is not a git repository`;
    }
    if (path.resolve(top) !== path.resolve(to)) return `${to} is inside a repository, not its root (${top})`;
    let remote;
    try {
        remote = git(to, ["remote", "get-url", "origin"]).trim();
    } catch {
        return `${to} has no origin remote`;
    }
    if (!PUBLIC_REMOTE.test(remote)) return `origin is ${remote}, not github.com/nordvec/partial-content`;
    if (git(to, ["status", "--porcelain"]).trim()) return `${to} has uncommitted changes`;
    return undefined;
}

/** @param {string} dir remove it and its parents up to `root` while they are empty */
function pruneEmpty(dir, root) {
    for (let d = dir; d !== root && d.startsWith(root) && readdirSync(d).length === 0; d = path.dirname(d))
        rmdirSync(d);
}

/** Whether `rel` exists under `root` with exactly this spelling, which a case-insensitive volume does not guarantee of `existsSync`. */
function existsExact(root, rel) {
    const parts = rel.split("/");
    let dir = root;
    for (const part of parts) {
        let names;
        try {
            names = readdirSync(dir);
        } catch {
            return false;
        }
        if (!names.includes(part)) return false;
        dir = path.join(dir, part);
    }
    return true;
}

/**
 * The target's files as the sync sees them: tracked or new and not ignored, and
 * present on disk under their tracked spelling (a deletion stays in the index
 * until the maintainer commits).
 * @param {string} to
 */
const targetFiles = (to) =>
    // Case-sensitive index lookups: a case-folding checkout would otherwise call `README.md`
    // tracked because `Readme.md` is, and never list it.
    lines(
        git(to, ["-c", "core.ignorecase=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
    ).filter((rel) => existsExact(to, rel));

/**
 * Refuse a write or delete whose destination is a link or whose parent leaves
 * the target.
 * @param {string} dest
 * @param {string} realTo realpath of the target root
 */
function checkContained(dest, realTo) {
    let stat;
    try {
        stat = lstatSync(dest);
    } catch {
        stat = undefined;
    }
    if (stat?.isSymbolicLink()) throw new Refusal(`${dest} is a symbolic link in the target`);
    let ancestor = path.dirname(dest);
    while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const inside = path.relative(realTo, realpathSync(ancestor));
    if (inside.startsWith("..") || path.isAbsolute(inside))
        throw new Refusal(`${dest} resolves outside the target through ${ancestor}`);
}

const execBit = (mode) => mode === "100755";

/**
 * Plan, and with `apply` perform, the mirror of `srcDir` at `rev` into `to`.
 * @param {{ to: string, apply?: boolean, srcDir?: string, rev?: string }} opts
 * @returns {{ rev: string, added: string[], changed: string[], deleted: string[] } | { problem: string }}
 */
export function syncPublic({ to, apply = false, srcDir = PKG_DIR, rev = "HEAD" }) {
    try {
        return mirror({ to, apply, srcDir, rev });
    } catch (error) {
        if (error instanceof Refusal) return { problem: error.message };
        throw error;
    }
}

/**
 * What a run would do: the commit, the source set, its blobs, the target's
 * tracked modes and the three path lists.
 * @typedef {{
 *   rev: string,
 *   sources: Map<string, { from: string, mode: string, oid: string }>,
 *   blobs: Map<string, Buffer>,
 *   trackedMode: Map<string, string>,
 *   added: string[], changed: string[], deleted: string[],
 * }} Plan
 */

/**
 * Every refusal and the three path lists, before anything is written.
 * @param {{ to: string, srcDir: string, rev: string }} opts
 * @returns {Plan}
 */
function plan({ to, srcDir, rev }) {
    if (git(srcDir, ["status", "--porcelain", "--untracked-files=no", "--", "."]).trim())
        throw new Refusal(`${srcDir} has uncommitted changes: commit them, the mirror is of a commit`);
    const refusal = refuseTarget(to);
    if (refusal) throw new Refusal(refusal);
    const sha = resolveRev(srcDir, rev);
    const sources = sourceSet(srcDir, sha);
    const trackedEntries = entriesOf(git(to, ["ls-files", "-s", "-z"]), "index");
    const link = trackedEntries.find((e) => !REGULAR_MODES.has(e.mode));
    if (link) throw new Refusal(`${link.path} is mode ${link.mode} in the target: only regular files are mirrored`);
    const trackedMode = new Map(trackedEntries.map((e) => [e.path, e.mode]));
    const blobs = readBlobs(
        srcDir,
        [...sources.values()].map((s) => s.oid),
    );
    const realTo = realpathSync(to);

    const added = [];
    const changed = [];
    for (const [rel, { mode, oid }] of sources) {
        const dest = path.join(to, rel);
        checkContained(dest, realTo);
        // "Present" is the target's tracked spelling, not the disk's: a case-insensitive
        // volume answers for `foo.md` while only `Foo.md` is tracked.
        const tracked = trackedMode.get(rel);
        if (tracked === undefined) added.push(rel);
        else if (
            !existsExact(to, rel) ||
            !readFileSync(dest).equals(/** @type {Buffer} */ (blobs.get(oid))) ||
            execBit(tracked) !== execBit(mode)
        )
            changed.push(rel);
    }
    const deleted = [...trackedMode.keys()].filter((rel) => !sources.has(rel) && !isKept(rel));
    for (const rel of deleted) checkContained(path.join(to, rel), realTo);
    return {
        rev: sha,
        sources,
        blobs,
        trackedMode,
        added: added.toSorted(),
        changed: changed.toSorted(),
        deleted: deleted.toSorted(),
    };
}

/**
 * Write the plan. Deletions come first: a case-only rename deletes the old
 * spelling, then writes the new one as a fresh file, so the volume's case
 * folding cannot undo either step.
 * @param {string} to
 * @param {Plan} p
 */
function writePlan(to, { sources, blobs, trackedMode, added, changed, deleted }) {
    for (const rel of deleted) {
        rmSync(path.join(to, rel), { force: true });
        pruneEmpty(path.dirname(path.join(to, rel)), path.resolve(to));
    }
    for (const rel of [...added, ...changed]) {
        const { mode, oid } = /** @type {{ mode: string, oid: string }} */ (sources.get(rel));
        const dest = path.join(to, rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, /** @type {Buffer} */ (blobs.get(oid)));
        chmodSync(dest, execBit(mode) ? 0o755 : 0o644);
        // A volume without exec bits cannot carry one on disk; the index can.
        const tracked = trackedMode.get(rel);
        if (tracked !== undefined && execBit(tracked) !== execBit(mode))
            git(to, ["update-index", `--chmod=${execBit(mode) ? "+x" : "-x"}`, "--", rel]);
    }
}

/**
 * The defect in the target after a write, or null when its names, contents and
 * modes equal the source set plus the kept files.
 * @param {string} to
 * @param {Plan} p
 * @returns {string | null}
 */
function verifyApplied(to, { sources, blobs, trackedMode }) {
    const expected = new Set([...sources.keys(), ...[...trackedMode.keys()].filter(isKept)]);
    const actual = new Set(targetFiles(to));
    const missing = [...expected].filter((rel) => !actual.has(rel));
    const extra = [...actual].filter((rel) => !expected.has(rel));
    if (missing.length > 0 || extra.length > 0)
        return `target differs from source set plus keep-list after apply: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`;
    const wrong = [...sources].filter(([rel, { mode, oid }]) => {
        const dest = path.join(to, rel);
        if (!readFileSync(dest).equals(/** @type {Buffer} */ (blobs.get(oid)))) return true;
        // The exec bit is read from disk only where the volume keeps one.
        const onDisk = (statSync(dest).mode & 0o111) !== 0;
        return process.platform !== "win32" && onDisk !== execBit(mode);
    });
    return wrong.length > 0
        ? `target content or mode differs from the commit after apply: [${wrong.map(([r]) => r).join(", ")}]`
        : null;
}

function mirror({ to, apply, srcDir, rev }) {
    const p = plan({ to, srcDir, rev });
    const { added, changed, deleted } = p;
    if (!apply) return { rev: p.rev, added, changed, deleted };
    writePlan(to, p);
    const problem = verifyApplied(to, p);
    return problem ? { problem } : { rev: p.rev, added, changed, deleted };
}

if (invokedDirectly(import.meta.url)) {
    const usage = "usage: node scripts/sync-public.mjs --to <public checkout> [--rev <commit>] [--apply]";
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const valueOf = (flag) => {
        const at = args.indexOf(flag);
        return at >= 0 ? { at, value: args[at + 1] } : undefined;
    };
    const toArg = valueOf("--to");
    const revArg = valueOf("--rev");
    const consumed = new Set(["--apply", "--to", "--rev"]);
    const rest = args.filter((a, i) => !consumed.has(a) && i !== (toArg?.at ?? -9) + 1 && i !== (revArg?.at ?? -9) + 1);
    if (!toArg?.value || (revArg && !revArg.value) || rest.length > 0) {
        console.error(usage);
        process.exit(2);
    }
    const result = syncPublic({ to: path.resolve(toArg.value), apply, rev: revArg?.value });
    if ("problem" in result) {
        console.error(`sync-public: ${result.problem}`);
        process.exit(1);
    }
    console.log(`source commit ${result.rev}`);
    for (const [label, paths] of [
        ["added", result.added],
        ["changed", result.changed],
        ["deleted", result.deleted],
    ]) {
        console.log(`${label} (${paths.length})`);
        for (const p of paths) console.log(`  ${p}`);
    }
    console.log(apply ? "applied; nothing was committed or pushed" : "dry run; pass --apply to write these changes");
}
