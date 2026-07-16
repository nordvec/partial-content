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
 * -instance deployments supply their own {@link UploadLocker} backed by
 * shared infrastructure; the interface is deliberately tiny so that stays a
 * page of code.
 */

/** A held lock. Release exactly once; further calls are no-ops. */
export interface UploadLock {
  release(): void;
}

/** Thrown when the holder did not yield within the acquire timeout. */
export class UploadLockTimeoutError extends Error {
  readonly uploadToken: string;
  constructor(uploadToken: string) {
    super(`Upload ${uploadToken}: lock holder did not yield in time`);
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
   * Acquire the lock for one upload resource. `onPreemptRequested` is
   * invoked (at most once) if a LATER acquirer wants the lock: the holder
   * must abort its work at the next safe boundary and release.
   */
  acquire(
    uploadToken: string,
    onPreemptRequested: () => void,
    opts?: AcquireOptions,
  ): Promise<UploadLock>;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;

interface Holder {
  preempt: () => void;
  preempted: boolean;
  queue: Array<{
    resolve: (lock: UploadLock) => void;
    reject: (err: Error) => void;
    preempt: () => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

/** Single-process in-memory locker (the default). */
export function memoryUploadLocker(): UploadLocker {
  const holders = new Map<string, Holder>();

  function makeLock(token: string): UploadLock {
    let released = false;
    return {
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
        holder.preempt = next.preempt;
        holder.preempted = false;
        // Hand-over wakes the next waiter as the new holder. If more
        // waiters remain, the new holder is preempted immediately: the
        // queue only grows when callers keep arriving, and each is served
        // in FIFO order with the same yield pressure.
        next.resolve(makeLock(token));
        if (holder.queue.length > 0 && !holder.preempted) {
          holder.preempted = true;
          holder.preempt();
        }
      },
    };
  }

  return {
    acquire(token, onPreemptRequested, opts): Promise<UploadLock> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
      const holder = holders.get(token);
      if (!holder) {
        holders.set(token, { preempt: onPreemptRequested, preempted: false, queue: [] });
        return Promise.resolve(makeLock(token));
      }
      return new Promise<UploadLock>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          preempt: onPreemptRequested,
          timer: setTimeout(() => {
            const idx = holder.queue.indexOf(entry);
            if (idx !== -1) holder.queue.splice(idx, 1);
            reject(new UploadLockTimeoutError(token));
          }, timeoutMs),
        };
        holder.queue.push(entry);
        if (!holder.preempted) {
          holder.preempted = true;
          holder.preempt();
        }
      });
    },
  };
}
