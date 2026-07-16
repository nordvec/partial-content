/**
 * Resumable-upload engine: the wire-agnostic protocol core.
 *
 * One pure state machine evaluates every upload interaction (creation, offset
 * probe, append, cancel) against caller-supplied state and policy, and returns
 * a typed VERDICT. It never touches bytes, storage, clocks, or HTTP framing:
 * the wire dialects map verdicts to statuses and header names, the
 * orchestrator executes verdict actions against a write store, and the caller
 * injects `now`.
 *
 * Contract split (mirrors the read-side kernel's discipline):
 * - Request-derived values (offsets, lengths, completeness flags a client
 *   claimed) are DATA: anything inconsistent becomes a reject verdict, never
 *   a throw.
 * - Caller-supplied state (what the adapter read back from storage) is
 *   TRUSTED INPUT with a sanity gate: malformed state is an adapter bug and
 *   throws loudly (RangeError), exactly like corrupt metadata on the read
 *   side.
 * - The engine decides; it never performs. An `append-allowed` verdict is a
 *   permission with bounds, and the orchestrator must re-derive fresh state
 *   from the store before acting on one (offsets are adapter-authoritative;
 *   a cached offset is the corruption class this design exists to prevent).
 *
 * @packageDocumentation
 */

// ─── State, Policy, Intents ─────────────────────────────────────────────────

/**
 * Authoritative upload-resource state, as freshly derived from storage by the
 * adapter. `offset` must come from backend bookkeeping (part listings, block
 * lists, an fsynced stat), never from a separately persisted counter.
 */
export interface UploadState {
  /** Bytes durably committed. Monotonic; never client-supplied. */
  offset: number;
  /** Total representation length. Immutable once known; undefined = deferred. */
  length?: number;
  /** The server's completion verdict (not an echo of any request). */
  isComplete: boolean;
  /**
   * Terminal dead state: the resource lost bytes, or an append was ever
   * committed past a known length. Every later interaction is refused.
   */
  isInvalidated: boolean;
  /** Epoch milliseconds of resource creation (for lifetime policy). */
  createdAt: number;
  /** Epoch milliseconds of the last accepted append, when any. */
  lastAppendAt?: number;
}

/**
 * Server policy for one upload surface. All fields optional: an absent bound
 * is simply not enforced. Dialects advertise these (e.g. as `Upload-Limit`
 * members); the engine enforces them BEFORE any byte reaches an adapter.
 */
export interface UploadPolicy {
  /** Maximum total representation size in bytes. */
  maxSize?: number;
  /** Minimum total representation size in bytes. */
  minSize?: number;
  /** Maximum bytes accepted by a single append. */
  maxAppendSize?: number;
  /**
   * Minimum bytes required per append. Exemptions (spec-mandated): a
   * creation with no content, and an append that completes the upload.
   */
  minAppendSize?: number;
  /** Maximum resource lifetime in seconds, measured from creation. */
  maxAgeSeconds?: number;
}

/** Start a new upload resource. */
export interface CreateIntent {
  kind: "create";
  /** Declared total length, when the client sent one. */
  declaredLength?: number;
  /** Size of the content carried by THIS request, when known up front. */
  contentLength?: number;
  /** Whether the request carries any content at all. */
  hasContent: boolean;
  /** Client marked the upload complete with this request. */
  complete: boolean;
}

/** Read the current offset/completeness (HEAD/GET on the upload resource). */
export interface ProbeIntent {
  kind: "probe";
}

/** Append content at an offset, optionally completing the upload. */
export interface AppendIntent {
  kind: "append";
  /** The offset the client claims to be appending at. */
  offset: number;
  /** Size of this request's content, when known up front. */
  contentLength?: number;
  /** Client marks the upload complete with this request. */
  complete: boolean;
  /** Declared total length, when this request (re-)states one. */
  declaredLength?: number;
}

/** Cancel the upload resource (DELETE). */
export interface CancelIntent {
  kind: "cancel";
}

export type UploadIntent = ProbeIntent | AppendIntent | CancelIntent;

