/**
 * Render the parts of `docs/API.md` that restate a contract the source already
 * states, so the reference cannot drift from the TSDoc and the conformance
 * harness it describes.
 *
 * A region is the text between `<!-- generated:<id> -->` and
 * `<!-- /generated:<id> -->`. Each id in `REGIONS` names the source file and
 * the renderer that produces its body: the members of a contract interface
 * with their signatures and TSDoc, or the check table of a conformance
 * harness with each check's obligation and the reasons it can be skipped.
 * Parsing goes through the TypeScript compiler API (a devDependency), so a
 * reformatted signature or a multi-line string concatenation reads the same.
 *
 * Usage:
 *   node scripts/api-doc-regions.mjs          rewrite every region in place
 *   node scripts/api-doc-regions.mjs --check  exit 1 naming each stale region
 *
 * `--check` runs as `check:api-docs` in `prepublishOnly`. A region marker the
 * registry does not know, or a registered region missing from the document,
 * fails both modes: either is a document the generator can no longer keep
 * current.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The TSDoc block directly above `node`, as Markdown-ready text, or "". */
function docOf(node, sourceFile) {
    const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
    const block = ranges
        .map((r) => sourceFile.text.slice(r.pos, r.end))
        .filter((text) => text.startsWith("/**"))
        .at(-1);
    if (block === undefined) return "";
    const lines = block
        .slice(3, -2)
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\*(?: |$)/, "").replace(/\s+$/, ""));
    return tsdocToMarkdown(lines.join("\n").trim());
}

/**
 * Inline TSDoc to Markdown: `{@link X}` becomes `` `X` `` and
 * `{@link X | label}` becomes the label. Block tags keep their text under the
 * tag name, since a reader of the reference needs what they say.
 * @param {string} text
 * @returns {string}
 */
export function tsdocToMarkdown(text) {
    return text
        .replace(/\{@link(?:code|plain)?\s+([^}|]+?)\s*\|\s*([^}]+?)\s*\}/g, "$2")
        .replace(/\{@link(?:code|plain)?\s+([^}]+?)\s*\}/g, "`$1`")
        .replace(/^@default\s+(.*)$/gm, "Default: $1.")
        .replace(/^@(\w+)\s*/gm, "*@$1* ");
}

/** Whitespace runs to one space, for a signature printed on one line. */
const oneLine = (text) => text.replace(/\s+/g, " ").trim();

/**
 * The members of `interfaceName` in declaration order.
 * @param {string} sourceText
 * @param {string} interfaceName
 * @returns {{ kind: "method" | "property", name: string, optional: boolean, params: string, type: string, doc: string }[]}
 */
export function extractInterfaceMembers(sourceText, interfaceName) {
    const sourceFile = ts.createSourceFile("source.ts", sourceText, ts.ScriptTarget.Latest, true);
    const decl = sourceFile.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === interfaceName);
    if (decl === undefined) throw new Error(`api-doc-regions: no interface ${interfaceName}`);
    return decl.members.map((member) => {
        const name = member.name?.getText(sourceFile);
        if (name === undefined) throw new Error(`api-doc-regions: ${interfaceName} has an unnamed member`);
        const common = { name, optional: member.questionToken !== undefined, doc: docOf(member, sourceFile) };
        if (ts.isMethodSignature(member)) {
            return {
                kind: "method",
                ...common,
                params: member.parameters.map((p) => oneLine(p.getText(sourceFile))).join(", "),
                type: oneLine(member.type?.getText(sourceFile) ?? "void"),
            };
        }
        if (ts.isPropertySignature(member)) {
            return {
                kind: "property",
                ...common,
                params: "",
                type: oneLine(member.type?.getText(sourceFile) ?? "unknown"),
            };
        }
        throw new Error(`api-doc-regions: ${interfaceName}.${name} is neither a method nor a property`);
    });
}

