/**
 * How the Cloud Storage client reports the outcomes the GCS stores branch on:
 * the HTTP status it surfaces on `err.code`.
 *
 * @packageDocumentation
 */

import { readPath } from "./object-store.ts";

/** The HTTP status the Cloud Storage client surfaces on `err.code`, if any. */
export function gcsCode(err: unknown): unknown {
    return readPath(err, "code");
}

export function isGcsNotFound(err: unknown): boolean {
    return gcsCode(err) === 404;
}

/**
 * A pinned read refused by the backend: the object's generation was not the
 * one the request named (`ifGenerationMatch`), which the client library
 * surfaces as HTTP 412 on `err.code`.
 */
export function isGcsPreconditionFailed(err: unknown): boolean {
    return gcsCode(err) === 412;
}
