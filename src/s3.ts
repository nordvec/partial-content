/**
 * S3-compatible storage adapters for partial-content.
 *
 * Implements the read-only {@link ObjectStore} interface from the kernel
 * (HeadObject/GetObject) and the resumable-write {@link ResumableWriteStore}
 * contract (multipart uploads) over `@aws-sdk/client-s3`. Covers:
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
 * import { s3Store, s3UploadStore } from "partial-content/s3";
 *
 * const client = new S3Client({ region: "eu-central-1" });
 * const store = s3Store({ client, bucket: "documents" });
 * const uploads = s3UploadStore({ client, bucket: "documents" });
 * ```
 *
 * @packageDocumentation
 */

import {
    S3Client,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    ListPartsCommand,
    ListMultipartUploadsCommand,
    NoSuchKey,
    NotFound,
    NoSuchUpload,
    type CompletedPart,
    type ListMultipartUploadsCommandOutput,
    type ListObjectsV2CommandOutput,
    type MultipartUpload,
    type _Object,
} from "@aws-sdk/client-s3";
import {
    ObjectNotFoundError,
    ObjectChangedError,
    StoreUnavailableError,
    classifyStoreRead,
    nodeStreamToWeb,
    guardStreamLength,
    resolveServedRange,
    parseRetryAfterSeconds,
    buildContentDisposition,
    isOpenEndedRange,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectStream,
    type ParsedRange,
    type StoreErrorClassifiers,
    isSha256Base64,
    reservedKeyGuard,
    redactErrorText,
} from "./index.ts";
import {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
    UploadDestinationConflictError,
    isUploadOffsetConflictError,
    type ResumableWriteStore,
    type SweepingWriteStore,
    type PrefixedUploadStore,
    type StoredUploadState,
    type UploadStateReadOptions,
    type UploadStateSnapshot,
    type CreateUploadOptions,
    type AppendChunkOptions,
    type AppendChunkResult,
    type UploadSweepCutoff,
    type CompleteUploadOptions,
    type CompletedUpload,
} from "./upload-store.ts";
import {
    UPLOAD_ID_RE,
    corruptUploadState,
    releaseUploadBody,
    newUploadId,
    requireSweepCutoff,
    isSweepable,
    isCount,
    openUploadBody,
    publishKeyGuard,
} from "./upload-internals.ts";
import { sweepEach } from "./sweep-each.ts";
import { casMerge } from "./cas-merge.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };
export { UploadNotFoundError, UploadOffsetConflictError, UploadDigestMismatchError, UploadDestinationConflictError };
export { UploadAppendBoundError, UploadOverrunError };
export type {
    ResumableWriteStore,
    SweepingWriteStore,
    StoredUploadState,
    CreateUploadOptions,
    AppendChunkOptions,
    AppendChunkResult,
    UploadSweepCutoff,
    CompleteUploadOptions,
    CompletedUpload,
};

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
 * Where the upload store keeps its bookkeeping and the read store refuses to
 * serve, by default. One constant, so the two defaults cannot drift apart.
 */
const S3_DEFAULT_UPLOAD_PREFIX = ".uploads/";

export interface S3StoreOptions {
    /**
     * Key prefix this store refuses to serve, because it is where an upload
     * store sharing this location keeps its in-flight bytes and the sidecars
     * naming their destination keys. Keys at or under it answer
     * {@link ObjectNotFoundError}. Set to `""` when no upload store shares it.
     * @default ".uploads/"
     */
    reservedPrefix?: string;
    /** Pre-configured S3Client instance (BYOC, no config coupling). */
    client: S3Client;
    /** The S3 bucket name. */
    bucket: string;
}

/** Both S3 factories need a client and a bucket; neither fails usefully without one. */
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
    const assertReadable = reservedKeyGuard(opts.reservedPrefix ?? S3_DEFAULT_UPLOAD_PREFIX);

    return {
        supportsRange: true,
        // 206 bounds/total are parsed from S3's actual Content-Range: the
        // orchestrator may skip the validating HEAD for plain range requests.
        authoritativeRange: true,

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
            };
        },

        async getObject(
            key: string,
            opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string },
        ): Promise<ObjectStream> {
            assertReadable(key);
            const { range, signal, ifMatch } = opts ?? {};
            // Open-ended fast-path ranges (`bytes=a-`) carry the OPEN_ENDED
            // sentinel end; emit the bare open form so no 16-digit last-byte-pos
            // reaches the wire (S3 clamps it, but strict proxies may reject it).
            const rangeHeader = range
                ? isOpenEndedRange(range)
                    ? `bytes=${range.start}-`
                    : `bytes=${range.start}-${range.end}`
                : undefined;

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
                stream.cancel().catch(() => {
                    /* already-errored streams reject cancel */
                });
                throw new Error(`S3 GetObject returned no ContentLength`);
            }
            const contentLength = response.ContentLength;

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
                    stream.cancel().catch(() => {
                        /* already-errored streams reject cancel */
                    });
                    throw new Error(`S3 returned unparseable Content-Range: ${response.ContentRange}`);
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
 * Check if an S3 error indicates the object does not exist.
 *
 * Covers:
 *   - AWS SDK v3 `NoSuchKey` and `NotFound` error classes
 *   - Generic S3-compatible providers that set `$metadata.httpStatusCode: 404`
 *   - Providers that set `name: "NotFound"` or `name: "NoSuchKey"` without
 *     using the SDK error classes (a second SDK copy in the module graph
 *     makes `instanceof` silently false, so names are matched too)
 */
function isNotFoundError(err: unknown): boolean {
    return err instanceof NoSuchKey || err instanceof NotFound || s3ErrorIs(err, 404, "NotFound", "NoSuchKey");
}

/** An S3 error named one of `names` (matched by name, not class), or carrying `status`. */
function s3ErrorIs(err: unknown, status: number, ...names: string[]): boolean {
    return (
        (err instanceof Error && names.includes(err.name)) ||
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === status
    );
}

/**
 * Check if an S3 error is a failed IfMatch precondition (object changed).
 * The SDK surfaces this as name "PreconditionFailed" with HTTP 412.
 */
function isPreconditionFailedError(err: unknown): boolean {
    return s3ErrorIs(err, 412, "PreconditionFailed");
}

/**
 * A conditional write the destination refused: a failed precondition (412),
 * or S3's 409 `ConditionalRequestConflict` for a conditional write that raced
 * another write to the same key. Matched by name for the 409, since other
 * conflicts share that status.
 */
function isConditionalWriteRefused(err: unknown): boolean {
    return isPreconditionFailedError(err) || s3ErrorIs(err, Number.NaN, "ConditionalRequestConflict");
}

/**
 * Check if an S3 error says the backend does not implement a request feature
 * (HTTP 501, error code `NotImplemented`). S3-compatibles answer a conditional
 * `PutObject` this way when they have not adopted the precondition headers.
 */