/** Evaluation options: injected clock + concurrency snapshot. */
export interface UploadEvaluateOptions {
  /** Current time, epoch milliseconds. Injected: the engine reads no clock. */
  now: number;
  /**
   * Another request is mid-flight on this resource. The engine then decides
   * preempt-vs-refuse per `preemptInFlight`.
   */
  hasInFlight?: boolean;
  /**
   * Concurrency strategy when `hasInFlight` is set: `true` (default, the
   * spec-recommended behavior) asks the orchestrator to terminate the prior
   * request and re-evaluate; `false` refuses with `contended` (dialects map
   * it to 423, which the dominant client treats as retry-later, keeping it
   * distinct from the re-probe signal an offset mismatch sends).
   */
  preemptInFlight?: boolean;
}

// ─── Verdicts ───────────────────────────────────────────────────────────────

/** Audit event synthesized by an evaluation. Content-free by construction. */
export type UploadAuditEvent =
  | { kind: "created"; declaredLength?: number }
  | { kind: "append-accepted"; atOffset: number; completes: boolean }
  | { kind: "append-rejected"; reason: UploadRejectReason; atOffset?: number }
  | { kind: "completed"; length: number }
  | { kind: "cancelled" }
  | { kind: "expired" };

export type UploadRejectReason =
  | "offset-mismatch"
  | "length-inconsistent"
  | "size-exceeded"
  | "append-too-small"
  | "append-too-large"
  | "below-min-size"
  | "already-complete"
  | "invalidated"
  | "expired"
  | "contended";

/**
 * Wire-agnostic outcome of an evaluation. Dialects map each variant to a
 * status + header set; the orchestrator executes `append`/`complete`/
 * `deactivate` actions against the write store.
 */
export type UploadVerdict =
  /** Creation accepted: allocate the resource, then stream any content. */
  | {
      kind: "create-accepted";
      /** Length to record, when declared (immutable afterwards). */
      declaredLength?: number;
      /** Bytes this request may append at offset 0 (policy-clamped bound). */
      maxBytes?: number;
      /** The request also completes the upload once content is processed. */
      completes: boolean;
      events: UploadAuditEvent[];
    }
  /** Offset probe answer. */
  | {
      kind: "probe-result";
      offset: number;
      length?: number;
      complete: boolean;
      /** Remaining lifetime in whole seconds, when a max age applies. */
      remainingLifetimeSeconds?: number;
      events: UploadAuditEvent[];
    }
  /** Append permitted at the (verified) current offset. */
  | {
      kind: "append-allowed";
      atOffset: number;
      /**
       * Hard byte bound for this append: remaining space toward a known
       * length and/or the per-append cap. The orchestrator MUST enforce it
       * while streaming when the content size was not known up front;
       * exceeding it means the resource is invalidated.
       */
      maxBytes?: number;
      /** Length to record when this request declared it for the first time. */
      declaredLength?: number;
      /** Whether full processing of this content completes the upload. */
      completes: boolean;
      events: UploadAuditEvent[];
    }
  /** Zero-content append that completes an upload already at its length. */
  | { kind: "complete-now"; length: number; events: UploadAuditEvent[] }
  /**
   * The claimed offset is not the durable offset. Carries the correct one:
   * the retry mechanism the spec's conflict semantics depend on.
   */
  | {
      kind: "offset-mismatch";
      claimedOffset: number;
      correctOffset: number;
      complete: boolean;
      events: UploadAuditEvent[];
    }
  /** Valid re-interaction with a completed upload (idempotent retry). */
  | { kind: "already-complete"; length?: number; events: UploadAuditEvent[] }
  /** Another request is active and preemption is disabled. */
  | { kind: "contended"; events: UploadAuditEvent[] }
  /** Preemption chosen: terminate the holder, then re-evaluate fresh. */
  | { kind: "preempt-then-retry"; events: UploadAuditEvent[] }
  /** Policy bound violated before any byte moved. */
  | {
      kind: "limit-violation";
      reason: Extract<
        UploadRejectReason,
        "size-exceeded" | "append-too-small" | "append-too-large" | "below-min-size"
      >;
      events: UploadAuditEvent[];
    }
  /** Conflicting or mutated length indicators. */
  | { kind: "length-inconsistent"; events: UploadAuditEvent[] }
  /** Terminal: resource invalidated, expired, or cancelled. */
  | {
      kind: "gone";
      reason: Extract<UploadRejectReason, "invalidated" | "expired">;
      events: UploadAuditEvent[];
    }
  /** Cancellation accepted: deactivate and preempt any in-flight request. */
  | { kind: "cancel-accepted"; events: UploadAuditEvent[] };

