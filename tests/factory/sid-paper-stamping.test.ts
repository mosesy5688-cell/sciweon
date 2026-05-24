// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import {
    sanitizeDoi, deriveDoiAnchor, deriveOpenAlexAnchor, derivePaperSidSCandidates,
    classifyPapers, buildPaperStampingEntries, buildCrossPollinationEntries,
    applyStampsToPapers, buildPaperStampingSummary,
    PAPER_ENTITY_CLASS, PAPER_CANON_VERSION_DOI, PAPER_CANON_VERSION_OPENALEX,
    UNSTAMPABLE_REASON_MISSING_PAPER_ID,
} from '../../scripts/factory/lib/sid-paper-stamping.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';

// Frozen reference SIDs (computed via PowerShell SHA-256, pinned).
const DOI_SAMPLE = '10.1038/nature12373';
const OPENALEX_SAMPLE = 'W2741809807';
const DOI_PAPER_SID_S = '9e64b09acf81cb4f69e2dd5a745edc2a';
const OPENALEX_PAPER_SID_S = '8d11ef1fed63aa0d325ee47e3b82d6eb';
const COUNTER_1_PAPER_SID_C = '105da45b553501f5dd9f7bb3d10c50f7';

describe('constants', () => {
    it('PAPER_ENTITY_CLASS locked', () => { expect(PAPER_ENTITY_CLASS).toBe('paper'); });
    it('PAPER_CANON_VERSION_DOI locked', () => { expect(PAPER_CANON_VERSION_DOI).toBe('paper.doi.v1.0'); });
    it('PAPER_CANON_VERSION_OPENALEX locked', () => { expect(PAPER_CANON_VERSION_OPENALEX).toBe('paper.openalex.v1.0'); });
});

describe('sanitizeDoi — defensive cleaning', () => {
    it('strips trailing punctuation (defect minor fix)', () => {
        expect(sanitizeDoi('10.1038/nature12373.')).toBe('10.1038/nature12373');
        expect(sanitizeDoi('10.1038/nature12373,')).toBe('10.1038/nature12373');
        expect(sanitizeDoi('10.1038/nature12373;')).toBe('10.1038/nature12373');
    });
    it('strips URL prefix', () => {
        expect(sanitizeDoi('https://doi.org/10.1038/nature12373')).toBe('10.1038/nature12373');
        expect(sanitizeDoi('https://dx.doi.org/10.1038/Nature12373')).toBe('10.1038/nature12373');
    });
    it('lowercases', () => { expect(sanitizeDoi('10.1038/NATURE12373')).toBe('10.1038/nature12373'); });
    it('trims whitespace', () => { expect(sanitizeDoi('  10.1038/nature12373  ')).toBe('10.1038/nature12373'); });
    it('non-string -> null', () => { expect(sanitizeDoi(null)).toBeNull(); expect(sanitizeDoi(42)).toBeNull(); });
    it('empty -> null', () => { expect(sanitizeDoi('')).toBeNull(); expect(sanitizeDoi('   ')).toBeNull(); });
});

describe('deriveDoiAnchor', () => {
    it('valid DOI -> anchor with paper.doi.v1.0', () => {
        const a = deriveDoiAnchor({ doi: DOI_SAMPLE });
        expect(a).toEqual({ canonVersion: PAPER_CANON_VERSION_DOI, payload: `doi:${DOI_SAMPLE}` });
    });
    it('dirty DOI sanitized via pipeline', () => {
        const a = deriveDoiAnchor({ doi: 'https://doi.org/10.1038/Nature12373.' });
        expect(a.payload).toBe(`doi:${DOI_SAMPLE}`);
    });
    it('malformed DOI -> null', () => { expect(deriveDoiAnchor({ doi: 'not-a-doi' })).toBeNull(); });
    it('missing doi -> null', () => { expect(deriveDoiAnchor({})).toBeNull(); });
});

describe('deriveOpenAlexAnchor', () => {
    it('valid W-prefixed ID -> anchor', () => {
        const a = deriveOpenAlexAnchor({ openalex_id: OPENALEX_SAMPLE });
        expect(a).toEqual({ canonVersion: PAPER_CANON_VERSION_OPENALEX, payload: `openalex:${OPENALEX_SAMPLE}` });
    });
    it('malformed openalex_id -> null', () => {
        expect(deriveOpenAlexAnchor({ openalex_id: 'X12345' })).toBeNull();
        expect(deriveOpenAlexAnchor({ openalex_id: 'Wabc' })).toBeNull();
    });
    it('missing openalex_id -> null', () => { expect(deriveOpenAlexAnchor({})).toBeNull(); });
});

