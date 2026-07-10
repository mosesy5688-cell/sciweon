/**
 * Source-rights containment filter (RC-3A / D-132G, scope FD-15-B).
 *
 * ONE shared filter used by BOTH the REST serializers and the MCP tool
 * envelope. Given a public response object it WITHHOLDS MedDRA-derived and
 * KEGG-derived content before serialization and stamps an ADDITIVE
 * rights-withheld marker so a consumer never reads the absence as "no data"
 * (withheld != absent).
 *
 * Withheld (containment only -- nothing else is touched):
 *   MedDRA: the FAERS ADR Preferred-Term string
 *           (neg-evidence signals[].detail.meddra_pt); the compound
 *           fda_signals.faers_top_adr_terms[] array (each {term,count} carries
 *           a MedDRA PT); and the MedDRA-derived slug embedded in a faers
 *           NegEvidence record id / url (and in a target's
 *           negative_evidence_ids[] / a repurposing example id). The adverse-
 *           event SIGNAL is preserved (severity / report_count / provenance /
 *           evidence_type / reason_category stay) -- only the proprietary
 *           MedDRA label is withheld.
 *   KEGG:   the kegg_drug object and the external_ids.kegg_drug_id identifier.
 *
 * NEVER removes non-restricted content; NEVER places a protected value inside
 * a marker. Operates on a structuredClone so isolate-cached source records are
 * never mutated in place.
 */

const WITHHELD_STATE = 'withheld_by_rights_policy';
const POLICY = 'restricted_source_rights_containment_v1';
const FAERS_NEG_ID_RE = /^sciweon::neg::faers::/;

export interface WithheldTally { meddra: number; kegg: number; }

interface Marker {
    source_visibility_state: string;
    source_family: 'meddra' | 'kegg';
    withheld_item_count: number;
}

function marker(family: 'meddra' | 'kegg', count: number): Marker {
    return { source_visibility_state: WITHHELD_STATE, source_family: family, withheld_item_count: count };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// FNV-1a 32-bit of the ORIGINAL id -> a stable, deterministic, non-reversible
// token that keeps the record identity unique across requests without exposing
// the MedDRA-derived slug it replaces.
function withheldToken(original: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < original.length; i++) {
        h ^= original.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return `rwh_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

// Replace the MedDRA-derived trailing slug of a faers NegEvidence id with an
// opaque withheld token, keeping the `sciweon::neg::faers::<cid>::` identity.
// Idempotent: an already-withheld id (rwh_ suffix) is returned unchanged.
function neutralizeFaersId(id: string): string {
    const parts = id.split('::');
    if (parts.length < 2) return id;
    if (parts[parts.length - 1].startsWith('rwh_')) return id;
    parts[parts.length - 1] = withheldToken(id);
    return parts.join('::');
}

// A faers NegEvidence signal node carries a MedDRA PT (detail.meddra_pt) and a
// MedDRA-derived slug in its id. Detected structurally.
function isFaersSignal(o: Record<string, unknown>): boolean {
    if (typeof o.id === 'string' && FAERS_NEG_ID_RE.test(o.id)) return true;
    const prov = o.provenance;
    if (isPlainObject(prov) && prov.primary_source === 'openfda_faers') return true;
    const detail = o.detail;
    if (isPlainObject(detail) && 'meddra_pt' in detail) return true;
    return false;
}

// Withhold the MedDRA PT + neutralize the id/url slug for a faers signal node,
// preserving every non-MedDRA field. Returns true if anything was withheld.
function withholdFaersSignal(node: Record<string, unknown>): boolean {
    if (node.source_visibility_state === WITHHELD_STATE) return false;
    let did = false;
    const detail = node.detail;
    if (isPlainObject(detail) && 'meddra_pt' in detail) {
        delete detail.meddra_pt;
        did = true;
    }
    if (typeof node.id === 'string' && FAERS_NEG_ID_RE.test(node.id)) {
        const oldId = node.id;
        const newId = neutralizeFaersId(oldId);
        if (newId !== oldId) {
            node.id = newId;
            if (typeof node.url === 'string') {
                node.url = node.url.split(encodeURIComponent(oldId)).join(encodeURIComponent(newId));
            }
            did = true;
        }
    }
    if (did) {
        node.source_visibility_state = WITHHELD_STATE;
        node.source_family = 'meddra';
    }
    return did;
}

function withholdObjectKeys(node: Record<string, unknown>, tally: WithheldTally): void {
    if (node.kegg_drug != null) {
        delete node.kegg_drug;
        node.kegg_drug_visibility = marker('kegg', 1);
        tally.kegg += 1;
    }
    if (typeof node.kegg_drug_id === 'string' && node.kegg_drug_id.length > 0) {
        delete node.kegg_drug_id;
        node.kegg_drug_id_visibility = WITHHELD_STATE;
        tally.kegg += 1;
    }
    const faers = node.faers_top_adr_terms;
    if (Array.isArray(faers) && faers.length > 0) {
        delete node.faers_top_adr_terms;
        node.faers_top_adr_terms_visibility = marker('meddra', faers.length);
        tally.meddra += faers.length;
    }
    // Safety net: a stray MedDRA PT not covered by the faers-signal handler.
    if (typeof node.meddra_pt === 'string') {
        delete node.meddra_pt;
        node.meddra_pt_visibility = WITHHELD_STATE;
        tally.meddra += 1;
    }
}

function walk(node: unknown, tally: WithheldTally): void {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            const el = node[i];
            if (typeof el === 'string' && FAERS_NEG_ID_RE.test(el)) {
                const neutral = neutralizeFaersId(el);
                if (neutral !== el) { node[i] = neutral; tally.meddra += 1; }
            } else {
                walk(el, tally);
            }
        }
        return;
    }
    if (!isPlainObject(node)) return;
    if (isFaersSignal(node) && withholdFaersSignal(node)) tally.meddra += 1;
    withholdObjectKeys(node, tally);
    for (const key of Object.keys(node)) walk(node[key], tally);
}

/**
 * Filter a public response payload: withhold restricted-source content on a
 * deep clone and, when anything was withheld, attach an additive top-level
 * `source_visibility` marker. The input object is never mutated.
 */
export function applySourceRightsFilter<T>(payload: T): { filtered: T; withheld: WithheldTally } {
    const tally: WithheldTally = { meddra: 0, kegg: 0 };
    if (payload === null || typeof payload !== 'object') {
        return { filtered: payload, withheld: tally };
    }
    const filtered = structuredClone(payload) as unknown;
    walk(filtered, tally);
    if (isPlainObject(filtered) && (tally.meddra > 0 || tally.kegg > 0)) {
        const withheld: Marker[] = [];
        if (tally.meddra > 0) withheld.push(marker('meddra', tally.meddra));
        if (tally.kegg > 0) withheld.push(marker('kegg', tally.kegg));
        filtered.source_visibility = { policy: POLICY, withheld };
    }
    return { filtered: filtered as T, withheld: tally };
}

/**
 * Shared REST serialization boundary: JSON-encode a public response with the
 * source-rights filter applied. Every data-serving REST handler routes its
 * success response through this so the filter is single-source with the MCP
 * envelope (mcp-handlers.ts textContent).
 */
export function jsonWithRights(payload: unknown, init?: ResponseInit): Response {
    const { filtered } = applySourceRightsFilter(payload);
    return Response.json(filtered, init);
}
