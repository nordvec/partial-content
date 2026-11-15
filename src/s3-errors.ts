/**
 * How S3 and S3-compatible stores report the outcomes the stores branch on.
 * Matched by name and by HTTP status, not by class alone: a second copy of the
 * SDK in the module graph makes `instanceof` silently false.
 *
 * @packageDocumentation
 */

import { NoSuchKey, NotFound } from "@aws-sdk/client-s3";
import { isErrorNamed, isInstance, readPath } from "./object-store.ts";

/** An S3 error named one of `names` (matched by name, not class), or carrying `status`. */
export function s3ErrorIs(err: unknown, status: number, ...names: string[]): boolean {
    return names.some((name) => isErrorNamed(err, name)) || readPath(err, "$metadata", "httpStatusCode") === status;
}

/**
 * Check if an S3 error indicates the object does not exist.
 *
 * Covers:
 *   - AWS SDK v3 `NoSuchKey` and `NotFound` error classes
 *   - Generic S3-compatible providers that set `$metadata.httpStatusCode: 404`
 *   - Providers that set `name: "NotFound"` or `name: "NoSuchKey"` without
 *     using the SDK error classes
 */
export function isNotFoundError(err: unknown): boolean {
    return isInstance(err, NoSuchKey) || isInstance(err, NotFound) || s3ErrorIs(err, 404, "NotFound", "NoSuchKey");
}

/**
 * Check if an S3 error is a failed IfMatch precondition (object changed).
 * The SDK surfaces this as name "PreconditionFailed" with HTTP 412.
 */
export function isPreconditionFailedError(err: unknown): boolean {
    return s3ErrorIs(err, 412, "PreconditionFailed");
}
