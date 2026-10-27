import { describe, expect, test } from "bun:test";
import { redactErrorText } from "../object-store.ts";

const KEY = "tenants/t1/secret.pdf";
const SAFE = "<redacted>";

function asError(value: unknown): Error {
    if (!(value instanceof Error)) throw new Error("redactErrorText returned a non-error");
    return value;
}

describe("redactErrorText", () => {
    test("an error carrying no needle is returned by identity", () => {
        const err = new Error("nothing to see");
        expect(redactErrorText(err, [KEY], SAFE)).toBe(err);
        expect(redactErrorText(err, [undefined, ""], SAFE)).toBe(err);
    });

    test("own message, stack and string properties are rewritten on a clone of the same class", () => {
        const err = Object.assign(new TypeError(`cannot read ${KEY}`), { path: KEY, code: "ENOENT" });
        const out = asError(redactErrorText(err, [KEY], SAFE));
        expect(out).not.toBe(err);
        expect(out).toBeInstanceOf(TypeError);
        expect(out.message).toBe(`cannot read ${SAFE}`);
        expect(out.stack).not.toContain(KEY);
        expect((out as Error & { path: string }).path).toBe(SAFE);
        expect((out as Error & { code: string }).code).toBe("ENOENT");
        expect(err.message).toContain(KEY);
    });

    test("a message, stack and cause defined as prototype accessors are read through the instance", () => {
        class AccessorError extends Error {
            override get message(): string {
                return `accessor names ${KEY}`;
            }
            override get stack(): string {
                return `AccessorError at ${KEY}`;
            }
            override get cause(): unknown {
                return new Error(`cause names ${KEY}`);
            }
        }
        const err = new AccessorError();
        // The engine stamps an own `stack` at construction, which would hide the
        // accessor; removing it leaves the prototype's getter as the only one.
        Reflect.deleteProperty(err, "stack");
        expect(Object.hasOwn(err, "message")).toBe(false);
        const out = asError(redactErrorText(err, [KEY], SAFE));
        expect(out.message).toBe(`accessor names ${SAFE}`);
        expect(out.stack).toBe(`AccessorError at ${SAFE}`);
        expect(asError(out.cause).message).toBe(`cause names ${SAFE}`);
    });

    test("the cause chain and nested plain objects are redacted, a classed object is left alone", () => {
        class Request {
            constructor(readonly url: string) {}
        }
        const request = new Request(`https://store/${KEY}`);
        const inner = Object.assign(new Error(`inner ${KEY}`), { meta: { keys: [KEY] }, request });
        const out = asError(redactErrorText(new Error("outer", { cause: inner }), [KEY], SAFE));
        const cause = asError(out.cause) as Error & { meta: { keys: string[] }; request: Request };
        expect(cause.message).toBe(`inner ${SAFE}`);
        expect(cause.meta.keys).toEqual([SAFE]);
        expect(cause.request).toBe(request);
    });

    test("a slash-separated needle is also found in its backslash spelling", () => {
        const out = asError(redactErrorText(new Error(`open C:\\data\\tenants\\t1\\secret.pdf`), [KEY], SAFE));
        expect(out.message).toBe(`open C:\\data\\${SAFE}`);
    });

    test("a non-string message accessor is left as it is", () => {
        class OddError extends Error {}
        Object.defineProperty(OddError.prototype, "message", { get: () => 42 });
        const err = new OddError();
        expect(redactErrorText(err, [KEY], SAFE)).toBe(err);
    });
});
