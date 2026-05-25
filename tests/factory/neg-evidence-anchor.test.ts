// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    NEG_EVIDENCE_TYPES, NEG_EVIDENCE_CANON_VERSIONS, NEGEVIDENCE_NAMESPACE,
    TYPE_TRIAL_FAILURE, TYPE_INACTIVE_BIOASSAY, TYPE_FAERS_ADR_SIGNAL,
    TYPE_DRUG_WITHDRAWAL, TYPE_BLACK_BOX_WARNING, TYPE_SERIOUS_AE_PER_TRIAL,
    TYPE_PAPER_RETRACTION,
    parseNegIdTail, buildNegAnchorPayload,
} from '../../src/lib/schemas/neg-evidence-types.js';

describe('NEG_EVIDENCE_CANON_VERSIONS — 7 canon-versions Plan A1 lock', () => {
    it('has exactly 7 entries (1 per evidence_type)', () => {
        expect(Object.keys(NEG_EVIDENCE_CANON_VERSIONS).length).toBe(7);
        expect(Object.keys(NEG_EVIDENCE_CANON_VERSIONS).sort()).toEqual([...NEG_EVIDENCE_TYPES].sort());
    });
    it('each canon-version matches negevidence.<type>.v1.0 format', () => {
        for (const [type, canon] of Object.entries(NEG_EVIDENCE_CANON_VERSIONS)) {
            expect(canon).toBe(`negevidence.${type}.v1.0`);
        }
    });
    it('NEGEVIDENCE_NAMESPACE = negevidence', () => {
        expect(NEGEVIDENCE_NAMESPACE).toBe('negevidence');
    });
});

describe('parseNegIdTail — tail-cleaning state machine (architect-locked)', () => {
    it('production samples — one per evidence_type', () => {
        expect(parseNegIdTail('sciweon::neg::bioassay::CHEMBL_ACT_22084310')).toBe('bioassay:chembl_act_22084310');
        expect(parseNegIdTail('sciweon::neg::faers::CID:5002::toxicity_to_various_agents')).toBe('faers:cid:5002:toxicity_to_various_agents');
        expect(parseNegIdTail('sciweon::neg::withdrawn::CID:237')).toBe('withdrawn:cid:237');
        expect(parseNegIdTail('sciweon::neg::boxed::CID:5002')).toBe('boxed:cid:5002');
        expect(parseNegIdTail('sciweon::neg::ae::NCT00683618')).toBe('ae:nct00683618');
        expect(parseNegIdTail('sciweon::neg::trial::NCT03952598')).toBe('trial:nct03952598');
        expect(parseNegIdTail('sciweon::neg::retraction::10.1016_s0140_6736_20_32656_8')).toBe('retraction:10.1016_s0140_6736_20_32656_8');
    });

    it('faers double-suffix preserved as single-colon-separated triple', () => {
        const result = parseNegIdTail('sciweon::neg::faers::CID:5002::toxicity_to_various_agents');
        expect(result).toBe('faers:cid:5002:toxicity_to_various_agents');
        expect(result).not.toContain('::');
    });

    it('lowercase enforcement', () => {
        expect(parseNegIdTail('sciweon::neg::TRIAL::NCT99999')).toBe('trial:nct99999');
    });

    it('rejects null / non-string / wrong prefix / empty / non-ASCII', () => {
        expect(parseNegIdTail(null)).toBeNull();
        expect(parseNegIdTail(undefined)).toBeNull();
        expect(parseNegIdTail(42)).toBeNull();
        expect(parseNegIdTail('sciweon::compound::CID:5')).toBeNull();
        expect(parseNegIdTail('sciweon::neg::')).toBeNull();
        // Non-ASCII rejection (mojibake guard): use Latin-Extended chars stored via
        // hex codepoints so the source file itself stays pure ASCII per CES Art 8.1.
        expect(parseNegIdTail('sciweon::neg::trial::' + String.fromCharCode(0x00e9, 0x00fc) + 'NCT99999')).toBeNull();
    });
});

describe('buildNegAnchorPayload — 3-field triple per Plan A1', () => {
    function rec(type, id) { return { id, evidence_type: type }; }

    it('inactive_bioassay → correct triple', () => {
        const r = buildNegAnchorPayload(rec(TYPE_INACTIVE_BIOASSAY, 'sciweon::neg::bioassay::CHEMBL_ACT_22084310'));
        expect(r).toEqual({
            namespace: 'negevidence',
            anchor_payload: 'bioassay:chembl_act_22084310',
            canonicalization_version: 'negevidence.inactive_bioassay.v1.0',
        });
    });

    it('faers_adr_signal → double-suffix triple', () => {
        const r = buildNegAnchorPayload(rec(TYPE_FAERS_ADR_SIGNAL, 'sciweon::neg::faers::CID:5002::toxicity_to_various_agents'));
        expect(r.anchor_payload).toBe('faers:cid:5002:toxicity_to_various_agents');
        expect(r.canonicalization_version).toBe('negevidence.faers_adr_signal.v1.0');
    });

    it('all 7 evidence_types produce non-null triples for canonical samples', () => {
        const cases = [
            [TYPE_TRIAL_FAILURE, 'sciweon::neg::trial::NCT99999'],
            [TYPE_INACTIVE_BIOASSAY, 'sciweon::neg::bioassay::1234'],
            [TYPE_DRUG_WITHDRAWAL, 'sciweon::neg::withdrawn::CID:1'],
            [TYPE_BLACK_BOX_WARNING, 'sciweon::neg::boxed::CID:2'],
            [TYPE_FAERS_ADR_SIGNAL, 'sciweon::neg::faers::CID:3::headache'],
            [TYPE_SERIOUS_AE_PER_TRIAL, 'sciweon::neg::ae::NCT11111'],
            [TYPE_PAPER_RETRACTION, 'sciweon::neg::retraction::10.1/abc'],
        ];
        for (const [type, id] of cases) {
            const r = buildNegAnchorPayload(rec(type, id));
            expect(r).not.toBeNull();
            expect(r.namespace).toBe('negevidence');
            expect(r.canonicalization_version).toBe(NEG_EVIDENCE_CANON_VERSIONS[type]);
        }
    });

    it('returns null on unknown evidence_type / missing id / bad prefix', () => {
        expect(buildNegAnchorPayload(null)).toBeNull();
        expect(buildNegAnchorPayload({})).toBeNull();
        expect(buildNegAnchorPayload({ id: 'sciweon::neg::trial::X', evidence_type: 'NOT_A_TYPE' })).toBeNull();
        expect(buildNegAnchorPayload({ id: 'sciweon::compound::CID:5', evidence_type: TYPE_TRIAL_FAILURE })).toBeNull();
    });
});
