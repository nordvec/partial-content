/**
 * S3-compatible read adapter for partial-content.
 *
 * Implements the read-only {@link ObjectStore} interface from the kernel
 * (HeadObject/GetObject) over `@aws-sdk/client-s3`. Covers:
 *   - AWS S3
 *   - Cloudflare R2 (S3-compatible mode)
 *   - Hetzner Object Storage
 *   - MinIO / Backblaze B2 / Wasabi
 *
 * For native R2 bindings (without the AWS SDK), use `partial-content/r2`.
 *
 * @example
 * ```typescript
 * import { S3Client } from "@aws-sdk/client-s3";
 * import { s3Store } from "partial-content/s3";
 *
 * const client = new S3Client({ region: "eu-central-1" });
 * const store = s3Store({ client, bucket: "documents" });
 * ```
 *
 * @packageDocumentation
 */

import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
    ObjectNotFoundError,
    ObjectChangedError,
    StoreUnavailableError,
    classifyStoreRead,
    nodeStreamToWeb,
    guardStreamLength,
    resolveServedRange,
    buildContentDisposition,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectStream,
    type ReadRange,
    type StoreErrorClassifiers,
    isSha256Base64,
    representationCoding,
    type KeyPolicy,
} from "./index.ts";
import {
    BUCKET_KEY_MAX_BYTES,
    failRead,
    rangeHeaderValue,
    readPath,
    retryAfterFrom,
    urlKeyGuard,
} from "./object-store.ts";
import { isNotFoundError, isPreconditionFailedError, s3ErrorIs } from "./s3-errors.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };

// ─── S3 Body -> Web ReadableStream ──────────────────────────────────────────

/**
 * Convert an S3 SDK response Body to a web ReadableStream.
 *
 * The SDK Body is a web ReadableStream in Bun/Deno, a Node Readable in
 * Node.js, and may expose `transformToWebStream()` as a convenience.
 * We try each path in order of preference.
 */
function toWebStream(
    body: unknown,
    signal?: AbortSignal,
    expectedBytes?: number,
): ReadableStream<Uint8Array<ArrayBuffer>> {
    // Every branch enforces the committed length: an S3-compatible backend that
    // ends a body cleanly but short of ContentLength (some do in-flight body
    // retries) must error the stream, not silently under-run the response. The
    // web-stream branches are the ones Node aws-sdk v3 and Bun/Deno actually take,
    // so guarding only the Node-Readable fallback would leave the guard dead.
    if (body instanceof ReadableStream) {
        return guardStreamLength(body, expectedBytes);
    }
    if (typeof (body as { transformToWebStream?: () => ReadableStream }).transformToWebStream === "function") {
        return guardStreamLength(
            (body as { transformToWebStream: () => ReadableStream<Uint8Array> }).transformToWebStream(),
            expectedBytes,
        );
    }
    // Node Readable fallback: the shared utility auto-detects destroy() and
    // applies the same length guard internally.
    return nodeStreamToWeb(body as AsyncIterable<Buffer | Uint8Array>, { signal, expectedBytes });
}

// ─── S3 ObjectStore Options ─────────────────────────────────────────────────

/**
 * The prefix the store refuses to serve by default: where a 5.x upload store
 * kept its bookkeeping.
 */
const S3_DEFAULT_UPLOAD_PREFIX = ".uploads/";

export interface S3StoreOptions {
    /**
     * Key prefixes this store refuses to serve, because they are where a
     * partial-content 5.x upload store sharing this location keeps its
     * in-flight bytes and the sidecars naming their destination keys. Keys at
     * or under one answer {@link ObjectNotFoundError}. Set to `""` when no
     * upload store shares the location.
     * @default ".uploads/"
     */
    reservedPrefix?: string | readonly string[];
    /**
     * Whether a key with an empty segment is refused. The SDK builds the
     * request URL's path from the key, so the default refuses it; `"verbatim"`
     * serves a bucket's real `a//b` object. A `.` or `..` segment is refused
     * under either value: a fetch-based handler resolves it before S3 sees
     * the path, so no object is named by such a key.
     * @default "plain"
     */
    keys?: KeyPolicy;
    /** Pre-configured S3Client instance (BYOC, no config coupling). */
    client: S3Client;
    /** The S3 bucket name. */
    bucket: string;
}

/** `s3Store` needs a client and a bucket; without them the first read fails opaquely, so construction refuses. */
function assertS3Target(factory: string, opts: { client?: unknown; bucket?: unknown } | undefined): void {
    if (opts?.client === null || typeof opts?.client !== "object") {
        throw new TypeError(`${factory}: options.client is required (an S3Client)`);
    }
    if (typeof opts?.bucket !== "string" || opts.bucket === "") {
        throw new TypeError(
            `${factory}: options.bucket is required (a non-empty string), got ${JSON.stringify(opts?.bucket)}`,
        );
    }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} backed by an S3-compatible bucket.
 *
 * @example
 * ```typescript
 * import { S3Client } from "@aws-sdk/client-s3";
 * import { s3Store } from "partial-content/s3";
 *
 * const client = new S3Client({ region: "eu-central-1" });
 * const store = s3Store({ client, bucket: "documents" });
 *
 * // Use with partial-content's evaluateConditionalRequest:
 * const meta = await store.headObject("reports/q4.pdf");
 * ```
 */
