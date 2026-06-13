/**
 * RK-15 PR-A — dual-contract reader + per-request SnapshotContext.
 *
 * THE single place `snapshots/latest.json` is parsed into a pinned, immutable
 * description of the snapshot a request must read. The request reads latest.json
 * EXACTLY ONCE, builds one `SnapshotContext`, and threads it through every
 * manifest / xref / routing / shard / range-read / Tier-1 lookup. No downstream
 * helper re-reads latest.json or re-derives a date-based key out of band.
 *
 * DUAL CONTRACT (mutually exclusive, fail-loud on anything else):
 *   - legacy_v1: the EXACT current pointer (date-keyed). Matched by its precise
 *     known field-set; layout is date-derived (`snapshots/<date>/...`). This is
 *     what the CURRENT live latest.json is — the reader MUST keep serving it.
 *   - immutable_snapshot_v2: carries explicit `layout_version ===
 *     "immutable_snapshot_v2"` + `snapshot_id` + declared object keys. The
 *     reader reads the DECLARED keys; it never reconstructs paths from a date.
 *
 * Anything that is neither a precise v1 nor a precise v2 throws
 * `SnapshotContractError` (LOUD; never serve). NO try-v2-then-fall-back-to-v1:
 * detection is by precise field-set, not by attempting a read and guessing.
 */

export type LayoutVersion = 'legacy_v1' | 'immutable_snapshot_v2';

/**
 * Pinned, immutable per-request snapshot identity. Built ONCE per request from
 * latest.json; threaded through the whole read chain. For legacy_v1 the
 * date-derived values populate the same fields so downstream code is uniform
 * (snapshot_id = date, object_prefix = `snapshots/<date>/`).
 */
export interface SnapshotContext {
    readonly layout_version: LayoutVersion;
    /** v2: declared snapshot_id. v1: the snapshot date (its only identity). */
    readonly snapshot_id: string;
    /** v1: the snapshot date. v2: same as snapshot_id (kept for uniform date-shaped helpers if a v2 producer still carries a date). */
    readonly snapshot_date: string;
    /** Common object prefix. v1: `snapshots/<date>/`. v2: declared object_prefix (always ends with `/`). */
    readonly object_prefix: string;
    /** Compounds bucket-manifest key. v1: date-derived per bucket (null here; derived per-bucket downstream). v2: declared compounds_manifest_key. */
    readonly compounds_manifest_key: string | null;
    /** Negative-evidence per-bucket manifest key prefix root. v2: declared; v1: null (date-derived per bucket downstream). */
    readonly neg_evidence_manifest_key: string | null;
    /** Xref-index object key. v2: declared; v1: null (date-derived downstream). */
    readonly xref_index_key: string | null;
    /** Optional integrity hash of the top-level manifest (v2 only); strengthens cache identity. */
    readonly manifest_hash: string | null;
    /** Optional producing commit (v2 only); recorded for provenance, not required. */
    readonly commit_sha: string | null;
}

/**
 * Thrown when latest.json matches NEITHER a precise legacy_v1 NOR a precise
 * immutable_snapshot_v2 contract (unknown / mixed / partial / empty / corrupt).
 * Typed so the API layer maps it to a LOUD failure and never serves a guess.
 */
export class SnapshotContractError extends Error {
    readonly reason: string;
    constructor(reason: string) {
        super(`Unrecognized latest.json contract: ${reason}`);
        this.name = 'SnapshotContractError';
        this.reason = reason;
    }
}

export const LATEST_POINTER_KEY = 'snapshots/latest.json';

// The EXACT set of v2 marker fields. A pointer is "v2-shaped" iff it carries
// the layout_version discriminator; once it does, it MUST be a COMPLETE v2 or
// it fails loud (never silently demoted to v1).
const V2_LAYOUT_TOKEN = 'immutable_snapshot_v2';

// Fields that ONLY exist in v2. If any appears alongside the v1 date-shape (and
// no v2 discriminator), that is a MIXED pointer -> fail loud.
const V2_ONLY_FIELDS = [
    'layout_version',
    'snapshot_id',
    'object_prefix',
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0;
}

/**
 * Parse a raw latest.json TEXT into a pinned SnapshotContext, choosing EXACTLY
 * one contract. Pure (no I/O) so it is unit-testable against every input class.
 */
export function parseSnapshotContext(rawText: string): SnapshotContext {
    let obj: unknown;
    try {
        obj = JSON.parse(rawText);
    } catch {
        throw new SnapshotContractError('latest.json is not valid JSON (corrupt/unparseable)');
    }
    if (!isPlainObject(obj)) {
        throw new SnapshotContractError('latest.json is not a JSON object');
    }
    if (Object.keys(obj).length === 0) {
        throw new SnapshotContractError('latest.json is empty');
    }

    const hasV2Token = obj.layout_version === V2_LAYOUT_TOKEN;
    const hasUnknownLayout =
        'layout_version' in obj && obj.layout_version !== V2_LAYOUT_TOKEN;
    const carriesAnyV2Field = V2_ONLY_FIELDS.some(f => f in obj);

    // (iii) an explicit but UNKNOWN layout_version is never legacy_v1.
    if (hasUnknownLayout) {
        throw new SnapshotContractError(
            `unknown layout_version=${JSON.stringify(obj.layout_version)} (expected "${V2_LAYOUT_TOKEN}" or a legacy pointer with no layout_version)`,
        );
    }

    if (hasV2Token) {
        // Committed to v2: it MUST be a COMPLETE precise v2. (ii) a v2 token with
        // any missing key field fails loud — NEVER demoted to v1.
        return parseImmutableV2(obj);
    }

    // No v2 discriminator. (i) but if it still carries v2-only structural fields
    // (snapshot_id / object_prefix) it is a MIXED/ambiguous pointer -> fail loud,
    // never read as v1.
    if (carriesAnyV2Field) {
        const present = V2_ONLY_FIELDS.filter(f => f in obj);
        throw new SnapshotContractError(
            `v2-only field(s) ${present.join(', ')} present without layout_version="${V2_LAYOUT_TOKEN}" (mixed/ambiguous pointer)`,
        );
    }

    // Precise legacy_v1: the EXACT known v1 field-set.
    return parseLegacyV1(obj);
}

