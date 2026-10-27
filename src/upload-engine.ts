/**
 * Resumable-upload engine: the wire-agnostic protocol core.
 *
 * One pure state machine evaluates every upload interaction (creation, offset
 * probe, append) against caller-supplied state and policy, and returns
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
 * - One question is unanswerable here and the engine does not pretend
 *   otherwise: how much content a request that declared no size carries. It is
 *   knowable only by reading the body, and the store is what reads it. The
 *   engine therefore answers a byte BOUND plus a POST-CONDITION
 *   ({@link AppendPostCondition}) over the bytes that actually landed, and the
 *   orchestrator evaluates it against the store's own `bytesWritten`.
 *
 * @packageDocumentation
 */

// ─── State, Policy, Intents ─────────────────────────────────────────────────

/**
 * The lifecycle of an upload resource. One field, so a resource that is both
 * complete and invalidated cannot be stated.
 *
 * May gain a member in a minor release: give a switch over it a default branch.
 */
export type UploadStatus = "incomplete" | "complete" | "invalidated";

/**
 * Authoritative upload-resource state, as freshly derived from storage by the
 * adapter. `offset` must come from backend bookkeeping (part listings, block
 * lists, an fsynced stat), never from a separately persisted counter.
 */
export interface UploadState {
    /**
     * Bytes durably committed. Never client-supplied, and monotonic except for
     * one bounded regression: an adapter that must remove a staged sub-minimum
     * remainder before folding it into a part (the s3 adapter does so for a
     * remainder an earlier release parked) drops it on a crash in that window,
     * and the client resumes lower. Understating is the safe direction (a re-sent chunk); overstating
     * would silently skip bytes the client believes landed.
     */
    offset: number;
    /** Total representation length. Immutable once known; undefined = deferred. */
    length?: number;
    /**
     * The server's lifecycle verdict, never an echo of any request.
     * `"invalidated"` is terminal: the resource lost bytes, or an append was
     * ever committed past a known length, and every later interaction is
     * refused.
     */
    status: UploadStatus;
    /** Epoch milliseconds of resource creation. */
    createdAt: number;
    /** Epoch milliseconds of the expiry recorded at creation, when the store kept one. */
    expiresAt?: number;
    /** Epoch milliseconds of the last accepted append, when any. */
    lastAppendAt?: number;
}

/**
 * Server policy for one upload surface. All fields optional: an absent bound
 * is simply not enforced. Dialects advertise these (e.g. as `Upload-Limit`
 * members); the engine enforces them BEFORE any byte reaches an adapter.
 *
 * OPERATIONAL SECURITY: an upload surface with NEITHER `maxSize` NOR
 * `maxAgeSeconds` accepts unbounded bytes AND never expires abandoned
 * resources, so a client can grow storage without limit. Set at least one on
 * any surface reachable by untrusted clients. Note that `maxAgeSeconds` only
 * makes a resource ELIGIBLE for expiry; storage is reclaimed only when you
 * periodically call the store's `sweepExpired()` (e.g. from a cron), so pair
 * the two, and pass that sweep `createdBeforeMs: now - maxAgeSeconds * 1000`.
 * An idleness cutoff alone can never reach a resource that traffic keeps
 * active while every request against it is already refused as expired.
 * `maxSize` caps the total per resource; `maxAppendSize` additionally bounds a
 * single request.
 */
