// @ts-nocheck
/**
 * PR-UMLS-4b LOINC cross-link tests (network-free; NO real LOINC strings -- SYNTHETIC
 * placeholder tokens ONLY).
 *
 * Locks: the PUBLIC link itemShape = { loinc_sid, confidence, match_method } (no cui/code/str);
 * the deterministic Token-Set Jaccard math; the <=2 token filter; the ANCHOR guardrail (primary
 * outcome titles, NOT conditions -- category-error protection); the cross-link policy (ALL links
 * published incl low-confidence -- the ONLY floor is Jaccard > 0, nothing withheld); the PR
 * discipline (no_match bucketed not thrown, idempotent byte-identical re-run, HALT on 0 concepts).
 */

import { describe, it, expect } from 'vitest';
import {
    tokenize, jaccard,
    buildLoincTokenIndex, resolveOutcomeTitle,
    buildLoincLinksForTrial, enrichTrialsWithLoincLinks,
    assertLoincConceptsLoaded, emptyLoincTelemetry,
    MATCH_TOKEN_SET_JACCARD,
} from '../../scripts/factory/lib/loinc-crosslink-helpers.js';

// FULL stamped internal LOINC concept (preferred_str/synonyms are SYNTHETIC placeholder tokens
// -- NO real LOINC strings). The token index reads these; the links must NEVER carry them.
function concept(overrides = {}) {
    return {
        code: 'L0001', cui: 'C0009999', sab: 'LNC', tty: 'LN',
        preferred_str: 'alpha beta gamma', synonyms: [],
        anchor_payload: 'LNC:L0001', canonicalization_version: 'loinc.concept.v1.0',
        sid_s: 'sid-alpha-0001', sid_c: 'sidc-alpha-0001',
        ...overrides,
    };
}

const LINK_KEYS = ['confidence', 'loinc_sid', 'match_method'];

function assertPublicLinkShape(link) {
    expect(Object.keys(link).sort()).toEqual(LINK_KEYS);
    expect(typeof link.loinc_sid).toBe('string');
    expect(typeof link.confidence).toBe('number');
    expect(link.match_method).toBe(MATCH_TOKEN_SET_JACCARD);
    // ZERO NLM/LOINC content -- cui MUST be absent (scan the keys).
    for (const k of ['cui', 'code', 'str', 'preferred_str', 'synonyms']) {
        expect(Object.prototype.hasOwnProperty.call(link, k)).toBe(false);
    }
}

describe('tokenizer -- lowercase, split non-alnum, drop tokens of length <= 2', () => {
    it('drops short tokens (<=2) and dedups into a Set', () => {
        const toks = tokenize('Hemoglobin A1c at of in by HB');
        expect(toks.has('hemoglobin')).toBe(true);
        expect(toks.has('a1c')).toBe(true);
        // <=2 chars dropped: "at","of","in","by","hb" all length 2
        expect(toks.has('at')).toBe(false);
        expect(toks.has('of')).toBe(false);
        expect(toks.has('in')).toBe(false);
        expect(toks.has('by')).toBe(false);
        expect(toks.has('hb')).toBe(false);
    });
    it('non-string -> empty set', () => {
        expect(tokenize(undefined).size).toBe(0);
        expect(tokenize(null).size).toBe(0);
        expect(tokenize(42).size).toBe(0);
    });
});

describe('jaccard -- hand-computed example', () => {
    it('{alpha,beta,gamma} vs {beta,gamma,delta} -> |int|=2 |union|=4 -> 0.5', () => {
        const a = new Set(['alpha', 'beta', 'gamma']);
        const b = new Set(['beta', 'gamma', 'delta']);
        expect(jaccard(a, b)).toBe(0.5);
    });
    it('rounds to 2 decimals; identical sets -> 1; disjoint -> 0; empty -> 0', () => {
        // {a,b,c} vs {a} -> 1/3 -> 0.33
        expect(jaccard(new Set(['aaa', 'bbb', 'ccc']), new Set(['aaa']))).toBe(0.33);
        expect(jaccard(new Set(['aaa', 'bbb']), new Set(['aaa', 'bbb']))).toBe(1);
        expect(jaccard(new Set(['aaa']), new Set(['zzz']))).toBe(0);
        expect(jaccard(new Set(), new Set(['aaa']))).toBe(0);
    });
});

