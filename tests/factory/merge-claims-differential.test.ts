// @ts-nocheck
/**
 * LANE3 tests 1, 12, 14 and 17.
 *
 * Winner invariance is the load-bearing property of this lane: the wrapper
 * calls deepMergeCompound FIRST and then touches only the six new top-level
 * keys, so which value wins any merge cannot change. The differential strips
 * the six keys from BOTH sides before comparing -- the unmodified function
 * inherits them through its shallow spread whenever `prev` already carries
 * them, so stripping only the wrapper's output would fail on a CORRECT
 * implementation.
 *
 * Merged records are serialised with JSON.stringify to JSONL, so key
 * insertion order is byte-significant: canonical-string identity and key-order
 * identity are asserted as well as deep equality.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deepMergeCompound } from '../../scripts/factory/lib/aggregated-deep-merge.js';
import { mergeCompoundWithClaims } from '../../scripts/factory/lib/merge-claims-wrapper.js';
import {
    MERGE_FILES, KEY_FN_PER_FILE, MERGE_STRATEGY_PER_FILE,
} from '../../scripts/factory/lib/aggregated-merger.js';
import { recoveryMergeCompoundRecords } from '../../scripts/factory/recovery-merge-all.js';

const SIX_KEYS = [
    'competing_claims', 'preserved_against_null', 'field_sources',
    'claim_set_state', 'claim_overflow_fields', 'claim_overflow_counts',
];

const PATHS = ['inchi_key', 'smiles_canonical', 'molecular_formula', 'iupac_name'];

const RECOVERY_SRC = readFileSync(
    new URL('../../scripts/factory/recovery-merge-all.js', import.meta.url), 'utf-8');

// Structure-preserving clone: unlike JSON round-tripping it KEEPS a key whose
// value is an explicit undefined, which several corpus cases depend on.
function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) out[k] = clone(v[k]);
        return out;
    }
    return v;
}

function strip(rec) {
    if (!rec || typeof rec !== 'object') return rec;
    const out = { ...rec };
    for (const k of SIX_KEYS) delete out[k];
    return out;
}

function base(extra = {}) {
    return {
        id: 'sciweon::compound::CID:2244',
        pubchem_cid: 2244,
        inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
        smiles_canonical: 'CC(=O)OC1=CC=CC=C1C(=O)O',
        molecular_formula: 'C9H8O4',
        iupac_name: '2-acetyloxybenzoic acid',
        external_ids: { unii: 'R16CO5Y76E', sources: ['unichem'] },
        ...extra,
    };
}

function withoutFormula() {
    const r = base();
    delete r.molecular_formula;
    return r;
}

function withSixKeys() {
    return base({
        competing_claims: [{
            path: 'molecular_formula', value: 'C9H8O5', side: 'previous',
            source: { source: null, status: 'unknown' },
        }],
        preserved_against_null: [{ path: 'inchi_key', value: 'OLDKEYAAAAAAAA-UHFFFAOYSA-N' }],
        field_sources: { molecular_formula: { source: null, status: 'unknown' } },
        claim_set_state: 'CLAIM_SET_INCOMPLETE_OVERFLOW',
        claim_overflow_fields: ['iupac_name'],
        claim_overflow_counts: { iupac_name: 2 },
    });
}

const CORPUS = [
    ['both sides populated and equal', base(), base()],
    ['both populated and different', base(), base({ molecular_formula: 'C9H8O5', iupac_name: 'other' })],
    ['incoming null on every path', base(), base({
        inchi_key: null, smiles_canonical: null, molecular_formula: null, iupac_name: null,
    })],
    ['incoming empty string on every path', base(), base({
        inchi_key: '', smiles_canonical: '', molecular_formula: '', iupac_name: '',
    })],
    ['incoming explicit undefined on every path', base(), base({
        inchi_key: undefined, smiles_canonical: undefined,
        molecular_formula: undefined, iupac_name: undefined,
    })],
    ['previous null', base({ molecular_formula: null }), base()],
    ['both null', base({ molecular_formula: null }), base({ molecular_formula: null })],
    ['key missing on the current side', base(), withoutFormula()],
    ['keys present only on prev', base(), withoutFormula()],
    ['key missing on the previous side', withoutFormula(), base()],
    ['current carries the key with an explicit undefined', base(), base({ molecular_formula: undefined })],
    ['prev carries all six keys from a prior cycle, current none', withSixKeys(), base()],
];

for (const p of PATHS) {
    CORPUS.push([`E-1 split: incoming null on ${p}`, base(), base({ [p]: null })]);
}

describe('LANE3 4a: winner invariance and key order', () => {
    for (const [name, prev, current] of CORPUS) {
        it(`leaves every winner and the key order untouched -- ${name}`, () => {
            const unwrapped = deepMergeCompound(clone(prev), clone(current));
            const wrapped = mergeCompoundWithClaims(clone(prev), clone(current), {});
            expect(strip(wrapped)).toEqual(strip(unwrapped));
            expect(Object.keys(strip(wrapped))).toEqual(Object.keys(strip(unwrapped)));
            expect(JSON.stringify(strip(wrapped))).toBe(JSON.stringify(strip(unwrapped)));
        });
    }

    it('returns the other input BY IDENTITY when either side is absent (4b)', () => {
        const rec = base();
        expect(mergeCompoundWithClaims(null, rec, {})).toBe(rec);
        expect(mergeCompoundWithClaims(rec, null, {})).toBe(rec);
        expect(rec.competing_claims).toBeUndefined();
        expect(rec.preserved_against_null).toBeUndefined();
    });

    it('mutates neither input record (test 14)', () => {
        const prev = base();
        const current = base({ molecular_formula: null, iupac_name: null });
        const prevJson = JSON.stringify(prev);
        const currentJson = JSON.stringify(current);
        const merged = mergeCompoundWithClaims(prev, current, {});
        expect(merged.competing_claims).toHaveLength(2);
        expect(JSON.stringify(prev)).toBe(prevJson);
        expect(JSON.stringify(current)).toBe(currentJson);
    });

    it('never writes confidence.cross_source_agreement.conflicts (test 12)', () => {
        const conflicts = [{ field: 'molecular_formula', note: 'pre-existing scorer input' }];
        const prev = base({ confidence: { score: 0.5, cross_source_agreement: { conflicts } } });
        const current = base({ molecular_formula: null, iupac_name: null });
        const unwrapped = deepMergeCompound(clone(prev), clone(current));
        const wrapped = mergeCompoundWithClaims(clone(prev), clone(current), {});
        expect(JSON.stringify(wrapped.confidence)).toBe(JSON.stringify(unwrapped.confidence));
        expect(wrapped.confidence.cross_source_agreement.conflicts).toEqual(conflicts);
    });
});

describe('LANE3 0a / F-2: the recovery path (test 17)', () => {
    it('importing the module does not execute main()', () => {
        // Runtime proof: if main() ran at import, makeClient() would throw with
        // R2 env unset and the top-level .catch would call process.exit(1),
        // killing this vitest worker before any assertion ran. Reaching this
        // line is the symptom-level proof; the static assertions below prove
        // the guard itself rather than only its absence of symptom.
        expect(typeof recoveryMergeCompoundRecords).toBe('function');
        expect(/^main\(\)\.catch/m.test(RECOVERY_SRC)).toBe(false);
        expect(RECOVERY_SRC).toContain('import.meta.url === invokedPath');
        expect(RECOVERY_SRC).toContain('pathToFileURL(process.argv[1]).href');
    });

    it('wires the compound axis explicitly and leaves the drug-label axis alone', () => {
        // The natural one-line wiring MERGE_STRATEGY_PER_FILE[fname] would also
        // activate the drug-label strategy, which section 7 forbids.
        expect(RECOVERY_SRC).toContain('fname === COMPOUND_FILE');
        // Checked against CODE only: the doc comment deliberately quotes the
        // forbidden wiring, so a naive substring check would match the warning.
        const NL = String.fromCharCode(10);
        const code = RECOVERY_SRC.split(NL).filter((l) => {
            const t = l.trim();
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        }).join(NL);
        expect(code).not.toContain('MERGE_STRATEGY_PER_FILE[fname]');
        expect(Object.keys(MERGE_STRATEGY_PER_FILE).sort()).toEqual([
            'compounds-enriched.jsonl', 'drug-labels.jsonl',
        ]);
    });

    it('no longer replaces a claims-bearing record wholesale', () => {
        const accumulated = [base()];
        const run = [base({
            inchi_key: null, smiles_canonical: null,
            molecular_formula: null, iupac_name: null,
        })];
        const { merged } = recoveryMergeCompoundRecords(run, accumulated);
        expect(merged).toHaveLength(1);
        expect(merged[0].competing_claims.map(c => c.path).sort())
            .toEqual(['iupac_name', 'molecular_formula']);
        expect(merged[0].preserved_against_null.map(p => p.path).sort())
            .toEqual(['inchi_key', 'smiles_canonical']);
    });

    it('records the PRE-EXISTING key-function defect without fixing it', () => {
        // 0a: the merged-file list carries one entry the key map lacks and the
        // key function is resolved WITHOUT a fallback. The throw is CONDITIONAL
        // -- the loop continues on a missing object and the key function is only
        // invoked for a non-empty record list, so it fires only when a historical
        // bundle actually holds a non-empty drug-labels file. The compound file
        // is first in the list, so the compound strategy is reached before any
        // such throw. REPORTED, NOT FIXED.
        expect(MERGE_FILES).toContain('drug-labels.jsonl');
        expect(KEY_FN_PER_FILE['drug-labels.jsonl']).toBeUndefined();
        expect(MERGE_FILES.indexOf('compounds-enriched.jsonl')).toBe(0);
    });
});
