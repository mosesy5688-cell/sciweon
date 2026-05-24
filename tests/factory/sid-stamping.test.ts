// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import {
    deriveSmallMoleculeSidS,
    classifyCompounds,
    planReservations,
    buildStampingEntries,
    applyStampsToCompounds,
    buildStampingSummary,
    SMALL_MOLECULE_ENTITY_CLASS,
    SMALL_MOLECULE_CANON_VERSION,
    UNSTAMPABLE_REASON_MISSING_INCHIKEY,
} from '../../scripts/factory/lib/sid-stamping.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';
import { DEFAULT_BATCH_SIZE } from '../../scripts/factory/lib/sid-counter-ledger.js';

const ASPIRIN = 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N';
const CAFFEINE = 'RYYVLZVUVIJVGH-UHFFFAOYSA-N';
const ASPIRIN_SID_S = 'c1fe6bb77cec6b1e3ecd0061a5dc749e';
const COUNTER_1_SID_C = '9549658c8384b75a751de9d7eaa28d4d';

describe('deriveSmallMoleculeSidS', () => {
    it('matches Phase 1.1a frozen aspirin SID-S', () => {
        expect(deriveSmallMoleculeSidS(ASPIRIN)).toBe(ASPIRIN_SID_S);
    });
    it('deterministic across calls', () => {
        expect(deriveSmallMoleculeSidS(CAFFEINE)).toBe(deriveSmallMoleculeSidS(CAFFEINE));
    });
    it('different InChIKeys -> different SID-S', () => {
        expect(deriveSmallMoleculeSidS(ASPIRIN)).not.toBe(deriveSmallMoleculeSidS(CAFFEINE));
    });
    it('throws on null/empty (contract violation, not data shape)', () => {
        expect(() => deriveSmallMoleculeSidS(null)).toThrow(/inchiKey/);
        expect(() => deriveSmallMoleculeSidS('')).toThrow(/inchiKey/);
        expect(() => deriveSmallMoleculeSidS(undefined)).toThrow(/inchiKey/);
    });
});

describe('classifyCompounds — never throws on data shape (defect-2 fix)', () => {
    const emptyIndex = buildCrosswalkIndex([]);

    it('empty compounds + empty crosswalk -> empty partitions', () => {
        const r = classifyCompounds([], emptyIndex);
        expect(r.alreadyStamped).toEqual([]);
        expect(r.unstamped).toEqual([]);
        expect(r.unstampable).toEqual([]);
    });

    it('valid InChIKey + empty crosswalk -> unstamped', () => {
        const r = classifyCompounds([{ id: 'C1', inchi_key: ASPIRIN }], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.unstamped[0].sidS).toBe(ASPIRIN_SID_S);
        expect(r.alreadyStamped).toEqual([]);
        expect(r.unstampable).toEqual([]);
    });

    it('missing inchi_key -> unstampable (NEVER throws)', () => {
        const r = classifyCompounds([{ id: 'C-missing' }], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_INCHIKEY);
        expect(r.unstamped).toEqual([]);
    });

    it('empty-string inchi_key -> unstampable (NEVER throws)', () => {
        const r = classifyCompounds([{ id: 'C-empty', inchi_key: '' }], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_INCHIKEY);
    });

    it('null inchi_key -> unstampable (NEVER throws)', () => {
        const r = classifyCompounds([{ id: 'C-null', inchi_key: null }], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
    });

    it('crosswalk hit -> alreadyStamped with reused sid_c', () => {
        const existing = [{
            sid_s: ASPIRIN_SID_S, sid_c: COUNTER_1_SID_C,
            entity_class: SMALL_MOLECULE_ENTITY_CLASS,
            canonicalization_version: SMALL_MOLECULE_CANON_VERSION,
            canonical_identity_payload: `inchikey:${ASPIRIN}`,
            counter_value: 1, reservation_id: 'r1', issuance_at: '2026-05-24T00:00:00Z',
        }];
        const idx = buildCrosswalkIndex(existing);
        const r = classifyCompounds([{ id: 'C1', inchi_key: ASPIRIN }], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidS).toBe(ASPIRIN_SID_S);
        expect(r.alreadyStamped[0].sidC).toBe(COUNTER_1_SID_C);
    });

    it('mixed input (1 missing + 1 stamped + 1 unstamped) -> 3 partitions populated correctly', () => {
        const existing = [{
            sid_s: ASPIRIN_SID_S, sid_c: COUNTER_1_SID_C,
            entity_class: SMALL_MOLECULE_ENTITY_CLASS,
            canonicalization_version: SMALL_MOLECULE_CANON_VERSION,
            canonical_identity_payload: `inchikey:${ASPIRIN}`,
            counter_value: 1, reservation_id: 'r1', issuance_at: '2026-05-24T00:00:00Z',
        }];
        const idx = buildCrosswalkIndex(existing);
        const r = classifyCompounds([
            { id: 'C-missing' },
            { id: 'C-aspirin', inchi_key: ASPIRIN },
            { id: 'C-caffeine', inchi_key: CAFFEINE },
        ], idx);
        expect(r.unstampable).toHaveLength(1);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.unstamped).toHaveLength(1);
    });

    it('throws on null compounds arg (contract violation)', () => {
        expect(() => classifyCompounds(null, emptyIndex)).toThrow(/array/);
    });

    it('throws on null index arg', () => {
        expect(() => classifyCompounds([], null)).toThrow(/crosswalkIndex/);
    });
});