function isNotImplementedError(err: unknown): boolean {
    return s3ErrorIs(err, 501, "NotImplemented");
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
    let throttled = false;
    if ((err as { $retryable?: { throttling?: boolean } }).$retryable?.throttling === true) {
        throttled = true;
    } else {
        const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
        if (meta?.httpStatusCode === 503 || meta?.httpStatusCode === 429) {
            throttled = true;
        } else {
            throttled = s3ErrorIs(
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
        }
    }
    if (!throttled) return false;
    // Surface the backend's advised back-off when the SDK kept the raw
    // response: the resulting 503 echoes it as Retry-After so clients and
    // shared caches wait the advised interval instead of hammering an origin
    // that is already shedding load.
    const headers = (err as { $response?: { headers?: Record<string, string> } }).$response?.headers;
    const hint = parseRetryAfterSeconds(headers?.["retry-after"], { allowHttpDate: true });
    return hint !== undefined ? { retryAfterSeconds: hint } : true;
}

/** The ordered error-classification set shared by headObject and getObject. */
const s3Classifiers: StoreErrorClassifiers = {
    notFound: isNotFoundError,
    changed: isPreconditionFailedError,
    throttled: isThrottledError,
};

// ─── Resumable-Upload Write Adapter ─────────────────────────────────────────

/** The multipart part-size floor S3 enforces for every non-final part: 5 MiB. */
const S3_MIN_PART_SIZE = 5 * 1024 * 1024;

/**
 * S3's hard ceiling on parts per multipart upload. Parts need not be uniform,
 * so an append with a known length sizes its parts for the bytes and parts
 * that remain, up to `S3_MAX_PART_SIZE`. A deferred length can only assume
 * `minPartSize`, so its upload holds at most `S3_MAX_MULTIPART_PARTS *
 * minPartSize` bytes (~48.8 GiB at the 5 MiB default) and an append past that
 * is refused as a non-fatal append bound.
 */
const S3_MAX_MULTIPART_PARTS = 10_000;

/** The largest part S3 accepts: 5 GiB. */
const S3_MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;

const INVALIDATED_MESSAGE = "Upload resource is invalidated";

const PART_LIMIT_MESSAGE = `s3UploadStore: the upload does not fit S3's ${S3_MAX_MULTIPART_PARTS}-part limit`;

/** A HEAD's ContentLength; a response without one carries no byte accounting to trust. */
function headLength(response: { ContentLength?: number }): number {
    if (response.ContentLength == null) throw new Error(`HeadObject returned no ContentLength`);
    return response.ContentLength;
}

/**
 * The offset an upload has reached: `committed` bytes of parts plus a parked
 * tail of `size` bytes stamped with the offset it was accepted at.
 *
 * - Stamped AT `committed`: it follows the parts and counts.
 * - Stamped BELOW: a holder whose view was stale (its lock was stolen while
 *   its body streamed, and the winner committed a part in between) parked
 *   it. Counting it would place those bytes where the client never sent them,
 *   so it counts nowhere; it stays in the slot, where the next park replaces
 *   it pinned to its version and an abort or the sweep removes it.
 * - Stamped ABOVE: a newer holder parked it after parts this listing does not
 *   hold yet. Parts never shrink, so its stamp plus its size is a floor the
 *   upload has durably reached, and an acknowledged offset never decreases.
 * - Unstamped: parked by a build that did not stamp, and counted where found;
 *   that trust ends with the skew window, and the sweep bounds the wait.
 */
function tailEnd(committed: number, size = 0, stamp?: string): number {
    const at = stamp === undefined ? committed : Number(stamp);
    return at >= committed ? at + size : committed;
}

/** An entity tag as the opaque value it carries: no `W/` prefix, no quotes, lowercase. */
const normalizeEtag = (etag: string | undefined): string | undefined =>
    etag?.replace(/^W\//, "").replaceAll('"', "").toLowerCase();

/**
 * A truncated listing page must say where the next one starts; one that does
 * not would end the walk early and hide everything behind it.
 */
function requireMarker(marker: string | undefined): marker is string {
    if (marker === undefined) throw new Error("a truncated listing carried no continuation marker");
    return true;
}

/**
 * Fail at the crossing part, not at completion: past the ceiling S3 rejects
 * CompleteMultipartUpload opaquely, so the real cause surfaces while the
 * token still resolves.
 */
function assertPartNumber(partNumber: number): void {
    if (partNumber > S3_MAX_MULTIPART_PARTS) {
        throw new RangeError(PART_LIMIT_MESSAGE);
    }
}

export interface S3UploadStoreOptions {
    /** Pre-configured S3Client instance (BYOC, no config coupling). */
    client: S3Client;
    /** The S3 bucket name. */
    bucket: string;
    /**
     * Part-buffering threshold in bytes. Defaults to 5 MiB, the floor S3 and
     * its compatibles enforce for every non-final multipart part. Appends
     * buffer to this size before committing a part; the sub-minimum remainder
     * is parked in a sidecar object until the next append or completion.
     * Parts are cut at exactly this size and S3 caps a multipart upload at
     * 10,000 parts, so raise it when objects may exceed 10,000 x minPartSize.
     */
    minPartSize?: number;
    /**
     * Key prefix for the upload bookkeeping sidecars (`<token>.info` metadata
     * and `<token>.part` sub-minimum tail). Defaults to `".uploads/"`; a
     * trailing slash is appended when missing. The store reports the effective
     * value as `uploadPrefix`; pass it as the read store's `reservedPrefix`.
     */
    uploadPrefix?: string;
    /**
     * Opt into S3 flexible checksums: SHA-256 on every part, verified by the
     * backend at part-upload time (per-part TRANSPORT integrity), with the
     * part checksums restated at completion so the backend validates the
     * assembled part list.
     *
     * This is deliberately NOT whole-object digest verification: multipart
     * SHA-256 checksums are composite only (a hash of per-part hashes), so no
     * S3 backend can verify a caller-asserted whole-representation SHA-256 at
     * completion, and `digestOnComplete` stays `false` either way.
     *
     * Default OFF because the checksum parameters are NOT portable across
     * S3-compatibles: some deployments reject them outright (501). Probe your
     * backend before enabling.
     *
     * Leaving this off governs only the checksums this store requests. Recent
     * AWS SDK clients add a CRC32 checksum to every upload on their own while
     * `requestChecksumCalculation` is `"WHEN_SUPPORTED"`, their default, and a
     * backend that rejects checksum parameters rejects that one too. Construct
     * the client with `requestChecksumCalculation: "WHEN_REQUIRED"` for such a
     * backend; the store cannot read that setting back from the client.
     */
    checksums?: boolean;
    /**
     * Write the `<token>.info` metadata sidecar conditionally: `If-Match` on the
     * ETag the merge read, `If-None-Match: *` at creation. A writer whose
     * read is stale (a holder whose lock was stolen while its body streamed)
     * gets a 412 instead of overwriting the winner's record, the merge re-reads
     * and retries a bounded number of times, and a write that keeps losing
     * fails rather than landing. The `<token>.part` tail is parked on the same
     * switch, pinned to the tail the append read (`If-Match`) or to absence
     * (`If-None-Match: *`), and every append that commits a part parks one,
     * empty when nothing is left over. A stale holder's park is therefore
     * refused as an offset conflict at the winner's offset, which is also what
     * lets an append write against the orchestrator's state read instead of
     * reading it again; with this off, the append reads it again.
     *
     * Default ON: S3 implements both headers on `PutObject`, and the sidecar is
     * the only record of an upload's invalidation, which nothing else recomputes.
     * Some S3-compatible backends accept the headers and ignore them, which no
     * single write reveals. Before its first conditional write the store
     * therefore asks once: it creates a canary object under `uploadPrefix`
     * with `If-None-Match: *` twice, deletes it, and trusts the backend only
     * when the second create answered 412. The verdict is kept for the store's
     * lifetime; a probe that fails for another reason decides nothing and is
     * asked again. A backend that accepted both creates, or answers
     * `NotImplemented`, fails the operation loudly with an error naming this
     * option rather than degrading in place; set `false` for such a backend, accepting that
     * its sidecar writes are read-modify-writes whose only protection is the
     * one-round-trip re-read and the monotonic terminal flags.
     */
    sidecarCas?: boolean;
    /**
     * Publish under a precondition on the destination: completion records
     * the key's state when it seals (its ETag, or that it is empty) and sends
     * CompleteMultipartUpload with `If-Match` on that ETag or
     * `If-None-Match: *`. An object a third party wrote at the key after the
     * seal is then never overwritten: the backend refuses the commit (412, or
     * 409 `ConditionalRequestConflict` for a concurrent write) and the store
     * throws `UploadDestinationConflictError`, with nothing published.
     *
     * Default ON: S3 implements both headers on CompleteMultipartUpload. Some
     * S3-compatible backends accept and ignore them, so before its first
     * conditional publish the store asks once, as for `sidecarCas`: it commits
     * an empty multipart canary under `uploadPrefix` with `If-None-Match: *`,
     * then a second one over it with `If-None-Match: *` and with `If-Match` on
     * a tag nothing carries, and trusts the backend only when both are refused
     * with 412. It aborts the refused upload and deletes the canary object (a
     * canary left behind is shaped like an orphan tail, which the sweep
     * reclaims). A backend that accepted either, or answers `NotImplemented`,
     * fails the completion with an error naming this option. Set `false` for
     * such a backend, accepting that a key written between the seal and the
     * commit is overwritten by this upload's object. Recovery after a lost
     * completion response still adopts only an object that carries this
     * upload's publication id, either way.
     */
    publishCas?: boolean;
    /**
     * Key prefix under which every multipart upload belongs to this store
     * (`""` for the whole bucket). When set, {@link
     * ResumableWriteStore.sweepExpired} also aborts the multipart uploads
     * under it that no sidecar names and whose `Initiated` time precedes
     * either cutoff: a creation that failed between CreateMultipartUpload and
     * its sidecar write leaves exactly such an upload, which nothing else can
     * reach. Unset, that pass does not run. Leave it unset for keys another
     * writer also uploads to in multipart: an upload started by that writer
     * has no sidecar either, and the pass would abort it.
     *
     * A bucket lifecycle rule with `AbortIncompleteMultipartUpload` covers
     * the same orphans on the backend's own schedule, with or without this.
     */
    multipartSweepPrefix?: string;
}

/**
 * Create a {@link ResumableWriteStore} backed by an S3-compatible bucket,
 * built on multipart uploads.
 *
 * Layout: each upload resource is one multipart upload targeting the final
 * key, plus two bookkeeping sidecars under `uploadPrefix`: `<token>.info`
 * (creation-time facts: declared length, metadata, timestamps, the
 * invalidation flag) and `<token>.part` (tail bytes below the part-size
 * floor, prepended to the next append or committed as the size-exempt final
 * part at completion).
 *
 * The offset is always derived from backend bookkeeping -- the committed
 * part listing plus the tail sidecar's size -- never from a stored counter,
 * so a crashed append can never answer an offset ahead of the durable bytes.
 *
 * @example
 * ```typescript
 * import { S3Client } from "@aws-sdk/client-s3";
 * import { s3UploadStore } from "partial-content/s3";
 *
 * const client = new S3Client({ region: "eu-central-1" });
 * const uploads = s3UploadStore({ client, bucket: "documents" });
 *
 * const { uploadToken } = await uploads.createUpload({
 *   key: "reports/q4.pdf",
 *   length: 12_582_912,
 *   now: Date.now(),
 * });
 * ```
 */
export function s3UploadStore(opts: S3UploadStoreOptions): PrefixedUploadStore {
    assertS3Target("s3UploadStore", opts);
    const { client, bucket, checksums = false, sidecarCas = true, publishCas = true, multipartSweepPrefix } = opts;
    const minPartSize = opts.minPartSize ?? S3_MIN_PART_SIZE;
    if (!Number.isSafeInteger(minPartSize) || minPartSize <= 0) {
        throw new RangeError(`s3UploadStore: minPartSize must be a positive safe integer, got ${minPartSize}`);
    }
    const rawPrefix = opts.uploadPrefix ?? S3_DEFAULT_UPLOAD_PREFIX;
    const prefix = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;
    const assertPublishable = publishKeyGuard(prefix);
    // The token is interpolated into object names, so the shape check lives in
    // the builders rather than at each call site: a caller that skipped it could
    // otherwise address `<prefix><anything>.info` and delete or read an object
    // this store never minted, including the foreign objects the sweep
    // deliberately leaves alone. Callers that must tolerate an unknown token
    // (readInfoEntry, abortUpload) test it themselves and never reach here.
    const assertToken = (token: string): string => {
        if (!UPLOAD_ID_RE.test(token)) {
            throw new TypeError("s3UploadStore: not a token this store minted");
        }
        return token;
    };
    const infoKey = (token: string): string => `${prefix}${assertToken(token)}.info`;
    const partKey = (token: string): string => `${prefix}${assertToken(token)}.part`;
    /** `base`, grown only as far as `remaining` bytes need to fit `partsLeft` parts. */
    const sizePart = (base: number, remaining: number, partsLeft: number): number =>
        Math.max(base, Math.min(S3_MAX_PART_SIZE, Math.ceil(remaining / partsLeft)));

    const classified = <T>(key: string, op: () => Promise<T>): Promise<T> =>
        classifyStoreRead(key, op, uploadOpClassifiers);

    /** A read of `key` that answers `undefined` when the object does not exist. */
    const readOrAbsent = <T>(key: string, op: () => Promise<T>): Promise<T | undefined> =>
        classified(key, op).catch((err: unknown) => {
            if (isNotFoundError(err)) return undefined;
            throw err;
        });
    const getOrAbsent = (key: string, signal?: AbortSignal) =>
        readOrAbsent(key, () =>
            client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal }),
        );
    const headOrAbsent = (key: string, signal?: AbortSignal) =>
        readOrAbsent(key, () =>
            client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal }),
        );

    /**
     * Read + parse the metadata sidecar together with the ETag the backend
     * stamped on it; `undefined` when it does not exist. The ETag is the version
     * a conditional write is pinned to, and a backend that returns none leaves
     * `etag` unset, which the merge treats as "no version to pin".
     */
    async function readInfoEntry(token: string, signal?: AbortSignal): Promise<InfoEntry | undefined> {
        // The id is interpolated into object names, so a token that is not one the
        // store minted is refused here rather than sent to the backend as a key.
        if (!UPLOAD_ID_RE.test(token)) return undefined;
        const response = await getOrAbsent(infoKey(token), signal);
        if (response === undefined) return undefined;
        const bytes = await bodyToBytes(response.Body, "upload metadata");
        return {
            record: parseInfoRecord(new TextDecoder().decode(bytes)),
            etag: response.ETag,
        };
    }

    /**
     * The sidecar as a protocol request reads it: corrupt bookkeeping answers
     * the shared corrupt not-found, the 404 every store gives a resource
     * nobody can resume, marked as damage for the operator. The corrupt
     * record's own error stays inside the store (a discard reads what it still
     * names), since its cause quotes the record.
     */
    async function readUploadInfo(token: string, signal?: AbortSignal): Promise<InfoEntry | undefined> {
        try {
            return await readInfoEntry(token, signal);
        } catch (err) {
            if (err instanceof CorruptSidecarError) throw corruptUploadState(token);
            throw err;
        }
    }

    /**
     * Apply a patch to the sidecar, based on a FRESH read rather than on the
     * snapshot the caller has been holding, and written back only if the
     * sidecar is still the version that read returned.
     *
     * The snapshot an append is holding was read before the body streamed,
     * which can be minutes. The lock makes that safe for a live holder and does
     * not make it safe for one whose lock was stolen: such a holder would write
     * back a record from before the new holder's changes, and `invalidated`
     * lives ONLY here, so re-writing it away silently resurrects a terminally
     * dead upload. Unlike `completed`, which the multipart-gone fallback
     * re-derives from the published object, nothing recomputes that flag.
     *
     * Three rules make the merge safe for what a stale writer can still do:
     *
     * - The write is CONDITIONAL on the ETag the fresh read returned. A record
     *   that changed between the read and the write is refused with a 412, the
     *   merge re-reads and tries again, and after `CAS_MERGE_ATTEMPTS` losses
     *   it fails rather than landing. That is what closes the window: a stale
     *   writer cannot overwrite a record it has not seen.
     * - Both terminal flags are MONOTONIC. Once set, no later write clears them,
     *   whichever record it was computed from.
     * - The creation facts, a recorded length and the published ETag come from
     *   the fresh copy. They are write-once by contract, so the fresh copy
     *   either equals the caller's or is the one that won.
     *
     * The first rule needs a version to pin to. Without one (`sidecarCas` off,
     * or a backend that stamps no ETag on the sidecar) the write is
     * unconditional and the last two rules are the whole protection: the
     * window is one round trip rather than closed, which is the residual
     * `sidecarCas` documents.
     *
     * A read that FAILS supplies none of the three, so it fails the merge. The
     * caller's snapshot is not a base to write from: it predates the body, and
     * writing it back would clear whatever a live holder has recorded since,
     * unconditionally, which is the exact loss the fresh read exists to stop.
     *
     * The one exception is a `held` entry under the first rule: its write is
     * pinned to the version it carries, so it lands only while the sidecar is
     * still exactly that version, which is as good as a fresh read of it. The
     * first pass writes from it without a read, and a 412 falls back to fresh
     * reads. Without a version to pin, a held entry is ignored.
     *
     * A patch that depends on the record (the seal, its lift, an append's
     * write that a seal must refuse) is a function of the fresh record, run
     * on every pass, so its decision is made against the version the write
     * is pinned to. It may throw to refuse, or answer `undefined` when the
     * fresh record already says what the caller needs, and nothing is
     * written. Answers the record as it stands after the merge.
     */
    async function mergeInfo(
        token: string,
        patch: InfoPatch | ((fresh: UploadInfoRecord) => InfoPatch | undefined),
        signal?: AbortSignal,
        held?: InfoEntry,
    ): Promise<UploadInfoRecord> {
        let result: UploadInfoRecord | undefined;
        // Only a write that carried a precondition can lose it; a 412 from an
        // unconditional one is the backend's failure and is not retried.
        let pinned = false;
        await casMerge({
            read: async () => {
                const entry = sidecarCas && held?.etag !== undefined ? held : await readUploadInfo(token, signal);
                held = undefined;
                return entry;
            },
            merge: (entry) => {
                // A sidecar that is gone was reaped: by the sweep, by an abort, or
                // by the completion's cleanup. Writing the caller's snapshot back
                // would recreate the resource from a holder the reap already
                // ended, so the resource is reported gone instead. Creation is the
                // one write that starts from absence, and it pins to absence
                // through writeInfo itself.
                if (entry === undefined) throw new UploadNotFoundError(token);
                const { record: fresh, etag } = entry;
                // A read that returned no ETag has no version to pin to.
                const condition = sidecarCas && etag !== undefined ? { IfMatch: etag } : undefined;
                pinned = condition !== undefined;
                const applied = typeof patch === "function" ? patch(fresh) : patch;
                if (applied === undefined) return { record: fresh, condition, unchanged: true };
                const record: UploadInfoRecord = {
                    ...fresh,
                    ...applied,
                    // The declaration and the part size it fixed are written once.
                    ...(fresh.length !== undefined && { length: fresh.length, partSize: fresh.partSize }),
                    publishedEtag: fresh.publishedEtag ?? applied.publishedEtag,
                    invalidated: fresh.invalidated || applied.invalidated || undefined,
                    completed: fresh.completed || applied.completed || undefined,
                };
                return { record, condition, unchanged: false };
            },
            write: async ({ record, condition, unchanged }) => {
                if (!unchanged) await writeInfo(token, record, signal, condition);
                result = record;
            },
            isConflict: (err) => pinned && isPreconditionFailedError(err),
            signal,
        });
        // casMerge returns only after a pass's write step ran, which set it.
        return result!;
    }

    /**
     * Write the sidecar, under `condition` when one is given and `sidecarCas`
     * is on. A backend that does not honour the precondition fails the write
     * with the option named ({@link requireCas}), never writes without it.
     */
    async function writeInfo(
        token: string,
        record: UploadInfoRecord,
        signal?: AbortSignal,
        condition?: SidecarWriteCondition,
    ): Promise<void> {
        const applied = sidecarCas ? condition : undefined;
        if (applied) await requireCas();
        await classified(infoKey(token), () =>
            client.send(
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: infoKey(token),
                    Body: JSON.stringify(record),
                    ContentType: "application/json",
                    ...applied,
                }),
                { abortSignal: signal },
            ),
        );
    }

    /**
     * Whether the backend honours a conditional PutObject, asked once per
     * store before its first conditional write. A canary is created under
     * If-None-Match: *, and the same create again must be refused with a
     * 412. A backend that accepts the second create ignores the precondition,
     * so every sidecar write it took as pinned would land unpinned; one that
     * answers NotImplemented lacks it. Both refuse with the option named,
     * and that verdict is kept: a protection that switches itself off is one
     * the operator believes they have. Any other failure decides nothing, so
     * the next conditional write asks again. The canary is shaped like a
     * tail no sidecar names, so the sweep reclaims one a failed delete left.
     */
    let casVerdict: Promise<void> | undefined;
    function requireCas(): Promise<void> {
        return (casVerdict ??= (async () => {
            const canary = partKey(newUploadId());
            const create = () =>
                classified(canary, () =>
                    client.send(new PutObjectCommand({ Bucket: bucket, Key: canary, Body: "", IfNoneMatch: "*" })),
                );
            try {
                await create();
                await create();
            } catch (err) {
                // The canary's name is fresh, so only the second create can
                // lose its precondition.
                if (isPreconditionFailedError(err)) return;
                if (!isNotImplementedError(err)) {
                    casVerdict = undefined;
                    throw err;
                }
            } finally {
                // Best-effort: the sweep reclaims a canary left behind.
                await deleteObjectIdempotent(canary).catch(() => undefined);
            }
            throw new Error("the backend does not honour conditional PutObject; set sidecarCas: false");
        })());
    }

    /**
     * Whether the backend honours a conditional CompleteMultipartUpload,
     * asked once per store before its first conditional publish, on the same
     * terms as {@link requireCas}: a refusal for a missing feature is kept, a
     * failure for any other reason decides nothing. An empty canary commits
     * under If-None-Match: *, then a second multipart upload at the same name
     * must be refused under If-None-Match: * and under If-Match on a tag
     * nothing carries. The canary is shaped like an orphan tail, so the sweep
     * reclaims one a failed delete left.
     */
    let publishVerdict: Promise<void> | undefined;
    function requirePublishCas(): Promise<void> {
        return (publishVerdict ??= (async () => {
            const canary = partKey(newUploadId());
            const open = async (): Promise<{ uploadId: string; parts: CompletedPart[] }> => {
                const { UploadId } = await classified(canary, () =>
                    client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: canary })),
                );
                if (UploadId === undefined) throw new Error("CreateMultipartUpload returned no UploadId");
                const { ETag } = await classified(canary, () =>
                    client.send(
                        new UploadPartCommand({
                            Bucket: bucket,
                            Key: canary,
                            UploadId,
                            PartNumber: 1,
                            Body: new Uint8Array(0),
                        }),
                    ),
                );
                return { uploadId: UploadId, parts: [{ PartNumber: 1, ETag }] };
            };
            const commit = (
                upload: { uploadId: string; parts: CompletedPart[] },
                condition: PublishCondition,
            ): Promise<unknown> =>
                classified(canary, () =>
                    client.send(
                        new CompleteMultipartUploadCommand({
                            Bucket: bucket,
                            Key: canary,
                            UploadId: upload.uploadId,
                            MultipartUpload: { Parts: upload.parts },
                            ...condition,
                        }),
                    ),
                );
            /** True when the commit was refused on its precondition, false when it landed. */
            const refused = (op: Promise<unknown>): Promise<boolean> =>
                op.then(
                    () => false,
                    (err: unknown) => {
                        if (isPreconditionFailedError(err)) return true;
                        throw err;
                    },
                );
            let second: { uploadId: string } | undefined;
            try {
                await commit(await open(), { IfNoneMatch: "*" });
                const upload = await open();
                second = upload;
                if (
                    (await refused(commit(upload, { IfNoneMatch: "*" }))) &&
                    (await refused(commit(upload, { IfMatch: '"0"' })))
                ) {
                    return;
                }
            } catch (err) {
                if (!isNotImplementedError(err)) {
                    publishVerdict = undefined;
                    throw err;
                }
            } finally {
                // Best-effort: the sweep reclaims a canary object, and the
                // multipart sweep or a lifecycle rule an upload left open.
                if (second !== undefined) await abortMultipart(canary, second.uploadId).catch(() => undefined);
                await deleteObjectIdempotent(canary).catch(() => undefined);
            }
            throw new Error("the backend does not honour conditional CompleteMultipartUpload; set publishCas: false");
        })());
    }

    /**
     * Download the sub-minimum tail sidecar; `undefined` when absent. It is
     * read beside the part listing rather than after it, so the caller judges
     * it against the listing with {@link countedTail}.
     */
    async function readTail(token: string, signal?: AbortSignal): Promise<ParkedTail | undefined> {
        const response = await getOrAbsent(partKey(token), signal);
        // Drained before any decision: the tail is sub-minimum by
        // construction, and a cancelled SDK body can leave its socket open.
        return (
            response && {
                bytes: await bodyToBytes(response.Body, "upload tail"),
                etag: response.ETag,
                stamp: response.Metadata?.[TAIL_OFFSET_METADATA_KEY],
                lastModified: response.LastModified?.getTime(),
            }
        );
    }

    /**
     * The tail that counts after `committed` bytes of parts (or `undefined`),
     * and the offset the upload has reached. A refusal for a tail parked past
     * `committed` is the caller's: see {@link tailEnd}.
     */
    function countedTail(
        token: string,
        tail: ParkedTail | undefined,
        committed: number,
    ): [ParkedTail | undefined, number] {
        const end = tailEnd(committed, tail?.bytes.length, tail?.stamp);
        // Parked by a newer holder after parts this caller's listing does not
        // hold: those bytes were acknowledged, so the caller is the stale one.
        if (Number(tail?.stamp) > committed) throw new UploadOffsetConflictError(token, end);
        return [end > committed ? tail : undefined, end];
    }

    /**
     * Park the sub-minimum remainder of an append at `offset`, stamped with the
     * offset so a later derivation can tell whether it still belongs after the
     * committed parts. Under `sidecarCas` the write is conditional on the slot
     * holding exactly what this append read: the tail it `replaces`, by ETag,
     * or nothing. A holder whose lock was stolen while it streamed parks after
     * the winner did, and its park must lose rather than replace the winner's
     * tail. Losing is the safe direction: the bytes it would have parked were
     * never acknowledged, and the tail it read is either still in place or
     * already inside a committed part. It loses as an offset conflict carrying
     * the offset the winner reached, so the client resumes from there.
     */
    async function parkTail(
        token: string,
        info: UploadInfoRecord,
        offset: number,
        remainder: Uint8Array,
        replaces: ParkedTail | undefined,
    ): Promise<void> {
        if (sidecarCas) await requireCas();
        try {
            await classified(partKey(token), () =>
                client.send(
                    new PutObjectCommand({
                        Bucket: bucket,
                        Key: partKey(token),
                        Body: remainder,
                        Metadata: { [TAIL_OFFSET_METADATA_KEY]: String(offset) },
                        ...(sidecarCas ? (replaces ? { IfMatch: replaces.etag } : { IfNoneMatch: "*" }) : {}),
                    }),
                ),
            );
        } catch (err) {
            if (sidecarCas && isPreconditionFailedError(err)) {
                throw new UploadOffsetConflictError(token, await reachedOffset(token, info));
            }
            throw err;
        }
    }

    /** The offset a live upload has reached, read fresh: its parts, then its tail's size and stamp. */
    async function reachedOffset(token: string, info: UploadInfoRecord): Promise<number> {
        const parts = await listCommittedParts(info.key, info.uploadId).catch(goneAsNotFound(token));
        // HEAD after the listing, as in a state read: a part committed in
        // between shows as a tail stamped past it, which still counts.
        const tail = await headOrAbsent(partKey(token));
        return tailEnd(parts.size, tail && headLength(tail), tail?.Metadata?.[TAIL_OFFSET_METADATA_KEY]);
    }

    /**
     * Refuse an append against a sealed record with the length the seal
     * publishes, or against a record a build without the seal completed (its
     * multipart upload is gone, so the upload is not found to an append).
     * Answers `patch` otherwise, for a sidecar write an append makes.
     */
    function refuseSealed<P>(token: string, record: UploadInfoRecord, patch?: P): P | undefined {
        if (record.completing !== undefined) throw new UploadOffsetConflictError(token, record.completing.length);
        if (record.completed === true) throw new UploadNotFoundError(token);
        return patch;
    }

    /**
     * The state reads this store handed out for an append, by the opaque
     * handle it returned. A handle is honoured once, by the append to the
     * upload it was read for; one this store did not mint finds nothing here,
     * so no caller can hand an append a state it fabricated.
     */
    const snapshots = new WeakMap<UploadStateSnapshot, S3StateSnapshot>();
    function takeSnapshot(handle: UploadStateSnapshot | undefined, token: string): S3StateSnapshot | undefined {
        if (handle === undefined) return undefined;
        const held = snapshots.get(handle);
        snapshots.delete(handle);
        return held?.token === token ? held : undefined;
    }

    /** DeleteObject that tolerates already-gone keys (S3 does natively; some compatibles 404). */
    async function deleteObjectIdempotent(key: string, signal?: AbortSignal): Promise<void> {
        try {
            await classified(key, () =>
                client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal }),
            );
        } catch (err) {
            if (!isNotFoundError(err)) throw err;
        }
    }

    /**
     * The object at the upload's key with whether it is this upload's
     * publication; `undefined` when the key is empty. The key alone proves
     * nothing: a replace flow creates the upload over a key that already holds
     * an object, a lifecycle rule can abort the multipart upload under a live
     * sidecar, and a third party can write the key between a lost publish
     * response and its retry, in an object of any size and part count.
     *
     * So the proof is identity, never shape: the object is ours exactly when
     * its user metadata carries the record's publication id, which the
     * multipart upload was created with and nothing else knows. A record
     * written before the id was minted is attributed only through a
     * completion it recorded after its commit returned: by the ETag it
     * stamped while the object still carries it, or, older still and
     * unstamped, by the length it fixed. Such a record's in-flight publish
     * (`publishing`) proves nothing and attributes nothing.
     */
    async function objectAtKey(
        info: UploadInfoRecord,
        signal?: AbortSignal,
    ): Promise<{ size: number; etag?: string; ours: boolean } | undefined> {
        const response = await headOrAbsent(info.key, signal);
        if (response === undefined) return undefined;
        const object = { size: headLength(response), etag: response.ETag };
        if (info.publicationId !== undefined) {
            return { ...object, ours: response.Metadata?.[PUBLICATION_METADATA_KEY] === info.publicationId };
        }
        if (info.completed !== true) return { ...object, ours: false };
        // Compared as opaque tags, never as spellings: S3-compatibles differ in
        // whether one call quotes or weak-prefixes what another returns bare.
        const tag = normalizeEtag(object.etag);
        const ours =
            info.publishedEtag !== undefined
                ? tag === undefined || tag === normalizeEtag(info.publishedEtag)
                : info.length === undefined || object.size === info.length;
        return { ...object, ours };
    }

    /**
     * The answer for an upload whose multipart upload is gone, or whose
     * publish was refused: the object it published, when the key holds this
     * upload's publication (a completion recorded afterwards, unless the
     * caller asked for no repair). Otherwise an object at the key under a
     * seal, or after a refused publish, is a destination conflict: either a
     * third party wrote the key or the upload's publication was replaced,
     * and neither is this upload's to claim. The one object a seal does not
     * contest is the one it recorded, still unchanged: the key was never
     * touched, so the multipart upload was aborted under the seal (a lifecycle
     * rule) and nothing published. A pre-seal record's publish entry gets no
     * such pass, since its commit may have produced that very object.
     * Anything else is a vanished upload. A completed upload whose object was
     * replaced since is vanished too: its completion is not in question, only
     * what sits at the key now.
     */
    async function adopt(
        token: string,
        info: UploadInfoRecord,
        opts: { signal?: AbortSignal | undefined; repair?: false | undefined },
        cause?: unknown,
        refused = false,
    ): Promise<{ size: number; etag?: string }> {
        const found = await objectAtKey(info, opts.signal);
        if (found?.ours === true) {
            if (info.completed !== true && opts.repair !== false) {
                // A promotion that fails leaves the next probe to repeat the match.
                await mergeInfo(token, { completed: true, publishedEtag: found.etag }, opts.signal).catch(
                    () => undefined,
                );
            }
            return found;
        }
        if (refused) throw new UploadDestinationConflictError(token, cause);
        if (found !== undefined && info.completed !== true) {
            const recorded = info.completing?.destination;
            const untouched =
                info.publishing === undefined &&
                typeof recorded === "string" &&
                normalizeEtag(found.etag) === normalizeEtag(recorded);
            const contested = info.publishing !== undefined || (info.completing !== undefined && !untouched);
            if (contested) throw new UploadDestinationConflictError(token, cause);
        }
        throw new UploadNotFoundError(token, cause);
    }

    /**
     * Every committed part, across every ListParts page, with their total size
     * and the part number the next flush takes.
     */
    async function listCommittedParts(key: string, uploadId: string, signal?: AbortSignal): Promise<CommittedParts> {
        const parts: CommittedParts = Object.assign([], { size: 0, next: 1, last: 0 });
        let marker: string | undefined;
        for (;;) {
            const page = await classified(key, () =>
                client.send(
                    new ListPartsCommand({
                        Bucket: bucket,
                        Key: key,
                        UploadId: uploadId,
                        PartNumberMarker: marker,
                    }),
                    { abortSignal: signal },
                ),
            );
            for (const part of page.Parts ?? []) {
                if (part.PartNumber == null || part.Size == null) {
                    throw new Error(`ListParts returned a part without number/size`);
                }
                parts.push({
                    PartNumber: part.PartNumber,
                    ETag: part.ETag,
                    ChecksumSHA256: checksums ? part.ChecksumSHA256 : undefined,
                });
                parts.size += part.Size;
                parts.next = Math.max(parts.next, part.PartNumber + 1);
                parts.last = Math.max(parts.last, part.LastModified?.getTime() ?? 0);
            }
            if (page.IsTruncated !== true || !requireMarker(page.NextPartNumberMarker)) return parts;
            marker = page.NextPartNumberMarker;
        }
    }

    /**
     * The committed parts of a live upload, or the object it published. A
     * multipart that is gone while its record remains was either completed by
     * a commit whose result was never recorded, or aborted by an external
     * actor (a lifecycle rule); {@link adopt} tells the two apart by identity.
     */
    async function partsOrPublished(
        token: string,
        info: UploadInfoRecord,
        opts: { signal?: AbortSignal | undefined; repair?: false | undefined },
    ) {
        let gone: unknown;
        if (info.completed !== true) {
            try {
                return await listCommittedParts(info.key, info.uploadId, opts.signal);
            } catch (err) {
                if (!isMultipartGoneError(err)) throw err;
                gone = err;
            }
        }
        return adopt(token, info, opts, gone);
    }

    async function abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
        const signal = abortOpts?.signal;
        // A token this store never minted names no resource here, so aborting it
        // is a no-op rather than an error: the call is idempotent by contract for
        // an unknown token, and a token that cannot be one is a stronger case of
        // unknown. Tested here rather than relied on downstream, because the two
        // deletes below run even when the sidecar read finds nothing.
        if (!UPLOAD_ID_RE.test(uploadToken)) return;
        // The multipart upload is named by the sidecar, so a token that names
        // none discards nothing. A sidecar read that fails propagates before
        // anything is deleted: deleting the sidecar while its upload is live
        // would report an erasure that did not happen.
        const { key, uploadId } = (await readDiscardTarget(uploadToken, signal)) ?? {};
        if (key !== undefined && uploadId !== undefined) {
            await abortMultipart(key, uploadId, signal);
        } else if (key !== undefined) {
            // The key survived and the upload id did not. Every multipart upload
            // at that key that no live sidecar claims is this one or an orphan.
            const named = await namedUploadIds(signal);
            for await (const upload of listMultipartUploads(key, signal)) {
                if (upload.Key === key && upload.UploadId !== undefined && !named.has(upload.UploadId)) {
                    await abortMultipart(key, upload.UploadId, signal);
                }
            }
        }
        await deleteObjectIdempotent(partKey(uploadToken), signal);
        await deleteObjectIdempotent(infoKey(uploadToken), signal);
    }

    /**
     * Upload one part, answering the entry a completion lists for it. Writes
     * deliberately carry no abort signal: an in-progress part is allowed to
     * finish so already-received bytes become durable (the orchestrator owns
     * the post-disconnect grace window).
     */
    async function uploadPart(
        key: string,
        uploadId: string,
        partNumber: number,
        body: Uint8Array,
    ): Promise<CompletedPart> {
        assertPartNumber(partNumber);
        const uploaded = await classified(key, () =>
            client.send(
                new UploadPartCommand({
                    Bucket: bucket,
                    Key: key,
                    UploadId: uploadId,
                    PartNumber: partNumber,
                    Body: body,
                    ChecksumAlgorithm: checksums ? "SHA256" : undefined,
                }),
            ),
        );
        return {
            PartNumber: partNumber,
            ETag: uploaded.ETag,
            ChecksumSHA256: checksums ? uploaded.ChecksumSHA256 : undefined,
        };
    }

    /** AbortMultipartUpload that tolerates an upload already gone (aborted, completed, reaped). */
    async function abortMultipart(key: string, uploadId: string, signal?: AbortSignal): Promise<void> {
        try {
            await classified(key, () =>
                client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), {
                    abortSignal: signal,
                }),
            );
        } catch (err) {
            if (!isMultipartGoneError(err)) throw err;
        }
    }

    /**
     * Every in-progress multipart upload whose key starts with `keyPrefix`,
     * across every ListMultipartUploads page (a page resumes after the key
     * and upload id the previous one ended on).
     */
    async function* listMultipartUploads(keyPrefix: string, signal?: AbortSignal): AsyncGenerator<MultipartUpload> {
        let page: ListMultipartUploadsCommandOutput | undefined;
        do {
            page = await classified(keyPrefix, () =>
                client.send(
                    new ListMultipartUploadsCommand({
                        Bucket: bucket,
                        Prefix: keyPrefix,
                        KeyMarker: page?.NextKeyMarker,
                        UploadIdMarker: page?.NextUploadIdMarker,
                    }),
                    { abortSignal: signal },
                ),
            );
            yield* page.Uploads ?? [];
        } while (page.IsTruncated === true && requireMarker(page.NextKeyMarker));
    }

    /** Every object under the bookkeeping prefix, across every listing page. */
    async function* listBookkeeping(signal?: AbortSignal): AsyncGenerator<_Object> {
        let page: ListObjectsV2CommandOutput | undefined;
        do {
            page = await classified(prefix, () =>
                client.send(
                    new ListObjectsV2Command({
                        Bucket: bucket,
                        Prefix: prefix,
                        ContinuationToken: page?.NextContinuationToken,
                    }),
                    { abortSignal: signal },
                ),
            );
            yield* page.Contents ?? [];
        } while (page.IsTruncated === true && requireMarker(page.NextContinuationToken));
    }

    /**
     * The multipart upload ids every live sidecar names. A sidecar that cannot
     * be read fails the whole answer: the upload it names is unknown, and a
     * caller acting on an incomplete set would abort a live upload.
     */
    async function namedUploadIds(signal?: AbortSignal): Promise<Set<string>> {
        const named = new Set<string>();
        for await (const { Key } of listBookkeeping(signal)) {
            if (!Key?.endsWith(".info")) continue;
            const uploadId = (await readDiscardTarget(Key.slice(prefix.length, -".info".length), signal))?.uploadId;
            if (uploadId !== undefined) named.add(uploadId);
        }
        return named;
    }

    /**
     * What a discard needs from the sidecar: the destination and the multipart
     * upload, from the record, or from whatever a corrupt record still names.
     * Corruption is the backend answering, which no retry repairs; a read that
     * FAILS propagates, because the sidecar is the only record of which
     * multipart upload holds the bytes.
     */
    async function readDiscardTarget(
        token: string,
        signal?: AbortSignal,
    ): Promise<{ key?: string; uploadId?: string; createdAt?: number } | undefined> {
        try {
            return (await readInfoEntry(token, signal))?.record;
        } catch (err) {
            if (err instanceof CorruptSidecarError) return err;
            throw err;
        }
    }

    /**
     * Seal the record at `length` for completion, recording the destination
     * state the publish is allowed over: the ETag the key holds now, or
     * `null` when it is empty. The write is pinned to the version `entry`
     * carries. A record that already carries a seal, or that another
     * completer completed, is answered as found: a retry resumes the seal
     * with the destination it recorded, never with what the key holds now.
     */
    async function seal(
        token: string,
        entry: InfoEntry,
        length: number,
        signal?: AbortSignal,
    ): Promise<UploadInfoRecord> {
        if (entry.record.completing !== undefined) return entry.record;
        const found = await headOrAbsent(entry.record.key, signal);
        let destination: string | null = null;
        if (found !== undefined) {
            if (found.ETag === undefined) throw new Error("HeadObject returned no ETag for the destination");
            destination = found.ETag;
        }
        return mergeInfo(
            token,
            (fresh) => {
                if (fresh.completing !== undefined || fresh.completed === true) return undefined;
                if (fresh.invalidated === true) throw new Error(INVALIDATED_MESSAGE);
                return { completing: { length, destination } };
            },
            signal,
            entry,
        );
    }

    /**
     * Lift a seal no completion can publish: one whose length the snapshot
     * does not hold. A seal at a length the snapshot does hold belongs to a
     * completer that can still publish, and lifting it would let an append
     * in while that completer commits a plan without it, so it stays.
     */
    async function liftSeal(
        token: string,
        holds: (length: number, declared: number | undefined) => boolean,
        signal?: AbortSignal,
    ): Promise<void> {
        await mergeInfo(
            token,
            (fresh) =>
                fresh.completing === undefined ||
                fresh.completed === true ||
                holds(fresh.completing.length, fresh.length)
                    ? undefined
                    : { completing: undefined },
            signal,
        );
    }

    /**
     * SNAPSHOT a sealed record's parts and tail, after the seal, and prove the
     * plan publishes exactly `expectedLength`, the whole representation when
     * one was declared. A plan short of an acknowledged append would publish
     * without it; the size is the check S3 cannot make, since it is never told
     * the total. A refused plan lifts a seal no snapshot can satisfy; a seal
     * at another length this snapshot proves dead is re-pointed at
     * `expectedLength` in one write, so appends stay fenced throughout. A
     * multipart upload that is gone is thrown as found, for the caller to
     * recover.
     */
    async function snapshotPlan(
        token: string,
        info: UploadInfoRecord,
        expectedLength: number,
        signal?: AbortSignal,
    ): Promise<SealedPlan> {
        const parts = await listCommittedParts(info.key, info.uploadId, signal);
        let tail: ParkedTail | undefined;
        let assembledSize: number;
        try {
            [tail, assembledSize] = countedTail(token, await readTail(token, signal), parts.size);
        } catch (err) {
            if (!isUploadOffsetConflictError(err)) throw err;
            assembledSize = err.durableOffset;
        }
        const holds = (length: number, declared: number | undefined): boolean =>
            length === assembledSize && (declared === undefined || length === declared);
        // A tail countedTail refused was parked past this listing, so the
        // listing misses parts and is no plan at any length.
        if ((tail === undefined && assembledSize !== parts.size) || !holds(expectedLength, info.length)) {
            await liftSeal(token, holds, signal);
            throw new UploadOffsetConflictError(token, assembledSize);
        }
        const sealed =
            info.completing?.length === expectedLength
                ? info
                : await mergeInfo(
                      token,
                      (fresh) => {
                          // Lifted, or completed, by another completer meanwhile.
                          if (fresh.completing === undefined || fresh.completed === true) {
                              throw new UploadOffsetConflictError(token, assembledSize);
                          }
                          return fresh.completing.length === expectedLength
                              ? undefined
                              : { completing: { ...fresh.completing, length: expectedLength } };
                      },
                      signal,
                  );
        const { completing } = sealed;
        if (completing === undefined) throw new Error("s3UploadStore: the completion seal did not land");
        return { info: sealed, completing, parts, tail };
    }

    /** The part list a plan commits: its listed parts, then its tail as the size-exempt final part. */
    async function assembleParts(token: string, plan: SealedPlan): Promise<CompletedPart[]> {
        const { info, parts, tail } = plan;
        const completedParts = [...parts];
        if (tail !== undefined) {
            // S3 exempts only the LAST part from the part-size floor, which is
            // exactly what the parked tail becomes here.
            const partNumber = parts.next;
            // Checked before any write, so an upload of exactly the limit plus
            // a tail fails here rather than with S3's opaque part-range error
            // after the tail was touched.
            assertPartNumber(partNumber);
            // The part is committed BEFORE the tail is removed, as in an
            // append: once it lands the committed sum passes the tail's stamp
            // and the tail stops counting, so its bytes count exactly once at
            // every instant. An unstamped tail would count again beside the
            // part, so it alone is removed first.
            if (tail.stamp === undefined) await deleteObjectIdempotent(partKey(token));
            completedParts.push(await uploadPart(info.key, info.uploadId, partNumber, tail.bytes));
            await deleteObjectIdempotent(partKey(token));
        }
        if (completedParts.length === 0) {
            // S3 rejects a CompleteMultipartUpload with zero parts; a zero-byte
            // upload commits one empty part so an empty object can publish.
            completedParts.push(await uploadPart(info.key, info.uploadId, 1, new Uint8Array(0)));
        }
        return completedParts;
    }

    /**
     * PUBLISH a plan under the destination precondition its seal recorded:
     * create-only over a key that was empty, replace-only of the exact object
     * that was there. Returns the published ETag.
     */
    async function publishPlan(
        plan: SealedPlan,
        completedParts: CompletedPart[],
        signal?: AbortSignal,
    ): Promise<string | undefined> {
        const { key, uploadId } = plan.info;
        const { destination } = plan.completing;
        if (publishCas) await requirePublishCas();
        const condition: PublishCondition = destination === null ? { IfNoneMatch: "*" } : { IfMatch: destination };
        // Restating the per-part checksums in the part list makes the backend
        // validate the assembled sequence at completion; there is no
        // whole-object digest to assert (composite-only, see the options doc).
        const { ETag } = await classified(key, () =>
            client.send(
                new CompleteMultipartUploadCommand({
                    Bucket: bucket,
                    Key: key,
                    UploadId: uploadId,
                    MultipartUpload: { Parts: completedParts },
                    ...(publishCas && condition),
                }),
                { abortSignal: signal },
            ),
        );
        return ETag;
    }

    return {
        // ── Capability flags ──
        /** Byte-exact appends are impossible under the part-size floor; the engine buffers to it. */
        appendGranularity: minPartSize,
        uniformPartSize: false,
        /**
         * Offset derives from ListParts + the tail sidecar's HEAD on every read,
         * both backend facts. A parked tail leaves the slot only after its bytes
         * are durable in a part or a replacing tail, so the derived offset never
         * falls below an acknowledged one. The one exception is an unstamped
         * tail written by a 4.x store, removed before its part is sent.
         */
        exactOffsetRecovery: true,
        /** CompleteMultipartUpload publishes all-or-nothing. */
        atomicCompletion: true,
        /** Every append verifies the claimed offset against durable state before writing. */
        enforcesOffsetCheck: true,
        // Never "sha256": multipart SHA-256 checksums are composite (hash of
        // per-part hashes), so a whole-representation digest is unverifiable
        // server-side regardless of the checksums option.
        digestOnComplete: false,
        uploadPrefix: prefix,
        // maxAppendSize is deliberately absent: parts stream out as they fill, so
        // one append is never bounded by the backend's single-part size ceiling.

        async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
            const { key, length, metadata, now, expiresAt, signal } = createOpts;
            assertPublishable(key);
            if (length !== undefined && length > S3_MAX_MULTIPART_PARTS * S3_MAX_PART_SIZE) {
                throw new RangeError(PART_LIMIT_MESSAGE);
            }
            // The object this upload publishes carries the id, which is how a
            // recovery tells it from any other object at the key.
            const publicationId = newUploadId();
            const created = await classified(key, () =>
                client.send(
                    new CreateMultipartUploadCommand({
                        Bucket: bucket,
                        Key: key,
                        Metadata: { [PUBLICATION_METADATA_KEY]: publicationId },
                        ...(checksums
                            ? { ChecksumAlgorithm: "SHA256" as const, ChecksumType: "COMPOSITE" as const }
                            : {}),
                    }),
                    { abortSignal: signal },
                ),
            );
            if (created.UploadId === undefined) {
                throw new Error(`CreateMultipartUpload returned no UploadId`);
            }
            const uploadToken = newUploadId();
            try {
                await writeInfo(
                    uploadToken,
                    {
                        key,
                        uploadId: created.UploadId,
                        publicationId,
                        length,
                        metadata,
                        createdAt: now,
                        ...(expiresAt !== undefined && { expiresAt }),
                        partSize: sizePart(minPartSize, length ?? 0, S3_MAX_MULTIPART_PARTS),
                    },
                    signal,
                    { IfNoneMatch: "*" },
                );
            } catch (err) {
                // Without its metadata sidecar the resource is unreachable; reap the
                // multipart upload instead of leaking it until a lifecycle rule fires.
                // Best-effort: the sidecar failure is the story, and the sweep's
                // multipart pass reclaims an upload this abort could not reach.
                await abortMultipart(key, created.UploadId).catch(() => undefined);
                throw err;
            }
            return { uploadToken };
        },

        async getUploadState(uploadToken: string, stateOpts?: UploadStateReadOptions): Promise<StoredUploadState> {
            const signal = stateOpts?.signal;

            const entry = await readUploadInfo(uploadToken, signal);
            if (entry === undefined) throw new UploadNotFoundError(uploadToken);
            const { record: info } = entry;
            const { key } = info;
            // A caller reaches this entry point holding a token and nothing else:
            // learning the destination key is what the call is FOR. The reads below
            // are addressed by that key, so a backend failure names it, and a caller
            // whose read failed is then handed an identifier it has no way to match
            // against anything it holds, or to redact -- and a destination key
            // commonly embeds a filename. The upload's own sidecar names the same
            // resource in a spelling derived from the token, so that is what a
            // failure here reports; a read that succeeds still returns the key.
            try {
                // A caller holding no lock asks for no repair: the read then
                // derives the state and never writes the sidecar.
                const parts = await partsOrPublished(uploadToken, info, { signal, repair: stateOpts?.repair });
                // A live upload counts its parts and the tail parked after them;
                // a published one is exactly the object it published.
                const live = Array.isArray(parts);
                // Sent after the listing, so a part committed in between shows
                // as a tail stamped past it, which still counts where it ends.
                // An append that follows under the fence prepends the tail, so
                // its bytes are read now (GET) and the append writes against
                // this read; any other read needs only the size and the stamp.
                let tail: { size: number; stamp?: string; lastModified?: number } | undefined;
                let snapshot: UploadStateSnapshot | undefined;
                if (live && sidecarCas && stateOpts?.forAppend === true) {
                    const read = await readTail(uploadToken, signal);
                    tail = read && { size: read.bytes.length, stamp: read.stamp, lastModified: read.lastModified };
                    snapshot = Object.freeze({});
                    snapshots.set(snapshot, { token: uploadToken, entry, parts, tail: read });
                } else if (live) {
                    const head = await headOrAbsent(partKey(uploadToken), signal);
                    tail = head && {
                        size: headLength(head),
                        stamp: head.Metadata?.[TAIL_OFFSET_METADATA_KEY],
                        lastModified: head.LastModified?.getTime(),
                    };
                }
                return {
                    key,
                    offset: tailEnd(parts.size, tail?.size, tail?.stamp),
                    length: info.length ?? (live ? undefined : parts.size),
                    status: !live ? "complete" : info.invalidated === true ? "invalidated" : "incomplete",
                    createdAt: info.createdAt,
                    expiresAt: info.expiresAt,
                    // Read off what the appends wrote, the newest part and the
                    // tail; the sidecar records state changes, not appends.
                    lastAppendAt: Math.max(live ? parts.last : 0, tail?.lastModified ?? 0) || undefined,
                    metadata: info.metadata,
                    ...(snapshot && { snapshot }),
                };
            } catch (err) {
                throw redactErrorText(err, [key], infoKey(uploadToken));
            }
        },

        async appendChunk(
            uploadToken: string,
            offset: number,
            body: ReadableStream<Uint8Array> | Uint8Array,
            appendOpts: AppendChunkOptions,
        ): Promise<AppendChunkResult> {
            try {
                const { maxBytes, maxBytesFatal, length: declaredLength, signal } = appendOpts;
                // A yield asked for before the call arrived is an interruption with
                // nothing durable, reported rather than raised: a caller must never have
                // to read an exception to tell a yield from a failure.
                if (signal?.aborted === true) {
                    await releaseUploadBody(body, appendOpts);
                    return { bytesWritten: 0, interrupted: true };
                }

                // The state read this append was judged on, when it was made for
                // it: written against instead of read again, because the park
                // that ends the append is pinned to the tail it saw.
                const held = takeSnapshot(appendOpts.snapshot, uploadToken);
                const entry = held?.entry ?? (await readUploadInfo(uploadToken, signal));
                if (entry === undefined) throw new UploadNotFoundError(uploadToken);
                const { record: info } = entry;
                const { key, uploadId } = info;
                if (info.invalidated === true) {
                    // Defense in depth: the orchestrator's fresh state read already refused.
                    throw new Error(INVALIDATED_MESSAGE);
                }
                // A sealed upload takes no byte: completion is publishing what
                // was durable at the seal. The fence below catches a seal that
                // lands while this append writes.
                refuseSealed(uploadToken, info);

                // The tail's bytes are needed for prepending, so GET (not HEAD) is the
                // state read here, sent beside the listing and judged against it
                // once both answer; its exact length feeds the offset verification.
                const [parts, read] = held
                    ? [held.parts, held.tail]
                    : await Promise.all([
                          listCommittedParts(key, uploadId, signal).catch(goneAsNotFound(uploadToken)),
                          readTail(uploadToken, signal),
                      ]);
                const committed = parts.size;
                const [tail, durableOffset] = countedTail(uploadToken, read, committed);
                const tailSize = durableOffset - committed;
                if (offset !== durableOffset) {
                    throw new UploadOffsetConflictError(uploadToken, durableOffset);
                }

                // The tail is never removed before its bytes are durable elsewhere,
                // since the offset it counts toward was acknowledged and must not
                // decrease. A stamped tail stays in place while the body streams: the
                // first flushed part carries all of it (a tail is shorter than a
                // part), and once that part commits the stamp no longer matches the
                // committed sum, so the tail stops counting at the same instant its
                // bytes start counting in the part. Without a flush it is replaced by
                // one conditional write. An unstamped tail would count again beside
                // that part, so it alone is deleted first, and the park then pins
                // to absence. Whatever else the slot holds is what a park replaces.
                let replaces = read;
                if (tail !== undefined && tail.stamp === undefined) {
                    await deleteObjectIdempotent(partKey(uploadToken));
                    replaces = undefined;
                }

                const length = info.length ?? declaredLength;
                let nextPartNumber = parts.next;
                const partsLeft = S3_MAX_MULTIPART_PARTS + 1 - nextPartNumber;
                // Cut at the size the record fixed, never this process's own
                // minimum. A record from before it was persisted falls back to the
                // configured minimum, grown to fit a known length into the parts
                // left. A tail lifted into the first part always fits inside it
                // (the stamp rule needs its bytes in exactly one part), so the size
                // is never below it; only a tail parked under a larger size can
                // raise it. The final part may be short.
                const partSize = Math.max(
                    tailSize,
                    sizePart(info.partSize ?? minPartSize, (length ?? 0) - committed, partsLeft),
                );
                // Deferred-length declaration: the first append to carry a length
                // records it in the `.info` sidecar, before any byte of the body, so
                // the next getUploadState reports it and it turns immutable, together
                // with the part size it needs. This is the one append that writes the
                // sidecar, pinned to the version this call already read. Only ever
                // set once (the orchestrator guarantees it, and mergeInfo keeps a
                // recorded length over the patch's).
                if (info.length === undefined && length !== undefined) {
                    await mergeInfo(
                        uploadToken,
                        (fresh) => refuseSealed(uploadToken, fresh, { length, partSize }),
                        signal,
                        entry,
                    );
                }

                const queue = new ByteQueue();
                if (tail !== undefined) queue.push(tail.bytes);
                // Bytes this append can take before it would need a part past the ceiling.
                const room = partsLeft * partSize - tailSize;
                let flushed = 0;
                let received = 0;
                let ceilingHit = false;

                // Part N covers exactly the bytes [(N - 1) * P, N * P) for the
                // record's part size P, because every part but the last is cut at P
                // from the committed boundary. That is what makes an UploadPart
                // from a holder whose lock was stolen harmless: it replaces part N
                // with the same range from the same client. It holds across
                // processes only because P is read from the record; a deferred
                // declaration that has to grow P re-bases it at the boundary it
                // declared at. A part landing after the upload was reaped is the
                // upload not found, not a backend fault.
                const flushPart = async (bytes: Uint8Array): Promise<void> => {
                    await uploadPart(key, uploadId, nextPartNumber, bytes).catch(goneAsNotFound(uploadToken));
                    nextPartNumber += 1;
                    flushed += bytes.length;
                };

                // Reading the body and flushing to the backend get SEPARATE failure
                // handling, because they are separate failures wearing one shape. A body
                // that dies mid-request is the client vanishing: the accepted prefix is
                // the truthful answer and the next probe agrees with it, exactly as the
                // other adapters already treat it. A flush that dies is the backend, and
                // that must surface. One try around both reported a client disconnect as
                // a storage fault, which is a 502 for something the storage never saw.
                const { iterator, finalize } = openUploadBody(body);
                let interrupted = false;
                try {
                    for (;;) {
                        let next: IteratorResult<Uint8Array>;
                        try {
                            next = await iterator.next();
                        } catch {
                            // Torn body: keep the prefix and account it truthfully.
                            interrupted = true;
                            break;
                        }
                        if (next.done) break;
                        const chunk = next.value;
                        received += chunk.length;
                        if (maxBytes !== undefined && received > maxBytes) {
                            if (!maxBytesFatal) {
                                // This request's ceiling, not the representation's. Stop reading
                                // and fall through to the normal durable-flush tail below, so
                                // the accepted prefix lands and the resource stays healthy; the
                                // ceiling is reported after those bytes are safe.
                                ceilingHit = true;
                                break;
                            }
                            // Durably mark the terminal fault before surfacing it, so every
                            // later state read refuses, even from a process that never saw
                            // this request. No over-bound byte lands: the crossing chunk is
                            // dropped, never written.
                            // A seal that landed meanwhile refuses it instead: a
                            // completion's plan is not this append's to end.
                            await mergeInfo(
                                uploadToken,
                                (fresh) => refuseSealed(uploadToken, fresh, { invalidated: true }),
                                undefined,
                                entry,
                            );
                            await finalize();
                            throw new UploadOverrunError(uploadToken, maxBytes);
                        }
                        // The store's own ceiling, reported like the request's.
                        if (received > room) {
                            ceilingHit = true;
                            break;
                        }
                        queue.push(chunk);
                        // Drained fully before the signal is consulted, deliberately. One
                        // chunk can be several parts, and stopping mid-drain would not make
                        // fewer bytes durable: the remainder is parked in the tail sidecar
                        // below, which advances the derived offset by exactly as much. What
                        // bounds a stalled holder is the chunk boundary, where it stops
                        // pulling from the body; the shape those already-accepted bytes take
                        // on the backend is not what the bound is about.
                        while (queue.size >= partSize) {
                            await flushPart(queue.take(partSize));
                        }
                        if (signal?.aborted) {
                            interrupted = true;
                            break;
                        }
                    }
                } catch (err) {
                    await finalize();
                    throw err;
                }
                await finalize();
                if (signal?.aborted || ceilingHit) await releaseUploadBody(body, appendOpts);

                // Park the sub-minimum remainder (append tail OR abort leftover) in
                // the sidecar so every received byte is durable and counted by the
                // next offset derivation. A remainder that is exactly the still-parked
                // tail (no byte arrived) is left untouched. Under the fence an append
                // that committed a part parks even with nothing left over (an empty
                // tail at the new offset), so the slot's version moves with every
                // append that moves the offset, and a stale holder's park, pinned to
                // the slot it read, is refused whatever the winner wrote.
                if ((queue.size > 0 && (received > 0 || replaces !== tail)) || (sidecarCas && flushed > 0)) {
                    const remainder = queue.takeAll();
                    // `flushed` is every byte this call committed as parts, the lifted
                    // tail included, so the remainder starts right after them. No
                    // sidecar write follows: a park into an upload the sweep reaped
                    // while this body streamed lands as an orphan tail, which the
                    // sweep's own pass reclaims, and the next request answers 404.
                    await parkTail(uploadToken, info, committed + flushed, remainder, replaces);
                    flushed += remainder.length;
                }

                // The fence. Every byte this call wrote is durable now, so a
                // completion that seals after this read snapshots them, and one
                // that sealed before it is publishing a plan they are not in:
                // the append is then refused, never acknowledged. Read without
                // the signal, like the writes, so a yield still reports.
                if (flushed > 0) {
                    const fresh = await readUploadInfo(uploadToken);
                    if (fresh === undefined) throw new UploadNotFoundError(uploadToken);
                    refuseSealed(uploadToken, fresh.record);
                }

                // The prepended tail was durable before this call; only the incoming
                // prefix that actually flushed counts.
                const bytesWritten = Math.max(0, flushed - tailSize);
                // Reported only now: the accepted prefix is durable and the resource is
                // untouched, so the client resumes from here in smaller chunks.
                if (ceilingHit) throw new UploadAppendBoundError(uploadToken, durableOffset + bytesWritten);
                return { bytesWritten, interrupted };
            } catch (err) {
                // Every refusal, the ones before any byte was read included,
                // releases a streaming body rather than leaving it open.
                await releaseUploadBody(body, appendOpts);
                throw err;
            }
        },

        /**
         * The sealed plan of {@link ResumableWriteStore.completeUpload}:
         *
         * 1. SEAL the record at `expectedLength`, with the key's ETag (or its
         *    emptiness) as the destination the publish is allowed over. A seal
         *    already there is resumed with the destination it recorded.
         * 2. FENCE: from the seal on, every append is refused (see appendChunk).
         * 3. SNAPSHOT the parts and the tail, after the seal. A plan of another
         *    length is refused, and a seal no snapshot can satisfy is lifted so
         *    the upload stays resumable; a seal at a length the plan does hold
         *    is another completer's and stays. A seal at another length that
         *    this snapshot proves dead is re-pointed at `expectedLength` in one
         *    write, so appends stay fenced throughout.
         * 4. PUBLISH under the destination precondition (`publishCas`). A
         *    refused or vanished commit is recovered by identity: this upload's
         *    publication is adopted, anything else at the key is a destination
         *    conflict.
         * 5. RECORD completion. A failure here leaves the seal, and the next
         *    completion or repairing state read adopts the object by identity.
         */
        async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
            const { expectedDigests, expectedLength, signal } = completeOpts;

            if (expectedDigests !== undefined) {
                // The orchestrator gates digest assertions on `digestOnComplete`
                // (always false here: multipart SHA-256 is composite-only, so no S3
                // backend can verify a whole-representation digest at completion).
                // Reaching this is a caller bug, and silently skipping verification
                // would launder an unverified digest.
                throw new Error("s3UploadStore: digestOnComplete is false");
            }

            const entry = await readUploadInfo(uploadToken, signal);
            if (entry === undefined) throw new UploadNotFoundError(uploadToken);
            if (entry.record.invalidated === true && entry.record.completed !== true) {
                throw new Error(INVALIDATED_MESSAGE);
            }

            /**
             * The object this upload published, found where a commit was
             * refused or the multipart upload is gone. The tail is reaped
             * with the record promoted, not reaped: a late probe still needs
             * the record to answer, and the sweep reaps it once idle.
             */
            const recover = async (
                record: UploadInfoRecord,
                cause?: unknown,
                refused = false,
            ): Promise<CompletedUpload> => {
                const published = await adopt(uploadToken, record, { signal }, cause, refused);
                if (record.completed !== true) await deleteObjectIdempotent(partKey(uploadToken), signal);
                return { etag: published.etag };
            };

            // An idempotent retry of a recorded completion answers the object it published.
            if (entry.record.completed === true) return recover(entry.record);

            const sealed = await seal(uploadToken, entry, expectedLength, signal);
            if (sealed.completed === true) return recover(sealed);

            let plan: SealedPlan;
            try {
                plan = await snapshotPlan(uploadToken, sealed, expectedLength, signal);
            } catch (err) {
                // A commit of this plan that landed without being recorded, or
                // a multipart upload an external actor aborted.
                if (!isMultipartGoneError(err)) throw err;
                return recover(sealed, err);
            }
            const completedParts = await assembleParts(uploadToken, plan);

            let etag: string | undefined;
            try {
                etag = await publishPlan(plan, completedParts, signal);
            } catch (err) {
                // Refused: the key is not in the state the seal recorded, which
                // an earlier attempt of this same plan also causes once it
                // published. Gone: such an attempt completed the upload. Either
                // way only this upload's publication is adopted.
                const refused = publishCas && isConditionalWriteRefused(err);
                if (refused || isMultipartGoneError(err)) return recover(plan.info, err, refused);
                throw err;
            }

            // Marked, not deleted: the sidecar is the only record of where this
            // upload published, and a retried completion or a late probe needs it
            // to answer. The sweep reaps it once idle. Failing to mark is not a
            // failed completion, since the object is already visible, and the
            // seal with the publication id still attributes it.
            await mergeInfo(uploadToken, { completed: true, publishedEtag: etag }, signal).catch(() => undefined);

            return { etag };
        },

        abortUpload,

        /**
         * Abort upload resources either sweep cutoff condemns. An upload's last
         * activity is the newest of its sidecar's and its tail's LastModified,
         * which one listing answers for the whole prefix, and its newest part,
         * which a ListParts answers only for an upload the listing already finds
         * idle: an append writes a part or a tail, never the sidecar. Creation
         * time lives inside the sidecar, so a lifetime cutoff costs one GET.
         *
         * A `.part` tail whose sidecar is already gone is reclaimed on its own
         * terms in the same pass. Nothing else can reach it: every other path to
         * a tail starts from the sidecar that names it.
         *
         * A multipart upload no sidecar names (a creation that failed before
         * its sidecar landed) is reached only by listing the multipart uploads
         * themselves, which this sweep does under `multipartSweepPrefix` when
         * that option is set.
         *
         * S3's native alternative: a lifecycle rule with
         * `AbortIncompleteMultipartUpload` reaps the multipart uploads
         * themselves without this sweep, sidecar or not, but knows nothing
         * about the `.info`/`.part` bookkeeping sidecars. Pair such a rule
         * with an expiration rule on the `uploadPrefix` keys, or keep running
         * this sweep, so the sidecars do not accumulate.
         *
         * One unreclaimable resource must not end the scan. An AccessDenied on a
         * single key, a throttled abort, a sidecar that stops being readable: any
         * of those propagated would abandon every resource behind it in the
         * listing, so a scheduled sweep could reclaim nothing while reporting
         * success by not throwing. Each resource is therefore isolated and
         * counted in `failed`, which is what a caller alerts on. The listing
         * itself is not isolated: a page that cannot be read leaves no resources
         * to attribute a failure to.
         */
        async sweepExpired(
            cutoff: UploadSweepCutoff,
            sweepOpts?: { signal?: AbortSignal },
        ): Promise<{ removed: number; failed: number }> {
            const signal = sweepOpts?.signal;
            requireSweepCutoff(cutoff);
            // Each upload's bookkeeping by token: the last writes of its sidecar
            // and of its tail, both carried by the listing at no extra cost.
            const listed = new Map<string, { info?: number; part?: number }>();
            for await (const { Key, LastModified } of listBookkeeping(signal)) {
                const kind = Key?.slice(-5);
                const token = Key?.slice(prefix.length, -5);
                // A foreign object is not ours to reap.
                if (!LastModified || !token || !UPLOAD_ID_RE.test(token) || (kind !== ".info" && kind !== ".part")) {
                    continue;
                }
                listed.set(token, {
                    ...listed.get(token),
                    [kind === ".info" ? "info" : "part"]: LastModified.getTime(),
                });
            }
            const swept = await sweepEach(
                listed,
                async ([token, { info, part = 0 }]) => {
                    if (info === undefined) {
                        // A tail is normally reached through its sidecar. One left
                        // with no sidecar is reached by nothing, so it is judged on
                        // its OWN last write, which bounds its idleness and, being
                        // later than creation, its lifetime too. Removed only once
                        // no sidecar answers for it, so a live upload's tail is safe.
                        if (!isSweepable(cutoff, part) || (await readDiscardTarget(token, signal)) !== undefined)
                            return false;
                        await deleteObjectIdempotent(partKey(token), signal);
                        return true;
                    }
                    // No append writes the sidecar, so an upload's last activity is
                    // the latest of its sidecar, its tail and its newest part. The
                    // listing bounds it from below for free; the parts are listed
                    // only for an upload the listing already finds idle, and the
                    // record (creation time lives INSIDE it) is read only for one
                    // a cutoff can still condemn.
                    let newest = Math.max(info, part);
                    const idle = cutoff.idleSinceMs !== undefined && newest < cutoff.idleSinceMs;
                    if (!idle && cutoff.createdBeforeMs === undefined) return false;
                    const target = await readDiscardTarget(token, signal);
                    if (target === undefined) return false;
                    if (idle && target.key !== undefined && target.uploadId !== undefined) {
                        newest = Math.max(
                            newest,
                            await listCommittedParts(target.key, target.uploadId, signal).then(
                                (parts) => parts.last,
                                (err: unknown) => {
                                    if (isMultipartGoneError(err)) return 0;
                                    throw err;
                                },
                            ),
                        );
                    }
                    // A corrupt record carries no creation time: judged on idleness.
                    if (!isSweepable(cutoff, target.createdAt ?? Infinity, newest)) return false;
                    await abortUpload(token, sweepOpts);
                    return true;
                },
                sweepOpts,
            );
            if (multipartSweepPrefix !== undefined) {
                // A multipart upload no sidecar names has no activity record, so
                // its Initiated time stands in for both clocks. Judged only after
                // the sidecar pass, so the uploads it just reaped are already gone.
                // Which uploads the sidecars name is read once, on the first
                // candidate; a failure to read it fails every candidate, since
                // none can be proven unclaimed.
                let named: Promise<Set<string>> | undefined;
                const orphans = await sweepEach(
                    listMultipartUploads(multipartSweepPrefix, signal),
                    async ({ Key, UploadId, Initiated }) => {
                        if (!Key || !UploadId || !Initiated || !isSweepable(cutoff, Initiated.getTime())) return false;
                        if ((await (named ??= namedUploadIds(signal))).has(UploadId)) return false;
                        await abortMultipart(Key, UploadId, signal);
                        return true;
                    },
                    sweepOpts,
                );
                swept.removed += orphans.removed;
                swept.failed += orphans.failed;
            }
            return swept;
        },
    };
}

