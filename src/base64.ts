/**
 * Base64 of raw bytes, the encoding RFC 9530 digest fields carry.
 *
 * @packageDocumentation
 */

/** Base64 of raw bytes, standard alphabet with padding (RFC 4648 Section 4). */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
}
