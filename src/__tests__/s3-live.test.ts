import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
    S3Client,
    CreateBucketCommand,
    PutObjectCommand,
    DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { s3Store } from "../s3";
import { serveObject } from "../web";
import { ObjectChangedError } from "../object-store";

/**
 * LIVE integration tests against a real S3-compatible endpoint.
 *
 * Opt-in via environment (skipped otherwise, so the default suite never
 * needs credentials or network):
 *
 *   PC_LIVE_S3_ENDPOINT    e.g. http://127.0.0.1:19000 (MinIO) or a Hetzner
 *                          Object Storage endpoint
 *   PC_LIVE_S3_ACCESS_KEY
 *   PC_LIVE_S3_SECRET_KEY
 *   PC_LIVE_S3_BUCKET      default "partial-content-live"
 *   PC_LIVE_S3_REGION      default "us-east-1"
 *
 * Local run (real S3 wire protocol, no cloud account; MinIO requires a
 * user of 3+ chars and a password of 8+):
 *   docker run -d -p 19000:9000 -e MINIO_ROOT_USER=pcx \
 *     -e MINIO_ROOT_PASSWORD=yyyyyyyy quay.io/minio/minio server /data
 *   PC_LIVE_S3_ENDPOINT=http://127.0.0.1:19000 PC_LIVE_S3_ACCESS_KEY=pcx \
 *     PC_LIVE_S3_SECRET_KEY=yyyyyyyy bun test src/__tests__/s3-live.test.ts
 */
const ENDPOINT = process.env.PC_LIVE_S3_ENDPOINT;
const ACCESS_KEY = process.env.PC_LIVE_S3_ACCESS_KEY;
const SECRET_KEY = process.env.PC_LIVE_S3_SECRET_KEY;
const BUCKET = process.env.PC_LIVE_S3_BUCKET ?? "partial-content-live";
const REGION = process.env.PC_LIVE_S3_REGION ?? "us-east-1";

const configured = Boolean(ENDPOINT && ACCESS_KEY && SECRET_KEY);

const CONTENT = new TextEncoder().encode("0123456789abcdefghijklmnopqrstuvwxyz"); // 36 bytes
const KEY = "live/doc-v1.bin";

describe.skipIf(!configured)("s3Store: LIVE S3-compatible endpoint", () => {
    let client: S3Client;
    let store: ReturnType<typeof s3Store>;

    beforeAll(async () => {
        client = new S3Client({
            endpoint: ENDPOINT,
            region: REGION,
            credentials: { accessKeyId: ACCESS_KEY!, secretAccessKey: SECRET_KEY! },
            forcePathStyle: true, // MinIO and most S3-compatibles require it
        });
        try {
            await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
        } catch (err) {
            // BucketAlreadyOwnedByYou / BucketAlreadyExists are fine
            const name = (err as Error).name;
            if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
        }
        await client.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: KEY,
            Body: CONTENT,
            ContentType: "application/octet-stream",
            ChecksumAlgorithm: "SHA256",
        }));
        store = s3Store({ client, bucket: BUCKET });
    });

    afterAll(async () => {
        await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY })).catch(() => {});
        client.destroy();
    });

    async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks);
    }

    test("headObject returns real size, etag, and SHA-256 digest", async () => {
        const meta = await store.headObject(KEY);

        expect(meta.contentLength).toBe(36);
        expect(meta.etag).toMatch(/^"[0-9a-f]+"$/);
        // Uploaded with ChecksumAlgorithm SHA256: the digest must round-trip.
        expect(meta.digest).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    });

    test("getObject full: exact bytes and matching validators", async () => {
        const result = await store.getObject(KEY);

        expect(await drain(result.body)).toEqual(Buffer.from(CONTENT));
        expect(result.totalSize).toBe(36);
        expect(result.contentLength).toBe(36);
        expect(result.range).toBeUndefined();
    });

    test("getObject range: real backend Content-Range parsed into structured bounds", async () => {
        const result = await store.getObject(KEY, { range: { start: 10, end: 19 } });

        expect(new TextDecoder().decode(await drain(result.body))).toBe("abcdefghij");
        expect(result.range).toEqual({ start: 10, end: 19 });
        expect(result.totalSize).toBe(36);
        expect(result.contentLength).toBe(10);
    });

    test("pinned read: real If-Match honors the current etag and rejects a stale one", async () => {
        const meta = await store.headObject(KEY);
        const pinned = await store.getObject(KEY, { range: { start: 0, end: 4 }, ifMatch: meta.etag });
        expect(new TextDecoder().decode(await drain(pinned.body))).toBe("01234");

        await expect(
            store.getObject(KEY, { ifMatch: '"0123456789abcdef0123456789abcdef"' }),
        ).rejects.toBeInstanceOf(ObjectChangedError);
    });

    test("serveObject end-to-end: 206 and 304 against the live backend", async () => {
        const handler = serveObject(store, { cacheControl: "private, no-cache" });

        const partial = await handler(
            new Request("http://x/f", { headers: { Range: "bytes=30-35" } }),
            { key: KEY },
        );
        expect(partial.status).toBe(206);
        expect(partial.headers.get("Content-Range")).toBe("bytes 30-35/36");
        expect(await partial.text()).toBe("uvwxyz");

        const etag = partial.headers.get("ETag")!;
        const revalidated = await handler(
            new Request("http://x/f", { headers: { "If-None-Match": etag } }),
            { key: KEY },
        );
        expect(revalidated.status).toBe(304);
    });

    test("createSignedUrl: presigned GET is fetchable without credentials", async () => {
        const result = await store.createSignedUrl!(KEY, { expiresInSeconds: 60 });
        if (!("url" in result && result.ok)) throw new Error(`presign failed: ${JSON.stringify(result)}`);

        const res = await fetch(result.url);
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(CONTENT);
    });

    test("overwrite invalidates the old pin (real TOCTOU semantics)", async () => {
        const before = await store.headObject(KEY);

        await client.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: KEY,
            Body: new TextEncoder().encode("REPLACED-CONTENT-DIFFERENT-LENGTH!"),
        }));

        await expect(
            store.getObject(KEY, { ifMatch: before.etag }),
        ).rejects.toBeInstanceOf(ObjectChangedError);

        // Restore for other tests / reruns.
        await client.send(new PutObjectCommand({
            Bucket: BUCKET, Key: KEY, Body: CONTENT, ChecksumAlgorithm: "SHA256",
        }));
    });
});
