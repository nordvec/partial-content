/**
 * Storage backend contract for partial-content adapters.
 *
 * Implementations adapt a concrete store (S3, R2, Hetzner, GCS, fs) down to
 * this surface. The kernel and framework adapters depend only on these types,
 * never on a storage SDK.
 *
 * @packageDocumentation
 */
import { parseContentRange, parseRequestHttpSeconds, type ReadRange, utf8ByteLength } from "./kernel.ts";

// ─── Error Types ────────────────────────────────────────────────────────────

/**
 * Thrown when an object does not exist in a storage backend.
 *
 * All built-in adapters (S3, R2, GCS, Azure, fs) throw this error
 * for missing objects. Framework adapters (e.g. `partial-content/web`)
 * use the `status` property to distinguish "object not found" (404)
 * from a transiently unavailable backend (503, {@link StoreUnavailableError})
 * and other store failures (502).
 *
 * The message names the failure, never the key: a key is commonly a user's
 * filename, and a message is free text every log line and error tracker
 * prints whole. The key rides on {@link ObjectNotFoundError.key}, as it does
 * on {@link ObjectChangedError} and {@link StoreUnavailableError}, where a
 * consumer can drop, hash or redact it by name.
 */
export class ObjectNotFoundError extends Error {
    /** HTTP status hint for downstream handlers. */
    readonly status = 404 as const;
    /** The storage key that was not found. */
    readonly key: string;

    constructor(key: string, cause?: unknown) {
        super("Object not found");
        this.name = "ObjectNotFoundError";
        this.key = key;
        if (cause !== undefined) this.cause = cause;
    }
}

/**
 * Refuse keys that name a partial-content 5.x upload store's bookkeeping
 * rather than a published object.
 *
 * A location a 5.x upload store shared holds that store's namespace: the
 * in-flight bytes of an upload nobody published, and the sidecar naming the
 * key it was destined for, which commonly embeds a filename. Through a read
 * store over the same location that namespace would be servable.
 *
 * Two independent policies are applied. The NAMESPACE policy refuses the
 * reserved prefixes themselves; pass `reservedPrefix: ""` to serve the whole
 * location when no upload store ever shared it. The KEY policy
 * ({@link KeyPolicy}) decides whether a key that is not plain
 * ({@link isPlainObjectKey}) is refused: it is needed wherever a URL path is
 * built from the key, because a dot or empty segment can reach another object
 * (the reserved namespace included) by a spelling the prefix test never sees,
 * and it only breaks keys where the backend takes the key verbatim. Turning
 * one off leaves the other in force.
 *
 * Refusal is the default rather than an opt-in, because the safe posture has
 * to be what a consumer gets without knowing to ask for it.
 *
 * A prefix that no key can be spelled to match is refused at construction
 * with a `TypeError`: a leading `/` (`"/.uploads/"`), a `.` or `..` segment
 * (`"./.uploads"`) or an empty segment (`"a//b/"`). Such a prefix would
 * silently reserve nothing, so it is a configuration error, not a no-op.
 */
export function reservedKeyGuard(
    reservedPrefix: string | readonly string[],
    opts: ReservedKeyGuardOptions = {},
): (key: string) => void {
    return keyGuard(reservedPrefix, opts, false);
}

/**
 * The guard of a store that puts the key into a URL path (s3Store, azureStore,
 * httpStore), where the path is resolved before the backend sees it. On top of
 * {@link reservedKeyGuard}:
 *
 * - a `.` or `..` segment is refused whatever the {@link KeyPolicy}, in every
 *   spelling {@link hasDotSegment} reads. No backend holds an object such a key
 *   names, because the URL is resolved first, so there is no key the opt-out
 *   could serve; `keys: "verbatim"` governs the empty segment, which is a real
 *   object name on these backends, and nothing else;
 * - the reserved prefixes are also tested against the key with `\` read as
 *   `/` and its doubled slashes collapsed, since a URL parser or a backend
 *   that merges them resolves `/.uploads/x`, `.uploads//x` and `.uploads\x`
 *   into the workspace.
 *
 * Internal: not exported from the package root.
 */
export function urlKeyGuard(
    reservedPrefix: string | readonly string[],
    opts: ReservedKeyGuardOptions = {},
): (key: string) => void {
    return keyGuard(reservedPrefix, opts, true);
}