export interface UploadPolicy {
    /**
     * Maximum total representation size in bytes. Unset or `Infinity` = no
     * per-upload cap. Both handlers require it, so `Infinity` is how a handler
     * states that it serves unbounded uploads.
     */
    maxSize?: number;
    /** Minimum total representation size in bytes. */
    minSize?: number;
    /** Maximum bytes accepted by a single append. */
    maxAppendSize?: number;
    /**
     * Minimum bytes required per append. Exemptions (spec-mandated): a
     * creation with no content, and an append the CLIENT states completes the
     * upload.
     *
     * Setting it makes an append that declares no content size a refusal, since
     * a floor is a claim about bytes and the only honest moment to check it is
     * before any of them move: after the write they are durable, and rejecting
     * content the resource kept is not a rejection. An append a client states is
     * final stays exempt, so a client that cannot state a size can still finish.
     *
     * The exemption follows the client's STATEMENT and not the flag the engine
     * evaluates: an inferred completion ({@link AppendIntent.completeInferred})
     * carries no exemption, because an inference is not something the client
     * said. It is therefore only reachable on a wire where a request can assert
     * its own completion. The tus dialect infers completion from a known total, so
     * an upload created with a deferred length can never claim it, and every
     * chunked append would meet a floor it cannot escape and cannot discover,
     * tus having no header that advertises one. `createTusHandler` therefore
     * refuses this field at construction rather than serving an endpoint that
     * answers 400 forever.
     */
    minAppendSize?: number;
    /**
     * Maximum resource lifetime in seconds, measured from creation. Unset =
     * resources never expire. Enforced lazily on access AND, for actual storage
     * reclamation of abandoned uploads, by a periodic `sweepExpired()` sweep.
     *
     * It bounds the lifetime of an UNFINISHED upload. A completed one is
     * exempt: its bytes are already published and are no longer this resource's
     * to expire, while its completion answer is what lets a client that lost the
     * response recover. The sweep still reclaims the finished resource's
     * bookkeeping on its own clock.
     *
     * The policy that creates an upload fixes its deadline: the store records
     * `createdAt + maxAgeSeconds` and every later request judges by that
     * instant, so a request resolving another max age neither shortens nor
     * extends a lifetime already granted.
     */
    maxAgeSeconds?: number;
    /**
     * What a request does with a digest assertion (`Repr-Digest`, RFC 9530) in
     * an algorithm the store cannot verify at completion.
     *
     * - `"advisory"` (default): the assertion is dropped and the upload
     *   publishes unverified, RFC 9530's reading of the field. Assertions in
     *   an algorithm the store does verify are enforced.
     * - `"require-verifiable"`: a request asserting at least one digest, none
     *   of them verifiable by the store, is refused with a 400 before any
     *   resource is allocated or byte written (`UploadDigestUnverifiableError`
     *   in the audit stream as `append-rejected` with reason
     *   `"digest-unverifiable"`). A request that asserts nothing, or asserts
     *   at least one verifiable algorithm, proceeds as usual.
     *
     * Part of the policy so a per-request policy resolver can choose it per
     * tenant. It governs the IETF dialect, the only one whose assertion
     * reaches the store; the tus dialect verifies `Upload-Checksum` itself and
     * refuses this field at construction.
     */
    digestPolicy?: "advisory" | "require-verifiable";
}

/** Start a new upload resource. */
export interface CreateIntent {
    kind: "create";
    /** Declared total length, when the client sent one. */
    declaredLength?: number;
    /** Size of the content carried by THIS request, when known up front. */
    contentLength?: number;
    /** Client marked the upload complete with this request. */
    complete: boolean;
}

/** Read the current offset/completeness (HEAD/GET on the upload resource). */
interface ProbeIntent {
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
    /**
     * `complete` was DERIVED from durable state rather than stated on the wire
     * (the tus model, where completion is implicit at offset == length). Set by
     * the orchestrator, which owns that derivation; a dialect never sets it.
     *
     * It is what separates a client's assertion from the engine's own
     * conclusion, and the {@link UploadPolicy.minAppendSize} exemption is
     * written for the assertion. An inference is not one: on a known-length
     * upload it resolves to true for any body whose size the request did not
     * declare, so an exempt inference would leave the floor binding only on
     * requests that declare a size.
     */
    completeInferred?: boolean;
    /** Declared total length, when this request (re-)states one. */
    declaredLength?: number;
}

/**
 * A cancel (DELETE) is not an intent: it is answered whatever the resource's
 * state, so there is nothing for the engine to decide.
 */
export type UploadIntent = ProbeIntent | AppendIntent;