// ─── Upload Internal Helpers ────────────────────────────────────────────────

/** A sidecar record with the version the backend stamped on it. */
interface InfoEntry {
    record: UploadInfoRecord;
    etag?: string;
}

/**
 * A tail that counts at the committed sum it was read against: its bytes,
 * the version a replacement is pinned to, and whether it carries an offset
 * stamp. Only a stamped tail stops counting once a part passes its offset;
 * an unstamped one counts wherever it is found.
 */
interface ParkedTail {
    bytes: Uint8Array;
    etag?: string | undefined;
    stamp?: string | undefined;
    /** The tail's LastModified, epoch ms: the newest append when it parked last. */
    lastModified?: number | undefined;
}

/**
 * A state read handed to the append that follows it under the same lock: the
 * sidecar entry, the committed parts and the raw tail (bytes included), all
 * read for that append. The append's final write is the tail park, pinned to
 * this tail's ETag (or to absence), so a snapshot gone stale fails there.
 */
interface S3StateSnapshot {
    token: string;
    entry: InfoEntry;
    parts: CommittedParts;
    tail: ParkedTail | undefined;
}

/**
 * The precondition a sidecar write carries: the version it was computed from
 * (`If-Match`) for a merge, or absence (`If-None-Match: *`) for creation.
 */
