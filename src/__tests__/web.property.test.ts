import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { serveObjectRaw, type RawResponseParts } from "../web";
import { memoryStore } from "../memory";

/**
 * Property: the adapter's never-throw contract, fuzzed.
 *
 * `serveObjectRaw` is the rawest consumer surface: `ServableRequest.headers`
 * is any `{ get() }` view, so a node consumer can feed it strings the Fetch
 * `Headers` class would have rejected or normalized (untrimmed values,
 * control characters, header-splitting attempts). Example tests sample this
 * space; the fuzz pins totality across it: for ANY method, ANY header soup on
 * the protocol-relevant fields, and ANY filename/MIME context, the handler
 * resolves to structurally sound response parts and never throws, and no
 * backend- or caller-derived value can smuggle CR/LF into a header value.
 */

const PROTOCOL_HEADERS = [
    "Range",
    "If-Range",
    "If-None-Match",
    "If-Match",
    "If-Modified-Since",
    "If-Unmodified-Since",
    "Accept-Encoding",
    "Want-Repr-Digest",
    "Want-Content-Digest",
] as const;

/** Adversarial value pool: spec fragments, edge numerics, injection attempts. */
const headerValue = fc.oneof(
    fc.string(),
    fc.string({ unit: "binary" }),
    fc.constantFrom(
        "bytes=0-", "bytes=-1", "bytes=0-0,5-9,3-4", "bytes=999999999999999999999-",
        "bytes = 0-4", "BYTES=0-4", "bytes=4-2", "bytes=,,,", "octets=0-4",
        'W/"weak"', '"strong"', "*", '"a", W/"b", *',
        "Thu, 01 Jan 1970 00:00:00 GMT", "not a date", "-1",
        "gzip;q=nope, *;q=0, identity;q=0.0001", "br;q=1.0000, zstd;q=0.999",
        "sha-256=10, sha-512=3, unknown=9", "sha-256=0",
        "evil\r\nX-Injected: 1", "null\u0000byte", " \t leading-ows",
    ),
);

const requestArb = fc.record({
    method: fc.oneof(
        fc.constantFrom("GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "get", "head"),
        fc.string({ minLength: 1, maxLength: 12 }),
    ),
    headers: fc.dictionary(fc.constantFrom(...PROTOCOL_HEADERS), headerValue, { maxKeys: 6 }),
    filename: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
    mime: fc.option(
        fc.oneof(
            fc.constantFrom(
                "text/plain", "application/json", "image/svg+xml", "application/pdf",
                "text/html; charset=utf-16", "application/vnd.api+json", "font/woff2",
            ),
            fc.string({ maxLength: 40 }),
        ),
        { nil: undefined },
    ),
    disposition: fc.constantFrom<"inline" | "attachment">("inline", "attachment"),
});

function headerView(map: Record<string, string>): { get(name: string): string | null } {
    const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
    return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

function assertStructurallySound(parts: RawResponseParts, method: string): void {
    expect(Number.isInteger(parts.status)).toBe(true);
    expect(parts.status).toBeGreaterThanOrEqual(200);
    expect(parts.status).toBeLessThan(600);
    for (const [name, value] of Object.entries(parts.headers)) {
        // The whole-response injection guarantee: no header NAME or VALUE may
        // contain CR/LF/NUL regardless of what the request smuggled in.
        expect(name).not.toMatch(/[\r\n\u0000]/);
        expect(value).not.toMatch(/[\r\n\u0000]/);
    }
    if (parts.headers["Content-Length"] !== undefined) {
        expect(parts.headers["Content-Length"]).toMatch(/^\d+$/);
    }
    if (method.toUpperCase() === "HEAD" && parts.status < 300) {
        expect(parts.body).toBeNull();
    }
}

describe("serveObjectRaw: never-throw totality (fuzzed)", () => {
    const store = memoryStore({
        objects: {
            "doc.bin": {
                body: "0123456789abcdefghij".repeat(10), // 200 bytes
                etag: '"fuzz-v1"',
                lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
            },
        },
    });

    test("any method + protocol-header soup resolves to sound parts", async () => {
        const handler = serveObjectRaw(store);
        await fc.assert(
            fc.asyncProperty(requestArb, async (r) => {
                const parts = await handler(
                    { method: r.method, headers: headerView(r.headers) },
                    { key: "doc.bin", mime: r.mime, filename: r.filename },
                );
                assertStructurallySound(parts, r.method);
                // Drain stream bodies so a mid-stream throw cannot hide.
                if (parts.body instanceof ReadableStream) {
                    for await (const _chunk of parts.body) { /* consume */ }
                }
            }),
            { numRuns: 300 },
        );
    });

    test("negotiation + hardening options hold totality too", async () => {
        const handler = serveObjectRaw(store, {
            precompressed: true,
            accessControlExposeHeaders: true,
            timing: true,
            etag: false,
        });
        await fc.assert(
            fc.asyncProperty(requestArb, async (r) => {
                const parts = await handler(
                    { method: r.method, headers: headerView(r.headers) },
                    { key: "doc.bin", mime: r.mime, filename: r.filename },
                );
                assertStructurallySound(parts, r.method);
                if (parts.body instanceof ReadableStream) {
                    for await (const _chunk of parts.body) { /* consume */ }
                }
            }),
            { numRuns: 200 },
        );
    });
});