/**
 * Evaluation options: just the injected clock. Concurrency is NOT an engine
 * concern: the locker owns it end to end (it serializes every interaction on
 * a resource and preempts a stalled holder), so the engine always evaluates
 * fresh, uncontended state. A lock timeout surfaces as `contended` from the
 * orchestrator, never from here.
 */
export interface UploadEvaluateOptions {
    /** Current time, epoch milliseconds. Injected: the engine reads no clock. */
    now: number;
}

// ─── Verdicts ───────────────────────────────────────────────────────────────

/**
 * Audit event for one upload decision or outcome. Content-free by construction.
 *
 * A verdict only ever carries DECISION events (created, append-accepted,
 * append-rejected, expired): facts that are already true the moment the engine
 * answers. The OUTCOME events (`appended`, `completed`, `cancelled`,
 * `lock-contended`) describe a store or locker action the engine does not
 * perform and cannot know the result of, so they are the orchestrator's to
 * emit, after that action returns. Synthesizing one here would record an
 * outcome a throwing store call never produced.
 *
 * - `appended`: a write returned; `bytes` is what it made durable and
 *   `interrupted` whether the body stopped short of what the request sent.
 * - `lock-contended`: the resource lock was not acquired in time, so the
 *   request was refused without reading state.
 *
 * May gain a member in a minor release: give a switch over it a default branch.
 */
export type UploadAuditEvent =
    | { kind: "created"; declaredLength?: number }
    | { kind: "append-accepted"; atOffset: number; completes: boolean }
    | { kind: "append-rejected"; reason: UploadRejectReason; atOffset?: number }
    | { kind: "appended"; atOffset: number; bytes: number; interrupted: boolean }
    | { kind: "completed"; length: number }
    | { kind: "cancelled" }
    | { kind: "expired" }
    | { kind: "lock-contended" };

/**
 * Which representation bound a fatal append crossed: the length the client
 * declared, or the policy's total maximum.
 *
 * May gain a member in a minor release: give a switch over it a default branch.
 */
export type FatalBoundReason = "length" | "size";

/**
 * What the bytes an append actually delivers must satisfy, checked AFTER the
 * write against the store's own `bytesWritten`.
 *
 * Every other bound the engine enforces before a byte moves. This one it can
 * only state, because a request that declares no content size makes "how much
 * content is there" unanswerable until the body has been read, and the store
 * is the party that reads it. The orchestrator holds that fact and evaluates
 * this there.
 */
interface AppendPostCondition {
    /**
     * Durable total this request must reach for it to complete the upload.
     *
     * Fixed in advance by any length indicator the request or the resource
     * carries: a known representation length, or a completing request's own
     * content size. Undefined when nothing fixes it, in which case a completing
     * append publishes at whatever total it delivers, and undefined for a
     * request that does not complete at all.
     */
    completesAt?: number;
}

/**
 * Why an append (or a creation's body) was refused. `digest-mismatch` is a
 * completion whose assembled bytes did not match the client's assertion.
 * `digest-unverifiable` is an assertion the store cannot verify, refused under
 * `digestPolicy: "require-verifiable"`.
 *
 * May gain a member in a minor release: give a switch over it a default branch.
 */