type SidecarWriteCondition = { IfMatch: string } | { IfNoneMatch: "*" };

/**
 * The precondition a publish carries: the ETag the key held at the seal
 * (`If-Match`), or that it was empty (`If-None-Match: *`).
 */
type PublishCondition = SidecarWriteCondition;

/** Creation-time facts persisted in the `.info` metadata sidecar. */
interface UploadInfoRecord {
    /** Held here rather than in the token: a request carries only the id. */
    key: string;
    uploadId: string;
    length?: number;
    /**
     * The size every part but the last is cut at, fixed at creation (sized
     * so a declared length fits the part limit) and grown only by a deferred
     * length declaration that would not fit otherwise. Absent on a record
     * written before it was persisted.
     */
    partSize?: number;
    metadata?: Record<string, string>;
    createdAt: number;
    /** {@link StoredUploadState.expiresAt}; absent on a record created without one. */
    expiresAt?: number;
    invalidated?: boolean;
    /**
     * The random id this upload's published object carries in its user
     * metadata ({@link PUBLICATION_METADATA_KEY}), set on the multipart upload
     * at creation because S3 applies object metadata only there. An object at
     * the key is this upload's publication exactly when it carries this id.
     * Absent on a record written before it was minted: such an upload still
     * publishes, but a lost completion record can then never be recovered by
     * identity and fails closed as a destination conflict.
     */
    publicationId?: string;
    /**
     * The seal: completion is in progress at `length`, and publishes only over
     * `destination`, the ETag the key held when the seal was written (`null`:
     * the key was empty). From the seal on, appends are refused. Kept on the
     * completed record, since the fence reads it there too.
     */
    completing?: { length: number; destination: string | null };
    /**
     * Written by a build that predates the seal, before its commit: the
     * assembled size and part count. Read only to fail closed, since a shape
     * proves nothing about whose object sits at the key; never written.
     */
    publishing?: { size: number; parts: number };
    /**
     * Set once the object has published. The sidecar outlives completion so a
     * retried completion or a late probe still has a record proving this token
     * named this key; the sweep reaps it like any other idle bookkeeping.
     */
    completed?: boolean;
    /** The ETag the commit returned: the object is this upload's while it holds it. */
    publishedEtag?: string;
}

