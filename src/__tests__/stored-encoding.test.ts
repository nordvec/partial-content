import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { S3Client } from "@aws-sdk/client-s3";
import { azureStore, type AzureStoreOptions } from "../azure";
import { gcsStore, type GcsStoreOptions } from "../gcs";
import { memoryStore } from "../memory";
import { r2Store, type R2Bucket } from "../r2";
import { s3Store } from "../s3";
import { representationCoding } from "../index";
import { serveObject } from "../web";

/**
 * An object stored already encoded is served as that representation: its
 * stored coding is `Content-Encoding`, and length, ETag, digest and ranges all
 * describe the encoded bytes (RFC 9110 Section 14.2). Serving the encoded
 * bytes as identity would hand the client undecodable data under validators
 * that vouch for it.
 */
const PLAIN = Buffer.from(JSON.stringify({ hello: "world" }).repeat(40));
const GZ = gzipSync(PLAIN);
const ETAG = '"enc-1"';

const get = (handler: ReturnType<typeof serveObject>, headers: Record<string, string> = {}, method = "GET") =>
    handler({ method, headers: new Headers(headers) }, { key: "d.json", mime: "application/json" });

const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe("representationCoding", () => {
    test("normalizes a stored value and drops identity", () => {
        expect(representationCoding(" GZip ")).toBe("gzip");
        expect(representationCoding("gzip, br")).toBe("gzip, br");
        for (const none of [undefined, null, "", "  ", "identity", "Identity"]) {
            expect(representationCoding(none)).toBeUndefined();
        }
    });

    test("serves registered codings, with x-gzip spelled gzip", () => {
        for (const coding of ["gzip", "deflate", "br", "zstd", "compress"]) {
            expect(representationCoding(coding)).toBe(coding);
        }
        expect(representationCoding("X-GZip")).toBe("gzip");
        expect(representationCoding("gzip, x-gzip")).toBe("gzip, gzip");
    });

    test("passes a registered coding the store cannot decode through under its own name", () => {
        for (const coding of ["aes128gcm", "dcb", "dcz", "exi", "pack200-gzip"]) {
            expect(representationCoding(coding)).toBe(coding);
        }
        expect(representationCoding("Pack200-GZip")).toBe("pack200-gzip");
    });

    test("reads the MIME transfer-encoding names and none as identity", () => {
        for (const stored of ["base64", "Binary", "7bit", "8BIT", "quoted-printable", "none", "None"]) {
            expect(representationCoding(stored)).toBeUndefined();
        }
        expect(representationCoding("base64, gzip")).toBe("gzip");
    });

    test("treats transfer markers and values that are not codings as identity", () => {
        const identity = [
            "aws-chunked",
            "AWS-Chunked",
            "UTF-8",
            "utf8",
            "iso-8859-1",
            "us-ascii",
            "windows-1252",
            "text/plain; charset=utf-8",
            "charset=utf-8",
            "a b",
            "g;q=1",
            "gz\r\nSet-Cookie: x=1",
            ",",
        ];
        for (const stored of identity) {
            expect(representationCoding(stored)).toBeUndefined();
        }
    });

    test("drops identity members of a list and keeps the codings", () => {
        expect(representationCoding("aws-chunked,gzip")).toBe("gzip");
        expect(representationCoding("gzip, identity")).toBe("gzip");
    });

    test("refuses an unregistered token it cannot tell from a coding", () => {
        for (const unknown of ["foo", "gzip, foo", "g!z", "x-custom"]) {
            expect(() => representationCoding(unknown)).toThrow(TypeError);
        }
    });
});

