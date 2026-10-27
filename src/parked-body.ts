/**
 * A body whose first pull parks until `release` is called, and which reports
 * through `pulled` that the store has reached it. Everything a store reads
 * before the body (its record or sidecar, its part listing) has been read by
 * then, which is what lets a check act on the resource between a store's
 * state read and the write that ends the append: a stolen lock, or a sweep
 * that reaps the resource mid-append.
 */
export function parkedBody(chunk: Uint8Array): {
    body: ReadableStream<Uint8Array>;
    pulled: Promise<void>;
    release: () => void;
} {
    const pulled = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    // highWaterMark 0: a default queue pulls once at construction, which fires
    // `pulled` before the store has read anything and races the state read.
    const body = new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                pulled.resolve();
                await released.promise;
                controller.enqueue(chunk);
                controller.close();
            },
        },
        { highWaterMark: 0 },
    );
    return { body, pulled: pulled.promise, release: released.resolve };
}
