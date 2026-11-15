/**
 * Cloudflare R2 native ObjectStore adapter for partial-content.
 *
 * Uses Cloudflare's native R2 bindings (`R2Bucket`) directly, without the
 * AWS SDK. This eliminates the ~50-package `@aws-sdk/client-s3` dependency
 * and its cold-start overhead in Workers.
 *
 * For S3-compatible access to R2 (e.g. from Node.js outside Workers),
 * use `partial-content/s3` instead.
 *
 * @example
 * ```typescript
 * import { r2Store } from "partial-content/r2";
 * import { serveObject } from "partial-content/hono";
 *
 * // In a Cloudflare Worker with R2 binding:
 * app.get("/files/:key", serveObject(
 *   r2Store({ bucket: env.MY_BUCKET }),
 *   { key: (c) => c.req.param("key") },
 * ));
 * ```
 *
 * @packageDocumentation
 */

import {
    guardStreamLength,
    ObjectNotFoundError,
    ObjectChangedError,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectStream,
    type ReadRange,
    reservedKeyGuard,
    representationCoding,
    type KeyPolicy,
} from "./index.ts";
import { bytesToBase64 } from "./base64.ts";
import { BUCKET_KEY_MAX_BYTES } from "./object-store.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError };

// ─── R2 Types ───────────────────────────────────────────────────────────────

/**
 * Minimal R2Bucket interface from Cloudflare Workers types.
 *
 * Declared locally to avoid a dependency on `@cloudflare/workers-types`.
 * The shapes match the runtime behavior; type-checking is the caller's
 * responsibility (their Worker project imports the full types).
 */
export interface R2Bucket {
    head(key: string): Promise<R2Object | null>;
    /**
     * With `onlyIf`, a failed precondition resolves to a body-less `R2Object`
     * (not null, not an error) -- callers must check for `body`.
     */
    get(key: string, options?: R2GetOptions): Promise<R2Object | R2ObjectBody | null>;
}

export interface R2Object {
    key: string;
    size: number;
    etag: string;
    uploaded: Date;
    checksums: R2Checksums;
    httpMetadata?: R2HttpMetadata;
}

export interface R2ObjectBody extends R2Object {
    body: ReadableStream<Uint8Array>;
    /** The span returned; the binding reports it for ranged reads only. */
    range?: R2Range;
}

export interface R2Range {
    offset: number;
    length: number;
}

export interface R2GetOptions {
    // `length` is optional in the real R2 binding: offset alone reads to the
    // end of the object (the open-ended fast-path form).
    range?: { offset: number; length?: number };
    onlyIf?: { etagMatches?: string };
}

export interface R2Checksums {
    sha256?: ArrayBuffer;
}