describe('derivePaperSidSCandidates', () => {
    it('DOI-only -> primary=DOI, fallback=null', () => {
        const c = derivePaperSidSCandidates({ doi: DOI_SAMPLE });
        expect(c.primary.sidS).toBe(DOI_PAPER_SID_S);
        expect(c.primary.canonVersion).toBe(PAPER_CANON_VERSION_DOI);
        expect(c.fallback).toBeNull();
    });
    it('OpenAlex-only -> primary=OpenAlex, fallback=null', () => {
        const c = derivePaperSidSCandidates({ openalex_id: OPENALEX_SAMPLE });
        expect(c.primary.sidS).toBe(OPENALEX_PAPER_SID_S);
        expect(c.primary.canonVersion).toBe(PAPER_CANON_VERSION_OPENALEX);
        expect(c.fallback).toBeNull();
    });
    it('both -> primary=DOI, fallback=OpenAlex', () => {
        const c = derivePaperSidSCandidates({ doi: DOI_SAMPLE, openalex_id: OPENALEX_SAMPLE });
        expect(c.primary.sidS).toBe(DOI_PAPER_SID_S);
        expect(c.fallback.sidS).toBe(OPENALEX_PAPER_SID_S);
    });
    it('neither -> both null', () => {
        const c = derivePaperSidSCandidates({});
        expect(c.primary).toBeNull();
        expect(c.fallback).toBeNull();
    });
});

describe('classifyPapers — defect-5 + 5-expanded fix coverage', () => {
    const emptyIndex = buildCrosswalkIndex([]);
    function fixtureEntry(sidS, sidC, counterValue, canonVersion) {
        return {
            sid_s: sidS, sid_c: sidC, entity_class: PAPER_ENTITY_CLASS,
            canonicalization_version: canonVersion, canonical_identity_payload: 'x',
            counter_value: counterValue, reservation_id: 'r', issuance_at: '2026-05-24T00:00:00Z',
        };
    }

    it('empty crosswalk + valid paper -> unstamped, crossPollination empty', () => {
        const r = classifyPapers([{ id: 'p1', doi: DOI_SAMPLE }], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.crossPollination).toHaveLength(0);
    });

    it('paper without any anchor -> unstampable (NEVER throws)', () => {
        const r = classifyPapers([{ id: 'p-missing' }], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_PAPER_ID);
    });

    it('primary hit in crosswalk -> alreadyStamped, no crossPollination', () => {
        const idx = buildCrosswalkIndex([fixtureEntry(DOI_PAPER_SID_S, COUNTER_1_PAPER_SID_C, 1, PAPER_CANON_VERSION_DOI)]);
        const r = classifyPapers([{ id: 'p1', doi: DOI_SAMPLE }], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidC).toBe(COUNTER_1_PAPER_SID_C);
        expect(r.crossPollination).toHaveLength(0);
    });

    it('★ defect-5: both anchors, fallback hit, primary miss -> alreadyStamped with FALLBACK sid + crossPollination entry', () => {
        const idx = buildCrosswalkIndex([fixtureEntry(OPENALEX_PAPER_SID_S, COUNTER_1_PAPER_SID_C, 7, PAPER_CANON_VERSION_OPENALEX)]);
        const r = classifyPapers([{ id: 'p1', doi: DOI_SAMPLE, openalex_id: OPENALEX_SAMPLE }], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidS).toBe(OPENALEX_PAPER_SID_S);
        expect(r.alreadyStamped[0].sidC).toBe(COUNTER_1_PAPER_SID_C);
        expect(r.crossPollination).toHaveLength(1);
        expect(r.crossPollination[0].primarySidS).toBe(DOI_PAPER_SID_S);
        expect(r.crossPollination[0].fallbackSidS).toBe(OPENALEX_PAPER_SID_S);
        expect(r.crossPollination[0].sidC).toBe(COUNTER_1_PAPER_SID_C);
        expect(r.crossPollination[0].counterValue).toBe(7);
    });

    it('both anchors, neither in crosswalk -> unstamped under PRIMARY (DOI)', () => {
        const r = classifyPapers([{ id: 'p1', doi: DOI_SAMPLE, openalex_id: OPENALEX_SAMPLE }], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.unstamped[0].sidS).toBe(DOI_PAPER_SID_S);
        expect(r.crossPollination).toHaveLength(0);
    });

    it('mixed batch -> 4 partitions populated correctly', () => {
        const idx = buildCrosswalkIndex([
            fixtureEntry(DOI_PAPER_SID_S, 'sidc-doi', 1, PAPER_CANON_VERSION_DOI),
            fixtureEntry(OPENALEX_PAPER_SID_S, 'sidc-oa', 2, PAPER_CANON_VERSION_OPENALEX),
        ]);
        const r = classifyPapers([
            { id: 'p1', doi: DOI_SAMPLE },                                            // already_stamped via DOI
            { id: 'p2', openalex_id: 'W999' },                                        // unstamped via OpenAlex
            { id: 'p3', doi: '10.1234/other', openalex_id: OPENALEX_SAMPLE },         // cross-pollination
            { id: 'p4-missing' },                                                       // unstampable
        ], idx);
        expect(r.alreadyStamped).toHaveLength(2);
        expect(r.unstamped).toHaveLength(1);
        expect(r.unstampable).toHaveLength(1);
        expect(r.crossPollination).toHaveLength(1);
    });
});