/** The fields a sidecar merge may patch: everything but the creation facts. */
type InfoPatch = Partial<
    Pick<UploadInfoRecord, "length" | "partSize" | "invalidated" | "completed" | "completing" | "publishedEtag">
>;

/**
 * The user-metadata key a parked tail carries, holding the offset its bytes
 * were accepted at (the committed part sum at the time of the park).
 */
const TAIL_OFFSET_METADATA_KEY = "tail-offset";

/**
 * The user-metadata key the multipart upload, and so the object it
 * publishes, carries: the upload's {@link UploadInfoRecord.publicationId}.
 */
const PUBLICATION_METADATA_KEY = "upload-publication";

/**
 * The committed parts in listing order, in the shape a completion sends them,
 * with their byte total, the next part number, and when the newest landed
 * (epoch ms, 0 with none).
 */
type CommittedParts = CompletedPart[] & { size: number; next: number; last: number };

/** A sealed record's snapshot, proven to publish exactly the length its seal holds. */
interface SealedPlan {
    info: UploadInfoRecord;
    completing: NonNullable<UploadInfoRecord["completing"]>;
    parts: CommittedParts;
    tail: ParkedTail | undefined;
}

/**
 * Upload operations reuse the shared classification pipeline for throttles
 * only: what "not found" MEANS differs per call (a missing sidecar, a gone
 * multipart upload, a published object), so each callsite interprets the raw
 * not-found error itself instead of receiving a read-side ObjectNotFoundError.
 */
