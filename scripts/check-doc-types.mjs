/**
 * Typecheck the TypeScript in the documentation.
 *
 * The docs are the API's other implementation: a reference template that does
 * not compile is the same defect as a function that does not, and it is worse
 * for a consumer, who copies it before finding out. This gate derives its
 * verdict from the documents themselves rather than from anyone remembering to
 * try the snippets, so a doc and the code it documents cannot drift apart
 * silently.
 *
 * Every fenced `typescript` block in README.md and docs/*.md is extracted into
 * its own module and compiled against the real source. A block is skipped when
 * it is not meant to stand alone:
 *
 *   - it opens with the marker `// doc-check: fragment` (a deliberate excerpt),
 *   - or it imports a package other than this one, since the gate is about our
 *     API and not about whether a third-party type happens to be installed.
 *
 * Usage: `bun run check:doc-types`.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const FRAGMENT_MARKER = "doc-check: fragment";

/**
 * The language level every block compiles at. Each block compiles the real
 * source, so the target and ES lib are the package's own, read from its
 * tsconfig: a level kept here by hand refuses any API the package's lib
 * admits once the package moves past it. The DOM libs are this gate's
 * addition, the consumer's view of the Fetch types, which the package's own
 * lib does not load.
 */
function languageLevel() {
    const ts = require_("typescript");
    const { config, error } = ts.readConfigFile(path.join(pkgDir, "tsconfig.json"), ts.sys.readFile);
    if (error) {
        throw new Error(`check:doc-types: tsconfig.json: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
    }
    const { target, lib } = config.compilerOptions ?? {};
    if (typeof target !== "string" || !Array.isArray(lib)) {
        throw new Error("check:doc-types: tsconfig.json names no target and lib to compile the source at");
    }
    return { target, lib: [...lib, "DOM", "DOM.Iterable"] };
}
// Indentation is captured so a block nested inside a list item is checked
// too. A fence the extractor cannot see is a documented snippet nobody
// compiles, which is the gap this gate exists to close.
const BLOCK = /\n([ \t]*)```(?:typescript|ts)\n([\s\S]*?)\n[ \t]*```/g;
const BARE_IMPORT = /\bfrom\s+["']([^."'][^"']*)["']/g;

function docFiles() {
    const docs = path.join(pkgDir, "docs");
    return [
        path.join(pkgDir, "README.md"),
        ...readdirSync(docs)
            .filter((f) => f.endsWith(".md"))
            .map((f) => path.join(docs, f)),
    ];
}

/** Every specifier the block imports that is neither ours nor a node: builtin. */
function foreignImports(code) {
    const out = [];
    for (const [, spec] of code.matchAll(BARE_IMPORT)) {
        if (spec === "partial-content" || spec.startsWith("partial-content/")) continue;
        if (spec.startsWith("node:")) continue;
        out.push(spec);
    }
    return out;
}

const checked = [];
const skipped = [];
for (const file of docFiles()) {
    const text = readFileSync(file, "utf8");
    const rel = path.relative(pkgDir, file).replaceAll("\\", "/");
    let index = 0;
    for (const match of text.matchAll(BLOCK)) {
        index += 1;
        const indent = match[1] ?? "";
        // Re-flush to column zero: the surrounding prose owns the indentation,
        // the TypeScript does not.
        const code =
            indent === ""
                ? match[2]
                : match[2]
                      .split("\n")
                      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
                      .join("\n");
        const line = text.slice(0, match.index).split("\n").length + 1;
        const where = `${rel}:${line}`;
        if (code.includes(FRAGMENT_MARKER)) {
            skipped.push(`${where} (marked fragment)`);
            continue;
        }
        const foreign = foreignImports(code);
        if (foreign.length > 0) {
            skipped.push(`${where} (imports ${foreign.join(", ")})`);
            continue;
        }
        checked.push({ where, code, name: `${rel.replaceAll("/", "_").replace(/\.md$/, "")}_${index}.ts` });
    }
}

if (checked.length === 0) {
    console.error("check:doc-types: no self-contained blocks found, which is itself suspicious");
    process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), "pc-doc-types-"));
try {
    for (const block of checked) {
        // `export {}` keeps each block its own module, so two blocks declaring the
        // same name do not collide and a top-level await stays legal.
        writeFileSync(path.join(dir, block.name), `${block.code}\nexport {};\n`, "utf8");
    }
    // ESM, so a documented snippet may use top-level await the way a consumer
    // would in a module.
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify(
            {
                compilerOptions: {
                    module: "nodenext",
                    moduleResolution: "nodenext",
                    ...languageLevel(),
                    strict: true,
                    noEmit: true,
                    skipLibCheck: true,
                    // The package itself compiles with the node types and declares an engines
                    // floor for them, so the gate must resolve them too or every block that
                    // reaches a node: import fails for a reason the consumer never sees.
                    types: ["node"],
                    typeRoots: [
                        path.join(pkgDir, "node_modules/@types").replaceAll("\\", "/"),
                        path.join(pkgDir, "../../node_modules/@types").replaceAll("\\", "/"),
                    ],
                    allowImportingTsExtensions: true,
                    // Absolute targets, so no baseUrl is needed to anchor them.
                    paths: {
                        "partial-content": [path.join(pkgDir, "src/index.ts").replaceAll("\\", "/")],
                        "partial-content/*": [path.join(pkgDir, "src/*.ts").replaceAll("\\", "/")],
                    },
                },
                include: ["*.ts"],
            },
            null,
            2,
        ),
        "utf8",
    );

    // Resolve typescript's own entry point rather than a platform-specific shim,
    // so the gate runs the same way on every developer machine and in CI.
    const tscJs = path.join(path.dirname(require_.resolve("typescript/package.json")), "bin", "tsc");
    const run = spawnSync(process.execPath, [tscJs, "--noEmit", "-p", path.join(dir, "tsconfig.json")], {
        encoding: "utf8",
    });

    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    if (run.status !== 0) {
        // Map the generated filename back to the document and line the reader owns.
        let mapped = output;
        for (const block of checked) mapped = mapped.replaceAll(block.name, block.where);
        console.error(`check:doc-types: ${checked.length} documented block(s) checked, some do not compile\n`);
        console.error(mapped);
        console.error(
            "\nA documented snippet that does not compile is a defect in the API's other implementation." +
                `\nMark a deliberate excerpt with a leading \`// ${FRAGMENT_MARKER}\` comment.`,
        );
        process.exit(1);
    }
    console.log(`check:doc-types: ${checked.length} documented block(s) compile`);
    for (const s of skipped) console.log(`  skipped ${s}`);
} finally {
    // oxlint-disable-next-line nordvec/no-restricted-syntax -- dir is the mkdtemp result created at the top of this script, assigned before the try.
    rmSync(dir, { recursive: true, force: true });
}