describe('buildPaperStampingEntries — multi-canon-version', () => {
    const NOW = '2026-05-24T12:00:00Z';
    it('per-entry canonicalization_version from anchor', () => {
        const unstamped = [
            { paper: { id: 'p1' }, sidS: DOI_PAPER_SID_S, anchor: { canonVersion: PAPER_CANON_VERSION_DOI, payload: `doi:${DOI_SAMPLE}` } },
            { paper: { id: 'p2' }, sidS: OPENALEX_PAPER_SID_S, anchor: { canonVersion: PAPER_CANON_VERSION_OPENALEX, payload: `openalex:${OPENALEX_SAMPLE}` } },
        ];
        const entries = buildPaperStampingEntries({ unstamped, counterStart: 1, reservationId: 'rid-1', issuanceAt: NOW });
        expect(entries[0].ledgerEntry.canonicalization_version).toBe(PAPER_CANON_VERSION_DOI);
        expect(entries[1].ledgerEntry.canonicalization_version).toBe(PAPER_CANON_VERSION_OPENALEX);
        expect(entries[0].sidC).toBe(COUNTER_1_PAPER_SID_C);
    });
});

describe('buildCrossPollinationEntries — defect-5-expanded fix', () => {
    const NOW = '2026-05-24T12:00:00Z';
    it('produces crosswalk entries binding primary sid_s -> existing sid_c (no new counter)', () => {
        const cp = [{
            paper: { id: 'p1' }, primarySidS: DOI_PAPER_SID_S, fallbackSidS: OPENALEX_PAPER_SID_S,
            sidC: 'existing-sidc', counterValue: 42,
            anchor: { canonVersion: PAPER_CANON_VERSION_DOI, payload: `doi:${DOI_SAMPLE}` },
        }];
        const entries = buildCrossPollinationEntries({ crossPollination: cp, reservationId: 'crosspoll-x', issuanceAt: NOW });
        expect(entries).toHaveLength(1);
        expect(entries[0].sid_s).toBe(DOI_PAPER_SID_S);
        expect(entries[0].sid_c).toBe('existing-sidc');
        expect(entries[0].counter_value).toBe(42);
        expect(entries[0].canonicalization_version).toBe(PAPER_CANON_VERSION_DOI);
    });
});

describe('applyStampsToPapers — defect-4 carry', () => {
    it('opaque paper.id', () => {
        const c = [{ id: 'sciweon::paper::W2741809807' }];
        const m = new Map([['sciweon::paper::W2741809807', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToPapers(c, m);
        expect(r.skippedParanoiaCount).toBe(0);
        expect(c[0].sid_s).toBe('a');
    });
    it('paranoia branch on miss', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const c = [{ id: 'p1' }, { id: 'p2' }];
        const m = new Map([['p1', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToPapers(c, m);
        expect(r.skippedParanoiaCount).toBe(1);
        warnSpy.mockRestore();
    });
});

describe('buildPaperStampingSummary', () => {
    it('includes cross_pollinated + stamped_by_doi + stamped_by_openalex', () => {
        const s = buildPaperStampingSummary({
            totalPapers: 100, alreadyStamped: 20, newlyStamped: 80, unstampable: 0,
            crossPollinated: 5, stampedByDoi: 60, stampedByOpenalex: 20,
            reservationsIssued: 2, skippedParanoiaCount: 0, elapsedMs: 100, ledgerKeys: [],
        });
        expect(s.cross_pollinated).toBe(5);
        expect(s.stamped_by_doi).toBe(60);
        expect(s.stamped_by_openalex).toBe(20);
    });
});
