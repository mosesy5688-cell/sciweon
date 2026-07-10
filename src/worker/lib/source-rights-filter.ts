/**
 * Source-rights containment filter (RC-3A / D-132G, scope FD-15-B).
 *
 * ONE shared filter used by BOTH the REST serializers and the MCP tool
 * envelope. Given a public response object it WITHHOLDS MedDRA-derived and
 * KEGG-derived content before serialization and stamps ADDITIVE
 * rights-withheld markers so a consumer never reads the absence as "no data"
 * (withheld != absent).
 *
 * DELETE, never tokenize: a MedDRA PT is a finite public dictionary and CIDs
 * are public, so ANY unkeyed deterministic surrogate (FNV / SHA / etc.) of a
 * protected value is offline-enumerable and would leak the term. This filter
 * therefore DELETES restricted fields outright and marks the site; it never
 * emits a digest/surrogate of a protected value.
 *
 * Withheld (containment only -- nothing else is touched):
 *   MedDRA: a public FAERS-derived signal's PT text (detail.meddra_pt), any
 *           failure.reason_text carrying the PT, the compound
 *           fda_signals.faers_top_adr_terms[] array, and the MedDRA-derived
 *           faers NegEvidence id + its url (deleted, with id_visibility /
 *           url_visibility markers). Restricted ids inside ID-LISTS
 *           (target.negative_evidence_ids[], repurposing neg examples) are
 *           REMOVED with an enclosing count marker. The SIGNAL stays
 *           represented (evidence_type / severity / report_count / confidence /
 *           subject / provenance / aggregate counts).
 *   KEGG:   the kegg_drug object and external_ids.kegg_drug_id.
 *
 * NEVER removes non-restricted content; NEVER places a protected value (or a
 * digest of one) inside a marker. Operates on a structuredClone so
 * isolate-cached source records are never mutated in place.
 */

const WITHHELD_STATE = 'withheld_by_rights_policy';
const POLICY = 'restricted_source_rights_containment_v1';
const FAERS_NEG_ID_RE = /^sciweon::neg::faers::/;

export interface WithheldTally { meddra: number; kegg: number; }

interface CountedMarker { source_visibility_state: string; source_family: 'meddra' | 'kegg'; withheld_item_count: number; }
interface FamilyMarker { source_visibility_state: string; source_family: 'meddra' | 'kegg'; }

