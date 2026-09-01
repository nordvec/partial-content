import type { ObjectStream } from "../object-store";

/**
 * Narrow a body to its streaming arm.
 *
 * `ObjectStream["body"]` is a union because the contract admits both, and
 * `memory` and `fs` genuinely return bytes on some paths. The adapters that
 * front a network backend can only ever produce the stream, so a test against
 * one of those would otherwise narrow the union at every call site.
 *
 * Throws rather than casting: if an adapter ever starts returning bytes, the
 * test that assumed otherwise should say so out loud instead of failing later
 * on a missing method.
 */
export function asStream(body: ObjectStream["body"]): ReadableStream<Uint8Array<ArrayBuffer>> {
    if (body instanceof Uint8Array) throw new Error("expected a streaming body, got bytes");
    return body;
}
