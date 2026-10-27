import { describe, test, expect } from "bun:test";
import {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
} from "../upload-store.ts";
import { StoreUnavailableError, redactErrorText } from "../object-store.ts";

/**
 * The upload token is a bearer capability, so it must stay off `Error.message`:
 * the typed upload errors carry it on a property, and `redactErrorText`
 * substitutes it, and a storage key the caller knows, on every surface of an
 * error that reaches the consumer's `onError` log sink.
 */

describe("the upload token never reaches Error.message", () => {
    test("the typed upload errors carry the token on a property, not in the text", () => {
        const token = "tok-ABCDEF-capability";
        const errors: Error[] = [
            new UploadNotFoundError(token),
            new UploadOffsetConflictError(token, 10),
            new UploadAppendBoundError(token, 10),
            new UploadOverrunError(token, 20),
            new UploadDigestMismatchError(token, "sha-256", "sha-256", "sha-256-other"),
        ];
        for (const err of errors) {
            // The message is what a logger serializes by default; the token is
            // reachable for callers that genuinely need it.
            expect(err.message).not.toContain(token);
            expect((err as unknown as { uploadToken?: string }).uploadToken).toBe(token);
        }
    });
});

describe("redactErrorText over an upload token and its key", () => {
    const token = "9f2c1d44-0000-4000-8000-aaaabbbbcccc";
    const auditKey = "upload-42";

    test("replaces the token in the message, the errno path, and the stack", () => {
        const err = Object.assign(new Error(`EMFILE: too many open files, open '/var/data/.uploads/${token}.json'`), {
            code: "EMFILE",
            path: `/var/data/.uploads/${token}.json`,
        });
        err.stack = `Error: open '/var/data/.uploads/${token}.json'\n    at writeSidecar`;

        const out = redactErrorText(err, [token], auditKey) as Error & { code: string; path: string };

        expect(out.message).not.toContain(token);
        expect(out.path).not.toContain(token);
        expect(out.stack).not.toContain(token);
        expect(out.message).toContain(auditKey);
        // The errno code is what a consumer branches on; redaction must not cost it.
        expect(out.code).toBe("EMFILE");
    });

    test("the clone keeps the prototype and the typed error's own fields, with the token substituted on every one", () => {
        const err = new UploadNotFoundError(token);
        err.message = `Upload ${token} not found`; // a message that DOES carry it

        const out = redactErrorText(err, [token], auditKey);

        expect(out).toBeInstanceOf(UploadNotFoundError);
        expect((out as UploadNotFoundError).status).toBe(404);
        // The typed errors keep the token OFF the message and ON a property for
        // callers that need it; an error that reaches the redacting sink is on
        // a log surface, where the property is the same capability one field
        // over, so it is substituted like the message.
        expect((out as UploadNotFoundError).uploadToken).toBe(auditKey);
        expect((out as Error).message).not.toContain(token);
    });

    test("a store error's key property and its cause are substituted, not only the message", () => {
        // A throttled sidecar read is classified into an error whose message
        // names the token-derived key, whose `key` property carries the same
        // string, and whose `cause` is the raw backend error. Rewriting the
        // message alone leaves the token one property away.
        const backend = new Error(`GET .uploads/${token}.info: 503 SlowDown`);
        const err = new StoreUnavailableError(`.uploads/${token}.info`, { cause: backend });

        const out = redactErrorText(err, [token], auditKey) as StoreUnavailableError;

        expect(out).toBeInstanceOf(StoreUnavailableError);
        expect(out.status).toBe(503);
        expect(out.message).not.toContain(token);
        expect(out.key).toBe(`.uploads/${auditKey}.info`);
        expect((out.cause as Error).message).not.toContain(token);
        expect((out.cause as Error).message).toContain(auditKey);
        // The backend error itself is untouched: the clone is what the sink sees.
        expect(backend.message).toContain(token);
        expect(JSON.stringify(out)).not.toContain(token);
    });

    test("a rename errno names the destination on dest, which is substituted with path", () => {
        const err = Object.assign(new Error(`ENOENT: rename '/tmp/${token}.tmp' -> '/tmp/${token}.json'`), {
            code: "ENOENT",
            path: `/tmp/${token}.tmp`,
            dest: `/tmp/${token}.json`,
        });
        const out = redactErrorText(err, [token], auditKey) as typeof err;
        expect(out.path).toBe(`/tmp/${auditKey}.tmp`);
        expect(out.dest).toBe(`/tmp/${auditKey}.json`);
        expect(out.code).toBe("ENOENT");
    });

    test("the storage key is substituted alongside the token when the caller knows it", () => {
        const key = "users/alice/tax-return.pdf";
        const err = Object.assign(new Error(`EACCES: open '/srv/data/${key}'`), {
            code: "EACCES",
            path: `/srv/data/${key}`,
        });
        const out = redactErrorText(err, [token, key], auditKey) as typeof err;
        expect(out.message).not.toContain(key);
        expect(out.path).toBe(`/srv/data/${auditKey}`);
    });

    test("a cause cycle terminates at the depth bound", () => {
        const a = new Error(`a ${token}`);
        const b = new Error(`b ${token}`, { cause: a });
        (a as { cause?: unknown }).cause = b;
        const out = redactErrorText(b, [token], auditKey) as Error;
        expect(out.message).not.toContain(token);
        expect((out.cause as Error).message).not.toContain(token);
    });

    test("an error that never mentions the token is passed through unchanged", () => {
        const err = new Error("Upload is invalidated; nothing may be appended");
        expect(redactErrorText(err, [token], auditKey)).toBe(err);
    });

    test("a non-Error throwable and an empty token are returned as they are", () => {
        expect(redactErrorText("a string", [token], auditKey)).toBe("a string");
        const err = new Error("anything");
        expect(redactErrorText(err, [""], auditKey)).toBe(err);
    });

    test("a key is redacted in the separator spelling the filesystem resolved it to", () => {
        // A consumer spells a key with forward slashes and that is the spelling
        // the reporting paths pass here, but a filesystem adapter resolves it
        // through the platform path module before naming it in an errno error,
        // so on a backslash platform the failing `path` and `dest` carry the
        // same key under the other separator. Searching for one spelling only
        // leaves the filename, which is the personal data `auditKey` exists to
        // keep out of the sink.
        const key = "users/alice/tax-return.pdf";
        const err = Object.assign(
            new Error(
                `EPERM: operation not permitted, rename 'C:\\data\\.uploads\\${token}' -> 'C:\\data\\users\\alice\\tax-return.pdf'`,
            ),
            { code: "EPERM", path: `C:\\data\\.uploads\\${token}`, dest: "C:\\data\\users\\alice\\tax-return.pdf" },
        );
        const out = redactErrorText(err, [token, key], auditKey) as typeof err;
        expect(out.message).not.toContain("tax-return.pdf");
        expect(out.dest).not.toContain("tax-return.pdf");
        expect(out.message).not.toContain(token);
        expect(out.path).not.toContain(token);
        expect(out.code).toBe("EPERM");
    });

    test("a needle nested under an own property is redacted, not only a top-level string", () => {
        // A backend client reports the failing request as a nested own property
        // and the whole error reaches the sink, so a walk that stops at
        // string-valued properties hands the sink the identifier one level down.
        const err = Object.assign(new Error("ServerBusy"), {
            name: "RestError",
            statusCode: 503,
            request: { url: `https://acct.blob.core.windows.net/c/.partial-content-uploads/${token}.info` },
        });
        const out = redactErrorText(err, [token], auditKey) as typeof err;
        expect(JSON.stringify(out)).not.toContain(token);
        expect(out.request.url).not.toContain(token);
        expect(out.request.url).toContain(auditKey);
        expect(out.statusCode).toBe(503);
        // The original is never written through: the sink gets a clone.
        expect(err.request.url).toContain(token);
    });

    test("an object with a prototype of its own is left as the thing it is", () => {
        // Rebuilding it would hand the sink a plain object wearing the same
        // properties, so a carrier that is not a plain object or an array is
        // passed through even though a needle sits inside it.
        class Carrier {
            constructor(readonly url: string) {}
        }
        const carrier = new Carrier(`https://host/${token}`);
        const err = Object.assign(new Error("failed"), { request: carrier });
        const out = redactErrorText(err, [token], auditKey) as typeof err;
        expect(out.request).toBeInstanceOf(Carrier);
        expect(out.request).toBe(carrier);
    });

    test("an array own property is walked and only the carrying entries are rebuilt", () => {
        const shared = { note: "unrelated" };
        const err = Object.assign(new Error("aggregate"), {
            attempts: [shared, { url: `s3://bucket/${token}` }],
        });
        const out = redactErrorText(err, [token], auditKey) as typeof err;
        expect(JSON.stringify(out)).not.toContain(token);
        expect(out.attempts[1]).toEqual({ url: `s3://bucket/${auditKey}` });
        // An untouched branch is shared rather than copied.
        expect(out.attempts[0]).toBe(shared);
    });

    test("a missing token redacts nothing, rather than searching for its stringification", () => {
        // The reporting paths call this before a token exists as well as after.
        // Searching for what an absent token stringifies to would substitute the
        // audit key into any message containing the word, and real backend
        // errors carry it constantly.
        const err = new Error("Cannot read properties of undefined (reading 'UploadId')");
        expect(redactErrorText(err, [undefined], auditKey)).toBe(err);
        expect(err.message).toContain("undefined");
    });
});
