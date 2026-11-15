import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error - a repo-tooling .mjs with no declarations; the package ships neither.
import { syncPublic as syncPublicUntyped } from "../../scripts/sync-public.mjs";
import { removeTree } from "./temp-cleanup.ts";

type Plan = { rev: string; added: string[]; changed: string[]; deleted: string[] } | { problem: string };
const syncPublic = syncPublicUntyped as (opts: { to: string; apply?: boolean; srcDir: string; rev?: string }) => Plan;

const scratch = mkdtempSync(path.join(tmpdir(), "sync-public-test-"));
afterAll(() => removeTree(scratch));

const PUBLIC_URL = "https://github.com/nordvec/partial-content.git";

const git = (cwd: string, ...args: string[]) =>
    execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
        {
            cwd,
            encoding: "utf8",
        },
    );

function put(root: string, files: Record<string, string>) {
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), text);
    }
}

let counter = 0;
function repo(files: Record<string, string>, remote?: string) {
    const root = path.join(scratch, `r${counter++}`);
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q");
    if (remote) git(root, "remote", "add", "origin", remote);
    put(root, files);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "seed");
    return root;
}

const sourceFiles = {
    "package.json": "{}",
    "src/index.ts": "export {};",
    "AGENTS.md": "dev only",
    "CLAUDE.md": "dev only",
    "bunfig.toml": "dev bunfig",
    "bunfig.public.toml": "telemetry = false",
    ".gitignore": "dev ignore",
};

const publicFiles = {
    "package.json": "{ old }",
    "src/index.ts": "export {};",
    "src/tus.ts": "stale write side",
    "src/upload/store.ts": "stale write side",
    ".gitignore": "public ignore",
    ".github/workflows/release.yml": "name: release",
    "bun.lock": "lock",
    "bunfig.toml": "old public bunfig",
};

