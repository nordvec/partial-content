/**
 * Refuse to publish a tarball carrying files a consumer should never receive,
 * or one missing the SBOM that names this release (`checkSbom`).
 *
 * `patterns-npm-publish` rule 3 requires this of every publishable package, and
 * rule 1 is the incident behind it: a declaration map or a source map ships the
 * relative paths of the machine that built it, and a stray `.env` or test
 * fixture ships whatever it held. npm publishes what is in the tarball, not
 * what the author pictured, and the mistake is unrecoverable once a version is
 * live.
 *
 * This was an inline `node -e` inside `prepublishOnly`, which made it
 * effectively unreadable and therefore unreviewed. It is a file now so the
 * predicate can be read, and so `prepublishOnly` can chain the package's other
 * pre-publish gates beside it rather than being one long shell line.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SBOM_PATH, npmPurl } from "./write-sbom.mjs";

/**
 * Suspicious by extension, with the two map kinds that ARE expected carved out.
 *
 * `.d.ts.map` and `.js.map` are declared in `files` on purpose: they are what
 * lets a consumer's editor jump into the package's own sources. Everything else
 * matching this pattern is either build residue or something private.
 */
const SUSPICIOUS = /\.(map|env|test|spec)/;
const ALLOWED_MAPS = [".d.ts.map", ".js.map"];

/**
 * npm's own CLI entry point, as a path node can run directly.
 *
 * The tarball's contents are npm's answer, so this needs npm specifically, not
 * whichever runner started the process. `npm_execpath` names the runner, and
 * only npm puts `npm-cli.js` there: under `bun run` it is `bun.exe`, under pnpm
 * `pnpm.cjs`. Handing either to node runs a binary as a script, so the name is
 * checked rather than assumed. Everything else resolves npm beside the running
 * node, in the two layouts an install produces.
 *
 * Two dead ends are recorded because both LOOK right:
 *
 *  - `execFile("npm", [...])` dies with ENOENT on Windows. npm ships as
 *    `npm.cmd`, and Node 20 removed the implicit `.cmd` resolution that used
 *    to cover this.
 *  - Adding `shell: true` fixes that and earns Node's DEP0190, because
 *    arguments passed alongside a shell are concatenated rather than escaped.
 *    Correct here (every argument is a literal) but the wrong habit to leave
 *    in a file whose whole job is refusing unsafe output.
 */
export function resolveNpmCli(env = process.env, execPath = process.execPath, exists = existsSync) {
    const declared = env.npm_execpath;
    if (declared && basename(declared) === "npm-cli.js") return declared;

    const nodeDir = dirname(execPath);
    const candidates = [
        // A non-npm runner still names where the runners live, and npm is its
        // sibling in that same node_modules. This is the path that covers a
        // bun-launched run, where npm is nowhere near the executing binary.
        siblingNpm(declared),
        siblingNpm(execPath),
        join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
        join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ].filter((p) => p !== undefined);

    const found = candidates.find(exists);
    if (!found) {
        throw new Error(
            "check-tarball: cannot find npm's CLI beside " +
                execPath +
                ". " +
                "Run this through npm (`npm run prepublishOnly`), which names it in npm_execpath.",
        );
    }
    return found;
}

/**
 * npm as a peer of `runner` inside the node_modules that contains it.
 *
 * The prefix is kept as one string rather than split into segments and rejoined:
 * splitting an absolute posix path yields a leading empty segment that `join`
 * discards, which silently turns `/home/u/...` into a relative path resolved
 * against the cwd. Windows never shows it, because a drive letter survives.
 */
function siblingNpm(runner) {
    if (!runner) return undefined;
    const upToNodeModules = /^(.*[\\/]node_modules)[\\/]/.exec(runner);
    if (!upToNodeModules) return undefined;
    return join(upToNodeModules[1], "npm", "bin", "npm-cli.js");
}

/** Run `npm pack --dry-run --json` without a shell, on every platform. */
function packedFiles() {
    const out = execFileSync(process.execPath, [resolveNpmCli(), "pack", "--dry-run", "--json"], { encoding: "utf8" });
    return JSON.parse(out)[0].files.map((f) => f.path);
}

/**
 * The defect in the shipped SBOM, or null when the tarball carries it and it
 * describes this manifest. A stale document (from a build before a version
 * bump) is the case that matters: it names a release the tarball is not.
 * @param {string[]} packed paths in the tarball
 * @param {string | undefined} sbomText the document on disk, undefined when absent
 * @param {{ name: string, version: string }} pkg
 * @returns {string | null}
 */
export function checkSbom(packed, sbomText, pkg) {
    if (!packed.includes(SBOM_PATH) || sbomText === undefined) {
        return `${SBOM_PATH} is not in the tarball; run the build, which writes it`;
    }
    let component;
    try {
        component = JSON.parse(sbomText)?.metadata?.component;
    } catch {
        return `${SBOM_PATH} is not valid JSON`;
    }
    const expected = { name: pkg.name, version: pkg.version, purl: npmPurl(pkg.name, pkg.version) };
    for (const [field, value] of Object.entries(expected)) {
        if (component?.[field] !== value) {
            return `${SBOM_PATH} names ${field} ${JSON.stringify(component?.[field])}, but package.json gives ${JSON.stringify(value)}`;
        }
    }
    return null;
}

function main() {
    const packed = packedFiles();
    const bad = packed.filter((p) => SUSPICIOUS.test(p) && !ALLOWED_MAPS.some((ext) => p.endsWith(ext)));
    if (bad.length > 0) {
        console.error("check-tarball: BLOCKED, the tarball contains files a consumer must not receive:");
        for (const p of bad) console.error(`  - ${p}`);
        console.error("Fix the `files` allowlist or the build output; do not publish past this.");
        process.exit(1);
    }
    const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const sbomFile = join(pkgDir, SBOM_PATH);
    const sbomProblem = checkSbom(
        packed,
        existsSync(sbomFile) ? readFileSync(sbomFile, "utf8") : undefined,
        JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")),
    );
    if (sbomProblem) {
        console.error(`check-tarball: BLOCKED, ${sbomProblem}`);
        process.exit(1);
    }
    console.log("check-tarball OK: no suspicious files in the packed tarball, and the SBOM names this release.");
}

// Only when run as the gate. A test imports `resolveNpmCli` from here, and an
// import that packs the tarball as a side effect would make that test the gate.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