describe("serveObject over a store holding encoded bytes", () => {
    const store = () => memoryStore({ objects: { "d.json": { body: GZ, etag: ETAG, contentEncoding: "gzip" } } });

    test("a full read carries the stored coding and the encoded bytes", async () => {
        const res = await get(serveObject(store()));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBe("gzip");
        expect(res.headers.get("content-length")).toBe(String(GZ.length));
        expect((await bytesOf(res)).equals(GZ)).toBe(true);
    });

    test("a stored charset or transfer marker is served as identity, not as a coding", async () => {
        for (const contentEncoding of ["UTF-8", "aws-chunked", "text/plain; charset=utf-8"]) {
            const handler = serveObject(
                memoryStore({ objects: { "d.json": { body: PLAIN, etag: ETAG, contentEncoding } } }),
            );
            const res = await get(handler);
            expect(res.status).toBe(200);
            expect(res.headers.get("content-encoding")).toBeNull();
            expect((await bytesOf(res)).equals(PLAIN)).toBe(true);
        }
    });

    test("HEAD reports the coding and the encoded length", async () => {
        const res = await get(serveObject(store()), {}, "HEAD");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBe("gzip");
        expect(res.headers.get("content-length")).toBe(String(GZ.length));
    });

    test("a range selects encoded bytes and keeps the coding", async () => {
        const res = await get(serveObject(store()), { range: "bytes=2-9" });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-encoding")).toBe("gzip");
        expect(res.headers.get("content-range")).toBe(`bytes 2-9/${GZ.length}`);
        expect((await bytesOf(res)).equals(GZ.subarray(2, 10))).toBe(true);
    });

    test("a range behind a validating HEAD keeps the coding", async () => {
        const res = await get(serveObject(store()), { range: "bytes=0-4", "if-match": ETAG });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-encoding")).toBe("gzip");
        expect((await bytesOf(res)).equals(GZ.subarray(0, 5))).toBe(true);
    });

    test("a multi-range request is served whole, never as multipart over encoded bytes", async () => {
        const res = await get(serveObject(store()), { range: "bytes=0-3,8-11" });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).not.toContain("multipart");
        expect(res.headers.get("content-encoding")).toBe("gzip");
        expect((await bytesOf(res)).equals(GZ)).toBe(true);
    });

    test("an identity object carries no Content-Encoding", async () => {
        const plain = memoryStore({ objects: { "d.json": { body: PLAIN, contentEncoding: "identity" } } });
        const res = await get(serveObject(plain));
        expect(res.headers.get("content-encoding")).toBeNull();
    });

    test("an unregistered stored coding is a 502, never a guessed header", async () => {
        const bad = memoryStore({ objects: { "d.json": { body: GZ, contentEncoding: "gzzz" } } });
        const res = await get(serveObject(bad));
        expect(res.status).toBe(502);
    });
});

describe("encodeBody", () => {
    const RealResponse = globalThis.Response;
    const seen: unknown[] = [];

    function recordInit() {
        seen.length = 0;
        globalThis.Response = class extends RealResponse {
            constructor(body?: ConstructorParameters<typeof Response>[0], init?: ResponseInit) {
                super(body, init);
                seen.push(init);
            }
        } as typeof Response;
    }

    test("a response with a content coding asks the runtime not to encode it again", async () => {
        const store = memoryStore({ objects: { "d.json": { body: GZ, contentEncoding: "gzip" } } });
        recordInit();
        try {
            await get(serveObject(store));
        } finally {
            globalThis.Response = RealResponse;
        }
        expect((seen.at(-1) as { encodeBody?: string }).encodeBody).toBe("manual");
    });

    test("a precompressed variant asks for it too", async () => {
        const store = memoryStore({
            objects: { "d.json": { body: PLAIN }, "d.json.br": { body: Buffer.from("brotli-bytes") } },
        });
        recordInit();
        try {
            await get(serveObject(store, { precompressed: ["br"] }), { "accept-encoding": "br" });
        } finally {
            globalThis.Response = RealResponse;
        }
        expect((seen.at(-1) as { encodeBody?: string }).encodeBody).toBe("manual");
    });

    test("an identity response leaves the member out", async () => {
        const store = memoryStore({ objects: { "d.json": { body: PLAIN } } });
        recordInit();
        try {
            await get(serveObject(store));
        } finally {
            globalThis.Response = RealResponse;
        }
        expect((seen.at(-1) as { encodeBody?: string }).encodeBody).toBeUndefined();
    });
});