function keyGuard(
    reservedPrefix: string | readonly string[],
    opts: ReservedKeyGuardOptions,
    urlBuilt: boolean,
): (key: string) => void {
    const { keys = "plain", foldCase = false, maxKeyBytes } = opts;
    if (maxKeyBytes !== undefined && !(Number.isSafeInteger(maxKeyBytes) && maxKeyBytes > 0)) {
        throw new TypeError("maxKeyBytes must be a positive integer");
    }
    const fold = foldCase ? foldKey : (value: string) => value;
    const prefixes = (typeof reservedPrefix === "string" ? [reservedPrefix] : reservedPrefix)
        .filter((p) => p !== "")
        .map((p) => {
            const stem = p.endsWith("/") ? p.slice(0, -1) : p;
            if (!isPlainObjectKey(stem)) {
                throw new TypeError(
                    "reservedPrefix must be a plain key path (no leading '/', no '.' or '..' segment, no empty segment); this prefix would reserve nothing",
                );
            }
            return fold(`${stem}/`);
        });
    const bare = prefixes.map((p) => p.slice(0, -1));
    return (key: string): void => {
        // First, so no later reading of the key costs more than the cap allows.
        if (maxKeyBytes !== undefined && exceedsUtf8Bytes(key, maxKeyBytes)) throw new ObjectNotFoundError(key);
        // A prefix test only holds for a key that names itself: one with a dot or empty segment can be
        // resolved into the reserved namespace by whatever builds the request URL from it.
        if (urlBuilt && hasDotSegment(key)) throw new ObjectNotFoundError(key);
        if (keys === "plain" && !isPlainObjectKey(key)) throw new ObjectNotFoundError(key);
        if (prefixes.length === 0) return;
        const reserved = (spelled: string): boolean =>
            bare.includes(spelled) || prefixes.some((p) => spelled.startsWith(p));
        if (reserved(fold(key))) throw new ObjectNotFoundError(key);
        // Collapsed in normal form NFKC, so a fullwidth `／` or `＼` counts as the separator it folds to.
        if (
            urlBuilt &&
            reserved(
                fold(
                    key
                        .normalize("NFKC")
                        .replace(/[/\\]+/g, "/")
                        .replace(/^\//, ""),
                ),
            )
        )
            throw new ObjectNotFoundError(key);
    };
}

/**
 * A key folded the way a case-insensitive volume equates names: compatibility
 * normalization (U+017F long s reads as `s`), lower case, and the dotless
 * `ı` (U+0131), which has no case mapping to `i` but is matched to it by
 * locale-aware volumes.
 */
function foldKey(value: string): string {
    return value.normalize("NFKC").toLowerCase().replaceAll("ı", "i");
}

/**
 * Whether a store refuses a key with an empty or dot segment.
 *
 * - `"plain"`: refuse it, as not found. The default wherever a URL path is
 *   built from the key (an HTTP origin, Azure's blob URL, S3 over a
 *   fetch-based handler), because the path is resolved before the backend
 *   sees it.
 * - `"verbatim"`: take every key as an opaque name. The default where the
 *   backend receives the key without resolving it (the R2 binding, the GCS
 *   client, which percent-encodes the whole object name), or where the key was
 *   already resolved to a path and checked (the filesystem store).
 *
 * On a store that builds a URL path from the key (`s3Store`, `azureStore`,
 * `httpStore`) a `.` or `..` segment is refused under either policy: a URL is
 * resolved before the backend sees it, so no object is named by such a key and
 * `"verbatim"` only lets the empty segment through (`reports//q1.pdf`, a real
 * name on S3 and Azure). `httpStore`, which hands the raw key to a
 * consumer-built URL, also refuses under either policy a key that would leave
 * the URL's base (see `HttpStoreOptions.keys`).
 */
export type KeyPolicy = "plain" | "verbatim";

/** Options for {@link reservedKeyGuard}. */
export interface ReservedKeyGuardOptions {
    /** @default "plain" */
    keys?: KeyPolicy;
    /**
     * Compare the prefixes case-insensitively and in Unicode normal form NFKC.
     * Case sensitivity is a property of the volume behind an origin, not of
     * this runtime, so an origin over a case-insensitive volume answers
     * `.UPLOADS/x` with the `.uploads/x` workspace. Folding refuses a key that
     * differs from the prefix only by case, which is a refusal, never a
     * disclosure.
     * @default false
     */
    foldCase?: boolean;
    /**
     * Refuse, as not found, a key longer than this many UTF-8 bytes, before
     * any other test reads it. Set it to the backend's own name limit (S3,
     * R2, GCS and Azure stop at 1,024 bytes), so the refusal costs no object
     * and the work spent on a key the requester chose stays bounded.
     * @default no limit
     */
    maxKeyBytes?: number;
}

/**
 * The name limit S3, R2, GCS and Azure Blob Storage share: an object name is
 * at most 1,024 bytes of UTF-8, so a longer key names nothing there.
 */
export const BUCKET_KEY_MAX_BYTES = 1024;

/** Whether `key` is longer than `max` bytes of UTF-8, without encoding a key that is far too long. */
export function exceedsUtf8Bytes(key: string, max: number): boolean {
    // A UTF-16 code unit is 1 to 3 bytes of UTF-8 (a surrogate pair is 4 for 2 units).
    if (key.length > max) return true;
    if (key.length * 3 <= max) return false;
    return utf8ByteLength(key) > max;
}

/**
 * A dot segment as the WHATWG URL Standard (section 4.1, "single-dot" and
 * "double-dot URL path segment") reads one: `.` or `..`, with any dot spelled
 * `%2e` in either case.
 */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
/**
 * Text as the URL parser reads it: the basic URL parser (WHATWG URL
 * Standard, section 4.1) removes every ASCII tab and newline from its input
 * before it splits the path, so `.\t.` is the `..` segment and `\t` is an
 * empty one.
 */
export function asUrlParserReads(text: string): string {
    return text.replace(/[\t\n\r]/g, "");
}

/**
 * Whether `key` names an object as written, with no segment a URL or path
 * resolver would rewrite: no empty segment (a leading, trailing or doubled
 * `/`, which a merging origin collapses) and no `.` or `..` segment in any
 * spelling. `\` counts as a separator, as it does in an `http:` or `https:`
 * URL. A key that fails can reach a different object than the one a prefix
 * check judged, so the reserved-namespace guard refuses it.
 */
export function isPlainObjectKey(key: string): boolean {
    for (const segment of key.split(/[/\\]/)) {
        const read = asUrlParserReads(segment);
        if (read === "" || DOT_SEGMENT.test(read)) return false;
    }
    return true;
}

/**
 * Whether any segment of `key` is a dot segment in a spelling a URL path is
 * resolved from: `.` or `..` with any dot spelled `%2e`, the key read in
 * Unicode normal form NFKC before it is split (a fullwidth full stop is a dot,
 * a fullwidth solidus or reverse solidus a separator), with trailing spaces
 * ignored, and `\` as a separator. A wider reading than
 * {@link isPlainObjectKey}, because it decides an unconditional refusal.
 */
function hasDotSegment(key: string): boolean {
    for (const segment of key.normalize("NFKC").split(/[/\\]/)) {
        if (DOT_SEGMENT.test(withoutTrailingSpaces(asUrlParserReads(segment)))) return true;
    }
    return false;
}

function withoutTrailingSpaces(text: string): string {
    return withoutTrailing(text, " ");
}

/**
 * `text` without its trailing run of the characters in `chars`, in one pass
 * from the end. A `/[. ]+$/` replace is retried from every character of an
 * interior run, which is quadratic in a key the requester chooses.
 */
export function withoutTrailing(text: string, chars: string): string {
    let end = text.length;
    while (end > 0 && chars.includes(text.charAt(end - 1))) end--;
    return end === text.length ? text : text.slice(0, end);
}

/**
 * Thrown when a pinned read ({@link GetObjectOptions.ifMatch}) finds the
 * object changed since its validator was captured.
 *
 * Adapters map their backend's native rejection to this error (S3 412
 * PreconditionFailed, R2 `onlyIf` body-less response, Azure 412
 * ConditionNotMet, GCS etag mismatch). The web adapter treats it as a
 * signal to re-validate the request against the object's new state.
 */
export class ObjectChangedError extends Error {
    /** HTTP status hint: the pinned read's precondition failed. */
    readonly status = 412 as const;
    /** The storage key whose object changed. */
    readonly key: string;

    constructor(key: string, cause?: unknown) {
        super("Object changed since validation");
        this.name = "ObjectChangedError";
        this.key = key;
        if (cause !== undefined) this.cause = cause;
    }
}

/**
 * Thrown when a storage backend is transiently unavailable: overloaded,
 * throttling, or timing out after the adapter's own retries are exhausted.
 *
 * A generic store failure (a malformed response, an unparseable
 * `Content-Range`, an empty body) is reported by the framework adapter as
 * `502 Bad Gateway` -- "the upstream returned something invalid." This error
 * is the distinct RETRYABLE case: the upstream is healthy but momentarily
 * cannot serve. The web adapter maps it to `503 Service Unavailable` and, when
 * {@link retryAfterSeconds} is set, emits a `Retry-After` header so clients and
 * shared caches back off instead of hammering an origin that is already shedding
 * load. Adapters map their backend's throttle signals here (S3/R2/Hetzner
 * `503 SlowDown`, `429 TooManyRequests`, Azure's server-side
 * `OperationTimedOut`). Network-level client failures (connection refused,
 * local timeouts) are NOT this: they propagate untouched and map to 502.
 */
export class StoreUnavailableError extends Error {
    /** HTTP status hint: the backend is transiently unavailable. */
    readonly status = 503 as const;
    /** The storage key whose read failed. */
    readonly key: string;
    /**
     * Suggested back-off in whole seconds, echoed as `Retry-After`. Normalized at
     * construction: a non-negative finite hint is floored to an integer (a
     * fractional `2.9` -> `2`) and capped at one day, and a NaN/negative/infinite hint
     * (from a hostile backend header or a buggy third-party classifier) is dropped
     * entirely. So every consumer -- the web adapter AND anyone reading
     * `.retryAfterSeconds` directly off the frozen contract -- sees a clean
     * non-negative integer or `undefined`. Absent means the adapter emits `503`
     * without a `Retry-After` (RFC 9110 Section 15.6.4 permits its absence).
     */
    readonly retryAfterSeconds?: number;

    constructor(key: string, opts?: { retryAfterSeconds?: number; cause?: unknown }) {
        super("Storage backend unavailable");
        this.name = "StoreUnavailableError";
        this.key = key;
        const hint = parseRetryAfterSeconds(opts?.retryAfterSeconds);
        if (hint !== undefined) this.retryAfterSeconds = hint;
        if (opts?.cause !== undefined) this.cause = opts.cause;
    }
}

/**
 * Name-based matchers for the store errors. `instanceof` is unreliable across package boundaries: a consumer
 * with two copies of this package in its tree, or a store built against a
 * different install, throws an error that is structurally right and fails the
 * check. The name is the stable identity.
 */
export function isObjectNotFoundError(err: unknown): err is ObjectNotFoundError {
    return isErrorNamed(err, "ObjectNotFoundError");
}
export function isObjectChangedError(err: unknown): err is ObjectChangedError {
    return isErrorNamed(err, "ObjectChangedError");
}

/**
 * `value instanceof Kind`, or `false` when the test throws: it runs a Proxy's
 * `getPrototypeOf` trap or a class's own `Symbol.hasInstance`, and a caught
 * value is arbitrary.
 */
export function isInstance<T>(value: unknown, Kind: abstract new (...args: never[]) => T): value is T {
    try {
        return value instanceof Kind;
    } catch {
        // Unreadable, so not an instance any classifier here recognises.
        return false;
    }
}

/**
 * Whether `err` is an `Error` with this `name`. Total: a thrown value is
 * arbitrary (a Proxy, an object with a throwing getter), and a classifier that
 * throws replaces the failure it was asked to classify.
 */
export function isErrorNamed(err: unknown, name: string): boolean {
    try {
        return err instanceof Error && err.name === name;
    } catch {
        // Unreadable, so not an error any classifier here recognises.
        return false;
    }
}

/**
 * One property of a thrown value, or `undefined` when reading it throws. A
 * throwing getter or a Proxy trap carries its own error, whose message is free
 * text; the projection must stay total so that text never escapes it.
 */
export function readField(obj: object, field: string): unknown {
    try {
        return (obj as Record<string, unknown>)[field];
    } catch {
        // The read's own error is dropped on purpose: its text is what the projection withholds.
        return undefined;
    }
}

/** A {@link ReadRange} as a `Range` request field: `bytes=a-b`, or the open `bytes=a-` when it has no end. */
export function rangeHeaderValue(range: ReadRange): string {
    return `bytes=${range.start}-${range.end ?? ""}`;
}

/**
 * The value at `path` under a thrown value (`readPath(err, "$metadata",
 * "httpStatusCode")`), or `undefined` when any step is not an object or its
 * read throws. How a classifier reads an SDK error: the error is arbitrary.
 */
export function readPath(value: unknown, ...path: string[]): unknown {
    let at = value;
    for (const field of path) {
        if ((typeof at !== "object" && typeof at !== "function") || at === null) return undefined;
        at = readField(at, field);
    }
    return at;
}

/** An integer HTTP status code, 100 to 599. */
function isHttpStatus(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

/**
 * The shape of an error class name or code (`AbortError`, `ECONNREFUSED`,
 * `ERR_SOCKET_TIMEOUT`): a string of any other shape is free text and is not
 * projected.
 */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** How deep a cause chain is followed before {@link projectError} stops. */
const REDACT_CAUSE_DEPTH = 8;

/**
 * The allow-listed form of an error bound for a sink that must not see the
 * storage key. Only fields that name a failure class pass: an
 * identifier-shaped `name` (otherwise `"Error"`), an identifier-shaped or
 * finite numeric `code`, an integer `status` from 100 to 599, the
 * failed `operation`, and the `cause` projected the same way. A field whose
 * read throws is left out. The message, the stack and every other
 * property stay behind, because the key can sit in any of them in any
 * spelling (a percent-encoded request path, a resolved filesystem path).
 */
export interface ProjectedError {
    name: string;
    code?: string | number;
    status?: number;
    operation?: string;
    cause?: ProjectedError;
}

/**
 * Project `err` to a {@link ProjectedError}. A thrown non-object projects to
 * its `typeof`; a cause chain (a cycle included) stops at a fixed depth.
 */
export function projectError(err: unknown, operation?: string, depth = 0): ProjectedError {
    const out: ProjectedError = { name: typeof err };
    if (typeof err === "object" && err !== null) {
        const name = readField(err, "name");
        const code = readField(err, "code");
        const status = readField(err, "status");
        const cause = readField(err, "cause");
        out.name = typeof name === "string" && IDENTIFIER.test(name) ? name : "Error";
        if (
            (typeof code === "string" && IDENTIFIER.test(code)) ||
            (typeof code === "number" && Number.isFinite(code))
        ) {
            out.code = code;
        }
        if (isHttpStatus(status)) out.status = status;
        if (cause !== undefined && depth < REDACT_CAUSE_DEPTH) out.cause = projectError(cause, undefined, depth + 1);
    }
    if (operation !== undefined) out.operation = operation;
    return out;
}

export function isStoreUnavailableError(err: unknown): err is StoreUnavailableError {
    return isErrorNamed(err, "StoreUnavailableError");
}

/**
 * The longest back-off this package relays, in seconds (one day). A longer
 * hint is a malformed or hostile one, and relaying it would park a client's
 * retry for as long as the number says.
 */
const MAX_RETRY_AFTER_SECONDS = 86_400;

/**
 * Normalize a `Retry-After` value to whole non-negative seconds, or `undefined`.
 *
 * The single sanctioned parser shared by every adapter and the web layer.
 * Accepts the delay-seconds form (a number, or a string of digits) and -- when
 * `allowHttpDate` is set -- an HTTP-date in one of the three RFC 9110 Section
 * 5.6.7 forms, as a non-negative delta from now. Everything else yields
 * `undefined`: NaN, Infinity, negatives, and any text outside those two
 * grammars (`1.5`, `+7`, a partial date), which is never read as "retry now".
 * A delay longer than one day is capped at one day. A hostile header or a
 * buggy third-party classifier therefore can never emit a malformed or
 * unbounded header.
 */
export function parseRetryAfterSeconds(raw: unknown, opts?: { allowHttpDate?: boolean }): number | undefined {
    if (typeof raw === "number") {
        if (!Number.isFinite(raw) || raw < 0) return undefined;
        return Math.min(Math.floor(raw), MAX_RETRY_AFTER_SECONDS);
    }
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS);
    if (opts?.allowHttpDate) {
        const when = parseRequestHttpSeconds(trimmed);
        if (Number.isNaN(when)) return undefined;
        return Math.min(Math.max(0, Math.round((when - Date.now()) / 1000)), MAX_RETRY_AFTER_SECONDS);
    }
    return undefined;
}

/**
 * The advised back-off in an SDK error's response headers, as whole seconds.
 *
 * The classifiers run on arbitrary error shapes, so the access is structural
 * and total: `headers` may be a `Headers`-like object with a `get` method or a
 * plain record, and a missing header, a non-function `get`, or a getter that
 * throws all yield `undefined`. A throw here would replace the throttle the
 * classifier is deciding and turn a 429 or 503 into a 502.
 */
export function retryAfterFrom(headers: unknown): number | undefined {
    if (typeof headers !== "object" || headers === null) return undefined;
    try {
        const get = (headers as { get?: unknown }).get;
        const raw =
            typeof get === "function"
                ? (get as (name: string) => unknown).call(headers, "retry-after")
                : (headers as Record<string, unknown>)["retry-after"];
        return parseRetryAfterSeconds(raw, { allowHttpDate: true });
    } catch {
        // A hostile or buggy header bag must not replace the throttle verdict.
        return undefined;
    }
}

/**
 * End a read that cannot be served: release whatever the backend left open,
 * then throw `err`. A release that throws or rejects never masks `err`, which
 * is the failure the caller needs to classify.
 */
export function failRead(release: () => unknown, err: unknown): never {
    try {
        const released = release();
        if (released instanceof Promise) released.catch(() => undefined);
    } catch {
        // Best effort: the read's own failure is what surfaces.
    }
    throw err;
}

// ─── Error Classification ─────────────────────────────────────────────────────

/**
 * Per-backend predicates that map a thrown SDK error to the contract's error
 * types. An adapter supplies one set and reuses it for both `headObject` and
 * `getObject`: a HEAD without a conditional never produces a `changed` (412),
 * so sharing the set costs nothing and keeps the two paths provably symmetric.
 */
export interface StoreErrorClassifiers {
    /** The object does not exist (maps to {@link ObjectNotFoundError}, 404). */
    notFound(err: unknown): boolean;
    /**
     * A pinned read's precondition failed (maps to {@link ObjectChangedError},
     * 412). Omit for backends whose pin is an etag/metadata comparison rather
     * than a native conditional error (e.g. GCS).
     */
    changed?(err: unknown): boolean;
    /**
     * Transient throttle/overload (maps to {@link StoreUnavailableError}, 503).
     * Return `true` for a throttle with no back-off hint, or
     * `{ retryAfterSeconds }` to surface a backend's `Retry-After` so the 503
     * echoes it and shared caches back off for the advised interval. Return
     * `false` when the error is not a throttle.
     */
    throttled(err: unknown): boolean | { retryAfterSeconds: number };
}

/**
 * Run a backend read and normalize its failures to the contract's error types.
 *
 * This is the single ordered classification pipeline every SDK-backed adapter
 * shares: `notFound` -> `changed` -> `throttled` -> rethrow. Centralizing it
 * means the "which errors are handled, in what order" contract is structural
 * rather than copy-pasted into each adapter's head/get catch blocks, so a
 * classifier can never be present on one path and silently missing on another.
 * The predicates MUST be mutually exclusive on a given backend (a 404, 412, and
 * 429/503 are distinct); the order only decides precedence if they are not.
 *
 * @example
 * ```typescript
 * const meta = await classifyStoreRead(key, () => client.headObject(key), {
 *   notFound: isNotFound,
 *   changed: isPreconditionFailed,
 *   throttled: isThrottled,
 * });
 * ```
 */
export async function classifyStoreRead<T>(
    key: string,
    op: () => Promise<T>,
    classifiers: StoreErrorClassifiers,
): Promise<T> {
    try {
        return await op();
    } catch (err) {
        // Each classifier runs on an arbitrary thrown value; one that throws on it
        // answers "not this class", so its own error never replaces the failure.
        const classified = <R>(classify: ((e: unknown) => R) | undefined): R | false => {
            try {
                return classify ? classify(err) : false;
            } catch {
                // Unreadable to this classifier.
                return false;
            }
        };
        if (classified(classifiers.notFound)) throw new ObjectNotFoundError(key, err);
        if (classified(classifiers.changed)) throw new ObjectChangedError(key, err);
        const throttled = classified(classifiers.throttled);
        if (throttled) {
            throw new StoreUnavailableError(key, {
                cause: err,
                // `throttled` may return the backend's advised back-off; a bare `true`
                // means "throttled, no hint" and emits a 503 without `Retry-After`.
                retryAfterSeconds: typeof throttled === "object" ? throttled.retryAfterSeconds : undefined,
            });
        }
        throw err;
    }
}

// ─── Read Options ───────────────────────────────────────────────────────────

/** Options for `headObject`. */
export interface HeadObjectOptions {
    /**
     * Cancel signal. Pass `req.signal` to cancel the backend request when the
     * client disconnects.
     */
    signal?: AbortSignal;
}

/**
 * Options for `getObject`.
 *
 * `ifMatch` pins the read to the representation whose validator was captured
 * by a prior `headObject` -- pass the RAW backend ETag from
 * {@link ObjectMetadata.etag}, not a derived/formatted one, and only a
 * STRONG validator (never `W/`-prefixed). Adapters map it to their backend's
 * native conditional read (S3 `IfMatch`, R2 `onlyIf.etagMatches`, Azure
 * `conditions.ifMatch`, GCS etag + generation pinning), making the HEAD->GET
 * pair atomic: either the exact validated bytes are streamed, or the adapter
 * throws {@link ObjectChangedError}.
 *
 * A store that reports `etag` or `lastModified` from `headObject` either
 * enforces `ifMatch` (and says so with {@link ObjectStore.pinsReads}) or
 * reports the same validator from `getObject`, which is what the read is
 * compared against when it cannot be pinned.
 */
export interface GetObjectOptions {
    /**
     * Validated byte range to stream. Omit for full content. `end` is
     * `undefined` for a read to the end of the object ({@link ReadRange}).
     */
    range?: ReadRange;
    /**
     * Cancel signal. Cancels the backend stream when the client disconnects,
     * preventing orphaned TCP connections.
     */
    signal?: AbortSignal;
    /** Raw backend ETag the object must still match (strong validators only). */
    ifMatch?: string;
    /**
     * Opaque pin token from a prior `headObject` on the same key
     * ({@link ObjectMetadata.pin}), passed back verbatim. Adapters that issue
     * pins use it to stream the exact validated representation without
     * re-fetching metadata; when the pinned version no longer exists they
     * throw {@link ObjectChangedError}. Adapters that never issue pins
     * ignore it.
     */
    pin?: string;
}

// ─── Node Stream Conversion ─────────────────────────────────────────────────

/**
 * Convert a Node.js readable stream (async iterable) to a web ReadableStream
 * with proper backpressure, Buffer coercion, signal propagation, and cleanup.
 *
 * This is the single implementation shared by all Node.js-based adapters
 * (fs, GCS, Azure, S3 fallback). It handles:
 *
 * - **Pull-based backpressure**: the web ReadableStream's `pull()` method
 *   drives the async iterator, so chunks are only read when the consumer
 *   is ready.
 * - **Buffer to Uint8Array coercion**: Node.js streams yield `Buffer`
 *   instances. We coerce to `Uint8Array` for cross-runtime compatibility
 *   (Buffer extends Uint8Array in Node, but the `instanceof` check
 *   ensures correctness in edge cases).
 * - **AbortSignal propagation**: when the client disconnects (signal aborts),
 *   the underlying node stream is destroyed immediately to stop I/O.
 * - **Cancel cleanup**: when the web ReadableStream is cancelled (e.g. by
 *   `Response.body.cancel()`), the node stream is destroyed.
 *
 * @param iterable - The async iterable (Node.js Readable stream). Typed
 *   `AsyncIterable<Uint8Array>` (Node `Buffer` extends `Uint8Array`, so Buffer
 *   streams satisfy it) to keep the `Buffer` name -- and its `@types/node`
 *   coupling -- out of the package's public type surface.
 * @param opts.destroy - Destroys the underlying stream on cancel/abort. When
 *   omitted, a `destroy()` method on the iterable is auto-detected and used.
 * @param opts.signal - Optional AbortSignal for client-disconnect detection
 * @param opts.expectedBytes - Exact byte count the source promised. When set,
 *   a graceful end that delivered a different total (a file truncated or grown
 *   in place mid-read) errors the web stream instead of closing it short, so a
 *   torn body can never masquerade as a complete response under the committed
 *   `Content-Length`. A client abort tears down via a thrown iterator error,
 *   not a graceful end, so it is unaffected by this check.
 */
export function nodeStreamToWeb(
    iterable: AsyncIterable<Uint8Array>,
    opts?: {
        destroy?: () => void;
        signal?: {
            addEventListener(type: "abort", listener: () => void): void;
            removeEventListener?(type: "abort", listener: () => void): void;
        };
        expectedBytes?: number;
    },
): ReadableStream<Uint8Array<ArrayBuffer>> {
    const { signal, expectedBytes } = opts ?? {};
    let seen = 0;
    // Auto-detect the Node-stream destroy capability when the caller doesn't
    // supply one: every adapter was hand-rolling the same
    // `typeof stream.destroy === "function"` guard.
    const nativeDestroy = (iterable as AsyncIterable<Uint8Array> & { destroy?: () => void }).destroy;
    const destroy =
        opts?.destroy ?? (typeof nativeDestroy === "function" ? () => nativeDestroy.call(iterable) : undefined);

    // Propagate abort signal to the underlying stream. The listener MUST be
    // removed once the stream settles: a consumer that reuses one long-lived
    // signal across many getObject calls would otherwise accumulate one
    // listener (and one retained stream reference) per completed transfer
    // until the signal is aborted or GC'd.
    if (signal && destroy) signal.addEventListener("abort", destroy);
    const detach = () => {
        if (signal && destroy) signal.removeEventListener?.("abort", destroy);
    };

    const iterator = iterable[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
            let result: IteratorResult<Uint8Array>;
            try {
                result = await iterator.next();
            } catch (err) {
                // Stop backend I/O when iteration fails, then error the web stream.
                // Without this, a mid-transfer backend failure leaks the socket.
                detach();
                destroy?.();
                throw err;
            }
            if (result.done) {
                detach();
                // A graceful end that under- or over-ran the promised length means the
                // source changed under an already-committed Content-Length: fail the
                // body loudly (a reset the client sees as a failed transfer) rather
                // than deliver a truncated stream that looks complete.
                if (expectedBytes !== undefined && seen !== expectedBytes) {
                    destroy?.();
                    controller.error(
                        new Error(
                            `stream delivered ${seen} bytes, expected ${expectedBytes} (source changed mid-read)`,
                        ),
                    );
                    return;
                }
                controller.close();
            } else {
                // Node.js streams yield Buffer; ensure Uint8Array for cross-runtime compat.
                // Node Buffers and adapter chunks are ArrayBuffer-backed, so the narrow
                // is runtime-safe and lets the web stream advertise a BodyInit-assignable
                // Uint8Array<ArrayBuffer> (the same narrowing guardStreamLength makes).
                const raw = result.value instanceof Uint8Array ? result.value : Buffer.from(result.value);
                const chunk = raw as Uint8Array<ArrayBuffer>;
                // Withheld on crossing the committed length, as in guardStreamLength:
                // the overrun never reaches the consumer ahead of the error.
                if (expectedBytes !== undefined && seen + chunk.byteLength > expectedBytes) {
                    detach();
                    destroy?.();
                    controller.error(
                        new Error(`stream delivered more than ${expectedBytes} bytes (source changed mid-read)`),
                    );
                    return;
                }
                seen += chunk.byteLength;
                controller.enqueue(chunk);
            }
        },
        async cancel(reason) {
            detach();
            try {
                await iterator.return?.(reason);
            } catch {
                // Iterator cleanup failed; socket will be GC'd
            }
            destroy?.();
        },
    });
}

