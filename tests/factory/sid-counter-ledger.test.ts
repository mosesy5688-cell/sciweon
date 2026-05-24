// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    computeReservationRange,
    nextCounterState,
    parseCounterState,
    buildReservation,
    buildLedgerEntry,
    validateBatchSize,
    ledgerKey,
    DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE,
    MAX_CAS_RETRIES,
    NAMESPACE,
    SPEC_VERSION,
    COUNTER_KEY,
    LEDGER_PREFIX,
} from '../../scripts/factory/lib/sid-counter-ledger.js';

describe('SID counter ledger constants (V1.0 §40 + §44 lock)', () => {
    it('NAMESPACE locked to sciweon', () => { expect(NAMESPACE).toBe('sciweon'); });
    it('SPEC_VERSION locked to 1.0', () => { expect(SPEC_VERSION).toBe('1.0'); });
    it('DEFAULT_BATCH_SIZE locked to 50000 per V1.0 §44', () => { expect(DEFAULT_BATCH_SIZE).toBe(50_000); });
    it('MAX_BATCH_SIZE locked to 1000000 per V1.0 §44', () => { expect(MAX_BATCH_SIZE).toBe(1_000_000); });
    it('MAX_CAS_RETRIES is a positive integer', () => { expect(MAX_CAS_RETRIES).toBeGreaterThan(0); expect(Number.isInteger(MAX_CAS_RETRIES)).toBe(true); });
    it('COUNTER_KEY locked to canonical R2 path', () => { expect(COUNTER_KEY).toBe('state/sid-c-counter.json'); });
    it('LEDGER_PREFIX locked to canonical R2 prefix', () => { expect(LEDGER_PREFIX).toBe('state/sid-c-ledger/'); });
});

describe('validateBatchSize', () => {
    it('accepts 1 (minimum)', () => { expect(() => validateBatchSize(1)).not.toThrow(); });
    it('accepts DEFAULT_BATCH_SIZE', () => { expect(() => validateBatchSize(DEFAULT_BATCH_SIZE)).not.toThrow(); });
    it('accepts MAX_BATCH_SIZE', () => { expect(() => validateBatchSize(MAX_BATCH_SIZE)).not.toThrow(); });
    it('throws on 0', () => { expect(() => validateBatchSize(0)).toThrow(/>= 1/); });
    it('throws on negative', () => { expect(() => validateBatchSize(-1)).toThrow(/>= 1/); });
    it('throws on > MAX', () => { expect(() => validateBatchSize(MAX_BATCH_SIZE + 1)).toThrow(/exceeds MAX/); });
    it('throws on non-integer', () => { expect(() => validateBatchSize(1.5)).toThrow(/integer/); });
    it('throws on non-number', () => { expect(() => validateBatchSize('100')).toThrow(/integer/); });
});

describe('computeReservationRange (V1.0 §40 monotonic invariant)', () => {
    it('first reservation: 0 + 50000 -> [1, 50000]', () => {
        expect(computeReservationRange(0, 50_000)).toEqual({ counterStart: 1, counterEnd: 50_000 });
    });
    it('second reservation: 50000 + 50000 -> [50001, 100000]', () => {
        expect(computeReservationRange(50_000, 50_000)).toEqual({ counterStart: 50_001, counterEnd: 100_000 });
    });
    it('batch_size=1 edge case', () => {
        expect(computeReservationRange(99, 1)).toEqual({ counterStart: 100, counterEnd: 100 });
    });
    it('large counter values', () => {
        expect(computeReservationRange(999_999, 1)).toEqual({ counterStart: 1_000_000, counterEnd: 1_000_000 });
    });
    it('throws on negative currentCounter', () => {
        expect(() => computeReservationRange(-1, 50_000)).toThrow(/non-negative integer/);
    });
    it('throws on non-integer currentCounter', () => {
        expect(() => computeReservationRange(1.5, 50_000)).toThrow(/non-negative integer/);
    });
    it('propagates batchSize validation', () => {
        expect(() => computeReservationRange(0, 0)).toThrow(/>= 1/);
    });
});

describe('parseCounterState', () => {
    it('null input returns empty state', () => {
        const s = parseCounterState(null);
        expect(s.namespace).toBe(NAMESPACE);
        expect(s.spec_version).toBe(SPEC_VERSION);
        expect(s.entity_classes).toEqual({});
        expect(s.last_updated).toBeNull();
    });
    it('empty string returns empty state', () => {
        const s = parseCounterState('');
        expect(s.entity_classes).toEqual({});
    });
    it('parses valid JSON state', () => {
        const json = JSON.stringify({ namespace: 'sciweon', spec_version: '1.0', entity_classes: { small_molecule: { current_counter: 100, last_reservation: null } }, last_updated: '2026-05-24T12:00:00Z' });
        const s = parseCounterState(json);
        expect(s.entity_classes.small_molecule.current_counter).toBe(100);
        expect(s.last_updated).toBe('2026-05-24T12:00:00Z');
    });
    it('defaults namespace/spec_version when absent in input', () => {
        const s = parseCounterState(JSON.stringify({ entity_classes: {} }));
        expect(s.namespace).toBe(NAMESPACE);
        expect(s.spec_version).toBe(SPEC_VERSION);
    });
    it('accepts already-parsed object', () => {
        const s = parseCounterState({ namespace: 'sciweon', spec_version: '1.0', entity_classes: { trial: { current_counter: 7, last_reservation: null } } });
        expect(s.entity_classes.trial.current_counter).toBe(7);
    });
});

