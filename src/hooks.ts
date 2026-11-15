/**
 * Consumer callbacks the handler invokes as side effects (`onServe`,
 * `onTransfer`, `onTiming`, `onError`). A callback may be async; the promise it
 * returns is observed, never awaited, so the return type is `unknown`: an async
 * function and an expression-bodied arrow that returns a value
 * (`(e) => events.push(e)`) are both assignable, and neither is a misused promise.
 */
export type Hook<Args extends unknown[]> = (...args: Args) => unknown;

/** The audit key an adapter reports when its extractor is configured and yields none. */
export const UNKEYED_AUDIT_KEY = "unkeyed";

/**
 * Wrap a consumer callback so it can fire from anywhere in the pipeline: a
 * synchronous throw and a rejected returned promise both go to `report`, and the
 * wrapper itself never throws or leaves a rejection unhandled. A failure of
 * `report` is swallowed, because there is no sink for the sink.
 */
export function guardHook<Args extends unknown[]>(
    hook: ((...args: Args) => unknown) | undefined,
    report: (err: unknown, ...args: Args) => void,
): ((...args: Args) => void) | undefined {
    if (!hook) return undefined;
    const contain = (err: unknown, args: Args): void => {
        try {
            report(err, ...args);
        } catch {
            /* the sink failed too; there is no further sink */
        }
    };
    return (...args: Args): void => {
        try {
            const out = hook(...args);
            if (typeof (out as PromiseLike<unknown> | undefined)?.then === "function") {
                (out as PromiseLike<unknown>).then(undefined, (err: unknown) => contain(err, args));
            }
        } catch (err) {
            contain(err, args);
        }
    };
}

/** Wrap an `onError` callback: its own failure, sync or async, is swallowed. */
export function guardSink<Args extends unknown[]>(
    sink: ((...args: Args) => unknown) | undefined,
): ((...args: Args) => void) | undefined {
    return guardHook(sink, () => {
        /* nothing receives a failure of the error sink */
    });
}
