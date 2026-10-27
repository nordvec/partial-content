import { describe, expect, it } from "bun:test";
// @ts-expect-error - a repo-tooling .mjs with no declarations; the package ships neither.
import * as generator from "../../scripts/api-doc-regions.mjs";

interface Member {
    kind: "method" | "property";
    name: string;
    optional: boolean;
    params: string;
    type: string;
    doc: string;
}
interface Check {
    id: string;
    obligation: string;
    skippedWhen: string[];
}
const { extractInterfaceMembers, extractChecks, renderMembers, renderChecks, applyRegions, tsdocToMarkdown } =
    generator as {
        extractInterfaceMembers: (source: string, name: string) => Member[];
        extractChecks: (source: string, name: string) => Check[];
        renderMembers: (members: Member[]) => string;
        renderChecks: (checks: Check[]) => string;
        applyRegions: (
            doc: string,
            bodies: Map<string, string>,
        ) => { text: string; stale: string[]; problems: string[] };
        tsdocToMarkdown: (text: string) => string;
    };

const CONTRACT = `
/** Not this one: it documents the interface, not a member. */
export interface Store {
    /**
     * Open a resource. See {@link Other.method} and
     * {@link Third | the third one}.
     *
     * Second paragraph.
     */
    open(
        key: string,
        opts?: { signal?: AbortSignal },
    ): Promise<{ token: string }>;

    // A line comment is not documentation.
    /** Optional and one line. */
    sweep?(cutoff: number): Promise<void>;

    /** Required flag. */
    readonly atomic: boolean;
    readonly undocumented?: number;
}
`;

const HARNESS = `
const MODULE_LEVEL = "declared at module scope";
export async function checkStore(): Promise<void> {
    const record = recorder();
    const skip = skipper();
    const LOCAL = "first half " + "second half";
    await record("literal", "a literal obligation", async () => {});
    if (flag) {
        await record("joined", LOCAL, async () => {});
    } else {
        skip("joined", LOCAL, cond ? MODULE_LEVEL : "the other branch");
    }
    const skipBoth = (why: string): void => {
        skip("helper-a", MODULE_LEVEL, why);
    };
    skipBoth("reason one");
    skipBoth(\`reason two\`);
    await record("literal", "a literal obligation", async () => {});
}
export async function otherHarness(): Promise<void> {
    await record("not-mine", "belongs to another function", async () => {});
}
`;

describe("extractInterfaceMembers", () => {
    it("reads each member's signature on one line and its own TSDoc, in order", () => {
        const members = extractInterfaceMembers(CONTRACT, "Store");
        expect(members.map((m) => m.name)).toEqual(["open", "sweep", "atomic", "undocumented"]);
        expect(members[0]).toEqual({
            kind: "method",
            name: "open",
            optional: false,
            params: "key: string, opts?: { signal?: AbortSignal }",
            type: "Promise<{ token: string }>",
            doc: "Open a resource. See `Other.method` and\nthe third one.\n\nSecond paragraph.",
        });
        expect(members[1]).toMatchObject({ kind: "method", optional: true, doc: "Optional and one line." });
        expect(members[2]).toMatchObject({ kind: "property", type: "boolean", optional: false, doc: "Required flag." });
        expect(members[3]).toMatchObject({ kind: "property", optional: true, doc: "" });
    });

    it("throws for an interface the source does not declare", () => {
        expect(() => extractInterfaceMembers(CONTRACT, "Missing")).toThrow(/no interface Missing/);
    });

    it("renders methods with their return type and properties with their type", () => {
        const text = renderMembers(extractInterfaceMembers(CONTRACT, "Store"));
        expect(text).toContain(
            "- **`open(key: string, opts?: { signal?: AbortSignal })`** -> `Promise<{ token: string }>`",
        );
        expect(text).toContain("  Open a resource.");
        expect(text).toContain("- **`sweep?(cutoff: number)`** -> `Promise<void>`");
        expect(text).toContain("- **`atomic`** (`boolean`)\n\n  Required flag.");
        expect(text).toContain("- **`undocumented`** (`number`, optional)");
    });
});

describe("extractChecks", () => {
    it("collects each check once, in first-named order, resolving constants, branches and helper call sites", () => {
        expect(extractChecks(HARNESS, "checkStore")).toEqual([
            { id: "literal", obligation: "a literal obligation", skippedWhen: [] },
            {
                id: "joined",
                obligation: "first half second half",
                skippedWhen: ["declared at module scope", "the other branch"],
            },
            { id: "helper-a", obligation: "declared at module scope", skippedWhen: ["reason one", "reason two"] },
        ]);
    });

    it("refuses an argument it cannot resolve rather than dropping the row", () => {
        const source = `export async function h() { await record("x", computeIt(), async () => {}); }`;
        expect(() => extractChecks(source, "h")).toThrow(/cannot resolve `computeIt\(\)`/);
    });

    it("renders the count and a table, escaping pipes", () => {
        const text = renderChecks([
            { id: "a", obligation: "x | y", skippedWhen: [] },
            { id: "b", obligation: "z", skippedWhen: ["one", "two"] },
        ]);
        expect(text).toContain("The 2 checks, by what they pin:");
        expect(text).toContain("| `a` | x \\| y | never |");
        expect(text).toContain("| `b` | z | one; or two |");
    });
});

describe("applyRegions", () => {
    const doc = "# T\n\n<!-- generated:one -->\nold\n<!-- /generated:one -->\n\nprose\n";

    it("rewrites a stale region and reports it", () => {
        const { text, stale, problems } = applyRegions(doc, new Map([["one", "new"]]));
        expect(text).toBe("# T\n\n<!-- generated:one -->\nnew\n<!-- /generated:one -->\n\nprose\n");
        expect(stale).toEqual(["one"]);
        expect(problems).toEqual([]);
    });

    it("reports nothing stale when the region is current", () => {
        expect(applyRegions(doc, new Map([["one", "old"]])).stale).toEqual([]);
    });

    it("refuses a missing region and a region no renderer owns", () => {
        expect(applyRegions(doc, new Map([["two", "x"]])).problems).toEqual([
            "docs/API.md carries a region no renderer owns: one",
            "docs/API.md has no region two (expected <!-- generated:two --> ... <!-- /generated:two -->)",
        ]);
    });

    it("writes a body containing replacement patterns literally", () => {
        expect(applyRegions(doc, new Map([["one", "cost $& and $1"]])).text).toContain("\ncost $& and $1\n");
    });
});

describe("tsdocToMarkdown", () => {
    it("keeps block tags readable", () => {
        expect(tsdocToMarkdown("Text.\n@default 30\n@throws RangeError on bad input")).toBe(
            "Text.\nDefault: 30.\n*@throws* RangeError on bad input",
        );
    });
});
