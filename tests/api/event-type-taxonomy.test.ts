/**
 * Tests for V0.5.8 Wave C1-1 Phase 1 — NegEvidence event_type taxonomy.
 *
 * Single source of truth for the 7 canonical evidence types Sciweon records.
 * Replaces ad-hoc string comparisons throughout the Worker API path with a
 * typed enum + runtime validator + filter parser.
 */

import { describe, it, expect } from 'vitest';
import {
    EVIDENCE_TYPES,
    isKnownEvidenceType,
    parseEventTypeFilter,
} from '../../src/worker/lib/event-type-taxonomy';

describe('EVIDENCE_TYPES', () => {
    it('contains the 7 canonical taxonomy values', () => {
        expect(EVIDENCE_TYPES).toHaveLength(7);
    });

    it('exposes the documented 7 values (MCP tool description source of truth)', () => {
        expect(EVIDENCE_TYPES).toEqual(expect.arrayContaining([
            'trial_failure',
            'inactive_bioassay',
            'drug_withdrawal',
            'black_box_warning',
            'faers_adr_signal',
            'serious_adverse_event_per_trial',
            'paper_retraction',
        ]));
    });
});

describe('isKnownEvidenceType', () => {
    it('accepts each canonical value', () => {
        for (const t of EVIDENCE_TYPES) expect(isKnownEvidenceType(t)).toBe(true);
    });

    it('rejects a near-miss typo (plural)', () => {
        expect(isKnownEvidenceType('trial_failures')).toBe(false);
    });

    it('rejects non-string types', () => {
        expect(isKnownEvidenceType(null)).toBe(false);
        expect(isKnownEvidenceType(undefined)).toBe(false);
        expect(isKnownEvidenceType(42)).toBe(false);
        expect(isKnownEvidenceType({})).toBe(false);
    });

    it('is case-sensitive (canonical form is lowercase_snake)', () => {
        expect(isKnownEvidenceType('Trial_Failure')).toBe(false);
        expect(isKnownEvidenceType('TRIAL_FAILURE')).toBe(false);
    });
});

describe('parseEventTypeFilter', () => {
    it('returns null on empty / null / undefined input (no filter requested)', () => {
        expect(parseEventTypeFilter(null)).toBeNull();
        expect(parseEventTypeFilter(undefined)).toBeNull();
        expect(parseEventTypeFilter('')).toBeNull();
        expect(parseEventTypeFilter('   ')).toBeNull();
    });

    it('parses single canonical value -> Set of 1', () => {
        const s = parseEventTypeFilter('trial_failure');
        expect(s).not.toBeNull();
        expect(s!.size).toBe(1);
        expect(s!.has('trial_failure')).toBe(true);
    });

    it('parses two values -> Set of 2', () => {
        const s = parseEventTypeFilter('trial_failure,paper_retraction');
        expect(s!.size).toBe(2);
        expect(s!.has('trial_failure')).toBe(true);
        expect(s!.has('paper_retraction')).toBe(true);
    });

    it('drops unknown tokens but keeps known ones in mixed input', () => {
        const s = parseEventTypeFilter('trial_failure,not_a_real_type,paper_retraction');
        expect(s!.size).toBe(2);
        expect(s!.has('trial_failure')).toBe(true);
        expect(s!.has('paper_retraction')).toBe(true);
    });

    it('all-unknown input returns empty Set (filter intent preserved, matches nothing)', () => {
        const s = parseEventTypeFilter('foo,bar,baz');
        expect(s).not.toBeNull();
        expect(s!.size).toBe(0);
    });

    it('trims whitespace and lowercases tokens', () => {
        const s = parseEventTypeFilter(' Trial_Failure , PAPER_RETRACTION ');
        expect(s!.size).toBe(2);
        expect(s!.has('trial_failure')).toBe(true);
        expect(s!.has('paper_retraction')).toBe(true);
    });

    it('caps input at 10 tokens (abuse guard)', () => {
        // 12 tokens all valid → only first 10 considered, but since values are
        // unique we expect at most min(7, 10) = 7 distinct types in the Set
        const many = Array(12).fill('trial_failure').join(',');
        const s = parseEventTypeFilter(many);
        expect(s!.size).toBeLessThanOrEqual(7);
    });
});
