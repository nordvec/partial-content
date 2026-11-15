/**
 * How Azure Blob Storage reports the outcomes the Azure stores branch on.
 * A numeric HTTP status on the error is authoritative; the `code` and message
 * fallbacks only run for status-less shapes.
 *
 * @packageDocumentation
 */

import { isErrorNamed, readPath } from "./object-store.ts";

/**
 * Azure `RestError`'s numeric HTTP status, when present. This is the
 * AUTHORITATIVE classification signal: when a numeric `statusCode` exists, the
 * classifiers key off it exactly and never fall through to message heuristics,
 * so a `503 ServerBusy` whose message text happens to contain "412" (a request
 * id or timestamp digit run) can never be misread as a 412. A present-but-
 * non-numeric status returns `undefined` so the code/message fallback still runs.
 */
export function azureStatusCode(err: unknown): number | undefined {
    const s = readPath(err, "statusCode");
    return typeof s === "number" ? s : undefined;
}

/**
 * Azure `RestError`'s stable error code (`BlobNotFound`, `ConditionNotMet`,
 * `ServerBusy`, ...). Matched exactly, so unlike a message substring it cannot
 * collide with arbitrary text in the error message.
 */
export function azureErrorCode(err: unknown): string | undefined {
    const c = readPath(err, "code");
    return typeof c === "string" ? c : undefined;
}

/** Whether `err` is a status-less `RestError` whose message names `code`: the last-resort reading. */
export function restErrorMessageNames(err: unknown, code: string): boolean {
    if (!isErrorNamed(err, "RestError")) return false;
    const message = readPath(err, "message");
    return typeof message === "string" && message.includes(code);
}

export function isAzureNotFound(err: unknown): boolean {
    const status = azureStatusCode(err);
    if (status !== undefined) return status === 404;
    if (azureErrorCode(err) === "BlobNotFound") return true;
    return restErrorMessageNames(err, "BlobNotFound");
}

/**
 * Check if an Azure error is a failed ifMatch condition (blob changed).
 * The SDK surfaces this as a RestError with statusCode 412 (ConditionNotMet).
 * A numeric status is authoritative; the `code`/message fallback only runs for
 * status-less shapes, so a throttle carrying "412" in its message text is never
 * misreported as a precondition failure.
 */
export function isAzurePreconditionFailed(err: unknown): boolean {
    const status = azureStatusCode(err);
    if (status !== undefined) return status === 412;
    if (azureErrorCode(err) === "ConditionNotMet") return true;
    return restErrorMessageNames(err, "ConditionNotMet");
}
