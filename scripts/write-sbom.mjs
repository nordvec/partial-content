/**
 * Write the package's CycloneDX 1.6 SBOM to `dist/sbom.cdx.json`, which the
 * `dist` entry in `files` ships in the tarball.
 *
 * The package has no runtime dependencies, so the document describes the one
 * component it ships (name, version, purl, license, supplier and references)
 * plus its peer dependencies, the optional SDKs its adapters import. Every
 * field comes from `package.json`, the serial number is a hash of name and
 * version, and the one date in it is the
 * release date the CHANGELOG gives the manifest's version, so two builds of the
 * same release write byte-identical documents. An undated (drafted) release
 * gets no timestamp rather than the build machine's clock.
 *
 * Usage: `node scripts/write-sbom.mjs` (chained after `tsc` in `build`).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseInstantOf } from "./release-date.mjs";

/** Where the build writes the document, relative to the package root. */
export const SBOM_PATH = "dist/sbom.cdx.json";

/**
 * The package URL (purl spec, `npm` type): a scope's `@` is percent-encoded.
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
export function npmPurl(name, version) {
    return `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
}

/**
 * The release date the CHANGELOG gives `version`, as an ISO instant at UTC
 * midnight, or undefined when its heading carries no date.
 * @param {string} version
 * @param {string} changelog
 * @returns {string | undefined}
 */
export function releaseInstant(version, changelog) {
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`^#{1,6}\\s+${escaped}\\s+\\((\\d{4}-\\d{2}-\\d{2})\\)\\s*$`, "m").exec(changelog);
    return m ? releaseInstantOf(m[1]) : undefined;
}

/**
 * A name-based UUID (version 5 layout) over `name@version`, so the serial
 * number of a release is the same on every build and differs between releases.
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
export function serialNumberOf(name, version) {
    const bytes = createHash("sha256").update(`${name}@${version}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The SBOM for a manifest, as a plain object.
 *
 * Peer dependencies are the SDKs the optional adapters import. Each is a
 * component and a dependency edge of the package; the one the manifest marks
 * optional carries `scope: "optional"`. A peer has no resolved version, so the
 * component names no `version` and the declared range travels as a property.
 * @param {{ name: string, version: string, description?: string, license?: string, author?: string,
 *   homepage?: string, bugs?: string | { url?: string }, repository?: string | { url?: string },
 *   dependencies?: Record<string, string>, peerDependencies?: Record<string, string>,
 *   peerDependenciesMeta?: Record<string, { optional?: boolean }> }} pkg
 * @param {string} changelog
 */
export function buildSbom(pkg, changelog) {
    // A runtime dependency would have to appear as a component and an edge; this
    // generator emits neither, so it refuses rather than writing a false "none".
    const runtime = Object.keys(pkg.dependencies ?? {});
    if (runtime.length > 0) {
        throw new Error(
            `write-sbom: package.json declares runtime dependencies (${runtime.join(", ")}); list them as components`,
        );
    }
    const purl = npmPurl(pkg.name, pkg.version);
    const supplier = pkg.author ? /^([^<(]+?)\s*(?:<([^>]+)>)?\s*(?:\(.*\))?$/.exec(pkg.author) : null;
    const urlOf = (field) => (typeof field === "string" ? field : field?.url);
    const references = [
        ["website", pkg.homepage],
        ["vcs", urlOf(pkg.repository)?.replace(/^git\+/, "")],
        ["issue-tracker", urlOf(pkg.bugs)],
    ]
        .filter(([, url]) => url)
        .map(([type, url]) => ({ type, url }));
    const timestamp = releaseInstant(pkg.version, changelog);
    const peers = Object.entries(pkg.peerDependencies ?? {})
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, range]) => {
            const peerPurl = `pkg:npm/${name.replace(/^@/, "%40")}`;
            return {
                type: "library",
                "bom-ref": peerPurl,
                name,
                scope: pkg.peerDependenciesMeta?.[name]?.optional ? "optional" : "required",
                purl: peerPurl,
                properties: [{ name: "npm:peerDependencyRange", value: range }],
            };
        });
    return {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        serialNumber: serialNumberOf(pkg.name, pkg.version),
        version: 1,
        metadata: {
            ...(timestamp ? { timestamp } : {}),
            tools: { components: [{ type: "application", name: "write-sbom", version: pkg.version }] },
            ...(supplier ? { authors: [{ name: supplier[1], ...(supplier[2] ? { email: supplier[2] } : {}) }] } : {}),
            component: {
                type: "library",
                "bom-ref": purl,
                name: pkg.name,
                version: pkg.version,
                ...(pkg.description ? { description: pkg.description } : {}),
                ...(supplier
                    ? { supplier: { name: supplier[1], ...(supplier[2] ? { contact: [{ email: supplier[2] }] } : {}) } }
                    : {}),
                ...(pkg.license ? { licenses: [{ license: { id: pkg.license } }] } : {}),
                purl,
                ...(references.length > 0 ? { externalReferences: references } : {}),
            },
        },
        components: peers,
        dependencies: [{ ref: purl, dependsOn: peers.map((c) => c["bom-ref"]) }],
    };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const sbom = buildSbom(pkg, readFileSync(path.join(pkgDir, "CHANGELOG.md"), "utf8"));
    writeFileSync(path.join(pkgDir, SBOM_PATH), `${JSON.stringify(sbom, null, 2)}\n`);
    console.log(`write-sbom: ${SBOM_PATH} describes ${sbom.metadata.component.purl}`);
}
