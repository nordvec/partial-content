/**
 * A handler's policy may be a function of the request (a tenant's quota, a
 * plan's ceiling). Every request is judged under, and advertises, the policy it
 * resolves: the IETF dialect's `Upload-Limit` on OPTIONS, the 201, the probe,
 * a limit rejection and the 104 hook; the tus dialect's `Tus-Max-Size`, its
 * `expiration` extension and `Upload-Expires`, and its checksum buffer bound.
 * A resolved policy is validated exactly like a static one, so an invalid one
 * fails the request loudly instead of silently disabling a bound.
 */
import { describe, test, expect } from "bun:test";
import { memoryUploadStore } from "../memory.ts";
import { createUploadHandler } from "../upload.ts";
import { createTusHandler, webCryptoChecksum } from "../tus.ts";
import type { UploadPolicy } from "../upload-engine.ts";

const VERSION = "Upload-Draft-Interop-Version";
const NOW = 1_700_000_000_000;

type Plan = UploadPolicy & { maxSize: number };
const PLANS: Record<string, Plan> = {
    small: { maxSize: 10 },
    large: { maxSize: 100, maxAgeSeconds: 60 },
};

function tenantOf(req: Request): Plan {
    return PLANS[req.headers.get("X-Plan") ?? "small"]!;
}

function ietf(policy: (req: Request) => Plan | Promise<Plan> = tenantOf) {
    const errors: unknown[] = [];
    const hooks: Array<Record<string, string>> = [];
    const keyPolicies: Array<UploadPolicy> = [];
    const handler = createUploadHandler(memoryUploadStore({ objects: {} }), {
        key: ({ policy: p }) => {
            keyPolicies.push(p);
            return "k";
        },
        location: (t) => `/u/${t}`,
        policy,
        graceMs: 0,
        now: () => NOW,
        onError: (err) => errors.push(err),
        onResumptionSupported: (info) => hooks.push(info.headers),
    });
    return { handler, errors, hooks, keyPolicies };
}

function create(plan: string, length: number): Request {
    return new Request("http://test/u", {
        method: "POST",
        headers: { [VERSION]: "10", "Upload-Complete": "?0", "Upload-Length": String(length), "X-Plan": plan },
    });
}

describe("IETF per-request policy", () => {
    test("OPTIONS advertises the policy the request resolves", async () => {
        const { handler } = ietf();
        const small = await handler(
            new Request("http://test/u", { method: "OPTIONS", headers: { "X-Plan": "small" } }),
        );
        const large = await handler(
            new Request("http://test/u", { method: "OPTIONS", headers: { "X-Plan": "large" } }),
        );
        expect(small.headers.get("Upload-Limit")).toBe("max-size=10, min-size=0");
        expect(large.headers.get("Upload-Limit")).toBe("max-size=100, min-size=0, max-age=60");
    });

    test("a creation is judged and answered under its own plan", async () => {
        const { handler, hooks, keyPolicies } = ietf();
        const refused = await handler(create("small", 50));
        expect(refused.status).toBe(413);
        expect(refused.headers.get("Upload-Limit")).toBe("max-size=10, min-size=0");

        const accepted = await handler(create("large", 50));
        expect(accepted.status).toBe(201);
        expect(accepted.headers.get("Upload-Limit")).toBe("max-size=100, min-size=0, max-age=60");
        expect(hooks.map((h) => h["Upload-Limit"])).toEqual(["max-size=100, min-size=0, max-age=60"]);
        expect(keyPolicies.map((p) => p.maxSize)).toEqual([100]);

        const location = accepted.headers.get("Location")!;
        const probe = await handler(
            new Request(`http://test${location}`, { method: "HEAD", headers: { [VERSION]: "10", "X-Plan": "large" } }),
            { uploadToken: location.slice("/u/".length) },
        );
        expect(probe.status).toBe(204);
        expect(probe.headers.get("Upload-Limit")).toBe("max-size=100, min-size=0, max-age=60");
    });

    test("an async resolver is awaited", async () => {
        const { handler } = ietf(async (req) => tenantOf(req));
        const res = await handler(create("large", 50));
        expect(res.status).toBe(201);
    });

    test("a resolved policy is validated like a static one", async () => {
        for (const bad of [{ maxSize: -1 }, {} as Plan, { maxSize: 10, minSize: 20 }]) {
            const { handler, errors } = ietf(() => bad);
            const res = await handler(create("small", 5));
            expect(res.status).toBe(500);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toBeInstanceOf(TypeError);
        }
    });
});

