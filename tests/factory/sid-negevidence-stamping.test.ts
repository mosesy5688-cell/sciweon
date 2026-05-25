// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import {
    NEGEVIDENCE_ENTITY_CLASS, NAMESPACE_SCIWEON_NEG, SAL_ANCHOR_DISPLAY_PREFIX,
    SAL_PAYLOAD_PREFIX, UNSTAMPABLE_REASON_MISSING_ANCHOR_AFTER_BACKFILL,
    NEG_EVIDENCE_CANON_VERSIONS, NEGEVIDENCE_NAMESPACE,
    canonicalSerializePayload, computeNegDeterministicUuid,
    ensureAnchorMetadata, classifyNegEvidences, buildNegStampingEntries,
    applyStampsToNegEvidences, buildPerCanonVersionCounts, buildNegEvidenceStampingSummary,
} from '../../scripts/factory/lib/sid-negevidence-stamping.js';
import { generateSID_S, generateSID_C } from '../../scripts/factory/lib/sid-generator.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';
import { NAMESPACE_SCIWEON_SAL } from '../../scripts/factory/lib/sid-sal-stamping.js';

// 7 frozen pins -- execution-gate verified 2026-05-25 + production-anchored from
// F3 run 26399491661 neg-evidence.jsonl sampling. Tail-cleaning applied.
const FROZEN_PINS = [
    { evType: 'inactive_bioassay', id: 'sciweon::neg::bioassay::CHEMBL_ACT_22084310',
      canon: 'negevidence.inactive_bioassay.v1.0', tail: 'bioassay:chembl_act_22084310',
      sidS: '9dc0e97434a4f19eb89c8a649897c404' },
    { evType: 'faers_adr_signal', id: 'sciweon::neg::faers::CID:5002::toxicity_to_various_agents',
      canon: 'negevidence.faers_adr_signal.v1.0', tail: 'faers:cid:5002:toxicity_to_various_agents',
      sidS: '232818ad2c121561e09677028306a448' },
    { evType: 'drug_withdrawal', id: 'sciweon::neg::withdrawn::CID:237',
      canon: 'negevidence.drug_withdrawal.v1.0', tail: 'withdrawn:cid:237',
      sidS: 'a3c2836c03e789b42fdf1dc4673fa47a' },
    { evType: 'black_box_warning', id: 'sciweon::neg::boxed::CID:5002',
      canon: 'negevidence.black_box_warning.v1.0', tail: 'boxed:cid:5002',
      sidS: 'e3676c609175e4c4adbdf0e1d71cbc0a' },
    { evType: 'serious_adverse_event_per_trial', id: 'sciweon::neg::ae::NCT00683618',
      canon: 'negevidence.serious_adverse_event_per_trial.v1.0', tail: 'ae:nct00683618',
      sidS: 'ab0a46f5e05179dd942921f4d325d8f0' },
    { evType: 'trial_failure', id: 'sciweon::neg::trial::NCT03952598',
      canon: 'negevidence.trial_failure.v1.0', tail: 'trial:nct03952598',
      sidS: '5e023e65cd57c8ed89848331b927e298' },
    { evType: 'paper_retraction', id: 'sciweon::neg::retraction::10.1016_s0140_6736_20_32656_8',
      canon: 'negevidence.paper_retraction.v1.0', tail: 'retraction:10.1016_s0140_6736_20_32656_8',
      sidS: '68ff89d770599067fa6bdc9d4f2b2487' },
];

