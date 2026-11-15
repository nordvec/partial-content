/**
 * A bounded, expiring set of keys a handler has just asked its store about, so a
 * request does not repeat a probe the store answered a moment ago.
 *
 * The set is bounded three ways: an entry lives for `ttlMs`; at most `max`
 * entries are held, the oldest dropped first; and a key longer than
 * `maxKeyLength` is never held, because the key comes from the request path
 * and an attacker would otherwise choose the memory it pins. The time-to-live
 * is the same for every entry, so insertion order is expiry order and an
 * expired entry is always at the front.
 */
class RecentKeys {
    readonly #until = new Map<string, number>();
    readonly #ttlMs: number;
    readonly #max: number;
    readonly #maxKeyLength: number;

    constructor(ttlMs: number, max: number, maxKeyLength: number) {
        this.#ttlMs = ttlMs;
        this.#max = max;
        this.#maxKeyLength = maxKeyLength;
    }

    /** Whether `key` was remembered within the window. An expired entry is dropped on the way. */
    has(key: string, now: number): boolean {
        const until = this.#until.get(key);
        if (until === undefined) return false;
        if (until > now) return true;
        this.#until.delete(key);
        return false;
    }

    /** Remember `key` from `now`. */
    add(key: string, now: number): void {
        if (key.length > this.#maxKeyLength) return;
        this.#until.delete(key);
        for (const [oldest, until] of this.#until) {
            if (until > now && this.#until.size < this.#max) break;
            this.#until.delete(oldest);
        }
        this.#until.set(key, now + this.#ttlMs);
    }

    /** Forget `key`. */
    delete(key: string): void {
        this.#until.delete(key);
    }

    get size(): number {
        return this.#until.size;
    }
}

/** The not-found precompressed variants a handler has just asked its store about. `delete` = the variant was found. */
export class VariantMisses extends RecentKeys {}

/** The precompressed variants a handler has just had its store confirm. `delete` = the variant was found missing. */
export class VariantHits extends RecentKeys {}