function countedMarker(family: 'meddra' | 'kegg', count: number): CountedMarker {
    return { source_visibility_state: WITHHELD_STATE, source_family: family, withheld_item_count: count };
}
function familyMarker(family: 'meddra' | 'kegg'): FamilyMarker {
    return { source_visibility_state: WITHHELD_STATE, source_family: family };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A public FAERS NegEvidence signal node: carries a MedDRA PT / MedDRA-derived
// id. Detected structurally (id prefix OR openfda_faers provenance OR a
// meddra_pt detail).
function isFaersSignal(o: Record<string, unknown>): boolean {
    if (typeof o.id === 'string' && FAERS_NEG_ID_RE.test(o.id)) return true;
    const prov = o.provenance;
    if (isPlainObject(prov) && prov.primary_source === 'openfda_faers') return true;
    const detail = o.detail;
    if (isPlainObject(detail) && 'meddra_pt' in detail) return true;
    return false;
}

function isFaersIdString(v: unknown): boolean {
    return typeof v === 'string' && FAERS_NEG_ID_RE.test(v);
}

// A thin FAERS "example" id-entry: a faers signal object that carries only
// summary fields (no rich detail/provenance/subject) -- e.g. a repurposing
// negative example {id, evidence_type, severity}. Such id-list entries are
// REMOVED (not preserved), per the FAERS-MedDRA-derived id-list rule.
function isThinFaersExample(v: unknown): boolean {
    return isPlainObject(v) && isFaersSignal(v)
        && !('detail' in v) && !('provenance' in v) && !('subject' in v);
}

// Withhold the MedDRA material of a FULL faers signal: DELETE meddra_pt,
// reason_text, id and url (never tokenize); mark each site. Preserve every
// non-MedDRA field (evidence_type / severity / report_count / confidence /
// subject / provenance). Returns true if anything was withheld.
function withholdFaersSignal(node: Record<string, unknown>): boolean {
    let did = false;
    const detail = node.detail;
    if (isPlainObject(detail) && 'meddra_pt' in detail) {
        delete detail.meddra_pt; detail.meddra_pt_visibility = WITHHELD_STATE; did = true;
    }
    const failure = node.failure;
    if (isPlainObject(failure) && 'reason_text' in failure) {
        delete failure.reason_text; failure.reason_text_visibility = WITHHELD_STATE; did = true;
    }
    if ('reason_text' in node) { // defense in depth: a future flattened shaper
        delete node.reason_text; node.reason_text_visibility = WITHHELD_STATE; did = true;
    }
    if (typeof node.id === 'string' && FAERS_NEG_ID_RE.test(node.id)) {
        delete node.id; node.id_visibility = familyMarker('meddra'); did = true;
    }
    if (typeof node.url === 'string') { // the entity url embeds the faers id/term
        delete node.url; node.url_visibility = familyMarker('meddra'); did = true;
    }
    return did;
}

// KEGG keys + the compound MedDRA faers_top_adr_terms[] array + a safety-net
// stray MedDRA PT scalar (strip a known MedDRA-term-bearing field even where
// the current shaper omits it -- last public boundary).
function withholdObjectKeys(node: Record<string, unknown>, tally: WithheldTally): void {
    if (node.kegg_drug != null) {
        delete node.kegg_drug; node.kegg_drug_visibility = countedMarker('kegg', 1); tally.kegg += 1;
    }
    if (typeof node.kegg_drug_id === 'string' && node.kegg_drug_id.length > 0) {
        delete node.kegg_drug_id; node.kegg_drug_id_visibility = WITHHELD_STATE; tally.kegg += 1;
    }
    const faers = node.faers_top_adr_terms;
    if (Array.isArray(faers) && faers.length > 0) {
        delete node.faers_top_adr_terms;
        node.faers_top_adr_terms_visibility = countedMarker('meddra', faers.length);
        tally.meddra += faers.length;
    }
    if (typeof node.meddra_pt === 'string') {
        delete node.meddra_pt; node.meddra_pt_visibility = WITHHELD_STATE; tally.meddra += 1;
    }
}

// ID-LISTS: any array value that holds FAERS-MedDRA-derived id entries (id
// strings, or thin example objects). REMOVE those entries entirely and attach
// a sibling <key>_visibility count marker. Preserve aggregate counts elsewhere
// (e.g. counts.negative_evidence / signals_count) so withheld != absent.
function pruneIdListArrays(node: Record<string, unknown>, tally: WithheldTally): void {
    for (const key of Object.keys(node)) {
        const val = node[key];
        if (!Array.isArray(val)) continue;
        const kept: unknown[] = [];
        let removed = 0;
        for (const el of val) {
            if (isFaersIdString(el) || isThinFaersExample(el)) removed += 1;
            else kept.push(el);
        }
        if (removed > 0) {
            node[key] = kept;
            node[`${key}_visibility`] = countedMarker('meddra', removed);
            tally.meddra += removed;
        }
    }
}

function walk(node: unknown, tally: WithheldTally): void {
    if (Array.isArray(node)) {
        for (const el of node) walk(el, tally);
        return;
    }
    if (!isPlainObject(node)) return;
    if (isFaersSignal(node) && withholdFaersSignal(node)) tally.meddra += 1;
    withholdObjectKeys(node, tally);
    pruneIdListArrays(node, tally); // removes restricted id-list entries before recursion
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
        const withheld: CountedMarker[] = [];
        if (tally.meddra > 0) withheld.push(countedMarker('meddra', tally.meddra));
        if (tally.kegg > 0) withheld.push(countedMarker('kegg', tally.kegg));
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