export type UploadRejectReason =
    | "offset-mismatch"
    | "length-inconsistent"
    | "size-exceeded"
    | "append-too-small"
    | "append-too-large"
    | "below-min-size"
    | "invalidated"
    | "expired"
    | "digest-mismatch"
    | "digest-unverifiable"
    | "destination-conflict";

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
          /** Whether crossing `maxBytes` is the representation's terminal fault. */
          maxBytesFatal: boolean;
          /**
           * Which representation bound `maxBytes` came from, when the bound is
           * a representation bound (fatal, or the zero bound). Absent when only
           * `maxAppendSize` binds. Decides what the client is told, never
           * whether the resource is invalidated.
           */
          fatalReason?: FatalBoundReason;
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
          events: UploadAuditEvent[];
      }
    /** Append permitted at the (verified) current offset. */
    | {
          kind: "append-allowed";
          atOffset: number;
          /**
           * Hard byte bound for this append: remaining space toward a known
           * length and/or the per-append cap. The orchestrator MUST enforce it
           * while streaming when the content size was not known up front.
           */
          maxBytes?: number;
          /**
           * Whether crossing `maxBytes` is the representation's terminal fault
           * (invalidate) or merely this request's ceiling (stop at the bound and
           * let the client resume). See {@link appendBound}: the two are different
           * constraints and only one of them means the upload can never be
           * completed coherently.
           */
          maxBytesFatal: boolean;
          /**
           * Which representation bound `maxBytes` came from, when the bound is
           * a representation bound (fatal, or the zero bound). Absent when only
           * `maxAppendSize` binds. Decides what the client is told, never
           * whether the resource is invalidated.
           */
          fatalReason?: FatalBoundReason;
          /** Length to record when this request declared it for the first time. */
          declaredLength?: number;
          /** Whether full processing of this content completes the upload. */
          completes: boolean;
          /**
           * What the delivered bytes must satisfy before this request may
           * publish. Evaluated by the orchestrator against `bytesWritten`.
           */
          postCondition: AppendPostCondition;
          events: UploadAuditEvent[];
      }
    /**
     * The claimed offset is not the durable offset. Carries the correct one:
     * the retry mechanism the spec's conflict semantics depend on.
     *
     * It carries no completeness. A conflict is resumable at the offset named
     * beside it, and the resource's own completeness is not what a client asks
     * here; a field nothing may read is a field that gets read, so there is
     * none.
     */
    | {
          kind: "offset-mismatch";
          claimedOffset: number;
          correctOffset: number;
          events: UploadAuditEvent[];
      }
    /** Valid re-interaction with a completed upload (idempotent retry). */
    | { kind: "already-complete"; length?: number; events: UploadAuditEvent[] }
    /**
     * The locker could not hand over in time (a stalled holder); retry later.
     * Produced by the orchestrator, which owns the lock, never by an engine
     * decision; the arm lives here so a dialect maps one verdict union.
     */
    | { kind: "contended"; events: UploadAuditEvent[] }
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
    /** Terminal: resource invalidated or expired. */
    | {
          kind: "gone";
          reason: Extract<UploadRejectReason, "invalidated" | "expired">;
          events: UploadAuditEvent[];
      };

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
    // An offset past a known length is only sane on a resource the adapter
    // already invalidated. Every field is a non-negative safe integer
    // (`length` may be undefined) and `createdAt` a finite timestamp.
    const { offset, length, createdAt } = state;
    if (
        offset === undefined ||
        !isCount(offset) ||
        !isCount(length) ||
        (offset > (length ?? Infinity) && state.status !== "invalidated") ||
        !Number.isFinite(createdAt) ||
        (state.expiresAt !== undefined && !Number.isFinite(state.expiresAt))
    ) {
        throw new RangeError(
            `upload engine: malformed adapter state (offset ${offset}, length ${length}, createdAt ${createdAt})`,
        );
    }
}

/**
 * The resource's deadline, epoch ms, which a dialect advertises as its
 * expiry: the instant recorded at creation, so a request resolving a shorter
 * policy cannot shorten a lifetime already granted. A resource with none
 * recorded (created with no max age, before expiry was recorded, or by a
 * store that keeps none) is judged by `createdAt + maxAgeSeconds` under the
 * policy in hand; `undefined` means it does not expire.
 */
export function uploadExpiry(
    state: Pick<UploadState, "createdAt" | "expiresAt">,
    policy: UploadPolicy,
): number | undefined {
    if (state.expiresAt !== undefined) return state.expiresAt;
    return policy.maxAgeSeconds === undefined ? undefined : state.createdAt + policy.maxAgeSeconds * 1000;
}

/**
 * Whether the resource has reached its {@link uploadExpiry}. A resource is
 * never expired at the instant it was created, so a zero max age still
 * answers its creation.
 */
function isExpired(state: UploadState, policy: UploadPolicy, now: number): boolean {
    const deadline = uploadExpiry(state, policy);
    return deadline !== undefined && now >= deadline && now > state.createdAt;
}