// ─── Guards ─────────────────────────────────────────────────────────────────

/** Non-negative safe integer, or undefined. */
function isCount(n: number | undefined): boolean {
  return n === undefined || (Number.isSafeInteger(n) && n >= 0);
}

/**
 * Caller-supplied state is adapter output: malformed values are an adapter
 * bug, and silently "handling" them would launder corruption into protocol
 * answers. Fail loudly, same posture as the read-side kernel's totalSize gate.
 */
function assertSaneState(state: UploadState): void {
  if (!isCount(state.offset) || state.offset === undefined) {
    throw new RangeError(`upload engine: state.offset must be a non-negative safe integer, got ${state.offset}`);
  }
  if (!isCount(state.length)) {
    throw new RangeError(`upload engine: state.length must be a non-negative safe integer or undefined, got ${state.length}`);
  }
  if (state.length !== undefined && state.offset > state.length && !state.isInvalidated) {
    throw new RangeError(
      `upload engine: state.offset ${state.offset} exceeds state.length ${state.length}; ` +
      "the adapter must have invalidated this resource",
    );
  }
  if (!Number.isFinite(state.createdAt)) {
    throw new RangeError(`upload engine: state.createdAt must be a finite timestamp, got ${state.createdAt}`);
  }
}

/** Remaining lifetime in whole seconds, or undefined when no max age applies. */
export function remainingLifetimeSeconds(
  state: Pick<UploadState, "createdAt">,
  policy: Pick<UploadPolicy, "maxAgeSeconds">,
  now: number,
): number | undefined {
  if (policy.maxAgeSeconds === undefined) return undefined;
  const elapsed = Math.floor((now - state.createdAt) / 1000);
  return Math.max(0, policy.maxAgeSeconds - elapsed);
}

function isExpired(state: UploadState, policy: UploadPolicy, now: number): boolean {
  const remaining = remainingLifetimeSeconds(state, policy, now);
  return remaining !== undefined && remaining <= 0 && now > state.createdAt;
}

// ─── Creation ───────────────────────────────────────────────────────────────

/**
 * Evaluate a creation request. There is no state yet: this is pure policy
 * (size window, per-append bound) over the request's declared shape.
 */
