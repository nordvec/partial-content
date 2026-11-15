import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { azureStore } from "../azure";
import { fsStore } from "../fs";
import { gcsStore } from "../gcs";
import { r2Store } from "../r2";
import { s3Store } from "../s3";
import { httpStore } from "../http";
import { ObjectNotFoundError, type ObjectStore } from "../index";
import { removeTree } from "./temp-cleanup.ts";

/**
 * Each read adapter's default `reservedPrefix` is the one 5.0.0 published, so a 5.x upload store sharing the
 * location keeps its bookkeeping unreadable after an upgrade: `.uploads/` for S3 and the filesystem,
 * `.partial-content-uploads/` for R2, GCS and Azure, both for an HTTP origin (which does not say which upload
 * store it fronts). A key under a default prefix is refused before the backend is asked; any other key reaches it.
 */
/** The name survives every adapter: `httpStore` replaces the message of a failure it did not author. */
const REACHED = "BackendReached";
const reached = (): never => {
    throw Object.assign(new Error("the backend was reached"), { name: REACHED });
};

const UPLOADS = [".uploads/token", ".uploads/token.json", ".uploads"];
const EARLIER = [".partial-content-uploads/token.info", ".partial-content-uploads"];

const stores: [name: string, build: () => ObjectStore, refused: string[], served: string[]][] = [
    ["r2Store", () => r2Store({ bucket: { head: reached, get: reached } }), EARLIER, [".uploads/anything"]],
    [
        "gcsStore",
        () => gcsStore({ storage: { bucket: () => ({ file: reached }) }, bucket: "b" }),
        EARLIER,
        [".uploads/anything"],
    ],
    ["azureStore", () => azureStore({ containerClient: { getBlobClient: reached } }), EARLIER, [".uploads/anything"]],
    [
        "s3Store",
        () => s3Store({ client: { send: reached } as unknown as S3Client, bucket: "b" }),
        UPLOADS,
        [".partial-content-uploads/token.info"],
    ],
    ["httpStore", () => httpStore({ url: () => reached() }), [...UPLOADS, ...EARLIER], ["public/file.txt"]],
];

describe("each read adapter's default reserved prefix is the 5.0.0 one", () => {
    for (const [name, build, refused, served] of stores) {
        for (const key of refused) {
            test(`${name} answers ${key} as not found, without asking the backend`, async () => {
                const store = build();
                await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
                await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            });
        }
        for (const key of served) {
            test(`${name} asks the backend for ${key}`, async () => {
                const store = build();
                await expect(store.headObject(key)).rejects.toHaveProperty("name", REACHED);
                await expect(store.getObject(key)).rejects.toHaveProperty("name", REACHED);
            });
        }
    }

    test("httpStore refuses every spelling the origin resolves into a default prefix", async () => {
        const store = httpStore({ url: () => reached() });
        for (const key of [
            "%2Euploads/x",
            "a/../.uploads/x",
            "%2Epartial-content-uploads/x",
            ".UPLOADS/x",
            "%2EUPLOADS/x",
            ".Partial-Content-Uploads/a",
        ]) {
            await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
    });
});

describe("fsStore's default reserved prefix is the 5.0.0 one", () => {
    let root: string;
    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "pc-reserved-"));
        await mkdir(join(root, ".uploads"));
        await writeFile(join(root, ".uploads", "token.json"), "{}");
        await mkdir(join(root, ".partial-content-uploads"));
        await writeFile(join(root, ".partial-content-uploads", "token.info"), "{}");
    });
    afterAll(async () => {
        await removeTree(root);
    });

    test("refuses .uploads/", async () => {
        const store = fsStore({ root });
        await expect(store.headObject(".uploads/token.json")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("serves a real file whose name merely contains percent escapes", async () => {
        await writeFile(join(root, "%2e%2e.txt"), "abc");
        const store = fsStore({ root });
        expect((await store.headObject("%2e%2e.txt")).contentLength).toBe(3);
    });

    test("refuses the long-s spelling of .uploads/", async () => {
        const store = fsStore({ root });
        await expect(store.headObject(".uploadſ/token.json")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("httpStore refuses the long-s and dotless-i spellings before the origin is asked", async () => {
        const store = httpStore({ url: reached });
        await expect(store.headObject(".uploadſ/token")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject(".partıal-content-uploads/token")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("serves .partial-content-uploads/", async () => {
        const store = fsStore({ root });
        expect((await store.headObject(".partial-content-uploads/token.info")).contentLength).toBe(2);
    });

    test("a reservedPrefix list refuses each prefix and serves the rest", async () => {
        const store = fsStore({ root, reservedPrefix: [".uploads/", ".partial-content-uploads/"] });
        await expect(store.headObject(".uploads/token.json")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.headObject(".partial-content-uploads/token.info")).rejects.toBeInstanceOf(
            ObjectNotFoundError,
        );
        expect((await store.headObject("%2e%2e.txt")).contentLength).toBe(3);
    });
});

describe("s3Store takes a reservedPrefix list", () => {
    test("refuses a key under each prefix without asking the backend, and asks for any other", async () => {
        const store = s3Store({
            client: { send: reached } as unknown as S3Client,
            bucket: "b",
            reservedPrefix: ["private/", "tmp/"],
        });
        await expect(store.headObject("private/x")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject("tmp/x")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.headObject(".uploads/x")).rejects.toHaveProperty("name", REACHED);
    });
});
