/**
 * Read-merge-conditional-write with a bounded retry, the shape every store
 * uses to update upload bookkeeping that more than one request can write.
 *
 * Internal: not a subpath export.
 *
 * @module
 */

/** What {@link casMerge} needs from a store. */
export interface CasMergeOptions<S, V> {
    /**
     * A FRESH read of the record, with the version token the write will pin
     * to. Never a snapshot the caller already holds.
     */
    read: () => Promise<S>;
    /**
     * The write to make, computed from the fresh read only, carrying the
     * version it pins to. Throws when the fresh read leaves no safe base.
     */
    merge: (fresh: S) => V;
    /** Make the write, conditional on the version `merge` carried. */
    write: (merged: V) => Promise<unknown>;
    /** True when `write` was refused because the record moved since `read`. */
    isConflict: (err: unknown) => boolean;
    /** Passes before a contended record fails the call; {@link CAS_MERGE_ATTEMPTS} when omitted. */
    attempts?: number | undefined;
    signal?: AbortSignal | undefined;
}

/**
 * How many times a merge re-reads and retries after the backend refuses its
 * conditional write. One loss is the stolen-lock case the condition exists
 * for; a record that changes under three consecutive merges is contended in a
 * way no retry resolves, and the merge fails rather than spinning.
 */
export const CAS_MERGE_ATTEMPTS = 3;

/**
 * Apply a merge to a record that other writers may change concurrently.
 *
 * Each pass reads the record, merges, and writes conditionally on the version
 * it read. A write refused as a conflict starts a new pass from a new read;
 * after `attempts` refusals the call throws instead of landing. Any other
 * failure, of the read, the merge or the write, propagates at once; only a
 * write's refusal is offered to `isConflict`.
 *
 * The retry makes the write safe only if `merge` is too. A merge must:
 *
 * - Compute from the FRESH record, never from a snapshot the caller held. A
 *   snapshot predates whatever another holder recorded since, so writing it
 *   back clears that record. A record that is gone, or that cannot be decoded,
 *   fails the call: corrupt bookkeeping is unreadable, not absent, and there
 *   is no safe base to write from.
 * - Keep every terminal flag MONOTONIC: once the fresh record has it set
 *   (invalidated, complete), the merged record has it set too.
 * - Keep every write-once fact from the fresh record when it has one: a
 *   recorded length, and the published ETag. A published ETag must never
 *   regress to an older value or to absent, whichever writer computed the
 *   patch.
 */
export async function casMerge<S, V>(opts: CasMergeOptions<S, V>): Promise<void> {
    const attempts = opts.attempts ?? CAS_MERGE_ATTEMPTS;
    for (let attempt = 1; ; attempt += 1) {
        opts.signal?.throwIfAborted();
        const merged = opts.merge(await opts.read());
        try {
            await opts.write(merged);
            return;
        } catch (err) {
            if (!opts.isConflict(err)) throw err;
            if (attempt >= attempts) {
                throw new Error(`upload state changed under ${attempt} consecutive merges`, { cause: err });
            }
        }
    }
}

/** The bookkeeping fields {@link mergePersistedState} protects. */
export interface MergeableUploadState {
    length?: number;
    etag?: string;
    isInvalidated: boolean;
    isComplete: boolean;
}

/**
 * Lay a writer's patch over the FRESH record by the rules {@link casMerge}
 * states: the patch applies, except that a length or published ETag the fresh
 * record already holds is kept, and a terminal flag the fresh record has set
 * stays set.
 */
export function mergePersistedState<S extends MergeableUploadState>(fresh: S, patch: NoInfer<Partial<S>>): S {
    return {
        ...fresh,
        ...patch,
        ...(fresh.length !== undefined ? { length: fresh.length } : {}),
        ...(fresh.etag !== undefined ? { etag: fresh.etag } : {}),
        isInvalidated: fresh.isInvalidated || patch.isInvalidated === true,
        isComplete: fresh.isComplete || patch.isComplete === true,
    };
}