describe('planReservations (V1.0 §44 batching)', () => {
    it('0 unstamped -> empty plan', () => {
        expect(planReservations(0)).toEqual([]);
    });
    it('exactly DEFAULT_BATCH_SIZE -> 1 reservation full size', () => {
        expect(planReservations(DEFAULT_BATCH_SIZE)).toEqual([{ counterCount: DEFAULT_BATCH_SIZE }]);
    });
    it('50K + 1 -> 2 reservations (50K + 1)', () => {
        expect(planReservations(DEFAULT_BATCH_SIZE + 1)).toEqual([{ counterCount: DEFAULT_BATCH_SIZE }, { counterCount: 1 }]);
    });
    it('69977 (Phase 1.1c production scenario) -> 2 reservations (50K + 19977)', () => {
        expect(planReservations(69977)).toEqual([{ counterCount: 50000 }, { counterCount: 19977 }]);
    });
    it('custom batchSize override', () => {
        expect(planReservations(7, 3)).toEqual([{ counterCount: 3 }, { counterCount: 3 }, { counterCount: 1 }]);
    });
    it('throws on negative count', () => {
        expect(() => planReservations(-1)).toThrow(/non-negative/);
    });
    it('throws on invalid batchSize', () => {
        expect(() => planReservations(10, 0)).toThrow(/positive/);
    });
});