/**
 * Hand a body of known length to the runtime as a `FixedLengthStream` where
 * that global exists (Cloudflare Workers), which is how such a runtime learns
 * the length of a stream body: without it the body may be sent with chunked
 * transfer coding instead of the committed Content-Length. Elsewhere the
 * stream is returned unchanged.
 */
export function fixedLength(
    stream: ReadableStream<Uint8Array>,
    length: number,
): ReadableStream<Uint8Array<ArrayBuffer>> {
    const Fixed = (
        globalThis as {
            FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>;
        }
    ).FixedLengthStream;
    return Fixed ? stream.pipeThrough(new Fixed(length)) : (stream as ReadableStream<Uint8Array<ArrayBuffer>>);
}

/**
 * Wrap a web `ReadableStream` so a graceful end that delivered a byte count
 * other than `expectedBytes` errors the stream instead of closing it short.
 *
 * The Node-stream path gets this guard inside {@link nodeStreamToWeb}. This is
 * the equivalent for adapters whose SDK hands back a web `ReadableStream`
 * directly (S3 in Bun/Deno or via `transformToWebStream`, R2's native binding,
 * a browser `Blob` stream) rather than a Node `Readable`. Without it, an
 * S3-compatible backend that ends a body cleanly but short of the committed
 * `Content-Length` (some do in-flight body retries) would under-run the
 * response undetected -- the exact truncation `expectedBytes` exists to catch.
 * Passing `undefined` disables the check and returns the stream unwrapped.
 */
