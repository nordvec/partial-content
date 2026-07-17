# Deployment

Operational guidance for running the resumable-upload handlers behind a
reverse proxy and across more than one instance. The read side (range and
conditional serving) has no special deployment needs; everything here is about
the upload (`PATCH`-streaming) path.

## Reverse proxies buffer uploads by default, and that breaks resumability

The single most common self-host failure is a proxy that buffers the whole
`PATCH` body before forwarding it. It defeats the entire point of resumable
uploads (the server never sees bytes until the client finishes, so a dropped
connection loses everything), and on large uploads the proxy either runs out of
buffer disk or pre-empts the app with its own opaque `413`. Every proxy in
front of an upload endpoint must be told to **stream request bodies through,
not buffer them**, and to **not impose its own body-size ceiling** (the handler
enforces `maxSize`/`maxAppendSize` itself, and returns the protocol-correct
status with `Tus-Max-Size`; a proxy `413` is a dead end a client cannot
interpret).

### nginx

```nginx
location /files/ {
    proxy_pass http://app;

    # Stream the PATCH body straight through instead of buffering it whole.
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_http_version 1.1;

    # Let the APP enforce size limits (it returns Tus-Max-Size); 0 = unlimited
    # at the proxy so a large upload is never cut off by an opaque proxy 413.
    client_max_body_size 0;

    # The handler builds the resource `Location` from the request's scheme and
    # host; forward both so resumes target the right URL behind TLS termination.
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

    # Uploads can idle between chunks on a slow link; keep the proxy from
    # reaping a live-but-quiet connection.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

On HTTP/2, nginx caps how much of a request body it pre-reads
(`http2_body_preread_size`, default 64k); raising it improves throughput for
large HTTP/2 uploads at the cost of proxy memory.

### Apache (mod_proxy)

```apache
<Location /files/>
    ProxyPass        http://app/files/
    ProxyPassReverse http://app/files/

    # Do not buffer the request body to disk before forwarding.
    SetEnv proxy-sendcl 1
    ProxyReceiveBufferSize 0

    RequestHeader set X-Forwarded-Proto "https"
    ProxyPreserveHost On
</Location>

# Apache buffers to a temp file past this; set high or the app never streams.
LimitRequestBody 0
```

### Caddy

Caddy streams request bodies by default and needs no buffering flags. Just
forward the scheme/host so `Location` is built correctly:

```caddy
reverse_proxy /files/* app:8080 {
    header_up X-Forwarded-Proto {scheme}
    header_up Host {host}
}
```

## CORS: expose the protocol response headers

A cross-origin browser upload cannot resume unless the browser is allowed to
**read** the protocol response headers. It is easy to expose `Location` and
forget `Upload-Offset`, which silently breaks every resume. The package
publishes the exact list so you never assemble it by hand:

```typescript
import { TUS_EXPOSED_HEADERS } from "partial-content/tus";
// or UPLOAD_EXPOSED_HEADERS from "partial-content/upload" for the IETF dialect

const cors = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Expose-Headers": TUS_EXPOSED_HEADERS.join(", "),
  // Allow-Headers is the mirror image (the request headers a client sends);
  // assemble it from the same protocol surface for your dialect.
};
```

The package ships no CORS middleware on purpose: the origin allow-list and
credential policy are yours to own. `TUS_EXPOSED_HEADERS` /
`UPLOAD_EXPOSED_HEADERS` are the one part that must not drift.

## Running more than one instance

Upload interactions on a single resource are serialized by a lock. The default
locker is in-process and correct for exactly one instance. If more than one
server can receive requests for the same upload (a horizontally scaled
deployment without upload-affinity routing), supply a shared locker:

```typescript
import { redisUploadLocker } from "partial-content/redis-locker";

const handler = createTusHandler(store, {
  /* ... */
  locker: redisUploadLocker(redisClient),   // any Redis-protocol server
});
```

See the API reference (Locking) for the client-adapter shape and the fencing /
watchdog / preemption semantics. Alternatively, route all requests for one
upload resource to the same instance (sticky sessions keyed on the upload
`Location`) and keep the in-process locker.

## Storage on a network volume

The filesystem store (`partial-content/fs`) runs on whatever volume you mount.
On a busy shared/network volume (SMB, NFS) an otherwise-fine file open can
momentarily fail with a share violation, and under load any local filesystem
can exhaust the process file-descriptor table; the store retries these
transient open failures with a short backoff, so a single momentary failure
does not sink a whole `PATCH`. For heavy sustained throughput, object storage
(`/s3`, `/r2`, `/gcs`, `/azure`) is the better fit; the fs store is ideal for
single-node and self-hosted deployments.

## Object-storage part limits

The S3 and R2 stores assemble large objects from multipart parts, and both
backends cap a multipart upload at **10,000 parts**. The largest object a store
can assemble is therefore `10,000 x minPartSize` (S3) or `10,000 x partSize`
(R2), roughly 48.8 GiB at the 5 MiB default. Past the ceiling the store fails
the crossing append with a message naming the knob to raise, rather than
letting the backend reject completion opaquely. For objects larger than ~49
GiB, raise `minPartSize`/`partSize` at construction (a 64 MiB part size lifts
the ceiling to ~625 GiB).