describe('index builder + resolve -- PUBLIC shape + cui ABSENT', () => {
    it('builds the inverted index; un-stamped concept skipped + counted', () => {
        const { index, missingSid } = buildLoincTokenIndex([
            concept(),
            concept({ code: 'X', sid_s: undefined }),
        ]);
        expect(index.size).toBeGreaterThan(0);
        expect(index.has('alpha')).toBe(true);
        expect(missingSid).toBe(1);
    });

    it('resolves an outcome title to the EXACT public link {loinc_sid,confidence,match_method}; cui ABSENT', () => {
        const { index } = buildLoincTokenIndex([concept()]); // preferred_str 'alpha beta gamma'
        const link = resolveOutcomeTitle('alpha beta gamma', index); // identical token set -> 1.0
        expect(link).not.toBeNull();
        assertPublicLinkShape(link);
        expect(link.loinc_sid).toBe('sid-alpha-0001');
        expect(link.confidence).toBe(1);
    });

    it('no shared token -> Jaccard 0 -> null (no link)', () => {
        const { index } = buildLoincTokenIndex([concept()]);
        expect(resolveOutcomeTitle('zzz9 yyy8 www7', index)).toBeNull();
    });

    it('synonym tokens are unioned into the concept token set (documented recall choice)', () => {
        const { index } = buildLoincTokenIndex([
            concept({ preferred_str: 'alpha', synonyms: ['delta epsilon'] }),
        ]);
        // 'delta' arrives only via the synonym; a title of 'delta epsilon' must resolve.
        const link = resolveOutcomeTitle('delta epsilon', index);
        expect(link).not.toBeNull();
        expect(link.loinc_sid).toBe('sid-alpha-0001');
    });
});

describe('deterministic tie-break -- lowest sid_s lexicographically wins on equal Jaccard', () => {
    it('two concepts with identical tokens -> the lexicographically-lower sid_s wins', () => {
        const { index } = buildLoincTokenIndex([
            concept({ sid_s: 'sid-zzz', preferred_str: 'alpha beta gamma' }),
            concept({ sid_s: 'sid-aaa', preferred_str: 'alpha beta gamma' }),
        ]);
        const link = resolveOutcomeTitle('alpha beta gamma', index);
        expect(link.loinc_sid).toBe('sid-aaa'); // lower lexicographically, regardless of insert order
    });
});

describe('ANCHOR guardrail -- primary_outcomes[].title ONLY, NOT conditions (category error)', () => {
    it('a conditions value that WOULD match a concept produces NO link; only the outcome title links', () => {
        // The concept tokens are {alpha,beta,gamma}. The trial.conditions WOULD overlap, but the
        // enricher must NEVER anchor on conditions (disease axis = SNOMED). Only the primary
        // outcome title is the anchor.
        const { index } = buildLoincTokenIndex([concept()]);
        const tel = emptyLoincTelemetry();
        const trial = {
            conditions: ['alpha beta gamma'], // WOULD match if (wrongly) anchored -- must be ignored
            results: { primary_outcomes: [{ title: 'alpha beta gamma' }] }, // the ONLY anchor
        };
        const links = buildLoincLinksForTrial(trial, index, tel);
        expect(links).toHaveLength(1); // exactly one link, from the OUTCOME title
        expect(tel.terms_total).toBe(1); // only the outcome title was counted as a term
        assertPublicLinkShape(links[0]);
    });

    it('a trial with a matching condition but NO primary outcomes yields ZERO links', () => {
        const { index } = buildLoincTokenIndex([concept()]);
        const tel = emptyLoincTelemetry();
        const trial = { conditions: ['alpha beta gamma'], results: { primary_outcomes: [] } };
        const links = buildLoincLinksForTrial(trial, index, tel);
        expect(links).toHaveLength(0);
        expect(tel.terms_total).toBe(0);
    });
});

