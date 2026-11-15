# Deployment

Operational guidance for running the serving handlers. Range and conditional
serving need no proxy configuration of their own: a reverse proxy that passes
`Range`, `If-Range` and the conditional request fields through, and does not
rewrite `ETag`, serves them correctly.

## Verifying a custom read store before it carries traffic

A custom `ObjectStore` has a harness, `checkObjectStore` from
`partial-content/conformance`. It pins the head length, a byte-identical full
read, the exact window a ranged read was asked for, an honest total size on
that partial read, and a not-found the adapter can tell from an outage. It
only reads, so it needs no disposable keys: point it at an object the staging
bucket already serves, and pass that object's exact bytes. It needs no test
framework and no dependencies, and it reports every gap in one run rather
than the first, so it fits a CI step or a startup self-test. See the API
reference (Store conformance) for the check list and the options.

## Storage on a network volume

The filesystem store (`partial-content/fs`) runs on whatever volume you mount.
On a busy shared/network volume (SMB, NFS) an otherwise-fine file open can
momentarily fail with a share violation, and under load any local filesystem
can exhaust the process file-descriptor table. The store does not retry a
failed open: the request fails and the error reaches `onError`,
so a client retry is the recovery and the file-descriptor ceiling is yours to
size. For heavy sustained throughput, object storage
(`/s3`, `/r2`, `/gcs`, `/azure`) is the better fit; the fs store is ideal for
single-node and self-hosted deployments.