export interface R2HttpMetadata {
    contentType?: string;
    /** The stored `Content-Encoding`; `size` counts these encoded bytes. */
    contentEncoding?: string;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface R2StoreOptions {
    /**
     * Key prefixes this store refuses to serve, because they are where a
     * partial-content 5.x upload store sharing this location keeps its
     * in-flight bytes and the records naming their destination keys. Keys at
     * or under one answer {@link ObjectNotFoundError}. Set to `""` when no
     * upload store shares the location.
     * @default ".partial-content-uploads/"
     */
    reservedPrefix?: string | readonly string[];
    /**
     * Whether a key with an empty or dot segment is refused. The R2 binding
     * takes the key verbatim, with no URL path built from it, so every key
     * names exactly the object it spells.
     * @default "verbatim"
     */
    keys?: KeyPolicy;
    /** The R2 bucket binding from the Worker environment. */
    bucket: R2Bucket;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * The validators every read reports: the last-modified date, and the SHA-256
 * checksum as base64 for RFC 9530 Repr-Digest.
 *
 * `checksums.sha256` is R2's whole-object SHA-256 as raw bytes, so unlike the
 * S3 adapter there is no `<base64>-<partCount>` composite string form to
 * reject: a 32-byte buffer always describes the full representation. If R2
 * ever exposes a per-part checksum in this field, this digest would need the
 * same whole-object guard S3 applies.
 */
function validatorsOf(obj: R2Object): {
    lastModified: string;
    digest: string | undefined;
    contentEncoding: string | undefined;
} {
    const { sha256 } = obj.checksums;
    return {
        lastModified: obj.uploaded.toUTCString(),
        digest: sha256 ? bytesToBase64(new Uint8Array(sha256)) : undefined,
        // The binding hands back the stored bytes, so the stored coding is the
        // coding of the body.
        contentEncoding: representationCoding(obj.httpMetadata?.contentEncoding),
    };
}

/**
 * The binding's form of a range. An open range reads to the end of the
 * object: offset alone, so R2 streams the tail.
 */
function r2RangeOf(range: ReadRange): { offset: number; length?: number } {
    return range.end === undefined
        ? { offset: range.start }
        : { offset: range.start, length: range.end - range.start + 1 };
}

/** The get options for a read, or `undefined` for a plain whole-object read. */
function getOptionsOf(range: ReadRange | undefined, ifMatch: string | undefined): R2GetOptions | undefined {
    if (range === undefined && !ifMatch) return undefined;
    return {
        ...(range ? { range: r2RangeOf(range) } : {}),
        // Pin the read to the validated representation. On mismatch R2
        // returns the object WITHOUT a body (checked by the caller).
        ...(ifMatch ? { onlyIf: { etagMatches: ifMatch } } : {}),
    };
}

/**
 * The span a ranged read actually returned. Content-Range must report what R2
 * returned, not what was requested: `body.range` is R2's authoritative
 * offset/length, and if R2 clamped the range (the object changed between HEAD
 * and GET), reporting the request would corrupt the client's bytes. The
 * request is the answer only where the binding reports no range.
 */
function servedSpan(body: R2ObjectBody, range: ReadRange): { start: number; length: number } {
    return {
        start: body.range?.offset ?? range.start,
        length: body.range?.length ?? r2RangeOf(range).length ?? body.size - range.start,
    };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} backed by a Cloudflare R2 bucket.
 *
 * @example
 * ```typescript
 * import { r2Store } from "partial-content/r2";
 *
 * export default {
 *   async fetch(request, env) {
 *     const store = r2Store({ bucket: env.MY_BUCKET });
 *     const meta = await store.headObject("reports/q4.pdf");
 *     // ...
 *   },
 * };
 * ```
 */
export function r2Store(opts: R2StoreOptions): ObjectStore {
    const { bucket } = opts;
    const assertReadable = reservedKeyGuard(opts.reservedPrefix ?? ".partial-content-uploads/", {
        keys: opts.keys ?? "verbatim",
        maxKeyBytes: BUCKET_KEY_MAX_BYTES,
    });

    // No `classifyStoreRead` here (unlike s3/gcs/azure): the R2 Workers binding
    // signals its recoverable outcomes structurally, not as classifiable errors.
    // Not-found is a `null` return, a failed `onlyIf` pin is a body-less object,
    // and both are handled inline below. R2 exposes NO documented throttle/503
    // error shape on the native binding (rate limiting surfaces at the Workers
    // platform layer, before the handler runs), so there is nothing to map to
    // `StoreUnavailableError`. Inventing a classifier for an undocumented error
    // shape would be guessing, so R2 is absent from the stores that map a
    // throttle (docs/API.md, StoreUnavailableError). Use `partial-content/s3`
    // (R2's S3 endpoint) if you need SlowDown/429 -> 503 mapping.
    return {
        supportsRange: true,
        // 206 bounds/total come from the R2ObjectBody's actual size/offset: the
        // orchestrator may skip the validating HEAD for plain range requests.
        authoritativeRange: true,
        // `onlyIf.etagMatches`: a failed precondition is a body-less answer, thrown as ObjectChangedError.
        pinsReads: true,

        async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
            assertReadable(key);
            opts?.signal?.throwIfAborted();
            const obj = await bucket.head(key);
            if (!obj) throw new ObjectNotFoundError(key);

            return {
                contentLength: obj.size,
                etag: obj.etag,
                ...validatorsOf(obj),
            };
        },

        async getObject(
            key: string,
            opts?: { range?: ReadRange; signal?: AbortSignal; ifMatch?: string },
        ): Promise<ObjectStream> {
            assertReadable(key);
            const { range, ifMatch } = opts ?? {};
            opts?.signal?.throwIfAborted();

            const obj = await bucket.get(key, getOptionsOf(range, ifMatch));
            if (!obj) throw new ObjectNotFoundError(key);

            // onlyIf precondition failed: R2 resolves with metadata but no body.
            if (!("body" in obj) || !obj.body) {
                throw new ObjectChangedError(key);
            }

            const span = range && servedSpan(obj, range);
            const contentLength = span ? span.length : obj.size;

            return {
                // Guard the committed length: if R2 ever ends the body short of the
                // computed contentLength, error the stream rather than under-run it.
                body: guardStreamLength(obj.body, contentLength),
                contentLength,
                totalSize: obj.size,
                range: span && { start: span.start, end: span.start + span.length - 1 },
                etag: obj.etag,
                ...validatorsOf(obj),
            };
        },
    };
}