describe("s3Store against an origin holding gzip bytes", () => {
    let server: Server;
    let client: S3Client;
    beforeAll(async () => {
        server = createServer((req, res) => {
            const range = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range ?? "");
            const start = range ? Number(range[1]) : 0;
            const end = range ? Math.min(Number(range[2] ?? GZ.length - 1), GZ.length - 1) : GZ.length - 1;
            const slice = GZ.subarray(start, end + 1);
            res.writeHead(range ? 206 : 200, {
                "Content-Type": "application/json",
                "Content-Encoding": "gzip",
                ETag: ETAG,
                "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT",
                "Content-Length": String(slice.length),
                ...(range ? { "Content-Range": `bytes ${start}-${end}/${GZ.length}` } : {}),
            });
            res.end(req.method === "HEAD" ? undefined : slice);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        client = new S3Client({
            region: "us-east-1",
            endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            forcePathStyle: true,
            credentials: { accessKeyId: "x", secretAccessKey: "y" },
        });
    });
    afterAll(() => {
        client.destroy();
        server.close();
    });

    test("serves the gzip bytes labelled as gzip", async () => {
        const res = await get(serveObject(s3Store({ client, bucket: "b" })));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBe("gzip");
        expect((await bytesOf(res)).equals(GZ)).toBe(true);
    });

    test("serves a range of the gzip bytes labelled as gzip", async () => {
        const res = await get(serveObject(s3Store({ client, bucket: "b" })), { range: "bytes=0-9" });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-encoding")).toBe("gzip");
        expect((await bytesOf(res)).equals(GZ.subarray(0, 10))).toBe(true);
    });
});

describe("gcsStore", () => {
    const calls: { decompress?: boolean }[] = [];
    const storage: GcsStoreOptions["storage"] = {
        bucket: () => ({
            file: () => ({
                getMetadata: async () => [{ size: String(GZ.length), etag: "e", contentEncoding: "gzip" }],
                createReadStream: (o) => {
                    calls.push({ decompress: o?.decompress });
                    return (async function* () {
                        yield GZ;
                    })() as never;
                },
                getSignedUrl: async () => ["https://x"],
            }),
        }),
    };

    test("reads the stored bytes undecoded and reports their coding", async () => {
        const store = gcsStore({ storage, bucket: "b" });
        expect((await store.headObject("d.json")).contentEncoding).toBe("gzip");
        const stream = await store.getObject("d.json");
        expect(stream.contentEncoding).toBe("gzip");
        expect(calls.at(-1)?.decompress).toBe(false);
        await stream.body;
    });
});

describe("azureStore", () => {
    test("reports the stored coding on head and get", async () => {
        const containerClient: AzureStoreOptions["containerClient"] = {
            getBlobClient: () =>
                ({
                    getProperties: async () => ({ contentLength: GZ.length, etag: "e", contentEncoding: "br" }),
                    download: async () => ({
                        readableStreamBody: (async function* () {
                            yield GZ;
                        })(),
                        contentLength: GZ.length,
                        etag: "e",
                        contentEncoding: "br",
                    }),
                }) as never,
        };
        const store = azureStore({ containerClient });
        expect((await store.headObject("d.json")).contentEncoding).toBe("br");
        expect((await store.getObject("d.json")).contentEncoding).toBe("br");
    });
});

describe("r2Store", () => {
    test("reports the stored coding on head and get", async () => {
        const obj = {
            key: "d.json",
            size: GZ.length,
            etag: "e",
            uploaded: new Date(0),
            checksums: {},
            httpMetadata: { contentEncoding: "gzip" },
        };
        const bucket: R2Bucket = {
            head: async () => obj,
            get: async () => ({ ...obj, body: new Response(GZ).body! }),
        };
        const store = r2Store({ bucket });
        expect((await store.headObject("d.json")).contentEncoding).toBe("gzip");
        const stream = await store.getObject("d.json");
        expect(stream.contentEncoding).toBe("gzip");
        await new Response(stream.body as ReadableStream).arrayBuffer();
    });
});