// ─── Creation ───────────────────────────────────────────────────────────────

/**
 * Evaluate a creation request. There is no state yet: this is pure policy
 * (size window, per-append bound) over the request's declared shape.
 */
export function evaluateUploadCreation(intent: CreateIntent, policy: UploadPolicy): UploadVerdict {
    // Request-derived numbers are data: malformed means reject, never throw.
    if (!isCount(intent.declaredLength) || !isCount(intent.contentLength)) {
        return inconsistent();
    }

    // Two length indicators in one request must agree: a declared total AND a
    // completing request whose content is the whole representation.
    if (
        intent.complete &&
        intent.declaredLength !== undefined &&
        intent.contentLength !== undefined &&
        intent.contentLength !== intent.declaredLength
    ) {
        return inconsistent();
    }

    // Content larger than the total it declares is the same inconsistency
    // whether or not the request completes: the surplus bytes have nowhere to
    // go, and letting them reach the store trades a 400 for a dead resource.
    if (
        intent.declaredLength !== undefined &&
        intent.contentLength !== undefined &&
        intent.contentLength > intent.declaredLength
    ) {
        return inconsistent();
    }

    const knownTotal = intent.declaredLength ?? (intent.complete ? intent.contentLength : undefined);

    if (policy.maxSize !== undefined) {
        const lower = knownTotal ?? intent.contentLength ?? 0;
        if (lower > policy.maxSize) {
            return limited("size-exceeded");
        }
    }
    if (policy.minSize !== undefined && knownTotal !== undefined && knownTotal < policy.minSize) {
        return limited("below-min-size");
    }
    if (
        policy.maxAppendSize !== undefined &&
        intent.contentLength !== undefined &&
        intent.contentLength > policy.maxAppendSize
    ) {
        return limited("append-too-large");
    }
    // Min-append floor, binding on the one fact a creation states about its
    // content: a declared size. A creation WITHOUT content is exempt (spec
    // exemption; an empty create merely allocates), and a declared zero IS that
    // creation. An undeclared size is not evidence either way, and at creation
    // the two shapes are the same request, so the floor does not bind there; the
    // total floor (`minSize`) still gates publication.
    if (
        policy.minAppendSize !== undefined &&
        !intent.complete &&
        intent.contentLength !== undefined &&
        intent.contentLength > 0 &&
        intent.contentLength < policy.minAppendSize
    ) {
        return limited("append-too-small");
    }

    return {
        kind: "create-accepted",
        declaredLength: knownTotal,
        ...appendBound(0, knownTotal, policy),
        completes: intent.complete,
        events: [{ kind: "created", declaredLength: knownTotal }],
    };
}

// ─── Resource interactions ──────────────────────────────────────────────────

/**
 * Evaluate an interaction with an EXISTING upload resource against freshly
 * adapter-derived state. The verdict's ordering rules are load-bearing:
 * terminal states first, then per-intent logic, so a dead resource can never
 * leak an `append-allowed`.
 */
export function evaluateUploadIntent(
    intent: UploadIntent,
    state: UploadState,
    policy: UploadPolicy,
    opts: UploadEvaluateOptions,
): UploadVerdict {
    // Every intent reads the state's numbers, so they must be numbers.
    assertSaneState(state);

    // Terminal states answer everything else.
    if (state.status === "invalidated") {
        return { kind: "gone", reason: "invalidated", events: rejected("invalidated") };
    }
    // Expiry governs the UPLOAD RESOURCE: partial bytes nothing will ever
    // finish, and the right to keep appending to them. A completed upload has
    // neither. Its bytes are published, and the representation's lifetime
    // belongs to whatever now serves it, not to the resource that assembled it.
    // What remains is an ANSWER, "this token completed, at this length", and
    // that answer is the recovery mechanism: the only retry a resumable
    // protocol has is the client repeating its completing request, and the
    // idempotent reply to that repeat is also the sole path that re-delivers a
    // completion report whose first delivery failed. Expiring it would answer a
    // fabricated not-found to a client whose upload succeeded and strand that
    // report permanently. Reclaiming the completed resource's bookkeeping is
    // the sweep's job, on its own clock.
    if (state.status !== "complete" && isExpired(state, policy, opts.now)) {
        return { kind: "gone", reason: "expired", events: [{ kind: "expired" }] };
    }

    if (intent.kind === "probe") {
        return {
            kind: "probe-result",
            offset: state.offset,
            length: state.length,
            complete: state.status === "complete",
            events: [],
        };
    }

    return evaluateAppend(intent, state, policy);
}