describe('buildStampingEntries', () => {
    const NOW = '2026-05-24T12:00:00Z';
    const RID = 'rid-test';

    it('counter values map correctly (counterStart..counterStart+n-1)', () => {
        const unstamped = [
            { compound: { id: 'A', inchi_key: ASPIRIN }, sidS: ASPIRIN_SID_S },
            { compound: { id: 'B', inchi_key: CAFFEINE }, sidS: deriveSmallMoleculeSidS(CAFFEINE) },
        ];
        const entries = buildStampingEntries({
            unstamped, counterStart: 5, reservationId: RID, issuanceAt: NOW,
            canonicalizationVersion: SMALL_MOLECULE_CANON_VERSION,
        });
        expect(entries).toHaveLength(2);
        expect(entries[0].ledgerEntry.counter_value).toBe(5);
        expect(entries[1].ledgerEntry.counter_value).toBe(6);
    });

    it('SID-C derived via Phase 1.1a generator (frozen counter=1)', () => {
        const unstamped = [{ compound: { id: 'A', inchi_key: ASPIRIN }, sidS: ASPIRIN_SID_S }];
        const entries = buildStampingEntries({
            unstamped, counterStart: 1, reservationId: RID, issuanceAt: NOW,
            canonicalizationVersion: SMALL_MOLECULE_CANON_VERSION,
        });
        expect(entries[0].sidC).toBe(COUNTER_1_SID_C);
        expect(entries[0].ledgerEntry.sid_c).toBe(COUNTER_1_SID_C);
        expect(entries[0].crosswalkEntry.sid_c).toBe(COUNTER_1_SID_C);
    });

    it('crosswalk entries pass Phase 1.1b shape validators', () => {
        const unstamped = [{ compound: { id: 'A', inchi_key: ASPIRIN }, sidS: ASPIRIN_SID_S }];
        const entries = buildStampingEntries({
            unstamped, counterStart: 1, reservationId: RID, issuanceAt: NOW,
            canonicalizationVersion: SMALL_MOLECULE_CANON_VERSION,
        });
        const e = entries[0].crosswalkEntry;
        expect(e.sid_s).toBeDefined();
        expect(e.sid_c).toBeDefined();
        expect(e.entity_class).toBe(SMALL_MOLECULE_ENTITY_CLASS);
        expect(e.canonicalization_version).toBe(SMALL_MOLECULE_CANON_VERSION);
        expect(e.canonical_identity_payload).toBe(`inchikey:${ASPIRIN}`);
        expect(e.counter_value).toBe(1);
        expect(e.reservation_id).toBe(RID);
        expect(e.issuance_at).toBe(NOW);
    });

    it('throws on missing counterStart / reservationId / issuanceAt / canonicalizationVersion', () => {
        const u = [{ compound: { id: 'A', inchi_key: ASPIRIN }, sidS: ASPIRIN_SID_S }];
        expect(() => buildStampingEntries({ unstamped: u, counterStart: 0, reservationId: 'r', issuanceAt: 't', canonicalizationVersion: 'v' })).toThrow(/counterStart/);
        expect(() => buildStampingEntries({ unstamped: u, counterStart: 1, reservationId: '', issuanceAt: 't', canonicalizationVersion: 'v' })).toThrow(/reservationId/);
    });
});

describe('applyStampsToCompounds (paranoia branch)', () => {
    it('normal flow: stampMap covers every compound -> skippedParanoiaCount === 0', () => {
        const c = [{ id: 'A', name: 'aspirin' }, { id: 'B', name: 'caffeine' }];
        const m = new Map([['A', { sid_s: 'sa', sid_c: 'ca' }], ['B', { sid_s: 'sb', sid_c: 'cb' }]]);
        const r = applyStampsToCompounds(c, m);
        expect(r.skippedParanoiaCount).toBe(0);
        expect(c[0].sid_s).toBe('sa');
        expect(c[0].sid_c).toBe('ca');
        expect(c[0].name).toBe('aspirin'); // preserves other fields
        expect(c[1].sid_c).toBe('cb');
    });

    it('paranoia branch: stampMap miss -> warn + skippedParanoiaCount++', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const c = [{ id: 'A' }, { id: 'B' }];
        const m = new Map([['A', { sid_s: 'sa', sid_c: 'ca' }]]); // B missing
        const r = applyStampsToCompounds(c, m);
        expect(r.skippedParanoiaCount).toBe(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/paranoia miss.*B/));
        warnSpy.mockRestore();
    });

    it('idempotent: applying twice produces same output', () => {
        const c = [{ id: 'A', inchi_key: ASPIRIN }];
        const m = new Map([['A', { sid_s: 'sa', sid_c: 'ca' }]]);
        applyStampsToCompounds(c, m);
        const snap = JSON.stringify(c);
        applyStampsToCompounds(c, m);
        expect(JSON.stringify(c)).toBe(snap);
    });

    it('throws on non-Map stampMap', () => {
        expect(() => applyStampsToCompounds([], {})).toThrow(/Map/);
    });
});

describe('buildStampingSummary', () => {
    it('produces canonical telemetry shape', () => {
        const s = buildStampingSummary({
            totalCompounds: 100, alreadyStamped: 30, newlyStamped: 70,
            unstampable: 0, reservationsIssued: 2, skippedParanoiaCount: 0,
            elapsedMs: 12345, ledgerKeys: ['state/sid-c-ledger/r1.jsonl.zst'],
        });
        expect(s.total_compounds).toBe(100);
        expect(s.already_stamped).toBe(30);
        expect(s.newly_stamped).toBe(70);
        expect(s.reservations_issued).toBe(2);
        expect(s.skipped_paranoia_count).toBe(0);
        expect(s.ledger_keys).toHaveLength(1);
    });
});