export function guardStreamLength(
    stream: ReadableStream<Uint8Array>,
    expectedBytes: number | undefined,
): ReadableStream<Uint8Array<ArrayBuffer>> {
    // Return position narrows to <ArrayBuffer> (backend byte chunks are always
    // ArrayBuffer-backed) so the guarded body stays `new Response(...)`-assignable
    // under DOM lib; the input stays wide for callers.
    if (expectedBytes === undefined) return stream as ReadableStream<Uint8Array<ArrayBuffer>>;
    let seen = 0;
    const guarded = stream.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
            transform(chunk, controller) {
                // A chunk that crosses the committed length is withheld: the bytes
                // past it belong to a representation the caller did not commit to,
                // and enqueuing them first would put them on the wire before the
                // error the flush would raise.
                if (seen + chunk.byteLength > expectedBytes) {
                    controller.error(
                        new Error(`stream delivered more than ${expectedBytes} bytes (source changed mid-read)`),
                    );
                    return;
                }
                seen += chunk.byteLength;
                controller.enqueue(chunk as Uint8Array<ArrayBuffer>);
            },
            flush(controller) {
                // A short (or long) graceful end means the source diverged from the
                // committed length: fail the body loudly rather than deliver a
                // truncated stream that looks complete. Mirrors nodeStreamToWeb.
                if (seen !== expectedBytes) {
                    controller.error(
                        new Error(
                            `stream delivered ${seen} bytes, expected ${expectedBytes} (source changed mid-read)`,
                        ),
                    );
                }
            },
        }),
    );
    // Last, so the body the runtime receives is the fixed-length one.
    return fixedLength(guarded, expectedBytes);
}

