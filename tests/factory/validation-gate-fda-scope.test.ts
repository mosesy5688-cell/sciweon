// @ts-nocheck
/**
 * PR-T1.1a R1 (THE KEYSTONE -- RESILIENCE FIRST): scope-tier fail-soft for the
 * fda_signals.* preserve-all fields.
 *
 * Before R1, fda_signals.* classified `primary` -> a single over-cap field
 * THREW in REJECT mode (validation-gate) via the per-record gate in
 * cross-source-linker -> HALTED the entire F3 chain for ALL records over ONE
 * fat field. R1 adds SCOPE_VIOLATION_RULES so an OVERFLOW (items > maxItems /
 * length > maxLength) on these fields FAILS SOFT (skip + telemetry the ONE
 * record), never throws/halts. A missing/typed/pattern violation on the same
 * field is still a primary halt (errorPattern is narrow).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { gate, setMode, MODE_REJECT } from '../../scripts/factory/lib/validation-gate.js';
import { COMPOUND_SCHEMA } from '../../src/lib/schemas/compound.js';
import { NEG_EVIDENCE_SCHEMA } from '../../src/lib/schemas/neg-evidence.js';

beforeAll(() => setMode(MODE_REJECT));

// Minimal valid compound skeleton (satisfies COMPOUND_SCHEMA required fields)
// so we can attach a single over-cap fda_signals field in isolation.
function baseCompound() {
    const now = new Date().toISOString();
    return {
        id: 'sciweon::compound::CID:1',
        inchi_key: 'AAAAAAAAAAAAAA-BBBBBBBBBB-N',
        smiles_canonical: 'C',
        inchi: 'InChI=1S/CH4/h1H4',
        molecular_formula: 'CH4',
        molecular_weight: { value: 16, unit: 'Da' },
        provenance: {
            sources: [{ source: 'pubchem', source_id: '1', timestamp: now, extraction_method: 'm' }],
            last_updated: now,
        },
        confidence: {
            overall: 70, structural: 70, bioactivity: 0, clinical: 0,
            method: 'cross_source_consensus_v2',
            cross_source_agreement: { structural_match: true, conflicts: [] },
        },
    };
}

describe('R1 scope-tier fail-soft: fda_signals overflow excludes, never throws', () => {
    const overCapCases = [
        ['faers_top_adr_terms over maxItems',
            { faers_top_adr_terms: Array.from({ length: 1001 }, () => ({ term: 'T', count: 1 })) },
            'oversized_faers_top_adr_terms'],
        ['faers term over per-item maxLength',
            { faers_top_adr_terms: [{ term: 'x'.repeat(2001), count: 1 }] },
            'oversized_faers_adr_term'],
        ['application_numbers over maxItems',
            { application_numbers: Array.from({ length: 201 }, (_, i) => `A${i}`) },
            'oversized_application_numbers'],
        ['pharm_class_epc over maxItems',
            { pharm_class_epc: Array.from({ length: 101 }, (_, i) => `E${i}`) },
            'oversized_pharm_class_epc'],
        ['pharm_class_moa over maxItems',
            { pharm_class_moa: Array.from({ length: 101 }, (_, i) => `M${i}`) },
            'oversized_pharm_class_moa'],
        ['boxed_warning_text over maxLength',
            { boxed_warning_text: 'x'.repeat(40001) },
            'oversized_boxed_warning_text'],
        ['boxed_warnings over maxItems',
            { boxed_warnings: Array.from({ length: 51 }, () => ({ text: 'w' })) },
            'oversized_boxed_warnings'],
        ['boxed_warnings item text over maxLength',
            { boxed_warnings: [{ text: 'x'.repeat(40001) }] },
            'oversized_boxed_warning_item'],
    ];

    for (const [name, fdaSig, reason] of overCapCases) {
        it(`${name} -> excluded (no throw)`, () => {
            const c = baseCompound();
            c.fda_signals = fdaSig;
            let r;
            expect(() => { r = gate(c, COMPOUND_SCHEMA, c.id); }).not.toThrow();
            expect(r.passed).toBe(false);
            expect(r.excluded).toBe(true);
            expect(r.exclusion_reason).toBe(reason);
        });
    }

    it('neg-evidence reason_text overflow -> excluded (no throw)', () => {
        const now = new Date().toISOString();
        const neg = {
            id: 'sciweon::neg::boxed::CID:1',
            evidence_type: 'black_box_warning',
            subject: { compound_id: 'sciweon::compound::CID:1' },
            failure: {
                reason_text: 'x'.repeat(40001),
                extraction_method: 'fda_label_section',
            },
            observed_date: now,
            severity: 'critical',
            confidence: { overall: 100, method: 'negative_evidence_v1' },
            provenance: {
                primary_source: 'openfda_drug_label', source_id: 'x',
                extraction_timestamp: now,
            },
        };
        let r;
        expect(() => { r = gate(neg, NEG_EVIDENCE_SCHEMA, neg.id); }).not.toThrow();
        expect(r.passed).toBe(false);
        expect(r.excluded).toBe(true);
        expect(r.exclusion_reason).toBe('oversized_reason_text');
    });

    it('ANTI-REGRESSION: one over-cap record excluded, siblings pass (no batch halt)', () => {
        const records = [
            baseCompound(),
            (() => { const c = baseCompound(); c.id = 'sciweon::compound::CID:2'; c.fda_signals = { boxed_warning_text: 'x'.repeat(40001) }; return c; })(),
            (() => { const c = baseCompound(); c.id = 'sciweon::compound::CID:3'; return c; })(),
        ];
        let passed = 0; let excluded = 0;
        for (const c of records) {
            const r = gate(c, COMPOUND_SCHEMA, c.id);   // must NEVER throw
            if (r.excluded) excluded++;
            else if (r.passed) passed++;
        }
        expect(passed).toBe(2);
        expect(excluded).toBe(1);
    });

    it('in-cap fda_signals passes (legitimate large data kept, not skipped)', () => {
        const c = baseCompound();
        c.fda_signals = {
            faers_top_adr_terms: Array.from({ length: 1000 }, () => ({ term: 'x'.repeat(2000), count: 1 })),
            application_numbers: Array.from({ length: 200 }, (_, i) => `A${i}`),
            pharm_class_epc: Array.from({ length: 100 }, (_, i) => `E${i}`),
            boxed_warning_text: 'x'.repeat(40000),
            boxed_warnings: Array.from({ length: 50 }, () => ({ text: 'x'.repeat(40000) })),
        };
        const r = gate(c, COMPOUND_SCHEMA, c.id);
        expect(r.passed).toBe(true);
        expect(r.excluded).toBeUndefined();
    });

    it('a PRIMARY violation co-present still HALTS (scope is narrow to overflow)', () => {
        const c = baseCompound();
        c.inchi_key = 'BADKEY';   // pattern mismatch = primary
        c.fda_signals = { boxed_warning_text: 'x'.repeat(40001) };  // also scope
        expect(() => gate(c, COMPOUND_SCHEMA, c.id)).toThrow(/primary violations/);
    });
});