describe('nextCounterState', () => {
    const NOW = '2026-05-24T12:00:00Z';
    const RID = 'rid-test-uuid';
    it('first-ever reservation initializes namespace + entity_class bucket', () => {
        const { newState, reservation, counterStart, counterEnd } = nextCounterState(null, 'small_molecule', 50_000, RID, 'worker-1', NOW);
        expect(newState.namespace).toBe('sciweon');
        expect(newState.spec_version).toBe('1.0');
        expect(newState.entity_classes.small_molecule.current_counter).toBe(50_000);
        expect(counterStart).toBe(1);
        expect(counterEnd).toBe(50_000);
        expect(reservation.reservation_id).toBe(RID);
    });
    it('second reservation advances current_counter by batchSize', () => {
        const prev = { entity_classes: { small_molecule: { current_counter: 50_000, last_reservation: null } } };
        const { newState, counterStart, counterEnd } = nextCounterState(prev, 'small_molecule', 25_000, RID, null, NOW);
        expect(newState.entity_classes.small_molecule.current_counter).toBe(75_000);
        expect(counterStart).toBe(50_001);
        expect(counterEnd).toBe(75_000);
    });
    it('preserves other entity_class buckets', () => {
        const prev = { entity_classes: { trial: { current_counter: 42, last_reservation: null }, small_molecule: { current_counter: 100, last_reservation: null } } };
        const { newState } = nextCounterState(prev, 'small_molecule', 10, RID, null, NOW);
        expect(newState.entity_classes.trial.current_counter).toBe(42);
        expect(newState.entity_classes.small_molecule.current_counter).toBe(110);
    });
    it('updates last_updated timestamp', () => {
        const { newState } = nextCounterState(null, 'small_molecule', 1, RID, null, NOW);
        expect(newState.last_updated).toBe(NOW);
    });
    it('throws on missing entityClass', () => {
        expect(() => nextCounterState(null, '', 1, RID, null, NOW)).toThrow(/entityClass/);
    });
});

describe('buildReservation', () => {
    const NOW = '2026-05-24T12:00:00Z';
    it('produces canonical reservation shape', () => {
        const r = buildReservation({ entityClass: 'small_molecule', counterStart: 1, counterEnd: 50_000, reservationId: 'rid', workerId: 'w1', now: NOW });
        expect(r).toEqual({ reservation_id: 'rid', entity_class: 'small_molecule', counter_start: 1, counter_end: 50_000, batch_size: 50_000, issued_at: NOW, worker_id: 'w1' });
    });
    it('workerId defaults to null when absent', () => {
        const r = buildReservation({ entityClass: 'trial', counterStart: 1, counterEnd: 1, reservationId: 'rid', now: NOW });
        expect(r.worker_id).toBeNull();
    });
    it('throws on missing entityClass', () => {
        expect(() => buildReservation({ counterStart: 1, counterEnd: 1, reservationId: 'rid', now: NOW })).toThrow(/entityClass/);
    });
    it('throws on missing reservationId', () => {
        expect(() => buildReservation({ entityClass: 'trial', counterStart: 1, counterEnd: 1, now: NOW })).toThrow(/reservationId/);
    });
});

describe('buildLedgerEntry', () => {
    const BASE = {
        counterValue: 1, entityClass: 'small_molecule',
        sidS: 'c1fe6bb77cec6b1e3ecd0061a5dc749e', sidC: '9549658c8384b75a751de9d7eaa28d4d',
        canonicalIdentityPayload: 'inchikey:BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
        canonicalizationVersion: 'compound.inchikey.v1.0',
        reservationId: 'rid-uuid', issuanceAt: '2026-05-24T12:00:00Z',
    };
    it('produces canonical ledger entry (aspirin reference SIDs from Phase 1.1a)', () => {
        const e = buildLedgerEntry(BASE);
        expect(e.sid_s).toBe('c1fe6bb77cec6b1e3ecd0061a5dc749e');
        expect(e.sid_c).toBe('9549658c8384b75a751de9d7eaa28d4d');
        expect(e.counter_value).toBe(1);
        expect(e.entity_class).toBe('small_molecule');
    });
    it('throws on counter_value=0 (counter is 1-indexed per §40)', () => {
        expect(() => buildLedgerEntry({ ...BASE, counterValue: 0 })).toThrow(/positive integer/);
    });
    it('throws on missing sidS', () => {
        expect(() => buildLedgerEntry({ ...BASE, sidS: '' })).toThrow(/sidS/);
    });
    it('throws on missing canonicalizationVersion', () => {
        expect(() => buildLedgerEntry({ ...BASE, canonicalizationVersion: '' })).toThrow(/canonicalizationVersion/);
    });
});

describe('ledgerKey', () => {
    it('formats reservation_id into LEDGER_PREFIX path', () => {
        expect(ledgerKey('rid-uuid-1234')).toBe('state/sid-c-ledger/rid-uuid-1234.jsonl.zst');
    });
    it('throws on missing reservationId', () => {
        expect(() => ledgerKey('')).toThrow(/reservationId/);
    });
});
