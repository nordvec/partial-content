/**
 * Generic HTTP ObjectStore adapter for partial-content.
 *
 * Serves from ANY range-capable HTTP origin using plain `fetch`: Supabase
 * Storage, S3/GCS/Azure presigned URLs, CDN origins, internal file services,
 * or another partial-content server. Zero dependencies, every runtime.
 *
 * Capabilities mapped straight onto HTTP semantics:
 * - `headObject` -> `HEAD` (metadata from Content-Length / ETag / Last-Modified)
 * - `getObject`  -> `GET` with `Range: bytes=...`
 * - Pinned reads -> `If-Match` (origin 412 becomes {@link ObjectChangedError})
 * - RFC 9530     -> `Repr-Digest: sha-256=:...:` response header is extracted
 *
 * Caveats:
 * - The origin must send `Content-Length` (range-capable origins always do).
 * - Presigned URLs are signed per-method: a GET-presigned URL will reject the
 *   HEAD probe. Presign both methods in `url()` (it receives the key only;
 *   return method-agnostic URLs, or front the origin with a service that
 *   accepts both).
 * - Origins that ignore `If-Match` are still safe: the web adapter's
 *   response-side guard (actual Content-Range + GET validators) remains.
 *
 * @example Supabase Storage (authenticated)
 * ```typescript
 * import { httpStore } from "partial-content/http";
 * import { serveObject } from "partial-content/web";
 *
 * const store = httpStore({
 *   // A key is a path in the origin's namespace, not a URL fragment: each
 *   // segment is encoded so a key cannot carry a query, a fragment, an
 *   // authority or a dot segment into the request line.
 *   url: (key) => `${SUPABASE_URL}/storage/v1/object/documents/${encodeKeyPath(key)}`,
 *   headers: { Authorization: `Bearer ${serviceRoleKey}` },
 * });
 *
 * export const GET = serveObject(store, { disposition: "inline" });
 * ```
 *
 * @packageDocumentation
 */

import {
    ObjectNotFoundError,
    ObjectChangedError,
    StoreUnavailableError,
    resolveServedRange,
    guardStreamLength,
    type KeyPolicy,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectStream,
    type ReadRange,
} from "./index.ts";
import {
    asUrlParserReads,
    BUCKET_KEY_MAX_BYTES,
    exceedsUtf8Bytes,
    isInstance,
    isObjectNotFoundError,
    isStoreUnavailableError,
    parseRetryAfterSeconds,
    projectError,
    type ProjectedError,
    rangeHeaderValue,
    readField,
    retryAfterFrom,
    urlKeyGuard,
} from "./object-store.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };

// ─── Options ────────────────────────────────────────────────────────────────

export interface HttpStoreOptions {
    /**
     * Build the absolute URL for a storage key. May return a promise, so a
     * presigner can sign per request. Returning anything but a string or a
     * `URL` is a configuration error (a `TypeError`), not a missing object.
     *
     * Encode the key ({@link encodeKeyPath} for a path, `encodeURIComponent`
     * for a query value). A key holding `?`, `#`, `\`, a tab or a line break
     * turns into a query, a fragment or another path when it is interpolated
     * unencoded, so the request would name a different object than the key
     * does. Such a key is fetched only when the built URL's path,
     * percent-decoded, holds it. Any other URL answers not found for such a
     * key, including one that carries the key in a query value and one from
     * a builder that maps the key to another name. A key with a lone
     * surrogate is not found.
     *
     * The key is the object's name, never URL text: an interpolated `%XX` is
     * decoded by the origin, so `%70rivate/x` interpolated unencoded is fetched
     * as `private/x`. A URL with a username or password is refused (a
     * `TypeError`): runtimes disagree on what URL credentials do, so pass them
     * in `headers`.
     */
    url: (key: string) => string | URL | Promise<string | URL>;
    /**
     * Request headers (e.g. Authorization). A static record, or a function of
     * the key for per-object credentials. They are sent to the origin `url()`
     * names; a followed redirect to another origin receives none of them.
     *
     * `Accept-Encoding`, `Range`, and `If-Match` are reserved: the adapter owns
     * them for byte-accounting and pinned-read correctness, and any supplied
     * value is replaced (case-insensitively, so a lowercase `accept-encoding`
     * cannot merge with the adapter's into a combined header the origin would
     * honor over the identity requirement).
     */
    headers?: Record<string, string> | ((key: string) => Record<string, string>);
    /**
     * Fetch implementation. Defaults to the global `fetch`.
     * Inject for testing or to add retries/instrumentation. This is also the
     * SSRF hook: when `url()` incorporates untrusted input, supply a fetch
     * that validates resolved addresses (see SECURITY.md).
     */
    fetch?: typeof globalThis.fetch;
    /**
     * Redirect policy for origin requests. Defaults to `"error"`: a 3xx from
     * the origin fails the read. A serving layer whose `url()` may incorporate
     * untrusted keys must not let a compromised or misconfigured origin bounce
     * the store to internal endpoints (cloud metadata IPs). Object-storage
     * origins answer GET/HEAD with a direct 200, so the safe default costs
     * nothing there.
     *
     * `"follow"` is for origins that legitimately redirect (some presigned-URL
     * or CDN front-door flows). The store follows each hop itself, the same
     * way on every runtime: at most 10 hops, each to an `http:` or `https:`
     * URL and never from `https:` to `http:`, each sent through `fetch` (so a
     * validating `fetch` judges every hop), and a hop to another origin
     * carries no header from `headers`.
     * @default "error"
     */
    redirect?: "follow" | "error";
    /**
     * Key prefixes this store refuses to serve, because they are where a
     * partial-content 5.x upload store sharing the origin keeps its in-flight
     * bytes and the sidecars naming their destination keys. Keys at or under
     * one answer {@link ObjectNotFoundError}, in the spellings a URL path is
     * resolved from: percent-decoded, with its dot segments resolved, case and
     * compatibility forms folded, and trailing dots and spaces dropped. A
     * filesystem-backed origin can equate more names than that (short-name
     * aliases, stream suffixes), so it should deny the workspace itself. The
     * default covers both 5.x upload-store layouts, since the origin behind a
     * URL does not say which one it fronts. Set to `""` when no upload store
     * shares the origin.
     * @default [".uploads/", ".partial-content-uploads/"]
     */
    reservedPrefix?: string | readonly string[];
    /**
     * Whether a key with an empty segment is refused. The key becomes the path
     * of a URL, which an origin or URL parser resolves, so the default refuses
     * it; `"verbatim"` passes an origin's real `a//b` object through
     * (`encodeKeyPath(key, { keys: "verbatim" })` builds its path). A `.` or
     * `..` segment is refused under either value, in the key and in the part
     * of it before any `?` or `#` (an origin that decodes the path and parses
     * it again reads only that part): the URL is resolved before the origin
     * sees it, so no object is named by such a key. So is a key a `new URL(key, base)` builder would
     * take out from under its base: one starting with `/` or `\`, one starting
     * with a special scheme (`https:x`, `file:x`), and one starting or ending
     * with a C0 control or a space, which the URL parser strips. Whatever the
     * key, only an `http:` or `https:` URL from `url()` is fetched, and a key
     * the builder cannot turn into a URL at all is not found.
     * @default "plain"
     */
    keys?: KeyPolicy;
    /**
     * The longest key served, in UTF-8 bytes. A longer key is not found, and
     * is refused before `url()` runs or any other test reads it, so the work
     * spent on a key the requester chose stays bounded. Raise it for an origin
     * whose names are longer.
     * @default 1024
     */
    maxKeyBytes?: number;
}

