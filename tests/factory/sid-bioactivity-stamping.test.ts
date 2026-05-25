// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import {
    deriveBioactivityChemblAnchor,
    classifyBioactivities, buildBioactivityStampingEntries,
    applyStampsToBioactivities, buildBioactivityStampingSummary,
    BIOACTIVITY_ENTITY_CLASS, BIOACTIVITY_CANON_VERSION_CHEMBL,
    UNSTAMPABLE_REASON_MISSING_CHEMBL_ID, CHEMBL_ACTIVITY_ID_PATTERN,
} from '../../scripts/factory/lib/sid-bioactivity-stamping.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';

const SAMPLE_ACTIVITY_ID = '12345';
const SAMPLE_SID_S = '8cd80ebb6f88ece555d7eeb407bcbd53';
const COUNTER_1_SID_C = '616b16377831cf309e88277f11990ac0';

function chemblProv(activityId, additionalSources = []) {
    const sources = [
        { source: 'chembl', source_id: activityId, timestamp: '2026-05-25T00:00:00Z', extraction_method: 'chembl_rest_v1' },
        ...additionalSources,
    ];
    return { provenance: { sources, last_updated: '2026-05-25T00:00:00Z' } };
}

describe('constants', () => {
    it('BIOACTIVITY_ENTITY_CLASS locked', () => { expect(BIOACTIVITY_ENTITY_CLASS).toBe('bioactivity'); });
    it('BIOACTIVITY_CANON_VERSION_CHEMBL locked', () => { expect(BIOACTIVITY_CANON_VERSION_CHEMBL).toBe('bioactivity.chembl.v1.0'); });
    it('CHEMBL_ACTIVITY_ID_PATTERN matches numeric strings only', () => {
        expect(CHEMBL_ACTIVITY_ID_PATTERN.test('12345')).toBe(true);
        expect(CHEMBL_ACTIVITY_ID_PATTERN.test('0')).toBe(true);
        expect(CHEMBL_ACTIVITY_ID_PATTERN.test('abc')).toBe(false);
        expect(CHEMBL_ACTIVITY_ID_PATTERN.test('12.5')).toBe(false);
        expect(CHEMBL_ACTIVITY_ID_PATTERN.test('')).toBe(false);
    });
});

describe('deriveBioactivityChemblAnchor — defect-12 hardened (label + format double-check)', () => {
    it('standard chembl provenance with numeric source_id -> anchor', () => {
        const a = deriveBioactivityChemblAnchor({ id: 'b1', ...chemblProv(SAMPLE_ACTIVITY_ID) });
        expect(a).toEqual({ canonVersion: BIOACTIVITY_CANON_VERSION_CHEMBL, payload: `chembl:${SAMPLE_ACTIVITY_ID}` });
    });

    it('★ defect-3 carry: reordered provenance.sources[] (chembl in position 2) -> anchor STILL derived', () => {
        const bio = {
            id: 'b1',
            provenance: {
                sources: [
                    { source: 'pubchem_validation', source_id: 'AID:567', timestamp: '...' },
                    { source: 'chembl', source_id: SAMPLE_ACTIVITY_ID, timestamp: '...' },
                ],
                last_updated: '...',
            },
        };
        const a = deriveBioactivityChemblAnchor(bio);
        expect(a.payload).toBe(`chembl:${SAMPLE_ACTIVITY_ID}`);
    });

    it('★ defect-12 sharpening: chembl label + NON-numeric source_id (alphabetic) -> null', () => {
        expect(deriveBioactivityChemblAnchor({ id: 'b1', ...chemblProv('abc') })).toBeNull();
    });

    it('★ defect-12 sharpening: chembl label + decimal source_id -> null', () => {
        expect(deriveBioactivityChemblAnchor({ id: 'b1', ...chemblProv('12.5') })).toBeNull();
    });

    it('★ defect-12 sharpening: chembl label + hyphenated source_id -> null', () => {
        expect(deriveBioactivityChemblAnchor({ id: 'b1', ...chemblProv('12-3') })).toBeNull();
    });

    it('★ defect-12 sharpening: chembl label + empty source_id -> null', () => {
        expect(deriveBioactivityChemblAnchor({ id: 'b1', ...chemblProv('') })).toBeNull();
    });

    it('missing chembl source in provenance -> null', () => {
        const bio = { id: 'b1', provenance: { sources: [{ source: 'pubchem_validation', source_id: 'AID:567' }] } };
        expect(deriveBioactivityChemblAnchor(bio)).toBeNull();
    });

    it('empty provenance.sources -> null', () => {
        expect(deriveBioactivityChemblAnchor({ id: 'b1', provenance: { sources: [] } })).toBeNull();
    });

    it('missing provenance -> null', () => {
        expect(deriveBioactivityChemblAnchor({ id: 'b1' })).toBeNull();
    });

    it('provenance.sources is not array -> null', () => {
        expect(deriveBioactivityChemblAnchor({ id: 'b1', provenance: { sources: 'oops' } })).toBeNull();
    });

    it('null/undefined bioactivity -> null', () => {
        expect(deriveBioactivityChemblAnchor(null)).toBeNull();
        expect(deriveBioactivityChemblAnchor(undefined)).toBeNull();
    });

    it('multiple chembl entries -> first matching wins', () => {
        const bio = {
            id: 'b1',
            provenance: {
                sources: [
                    { source: 'chembl', source_id: '111' },
                    { source: 'chembl', source_id: '222' },
                ],
            },
        };
        const a = deriveBioactivityChemblAnchor(bio);
        expect(a.payload).toBe('chembl:111');
    });
});

