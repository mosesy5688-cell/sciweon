// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import {
    deriveUniprotAnchor, deriveEnsemblAnchor, deriveTargetSidSCandidates,
    classifyTargets, buildTargetStampingEntries, buildTargetCrossPollinationEntries,
    applyStampsToTargets, buildTargetStampingSummary,
    TARGET_ENTITY_CLASS, TARGET_CANON_VERSION_UNIPROT, TARGET_CANON_VERSION_ENSEMBL,
    UNSTAMPABLE_REASON_MISSING_TARGET_ID,
} from '../../scripts/factory/lib/sid-target-stamping.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';

// Frozen reference SIDs (PowerShell SHA-256 pre-computed).
const UNIPROT_SAMPLE = 'P00533';
const ENSEMBL_SAMPLE = 'ENSG00000146648';
const UNIPROT_TARGET_SID_S = '0c83c5dce03b91adeabc7678fc0cb475';
const ENSEMBL_TARGET_SID_S = 'dc93bdb2402e22e573a5be5bbd639b98';
const COUNTER_1_TARGET_SID_C = '8a64d495f4fcad00dd3d27161ceece76';

describe('constants', () => {
    it('TARGET_ENTITY_CLASS locked', () => { expect(TARGET_ENTITY_CLASS).toBe('target'); });
    it('TARGET_CANON_VERSION_UNIPROT locked', () => { expect(TARGET_CANON_VERSION_UNIPROT).toBe('target.uniprot.v1.0'); });
    it('TARGET_CANON_VERSION_ENSEMBL locked', () => { expect(TARGET_CANON_VERSION_ENSEMBL).toBe('target.ensembl.v1.0'); });
});

describe('deriveUniprotAnchor — defect-8 + defect-3 carry', () => {
    it('valid UniProt -> anchor', () => {
        const a = deriveUniprotAnchor({ uniprot_accession: UNIPROT_SAMPLE });
        expect(a).toEqual({ canonVersion: TARGET_CANON_VERSION_UNIPROT, payload: `uniprot:${UNIPROT_SAMPLE}` });
    });
    it('isoform truncated via sanitizeUniprot (defect-8)', () => {
        const a = deriveUniprotAnchor({ uniprot_accession: 'P00533-2' });
        expect(a.payload).toBe(`uniprot:${UNIPROT_SAMPLE}`);
    });
    it('lowercase normalized', () => {
        const a = deriveUniprotAnchor({ uniprot_accession: 'p00533' });
        expect(a.payload).toBe(`uniprot:${UNIPROT_SAMPLE}`);
    });
    it('malformed UniProt -> null', () => {
        expect(deriveUniprotAnchor({ uniprot_accession: 'not-a-uniprot' })).toBeNull();
        expect(deriveUniprotAnchor({ uniprot_accession: 'ABCDEF' })).toBeNull(); // all letters fails both alternatives
        expect(deriveUniprotAnchor({ uniprot_accession: '123456' })).toBeNull(); // all digits
    });
    it('missing uniprot_accession -> null', () => { expect(deriveUniprotAnchor({})).toBeNull(); });
    it('ignores ensembl_gene_id field (field-shape on identifier itself)', () => {
        const a = deriveUniprotAnchor({ uniprot_accession: UNIPROT_SAMPLE, ensembl_gene_id: ENSEMBL_SAMPLE });
        expect(a.payload).toBe(`uniprot:${UNIPROT_SAMPLE}`);
    });
});

describe('deriveEnsemblAnchor', () => {
    it('valid ENSG -> anchor', () => {
        const a = deriveEnsemblAnchor({ ensembl_gene_id: ENSEMBL_SAMPLE });
        expect(a).toEqual({ canonVersion: TARGET_CANON_VERSION_ENSEMBL, payload: `ensembl:${ENSEMBL_SAMPLE}` });
    });
    it('non-ENSG format -> null', () => {
        expect(deriveEnsemblAnchor({ ensembl_gene_id: 'ENST12345678901' })).toBeNull(); // transcript not gene
        expect(deriveEnsemblAnchor({ ensembl_gene_id: 'ENSG123' })).toBeNull(); // too short
    });
    it('missing ensembl_gene_id -> null', () => { expect(deriveEnsemblAnchor({})).toBeNull(); });
});