export function evaluateUploadCreation(
  intent: CreateIntent,
  policy: UploadPolicy,
): UploadVerdict {
  // Request-derived numbers are data: malformed means reject, never throw.
  if (!isCount(intent.declaredLength) || !isCount(intent.contentLength)) {
    return {
      kind: "length-inconsistent",
      events: [{ kind: "append-rejected", reason: "length-inconsistent" }],
    };
  }

  // Two length indicators in one request must agree: a declared total AND a
  // completing request whose content is the whole representation.
  if (
    intent.complete
    && intent.declaredLength !== undefined
    && intent.contentLength !== undefined
    && intent.contentLength !== intent.declaredLength
  ) {
    return {
      kind: "length-inconsistent",
      events: [{ kind: "append-rejected", reason: "length-inconsistent" }],
    };
  }

  const knownTotal = intent.declaredLength
    ?? (intent.complete ? intent.contentLength : undefined);

  if (policy.maxSize !== undefined) {
    const lower = knownTotal ?? intent.contentLength ?? 0;
    if (lower > policy.maxSize) {
      return {
        kind: "limit-violation",
        reason: "size-exceeded",
        events: [{ kind: "append-rejected", reason: "size-exceeded" }],
      };
    }
  }
  if (policy.minSize !== undefined && knownTotal !== undefined && knownTotal < policy.minSize) {
    return {
      kind: "limit-violation",
      reason: "below-min-size",
      events: [{ kind: "append-rejected", reason: "below-min-size" }],
    };
  }
  if (
    policy.maxAppendSize !== undefined
    && intent.contentLength !== undefined
    && intent.contentLength > policy.maxAppendSize
  ) {
    return {
      kind: "limit-violation",
      reason: "append-too-large",
      events: [{ kind: "append-rejected", reason: "append-too-large" }],
    };
  }
  // Min-append floor: a creation WITHOUT content is exempt regardless of its
  // completeness flag (spec exemption; an empty create merely allocates).
  if (
    policy.minAppendSize !== undefined
    && intent.hasContent
    && !intent.complete
    && intent.contentLength !== undefined
    && intent.contentLength < policy.minAppendSize
  ) {
    return {
      kind: "limit-violation",
      reason: "append-too-small",
      events: [{ kind: "append-rejected", reason: "append-too-small" }],
    };
  }

  return {
    kind: "create-accepted",
    declaredLength: knownTotal,
    maxBytes: appendBound(0, knownTotal, policy),
    completes: intent.complete,
    events: [{ kind: "created", declaredLength: knownTotal }],
  };
}

// ─── Resource interactions ──────────────────────────────────────────────────

/**
 * Evaluate an interaction with an EXISTING upload resource against freshly
 * adapter-derived state. The verdict's ordering rules are load-bearing:
 * terminal states first, then contention, then per-intent logic, so a dead
 * or contended resource can never leak an `append-allowed`.
 */
export function evaluateUploadIntent(
  intent: UploadIntent,
  state: UploadState,
  policy: UploadPolicy,
  opts: UploadEvaluateOptions,
): UploadVerdict {
  assertSaneState(state);

  // Terminal states answer everything, including cancels.
  if (state.isInvalidated) {
    return { kind: "gone", reason: "invalidated", events: [{ kind: "append-rejected", reason: "invalidated" }] };
  }
  if (isExpired(state, policy, opts.now)) {
    return { kind: "gone", reason: "expired", events: [{ kind: "expired" }] };
  }

  if (intent.kind === "cancel") {
    // Cancels preempt whatever is running; that is their point.
    return { kind: "cancel-accepted", events: [{ kind: "cancelled" }] };
  }

  // Concurrency gate. Probes are included deliberately: reading a torn
  // multi-call offset (a part listing raced by an in-flight append) would
  // answer with a stale offset the very next append must then reject.
  if (opts.hasInFlight) {
    if (opts.preemptInFlight ?? true) {
      return { kind: "preempt-then-retry", events: [] };
    }
    return { kind: "contended", events: [{ kind: "append-rejected", reason: "contended" }] };
  }

  if (intent.kind === "probe") {
    return {
      kind: "probe-result",
      offset: state.offset,
      length: state.length,
      complete: state.isComplete,
      remainingLifetimeSeconds: remainingLifetimeSeconds(state, policy, opts.now),
      events: [],
    };
  }

  return evaluateAppend(intent, state, policy);
}