describe('cross-link policy -- LOW-confidence Jaccard link IS published (NOT withheld)', () => {
    it('a small Jaccard (e.g. 0.2) link is present, not dropped by any threshold', () => {
        // title {alpha,beta,gamma,delta,epsilon} vs concept {alpha} -> |int|=1 |union|=5 -> 0.2
        const { index } = buildLoincTokenIndex([concept({ preferred_str: 'alpha', synonyms: [] })]);
        const link = resolveOutcomeTitle('alpha beta gamma delta epsilon', index);
        expect(link).not.toBeNull();
        expect(link.confidence).toBe(0.2); // LOW -- but PUBLISHED, not withheld
        assertPublicLinkShape(link);
    });
});

describe('no-match -> bucketed (not thrown, not dropped)', () => {
    it('an unresolved outcome title is counted in no_match with a sample', () => {
        const { index } = buildLoincTokenIndex([concept()]);
        const tel = emptyLoincTelemetry();
        const trial = { results: { primary_outcomes: [{ title: 'zzz9 yyy8 www7' }] } };
        const links = buildLoincLinksForTrial(trial, index, tel);
        expect(links).toHaveLength(0);
        expect(tel.no_match).toBe(1);
        expect(tel.no_match_samples[0]).toContain('title:zzz9 yyy8 www7');
        expect(tel.jaccard_hits).toBe(0);
    });
});

describe('enrichTrialsWithLoincLinks -- telemetry + idempotent OVERWRITE + byte-identical re-run', () => {
    it('attaches trial.loinc_links; ALL links published; sid_s/sid_c untouched', () => {
        const concepts = [concept()];
        const trials = [{
            id: 't1', sid_s: 'T_SID_S', sid_c: 'T_SID_C',
            results: { primary_outcomes: [{ title: 'alpha beta gamma' }] },
        }];
        const tel = enrichTrialsWithLoincLinks(trials, concepts);
        expect(tel.trials_processed).toBe(1);
        expect(tel.jaccard_hits).toBe(1);
        expect(trials[0].loinc_links).toHaveLength(1);
        assertPublicLinkShape(trials[0].loinc_links[0]);
        expect(trials[0].sid_s).toBe('T_SID_S');
        expect(trials[0].sid_c).toBe('T_SID_C');
    });

    it('determinism -- running twice yields BYTE-IDENTICAL loinc_links', () => {
        const concepts = [
            concept({ sid_s: 'sid-zzz', preferred_str: 'alpha beta gamma' }),
            concept({ sid_s: 'sid-aaa', preferred_str: 'alpha beta gamma' }),
        ];
        const mk = () => [{ id: 't1', results: { primary_outcomes: [{ title: 'alpha beta gamma delta' }] } }];
        const a = mk(); enrichTrialsWithLoincLinks(a, concepts);
        const b = mk(); enrichTrialsWithLoincLinks(b, concepts);
        expect(JSON.stringify(a[0].loinc_links)).toBe(JSON.stringify(b[0].loinc_links));

        // also idempotent within a single record array (overwrite, no append-duplicate)
        const firstSerialized = JSON.stringify(a[0].loinc_links);
        enrichTrialsWithLoincLinks(a, concepts); // re-run on same array
        expect(JSON.stringify(a[0].loinc_links)).toBe(firstSerialized);
    });
});

describe('HALT -- 0 concepts loaded throws (no silent zero-out)', () => {
    it('assertLoincConceptsLoaded throws on empty / non-array', () => {
        expect(() => assertLoincConceptsLoaded([])).toThrow(/HALT: 0 LOINC concepts/);
        expect(() => assertLoincConceptsLoaded(undefined)).toThrow(/HALT: 0 LOINC concepts/);
        expect(() => assertLoincConceptsLoaded([concept()])).not.toThrow();
    });
});