const uploadOpClassifiers: StoreErrorClassifiers = {
    notFound: () => false,
    throttled: isThrottledError,
};

/**
 * The multipart upload backing a resource no longer exists (completed,
 * aborted, or lifecycle-reaped). AWS raises NoSuchUpload here, but several
 * S3-compatible backends raise NoSuchKey for the same condition, and some
 * SDK versions surface only the wire code as the error name, so the match
 * is name-based on top of the class checks.
 */
function isMultipartGoneError(err: unknown): boolean {
    return err instanceof NoSuchUpload || isNotFoundError(err) || s3ErrorIs(err, 404, "NoSuchUpload");
}

/** A rejection handler reporting a gone multipart upload as the upload not found. */
const goneAsNotFound =
    (token: string) =>
    (err: unknown): never => {
        throw isMultipartGoneError(err) ? new UploadNotFoundError(token, err) : err;
    };

/**
 * The `.info` sidecar exists and does not decode to a record. Distinct from a
 * failed read: the backend answered, so retrying changes nothing, and what
 * the object did hold is kept so a discard can still find the multipart
 * upload it names.
 */
class CorruptSidecarError extends Error {
    /** The destination the sidecar still names, when it names one. */
    readonly key?: string;
    /** The multipart upload the sidecar still names, when it names one. */
    readonly uploadId?: string;
    constructor(detail: string, record: unknown, cause?: unknown) {
        super(`Upload metadata sidecar ${detail}`, { cause });
        const { key, uploadId } = (record ?? {}) as { key?: unknown; uploadId?: unknown };
        if (isFilledString(key)) this.key = key;
        if (isFilledString(uploadId)) this.uploadId = uploadId;
    }
}