function evaluateAppend(intent: AppendIntent, state: UploadState, policy: UploadPolicy): UploadVerdict {
    if (!isCount(intent.offset) || !isCount(intent.contentLength) || !isCount(intent.declaredLength)) {
        return inconsistent();
    }

    // Length immutability: once known, a request may only restate the same
    // value. This precedes the offset check so a client that lost track of the
    // representation shape learns THAT first (a retried offset probe cannot fix
    // a wrong length).
    if (intent.declaredLength !== undefined && state.length !== undefined && intent.declaredLength !== state.length) {
        return inconsistent();
    }
    const length = state.length ?? intent.declaredLength;

    // A length fixed for the first time must cover the bytes already durable: a
    // total below the offset is one the resource can never reach, and recording
    // it would persist a state every later probe and append refuses as
    // impossible. The size ceiling below catches this only when the request
    // declares a content size; a bodiless or chunked request is refused here.
    if (state.length === undefined && intent.declaredLength !== undefined && intent.declaredLength < state.offset) {
        return inconsistent(intent.offset);
    }

    // A length this request is the first to declare is a total, and a total over
    // the policy maximum is refused wherever it is declared. Creation checks the
    // same thing; without this, a deferred-length upload could name a size the
    // policy forbids and only discover it while streaming, as a dead resource.
    if (
        state.length === undefined &&
        intent.declaredLength !== undefined &&
        policy.maxSize !== undefined &&
        intent.declaredLength > policy.maxSize
    ) {
        return limited("size-exceeded", intent.offset);
    }

    // A completing request with a known content size fixes the total; it must
    // agree with any known length.
    if (
        intent.complete &&
        intent.contentLength !== undefined &&
        length !== undefined &&
        intent.offset + intent.contentLength !== length &&
        // A retried completion at the durable end is handled below, not here.
        !(state.status === "complete" && intent.offset === state.offset)
    ) {
        return inconsistent();
    }

    // Completed uploads: a bodiless retry at the durable end is answered
    // idempotently; anything else is refused, carrying the truth the client
    // needs.
    if (state.status === "complete") {
        if (intent.offset === state.offset) {
            // Idempotence covers a repeat of the completing request, which carries
            // no byte the representation does not already hold.
            //
            // A DECLARED positive content size is the client stating the opposite,
            // and those bytes have nowhere to go: the length is fixed at completion
            // and the offset may never exceed it, so the only honest answer names
            // that inconsistency. An UNDECLARED size states nothing a pure function
            // can see, so the verdict is the replay and the orchestrator settles it
            // from the body: it reads as far as the first byte, refuses one that
            // exists the same way, and replays only a body that carries none. No
            // byte is written or acknowledged as stored either way.
            if (intent.contentLength !== undefined && intent.contentLength > 0) {
                return inconsistent(intent.offset);
            }
            return { kind: "already-complete", length: state.length, events: [] };
        }
        return mismatch(intent.offset, state);
    }

    if (intent.offset !== state.offset) {
        return mismatch(intent.offset, state);
    }

    // Policy bounds, checked before any byte is allowed to move.
    if (
        policy.maxAppendSize !== undefined &&
        intent.contentLength !== undefined &&
        intent.contentLength > policy.maxAppendSize
    ) {
        return limited("append-too-large", intent.offset);
    }
    // Min-append floor: a request the client STATES is the final one is exempt
    // (the tail of an upload is however small it is); a zero-content
    // non-completing append is not.
    //
    // An UNDECLARED content size is refused under the same floor, before any
    // byte moves. The floor is a bound on what a request delivers, and that
    // number exists only once the body has been read, by which time the bytes
    // are durable: refusing them afterwards would answer a rejection for content
    // the resource kept, and keeping them would leave an advertised bound
    // unenforced. A client that cannot state its size cannot meet a floor it was
    // told about in `min-append-size`, and the completing exemption still lets it
    // finish.
    //
    // The exemption requires the client's own statement, never the engine's
    // inference. An inferred completion on a known-length upload is true of
    // every body whose size the request did not declare, so exempting it would
    // leave the floor binding on declared sizes alone: a client could send
    // one-byte undeclared appends without limit, each of them inferred final,
    // each writing its byte and failing the post-condition.
    //
    // The client's statement is exempt only where the engine can hold it to
    // the post-condition before the write: a declared content size fixes what
    // the body delivers, a deferred length makes the delivered bytes the
    // representation, and at the durable end of a known length the bound is
    // zero so no byte can land. An undeclared size on a known length with room
    // left is none of these: a false assertion costs the client nothing, the
    // short body stays durable, and the floor would bind on declared sizes
    // alone.
    const clientStatesFinal =
        intent.complete &&
        intent.completeInferred !== true &&
        (intent.contentLength !== undefined || length === undefined || length === state.offset);
    if (policy.minAppendSize !== undefined && !clientStatesFinal) {
        if (intent.contentLength === undefined || intent.contentLength < policy.minAppendSize) {
            return limited("append-too-small", intent.offset);
        }
    }
    // Size ceiling: a known content size may not cross a known length or the
    // policy maximum. Rejected BEFORE writing, so the resource stays valid
    // (invalidation is reserved for bytes that actually landed past a bound).
    if (intent.contentLength !== undefined) {
        if (length !== undefined && intent.offset + intent.contentLength > length) {
            return inconsistent(intent.offset);
        }
        if (policy.maxSize !== undefined && intent.offset + intent.contentLength > policy.maxSize) {
            return limited("size-exceeded", intent.offset);
        }
    }

    // A completing request whose content size is known is itself a length
    // indicator: the total is this offset plus that size. Recorded on an append
    // and not only at creation, or a deferred-length upload finished with a
    // plain `Content-Length` publishes with its length still unknown.
    const total =
        length ??
        (intent.complete && intent.contentLength !== undefined ? intent.offset + intent.contentLength : undefined);

    // A total this request is the FIRST to fix meets the size floor here,
    // before the append that records it. A representation length is immutable
    // once known, so recording one the surface can never publish wedges the
    // resource: every later request either restates that length and is refused
    // on the floor again, or names a different one and is refused as
    // inconsistent, leaving durable bytes only a DELETE or a sweep can free.
    // Keyed on the DERIVED total, because a completing request's own content
    // size fixes the length exactly as a declared total does. A total still
    // unknown after this request freezes nothing, and its floor is checked
    // against the delivered bytes at publication instead.
    if (state.length === undefined && total !== undefined && policy.minSize !== undefined && total < policy.minSize) {
        return limited("below-min-size", intent.offset);
    }

    // A completing append at the durable end of a known length is an ordinary
    // append with a zero-byte representation bound: `appendBound` returns
    // exactly that, so a body carrying bytes trips the store's zero bound and is
    // answered as the inconsistency that bound names, and a body carrying none
    // satisfies the post-condition and publishes. Deciding "is there content"
    // here instead would be a guess about a body nothing has read.
    const completes = intent.complete;
    return {
        kind: "append-allowed",
        atOffset: state.offset,
        ...appendBound(state.offset, total, policy),
        declaredLength: state.length === undefined ? total : undefined,
        completes,
        postCondition: { completesAt: completes ? total : undefined },
        events: [{ kind: "append-accepted", atOffset: state.offset, completes }],
    };
}