export function s3Store(opts: S3StoreOptions): ObjectStore {
    assertS3Target("s3Store", opts);
    const { client, bucket } = opts;
    const assertReadable = urlKeyGuard(opts.reservedPrefix ?? S3_DEFAULT_UPLOAD_PREFIX, {
        keys: opts.keys ?? "plain",
        maxKeyBytes: BUCKET_KEY_MAX_BYTES,
    });

    return {
        supportsRange: true,
        // 206 bounds/total are parsed from S3's actual Content-Range: the
        // orchestrator may skip the validating HEAD for plain range requests.
        authoritativeRange: true,
        // GetObject carries `IfMatch`: S3 answers 412 for a changed object.
        pinsReads: true,

        async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
            assertReadable(key);
            const response = await classifyStoreRead(
                key,
                () =>
                    client.send(
                        // ChecksumMode is required for S3 to return ChecksumSHA256 at all;
                        // without it the digest would silently never be emitted.
                        new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }),
                        { abortSignal: opts?.signal },
                    ),
                s3Classifiers,
            );

            return {
                contentLength: headLength(response),
                etag: response.ETag,
                lastModified: response.LastModified?.toUTCString(),
                digest: toReprDigest(response.ChecksumSHA256),
                contentEncoding: representationCoding(response.ContentEncoding),
            };
        },

        async getObject(
            key: string,
            opts?: { range?: ReadRange; signal?: AbortSignal; ifMatch?: string },
        ): Promise<ObjectStream> {
            assertReadable(key);
            const { range, signal, ifMatch } = opts ?? {};
            // An open range (`bytes=a-`) goes out in its bare open form.
            const rangeHeader = range ? rangeHeaderValue(range) : undefined;

            const response = await classifyStoreRead(
                key,
                () =>
                    client.send(
                        new GetObjectCommand({
                            Bucket: bucket,
                            Key: key,
                            ChecksumMode: "ENABLED",
                            // Pin the read to the validated representation: S3 rejects with
                            // 412 PreconditionFailed if the object changed since HEAD.
                            IfMatch: ifMatch || undefined,
                            Range: rangeHeader,
                        }),
                        { abortSignal: signal },
                    ),
                s3Classifiers,
            );

            if (!response.Body) {
                throw new Error(`S3 GetObject returned empty body`);
            }

            const stream = toWebStream(response.Body, signal, response.ContentLength);

            // A null ContentLength on a GET with a live body is a degenerate response:
            // fabricating `0` would commit `Content-Length: 0` over real bytes (a wire
            // framing error) and silently disable the short-read guard. headObject
            // already fails loudly on this; mirror it -- cancel the body and throw.
            if (response.ContentLength == null) {
                failRead(() => stream.cancel(), new Error(`S3 GetObject returned no ContentLength`));
            }
            const contentLength = response.ContentLength;

            // The stored coding describes the bytes in this body; a corrupt
            // value fails the read and releases the live body.
            let contentEncoding: string | undefined;
            try {
                contentEncoding = representationCoding(response.ContentEncoding);
            } catch (err) {
                failRead(() => stream.cancel(), err);
            }

            // Extract served bounds + total size from Content-Range
            // (e.g. "bytes 0-999/5000") via the shared resolver, or fall back to
            // ContentLength for full responses. A Content-Range S3 emits but the
            // resolver cannot parse means the byte accounting is untrustworthy:
            // cancel the live body and fail loudly rather than guess.
            let totalSize: number | undefined;
            let served: { start: number; end: number } | undefined;
            if (response.ContentRange) {
                const resolved = resolveServedRange(response.ContentRange);
                if (!resolved) {
                    failRead(
                        () => stream.cancel(),
                        new Error(`S3 returned unparseable Content-Range: ${response.ContentRange}`),
                    );
                }
                served = resolved.served;
                totalSize = resolved.totalSize;
            } else {
                totalSize = contentLength;
            }

            return {
                body: stream,
                contentLength,
                totalSize,
                range: served,
                etag: response.ETag,
                lastModified: response.LastModified?.toUTCString(),
                contentEncoding,
                // Repr-Digest MUST hash the full representation. AWS omits the checksum
                // on ranged GETs, but a non-conforming S3-compatible backend could
                // return a range-scoped one; never advertise it as a whole-object
                // digest. HEAD (always whole-object) and full 200s still carry it.
                digest: served ? undefined : toReprDigest(response.ChecksumSHA256),
            };
        },

        async createSignedUrl(key: string, signOpts: S3SignOptions): Promise<S3SignResult> {
            assertReadable(key);
            const { signal } = signOpts;
            signal?.throwIfAborted();
            // Lazy import: the presigner is an optional peer needed ONLY for
            // signed URLs. A static import would crash `partial-content/s3` at
            // module load for every consumer who installed just
            // @aws-sdk/client-s3 (the documented baseline) and never presigns.
            // Its absence is the one "cannot sign here" answer: the caller
            // streams instead. Every failure after it is signing that was
            // supposed to work (a credential provider, the signer) and throws.
            let presigner;
            try {
                presigner = await import("@aws-sdk/s3-request-presigner");
            } catch (cause) {
                return {
                    ok: false,
                    error: "@aws-sdk/s3-request-presigner is not loadable",
                    code: "unsupported",
                    cause,
                };
            }
            // A signed URL is a 302 redirect target: the client fetches bytes
            // DIRECTLY from S3, bypassing the serve route's security headers
            // (nosniff, CSP, CORP). Force a download disposition AND an inert
            // content type so a stored SVG/HTML polyglot cannot render inline off
            // the header-less origin response. Both are S3 query-parameter
            // overrides honored on the presigned GET; the stored object is
            // untouched. `downloadFilename` only customizes the name.
            const command = new GetObjectCommand({
                Bucket: bucket,
                Key: key,
                ResponseContentType: "application/octet-stream",
                ResponseContentDisposition: buildContentDisposition(signOpts.downloadFilename ?? "download", {
                    type: "attachment",
                }),
                // Response-header override, not an object mutation: keeps a private
                // document's caching policy authoritative even when the object was
                // uploaded with a public Cache-Control (the CDN-caches-your-private
                // -file footgun).
                ResponseCacheControl: signOpts.cacheControl || undefined,
            });
            const url = await presigner.getSignedUrl(client, command, { expiresIn: signOpts.expiresInSeconds });
            // A caller that left while the credentials resolved is not handed a URL.
            signal?.throwIfAborted();
            return { ok: true, url };
        },
    };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * What `createSignedUrl` accepts and answers. `signal` is honoured before and
 * after signing; `{ ok: false }` means only "this store cannot sign here" and
 * carries why in `cause`, while a signing failure throws.
 */