describe("tus per-request policy", () => {
    function tus(withChecksum = false) {
        const errors: unknown[] = [];
        const handler = createTusHandler(memoryUploadStore({ objects: {} }), {
            key: () => "k",
            location: (t) => `/files/${t}`,
            policy: (req) =>
                req.headers.get("X-Plan") === "bad"
                    ? { maxSize: 100, minAppendSize: 1 }
                    : req.headers.get("X-Plan") === "chunked"
                      ? { maxSize: 100, maxAppendSize: 4 }
                      : tenantOf(req),
            graceMs: 0,
            now: () => NOW,
            onError: (err) => errors.push(err),
            ...(withChecksum && { checksum: webCryptoChecksum() }),
        });
        return { handler, errors };
    }

    function options(plan: string): Request {
        return new Request("http://test/files", { method: "OPTIONS", headers: { "X-Plan": plan } });
    }

    function post(plan: string, length: number): Request {
        return new Request("http://test/files", {
            method: "POST",
            headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(length), "X-Plan": plan },
        });
    }

    test("OPTIONS advertises the resolved max size and expiration", async () => {
        const { handler } = tus();
        const small = await handler(options("small"));
        const large = await handler(options("large"));
        expect(small.headers.get("Tus-Max-Size")).toBe("10");
        expect(small.headers.get("Tus-Extension")).not.toContain("expiration");
        expect(large.headers.get("Tus-Max-Size")).toBe("100");
        expect(large.headers.get("Tus-Extension")).toContain("expiration");
    });

    test("creation and its expiry follow the resolved policy", async () => {
        const { handler } = tus();
        const refused = await handler(post("small", 50));
        expect(refused.status).toBe(413);
        expect(refused.headers.get("Tus-Max-Size")).toBe("10");

        const noExpiry = await handler(post("small", 5));
        expect(noExpiry.status).toBe(201);
        expect(noExpiry.headers.get("Upload-Expires")).toBeNull();

        const expiring = await handler(post("large", 50));
        expect(expiring.status).toBe(201);
        expect(expiring.headers.get("Upload-Expires")).toBe(new Date(NOW + 60_000).toUTCString());
    });

    test("a resolved append floor is refused like a configured one", async () => {
        const { handler, errors } = tus();
        const res = await handler(post("bad", 5));
        expect(res.status).toBe(500);
        expect(errors[0]).toBeInstanceOf(TypeError);
    });

    test("the checksum buffer is bounded by the resolved append ceiling", async () => {
        const { handler } = tus(true);
        const created = await handler(post("chunked", 8));
        expect(created.status).toBe(201);
        const token = created.headers.get("Location")!.slice("/files/".length);
        const sha1 = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode("12345678")));
        const res = await handler(
            new Request("http://test/files/x", {
                method: "PATCH",
                headers: {
                    "Tus-Resumable": "1.0.0",
                    "Content-Type": "application/offset+octet-stream",
                    "Upload-Offset": "0",
                    "Upload-Checksum": `sha1 ${btoa(String.fromCharCode(...sha1))}`,
                    "X-Plan": "chunked",
                },
                body: "12345678",
            }),
            { uploadToken: token },
        );
        expect(res.status).toBe(413);
    });

    test("a checksum without any buffer bound fails the request loudly", async () => {
        const { handler, errors } = tus(true);
        const res = await handler(post("small", 5));
        expect(res.status).toBe(500);
        expect(errors[0]).toBeInstanceOf(TypeError);
    });
});
