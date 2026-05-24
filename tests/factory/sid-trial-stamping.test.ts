// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import {
    deriveTrialAnchor,
    deriveTrialSidS,
    classifyTrials,
    buildTrialStampingEntries,
    applyStampsToTrials,
    buildTrialStampingSummary,
    TRIAL_ENTITY_CLASS,
    TRIAL_CANON_VERSION,
    UNSTAMPABLE_REASON_MISSING_TRIAL_ID,
} from '../../scripts/factory/lib/sid-trial-stamping.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';

// Frozen reference SIDs computed via PowerShell SHA-256 (see plan §Verification).
// These values are FROZEN — any algorithm change requires
// canonicalization_version increment per V0.5 §25.
const NCT_SAMPLE = 'NCT04280705';
const CTIS_SAMPLE = '2024-001234-56-00';
const NCT_TRIAL_SID_S = '9b03c3073207da1092156e8d29cb74c4';
const CTIS_TRIAL_SID_S = 'b7bb70714190d8566bd2c3731a81b5ba';
const COUNTER_1_TRIAL_SID_C = '93c0816d0da83fcb4e2914f97abc356d';

describe('constants', () => {
    it('TRIAL_ENTITY_CLASS locked', () => { expect(TRIAL_ENTITY_CLASS).toBe('trial'); });
    it('TRIAL_CANON_VERSION locked per V1.0 §26', () => { expect(TRIAL_CANON_VERSION).toBe('trial.registry_id.v1.0'); });
    it('UNSTAMPABLE_REASON_MISSING_TRIAL_ID locked', () => { expect(UNSTAMPABLE_REASON_MISSING_TRIAL_ID).toBe('missing_trial_id'); });
});

describe('deriveTrialAnchor — field-shape detection (defect-3 fix)', () => {
    it('NCT-shaped nct_id -> registry=NCT', () => {
        expect(deriveTrialAnchor({ nct_id: NCT_SAMPLE })).toEqual({ registry: 'NCT', trialId: NCT_SAMPLE });
    });
    it('CTIS-shaped ct_number -> registry=CTIS', () => {
        expect(deriveTrialAnchor({ ct_number: CTIS_SAMPLE })).toEqual({ registry: 'CTIS', trialId: CTIS_SAMPLE });
    });
    it('CTIS-shaped value in nct_id field -> fallback to CTIS (CTIS-only legacy records)', () => {
        expect(deriveTrialAnchor({ nct_id: CTIS_SAMPLE })).toEqual({ registry: 'CTIS', trialId: CTIS_SAMPLE });
    });
    it('NCT > CTIS precedence: both fields shaped -> NCT wins', () => {
        const a = deriveTrialAnchor({ nct_id: NCT_SAMPLE, ct_number: CTIS_SAMPLE });
        expect(a).toEqual({ registry: 'NCT', trialId: NCT_SAMPLE });
    });
    it('missing both nct_id and ct_number -> null', () => {
        expect(deriveTrialAnchor({})).toBeNull();
    });
    it('null trial -> null', () => {
        expect(deriveTrialAnchor(null)).toBeNull();
    });
    it('malformed nct_id (wrong digit count) -> null if ct_number also absent', () => {
        expect(deriveTrialAnchor({ nct_id: 'NCT12345' })).toBeNull();
    });
    it('non-string nct_id -> null', () => {
        expect(deriveTrialAnchor({ nct_id: 42 })).toBeNull();
    });
    it('defect-3 verification: ignores provenance.sources[] entirely', () => {
        const a = deriveTrialAnchor({
            nct_id: NCT_SAMPLE,
            provenance: { sources: [{ source: 'openalex' }, { source: 'clinicaltrials' }] },
        });
        expect(a).toEqual({ registry: 'NCT', trialId: NCT_SAMPLE });
    });
    it('defect-3 verification: provenance reordered does NOT affect derivation', () => {
        const a1 = deriveTrialAnchor({ nct_id: NCT_SAMPLE, provenance: { sources: [{ source: 'clinicaltrials' }] } });
        const a2 = deriveTrialAnchor({ nct_id: NCT_SAMPLE, provenance: { sources: [{ source: 'pubmed' }, { source: 'clinicaltrials' }] } });
        const a3 = deriveTrialAnchor({ nct_id: NCT_SAMPLE });
        expect(a1).toEqual(a2);
        expect(a2).toEqual(a3);
    });
});

describe('deriveTrialSidS — frozen reference values', () => {
    it('NCT04280705 -> frozen SID-S', () => {
        expect(deriveTrialSidS({ nct_id: NCT_SAMPLE })).toBe(NCT_TRIAL_SID_S);
    });
    it('CTIS 2024-001234-56-00 -> frozen SID-S', () => {
        expect(deriveTrialSidS({ ct_number: CTIS_SAMPLE })).toBe(CTIS_TRIAL_SID_S);
    });
    it('deterministic', () => {
        expect(deriveTrialSidS({ nct_id: NCT_SAMPLE })).toBe(deriveTrialSidS({ nct_id: NCT_SAMPLE }));
    });
    it('throws on contract violation (caller must pre-check)', () => {
        expect(() => deriveTrialSidS({})).toThrow(/anchor/);
    });
});