// ─── Key to path ────────────────────────────────────────────────────────────

/**
 * Encode a storage key as the path suffix of an origin URL.
 *
 * A key is a path in the origin's namespace and a URL is a request line, and
 * interpolating one into the other unencoded lets the key rewrite the request:
 * `a?x=1` adds a query, `a#b` a fragment, `../other` walks to a sibling
 * resource, and an encoded slash the origin decodes reaches a key the
 * interpolation never named. Each segment is percent-encoded and the
 * separators are the only literal slashes, so the origin sees exactly the key's
 * segments in the key's order. The `.` and `..` dot segments are refused as
 * {@link ObjectNotFoundError}: a URL parser resolves them before the origin
 * ever sees the path, so no encoding of them names what the key names. An
 * empty segment is refused too unless `keys` is `"verbatim"`, the policy of a
 * store serving an origin's real `a//b` object. A leading one is refused under
 * either policy: a path that starts with `//` is read as an authority.
 */
export function encodeKeyPath(key: string, opts: { keys?: KeyPolicy } = {}): string {
    const segments = key.split("/");
    const keepEmpty = opts.keys === "verbatim";
    for (const segment of segments) {
        if ((segment === "" && !keepEmpty) || segment === "." || segment === "..") throw new ObjectNotFoundError(key);
    }
    // A leading empty segment makes the path start with `//`, which a URL parser reads as an authority.
    if (segments[0] === "") throw new ObjectNotFoundError(key);
    try {
        return segments.map(encodeURIComponent).join("/");
    } catch {
        // A lone surrogate has no UTF-8 encoding, so no URL names such a key.
        throw new ObjectNotFoundError(key);
    }
}

/**
 * The decoder for the reserved-prefix spellings. It drops a U+FEFF that
 * starts an escape run, as an origin that reads a decoded name as text may,
 * so `%EF%BB%BF.uploads/x` is also read as `.uploads/x`.
 */
const SPELLING_UTF8 = new TextDecoder();
/**
 * The decoder for the key gate, which keeps every code point: the gate asks
 * whether the path holds the key exactly, and an encoded U+FEFF in the key is
 * part of it.
 */
const GATE_UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * `value` with every well-formed `%XX` decoded and everything else left as
 * written, the way an origin decodes a path byte by byte. Total, unlike
 * `decodeURIComponent`: one malformed escape (`%zz`, a lone `%`, a byte that
 * is not UTF-8) must not leave the escapes beside it unread, since
 * the `%2f..%2f` in `x%ff%2f..%2f` is still a `/../` to the origin.
 */
