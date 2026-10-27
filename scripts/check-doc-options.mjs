/**
 * Every option the package exports is documented in docs/API.md.
 *
 * The option list is derived from the code, never kept by hand: every
 * subpath in the `exports` map is compiled, and every property of every
 * exported interface whose name ends in `Options` (inherited properties
 * included) must appear in the reference as a code span, `name` or `name?`.
 * A hand-kept capability table is how the reference came to deny an option
 * the package ships; deriving the list is what keeps the next option from
 * shipping undocumented.
 *
 * This proves presence, not correctness: a documented option can still be
 * described wrongly, which is what review and check:doc-types are for.
 *
 * Usage: `bun run check:doc-options`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const entries = Object.values(pkg.exports)
    .filter((target) => typeof target === "object" && typeof target.bun === "string")
    .map((target) => path.join(pkgDir, target.bun));

const program = ts.createProgram(entries, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
});
const checker = program.getTypeChecker();

/**
 * Exported slices of a third-party SDK's own option bags, typed so a consumer
 * can write a shim without a cast. Their members are the SDK's to document;
 * docs/API.md lists the interfaces themselves. A name here that stops being
 * exported fails the run, so the list cannot outlive what it excuses.
 */
const SDK_SHIMS = new Set(["AzureGenerateSasUrlOptions", "R2GetOptions"]);
const shimsSeen = new Set();

/** option name -> the interfaces declaring it, for the failure message. */
const options = new Map();
for (const entry of entries) {
    const source = program.getSourceFile(entry);
    if (!source) throw new Error(`check:doc-options: ${path.relative(pkgDir, entry)} did not load`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        if (!(symbol.flags & ts.SymbolFlags.Interface) || !exported.name.endsWith("Options")) continue;
        if (SDK_SHIMS.has(exported.name)) {
            shimsSeen.add(exported.name);
            continue;
        }
        const type = checker.getDeclaredTypeOfSymbol(symbol);
        for (const property of checker.getPropertiesOfType(type)) {
            const owners = options.get(property.name) ?? new Set();
            owners.add(exported.name);
            options.set(property.name, owners);
        }
    }
}
if (options.size === 0) {
    console.error("check:doc-options: no exported *Options interface found; the scan is broken");
    process.exit(2);
}
const staleShims = [...SDK_SHIMS].filter((name) => !shimsSeen.has(name));
if (staleShims.length > 0) {
    console.error(`check:doc-options: SDK_SHIMS names interfaces no subpath exports: ${staleShims.join(", ")}`);
    process.exit(1);
}

const reference = readFileSync(path.join(pkgDir, "docs", "API.md"), "utf8");
const documented = new Set();
for (const [, name] of reference.matchAll(/`([A-Za-z_$][\w$]*)\??`/g)) documented.add(name);
// A code span that opens with the name covers `name: value` and `name(...)`.
for (const [, name] of reference.matchAll(/`([A-Za-z_$][\w$]*)\??[:( ]/g)) documented.add(name);
// A dotted span names a nested option: `checksum.maxBufferBytes`.
for (const [, name] of reference.matchAll(/`[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\??`/g)) documented.add(name);
// A signature span lists its options in braces: `httpStore({ url, headers? })`.
for (const [span] of reference.matchAll(/`[^`\n]*\{[^`\n]*\}[^`\n]*`/g)) {
    for (const [, group] of span.matchAll(/\{([^{}]*)\}/g)) {
        for (const [, name] of group.matchAll(/(?:^|[,{]\s*|\s)([A-Za-z_$][\w$]*)\??\s*(?=[,:}]|$)/g))
            documented.add(name);
    }
}

const missing = [...options].filter(([name]) => !documented.has(name)).toSorted(([a], [b]) => a.localeCompare(b));
if (missing.length > 0) {
    console.error(`check:doc-options: ${missing.length} exported option(s) missing from docs/API.md:`);
    for (const [name, owners] of missing) console.error(`  ${name} (${[...owners].toSorted().join(", ")})`);
    process.exit(1);
}
console.log(`check:doc-options: all ${options.size} exported options are documented`);