// ─── Body Narrowing ─────────────────────────────────────────────────────────

/**
 * The body form {@link ObjectStream.body} carries: `ArrayBuffer`-backed, so a
 * consumer can hand it straight to `new Response(...)` under `lib: ["DOM"]`,
 * where `BodyInit` excludes `SharedArrayBuffer`-backed views.
 */
export type ObjectBody = ReadableStream<Uint8Array<ArrayBuffer>> | Uint8Array<ArrayBuffer>;

/**
 * The body forms a store may already be holding, before it commits to the
 * narrower {@link ObjectBody}. `Buffer` and `ReadableStream<Uint8Array>` both
 * land here: a `Buffer` is typed over `ArrayBufferLike` wherever the Node
 * typings in use predate `NonSharedBuffer`, and an SDK that hands back a web
 * stream types its chunks as bare `Uint8Array`.
 */
export type ObjectBodySource = ReadableStream<Uint8Array> | Uint8Array;

/**
 * Narrow a store's body to the {@link ObjectBody} form the read path serves.
 *
 * Wide in, narrow out, the same split {@link guardStreamLength} applies to
 * streams: a store keeps whatever type its source gave it and the narrowing
 * is decided here rather than at a cast in each adapter.
 *
 * Bytes are narrowed by inspection, so a `SharedArrayBuffer`-backed view is
 * copied into its own `ArrayBuffer` instead of being relabelled: that view
 * is the one input `new Response(...)` genuinely rejects, and a relabel would
 * move the failure from this call to the consumer's response construction.
 * Streams keep the chunk-level assumption {@link guardStreamLength}
 * documents, since a per-chunk copy would defeat streaming.
 *
 * @example
 * ```typescript
 * import { readFile } from "node:fs/promises";
 * import { toObjectBody } from "partial-content";
 *
 * const body = toObjectBody(await readFile("/data/report.pdf"));
 * ```
 */
