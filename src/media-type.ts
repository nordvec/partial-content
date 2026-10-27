/**
 * The one media-type parser: every decision made from a Content-Type (the
 * emitted header, the inline-safety and sandbox choice, charset enforcement,
 * compressibility) reads the same parse result, so no two of them can
 * disagree about what a value is.
 *
 * A value that does not match the RFC 9110 Section 8.3.1 grammar
 * (`type "/" subtype *( OWS ";" OWS parameter )`) is not interpreted at all.
 * That includes any value with a comma: a browser extracting a MIME type
 * (WHATWG Fetch) treats the comma as a list separator and takes the LAST
 * member that parses, so `image/png, text/html` would be vetted as an image
 * and rendered as a document.
 */

const TOKEN = "[-!#$%&'*+.^_`|~\\w]+";
// Bytes outside the field-value grammar are stripped before parsing, so a
// quoted-string body is any byte but the quote and the escape.
const PARAM = `[ \\t]*;[ \\t]*(${TOKEN})=(${TOKEN}|"(?:[^"\\\\]|\\\\.)*")`;
const MEDIA_TYPE = new RegExp(`^(${TOKEN}/${TOKEN})((?:${PARAM})*)$`);
const PARAMS = new RegExp(PARAM, "g");

/** Bytes outside the RFC 9110 field-value grammar (HTAB, SP, VCHAR, obs-text). */
export const NON_FIELD_VALUE_BYTES = /[^\t\x20-\x7e\x80-ÿ]/g;

/** The type served when a declared value cannot be trusted as a media type. */
const OCTET_STREAM = "application/octet-stream";

export interface MediaType {
    /** The header value to emit: the input without control bytes or surrounding whitespace. */
    readonly value: string;
    /** Lower-cased `type/subtype`, parameters dropped. */
    readonly essence: string;
    /** The `charset` parameter's value, quotes removed, or `undefined` when absent. */
    readonly charset: string | undefined;
}

/** Parse a media type, or `null` when the value is absent or off-grammar. */
export function parseMediaType(raw: string | null | undefined): MediaType | null {
    // Stripped exactly as every other metadata-derived header value is, so the
    // value parsed is the value that would reach the wire.
    const value = raw?.replace(NON_FIELD_VALUE_BYTES, "").trim();
    const match = value && !value.includes(",") ? MEDIA_TYPE.exec(value) : null;
    if (!match) return null;
    const charset = [...match[2]!.matchAll(PARAMS)].find(([, name]) => name!.toLowerCase() === "charset")?.[2];
    return { value: value!, essence: match[1]!.toLowerCase(), charset: charset?.replace(/^"|"$/g, "") };
}

/** {@link parseMediaType}, with an untrustworthy value replaced by `application/octet-stream`. */
export function resolveMediaType(raw: string | null | undefined): MediaType {
    return parseMediaType(raw) ?? { value: OCTET_STREAM, essence: OCTET_STREAM, charset: undefined };
}
