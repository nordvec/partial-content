import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error - a repo-tooling .mjs with no declarations; the package ships neither.
import { buildSbom, npmPurl, releaseInstant } from "../../scripts/write-sbom.mjs";
// @ts-expect-error - a repo-tooling .mjs with no declarations; the package ships neither.
import { checkSbom } from "../../scripts/check-tarball.mjs";

interface Manifest {
    name: string;
    version: string;
    license?: string;
    author?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
interface Sbom {
    bomFormat: string;
    specVersion: string;
    serialNumber: string;
    metadata: {
        timestamp?: string;
        tools?: { components?: { name: string }[] };
        authors?: { name: string; email?: string }[];
        component: { name: string; version: string; purl: string; "bom-ref": string; licenses?: unknown };
    };
    components: { name: string; "bom-ref": string; [field: string]: unknown }[];
    dependencies: { ref: string; dependsOn: string[] }[];
}

const build = buildSbom as (pkg: Manifest, changelog: string) => Sbom;
const purl = npmPurl as (name: string, version: string) => string;
const instant = releaseInstant as (version: string, changelog: string) => string | undefined;
const check = checkSbom as (packed: string[], sbomText: string | undefined, pkg: Manifest) => string | null;

const PKG_DIR = join(import.meta.dir, "..", "..");
const realPkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as Manifest;
const realChangelog = readFileSync(join(PKG_DIR, "CHANGELOG.md"), "utf8");

describe("write-sbom", () => {
    it("describes the real manifest: name, version and purl match package.json", () => {
        const sbom = build(realPkg, realChangelog);
        expect(sbom.bomFormat).toBe("CycloneDX");
        expect(sbom.specVersion).toBe("1.6");
        expect(sbom.metadata.component.name).toBe(realPkg.name);
        expect(sbom.metadata.component.version).toBe(realPkg.version);
        expect(sbom.metadata.component.purl).toBe(`pkg:npm/${realPkg.name}@${realPkg.version}`);
        expect(sbom.metadata.component.licenses).toEqual([{ license: { id: "Apache-2.0" } }]);
        const peers = Object.keys(realPkg.peerDependencies ?? {}).toSorted();
        expect(peers.length).toBeGreaterThan(0);
        expect(sbom.components.map((c) => c.name)).toEqual(peers);
        expect(sbom.dependencies).toEqual([
            { ref: sbom.metadata.component.purl, dependsOn: sbom.components.map((c) => c["bom-ref"]) },
        ]);
    });

    it("lists every optional peer SDK as an optional component carrying its declared range", () => {
        const sbom = build(
            {
                name: "x",
                version: "1.0.0",
                peerDependencies: { "@scope/sdk": "^3.4.0", hono: ">=4.0.0", needed: "1" },
                peerDependenciesMeta: { "@scope/sdk": { optional: true }, hono: { optional: true } },
            },
            "",
        );
        expect(sbom.components).toEqual([
            {
                type: "library",
                "bom-ref": "pkg:npm/%40scope/sdk",
                name: "@scope/sdk",
                scope: "optional",
                purl: "pkg:npm/%40scope/sdk",
                properties: [{ name: "npm:peerDependencyRange", value: "^3.4.0" }],
            },
            {
                type: "library",
                "bom-ref": "pkg:npm/hono",
                name: "hono",
                scope: "optional",
                purl: "pkg:npm/hono",
                properties: [{ name: "npm:peerDependencyRange", value: ">=4.0.0" }],
            },
            {
                type: "library",
                "bom-ref": "pkg:npm/needed",
                name: "needed",
                scope: "required",
                purl: "pkg:npm/needed",
                properties: [{ name: "npm:peerDependencyRange", value: "1" }],
            },
        ]);
    });

    it("names the generator and the package author, and derives a stable serial number", () => {
        const sbom = build(realPkg, realChangelog);
        expect(sbom.metadata.tools?.components?.[0]?.name).toBe("write-sbom");
        expect(sbom.metadata.authors).toEqual([{ name: "Nordvec", email: "oss@nordvec.com" }]);
        expect(sbom.serialNumber).toMatch(
            /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(sbom.serialNumber).toBe(build(realPkg, realChangelog).serialNumber);
        expect(build({ ...realPkg, version: "9.9.9" }, "").serialNumber).not.toBe(sbom.serialNumber);
    });

    it("is reproducible: the same inputs give byte-identical output", () => {
        expect(JSON.stringify(build(realPkg, realChangelog))).toBe(JSON.stringify(build(realPkg, realChangelog)));
    });

    it("dates the document by the CHANGELOG release, and leaves a drafted release undated", () => {
        const changelog = "# Changelog\n\n## 5.0.0\n\nDraft.\n\n## 4.0.0 (2026-09-01)\n";
        expect(instant("4.0.0", changelog)).toBe("2026-09-01T00:00:00Z");
        expect(instant("5.0.0", changelog)).toBeUndefined();
        expect(build({ name: "x", version: "5.0.0" }, changelog).metadata.timestamp).toBeUndefined();
        // A version that is a prefix of another heading does not borrow its date.
        expect(instant("4.0", changelog)).toBeUndefined();
    });

    it("gives an impossible calendar date no timestamp instead of a rolled-over one", () => {
        expect(instant("4.0.0", "## 4.0.0 (2026-02-30)\n")).toBeUndefined();
        expect(instant("4.0.0", "## 4.0.0 (2026-04-31)\n")).toBeUndefined();
        expect(instant("4.0.0", "## 4.0.0 (2028-02-29)\n")).toBe("2028-02-29T00:00:00Z");
    });

    it("percent-encodes a scope in the purl", () => {
        expect(purl("@scope/name", "1.2.3")).toBe("pkg:npm/%40scope/name@1.2.3");
        expect(purl("partial-content", "5.0.0")).toBe("pkg:npm/partial-content@5.0.0");
    });

    it("refuses a manifest with runtime dependencies instead of writing a false empty list", () => {
        expect(() => build({ name: "x", version: "1.0.0", dependencies: { y: "^1" } }, "")).toThrow(
            /runtime dependencies/,
        );
    });
});

describe("checkSbom", () => {
    const pkg = { name: "partial-content", version: "5.0.0" };
    const doc = (version: string) => JSON.stringify(build({ ...pkg, version }, ""));

    it("accepts a packed SBOM naming this release", () => {
        expect(check(["dist/index.js", "dist/sbom.cdx.json"], doc("5.0.0"), pkg)).toBeNull();
    });

    it("refuses a tarball without the SBOM", () => {
        expect(check(["dist/index.js"], doc("5.0.0"), pkg)).toMatch(/not in the tarball/);
        expect(check(["dist/sbom.cdx.json"], undefined, pkg)).toMatch(/not in the tarball/);
    });

    it("refuses a stale SBOM from a build before the version bump", () => {
        expect(check(["dist/sbom.cdx.json"], doc("4.0.0"), pkg)).toMatch(
            /names version "4\.0\.0", but package\.json gives "5\.0\.0"/,
        );
    });

    it("refuses a document that is not JSON", () => {
        expect(check(["dist/sbom.cdx.json"], "{", pkg)).toMatch(/not valid JSON/);
    });
});
