import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
} from "../upload-store.ts";
import { redactUploadToken } from "../upload-internals.ts";

/**
 * The upload token is a bearer capability, so it must stay off `Error.message`
 * and live on a property, as `UploadNotFoundError` already does: store errors
 * reach the consumer's `onError` log sink, and `auditKey` can only redact the
 * context object.
 *
 * Asserted on the CONSTRUCTION rather than the behavior, because driving the
 * error paths would cover the ones that exist today while the defect is a new
 * one being added.
 */
const SRC_DIR = join(import.meta.dir, "..");

/** Shipped source only: the tests themselves may name whatever they need. */
function shippedSources(): string[] {
    return readdirSync(SRC_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
}

/**
 * An `Error(...)` (or `Error(...)`-adjacent) template literal that interpolates
 * a token-named binding. Deliberately narrow: it catches the shape that
 * actually shipped rather than trying to trace a message built elsewhere and
 * thrown later, so a green result means "this shape is absent", not "no message
 * can ever carry a token".
 */
const TOKEN_IN_MESSAGE = /Error\(\s*`[^`]*\$\{\s*[A-Za-z0-9_.]*[Tt]oken[A-Za-z0-9_.]*\s*\}/g;

describe("the upload token never reaches Error.message", () => {
    test("no shipped module interpolates a token into an error message", () => {
        const offenders: string[] = [];
        for (const file of shippedSources()) {
            const source = readFileSync(join(SRC_DIR, file), "utf8");
            for (const match of source.matchAll(TOKEN_IN_MESSAGE)) {
                const line = source.slice(0, match.index).split("\n").length;
                offenders.push(`${file}:${line}  ${match[0].slice(0, 80)}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test("the typed upload errors carry the token on a property, not in the text", () => {
        const token = "tok-ABCDEF-capability";
        const errors: Error[] = [
            new UploadNotFoundError(token),
            new UploadOffsetConflictError(token, 10),
            new UploadAppendBoundError(token, 10),
            new UploadOverrunError(token, 20),
            new UploadDigestMismatchError(token, "sha-256", "sha-256-other"),
        ];
        for (const err of errors) {
            // The message is what a logger serializes by default; the token is
            // reachable for callers that genuinely need it.
            expect(err.message).not.toContain(token);
            expect((err as unknown as { uploadToken?: string }).uploadToken).toBe(token);
        }
    });
});

describe("redactUploadToken", () => {
    const token = "9f2c1d44-0000-4000-8000-aaaabbbbcccc";
    const auditKey = "upload-42";

    test("replaces the token in the message, the errno path, and the stack", () => {
        const err = Object.assign(
            new Error(`EMFILE: too many open files, open '/var/data/.uploads/${token}.json'`),
            { code: "EMFILE", path: `/var/data/.uploads/${token}.json` },
        );
        err.stack = `Error: open '/var/data/.uploads/${token}.json'\n    at writeSidecar`;

        const out = redactUploadToken(err, token, auditKey) as Error & { code: string; path: string };

        expect(out.message).not.toContain(token);
        expect(out.path).not.toContain(token);
        expect(out.stack).not.toContain(token);
        expect(out.message).toContain(auditKey);
        // The errno code is what a consumer branches on; redaction must not cost it.
        expect(out.code).toBe("EMFILE");
    });

    test("the clone keeps the prototype and the typed error's own fields", () => {
        const err = new UploadNotFoundError(token);
        err.message = `Upload ${token} not found`; // a message that DOES carry it

        const out = redactUploadToken(err, token, auditKey);

        expect(out).toBeInstanceOf(UploadNotFoundError);
        expect((out as UploadNotFoundError).status).toBe(404);
        expect((out as UploadNotFoundError).uploadToken).toBe(token);
        expect((out as Error).message).not.toContain(token);
    });

    test("an error that never mentions the token is passed through unchanged", () => {
        const err = new Error("Upload is invalidated; nothing may be appended");
        expect(redactUploadToken(err, token, auditKey)).toBe(err);
    });

    test("a non-Error throwable and an empty token are returned as they are", () => {
        expect(redactUploadToken("a string", token, auditKey)).toBe("a string");
        const err = new Error("anything");
        expect(redactUploadToken(err, "", auditKey)).toBe(err);
    });

    test("a missing token redacts nothing, rather than searching for its stringification", () => {
        // The reporting paths call this before a token exists as well as after.
        // Searching for what an absent token stringifies to would substitute the
        // audit key into any message containing the word, and real backend
        // errors carry it constantly.
        const err = new Error("Cannot read properties of undefined (reading 'UploadId')");
        expect(redactUploadToken(err, undefined, auditKey)).toBe(err);
        expect(err.message).toContain("undefined");
    });
});