export function toObjectBody(source: ObjectBodySource): ObjectBody {
    if (source instanceof Uint8Array) {
        return isArrayBufferBacked(source) ? source : new Uint8Array(source);
    }
    // `undefined` disables the length guard and returns the stream unwrapped,
    // so this costs nothing beyond the narrowing itself.
    return guardStreamLength(source, undefined);
}

/** Whether a view is backed by an `ArrayBuffer` rather than a `SharedArrayBuffer`. */
function isArrayBufferBacked(view: Uint8Array): view is Uint8Array<ArrayBuffer> {
    return view.buffer instanceof ArrayBuffer;
}

// ─── Storage Metadata ───────────────────────────────────────────────────────

/**
 * Metadata from a HEAD request -- enough to evaluate conditionals before
 * any body transfer.
 */
export interface ObjectMetadata {
    /** Full object size in bytes. */
    contentLength: number;
    /** Backend ETag, if any (already quoted or `W/`-prefixed -- pass through `generateETag`). */
    etag?: string;
    /** Last-Modified, in whatever format the backend emits (`Date.parse`-able). */
    lastModified?: string;
    /**
     * RFC 9530 SHA-256 digest of the full representation (raw base64, no prefix).
     *
     * When provided, the adapter emits `Repr-Digest: sha-256=:<base64>:` on
     * success responses for end-to-end integrity verification.
     *
     * Source it from a backend field that IS a SHA-256 of the object bytes:
     * S3 `x-amz-checksum-sha256` (checksummed uploads); R2 `checksums.sha256`.
     * GCS has no native SHA-256 (`x-goog-hash` carries only crc32c and md5,
     * neither of which may be framed as `sha-256`): store your own hash as
     * custom object metadata and point `gcsStore`'s `digestMetadataKey` at it.
     */
    digest?: string;
    /**
     * Opaque adapter token pinning a later `getObject` to this exact
     * representation. The orchestrator round-trips it verbatim into
     * {@link GetObjectOptions.pin} without interpreting it.
     *
     * Only needed by stores whose version identifier is not the ETag: GCS
     * encodes its generation (plus the size/validators `getObject` would
     * otherwise re-fetch), turning the HEAD->GET pair into a single backend
     * read. ETag-pinning stores (S3, R2, Azure, http) omit it -- `ifMatch`
     * already carries their pin.
     */
    pin?: string;
    /**
     * The media type the backend stored with the object, if it keeps one.
     * Informational only: the serving path never trusts it for
     * `Content-Type`, because a stored type is usually whatever the uploader
     * claimed. An omitted `mime` is served from the caller's choice or as
     * `application/octet-stream`; the value reaches audit events as
     * `storedContentType`.
     */
    contentType?: string;
    /**
     * The content coding the stored bytes are in (`gzip`, `br`, ...), when the
     * object was stored already encoded; omit it for identity bytes.
     *
     * The coding is representation metadata: `contentLength`, the ETag, the
     * digest and every byte range describe the ENCODED bytes (RFC 9110
     * Section 14.2), and the response carries `Content-Encoding` so the
     * client decodes them. A store whose backend or client library decodes
     * transparently MUST either turn that off so the bytes match
     * `contentLength`, or refuse the object; serving decoded bytes under the
     * encoded length is the corruption this field exists to prevent. Pass the
     * raw stored value through {@link representationCoding}.
     */
    contentEncoding?: string;
}

/**
 * Normalize a stored `Content-Encoding` value for {@link ObjectMetadata.contentEncoding}.
 *
 * - A coding in the IANA HTTP Content Coding Registry (`gzip`, `deflate`, `br`,
 *   `zstd`, `compress`, `aes128gcm`, `dcb`, `dcz`, `exi`, `pack200-gzip`;
 *   `x-gzip` and `x-compress` are spelled as their registered names) is
 *   returned lower-cased, as a comma list when the object was coded more than
 *   once. The store does not decode, so a registered coding it cannot itself
 *   decode is still served under its own name.
 * - `identity`, `none`, the upload-transfer marker `aws-chunked`, the MIME
 *   transfer-encoding names (`base64`, `binary`, `7bit`, `8bit`,
 *   `quoted-printable`) and anything that is plainly not a coding (a charset
 *   name, a media type, a value with whitespace, `;`, `=` or `/`) are
 *   identity: the value is `undefined`. Uploaders and legacy tooling store
 *   such values, and an object that 5.x served as identity bytes stays
 *   servable.
 * - Any other token throws a `TypeError`: serving bytes under a coding the
 *   client may not know is the corruption {@link ObjectMetadata.contentEncoding}
 *   exists to prevent, so a corrupt or unregistered stored value is a loud failure.
 */
export function representationCoding(stored: string | null | undefined): string | undefined {
    const codings: string[] = [];
    for (const member of (stored ?? "").split(",")) {
        const token = member.trim().toLowerCase();
        if (token === "" || IDENTITY_CODING.has(token) || NOT_A_CODING.test(token)) continue;
        const registered = REGISTERED_CODINGS[token];
        if (registered === undefined) throw new TypeError("stored content coding is not a registered coding");
        codings.push(registered);
    }
    return codings.length === 0 ? undefined : codings.join(", ");
}