function percentDecode(value: string, decoder: TextDecoder = SPELLING_UTF8): string {
    return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) =>
        decoder.decode(Uint8Array.from(run.slice(1).split("%"), (hex) => Number.parseInt(hex, 16))),
    );
}

/** `input` as a URL (resolved against `base` when given), or `undefined` when it is not one. */
function parseUrl(input: string | URL, base?: URL | string): URL | undefined {
    try {
        return new URL(input, base);
    } catch {
        // Not a URL: the caller decides what that means.
        return undefined;
    }
}

/**
 * The spellings a key can be read as on its way to naming something, for the
 * reserved-prefix test: as written, percent-decoded, resolved as a URL path
 * (dot segments removed), and in both orders of the two, since origins differ
 * on which they do first. `%2Euploads/x` and `a/../.uploads/x` both arrive at
 * `.uploads/x` though neither carries the reserved prefix as written. Each of
 * those is also read with the trailing dots and spaces of every segment
 * dropped, which a Windows-hosted origin does (`.uploads./x`).
 *
 * This covers URL resolution, percent-decoding, case and compatibility
 * folding, and that trailing-dot fold. It is not every way an origin can
 * equate two names (a short-name alias, a stream suffix, a path parameter, an
 * ignorable code point): a filesystem-backed origin should deny the workspace
 * itself. {@link encodeKeyPath} leaves none of this reachable, but `url()`
 * belongs to the consumer, and a key interpolated into one unencoded is what
 * this set exists for.
 *
 * `atQuery` decides what a `?` or `#` is when the spelling is resolved: path
 * text (`"path"`), as an encoding builder sends it, or the end of the path
 * (`"end"`), as an origin that decodes the path and parses it again reads it.
 */