describe('classifyBioactivities', () => {
    const emptyIndex = buildCrosswalkIndex([]);
    function bio(id, activityId) { return { id, ...chemblProv(activityId) }; }

    it('empty crosswalk + valid bioactivities -> all unstamped', () => {
        const r = classifyBioactivities([bio('b1', '111'), bio('b2', '222')], emptyIndex);
        expect(r.unstamped).toHaveLength(2);
        expect(r.alreadyStamped).toEqual([]);
        expect(r.unstampable).toEqual([]);
    });

    it('bioactivity without chembl source -> unstampable', () => {
        const r = classifyBioactivities([{ id: 'b-bad' }], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_CHEMBL_ID);
    });

    it('crosswalk hit -> alreadyStamped', () => {
        const existing = [{
            sid_s: SAMPLE_SID_S, sid_c: COUNTER_1_SID_C,
            entity_class: 'bioactivity', canonicalization_version: BIOACTIVITY_CANON_VERSION_CHEMBL,
            canonical_identity_payload: `chembl:${SAMPLE_ACTIVITY_ID}`,
            counter_value: 1, reservation_id: 'r1', issuance_at: '2026-05-25T00:00:00Z',
        }];
        const idx = buildCrosswalkIndex(existing);
        const r = classifyBioactivities([bio('b1', SAMPLE_ACTIVITY_ID)], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidC).toBe(COUNTER_1_SID_C);
    });

    it('mixed batch -> correct partition', () => {
        const r = classifyBioactivities([
            bio('b1', '111'),
            bio('b2', '222'),
            { id: 'b3' },        // missing chembl -> unstampable
        ], emptyIndex);
        expect(r.unstamped).toHaveLength(2);
        expect(r.unstampable).toHaveLength(1);
    });
});

describe('buildBioactivityStampingEntries — frozen reference SIDs', () => {
    it('counter=1 entry matches frozen SID-C', () => {
        const unstamped = [{
            bioactivity: { id: 'b1' }, sidS: SAMPLE_SID_S,
            anchor: { canonVersion: BIOACTIVITY_CANON_VERSION_CHEMBL, payload: `chembl:${SAMPLE_ACTIVITY_ID}` },
        }];
        const entries = buildBioactivityStampingEntries({
            unstamped, counterStart: 1, reservationId: 'rid-1', issuanceAt: '2026-05-25T00:00:00Z',
        });
        expect(entries[0].sidC).toBe(COUNTER_1_SID_C);
        expect(entries[0].ledgerEntry.canonicalization_version).toBe(BIOACTIVITY_CANON_VERSION_CHEMBL);
        expect(entries[0].crosswalkEntry.canonical_identity_payload).toBe(`chembl:${SAMPLE_ACTIVITY_ID}`);
    });
});

describe('applyStampsToBioactivities — defect-4 carry', () => {
    it('opaque bioactivity.id', () => {
        const c = [{ id: 'sciweon::bioactivity::CHEMBL_ACT_12345' }];
        const m = new Map([['sciweon::bioactivity::CHEMBL_ACT_12345', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToBioactivities(c, m);
        expect(r.skippedParanoiaCount).toBe(0);
        expect(c[0].sid_s).toBe('a');
    });

    it('paranoia branch warn + count++', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const c = [{ id: 'b1' }, { id: 'b2' }];
        const m = new Map([['b1', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToBioactivities(c, m);
        expect(r.skippedParanoiaCount).toBe(1);
        warnSpy.mockRestore();
    });
});

describe('buildBioactivityStampingSummary', () => {
    it('canonical telemetry shape including shard_count', () => {
        const s = buildBioactivityStampingSummary({
            totalBioactivities: 100, alreadyStamped: 20, newlyStamped: 80, unstampable: 0,
            stampedByChembl: 80, reservationsIssued: 2, skippedParanoiaCount: 0,
            elapsedMs: 100, ledgerKeys: ['k1'], shardCount: 1,
        });
        expect(s.shard_count).toBe(1);
        expect(s.stamped_by_chembl).toBe(80);
        expect(s.newly_stamped).toBe(80);
    });
});