const REGISTERED_CODINGS: Readonly<Record<string, string | undefined>> = Object.assign(Object.create(null), {
    gzip: "gzip",
    "x-gzip": "gzip",
    deflate: "deflate",
    br: "br",
    zstd: "zstd",
    compress: "compress",
    "x-compress": "compress",
    // Registered in the IANA HTTP Content Coding Registry: a client that knows
    // the coding decodes it, so the bytes are served under their own name.
    aes128gcm: "aes128gcm",
    dcb: "dcb",
    dcz: "dcz",
    exi: "exi",
    "pack200-gzip": "pack200-gzip",
});
/**
 * `identity`, the upload-transfer marker `aws-chunked`, `none`, and the MIME
 * Content-Transfer-Encoding names some uploaders write into this field: none
 * of them is a content coding, and each means the stored bytes are unencoded.
 */
const IDENTITY_CODING: ReadonlySet<string> = new Set([
    "identity",
    "aws-chunked",
    "none",
    "base64",
    "binary",
    "7bit",
    "8bit",
    "quoted-printable",
]);
/** A charset name, or a value no coding token can be: whitespace, `;`, `=` or `/` inside it. */
const NOT_A_CODING = /[\s;=/]|^(?:utf-?\d+|us-ascii|ascii|iso-8859-\d+|windows-\d+|latin-?1)$/;

// ─── Stream Result ──────────────────────────────────────────────────────────

/**
 * The byte range a backend actually served, inclusive on both ends
 * (`bytes start-end/total` without the total: {@link ObjectStream.totalSize}
 * carries it, or is `undefined` when the backend reported `bytes a-b/*`).
 *
 * SERVED is the operative word. An `authoritativeRange` store resolves the
 * range itself (it clamps past-EOF ends, and answers an open range), so the
 * orchestrator relays the span it answered after validating bounds, byte
 * counts and representation identity. Any other store was asked for a range
 * already resolved against a HEAD, and a served span that differs from it is
 * an incoherent store (a shifted label, or an object that changed): the read
 * is refused as a 502 rather than relabelled.
 */
export interface ServedRange {
    /** First byte position served (0-based, inclusive). */
    start: number;
    /** Last byte position served (inclusive). */
    end: number;
}

/** Served bounds plus honest total parsed from a backend `Content-Range`. */
export interface ResolvedContentRange {
    /** The byte range the backend actually served (inclusive bounds). */
    served: ServedRange;
    /**
     * Full representation size, or `undefined` for the `bytes a-b/*`
     * unknown-total sentinel (a streaming origin that does not know its length).
     */
    totalSize: number | undefined;
}

/**
 * Parse a backend `Content-Range` response header into served bounds plus an
 * honest total, applying the parser's `-1` unknown-total sentinel -> `undefined`
 * mapping that every SDK adapter needs identically. Returns `null` ONLY when the
 * header is present but unparseable -- the exact "byte accounting is
 * untrustworthy, tear down and fail loudly" signal, which each adapter pairs
 * with its own live-body cleanup (S3 `stream.cancel()`, Azure
 * `destroyAzureDownload`, http `drain`) before throwing.
 *
 * Adapters that treat an ABSENT header as a full 200 (S3, Azure) check for the
 * header before calling; callers that already know the response is partial
 * (http's 206 branch) treat both an absent header and a `null` here as the same
 * malformed-206 failure. Adapters that know their bounds natively (fs, memory,
 * GCS, R2) construct {@link ServedRange} directly and never call this.
 */
export function resolveServedRange(contentRange: string): ResolvedContentRange | null {
    const parsed = parseContentRange(contentRange);
    if (!parsed) return null;
    return {
        served: { start: parsed.start, end: parsed.end },
        totalSize: parsed.totalSize,
    };
}

/**
 * A body-transfer result from `getObject`.
 *
 * Every field is sourced from the **same GET response** -- including `etag`
 * and `lastModified`. Consumers MUST prefer these over any prior HEAD values
 * to avoid advertising stale validators against freshly-fetched bytes
 * (the HEAD->GET TOCTOU window).
 */
export interface ObjectStream {
    /**
     * The body: a `ReadableStream` for streamed transfers, or a plain
     * `Uint8Array` when the adapter already has the exact bytes in memory
     * (small files, in-memory stores). Byte bodies let consumers skip stream
     * machinery entirely -- server adapters write them in a single syscall
     * and `new Response(bytes)` takes the fetch runtime's static-body fast
     * path. Return whichever form is natural; never buffer large transfers
     * just to produce bytes.
     *
     * Typed `<ArrayBuffer>`-backed (not the wider `ArrayBufferLike`) so a
     * consumer can pass it straight to `new Response(...)` under `lib: ["DOM"]`
     * on TS >= 5.7, where `BodyInit` requires an `ArrayBuffer`-backed view.
     *
     * A store holding a wider value (a `Buffer<ArrayBufferLike>`, which older
     * Node typings return from `readFile`) passes it through {@link toObjectBody}, which
     * is the one place the narrowing is decided.
     *
     * **A stream body MUST be read to the end or cancelled.** It can hold an
     * operating-system resource that only those two paths release: the
     * filesystem store hands the reader a descriptor it opened, and a stream
     * neither drained nor cancelled keeps it open for the life of the process,
     * so a route that abandons bodies exhausts the descriptor table. Nothing
     * reclaims it later; a garbage collector frees the object, not the handle
     * underneath it. Every path in this package that stops early cancels, which
     * is the same obligation stated in code.
     */
    body: ObjectBody;
    /** Bytes in THIS response (range length for 206, full size for 200). */
    contentLength: number;
    /**
     * Full object size, independent of any range, or `undefined` when the
     * backend served a partial response with an unknown total (`bytes a-b/*`,
     * RFC 9110 Section 14.4) -- a streaming origin that does not know its full
     * length. Object stores (S3, R2, GCS, Azure) always know their sizes and
     * set a number; only proxied origins (the http adapter) legitimately leave
     * it `undefined`. Valid ONLY alongside a `range`: a full response carries a
     * concrete size in `contentLength`, so `undefined` with no `range` is an
     * adapter bug (the orchestrator emits 200 and needs the length).
     */
    totalSize: number | undefined;
    /**
     * The byte range the backend ACTUALLY served (inclusive bounds), or
     * `undefined` if it served full content.
     *
     * This is the source of truth for 206 vs 200: if a range was requested but
     * `range` is `undefined`, the backend ignored it -- emit 200, never a
     * lying 206. Adapters that receive a `Content-Range` string from their
     * backend parse it with {@link parseContentRange} and fail loudly on
     * garbage; adapters that know the bounds natively (fs, memory, GCS, R2)
     * construct this directly -- malformed range strings cannot exist in the
     * contract.
     */
    range?: ServedRange;
    /** ETag as returned by the GET (authoritative for this body). */
    etag?: string;
    /** Last-Modified as returned by the GET (authoritative for this body). */
    lastModified?: string;
    /**
     * RFC 9530 SHA-256 digest of the full representation (raw base64, no prefix).
     *
     * When provided by the GET response, the adapter can emit `Repr-Digest`
     * even on Path C (no prior HEAD). This closes the digest gap for
     * first-visit requests that skip the HEAD round-trip.
     *
     * S3: map from `x-amz-checksum-sha256` on GetObject response.
     */
    digest?: string;
    /**
     * The content coding the stored bytes are in (`gzip`, `br`, ...), when the
     * object was stored already encoded. Same meaning as
     * {@link ObjectMetadata.contentEncoding}; read it from the GET so it
     * describes the bytes the body carries.
     */
    contentEncoding?: string;
}