function originSpellings(key: string, atQuery: "path" | "end"): readonly string[] {
    const asPath = (value: string): string =>
        atQuery === "end" ? value : value.replace(/[?#]/g, (c) => (c === "?" ? "%3F" : "%23"));
    // A relative reference, so a key shaped like a scheme (`ab:c`) stays a path.
    const resolve = (value: string): string =>
        parseUrl(`./${asPath(value)}`, "http://spellings.invalid/")?.pathname.slice(1) ?? value;
    // Keeps one character of each segment, so a dots-only segment is not emptied.
    const dropTrailingDotsAndSpaces = (value: string): string =>
        value
            .split("/")
            .map((segment) => segment.replace(/(?<=[^. ])[. ]+$/, ""))
            .join("/");
    const decoded = percentDecode(key);
    // An origin that reads a decoded name in normal form NFKC sees a fullwidth `．` as a dot
    // before it trims or resolves the path, so the folded text is resolved too.
    const folded = decoded.normalize("NFKC");
    const spellings = [
        key,
        decoded,
        resolve(key),
        resolve(decoded),
        percentDecode(resolve(key)),
        folded,
        resolve(folded),
    ];
    return [...spellings, ...spellings.map(dropTrailingDotsAndSpaces)];
}

/**
 * Whether `key` stays under the location it is appended to when `url()` hands
 * it to `new URL(key, base)` (WHATWG URL Standard, section 4.1), as well as
 * under a template. Refused: a key the parser would strip at either end (C0
 * controls and space), one that starts with `/` or `\` (an absolute path, or
 * an authority when doubled), and one that starts with a special scheme
 * (`ftp`, `file`, `http`, `https`, `ws`, `wss`), which the parser resolves
 * relative to a base of the same scheme (`https:../x`) or reads as a new
 * authority. All are read with tab, CR and LF removed as the parser removes
 * them. Any other scheme-shaped key builds a URL whose own scheme
 * {@link originUrl} refuses.
 */
function staysUnderBase(key: string): boolean {
    // oxlint-disable-next-line no-control-regex -- the C0 range is what the parser strips
    if (/^[\x00-\x20]|[\x00-\x20]$/.test(key)) return false;
    return !/^[/\\]|^(?:ftp|file|https?|wss?):/i.test(asUrlParserReads(key));
}

/** What a URL parser rewrites inside a path: a query, a fragment, `\` as `/`, a dropped tab or line break. */
const PARSER_REWRITTEN = /[?#\\\t\n\r]/;

/** A lone surrogate has no UTF-8 form: a URL parser writes U+FFFD in its place, which is another key. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * Whether the parsed URL carries a parser-rewritten `key` intact, judged on
 * the one thing the URL can show: its path, percent-decoded, holds the key.
 * An unencoded key never gets there: a `?` or `#` ends the path, a `\`
 * arrives as `/` and a tab or line break is gone.
 *
 * The query is not read. A copy of the key there says nothing about the
 * object the path names, and a path can lose the key in more ways than a
 * rule over its text can list. Absence proves nothing either, so a URL whose
 * path does not carry the key never passes, however it was built.
 */
function carriesRewrittenKey(url: URL, key: string): boolean {
    return percentDecode(url.pathname, GATE_UTF8).includes(key);
}

/** Whether `url` carries a username or password, which runtimes treat three different ways. */
function hasUserinfo(url: URL): boolean {
    return url.username !== "" || url.password !== "";
}

/** The redirect statuses that carry a `Location` to follow (RFC 9110 Section 15.4). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** How many redirects one read follows under `redirect: "follow"`. */
const MAX_REDIRECT_HOPS = 10;

/**
 * The errors this store wrote itself, with fixed text. Everything else thrown
 * inside a store call came from a caller callback, a runtime or the origin and
 * can carry a URL, a credential or a key, so only these and the three contract
 * errors leave a store call as thrown.
 */
const AUTHORED = new WeakSet<object>();

/** A store-authored failure. `message` is fixed text: no origin, header or key text. */
function refusal(message: string, Kind: ErrorConstructor = Error): Error {
    const err = new Kind(message);
    AUTHORED.add(err);
    return err;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} backed by any range-capable HTTP origin.
 */
export function httpStore(opts: HttpStoreOptions): ObjectStore {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const follow = opts.redirect === "follow";
    // A header the runtime refuses is a configuration error, reported where no
    // key or URL is in scope. The runtime's own message quotes the value, which
    // is usually the credential, so the text here is fixed.
    if (typeof opts.headers === "object" && opts.headers !== null) {
        try {
            new Headers(opts.headers);
        } catch {
            throw new TypeError("httpStore: headers holds a name or value that is not a valid HTTP header");
        }
    }
    // descope: httpStore keeps consumer-built URLs, so its reserved-prefix guard is best effort over origin normalizations; revisit when 7.0 opens the API (baseUrl-owned paths)
    const maxKeyBytes = opts.maxKeyBytes ?? BUCKET_KEY_MAX_BYTES;
    if (!(Number.isSafeInteger(maxKeyBytes) && maxKeyBytes > 0)) {
        throw new TypeError("httpStore: maxKeyBytes must be a positive integer");
    }
    const reservedPrefix = opts.reservedPrefix ?? [".uploads/", ".partial-content-uploads/"];
    // An origin over a case-insensitive volume answers `.UPLOADS/x` with the workspace.
    const guardSpelling = urlKeyGuard(reservedPrefix, { keys: opts.keys ?? "plain", foldCase: true });
    // A spelling cut at `?` or `#` is judged for its dot segments and the
    // reserved prefix only: what such a cut leaves empty is where `url()`
    // appends the key, and an encoding builder sends the whole key.
    const guardCutSpelling = urlKeyGuard(reservedPrefix, { keys: "verbatim", foldCase: true });
    // Reported as the key the caller named: the spellings are how the origin
    // would read it, not something the caller asked for.
    const assertReadable = (key: string): void => {
        // First, so no later reading of the key costs more than the cap allows.
        if (exceedsUtf8Bytes(key, maxKeyBytes)) throw new ObjectNotFoundError(key);
        // The empty key names the location `url()` appends to, not an object under it.
        if (key === "" || !staysUnderBase(key)) throw new ObjectNotFoundError(key);
        const judged = (guard: (spelling: string) => void, spellings: readonly string[]): void => {
            for (const spelling of spellings) {
                try {
                    guard(spelling);
                } catch {
                    throw new ObjectNotFoundError(key);
                }
            }
        };
        judged(guardSpelling, originSpellings(key, "path"));
        // The part before a `?` or `#` is judged too: `a/..?x` is `a/..` to an origin that parses
        // the path again, and resolving the whole key would drop that `..` unseen. An origin that
        // decodes first cuts the decoded text, so `a/..%3Fx` and `.uploads%20%3F` are cut after decoding, and
        // in normal form NFKC, where a fullwidth `？` or `＃` is the character it cuts at.
        const cut = (text: string): string => asUrlParserReads(text).split(/[?#]/, 1)[0] ?? "";
        const decoded = percentDecode(key);
        const parts = new Set([key, cut(key), cut(decoded), cut(decoded.normalize("NFKC"))]);
        judged(
            guardCutSpelling,
            [...parts].flatMap((part) => originSpellings(part, "end")),
        );
    };

    /**
     * The URL `url()` built for `key`, parsed. The parsed URL is what is
     * fetched, so the request goes to exactly what was judged here:
     *
     * - only `http:` and `https:` pass. A runtime's `fetch` decides what any
     *   other scheme does (one reads `host:port/x` as an HTTP request to that
     *   host, another opens a storage client), so the built URL is judged, not
     *   the key's spelling;
     * - a key holding something the parser rewrites ({@link PARSER_REWRITTEN})
     *   is fetched only from a URL that carries it intact
     *   ({@link carriesRewrittenKey}): interpolated unencoded, `a?b` has
     *   become the object `a` with a query;
     * - a key with a lone surrogate is not found before `url()` runs, since
     *   the parser would fetch the key with U+FFFD in its place.
     *
     * Called once per store call: a signing `url()` returns a different URL
     * each time, and the request must go to the one this call built.
     */
    async function originUrl(key: string): Promise<URL> {
        if (LONE_SURROGATE.test(key)) throw new ObjectNotFoundError(key);
        let built: unknown;
        try {
            built = await opts.url(key);
        } catch (err) {
            throw builderFailure(key, err);
        }
        if (typeof built !== "string" && !(built instanceof URL)) {
            throw refusal("httpStore: url() must return a string or a URL", TypeError);
        }
        const url = parseUrl(built);
        if (!url || !isHttp(url)) throw new ObjectNotFoundError(key);
        if (hasUserinfo(url)) {
            throw refusal("httpStore: url() returned a URL with credentials; pass them in headers", TypeError);
        }
        if (PARSER_REWRITTEN.test(key) && !carriesRewrittenKey(url, key)) throw new ObjectNotFoundError(key);
        return url;
    }

    function requestHeaders(key: string): Headers {
        let headers: Headers;
        try {
            // A Headers instance, not a spread record: header names are
            // case-insensitive on the wire but object keys are not, so a consumer's
            // lowercase `accept-encoding` would survive a spread alongside ours and
            // fetch would MERGE the duplicates into e.g. "gzip, identity", silently
            // authorizing the compressed bodies the identity requirement exists to
            // prevent. `set()` replaces any spelling of the reserved fields.
            headers = new Headers(typeof opts.headers === "function" ? opts.headers(key) : (opts.headers ?? undefined));
        } catch (err) {
            throw callbackFailure("httpStore: headers could not be built", err);
        }
        // Byte accounting depends on the origin NOT transparently compressing:
        // a gzip'd body would break Content-Length/Content-Range math. Server
        // runtimes (undici, Bun, Deno, Workers) honor this; identity is also
        // what object-storage origins serve anyway.
        headers.set("Accept-Encoding", "identity");
        // Reserved protocol fields: a stale consumer-supplied Range would turn a
        // full read into an unrequested 206, and a consumer If-Match would fight
        // the orchestrator's pin. Cleared here; set per request below.
        headers.delete("Range");
        headers.delete("If-Match");
        return headers;
    }

    /**
     * One origin request, with redirects handled here and never by the
     * runtime. Every request goes out with `redirect: "manual"`: the runtimes
     * disagree on the other modes (one refuses `"error"` outright, and a
     * runtime-followed hop bypasses the URL rule, the injected `fetch` and the
     * header policy), while a 3xx handed back is the same everywhere. Under
     * the default policy that 3xx is returned and fails the read as any other
     * unexpected status does. Under `"follow"` each hop is resolved against
     * the URL that answered, held to the `http:` and `https:` rule (never `https:` to `http:`), and
     * sent through the same `fetch`; a hop to another origin keeps only the
     * fields this store owns.
     */
    async function send(method: "HEAD" | "GET", url: URL, headers: Headers, signal?: AbortSignal): Promise<Response> {
        let target = url;
        let sent = headers;
        for (let hops = 0; ; hops++) {
            const response = await fetchOrigin(doFetch, method, target, {
                method,
                headers: sent,
                signal,
                redirect: "manual",
            });
            if (!follow || !REDIRECT_STATUSES.has(response.status)) return response;
            releaseBody(response);
            const location = response.headers.get("location");
            const next = location === null || hops === MAX_REDIRECT_HOPS ? undefined : parseUrl(location, target);
            if (
                !next ||
                !isHttp(next) ||
                hasUserinfo(next) ||
                (target.protocol === "https:" && next.protocol === "http:")
            ) {
                throw refusal(`httpStore ${method}: the origin's redirect was refused`);
            }
            if (next.origin !== target.origin) {
                const own = new Headers();
                for (const name of ["Accept-Encoding", "Range", "If-Match"]) {
                    const value = sent.get(name);
                    if (value !== null) own.set(name, value);
                }
                sent = own;
            }
            target = next;
        }
    }

    /**
     * The store boundary: the three contract errors and this store's own
     * fixed-text failures leave as thrown, and anything else is replaced by
     * its {@link originFailure}, wherever in the call it was thrown.
     */
    const guarded =
        <Args extends unknown[], Result>(method: string, run: (...args: Args) => Promise<Result>) =>
        async (...args: Args): Promise<Result> => {
            try {
                return await run(...args);
            } catch (err) {
                if (leavesAsThrown(err)) throw err;
                throw callbackFailure(`httpStore ${method}: origin request failed`, err);
            }
        };

    /**
     * Whether a caught value is a contract error or one of this store's own
     * fixed-text failures. Total: `instanceof` runs a Proxy's
     * `getPrototypeOf` trap, whose own error must not leave in its place.
     */
    function leavesAsThrown(err: unknown): boolean {
        return (
            typeof err === "object" &&
            err !== null &&
            (AUTHORED.has(err) ||
                isInstance(err, ObjectNotFoundError) ||
                isInstance(err, ObjectChangedError) ||
                isInstance(err, StoreUnavailableError))
        );
    }

    /**
     * One {@link originUrl}, then its headers: the order every read takes, so
     * the key is judged before a callback sees it and no entry point can skip
     * the gate.
     */
    async function originRequest(key: string): Promise<{ url: URL; headers: Headers }> {
        assertReadable(key);
        const url = await originUrl(key);
        return { url, headers: requestHeaders(key) };
    }

    return {
        supportsRange: true,
        // 206 bounds/total are parsed from the origin's actual Content-Range
        // (an origin ignoring Range degrades to 200): the orchestrator may skip
        // the validating HEAD for plain range requests.
        authoritativeRange: true,

        headObject: guarded(
            "HEAD",
            async (key: string, headOpts?: { signal?: AbortSignal }): Promise<ObjectMetadata> => {
                const { url, headers } = await originRequest(key);
                const response = await send("HEAD", url, headers, headOpts?.signal);
                // Nothing reads a HEAD body; an injected fetch may still return one, which is released here.
                releaseBody(response);
                if (response.status === 404) throw new ObjectNotFoundError(key);
                if (isUnavailableStatus(response.status)) {
                    throw new StoreUnavailableError(key, { retryAfterSeconds: parseRetryAfter(response) });
                }
                if (!response.ok) {
                    throw refusal(`httpStore HEAD failed: ${response.status}`);
                }

                if (hasNonIdentityEncoding(response)) {
                    throw refusal(
                        "httpStore HEAD: origin returned a Content-Encoding other than identity; " +
                            "Content-Length would report the compressed size, so range serving requires an identity-coded body",
                    );
                }

                const contentLength = parseSize(response.headers.get("content-length"));
                if (contentLength === undefined) {
                    throw refusal(
                        "httpStore HEAD: origin sent no Content-Length; range serving requires sized responses",
                    );
                }

                return {
                    contentLength,
                    etag: response.headers.get("etag") ?? undefined,
                    lastModified: response.headers.get("last-modified") ?? undefined,
                    digest: extractSha256Digest(response.headers.get("repr-digest")),
                };
            },
        ),

        getObject: guarded(
            "GET",
            async (
                key: string,
                getOpts?: { range?: ReadRange; signal?: AbortSignal; ifMatch?: string },
            ): Promise<ObjectStream> => {
                const { range, signal, ifMatch } = getOpts ?? {};
                const { url, headers } = await originRequest(key);
                // An open range goes out in its bare `bytes=a-` form.
                if (range) headers.set("Range", rangeHeaderValue(range));
                // Pin the read to the validated representation. Origins that honor
                // If-Match (S3, Azure, nginx, another partial-content server) answer
                // 412 when the object changed; origins that ignore it fall through to
                // the caller's response-side guard. Weak validators are never sent:
                // RFC 9110 mandates strong comparison for If-Match, so a `W/` ETag
                // would be rejected by every compliant origin on every attempt.
                if (ifMatch && !ifMatch.startsWith("W/")) {
                    headers.set("If-Match", ifMatch);
                }

                const response = await send("GET", url, headers, signal);

                try {
                    return await readGetResponse(response, key);
                } catch (err) {
                    // Whatever refused the response after the origin answered, its body is released.
                    releaseBody(response);
                    throw err;
                }
            },
        ),
    };
}

/** Whether `url` is one this store fetches. */
function isHttp(url: URL): boolean {
    return url.protocol === "http:" || url.protocol === "https:";
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * The failure a throwing `url()` surfaces. A builder that parses the key
 * (`new URL(key, base)`) throws a `TypeError` on one that is not a URL
 * reference at all; such a key names no object. A builder that says so itself
 * ({@link encodeKeyPath}) is believed, and so is a throttled presigner that
 * says so with the contract's error, whose back-off is kept and whose cause is
 * not. Both are recognised by name as well as by class: a builder may import a
 * second copy of this package (one ESM, one CommonJS), whose classes are not
 * these. Any other failure is the builder's own (a presigner that is down).
 */
function builderFailure(key: string, err: unknown): Error {
    if (
        isInstance(err, ObjectNotFoundError) ||
        isObjectNotFoundError(err) ||
        (isInstance(err, TypeError) && !parseUrl(key, "http://key.invalid/"))
    ) {
        return new ObjectNotFoundError(key);
    }
    if (isInstance(err, StoreUnavailableError) || isStoreUnavailableError(err)) {
        const hint = readField(err, "retryAfterSeconds");
        return new StoreUnavailableError(key, { retryAfterSeconds: typeof hint === "number" ? hint : undefined });
    }
    return callbackFailure("httpStore: url() failed", err);
}

/**
 * Refuse an origin GET answered with anything but 200 or 206, draining its
 * body: 404 and 412 are the object's own answers, an unavailable status keeps
 * its `Retry-After`.
 */
async function refuseGetStatus(response: Response, key: string): Promise<void> {
    if (response.status === 200 || response.status === 206) return;
    const retryAfterSeconds = isUnavailableStatus(response.status) ? parseRetryAfter(response) : undefined;
    await drain(response);
    if (response.status === 404) throw new ObjectNotFoundError(key);
    if (response.status === 412) throw new ObjectChangedError(key);
    if (isUnavailableStatus(response.status)) throw new StoreUnavailableError(key, { retryAfterSeconds });
    throw refusal(`httpStore GET failed: ${response.status}`);
}

/**
 * Turn an origin GET response into the store's read, or refuse it. A refusal
 * drains or cancels the body it holds; the caller releases whatever is left when
 * this throws.
 */
async function readGetResponse(response: Response, key: string): Promise<ObjectStream> {
    await refuseGetStatus(response, key);

    // The fetch runtime transparently decodes a compressed body while
    // Content-Length / Content-Range still describe the encoded bytes, so
    // every byte count below would be wrong. Refuse rather than stream a
    // body that disagrees with its own headers.
    if (hasNonIdentityEncoding(response)) {
        await drain(response);
        throw refusal(
            "httpStore GET: origin returned a Content-Encoding other than identity; " +
                "range and length accounting require an identity-coded body",
        );
    }

    const headerLength = parseSize(response.headers.get("content-length"));
    let served: { start: number; end: number } | undefined;
    let contentLength: number;
    let totalSize: number | undefined;

    if (response.status === 206) {
        // A 206 MUST carry a parseable single-range Content-Range; without
        // one the body's bounds are unknowable and serving it as anything
        // would silently truncate or corrupt the client's view.
        const contentRangeHeader = response.headers.get("content-range");
        const resolved = contentRangeHeader ? resolveServedRange(contentRangeHeader) : null;
        if (!resolved) {
            await drain(response);
            throw refusal(
                `httpStore GET: origin sent 206 with ${contentRangeHeader ? "an unparseable" : "no"} Content-Range`,
            );
        }
        served = resolved.served;
        // Content-Length, or derived from the actual Content-Range when the
        // origin streams chunked 206s.
        contentLength = headerLength ?? resolved.served.end - resolved.served.start + 1;
        // A proxied origin streaming a generated/transcoded body legitimately
        // does not know its full length and sends `bytes a-b/*` (the resolver's
        // `undefined` total). Propagate that so the served response repeats `*`
        // honestly instead of fabricating a total that would draw a spurious
        // 416 on a later range past the invented end.
        totalSize = resolved.totalSize;
    } else {
        if (headerLength === undefined) {
            await drain(response);
            throw refusal("httpStore GET: origin sent no Content-Length; range serving requires sized responses");
        }
        contentLength = headerLength;
        totalSize = contentLength;
    }

    // A bodyless response that DECLARES bytes would otherwise serve a
    // clean-looking empty stream under a non-zero committed Content-Length
    // (truncated but "complete"). No conformant fetch runtime produces
    // this shape (a 200/206 body is never null); refuse an injected or
    // broken implementation loudly instead.
    if (!response.body && contentLength > 0) {
        throw refusal(`httpStore GET: origin response has no body but declares ${contentLength} bytes`);
    }

    return {
        // Same truncation guard every other streaming adapter has: an origin
        // that ends the body cleanly but short of (or past) the Content-Length
        // it declared must error the stream, not close it looking complete
        // under the committed byte count.
        body: response.body ? guardStreamLength(projectBodyErrors(response.body), contentLength) : emptyStream(),
        contentLength,
        totalSize,
        range: served,
        etag: response.headers.get("etag") ?? undefined,
        lastModified: response.headers.get("last-modified") ?? undefined,
        digest: extractSha256Digest(response.headers.get("repr-digest")),
    };
}

/**
 * The failure a store call surfaces for an error it did not write: a transport
 * error, a throwing `url()` or `headers()` callback, anything else thrown
 * inside the call. The origin URL can be a bearer credential (a presigned
 * query string, an SAS token), and a runtime may put all of it on the
 * rejection (a connection error's `path`, a message that quotes the request
 * or a header value), where `onError` would hand it to a log sink. So no text
 * of the original crosses the boundary: `message` is fixed text,
 * the `name`, `code`, `status` (an integer 100 to 599) and numeric `retryAfterSeconds` that
 * classify the failure are copied up (an abort or a timeout is still
 * recognised by its name, an unavailable origin keeps its 503 and its
 * `Retry-After`), and the `cause` is the {@link projectError} projection,
 * which carries no message, stack or other property.
 */
function originFailure(message: string, err: unknown): Error {
    const failure = projectedFailure(message, err);
    const { status } = failure.cause;
    if (status !== undefined) Object.assign(failure, { status });
    const raw = typeof err === "object" && err !== null ? readField(err, "retryAfterSeconds") : undefined;
    const retryAfterSeconds = typeof raw === "number" ? parseRetryAfterSeconds(raw) : undefined;
    if (retryAfterSeconds !== undefined) Object.assign(failure, { retryAfterSeconds });
    return failure;
}

/**
 * The names a serving handler classifies a store failure by. A failure that
 * did not come from the origin (a `url()` or `headers()` callback, or anything
 * else thrown inside the call) must not carry one: a presign service answering
 * its own 404, or a key file that is missing (`NotFound`), says nothing about
 * the object, and read as the object's 404 it turns an outage into "every
 * object is missing".
 */
const CLASSIFYING_NAMES: ReadonlySet<string> = new Set([
    "NotFound",
    "ObjectNotFoundError",
    "ObjectChangedError",
    "StoreUnavailableError",
]);

/**
 * The failure a store call surfaces for an error the origin did not answer
 * with: {@link originFailure}'s fixed text and projection, without the
 * `status`, the `retryAfterSeconds` or a name a handler classifies by.
 */
function callbackFailure(message: string, err: unknown): Error {
    const failure = projectedFailure(message, err);
    if (CLASSIFYING_NAMES.has(failure.name)) failure.name = "Error";
    return failure;
}

/** A store-authored `Error` with fixed `message`, the projected `name` and `code`, and the projection as `cause`. */
function projectedFailure(message: string, err: unknown): Error & { cause: ProjectedError } {
    const cause = projectError(err);
    const failure = new Error(message, { cause }) as Error & { cause: ProjectedError };
    AUTHORED.add(failure);
    failure.name = cause.name;
    if (cause.code !== undefined) Object.assign(failure, { code: cause.code });
    return failure;
}

/** `fetch`, called with the URL as a string, with a transport failure replaced by its {@link originFailure}. */
async function fetchOrigin(
    doFetch: typeof globalThis.fetch,
    operation: string,
    url: URL,
    init: RequestInit,
): Promise<Response> {
    try {
        return await doFetch(url.href, init);
    } catch (err) {
        throw originFailure(`httpStore ${operation}: origin request failed`, err);
    }
}

/**
 * The origin body, with a failure after the headers (a connection reset
 * mid-body rejects the read with the same URL-bearing error a failed `fetch`
 * does) replaced by its {@link originFailure}. Pulls one chunk per read so
 * backpressure reaches the origin, and a cancel is forwarded to it.
 */
function projectBodyErrors(body: ReadableStream<Uint8Array<ArrayBuffer>>): ReadableStream<Uint8Array<ArrayBuffer>> {
    const reader = body.getReader();
    return new ReadableStream<Uint8Array<ArrayBuffer>>(
        {
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) controller.close();
                    else controller.enqueue(value);
                } catch (err) {
                    throw originFailure("httpStore GET body: origin request failed", err);
                }
            },
            cancel: (reason) => reader.cancel(reason),
        },
        { highWaterMark: 0 },
    );
}

/** Release an origin body that will not be served, whatever state it is in. */
function releaseBody(response: Response): void {
    try {
        response.body?.cancel().catch(() => undefined);
    } catch {
        // A locked body has a reader that owns its release.
    }
}

/**
 * Whether the origin transfer-compressed the body despite our
 * `Accept-Encoding: identity` request. A compressed body is transparently
 * decoded by the fetch runtime, but `Content-Length` keeps reporting the
 * compressed size, which breaks all downstream byte accounting.
 */
function hasNonIdentityEncoding(response: Response): boolean {
    const enc = response.headers.get("content-encoding");
    return !!enc && enc.trim().toLowerCase() !== "identity";
}

/** Parse a Content-Length header into a non-negative integer, or undefined. */
function parseSize(value: string | null): number | undefined {
    if (!value || !/^\d+$/.test(value.trim())) return undefined;
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Whether an origin status means "transiently unavailable, retry" (mapped to
 * a 503, not a 502): `503 Service Unavailable` and `429 Too Many Requests`.
 */
function isUnavailableStatus(status: number): boolean {
    return status === 503 || status === 429;
}

/**
 * Parse this origin response's `Retry-After` (RFC 9110 Section 10.2.3) into
 * whole seconds via the shared parser: delay-seconds directly, or an HTTP-date
 * as the non-negative delta from now. Returns undefined when absent/unparseable.
 */
function parseRetryAfter(response: Response): number | undefined {
    return retryAfterFrom(response.headers);
}

/**
 * Extract the raw base64 SHA-256 from an RFC 9530 Repr-Digest header
 * (`sha-256=:BASE64:`), or undefined when absent / different algorithm.
 *
 * Linear manual scan rather than an unanchored `[A-Za-z0-9+/]+=*` regex:
 * on a long hostile header the regex backtracks quadratically, and a header
 * is attacker-influenced input when proxying arbitrary origins.
 */
function extractSha256Digest(header: string | null): string | undefined {
    if (!header) return undefined;
    const marker = "sha-256=:";
    const start = header.toLowerCase().indexOf(marker);
    if (start === -1) return undefined;
    const from = start + marker.length;
    let i = from;
    while (i < header.length && isBase64Char(header.charCodeAt(i))) i++;
    while (i < header.length && header[i] === "=") i++;
    if (i === from || header[i] !== ":") return undefined;
    return header.slice(from, i);
}

/** base64 alphabet: A-Z a-z 0-9 + / */
function isBase64Char(c: number): boolean {
    return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f;
}

/**
 * Consume up to `maxBytes` of an error/refusal body so the connection can be
 * reused, then cancel. A bare `response.arrayBuffer()` would buffer the ENTIRE
 * body -- and these paths include the malformed-206 and encoding-refusal
 * branches whose body is the real (potentially whole-object) payload, plus the
 * fetch runtime transparently INFLATES a compressed body during buffering. A
 * hostile or misconfigured origin could then drive per-request OOM (a
 * decompression bomb) just to make the adapter throw. Reading a small bounded
 * prefix keeps connection reuse for genuine 404/412 error bodies while capping
 * the cost; anything larger sacrifices one pooled connection, which is cheap.
 */
async function drain(response: Response, maxBytes = 64 * 1024): Promise<void> {
    const body = response.body;
    if (!body) return;
    try {
        const reader = body.getReader();
        let seen = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            seen += value.byteLength;
            if (seen > maxBytes) {
                await reader.cancel();
                return;
            }
        }
    } catch {
        // Body already consumed or connection gone; nothing to release.
    }
}

/** A closed empty stream for bodyless 200s (zero-byte objects). */
function emptyStream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.close();
        },
    });
}
