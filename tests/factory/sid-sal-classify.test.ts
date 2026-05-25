// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    SAL_ASSERTION_ENTITY_CLASS, SAL_CANON_VERSION, SAL_ANCHOR_PREFIX, SAL_PAYLOAD_PREFIX,
    UNSTAMPABLE_REASON_MISSING_SUBJECT_SID, UNSTAMPABLE_REASON_MISSING_OBJECT_SID,
    UNSTAMPABLE_REASON_MISSING_PAYLOAD_FIELD,
    classifyAssertions, buildSalStampingEntries, buildOutputRow, buildSalStampingSummary,
} from '../../scripts/factory/lib/sid-sal-stamping.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';

const SAMPLE_PAYLOAD = {
    assertion_class: 'bioactivity_association',
    subject_canonical_sid: 'a'.repeat(32),
    predicate: 'inhibits',
    object_canonical_sid: 'b'.repeat(32),
    primary_source: 'chembl_activity:12345',
};

describe('classifyAssertions — hard-fail invariant', () => {
    const emptyIndex = buildCrosswalkIndex([]);

    it('valid assertion → unstamped on empty crosswalk', () => {
        const r = classifyAssertions([SAMPLE_PAYLOAD], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.alreadyStamped).toEqual([]);
        expect(r.unstampable).toEqual([]);
    });
    it('missing subject_canonical_sid → unstampable MISSING_SUBJECT_SID', () => {
        const r = classifyAssertions([{ ...SAMPLE_PAYLOAD, subject_canonical_sid: null }], emptyIndex);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_SUBJECT_SID);
    });
    it('missing object_canonical_sid → unstampable MISSING_OBJECT_SID', () => {
        const r = classifyAssertions([{ ...SAMPLE_PAYLOAD, object_canonical_sid: null }], emptyIndex);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_OBJECT_SID);
    });
    it('missing other field → unstampable MISSING_PAYLOAD_FIELD', () => {
        const r = classifyAssertions([{ ...SAMPLE_PAYLOAD, predicate: null }], emptyIndex);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_PAYLOAD_FIELD);
        expect(r.unstampable[0].missingField).toBe('predicate');
    });
    it('crosswalk hit → alreadyStamped', () => {
        const firstPass = classifyAssertions([SAMPLE_PAYLOAD], buildCrosswalkIndex([]));
        const sidS = firstPass.unstamped[0].sidS;
        const anchor = firstPass.unstamped[0].anchor;
        const seed = [{
            sid_s: sidS, sid_c: 'c'.repeat(32),
            entity_class: SAL_ASSERTION_ENTITY_CLASS, canonicalization_version: SAL_CANON_VERSION,
            canonical_identity_payload: anchor.payload,
            counter_value: 1, reservation_id: 'rid', issuance_at: '2026-05-25T00:00:00Z',
        }];
        const r = classifyAssertions([SAMPLE_PAYLOAD], buildCrosswalkIndex(seed));
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidC).toBe('c'.repeat(32));
    });
});

describe('buildSalStampingEntries', () => {
    it('counter=1 entry has correct shape', () => {
        const firstPass = classifyAssertions([SAMPLE_PAYLOAD], buildCrosswalkIndex([]));
        const entries = buildSalStampingEntries({
            unstamped: firstPass.unstamped, counterStart: 1,
            reservationId: 'rid-1', issuanceAt: '2026-05-25T00:00:00Z',
        });
        expect(entries).toHaveLength(1);
        expect(entries[0].sidS).toBe(firstPass.unstamped[0].sidS);
        expect(entries[0].crosswalkEntry.entity_class).toBe(SAL_ASSERTION_ENTITY_CLASS);
        expect(entries[0].crosswalkEntry.canonicalization_version).toBe(SAL_CANON_VERSION);
        expect(entries[0].crosswalkEntry.canonical_identity_payload.startsWith(SAL_PAYLOAD_PREFIX)).toBe(true);
        expect(entries[0].ledgerEntry.counter_value).toBe(1);
    });
});

describe('buildOutputRow — locked double-track schema', () => {
    it('produces sid_s + sid_c + anchor + display_label + payload', () => {
        const firstPass = classifyAssertions([SAMPLE_PAYLOAD], buildCrosswalkIndex([]));
        const u = firstPass.unstamped[0];
        const row = buildOutputRow({
            sidS: u.sidS, sidC: 'c'.repeat(32), anchor: u.anchor, payload: u.payload,
            displayContext: { subject_label: 'Aspirin', object_label: 'COX-1' },
        });
        expect(row.sid_s).toBe(u.sidS);
        expect(row.sid_c).toBe('c'.repeat(32));
        expect(row.anchor.startsWith(SAL_ANCHOR_PREFIX)).toBe(true);
        expect(row.display_label).toBe('[BIOACTIVITY_ASSOCIATION] Aspirin -> inhibits -> COX-1 (via chembl_activity:12345)');
        expect(row.payload.predicate).toBe(SAMPLE_PAYLOAD.predicate);
    });
    it('falls back to SID-S when no display labels provided', () => {
        const firstPass = classifyAssertions([SAMPLE_PAYLOAD], buildCrosswalkIndex([]));
        const u = firstPass.unstamped[0];
        const row = buildOutputRow({ sidS: u.sidS, sidC: 'c'.repeat(32), anchor: u.anchor, payload: u.payload });
        expect(row.display_label).toContain(SAMPLE_PAYLOAD.subject_canonical_sid);
        expect(row.display_label).toContain(SAMPLE_PAYLOAD.object_canonical_sid);
    });
});

describe('buildSalStampingSummary', () => {
    it('canonical telemetry shape', () => {
        const s = buildSalStampingSummary({
            totalAssertions: 100, alreadyStamped: 20, newlyStamped: 80, unstampable: 0,
            perClassCounts: { bioactivity_association: 100 },
            perBuilderCounts: { 'SAL-BIOACTIVITY-BUILDER': 100 },
            reservationsIssued: 2, skippedParanoiaCount: 0,
            elapsedMs: 100, ledgerKeys: ['k1'], shardCount: 1,
        });
        expect(s.total_assertions).toBe(100);
        expect(s.newly_stamped).toBe(80);
        expect(s.per_class_counts.bioactivity_association).toBe(100);
        expect(s.shard_count).toBe(1);
    });
});