interface S3SignOptions {
    expiresInSeconds: number;
    downloadFilename?: string;
    cacheControl?: string;
    signal?: AbortSignal;
}
type S3SignResult = Awaited<ReturnType<NonNullable<ObjectStore["createSignedUrl"]>>>;

/** A HEAD's ContentLength; a response without one carries no byte accounting to trust. */
function headLength(response: { ContentLength?: number }): number {
    if (response.ContentLength == null) throw new Error(`HeadObject returned no ContentLength`);
    return response.ContentLength;
}

/**
 * Validate an S3 checksum for use as an RFC 9530 representation digest.
 *
 * Multipart uploads produce composite checksums ("checksum-of-checksums")
 * in the form `<base64>-<partCount>`, which do NOT hash the object bytes
 * and are invalid inside `Repr-Digest: sha-256=:...:`. Only a plain
 * base64 SHA-256 of the full object passes through.
 */
function toReprDigest(checksum: string | undefined): string | undefined {
    return isSha256Base64(checksum) ? checksum : undefined;
}

/**
 * Check if an S3 error is a transient throttle/overload the client should
 * retry (mapped to a 503, not a 502). The AWS SDK exhausts its own adaptive
 * retries first, so reaching here means sustained pressure.
 *
 * Covers:
 *   - `$retryable.throttling` (the SDK's own throttle classification)
 *   - HTTP 503 (`SlowDown`) and 429 (`TooManyRequests`) on `$metadata`
 *   - the named throttle errors S3-compatible backends raise without setting
 *     an HTTP status code
 */
function isThrottledError(err: unknown): boolean | { retryAfterSeconds: number } {
    const status = readPath(err, "$metadata", "httpStatusCode");
    const throttled =
        readPath(err, "$retryable", "throttling") === true ||
        status === 503 ||
        status === 429 ||
        s3ErrorIs(
            err,
            // Matched by name alone: the statuses are tested above.
            Number.NaN,
            "SlowDown",
            "ThrottlingException",
            "TooManyRequestsException",
            "RequestThrottled",
            "RequestThrottledException",
            "ProvisionedThroughputExceededException",
        );
    if (!throttled) return false;
    // Surface the backend's advised back-off when the SDK kept the raw
    // response: the resulting 503 echoes it as Retry-After so clients and
    // shared caches wait the advised interval instead of hammering an origin
    // that is already shedding load.
    const hint = retryAfterFrom(readPath(err, "$response", "headers"));
    return hint !== undefined ? { retryAfterSeconds: hint } : true;
}

/** The ordered error-classification set shared by headObject and getObject. */
const s3Classifiers: StoreErrorClassifiers = {
    notFound: isNotFoundError,
    changed: isPreconditionFailedError,
    throttled: isThrottledError,
};