describe('NAMESPACE locks -- execution-gate verified 2026-05-25', () => {
    it('NAMESPACE_SCIWEON_NEG pinned to 1b2729f6-2056-59a4-9ca6-3aed64ca2824', () => {
        expect(NAMESPACE_SCIWEON_NEG).toBe('1b2729f6-2056-59a4-9ca6-3aed64ca2824');
    });
    it('NAMESPACE_SCIWEON_SAL cross-PR continuity still 0032aae1-...015dd', () => {
        expect(NAMESPACE_SCIWEON_SAL).toBe('0032aae1-052d-5d09-97b1-5c5b091015dd');
    });
    it('NEG namespace version digit 5 + variant digit 9 (RFC4122)', () => {
        expect(NAMESPACE_SCIWEON_NEG.charAt(14)).toBe('5');
        expect(NAMESPACE_SCIWEON_NEG.charAt(19)).toBe('9');
    });
});

describe('Constants lock', () => {
    it('NEGEVIDENCE_ENTITY_CLASS = negevidence', () => {
        expect(NEGEVIDENCE_ENTITY_CLASS).toBe('negevidence');
    });
    it('SAL_ANCHOR_DISPLAY_PREFIX = sal:negevidence_v1:', () => {
        expect(SAL_ANCHOR_DISPLAY_PREFIX).toBe('sal:negevidence_v1:');
    });
    it('NEGEVIDENCE_NAMESPACE re-export = negevidence', () => {
        expect(NEGEVIDENCE_NAMESPACE).toBe('negevidence');
    });
    it('NEG_EVIDENCE_CANON_VERSIONS has 7 entries', () => {
        expect(Object.keys(NEG_EVIDENCE_CANON_VERSIONS).length).toBe(7);
    });
});

describe('7 frozen SID-S pins -- production-anchored', () => {
    for (const pin of FROZEN_PINS) {
        it(`${pin.evType} (${pin.id.split('::').slice(-1)[0]}) -> ${pin.sidS}`, () => {
            const payload = { evidence_type: pin.evType, clean_id_tail: pin.tail, canonicalization_version: pin.canon };
            const uuid = computeNegDeterministicUuid(payload);
            const sidS = generateSID_S(NEGEVIDENCE_ENTITY_CLASS, `${SAL_PAYLOAD_PREFIX}${uuid}`, pin.canon);
            expect(sidS).toBe(pin.sidS);
        });
    }
    it('counter=1 sid_c for negevidence pinned', () => {
        expect(generateSID_C(NEGEVIDENCE_ENTITY_CLASS, 1)).toBe('fb65ec16d601707c9b100aa72595fee3');
    });
});

describe('canonicalSerializePayload + computeNegDeterministicUuid', () => {
    it('sorted-key invariance across insertion orders', () => {
        const p1 = { evidence_type: 'trial_failure', clean_id_tail: 'trial:nct1', canonicalization_version: 'negevidence.trial_failure.v1.0' };
        const p2 = { canonicalization_version: 'negevidence.trial_failure.v1.0', clean_id_tail: 'trial:nct1', evidence_type: 'trial_failure' };
        expect(computeNegDeterministicUuid(p1)).toBe(computeNegDeterministicUuid(p2));
    });
    it('non-object payload throws', () => {
        expect(() => canonicalSerializePayload(null)).toThrow();
    });
});

describe('Gamma backfill: ensureAnchorMetadata', () => {
    it('record with pre-existing 3-field anchor -> ok + mutated=false', () => {
        const r = { id: 'sciweon::neg::trial::NCT1', evidence_type: 'trial_failure',
            namespace: 'negevidence', anchor_payload: 'trial:nct1',
            canonicalization_version: 'negevidence.trial_failure.v1.0' };
        const meta = ensureAnchorMetadata(r);
        expect(meta.ok).toBe(true);
        expect(meta.mutated).toBe(false);
    });
    it('legacy record without anchor -> backfilled + mutated=true + in-memory write-back', () => {
        const r = { id: 'sciweon::neg::trial::NCT03952598', evidence_type: 'trial_failure' };
        const meta = ensureAnchorMetadata(r);
        expect(meta.ok).toBe(true);
        expect(meta.mutated).toBe(true);
        // in-memory write-back per gamma protocol
        expect(r.namespace).toBe('negevidence');
        expect(r.anchor_payload).toBe('trial:nct03952598');
        expect(r.canonicalization_version).toBe('negevidence.trial_failure.v1.0');
    });
    it('record with unparseable id -> ok=false', () => {
        const meta = ensureAnchorMetadata({ id: 'malformed-id', evidence_type: 'trial_failure' });
        expect(meta.ok).toBe(false);
    });
});

