/**
 * `fs.open` with a bounded backoff retry over transient failures.
 *
 * The filesystem upload store runs on whatever volume the deployment mounts,
 * and on a busy shared/network volume (SMB, NFS) an otherwise-fine open can
 * momentarily fail with a share violation, and under load any local fs can
 * exhaust the process file-descriptor table. Both clear on a short retry, so a
 * single momentary failure should not sink a whole upload PATCH. Everything
 * else, including the `wx`/`r+` open semantics the callers rely on, rethrows
 * on the first attempt.
 *
 * @packageDocumentation
 */

import { open, type FileHandle } from "node:fs/promises";

/**
 * errno codes that are TRANSIENT for a file open and clear on a short retry:
 * descriptor exhaustion under load (`EMFILE`/`ENFILE`), a momentary share
 * violation on a network-mounted volume (`EBUSY`), and the POSIX try-again
 * (`EAGAIN`). NOT retried: `EEXIST` (the real collision the `wx` create relies
 * on), `ENOENT` (the file is genuinely gone), `EACCES`/`EPERM` (a standing
 * permission fault a retry only delays surfacing).
 */
const TRANSIENT_OPEN_ERRNOS: ReadonlySet<string> = new Set(["EMFILE", "ENFILE", "EBUSY", "EAGAIN"]);

/** True when an open failure is worth retrying a moment later. */
export function isTransientOpenError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_OPEN_ERRNOS.has(code);
}

/**
 * Open `path` with `flags`, retrying up to `attempts` times over a linear
 * backoff when the failure is transient (see {@link isTransientOpenError}).
 * `opener` is injectable for tests; production always uses `fs.open`.
 */
export async function openWithRetry(
  path: string,
  flags: string,
  attempts = 5,
  baseDelayMs = 40,
  opener: (p: string, f: string) => Promise<FileHandle> = open,
): Promise<FileHandle> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await opener(path, flags);
    } catch (err) {
      if (attempt >= attempts || !isTransientOpenError(err)) throw err;
      await new Promise<void>((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
}