function evaluateAppend(
  intent: AppendIntent,
  state: UploadState,
  policy: UploadPolicy,
): UploadVerdict {
  if (!isCount(intent.offset) || !isCount(intent.contentLength) || !isCount(intent.declaredLength)) {
    return {
      kind: "length-inconsistent",
      events: [{ kind: "append-rejected", reason: "length-inconsistent" }],
    };
  }

  // Length immutability: once known, a request may only restate the same
  // value. This precedes the offset check so a client that lost track of the
  // representation shape learns THAT first (a retried offset probe cannot fix
  // a wrong length).
  if (
    intent.declaredLength !== undefined
    && state.length !== undefined
    && intent.declaredLength !== state.length
  ) {
    return {
      kind: "length-inconsistent",
      events: [{ kind: "append-rejected", reason: "length-inconsistent" }],
    };
  }
  const length = state.length ?? intent.declaredLength;

  // A completing request with a known content size fixes the total; it must
  // agree with any known length.
  if (
    intent.complete
    && intent.contentLength !== undefined
    && length !== undefined
    && intent.offset + intent.contentLength !== length
    // A retried completion at the durable end is handled below, not here.
    && !(state.isComplete && intent.offset === state.offset)
  ) {
    return {
      kind: "length-inconsistent",
      events: [{ kind: "append-rejected", reason: "length-inconsistent" }],
    };
  }

  // Completed uploads: a matching retry is answered idempotently; anything
  // else is an offset mismatch carrying the truth.
  if (state.isComplete) {
    if (intent.offset === state.offset) {
      return { kind: "already-complete", length: state.length, events: [] };
    }
    return mismatch(intent.offset, state);
  }

  if (intent.offset !== state.offset) {
    return mismatch(intent.offset, state);
  }

  // Policy bounds, checked before any byte is allowed to move.
  if (policy.maxAppendSize !== undefined && intent.contentLength !== undefined
    && intent.contentLength > policy.maxAppendSize) {
    return {
      kind: "limit-violation",
      reason: "append-too-large",
      events: [{ kind: "append-rejected", reason: "append-too-large", atOffset: intent.offset }],
    };
  }
  // Min-append floor: completing requests are exempt (the tail of an upload
  // is however small it is); a zero-content NON-completing append is not.
  if (
    policy.minAppendSize !== undefined
    && !intent.complete
    && intent.contentLength !== undefined
    && intent.contentLength < policy.minAppendSize
  ) {
    return {
      kind: "limit-violation",
      reason: "append-too-small",
      events: [{ kind: "append-rejected", reason: "append-too-small", atOffset: intent.offset }],
    };
  }
  // Size ceiling: a known content size may not cross a known length or the
  // policy maximum. Rejected BEFORE writing, so the resource stays valid
  // (invalidation is reserved for bytes that actually landed past a bound).
  if (intent.contentLength !== undefined) {
    if (length !== undefined && intent.offset + intent.contentLength > length) {
      return {
        kind: "length-inconsistent",
        events: [{ kind: "append-rejected", reason: "length-inconsistent", atOffset: intent.offset }],
      };
    }
    if (policy.maxSize !== undefined && intent.offset + intent.contentLength > policy.maxSize) {
      return {
        kind: "limit-violation",
        reason: "size-exceeded",
        events: [{ kind: "append-rejected", reason: "size-exceeded", atOffset: intent.offset }],
      };
    }
  }

  // Zero-content completion of an upload already at its declared length.
  if (intent.complete && !intent.contentLength && length !== undefined && state.offset === length) {
    return {
      kind: "complete-now",
      length,
      events: [{ kind: "completed", length }],
    };
  }

  const completes = intent.complete;
  return {
    kind: "append-allowed",
    atOffset: state.offset,
    maxBytes: appendBound(state.offset, length, policy),
    declaredLength: state.length === undefined ? intent.declaredLength : undefined,
    completes,
    events: [{ kind: "append-accepted", atOffset: state.offset, completes }],
  };
}

function mismatch(claimedOffset: number, state: UploadState): UploadVerdict {
  return {
    kind: "offset-mismatch",
    claimedOffset,
    correctOffset: state.offset,
    complete: state.isComplete,
    events: [{ kind: "append-rejected", reason: "offset-mismatch", atOffset: claimedOffset }],
  };
}

/**
 * Hard byte bound for one append: remaining room toward a known length,
 * remaining room under the policy maximum, and the per-append cap, whichever
 * is smallest. Undefined when nothing bounds the append.
 */
function appendBound(
  offset: number,
  length: number | undefined,
  policy: UploadPolicy,
): number | undefined {
  const bounds: number[] = [];
  if (length !== undefined) bounds.push(length - offset);
  if (policy.maxSize !== undefined) bounds.push(policy.maxSize - offset);
  if (policy.maxAppendSize !== undefined) bounds.push(policy.maxAppendSize);
  if (bounds.length === 0) return undefined;
  return Math.max(0, Math.min(...bounds));
}
