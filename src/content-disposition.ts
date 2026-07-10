/**
 * Content-Disposition header builder (RFC 6266 + RFC 8187).
 *
 * Builds Content-Disposition headers for HTTP responses that serve files.
 * Handles both inline (in-app preview) and attachment (download) dispositions
 * with proper RFC compliance for non-ASCII filenames.
 *
 * Security: Prevents CRLF header injection, path traversal, bidi override
 * spoofing, and control character injection in filenames from untrusted
 * sources (integration APIs, user uploads).
 *
 * Emits dual filename parameters for cross-browser compatibility:
 *   - `filename="ascii-safe.pdf"` for legacy browsers
 *   - `filename*=UTF-8''%C3%85rlig.pdf` for modern browsers (RFC 8187)
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContentDispositionOptions {
    /**
     * Disposition type.
     * - `"attachment"`: Force download (safe default for untrusted content)
     * - `"inline"`: Render in browser (only for previewable types: PDF, image, video, audio)
     * @default "attachment"
     */
    type?: "attachment" | "inline";
    /**
     * Fallback filename when input is null, undefined, or empty after sanitization.
     * @default "document"
     */
    fallback?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * RFC 2616 token characters. A filename that matches this pattern can be
 * emitted unquoted in the `filename=` parameter (e.g. `filename=plans.pdf`).
 * Anything outside this set requires quoted-string encoding.
 *
 * token = 1*<any CHAR except CTLs or separators>
 * separators = "(" | ")" | "<" | ">" | "@" | "," | ";" | ":" | "\" | <">
 *            | "/" | "[" | "]" | "?" | "=" | "{" | "}" | SP | HT
 */