describe('classifyNegEvidences -- gamma backfill telemetry', () => {
    const emptyIndex = buildCrosswalkIndex([]);
    it('mixed native-enriched + legacy-backfilled batch produces correct telemetry', () => {
        const records = [
            { id: 'sciweon::neg::trial::NCT_A', evidence_type: 'trial_failure',
              namespace: 'negevidence', anchor_payload: 'trial:nct_a',
              canonicalization_version: 'negevidence.trial_failure.v1.0' },
            { id: 'sciweon::neg::trial::NCT_B', evidence_type: 'trial_failure' },
            { id: 'sciweon::neg::bioassay::123', evidence_type: 'inactive_bioassay' },
        ];
        const r = classifyNegEvidences(records, emptyIndex);
        expect(r.nativelyEnriched).toBe(1);
        expect(r.legacyBackfilled).toBe(2);
        expect(r.unstamped).toHaveLength(3);
        expect(r.unstampable).toHaveLength(0);
    });
    it('unparseable record -> unstampable_after_backfill', () => {
        const r = classifyNegEvidences([{ id: 'no-prefix', evidence_type: 'trial_failure' }], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_ANCHOR_AFTER_BACKFILL);
    });
});

describe('applyStampsToNegEvidences -- adds 4 stamp fields', () => {
    it('opaque id stamping adds sid_s + sid_c + anchor + display_label', () => {
        const r = [{ id: 'sciweon::neg::trial::NCT1', evidence_type: 'trial_failure',
            provenance: { primary_source: 'clinicaltrials_gov' } }];
        const m = new Map([['sciweon::neg::trial::NCT1', { sid_s: 'a', sid_c: 'b', uuid: 'uuid-x' }]]);
        const result = applyStampsToNegEvidences(r, m);
        expect(result.skippedParanoiaCount).toBe(0);
        expect(r[0].sid_s).toBe('a');
        expect(r[0].sid_c).toBe('b');
        expect(r[0].anchor).toBe('sal:negevidence_v1:uuid-x');
        expect(r[0].display_label).toBe('[NEG_EVIDENCE:TRIAL_FAILURE] sciweon::neg::trial::NCT1 (via clinicaltrials_gov)');
    });
    it('stampMap miss -> warn + skippedParanoiaCount++', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const r = [{ id: 'a' }, { id: 'b' }];
        const result = applyStampsToNegEvidences(r, new Map([['a', { sid_s: 'x', sid_c: 'y', uuid: 'z' }]]));
        expect(result.skippedParanoiaCount).toBe(1);
        warnSpy.mockRestore();
    });
});

describe('Summary telemetry shape', () => {
    it('summary includes gamma backfill metrics + per_canon_version_counts', () => {
        const s = buildNegEvidenceStampingSummary({
            totalRecords: 111804, alreadyStamped: 0, newlyStamped: 111804, unstampable: 0,
            nativelyEnriched: 6668, legacyBackfilled: 105136,
            perCanonVersionCounts: { inactive_bioassay: 92626, faers_adr_signal: 18541 },
            reservationsIssued: 3, skippedParanoiaCount: 0,
            elapsedMs: 100, ledgerKeys: ['k1'], shardCount: 1,
        });
        expect(s.total_processed_records).toBe(111804);
        expect(s.natively_enriched_current_cycle).toBe(6668);
        expect(s.legacy_records_autonomously_backfilled).toBe(105136);
        expect(s.unstampable_after_backfill).toBe(0);
        expect(s.per_canon_version_counts.inactive_bioassay).toBe(92626);
    });
});