/**
 * legacy_v1: MUST have a valid ISO `latest_snapshot_date` and MUST NOT carry any
 * v2 discriminator/structural field (already excluded above). The optional
 * date-derived manifest hints (compounds_manifest_key / neg_evidence_manifest_key)
 * may be present in the live pointer; in v1 the loaders derive keys from the
 * date, so they are NOT authoritative here and are ignored for key derivation.
 */
function parseLegacyV1(obj: Record<string, unknown>): SnapshotContext {
    const date = obj.latest_snapshot_date;
    if (!isNonEmptyString(date)) {
        throw new SnapshotContractError(
            'legacy_v1 pointer missing a string latest_snapshot_date',
        );
    }
    if (!ISO_DATE_RE.test(date)) {
        throw new SnapshotContractError(
            `legacy_v1 latest_snapshot_date is not an ISO date: ${JSON.stringify(date)}`,
        );
    }
    return Object.freeze({
        layout_version: 'legacy_v1',
        snapshot_id: date,
        snapshot_date: date,
        object_prefix: `snapshots/${date}/`,
        // v1 derives keys from the date downstream -> null (not authoritative).
        compounds_manifest_key: null,
        neg_evidence_manifest_key: null,
        xref_index_key: null,
        manifest_hash: null,
        commit_sha: null,
    });
}

/**
 * immutable_snapshot_v2: explicit identity + DECLARED object keys. Requires
 * layout_version, snapshot_id, object_prefix, and compounds_manifest_key.
 * (object_prefix is normalized to end with `/`.) Any missing key field -> LOUD.
 *
 * v2 child keys MUST be derived from these declared values / the manifest's own
 * object list — never reassembled from a date or run_id.
 */
function parseImmutableV2(obj: Record<string, unknown>): SnapshotContext {
    const snapshotId = obj.snapshot_id;
    if (!isNonEmptyString(snapshotId)) {
        throw new SnapshotContractError('immutable_snapshot_v2 missing snapshot_id');
    }
    const rawPrefix = obj.object_prefix;
    if (!isNonEmptyString(rawPrefix)) {
        throw new SnapshotContractError('immutable_snapshot_v2 missing object_prefix');
    }
    const compoundsKey = obj.compounds_manifest_key;
    if (!isNonEmptyString(compoundsKey)) {
        throw new SnapshotContractError('immutable_snapshot_v2 missing compounds_manifest_key');
    }
    const objectPrefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;

    // Optional declared keys (present in a fuller v2; null if not declared).
    const negKey = isNonEmptyString(obj.neg_evidence_manifest_key)
        ? obj.neg_evidence_manifest_key
        : null;
    const xrefKey = isNonEmptyString(obj.xref_index_key)
        ? obj.xref_index_key
        : null;
    const manifestHash = isNonEmptyString(obj.manifest_hash) ? obj.manifest_hash : null;
    const commitSha = isNonEmptyString(obj.commit_sha) ? obj.commit_sha : null;
    // A v2 producer may still carry a date for provenance; it is NOT used to
    // derive keys. Fall back to snapshot_id when absent so date-shaped helpers
    // remain populated.
    const snapshotDate = isNonEmptyString(obj.snapshot_date)
        ? obj.snapshot_date
        : (isNonEmptyString(obj.latest_snapshot_date) ? obj.latest_snapshot_date : snapshotId);

    return Object.freeze({
        layout_version: 'immutable_snapshot_v2',
        snapshot_id: snapshotId,
        snapshot_date: snapshotDate,
        object_prefix: objectPrefix,
        compounds_manifest_key: compoundsKey,
        neg_evidence_manifest_key: negKey,
        xref_index_key: xrefKey,
        manifest_hash: manifestHash,
        commit_sha: commitSha,
    });
}

/**
 * Read latest.json EXACTLY ONCE and build the pinned context. `fetchText` is
 * injected (the caller passes a function that does one R2 read) so this module
 * stays free of an R2 dependency and is trivially unit-testable. Callers that
 * already hold a context MUST thread it instead of calling this again.
 */
export async function loadSnapshotContext(
    fetchText: (key: string) => Promise<string>,
): Promise<SnapshotContext> {
    const rawText = await fetchText(LATEST_POINTER_KEY);
    return parseSnapshotContext(rawText);
}

/**
 * Identity-bearing cache-namespace token for a snapshot. Every Cache API key
 * and every R2-fetch cache key for a snapshot object MUST embed this so a cache
 * entry can NEVER be returned for a different snapshot's bytes:
 *   v2: snapshot_id (+ manifest_hash when available)
 *   v1: the date (its only identity)
 * Correctness does not depend on cache purge: an old context -> old identity ->
 * old object keys, all internally consistent.
 */
export function snapshotIdentityToken(ctx: SnapshotContext): string {
    const base = `${ctx.layout_version}:${ctx.snapshot_id}`;
    return ctx.manifest_hash ? `${base}:${ctx.manifest_hash}` : base;
}
