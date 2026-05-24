/**
 * SID Trial Stamping — Phase 1.2 pure-function helpers for stage-3 trial
 * batch stamping per V1.0 §35 Dual-SID + §44 Counter Ingestion Batching +
 * §26 trial canonical anchor (registry+trial_id).
 *
 * Design invariants (architect-review fixes baked in):
 *
 *   Defect-2 carry-over: classification NEVER throws on data-shape.
 *     Trials lacking parseable registry-ID-shape values are pushed to
 *     `unstampable` with reason; orchestrator inspects partition AFTER
 *     classification (zero-tolerance check reachable, not dead code).
 *
 *   Defect-3 fix: anchor derivation uses FIELD-SHAPE PATTERN MATCHING on
 *     the identifier itself (nct_id / ct_number), NOT array-index lookup
 *     into provenance.sources[]. The identifier's syntactic shape IS the
 *     discriminator. Immune to upstream pipeline metadata mutation that
 *     could reorder provenance.sources[] (e.g., a future cleanup script
 *     prepending an openalex reference).
 *
 *   Defect-4 fix: applyStampsToTrials uses trial.id as OPAQUE STRING via
 *     Map.get/set; NO string reconstruction (no `'sciweon::trial::' + ...`
 *     concatenation). CTIS-only records whose legacy id is
 *     `sciweon::trial::<ct_number>` are looked up by their actual id field,
 *     not by reconstructed assumptions.
 *
 * Per V1.0 §49 Semantic Weight Isolation: this module injects identity
 * infrastructure (sid_s + sid_c), zero truth weight. Truth lives only in
 * Layer 3 SAL Assertion records.
 */

import { generateSID_S, generateSID_C } from './sid-generator.js';
import { buildLedgerEntry } from './sid-counter-ledger.js';

export const TRIAL_ENTITY_CLASS = 'trial';
export const TRIAL_CANON_VERSION = 'trial.registry_id.v1.0';
export const UNSTAMPABLE_REASON_MISSING_TRIAL_ID = 'missing_trial_id';

const NCT_PATTERN = /^NCT\d{8}$/;
const CTIS_PATTERN = /^\d{4}-\d{6}-\d{2}-\d{2}$/;

/**
 * Derive trial canonical anchor via field-shape pattern matching on
 * the identifier itself. Defect-3 fix — does NOT read
 * provenance.sources[] array position. Returns null on any failure to
 * find a recognizable registry-id shape; caller routes to unstampable.
 */
export function deriveTrialAnchor(trial) {
    if (!trial || typeof trial !== 'object') return null;
    const nctId = trial.nct_id;
    const ctNumber = trial.ct_number;
    if (typeof nctId === 'string' && NCT_PATTERN.test(nctId)) {
        return { registry: 'NCT', trialId: nctId };
    }
    if (typeof ctNumber === 'string' && CTIS_PATTERN.test(ctNumber)) {
        return { registry: 'CTIS', trialId: ctNumber };
    }
    if (typeof nctId === 'string' && CTIS_PATTERN.test(nctId)) {
        return { registry: 'CTIS', trialId: nctId };
    }
    return null;
}

function canonicalPayloadForAnchor(anchor) {
    return `registry:${anchor.registry}:trial_id:${anchor.trialId}`;
}

export function deriveTrialSidS(trial) {
    const anchor = deriveTrialAnchor(trial);
    if (!anchor) {
        throw new Error('[SID-trial] deriveTrialSidS: anchor cannot be derived (caller must pre-check via classifier)');
    }
    return generateSID_S(TRIAL_ENTITY_CLASS, canonicalPayloadForAnchor(anchor), TRIAL_CANON_VERSION);
}

export function classifyTrials(trials, crosswalkIndex) {
    if (!Array.isArray(trials)) throw new Error('[SID-trial] trials must be array');
    if (!crosswalkIndex || !crosswalkIndex.bySidS) {
        throw new Error('[SID-trial] crosswalkIndex with bySidS map required');
    }
    const alreadyStamped = [];
    const unstamped = [];
    const unstampable = [];
    for (const trial of trials) {
        const anchor = deriveTrialAnchor(trial);
        if (!anchor) {
            unstampable.push({ trial, reason: UNSTAMPABLE_REASON_MISSING_TRIAL_ID });
            continue;
        }
        const sidS = generateSID_S(TRIAL_ENTITY_CLASS, canonicalPayloadForAnchor(anchor), TRIAL_CANON_VERSION);
        const existing = crosswalkIndex.bySidS.get(sidS);
        if (existing && existing.length > 0) {
            const entry = existing[0];
            alreadyStamped.push({ trial, sidS, sidC: entry.sid_c });
        } else {
            unstamped.push({ trial, sidS, anchor });
        }
    }
    return { alreadyStamped, unstamped, unstampable };
}

export function buildTrialStampingEntries({ unstamped, counterStart, reservationId, issuanceAt, canonicalizationVersion }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-trial] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-trial] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-trial] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-trial] issuanceAt required');
    if (typeof canonicalizationVersion !== 'string' || !canonicalizationVersion) {
        throw new Error('[SID-trial] canonicalizationVersion required');
    }
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { trial, sidS, anchor } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(TRIAL_ENTITY_CLASS, counter);
        const payload = canonicalPayloadForAnchor(anchor);
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: TRIAL_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: payload, canonicalizationVersion, reservationId, issuanceAt,
        });
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: TRIAL_ENTITY_CLASS,
            canonicalization_version: canonicalizationVersion,
            canonical_identity_payload: payload,
            counter_value: counter,
            reservation_id: reservationId,
            issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, ledgerEntry, crosswalkEntry, trialId: trial.id });
    }
    return entries;
}

/**
 * Apply stamps to trials in-place. Defect-4 fix — uses trial.id as opaque
 * string Map key; NO string reconstruction. Whatever id the upstream
 * pipeline assigned (sciweon::trial::<nct_id> OR sciweon::trial::<ct_number>
 * OR any other future scheme) flows through transparently.
 */
export function applyStampsToTrials(trials, stampMap) {
    if (!Array.isArray(trials)) throw new Error('[SID-trial] trials must be array');
    if (!(stampMap instanceof Map)) throw new Error('[SID-trial] stampMap must be Map');
    let skippedParanoiaCount = 0;
    for (const trial of trials) {
        if (!trial || typeof trial.id === 'undefined') continue;
        const stamp = stampMap.get(trial.id);
        if (!stamp) {
            console.warn(`[TRIAL-STAMP] paranoia miss: id=${trial.id} not in stampMap`);
            skippedParanoiaCount++;
            continue;
        }
        trial.sid_s = stamp.sid_s;
        trial.sid_c = stamp.sid_c;
    }
    return { trials, skippedParanoiaCount };
}

export function buildTrialStampingSummary({
    totalTrials, alreadyStamped, newlyStamped, unstampable,
    reservationsIssued, skippedParanoiaCount, elapsedMs, ledgerKeys,
}) {
    return {
        total_trials: totalTrials,
        already_stamped: alreadyStamped,
        newly_stamped: newlyStamped,
        unstampable: unstampable,
        reservations_issued: reservationsIssued,
        skipped_paranoia_count: skippedParanoiaCount,
        elapsed_ms: elapsedMs,
        ledger_keys: ledgerKeys || [],
    };
}
