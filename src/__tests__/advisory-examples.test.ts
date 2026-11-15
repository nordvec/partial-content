import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { azureStore } from "../azure";
import { httpStore } from "../http";
import { ObjectNotFoundError, type ObjectStore } from "../index";

/**
 * Every example key a 6.0.0 Security bullet quotes is refused by the store the
 * bullet names, built with its default options. An advisory example is a claim
 * readers act on, so it is executed here rather than trusted as prose: a key
 * the store would serve, or a store that never reserved the prefix the example
 * names, fails. A new example key is a new row below; one the table does not
 * name fails the coverage test.
 */
const REACHED = "the backend was reached";
const reached = (): never => {
    throw new Error(REACHED);
};

const STORES: Record<string, () => ObjectStore> = {
    azureStore: () => azureStore({ containerClient: { getBlobClient: reached } }),
    httpStore: () => httpStore({ url: () => reached() }),
};

/**
 * `resolved` is the key the example reaches once its dot segments resolve,
 * where the bullet claims it lands in a reserved namespace: the store must
 * refuse that spelling too, so an example naming a prefix the store never
 * reserved fails even though its dot segment alone is refused.
 */
const EXAMPLES: Record<string, { store: keyof typeof STORES; resolved?: string }> = {
    "../private/secret.pdf": { store: "azureStore" },
    "photos/../.partial-content-uploads/x": { store: "azureStore", resolved: ".partial-content-uploads/x" },
    ".UPLOADS/x": { store: "httpStore" },
    "a//../.uploads/x": { store: "httpStore", resolved: ".uploads/x" },
};

const pkgDir = join(import.meta.dir, "..", "..");
const planPath = join(pkgDir, "..", "..", "docs", "plans", "partial-content-5-0-release.md");
const changelogPath = join(pkgDir, "CHANGELOG.md");

/** The 6.0.0 Security bullets: from the CHANGELOG once released, from the plan's draft before. */
function securityBullets(): string[] {
    const changelog = readFileSync(changelogPath, "utf8");
    const released = /^## 6\.0\.0[^\n]*\n([\s\S]*?)(?=^## )/m.exec(changelog)?.[1];
    const entry =
        released ??
        (existsSync(planPath) ? /^### 6\.0\.0\n([\s\S]*?)(?=^## )/m.exec(readFileSync(planPath, "utf8"))?.[1] : "");
    const security = /^#{3,4} Security\n([\s\S]*?)(?=^#{3,4} )/m.exec(entry ?? "")?.[1] ?? "";
    return security.split("\n").filter((line) => line.startsWith("- **GHSA-"));
}

/** Backticked spans in a bullet that are keys: a `/`, no space. */
function exampleKeys(bullet: string): string[] {
    return [...bullet.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).filter((s) => s.includes("/") && !/\s/.test(s));
}

const bullets = securityBullets();

describe.skipIf(bullets.length === 0)("6.0.0 advisory examples", () => {
    test("every example key a Security bullet quotes is in the table", () => {
        const quoted = bullets.flatMap(exampleKeys);
        expect(quoted.length).toBeGreaterThan(0);
        expect(quoted.filter((key) => !(key in EXAMPLES))).toEqual([]);
    });

    for (const [key, { store: name, resolved }] of Object.entries(EXAMPLES)) {
        test(`${name} refuses ${key} with its default options, without asking the backend`, async () => {
            expect(bullets.some((b) => b.includes(name) && exampleKeys(b).includes(key))).toBe(true);
            const store = STORES[name]!();
            await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            if (resolved !== undefined) {
                await expect(store.headObject(resolved)).rejects.toBeInstanceOf(ObjectNotFoundError);
            }
        });
    }
});