// ─── Store Contract ─────────────────────────────────────────────────────────

/**
 * Storage backend abstraction consumed by partial-content adapters.
 *
 * This contract is **read-only by design**. It covers the operations needed
 * to evaluate conditional requests and stream object content. Write operations
 * (PUT, PATCH, DELETE) remain the consumer's responsibility -- use
 * `evaluateConditionalWrite()` to evaluate preconditions, then perform the
 * write through your storage SDK directly.
 *
 * Implementations adapt a concrete store (S3/R2/Hetzner/GCS/fs) down to this
 * surface. The kernel and framework adapters depend only on this interface,
 * never on a storage SDK.
 *
 * @example
 * ```typescript
 * import type { ObjectStore } from "partial-content";
 *
 * const store: ObjectStore = {
 *   async headObject(key, opts) { ... },
 *   async getObject(key, opts) { ... },
 * };
 * ```
 */
export interface ObjectStore {
    /**
     * Fetch metadata without a body. Used to evaluate conditional requests
     * (304/412) and If-Range before deciding whether to transfer bytes.
     *
     * @param key - Object key within the bucket.
     * @param opts - Cancellation ({@link HeadObjectOptions}).
     */
    headObject: (key: string, opts?: HeadObjectOptions) => Promise<ObjectMetadata>;

    /**
     * Stream an object, optionally a byte range.
     *
     * The adapter receives a {@link ReadRange} in `opts.range` and formats it
     * for the backend ({@link rangeHeaderValue} for a `Range` field). `range.end` may exceed the
     * object size (RFC 9110 lets servers clamp a last-byte-pos past EOF, and
     * the fast range path uses an open end deliberately); adapters clamp it
     * and report the bounds ACTUALLY served. `range.start` beyond EOF is the
     * caller's error: local adapters throw a RangeError, remote backends
     * reject natively. Returns the actual transfer result -- including the
     * real `Content-Range` -- so the caller can build a truthful 200/206
     * from a single round-trip.
     *
     * @param key - Object key within the bucket.
     * @param opts - Range, cancellation, and pinning
     *   ({@link GetObjectOptions}). Stores that cannot pin reads may ignore
     *   `ifMatch`, provided the read reports the validators the HEAD did; the
     *   web adapter keeps a response-side guard (actual Content-Range + GET
     *   validators) for that case.
     */
    getObject: (key: string, opts?: GetObjectOptions) => Promise<ObjectStream>;

    /**
     * Capability flag: `getObject` enforces `ifMatch` (and the `pin` it issued)
     * itself and throws {@link ObjectChangedError} when the object no longer
     * matches. Set it `true` only for a store that does: the web adapter then
     * treats a pinned read as the HEAD's representation without comparing GET
     * validators, and emits the HEAD's validators and digest over it. A store
     * that ignores `ifMatch` leaves it unset, and a read with no validator of
     * its own to compare is served without the HEAD's ETag and digest.
     * `checkObjectStore` probes it.
     *
     * @default false
     */
    readonly pinsReads?: boolean;

    /**
     * Capability flag. When `false`, the framework adapter degrades gracefully
     * (e.g. signed-URL redirect) instead of attempting range streaming.
     * Omit or set `true` for any S3-compatible backend.
     *
     * @default true
     */
    readonly supportsRange?: boolean;

    /**
     * Capability flag: this adapter's ranged responses carry bounds and total
     * size taken from the BACKEND's actual response (`Content-Range`), not
     * echoed from the request. When `true`, the framework adapter skips the
     * validating HEAD for plain range requests (no conditionals, no
     * If-Range) and serves the seek in a single round-trip -- validators,
     * bounds, and digest all come from the GET response itself, which is
     * also inherently TOCTOU-atomic. Any adapter that clamps ranges itself,
     * rejects a start beyond EOF, and reports the SERVED bounds qualifies
     * (S3, HTTP, fs, memory). Leave unset for stores that echo the requested
     * range or fetch metadata themselves anyway (GCS).
     *
     * @default false
     */
    readonly authoritativeRange?: boolean;

    /**
     * Optional egress-offload path: returns a short-lived URL the client is
     * redirected to. Used for backends that cannot stream ranges through the
     * origin, and by the web adapter's `preferSignedUrl` per-request offload.
     *
     * Returns an outcome rather than throwing, unlike every other method on
     * this interface, because DECLINING and FAILING are different answers and
     * the caller acts on them differently. `{ ok: false }` says this store
     * cannot sign (no credential configured, a backend without the
     * capability), and the serving path falls back to streaming the bytes
     * itself, which is a correct response; `cause` may carry the underlying
     * error for the store's own diagnostics, and the optional `code` says why
     * in a form a caller can branch on: `"no-credential"` (no signing
     * credential is configured) or `"unsupported"` (the backend or this store
     * cannot sign). `code` may gain a member in a minor release: give a switch
     * over it a default branch. A thrown error says signing was
     * supposed to work and did not, which is reported and answered as a
     * backend failure. Collapsing the two would turn "no signing configured"
     * into a 502 on every request.
     *
     * `downloadFilename` is RAW untrusted input (the consumer's
     * ServeContext.filename, verbatim). Implementations that embed it in a
     * response-content-disposition query parameter or similar MUST sanitize it
     * (e.g. via `buildContentDisposition`), exactly as the streaming path does.
     *
     * `cacheControl`, when provided, SHOULD override the Cache-Control of the
     * signed response (S3 `response-cache-control` and equivalents). Without
     * it, the redirect target serves whatever Cache-Control was baked into the
     * object at upload -- a private document stored with a public/immutable
     * value would be cached by any CDN in front of the bucket.
     *
     * `signal` is the request's abort signal, for a signer that makes a
     * network call; a signer that rejects after it aborted is answered as a
     * client abort, not a backend failure.
     *
     * Two adapter-author traps this contract documents:
     * - **Temporary credentials cap expiry.** A URL presigned under STS/role
     *   credentials (Lambda, ECS task roles) dies when the SESSION TOKEN
     *   expires, regardless of `expiresInSeconds`. Effective lifetime is
     *   `min(expiresInSeconds, credential lifetime remaining)`; long-lived
     *   links need long-term credentials or a stable re-signing endpoint that
     *   302s per fetch.
     * - **CloudFront canned policies break on RFC 8187 dispositions.** A
     *   sanitized disposition carries `filename*=UTF-8''...`; browsers
     *   re-encode the apostrophes to `%27`, which no longer matches a
     *   canned-policy signature (AccessDenied). CloudFront signers must use a
     *   custom policy with a wildcard query (`...?*`).
     */
    createSignedUrl?(
        key: string,
        opts: { expiresInSeconds: number; downloadFilename?: string; cacheControl?: string; signal?: AbortSignal },
    ): Promise<
        | { ok: true; url: string }
        | { ok: false; error: string; code?: "no-credential" | "unsupported"; cause?: unknown }
    >;
}