describe('deriveTargetSidSCandidates', () => {
    it('UniProt-only -> primary=UniProt, fallback=null', () => {
        const c = deriveTargetSidSCandidates({ uniprot_accession: UNIPROT_SAMPLE });
        expect(c.primary.sidS).toBe(UNIPROT_TARGET_SID_S);
        expect(c.primary.canonVersion).toBe(TARGET_CANON_VERSION_UNIPROT);
        expect(c.fallback).toBeNull();
    });
    it('Ensembl-only -> primary=Ensembl, fallback=null', () => {
        const c = deriveTargetSidSCandidates({ ensembl_gene_id: ENSEMBL_SAMPLE });
        expect(c.primary.sidS).toBe(ENSEMBL_TARGET_SID_S);
        expect(c.primary.canonVersion).toBe(TARGET_CANON_VERSION_ENSEMBL);
        expect(c.fallback).toBeNull();
    });
    it('both -> primary=UniProt, fallback=Ensembl', () => {
        const c = deriveTargetSidSCandidates({ uniprot_accession: UNIPROT_SAMPLE, ensembl_gene_id: ENSEMBL_SAMPLE });
        expect(c.primary.sidS).toBe(UNIPROT_TARGET_SID_S);
        expect(c.fallback.sidS).toBe(ENSEMBL_TARGET_SID_S);
    });
    it('neither -> both null', () => {
        const c = deriveTargetSidSCandidates({});
        expect(c.primary).toBeNull();
        expect(c.fallback).toBeNull();
    });
});

describe('classifyTargets — defect-5 + 5-expanded coverage', () => {
    const emptyIndex = buildCrosswalkIndex([]);
    function fixtureEntry(sidS, sidC, counterValue, canonVersion) {
        return {
            sid_s: sidS, sid_c: sidC, entity_class: TARGET_ENTITY_CLASS,
            canonicalization_version: canonVersion, canonical_identity_payload: 'x',
            counter_value: counterValue, reservation_id: 'r', issuance_at: '2026-05-24T00:00:00Z',
        };
    }

    it('empty crosswalk + valid target -> unstamped', () => {
        const r = classifyTargets([{ id: 't1', uniprot_accession: UNIPROT_SAMPLE }], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.crossPollination).toHaveLength(0);
    });

    it('no anchor -> unstampable', () => {
        const r = classifyTargets([{ id: 't-missing' }], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_TARGET_ID);
    });

    it('primary UniProt hit -> alreadyStamped, no crossPollination', () => {
        const idx = buildCrosswalkIndex([fixtureEntry(UNIPROT_TARGET_SID_S, COUNTER_1_TARGET_SID_C, 1, TARGET_CANON_VERSION_UNIPROT)]);
        const r = classifyTargets([{ id: 't1', uniprot_accession: UNIPROT_SAMPLE }], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.crossPollination).toHaveLength(0);
    });

    it('★ defect-5 + 5-expanded: both anchors, UniProt miss, Ensembl hit -> alreadyStamped via Ensembl + crossPollination entry', () => {
        // Target was first stamped under Ensembl-only (bioactivity ingest cycle); now OT adds UniProt
        const idx = buildCrosswalkIndex([fixtureEntry(ENSEMBL_TARGET_SID_S, COUNTER_1_TARGET_SID_C, 7, TARGET_CANON_VERSION_ENSEMBL)]);
        const r = classifyTargets([{ id: 't1', uniprot_accession: UNIPROT_SAMPLE, ensembl_gene_id: ENSEMBL_SAMPLE }], idx);
        // Wait — actually canonical anchor precedence is UniProt FIRST (primary). So in this case:
        // - primary = UniProt, sidS = 0c83c... → not in crosswalk
        // - fallback = Ensembl, sidS = dc93b... → IS in crosswalk
        // → alreadyStamped with Ensembl sid + cross-pollination entry binding UniProt sidS to same sid_c
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidS).toBe(ENSEMBL_TARGET_SID_S);
        expect(r.alreadyStamped[0].sidC).toBe(COUNTER_1_TARGET_SID_C);
        expect(r.crossPollination).toHaveLength(1);
        expect(r.crossPollination[0].primarySidS).toBe(UNIPROT_TARGET_SID_S);
        expect(r.crossPollination[0].fallbackSidS).toBe(ENSEMBL_TARGET_SID_S);
        expect(r.crossPollination[0].sidC).toBe(COUNTER_1_TARGET_SID_C);
        expect(r.crossPollination[0].counterValue).toBe(7);
    });

    it('both anchors, neither in crosswalk -> unstamped under UniProt primary', () => {
        const r = classifyTargets([{ id: 't1', uniprot_accession: UNIPROT_SAMPLE, ensembl_gene_id: ENSEMBL_SAMPLE }], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.unstamped[0].sidS).toBe(UNIPROT_TARGET_SID_S);
        expect(r.unstamped[0].anchor.canonVersion).toBe(TARGET_CANON_VERSION_UNIPROT);
    });

    it('mixed batch -> 4 partitions populated correctly', () => {
        const idx = buildCrosswalkIndex([
            fixtureEntry(UNIPROT_TARGET_SID_S, 'sidc-up', 1, TARGET_CANON_VERSION_UNIPROT),
            fixtureEntry(ENSEMBL_TARGET_SID_S, 'sidc-ens', 2, TARGET_CANON_VERSION_ENSEMBL),
        ]);
        const r = classifyTargets([
            { id: 't1', uniprot_accession: UNIPROT_SAMPLE },                                  // already_stamped via UniProt
            { id: 't2', ensembl_gene_id: 'ENSG99999999999' },                                  // unstamped via Ensembl
            { id: 't3', uniprot_accession: 'P00734', ensembl_gene_id: ENSEMBL_SAMPLE },        // primary miss + fallback hit -> cross-pollination
            { id: 't4-missing' },                                                                // unstampable
        ], idx);
        expect(r.alreadyStamped).toHaveLength(2);
        expect(r.unstamped).toHaveLength(1);
        expect(r.unstampable).toHaveLength(1);
        expect(r.crossPollination).toHaveLength(1);
    });
});

