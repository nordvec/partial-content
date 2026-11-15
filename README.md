# partial-content

[![npm version](https://img.shields.io/npm/v/partial-content.svg)](https://www.npmjs.com/package/partial-content)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/partial-content)
[![ci](https://github.com/nordvec/partial-content/actions/workflows/ci.yml/badge.svg)](https://github.com/nordvec/partial-content/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Serve files from any storage backend over HTTP with correct range requests, conditional caching, safe downloads and integrity digests. Zero runtime dependencies.

```
npm install partial-content
```

## Quick start

```typescript
import { serveObject } from "partial-content/web";
import { s3Store } from "partial-content/s3";
import { S3Client } from "@aws-sdk/client-s3";

const store = s3Store({ client: new S3Client({ region: "eu-central-1" }), bucket: "documents" });
const handler = serveObject(store, { disposition: "inline" });

// Next.js App Router (route-handler params arrive as a Promise)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handler(req, { key: id, mime: "application/pdf" });
}
export const HEAD = GET;
```

The handler answers 200, 206, 304, 412, 416 and HEAD. Video seeking, PDF progressive loading and browser caching work against your origin without further code. Authorization stays yours: check access before calling the handler.

## Stores and adapters

A store reads bytes from a backend; an adapter connects the handler to a server framework. Pick one of each.

| Import | Kind | Backend or framework |
|---|---|---|
| `partial-content/s3` | store | AWS S3 and S3-compatible (R2, Hetzner, MinIO, Wasabi) |
| `partial-content/r2` | store | Cloudflare R2 native bindings |
| `partial-content/gcs` | store | Google Cloud Storage |
| `partial-content/azure` | store | Azure Blob Storage |
| `partial-content/fs` | store | Local filesystem |
| `partial-content/http` | store | Any range-capable HTTP origin |
| `partial-content/memory` | store | In-memory, for tests and embedded assets |
| `partial-content/web` | adapter | Fetch API (Next.js, SvelteKit, Remix, Workers, Bun, Deno) |
| `partial-content/node` | adapter | Node `http`, Express, Fastify, Koa |
| `partial-content/hono` | adapter | Hono |

Also: `partial-content` (the kernel, for bringing your own I/O), `partial-content/mime` (MIME lookup) and `partial-content/conformance` (a check that a custom store meets the read contract). Cloud SDKs (`@aws-sdk/client-s3`, `@google-cloud/storage`, `@azure/storage-blob`) and `hono` are optional peer dependencies; install only what you use.

## What it does

- Range requests (206, 416), including `multipart/byteranges` with coalescing and an amplification cap (RFC 9110 Section 14)
- Conditional requests (304, 412) and `If-Range`, evaluated in the order RFC 9110 Section 13 prescribes, with strong and weak comparison where the RFC requires each
- `Repr-Digest` and `Content-Digest` with `Want-*` negotiation (RFC 9530)
- `Content-Disposition` with non-ASCII filenames, header-injection and path-traversal defense (RFC 6266, RFC 8187)
- ETags from storage metadata, typed `Cache-Control`, precompressed `.br`/`.zst`/`.gz` variants, optional signed-URL offload
- HEAD-to-GET consistency: reads are pinned to the validated representation, and a store failure maps to its truthful status (404, 503 with `Retry-After`, 502)
- Audit and metering hooks (`onServe`, `onTransfer`, `onError`) that can report an opaque id instead of the storage key
- ESM only; Node.js 24+, Bun, Deno and Cloudflare Workers

Looking for the 5.x upload API? See [docs/UPGRADING.md](docs/UPGRADING.md#5x-to-60) for presigned direct-to-storage writes.

## Documentation

- [docs/API.md](docs/API.md): full reference, every option
- [docs/EXAMPLES.md](docs/EXAMPLES.md): recipes (Express, Hono, Workers, authorized proxy, digests, precompressed variants)
- [docs/UPGRADING.md](docs/UPGRADING.md): moving between major versions
- [docs/DESIGN.md](docs/DESIGN.md): design notes, RFC deviations, response header matrix
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md): measurements and methodology
- [SECURITY.md](SECURITY.md): threat model, standards mapping, reporting

## License

Apache-2.0 from 5.0.0 onward, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Versions up to and including 4.0.0, as published, remain under the MIT License.