/** The audit trail of a refusal, positioned at the request's offset when it named one. */
function rejected(reason: UploadRejectReason, atOffset?: number): UploadAuditEvent[] {
    return [
        atOffset === undefined ? { kind: "append-rejected", reason } : { kind: "append-rejected", reason, atOffset },
    ];
}

function inconsistent(atOffset?: number): UploadVerdict {
    return { kind: "length-inconsistent", events: rejected("length-inconsistent", atOffset) };
}

function limited(
    reason: Extract<UploadVerdict, { kind: "limit-violation" }>["reason"],
    atOffset?: number,
): UploadVerdict {
    return { kind: "limit-violation", reason, events: rejected(reason, atOffset) };
}

function mismatch(claimedOffset: number, state: UploadState): UploadVerdict {
    return {
        kind: "offset-mismatch",
        claimedOffset,
        correctOffset: state.offset,
        events: rejected("offset-mismatch", claimedOffset),
    };
}

/**
 * Hard byte bound for one append, and whether crossing it is fatal.
 *
 * Three different constraints can bind, and they do NOT deserve the same
 * consequence. Room toward a known length and room under `maxSize` are bounds
 * on the REPRESENTATION: bytes past either are the spec's terminal fault, the
 * resource can never be completed coherently, and invalidation is the honest
 * answer. `maxAppendSize` bounds only THIS REQUEST (a server nicety, or a
 * backend's own per-call ceiling), and a body that runs past it has done
 * nothing wrong to the representation, so destroying the upload over it turns
 * a resumable situation into a lost one. That case stops at the bound and lets
 * the client resume from the truthful offset.
 *
 * A known content size never reaches here: the engine rejects an oversized
 * append up front with `append-too-large`, so the non-fatal path exists for
 * the case that cannot be checked in advance, an unknown-length (chunked) body.
 *
 * A bound of ZERO is never fatal, whichever constraint produced it. Fatality
 * answers bytes that landed past a representation bound, and at zero room the
 * store admits none: there is no byte that could have made the representation
 * incoherent. The request stops at the bound and the client resumes from the
 * truthful offset with its durable prefix intact. This is the bound a
 * completing append at the durable end of a known length gets, so the case is
 * an ordinary lost-response retry, not an attack. The zero bound still names
 * the representation bound it came from in `fatalReason`, so a body that
 * carries bytes into it is answered as that inconsistency rather than as a
 * per-request ceiling the client could meet with a smaller chunk.
 */