/**
 * Parse + sanity-gate the metadata sidecar. Malformed contents are adapter
 * state corruption: fail loudly rather than fabricate protocol answers. A
 * protocol read answers it with {@link corruptUploadState} (see
 * `readUploadInfo`), so nothing read from the record reaches a client or an
 * error sink: a parse error's text quotes the record, object key included.
 */
function parseInfoRecord(text: string): UploadInfoRecord {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new CorruptSidecarError("holds unparseable JSON", undefined, err);
    }
    const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const malformed = Object.keys(INFO_RECORD_SHAPE).find(
        (field) => !INFO_RECORD_SHAPE[field as keyof UploadInfoRecord](record[field]),
    );
    if (malformed !== undefined) throw new CorruptSidecarError(`holds a malformed ${malformed}`, parsed);
    return record as unknown as UploadInfoRecord;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isFilledString = (value: unknown): value is string => typeof value === "string" && value !== "";
const absentOr =
    (ok: (value: unknown) => boolean) =>
    (value: unknown): boolean =>
        value === undefined || ok(value);

/**
 * The persisted shape of every sidecar field. The key and upload id are the
 * only source of the destination: a record without them cannot address the
 * backend, and guessing would defeat the point of keeping them off the token.
 * Every field but those and createdAt is optional, but a present value that
 * does not match its persisted shape is corruption, not a stand-in for
 * "absent": a bad length flows straight into mergeInfo's read-modify-write
 * and gets laundered back to storage as though it were honest byte
 * accounting.
 */