/**
 * The checks a conformance harness records, in the order it first names
 * them: each id with its obligation and every reason it can be skipped. A
 * check is a call to `record(id, obligation, ...)` or `skip(id, obligation,
 * reason)` inside `functionName`; an argument that is not a literal is
 * resolved through `const` initializers and, for a parameter of a local
 * helper, through that helper's call sites. An argument nothing resolves
 * throws, so a refactor the extractor cannot follow fails the run instead of
 * dropping a row.
 * @param {string} sourceText
 * @param {string} functionName
 * @returns {{ id: string, obligation: string, skippedWhen: string[] }[]}
 */
export function extractChecks(sourceText, functionName) {
    const sourceFile = ts.createSourceFile("source.ts", sourceText, ts.ScriptTarget.Latest, true);
    const fn = sourceFile.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === functionName);
    if (fn?.body === undefined) throw new Error(`api-doc-regions: no function ${functionName}`);

    /** `const` initializers by name: module scope, overridden by the function's own. */
    const consts = new Map();
    const collect = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            consts.set(node.name.text, node.initializer);
        }
        ts.forEachChild(node, collect);
    };
    for (const s of sourceFile.statements) if (s !== fn) collect(s);
    collect(fn);

    const calls = [];
    const walk = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node);
        ts.forEachChild(node, walk);
    };
    walk(fn.body);

    /** Every string `node` can evaluate to. */
    const resolve = (node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
        if (ts.isParenthesizedExpression(node)) return resolve(node.expression);
        if (ts.isConditionalExpression(node)) return [...resolve(node.whenTrue), ...resolve(node.whenFalse)];
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const right = resolve(node.right);
            return resolve(node.left).flatMap((l) => right.map((r) => l + r));
        }
        if (ts.isIdentifier(node)) {
            const helper = parameterOwner(node);
            if (helper) {
                return calls
                    .filter((c) => c.expression.text === helper.name)
                    .flatMap((c) => resolve(c.arguments[helper.index]));
            }
            const init = consts.get(node.text);
            if (init) return resolve(init);
        }
        throw new Error(
            `api-doc-regions: cannot resolve \`${node.getText(sourceFile)}\` in ${functionName} to a string`,
        );
    };

    /** The local helper `const name = (..., ident, ...) => ...` whose parameter `ident` is. */
    const parameterOwner = (ident) => {
        for (let node = ident.parent; node; node = node.parent) {
            if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
                const index = node.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === ident.text);
                if (index >= 0 && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
                    return { name: node.parent.name.text, index };
                }
            }
        }
        return undefined;
    };

    return collectChecks(calls, resolve);
}

/** Merge the `record`/`skip` calls among `calls` into one entry per check id. */
function collectChecks(calls, resolve) {
    const checks = new Map();
    for (const call of calls) {
        const callee = call.expression.text;
        const [idArg, obligationArg, reasonArg] = call.arguments;
        const literalId =
            idArg !== undefined && (ts.isStringLiteral(idArg) || ts.isNoSubstitutionTemplateLiteral(idArg));
        if ((callee !== "record" && callee !== "skip") || !literalId) continue;
        const entry = checks.get(idArg.text) ?? { id: idArg.text, obligation: "", skippedWhen: [] };
        if (entry.obligation === "") entry.obligation = [...new Set(resolve(obligationArg))].join(" / ");
        const reasons = callee === "skip" && reasonArg !== undefined ? resolve(reasonArg) : [];
        entry.skippedWhen.push(...[...new Set(reasons)].filter((r) => !entry.skippedWhen.includes(r)));
        checks.set(entry.id, entry);
    }
    return [...checks.values()];
}

/** Indent every non-blank line by two spaces: a list item's continuation. */
const indent = (text) => text.replace(/^(?=.)/gm, "  ");