function appendBound(
    offset: number,
    length: number | undefined,
    policy: UploadPolicy,
): { maxBytes: number | undefined; maxBytesFatal: boolean; fatalReason?: FatalBoundReason } {
    // Representation bounds: crossing one is terminal.
    const roomToLength = length === undefined ? undefined : Math.max(0, length - offset);
    const roomToMax = policy.maxSize === undefined ? undefined : Math.max(0, policy.maxSize - offset);
    const totalBound =
        roomToLength === undefined
            ? roomToMax
            : roomToMax === undefined
              ? roomToLength
              : Math.min(roomToLength, roomToMax);
    const perAppend = policy.maxAppendSize;

    if (totalBound === undefined) {
        return { maxBytes: perAppend, maxBytesFatal: false };
    }
    // Which of the two representation bounds binds decides the ANSWER, not the
    // consequence: a body past the length the client itself declared is that
    // inconsistency, while a body past the server's ceiling is a size violation.
    // A tie means the client declared exactly the maximum, so its own
    // declaration is the one it broke.
    const representationReason: FatalBoundReason =
        roomToLength !== undefined && (roomToMax === undefined || roomToLength <= roomToMax) ? "length" : "size";
    if (totalBound === 0) {
        // Non-fatal, but still a representation bound: a body carrying bytes into
        // it is answered as the inconsistency it is, not as this request's
        // ceiling, which a client would try to meet with a smaller chunk.
        return { maxBytes: 0, maxBytesFatal: false, fatalReason: representationReason };
    }
    // Ties go to the representation bound: at equal values, crossing the
    // per-append cap crosses the total too, and that is the terminal one.
    if (perAppend === undefined || totalBound <= perAppend) {
        return { maxBytes: totalBound, maxBytesFatal: true, fatalReason: representationReason };
    }
    return { maxBytes: perAppend, maxBytesFatal: false };
}