describe("syncPublic", () => {
    it("deletes a stale file, keeps the public-only files and maps the public bunfig", () => {
        const srcDir = repo(sourceFiles);
        const to = repo(publicFiles, PUBLIC_URL);
        const result = syncPublic({ to, srcDir, apply: true });
        expect(result).toMatchObject({
            added: [],
            changed: ["bunfig.toml", "package.json"],
            deleted: ["src/tus.ts", "src/upload/store.ts"],
        });
        expect(existsSync(path.join(to, "src/tus.ts"))).toBe(false);
        expect(existsSync(path.join(to, "src/upload"))).toBe(false);
        expect(readFileSync(path.join(to, ".gitignore"), "utf8")).toBe("public ignore");
        expect(readFileSync(path.join(to, ".github/workflows/release.yml"), "utf8")).toBe("name: release");
        expect(readFileSync(path.join(to, "bun.lock"), "utf8")).toBe("lock");
        expect(readFileSync(path.join(to, "bunfig.toml"), "utf8")).toBe("telemetry = false");
        expect(existsSync(path.join(to, "bunfig.public.toml"))).toBe(false);
        for (const devOnly of ["AGENTS.md", "CLAUDE.md"]) expect(existsSync(path.join(to, devOnly))).toBe(false);
        expect(readFileSync(path.join(to, "package.json"), "utf8")).toBe("{}");
    });

    it("adds a source file the public repository lacks", () => {
        const srcDir = repo({ ...sourceFiles, "docs/new.md": "new" });
        const to = repo(publicFiles, PUBLIC_URL);
        const result = syncPublic({ to, srcDir, apply: true });
        expect("added" in result && result.added).toEqual(["docs/new.md"]);
        expect(readFileSync(path.join(to, "docs/new.md"), "utf8")).toBe("new");
    });

    it("changes nothing on a dry run", () => {
        const srcDir = repo(sourceFiles);
        const to = repo(publicFiles, PUBLIC_URL);
        const result = syncPublic({ to, srcDir });
        expect(result).toMatchObject({
            added: [],
            changed: ["bunfig.toml", "package.json"],
            deleted: ["src/tus.ts", "src/upload/store.ts"],
        });
        expect(git(to, "status", "--porcelain")).toBe("");
        expect(existsSync(path.join(to, "src/tus.ts"))).toBe(true);
    });

    it("refuses a dirty target", () => {
        const srcDir = repo(sourceFiles);
        const to = repo(publicFiles, PUBLIC_URL);
        writeFileSync(path.join(to, "src/index.ts"), "edited");
        const result = syncPublic({ to, srcDir, apply: true });
        expect(result).toEqual({ problem: expect.stringContaining("uncommitted changes") });
        expect(existsSync(path.join(to, "src/tus.ts"))).toBe(true);
    });

    it("refuses a target whose origin is not the public repository", () => {
        const srcDir = repo(sourceFiles);
        const wrong = repo(publicFiles, "https://github.com/nordvec/nordvec.git");
        expect(syncPublic({ to: wrong, srcDir, apply: true })).toEqual({
            problem: expect.stringContaining("not github.com/nordvec/partial-content"),
        });
        const none = repo(publicFiles);
        expect(syncPublic({ to: none, srcDir, apply: true })).toEqual({
            problem: expect.stringContaining("no origin remote"),
        });
        expect(existsSync(path.join(wrong, "src/tus.ts"))).toBe(true);
    });

    it("refuses a directory inside a repository rather than its root", () => {
        const srcDir = repo(sourceFiles);
        const to = repo(publicFiles, PUBLIC_URL);
        const inner = path.join(to, "src");
        expect(syncPublic({ to: inner, srcDir })).toEqual({ problem: expect.stringContaining("not its root") });
    });

    it.each([
        "https://evil.example/github.com/nordvec/partial-content",
        "git@notgithub.com:nordvec/partial-content.git",
        "https://github.com/nordvec/partial-content-fork.git",
        "https://github.com/someone/nordvec/partial-content.git",
    ])("refuses the look-alike origin %s", (origin) => {
        const srcDir = repo(sourceFiles);
        const to = repo(publicFiles, origin);
        expect(syncPublic({ to, srcDir })).toEqual({ problem: expect.stringContaining("not github.com/nordvec") });
    });

    it.each([
        "git@github.com:nordvec/partial-content.git",
        "ssh://git@github.com/nordvec/partial-content",
        "https://GitHub.com/nordvec/partial-content/",
    ])("accepts the origin %s", (origin) => {
        const srcDir = repo(sourceFiles);
        const to = repo(publicFiles, origin);
        expect(syncPublic({ to, srcDir })).toHaveProperty("added");
    });

    it("refuses a source with uncommitted changes and mirrors the commit, not the working tree", () => {
        const srcDir = repo({ ...sourceFiles, "src/a.ts": "committed" });
        const to = repo({ ...publicFiles, "src/a.ts": "committed" }, PUBLIC_URL);
        writeFileSync(path.join(srcDir, "src/a.ts"), "UNCOMMITTED");
        expect(syncPublic({ to, srcDir, apply: true })).toEqual({ problem: expect.stringContaining("uncommitted") });
        expect(readFileSync(path.join(to, "src/a.ts"), "utf8")).toBe("committed");
        git(srcDir, "checkout", "--", ".");
        const first = git(srcDir, "rev-parse", "HEAD").trim();
        put(srcDir, { "src/a.ts": "second" });
        git(srcDir, "commit", "-q", "-am", "second");
        const result = syncPublic({ to, srcDir, apply: true, rev: first });
        expect(result).toMatchObject({ rev: first });
        expect(readFileSync(path.join(to, "src/a.ts"), "utf8")).toBe("committed");
        git(to, "checkout", "--", ".");
        expect(syncPublic({ to, srcDir })).toMatchObject({ rev: git(srcDir, "rev-parse", "HEAD").trim() });
        expect(syncPublic({ to, srcDir, rev: "no-such-rev" })).toEqual({
            problem: expect.stringContaining("not a commit"),
        });
    });

    it("refuses a symbolic link tracked on either side", () => {
        const linkIn = (root: string, rel: string) => {
            const blob = path.join(root, "link-target");
            writeFileSync(blob, "elsewhere");
            const oid = git(root, "hash-object", "-w", "link-target").trim();
            rmSync(blob);
            git(root, "update-index", "--add", "--cacheinfo", `120000,${oid},${rel}`);
            git(root, "commit", "-q", "-m", "link");
            git(root, "checkout", "--", rel);
        };
        const srcDir = repo(sourceFiles);
        const to = repo(publicFiles, PUBLIC_URL);
        linkIn(srcDir, "NOTES.md");
        expect(syncPublic({ to, srcDir })).toEqual({ problem: expect.stringContaining("only regular files mirror") });
        const cleanSrc = repo(sourceFiles);
        linkIn(to, "NOTES.md");
        expect(syncPublic({ to, srcDir: cleanSrc, apply: true })).toEqual({
            problem: expect.stringContaining("only regular files are mirrored"),
        });
    });

    it("refuses a write whose parent directory resolves outside the target", () => {
        const srcDir = repo({ ...sourceFiles, "docs/new.md": "new" });
        const to = repo(publicFiles, PUBLIC_URL);
        const outside = path.join(scratch, `outside${counter++}`);
        mkdirSync(outside);
        symlinkSync(outside, path.join(to, "docs"), "junction");
        appendFileSync(path.join(to, ".git/info/exclude"), "docs\n");
        expect(syncPublic({ to, srcDir, apply: true })).toEqual({
            problem: expect.stringContaining("resolves outside the target"),
        });
        expect(readdirSync(outside)).toEqual([]);
    });

    it("never writes a path the public repository owns", () => {
        const srcDir = repo({ ...sourceFiles, ".github/workflows/ci.yml": "monorepo ci" });
        const to = repo(publicFiles, PUBLIC_URL);
        expect(syncPublic({ to, srcDir, apply: true })).toEqual({ problem: expect.stringContaining("keep-list") });
        expect(readFileSync(path.join(to, ".github/workflows/release.yml"), "utf8")).toBe("name: release");
        expect(existsSync(path.join(to, ".github/workflows/ci.yml"))).toBe(false);
    });

    it.each(["same", "changed"])("ends a case-only rename with the file present under its new name (%s)", (content) => {
        const srcDir = repo({ ...sourceFiles, "docs/Guide.md": "same", "Readme.md": "r" });
        git(srcDir, "mv", "docs/Guide.md", "docs/guide.md");
        git(srcDir, "mv", "Readme.md", "README.md");
        put(srcDir, { "docs/guide.md": content });
        git(srcDir, "commit", "-q", "-am", "case rename");
        const to = repo({ ...publicFiles, "docs/Guide.md": "same", "Readme.md": "r" }, PUBLIC_URL);
        const result = syncPublic({ to, srcDir, apply: true });
        expect(result).toMatchObject({
            added: ["README.md", "docs/guide.md"],
            deleted: expect.arrayContaining(["Readme.md", "docs/Guide.md"]),
        });
        expect(readdirSync(to)).toContain("README.md");
        expect(readdirSync(to)).not.toContain("Readme.md");
        expect(readdirSync(path.join(to, "docs"))).toEqual(["guide.md"]);
        expect(readFileSync(path.join(to, "docs/guide.md"), "utf8")).toBe(content);
    });
});
