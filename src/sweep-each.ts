/**
 * The isolate-and-count loop behind every store's `sweepExpired`.
 *
 * Internal: not a subpath export.
 *
 * @module
 */

/**
 * Reclaim each listed resource in turn, isolating failures.
 *
 * One unreclaimable resource must not end the scan: a denied delete, a
 * throttled request or a record that stops being readable would otherwise
 * abandon every resource behind it in the listing, so a scheduled sweep could
 * reclaim nothing while reporting success by not throwing. Each failure is
 * counted in `failed`, which is what a caller alerts on, and the scan goes on.
 *
 * `reclaim` answers `true` when it removed the resource and `false` when the
 * resource is not due (or was already gone), which counts as neither. An abort
 * is the caller ending the sweep, not a resource resisting, so it rejects with
 * the signal's reason instead of being counted. The listing itself is not
 * isolated: a failure to enumerate leaves no resource to attribute it to.
 */
export async function sweepEach<T>(
    items: Iterable<T> | AsyncIterable<T>,
    reclaim: (item: T) => Promise<boolean>,
    opts?: { signal?: AbortSignal | undefined },
): Promise<{ removed: number; failed: number }> {
    let removed = 0;
    let failed = 0;
    for await (const item of items) {
        opts?.signal?.throwIfAborted();
        try {
            if (await reclaim(item)) removed += 1;
        } catch {
            opts?.signal?.throwIfAborted();
            failed += 1;
        }
    }
    return { removed, failed };
}