const INFO_RECORD_SHAPE: Record<keyof UploadInfoRecord, (value: unknown) => boolean> = {
    createdAt: Number.isFinite,
    expiresAt: absentOr(Number.isFinite),
    key: isFilledString,
    uploadId: isFilledString,
    length: absentOr(isCount),
    partSize: absentOr((value) => isCount(value) && value > 0),
    invalidated: absentOr((value) => typeof value === "boolean"),
    completed: absentOr((value) => typeof value === "boolean"),
    publishedEtag: absentOr((value) => typeof value === "string"),
    publicationId: absentOr(isFilledString),
    completing: absentOr(
        (value) =>
            isObject(value) &&
            isCount(value.length) &&
            (value.destination === null || isFilledString(value.destination)),
    ),
    publishing: absentOr((value) => isObject(value) && isCount(value.size) && isCount(value.parts)),
    metadata: absentOr(
        (value) => isObject(value) && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string"),
    ),
};

/**
 * FIFO byte accumulator for part cutting. `take` copies exactly `count`
 * bytes off the front; residual chunks stay as subarray views until cut.
 */
class ByteQueue {
    private chunks: Uint8Array[] = [];
    size = 0;

    push(chunk: Uint8Array): void {
        if (chunk.length === 0) return;
        this.chunks.push(chunk);
        this.size += chunk.length;
    }

    /** Callers ask for at most `size` bytes: a part once `size` reaches it, or everything. */
    take(count: number): Uint8Array {
        const out = new Uint8Array(count);
        for (let filled = 0; filled < count;) {
            const head = this.chunks.shift()!;
            const cut = Math.min(head.length, count - filled);
            out.set(head.subarray(0, cut), filled);
            if (cut < head.length) this.chunks.unshift(head.subarray(cut));
            filled += cut;
        }
        this.size -= count;
        return out;
    }

    takeAll(): Uint8Array {
        return this.take(this.size);
    }
}

/**
 * Collect an SDK response body into bytes, through the one conversion the
 * read side already uses for every shape the SDK answers in (a web stream,
 * the stream mixin, a Node Readable).
 */
async function bodyToBytes(body: unknown, context: string): Promise<Uint8Array> {
    if (body == null) throw new Error(`${context}: response carried no body`);
    return body instanceof Uint8Array ? body : new Uint8Array(await new Response(toWebStream(body)).arrayBuffer());
}
