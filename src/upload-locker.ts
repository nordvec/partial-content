/**
 * Upload-resource locking: cooperative preemption, not a plain mutex.
 *
 * The race this exists for: a client's connection drops mid-append, and the
 * client resumes (probe, then append) BEFORE the server has noticed the dead
 * socket. A plain acquire-or-wait lock would stall every resume behind the
 * zombie holder's timeout. Cooperative preemption inverts it: the new
 * acquirer asks the HOLDER to stop, the holder aborts its append at the next
 * chunk boundary (flushing what it has, so the offset stays truthful), and
 * the lock hands over in milliseconds.
 *
 * Probes take the lock too: deriving an offset can be a multi-call read
 * against the backend, and answering from a torn snapshot while an append is
 * mid-flight would hand the client an offset its very next request fails on.
 *
 * The in-memory implementation is correct for a single process. Multi
 * -instance deployments use `redisUploadLocker` (the `redis-locker` subpath,
 * any Redis-protocol server, client injected) or supply their own
 * {@link UploadLocker}; the interface is deliberately tiny so that stays a
 * page of code.
 */

/** A held lock. Release exactly once; further calls are no-ops. */
export interface UploadLock {
  /**
   * Aborts the instant a LATER acquirer wants this lock (and, in a
   * distributed locker, if the holder can no longer prove it still holds the
   * lease). The holder MUST thread this signal into its long-running store
   * work (the append write) so it yields at the next safe boundary, flushing
   * what it has. Because an `AbortSignal` carries latched state (`.aborted`),
   * a preempt that lands before the holder starts its write is not lost: the
   * write sees an already-aborted signal and yields at once. Non-cooperation
   * is then a visible omission (a write that ignores the signal), not a
   * silent breach of a callback convention.
   */
  readonly signal: AbortSignal;
  release(): void;
}

/** Thrown when the holder did not yield within the acquire timeout. */
export class UploadLockTimeoutError extends Error {
  readonly uploadToken: string;
  constructor(uploadToken: string) {
    super("Upload lock holder did not yield in time");
    this.name = "UploadLockTimeoutError";
    this.uploadToken = uploadToken;
  }
}

export function isUploadLockTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "UploadLockTimeoutError";
}

export interface AcquireOptions {
  /**
   * How long to wait for a preempted holder to yield before giving up.
   * A holder that cannot be interrupted (stuck backend write) should surface
   * as a retryable contention answer, not an indefinite hang.
   * @default 15000
   */
  timeoutMs?: number;
}

export interface UploadLocker {
  /**
   * Acquire the lock for one upload resource. The returned lock carries a
   * {@link UploadLock.signal} that aborts when a LATER acquirer wants the
   * lock; the holder threads it into its store work to yield promptly.
   */
  acquire(uploadToken: string, opts?: AcquireOptions): Promise<UploadLock>;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;

/** The abort reason on a lock signal, so a preempt is distinguishable from a client disconnect. */
export const UPLOAD_PREEMPTED = "upload-lock-preempted";

interface Holder {
  /**
   * Aborted when a later acquirer wants the lock. Created at ACQUIRE time and
   * replaced on each hand-over, so it exists for the holder's full tenure:
   * there is no window where a preempt has nowhere to land, which is what
   * lets the holder rely on the signal's latched `.aborted` state instead of
   * a separate flag.
   */
  controller: AbortController;
  queue: Array<{
    resolve: (lock: UploadLock) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

/** Single-process in-memory locker (the default). */
export function memoryUploadLocker(): UploadLocker {
  const holders = new Map<string, Holder>();

  function makeLock(token: string, controller: AbortController): UploadLock {
    let released = false;
    return {
      signal: controller.signal,
      release(): void {
        if (released) return;
        released = true;
        const holder = holders.get(token);
        if (!holder) return;
        const next = holder.queue.shift();
        if (!next) {
          holders.delete(token);
          return;
        }
        clearTimeout(next.timer);
        // Hand over to the next waiter with a FRESH signal (the previous
        // holder's was already aborted). If more waiters remain behind it,
        // preempt the new holder at once, in FIFO order with the same yield
        // pressure every holder gets.
        const nextController = new AbortController();
        holder.controller = nextController;
        next.resolve(makeLock(token, nextController));
        if (holder.queue.length > 0) nextController.abort(UPLOAD_PREEMPTED);
      },
    };
  }

  return {
    acquire(token, opts): Promise<UploadLock> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
      const holder = holders.get(token);
      if (!holder) {
        const controller = new AbortController();
        holders.set(token, { controller, queue: [] });
        return Promise.resolve(makeLock(token, controller));
      }
      return new Promise<UploadLock>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const idx = holder.queue.indexOf(entry);
            if (idx !== -1) holder.queue.splice(idx, 1);
            reject(new UploadLockTimeoutError(token));
          }, timeoutMs),
        };
        holder.queue.push(entry);
        // Ask the current holder to yield. `abort()` is idempotent, so a
        // second waiter arriving needs no "already preempted" flag.
        holder.controller.abort(UPLOAD_PREEMPTED);
      });
    },
  };
}
