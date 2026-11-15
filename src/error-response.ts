/**
 * The headers every error and denial response carries, shared by the Fetch
 * handler and the Node adapter so the two cannot drift.
 *
 * @packageDocumentation
 */

/**
 * Error-hygiene headers: nothing in an error body is rendered, sniffed or
 * cached. A 404 is heuristically cacheable (RFC 9111 Section 4.2.2), so
 * without `no-store` a CDN can keep serving a transient miss after the
 * object appears.
 */
export const DENY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
} as const;

const UTF8_ENCODER = new TextEncoder();

/**
 * A plain-text error body as UTF-8 bytes and the headers that describe it.
 * `Content-Length` is the byte count, not the string's length, which counts
 * UTF-16 code units.
 */
export function plainTextErrorParts(body: string): { bytes: Uint8Array<ArrayBuffer>; headers: Record<string, string> } {
    const bytes = UTF8_ENCODER.encode(body);
    return {
        bytes,
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": String(bytes.byteLength),
            "Accept-Ranges": "none",
            ...DENY_HEADERS,
        },
    };
}
