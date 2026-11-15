import type { ObjectStream } from "../object-store";

/** Read a body of either arm to the end, as UTF-8. */
export async function drain(body: ReadableStream<Uint8Array> | Uint8Array): Promise<string> {
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

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