describe('buildTargetStampingEntries', () => {
    const NOW = '2026-05-24T12:00:00Z';
    it('per-entry canonicalization_version from anchor + frozen counter=1 SID-C', () => {
        const unstamped = [
            { target: { id: 't1' }, sidS: UNIPROT_TARGET_SID_S, anchor: { canonVersion: TARGET_CANON_VERSION_UNIPROT, payload: `uniprot:${UNIPROT_SAMPLE}` } },
            { target: { id: 't2' }, sidS: ENSEMBL_TARGET_SID_S, anchor: { canonVersion: TARGET_CANON_VERSION_ENSEMBL, payload: `ensembl:${ENSEMBL_SAMPLE}` } },
        ];
        const entries = buildTargetStampingEntries({ unstamped, counterStart: 1, reservationId: 'rid-1', issuanceAt: NOW });
        expect(entries[0].ledgerEntry.canonicalization_version).toBe(TARGET_CANON_VERSION_UNIPROT);
        expect(entries[1].ledgerEntry.canonicalization_version).toBe(TARGET_CANON_VERSION_ENSEMBL);
        expect(entries[0].sidC).toBe(COUNTER_1_TARGET_SID_C);
    });
});

describe('buildTargetCrossPollinationEntries', () => {
    it('produces crosswalk entries with primary sid_s + existing sid_c (no new counter)', () => {
        const cp = [{
            target: { id: 't1' }, primarySidS: UNIPROT_TARGET_SID_S, fallbackSidS: ENSEMBL_TARGET_SID_S,
            sidC: 'existing-sidc', counterValue: 42,
            anchor: { canonVersion: TARGET_CANON_VERSION_UNIPROT, payload: `uniprot:${UNIPROT_SAMPLE}` },
        }];
        const entries = buildTargetCrossPollinationEntries({ crossPollination: cp, reservationId: 'crosspoll-x', issuanceAt: '2026-05-24T12:00:00Z' });
        expect(entries).toHaveLength(1);
        expect(entries[0].sid_s).toBe(UNIPROT_TARGET_SID_S);
        expect(entries[0].sid_c).toBe('existing-sidc');
        expect(entries[0].counter_value).toBe(42);
        expect(entries[0].canonicalization_version).toBe(TARGET_CANON_VERSION_UNIPROT);
    });
});

describe('applyStampsToTargets — defect-4 carry', () => {
    it('opaque target.id', () => {
        const c = [{ id: 'sciweon::target::uniprot:P00533' }];
        const m = new Map([['sciweon::target::uniprot:P00533', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToTargets(c, m);
        expect(r.skippedParanoiaCount).toBe(0);
        expect(c[0].sid_s).toBe('a');
    });
    it('paranoia branch warn + count++', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const c = [{ id: 't1' }, { id: 't2' }];
        const m = new Map([['t1', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToTargets(c, m);
        expect(r.skippedParanoiaCount).toBe(1);
        warnSpy.mockRestore();
    });
});

describe('buildTargetStampingSummary', () => {
    it('canonical telemetry shape', () => {
        const s = buildTargetStampingSummary({
            totalTargets: 100, alreadyStamped: 20, newlyStamped: 80, unstampable: 0,
            crossPollinated: 3, stampedByUniprot: 75, stampedByEnsembl: 5,
            reservationsIssued: 1, skippedParanoiaCount: 0, elapsedMs: 100, ledgerKeys: [],
        });
        expect(s.cross_pollinated).toBe(3);
        expect(s.stamped_by_uniprot).toBe(75);
        expect(s.stamped_by_ensembl).toBe(5);
    });
});