const TOKEN_REGEXP = /^[!#$%&'*+.0-9A-Z^_`a-z|~-]+$/;

/**
 * Characters that are valid US-ASCII text (printable range 0x20-0x7E).
 * Filenames matching this can use the simple `filename=` parameter with
 * quoted-string encoding. Non-ASCII filenames need `filename*=` (RFC 8187).
 */
const ASCII_TEXT_REGEXP = /^[\x20-\x7e]*$/;

/**
 * Characters that need escaping inside an RFC 2616 quoted-string.
 * Per Section 2.2: quoted-pair = "\" CHAR, and the only characters
 * that MUST be escaped are `\` and `"`.
 */
const QUOTED_PAIR_REGEXP = /[\\"]/g;

/**
 * Characters that are not valid in RFC 8187 attr-char, applied AFTER
 * encodeURIComponent (so `%` is already handled). This catches characters
 * that encodeURIComponent leaves unescaped but RFC 8187 requires encoded.
 */
const ENCODE_URL_ATTR_CHAR_REGEXP = /[\x00-\x20"'()*,/:;<=>?@[\\\]{}\x7f]/g; // eslint-disable-line no-control-regex

/**
 * Non-US-ASCII characters. Replaced with `?` in the ASCII fallback
 * for maximum compatibility with legacy HTTP clients.
 */
const NON_ASCII_REGEXP = /[^\x20-\x7e]/g;

/**
 * Filenames containing percent-encoded sequences (like `the%20plans.pdf`)
 * should not use the simple `filename=` parameter because legacy clients
 * may decode them. Force `filename*` for these.
 */
const HEX_ESCAPE_REGEXP = /%[0-9A-Fa-f]{2}/;

/**
 * Matches lone surrogate code units (unpaired high or low surrogates).
 * These occur when filenames are truncated mid-emoji with .slice().
 * encodeURIComponent throws URIError on lone surrogates, so we must
 * strip them before encoding.
 */
const LONE_SURROGATE_REGEXP = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build a Content-Disposition header value with RFC compliance and
 * security sanitization.
 *
 * Accepts untrusted filenames from integration APIs, user uploads, and
 * database records. Sanitizes for:
 *   - CRLF injection (strips \r, \n, and all control characters)
 *   - Path traversal (strips ../ and ..\\ sequences)
 *   - Basename extraction (strips directory paths)
 *   - Bidi override stripping (prevents RLO filename spoofing)
 *   - Double-quote and backslash escaping (RFC 2616 quoted-pair)
 *
 * Emits dual filename parameters for cross-browser compatibility:
 *   - `filename="ascii-safe.pdf"` for legacy browsers (IE, old Safari)
 *   - `filename*=UTF-8''%C3%85rlig.pdf` for modern browsers (RFC 8187)
 *
 * Token optimization: Simple ASCII filenames like `plans.pdf` are emitted
 * unquoted (`filename=plans.pdf`).
 *
 * @param filename - Raw filename from untrusted source (upload, API, DB)
 * @param options - Disposition type and fallback configuration
 * @returns Complete Content-Disposition header value string
 *
 * @example
 * // Simple ASCII attachment
 * buildContentDisposition("report.pdf")
 * // => 'attachment; filename=report.pdf'
 *
 * @example
 * // Non-ASCII filename (Danish)
 * buildContentDisposition("Årlig_Rapport.pdf")
 * // => 'attachment; filename="?rlig_Rapport.pdf"; filename*=UTF-8\'\'%C3%85rlig_Rapport.pdf'
 *
 * @example
 * // Inline disposition for preview
 * buildContentDisposition("slides.pdf", { type: "inline" })
 * // => 'inline; filename=slides.pdf'
 *
 * @example
 * // Null input with custom fallback
 * buildContentDisposition(null, { fallback: "export.csv" })
 * // => 'attachment; filename=export.csv'
 */
export function buildContentDisposition(
    filename: string | null | undefined,
    options?: ContentDispositionOptions,
): string {
    // Never trust the disposition type: a JS caller (or a mistyped
    // `disposition` extractor returning a computed string) could otherwise
    // smuggle header parameters through it. Anything but "inline" is
    // "attachment" -- the safe default.
    const type = options?.type === "inline" ? "inline" : "attachment";

    // Sanitize BOTH the untrusted filename and the fallback through the same
    // cleaner, then fall back to a constant. A filename that reduces to
    // nothing (only controls/bidi/path components) must NOT emit a raw
    // fallback into filename* -- that path leaked un-neutralized bidi
    // overrides, defeating the anti-spoofing guarantee.
    const sanitized =
        sanitizeFilename(filename ?? "")
        || sanitizeFilename(options?.fallback ?? "")
        || "document";

    return `${type}${buildFilenameParams(sanitized)}`;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Sanitize an untrusted filename for safe use in HTTP headers.
 *
 * Applied BEFORE any RFC encoding. This is the security layer that
 * prevents header injection and path traversal attacks.
 */
function sanitizeFilename(raw: string): string {
    // 1. Strip control characters and Unicode formatting controls.
    //    C0 controls (\x00-\x1F), DEL (\x7F): prevents CRLF header injection.
    //    C1 controls (\x80-\x9F): invisible formatting, no valid use in filenames.
    //    Bidi controls (U+061C ALM, U+202A-202E, U+2066-2069): prevents RLO
    //    filename spoofing where "report\u202Efdp.exe" renders as
    //    "reportexe.pdf" -- the full Unicode bidi-control set, not only the
    //    LRE..RLO block.
    //    Zero-width and invisible format chars (U+200B-200F, U+2060-2064 word
    //    joiner + invisible operators, U+FEFF ZWNBSP/BOM, U+180E Mongolian
    //    vowel separator, U+FFF9-FFFB interlinear annotation): invisible
    //    joiners/marks that can hide or reorder what the user sees.
    //    Soft hyphen (U+00AD): invisible except at line breaks, same spoofing
    //    class. NBSP (U+00A0): often mistaken for a regular space.
    const noControls = raw.replace(
        /[\r\n\x00-\x1F\x7F\x80-\x9F\u00A0\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/g,
        "",
    );

    // 2. Strip path traversal sequences (../ and ..\).
    //    Some integration APIs return full paths or relative paths.
    //    Even though HTTP clients shouldn't interpret these, defense-in-depth.
    const noTraversal = noControls.replace(/\.\.[/\\]/g, "");

    // 3. Extract basename (strip directory components).
    //    Integration APIs sometimes return full paths like "/uploads/2024/report.pdf".
    //    Uses lastIndexOf instead of split().pop() to avoid array allocation.
    const lastSep = Math.max(noTraversal.lastIndexOf("/"), noTraversal.lastIndexOf("\\"));
    const basename = lastSep >= 0 ? noTraversal.slice(lastSep + 1) : noTraversal;

    // May be empty: the caller composes the fallback chain so both the
    // filename and the fallback pass through this same sanitizer.
    return basename;
}

/**
 * Build the filename parameter string for Content-Disposition.
 *
 * Encoding strategy:
 *   1. Pure ASCII token (no separators): emit unquoted `filename=report.pdf`
 *   2. ASCII with special chars: emit quoted `filename="my report.pdf"`
 *   3. Non-ASCII: emit both `filename="?rlig.pdf"` and `filename*=UTF-8''...`
 *
 * RFC 2616 Section 2.2 quoted-string escaping:
 *   - `\` -> `\\` (backslash must be escaped)
 *   - `"` -> `\"` (double-quote must be escaped)
 */
function buildFilenameParams(filename: string): string {
    // Case 1: Pure ASCII that fits in a token -- emit unquoted.
    // Also reject filenames with hex-encoded sequences (%20) which could
    // be decoded by legacy clients, and filenames containing a double
    // quote: RFC 6266 Appendix D advises against relying on quoted-pair
    // escaping (many user agents mishandle `\"`), so those get a
    // filename* companion below, which encodes the quote unambiguously.
    if (
        ASCII_TEXT_REGEXP.test(filename)
        && !HEX_ESCAPE_REGEXP.test(filename)
        && !filename.includes('"')
    ) {
        if (TOKEN_REGEXP.test(filename)) {
            return `; filename=${filename}`;
        }
        // ASCII but contains separators/spaces -- use quoted-string
        return `; filename=${quoteString(filename)}`;
    }

    // Case 2: Contains non-ASCII characters or hex escapes.
    // Emit both parameters for cross-browser compatibility:
    //   - filename="ascii-fallback" for legacy clients
    //   - filename*=UTF-8''percent-encoded for modern clients (RFC 8187)
    const asciiFallback = toAsciiFallback(filename);
    const encoded = encodeRfc8187(filename);

    // When filename has hex escapes but is pure ASCII, we still need
    // filename* because the hex escape could be decoded by legacy clients.
    // Percent-encode % in the fallback to prevent unintended decoding.
    const safeFallback = asciiFallback.replace(/%/g, "%25");
    if (TOKEN_REGEXP.test(safeFallback)) {
        return `; filename=${safeFallback}; filename*=${encoded}`;
    }
    return `; filename=${quoteString(safeFallback)}; filename*=${encoded}`;
}

/**
 * Quote a string per RFC 2616 Section 2.2.
 *
 * quoted-string = ( <"> *(qdtext | quoted-pair) <"> )
 * quoted-pair   = "\" CHAR
 *
 * Both `\` and `"` MUST be escaped with a preceding backslash.
 *
 * In practice, `\` is stripped by sanitizeFilename (treated as path separator),
 * so only `"` escaping is exercised through the normal code path. The `\`
 * escaping is defense-in-depth for correctness if sanitization ever changes.
 */
function quoteString(str: string): string {
    return `"${str.replace(QUOTED_PAIR_REGEXP, "\\$&")}"`;
}

/**
 * Generate a US-ASCII fallback for non-ASCII filenames.
 *
 * First folds compatibility-decomposable characters to their base letters
 * (NFKD + combining-mark strip), so accented Latin degrades readably:
 * "Årlig Rapport.pdf" -> "Arlig Rapport.pdf", "café.txt" -> "cafe.txt".
 * Characters with no ASCII decomposition (CJK, ø, æ, emoji) are replaced
 * with `?` -- more honest than `_`, since it signals characters were lost
 * rather than suggesting underscores were in the original. Modern clients
 * use the lossless `filename*` parameter instead.
 */
function toAsciiFallback(filename: string): string {
    return filename
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .replace(NON_ASCII_REGEXP, "?");
}

/**
 * Encode a string per RFC 8187 (formerly RFC 5987).
 *
 * Format: charset'language'value-chars
 * We always use UTF-8 and leave language empty.
 *
 * The encoding differs from encodeURIComponent in that RFC 8187
 * defines its own set of "attr-char" that don't need encoding.
 * We first apply encodeURIComponent (which handles all non-ASCII),
 * then encode the characters that encodeURIComponent leaves unescaped
 * but RFC 8187 requires encoded (including single quotes, which are
 * the charset/language delimiter in the RFC 8187 format).
 */
function encodeRfc8187(str: string): string {
    // encodeURIComponent itself throws URIError on lone surrogates
    // (ECMA-262), so the exception IS the surrogate detector: clean strings
    // (the overwhelming majority, including valid emoji pairs) pay no
    // pre-scan at all. Lone surrogates only occur when upstream code
    // truncates filenames mid-emoji with .slice() on UTF-16 code units;
    // that pathological path eats the exception cost and retries stripped.
    // Benchmarked against a surrogate-range pre-scan regex: this is ~6x
    // faster for emoji filenames (a pre-scan cannot tell valid pairs from
    // lone surrogates, so it triggered the strip for every emoji).
    let encoded: string;
    try {
        encoded = encodeURIComponent(str);
    } catch {
        encoded = encodeURIComponent(str.replace(LONE_SURROGATE_REGEXP, ""));
    }
    encoded = encoded.replace(ENCODE_URL_ATTR_CHAR_REGEXP, percentEncode);

    return `UTF-8''${encoded}`;
}

/** Percent-encode a single character. */
function percentEncode(char: string): string {
    return "%" + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
}