describe('classifyTrials — never throws on data shape (defect-2 carry-over)', () => {
    const emptyIndex = buildCrosswalkIndex([]);
    it('empty list -> empty partitions', () => {
        const r = classifyTrials([], emptyIndex);
        expect(r.alreadyStamped).toEqual([]);
        expect(r.unstamped).toEqual([]);
        expect(r.unstampable).toEqual([]);
    });
    it('valid trial + empty crosswalk -> unstamped', () => {
        const r = classifyTrials([{ id: 'sciweon::trial::NCT04280705', nct_id: NCT_SAMPLE }], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.unstamped[0].sidS).toBe(NCT_TRIAL_SID_S);
    });
    it('trial without nct_id and ct_number -> unstampable (NEVER throws)', () => {
        const r = classifyTrials([{ id: 'sciweon::trial::missing' }], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_TRIAL_ID);
    });
    it('crosswalk hit -> alreadyStamped with reused sid_c', () => {
        const existing = [{
            sid_s: NCT_TRIAL_SID_S, sid_c: COUNTER_1_TRIAL_SID_C,
            entity_class: 'trial', canonicalization_version: TRIAL_CANON_VERSION,
            canonical_identity_payload: `registry:NCT:trial_id:${NCT_SAMPLE}`,
            counter_value: 1, reservation_id: 'r1', issuance_at: '2026-05-24T00:00:00Z',
        }];
        const idx = buildCrosswalkIndex(existing);
        const r = classifyTrials([{ id: 'sciweon::trial::NCT04280705', nct_id: NCT_SAMPLE }], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidC).toBe(COUNTER_1_TRIAL_SID_C);
    });
    it('mixed input (1 valid + 1 missing-id + 1 already stamped) -> 3 partitions populated', () => {
        const existing = [{
            sid_s: NCT_TRIAL_SID_S, sid_c: COUNTER_1_TRIAL_SID_C,
            entity_class: 'trial', canonicalization_version: TRIAL_CANON_VERSION,
            canonical_identity_payload: `registry:NCT:trial_id:${NCT_SAMPLE}`,
            counter_value: 1, reservation_id: 'r1', issuance_at: '2026-05-24T00:00:00Z',
        }];
        const idx = buildCrosswalkIndex(existing);
        const r = classifyTrials([
            { id: 'sciweon::trial::NCT04280705', nct_id: NCT_SAMPLE },
            { id: 'sciweon::trial::missing' },
            { id: 'sciweon::trial::2024-001234-56-00', ct_number: CTIS_SAMPLE },
        ], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstamped).toHaveLength(1);
    });
});

describe('buildTrialStampingEntries', () => {
    const NOW = '2026-05-24T12:00:00Z';
    it('counter values map correctly + SID-C frozen reference', () => {
        const unstamped = [{ trial: { id: 'sciweon::trial::NCT04280705' }, sidS: NCT_TRIAL_SID_S, anchor: { registry: 'NCT', trialId: NCT_SAMPLE } }];
        const entries = buildTrialStampingEntries({
            unstamped, counterStart: 1, reservationId: 'rid-1', issuanceAt: NOW,
            canonicalizationVersion: TRIAL_CANON_VERSION,
        });
        expect(entries[0].sidC).toBe(COUNTER_1_TRIAL_SID_C);
        expect(entries[0].ledgerEntry.counter_value).toBe(1);
        expect(entries[0].crosswalkEntry.canonical_identity_payload).toBe(`registry:NCT:trial_id:${NCT_SAMPLE}`);
    });
});

describe('applyStampsToTrials — defect-4 fix (opaque trial.id Map key)', () => {
    it('NCT trial.id passes through opaquely', () => {
        const c = [{ id: 'sciweon::trial::NCT04280705', nct_id: NCT_SAMPLE }];
        const m = new Map([['sciweon::trial::NCT04280705', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToTrials(c, m);
        expect(r.skippedParanoiaCount).toBe(0);
        expect(c[0].sid_s).toBe('a');
    });
    it('defect-4 verification: CTIS-only trial.id (not nct_id form) looks up correctly', () => {
        const c = [{ id: 'sciweon::trial::2024-001234-56-00', ct_number: CTIS_SAMPLE }];
        const m = new Map([['sciweon::trial::2024-001234-56-00', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToTrials(c, m);
        expect(r.skippedParanoiaCount).toBe(0);
        expect(c[0].sid_c).toBe('b');
    });
    it('paranoia branch: stampMap miss -> warn + count++', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const c = [{ id: 'sciweon::trial::A' }, { id: 'sciweon::trial::B' }];
        const m = new Map([['sciweon::trial::A', { sid_s: 'a', sid_c: 'ca' }]]);
        const r = applyStampsToTrials(c, m);
        expect(r.skippedParanoiaCount).toBe(1);
        warnSpy.mockRestore();
    });
    it('throws on non-Map stampMap', () => {
        expect(() => applyStampsToTrials([], {})).toThrow(/Map/);
    });
});

describe('buildTrialStampingSummary', () => {
    it('produces canonical telemetry shape', () => {
        const s = buildTrialStampingSummary({
            totalTrials: 100, alreadyStamped: 30, newlyStamped: 70,
            unstampable: 0, reservationsIssued: 2, skippedParanoiaCount: 0,
            elapsedMs: 12345, ledgerKeys: ['k1'],
        });
        expect(s.total_trials).toBe(100);
        expect(s.newly_stamped).toBe(70);
        expect(s.reservations_issued).toBe(2);
    });
});
