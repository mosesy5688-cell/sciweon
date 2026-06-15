/**
 * RK-16A1 — route-profile read-budget KERNEL (PURE MECHANISM, COUNTS ONLY).
 *
 * The budget that makes a reader provably bounded: every route has a fixed cap
 * on control / posting / canonical R2 sub-requests and a hard total, all under
 * an ABSOLUTE ceiling. When a charge WOULD exceed a sub-cap or the total, the
 * charge is REFUSED (returns false, counter NOT advanced) and `exhausted` is
 * set — the contract behaviour is: the caller STOPS and returns a cursor. It
 * NEVER scans-to-fill and NEVER auto-raises a cap.
 *
 * IMPORTANT: this kernel only COUNTS / guards. It performs NO R2 reads (A1 is
 * not wired to R2; the read primitives it will later guard live in r2-fetch.ts).
 *
 * The budget is provably CLOSED: a module-load self-check asserts, for every
 * profile, that (control_max + posting_max + canonical_max) <= total_max and
 * total_max <= ABSOLUTE_MAX_R2_SUBREQUESTS. A mis-edited profile fails fast at
 * import, not in production.
 */

/** Hard ceiling on R2 sub-requests for ANY single served request. */
export const ABSOLUTE_MAX_R2_SUBREQUESTS = 16;

/** Per-page parsed-heap ceiling (bytes). */
export const PAGE_PARSED_HEAP_MAX_BYTES = 4 * 1024 * 1024;
/** Per-family / per-request parsed-heap ceiling (bytes). */
export const FAMILY_REQUEST_HEAP_MAX_BYTES = 32 * 1024 * 1024;

export interface RouteProfile {
    readonly control_max: number;
    readonly posting_max: number;
    readonly canonical_max: number;
    readonly total_max: number;
}

export const ROUTE_PROFILES = Object.freeze({
    LIST: Object.freeze<RouteProfile>({ control_max: 4, posting_max: 4, canonical_max: 0, total_max: 8 }),
    POINT_DETAIL: Object.freeze<RouteProfile>({ control_max: 4, posting_max: 0, canonical_max: 1, total_max: 5 }),
    INTERNAL_BATCH: Object.freeze<RouteProfile>({ control_max: 4, posting_max: 0, canonical_max: 8, total_max: 12 }),
});

export type RouteProfileName = keyof typeof ROUTE_PROFILES;

// ── Closed-budget self-check (runs once, at module load) ─────────────────────
for (const [name, p] of Object.entries(ROUTE_PROFILES)) {
    const subSum = p.control_max + p.posting_max + p.canonical_max;
    if (subSum > p.total_max) {
        throw new Error(
            `[read-budget] profile ${name}: sub-caps sum (${subSum}) > total_max (${p.total_max}) — budget not closed`,
        );
    }
    if (p.total_max > ABSOLUTE_MAX_R2_SUBREQUESTS) {
        throw new Error(
            `[read-budget] profile ${name}: total_max (${p.total_max}) > ABSOLUTE_MAX (${ABSOLUTE_MAX_R2_SUBREQUESTS})`,
        );
    }
}

/**
 * A per-request budget. Construct with a route profile; charge each sub-request
 * BEFORE issuing it. A refused charge (false) means: STOP, return a cursor.
 */
export class ReadBudget {
    readonly profile: RouteProfile;
    private control = 0;
    private posting = 0;
    private canonical = 0;
    private total = 0;
    private parsedHeapTotal = 0;
    /** Set once any charge is refused — the signal to return next_cursor. */
    private stopped = false;

    constructor(profile: RouteProfile) {
        this.profile = profile;
    }

    /** True once a charge has been refused (collection stopped at the budget). */
    get exhausted(): boolean {
        return this.stopped;
    }
    /** Alias kept explicit per the contract vocabulary. */
    canExceedSignaled(): boolean {
        return this.stopped;
    }

    get controlUsed(): number { return this.control; }
    get postingUsed(): number { return this.posting; }
    get canonicalUsed(): number { return this.canonical; }
    get totalUsed(): number { return this.total; }
    get parsedHeapUsed(): number { return this.parsedHeapTotal; }

    private wouldExceedTotal(): boolean {
        return this.total + 1 > this.profile.total_max
            || this.total + 1 > ABSOLUTE_MAX_R2_SUBREQUESTS;
    }

    chargeControl(): boolean {
        if (this.control + 1 > this.profile.control_max || this.wouldExceedTotal()) {
            this.stopped = true;
            return false;
        }
        this.control += 1;
        this.total += 1;
        return true;
    }

    chargePosting(): boolean {
        if (this.posting + 1 > this.profile.posting_max || this.wouldExceedTotal()) {
            this.stopped = true;
            return false;
        }
        this.posting += 1;
        this.total += 1;
        return true;
    }

    chargeCanonical(): boolean {
        // LIST (canonical_max 0) ALWAYS refuses — list routes do 0 canonical reads.
        if (this.canonical + 1 > this.profile.canonical_max || this.wouldExceedTotal()) {
            this.stopped = true;
            return false;
        }
        this.canonical += 1;
        this.total += 1;
        return true;
    }

    /**
     * Account `bytes` of newly-parsed heap. Refuses (false) and stops collection
     * when this page would exceed the per-page ceiling OR the cumulative
     * per-family/request ceiling. On refusal the bytes are NOT added.
     */
    addParsedHeap(bytes: number): boolean {
        if (bytes > PAGE_PARSED_HEAP_MAX_BYTES) {
            this.stopped = true;
            return false;
        }
        if (this.parsedHeapTotal + bytes > FAMILY_REQUEST_HEAP_MAX_BYTES) {
            this.stopped = true;
            return false;
        }
        this.parsedHeapTotal += bytes;
        return true;
    }
}

/** Construct a budget from a profile NAME (convenience for callers). */
export function newReadBudget(name: RouteProfileName): ReadBudget {
    return new ReadBudget(ROUTE_PROFILES[name]);
}