/** A list item for each member, signature first and its TSDoc below. */
export function renderMembers(members) {
    return members
        .map((m) => {
            const head =
                m.kind === "method"
                    ? `- **\`${m.name}${m.optional ? "?" : ""}(${m.params})\`** -> \`${m.type}\``
                    : `- **\`${m.name}\`** (\`${m.type}\`${m.optional ? ", optional" : ""})`;
            return m.doc === "" ? head : `${head}\n\n${indent(m.doc)}`;
        })
        .join("\n\n");
}

const cell = (text) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** The check count sentence and the table of checks. */
export function renderChecks(checks) {
    const rows = checks.map(
        (c) =>
            `| \`${c.id}\` | ${cell(c.obligation)} | ${c.skippedWhen.length === 0 ? "never" : cell(c.skippedWhen.join("; or "))} |`,
    );
    return [
        `The ${checks.length} checks, by what they pin:`,
        "",
        "| Check | Obligation | Skipped when |",
        "|---|---|---|",
        ...rows,
    ].join("\n");
}

/** Every region the document carries: its id, the source it reads, and how it renders. */
export const REGIONS = [
    {
        id: "write-store-methods",
        source: "src/upload-store.ts",
        render: (src) =>
            renderMembers(extractInterfaceMembers(src, "ResumableWriteStore").filter((m) => m.kind === "method")),
    },
    {
        id: "write-store-flags",
        source: "src/upload-store.ts",
        render: (src) =>
            renderMembers(extractInterfaceMembers(src, "ResumableWriteStore").filter((m) => m.kind === "property")),
    },
    {
        id: "write-store-checks",
        source: "src/conformance.ts",
        render: (src) => renderChecks(extractChecks(src, "checkResumableWriteStore")),
    },
    {
        id: "read-store-checks",
        source: "src/conformance.ts",
        render: (src) => renderChecks(extractChecks(src, "checkObjectStore")),
    },
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Write each rendered body into its region of `doc`.
 * @param {string} doc
 * @param {Map<string, string>} bodies id -> rendered body
 * @returns {{ text: string, stale: string[], problems: string[] }}
 */
export function applyRegions(doc, bodies) {
    const problems = [];
    for (const [, id] of doc.matchAll(/<!-- generated:([\w-]+) -->/g)) {
        if (!bodies.has(id)) problems.push(`docs/API.md carries a region no renderer owns: ${id}`);
    }
    const stale = [];
    let text = doc;
    for (const [id, body] of bodies) {
        const open = `<!-- generated:${id} -->`;
        const close = `<!-- /generated:${id} -->`;
        const pattern = new RegExp(`${escapeRegExp(open)}[\\s\\S]*?${escapeRegExp(close)}`);
        if (!pattern.test(text)) {
            problems.push(`docs/API.md has no region ${id} (expected ${open} ... ${close})`);
            continue;
        }
        const next = text.replace(pattern, () => `${open}\n${body}\n${close}`);
        if (next !== text) stale.push(id);
        text = next;
    }
    return { text, stale, problems };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const docPath = path.join(pkgDir, "docs", "API.md");
    const check = process.argv.includes("--check");
    const bodies = new Map(REGIONS.map((r) => [r.id, r.render(readFileSync(path.join(pkgDir, r.source), "utf8"))]));
    const { text, stale, problems } = applyRegions(readFileSync(docPath, "utf8"), bodies);
    if (problems.length > 0) {
        for (const p of problems) console.error(`api-doc-regions: ${p}`);
        process.exit(1);
    }
    if (check) {
        if (stale.length > 0) {
            console.error(`api-doc-regions: stale region(s) in docs/API.md: ${stale.join(", ")}`);
            console.error("Run `node scripts/api-doc-regions.mjs` in packages/partial-content and commit the result.");
            process.exit(1);
        }
        console.log(`api-doc-regions: ${bodies.size} region(s) in docs/API.md match the source`);
    } else {
        writeFileSync(docPath, text);
        console.log(`api-doc-regions: ${stale.length} of ${bodies.size} region(s) rewritten`);
    }
}
