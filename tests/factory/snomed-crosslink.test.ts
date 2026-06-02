// @ts-nocheck
/**
 * PR-UMLS-3 SNOMED cross-link tests (network-free; NO real SNOMED strings).
 *
 * Locks the PUBLIC link itemShape = { snomed_sid, confidence, match_method } (no cui/code/str),
 * the three resolution channels (disease code_join + cui_join, trial fuzzy_string_resolve), the
 * corrected CROSS-LINK POLICY (ALL links published incl low-confidence -- NOT withheld), and the
 * PR-2 discipline (fail-soft, idempotent overwrite, loud bucketed telemetry).
 */

import { describe, it, expect } from 'vitest';
import {
    parseDiseaseXref, normalizeSnomedString,
    buildSnomedByCode, buildSnomedByCui, buildSnomedByString,
    buildSnomedLinksForDisease, buildSnomedLinksForTrial, enrichWithSnomedLinks,
    emptySnomedTelemetry,
    MATCH_EXACT_CODE, MATCH_CUI, MATCH_FUZZY_STRING,
    CONFIDENCE_EXACT_CODE, CONFIDENCE_CUI, CONFIDENCE_FUZZY_STRING,
} from '../../scripts/factory/lib/snomed-crosslink-helpers.js';

// FULL stamped internal SNOMED concept (STR/synonyms are synthetic placeholders -- NO real
// SNOMED strings). The indices read these; the links must NEVER carry them.
function concept(overrides = {}) {
    return {
        code: '73211009', cui: 'C0011849', sab: 'SNOMEDCT_US', tty: 'PT',
        preferred_str: 'condition-placeholder', synonyms: ['syn-placeholder'],
        anchor_payload: 'SNOMEDCT_US:73211009', canonicalization_version: 'snomed.concept.v1.0',
        sid_s: 'a409595b11d0aabe31aecd559a84e04a', sid_c: '6c73f8b801ffc7d25733836ead05408b',
        ...overrides,
    };
}

const LINK_KEYS = ['confidence', 'match_method', 'snomed_sid'];

function assertPublicLinkShape(link) {
    expect(Object.keys(link).sort()).toEqual(LINK_KEYS);
    expect(typeof link.snomed_sid).toBe('string');
    expect(typeof link.confidence).toBe('number');
    expect(typeof link.match_method).toBe('string');
    // ZERO NLM/SNOMED content
    for (const k of ['cui', 'code', 'str', 'preferred_str']) {
        expect(Object.prototype.hasOwnProperty.call(link, k)).toBe(false);
    }
}

describe('parseDiseaseXref', () => {
    it('SNOMED code variants -> kind code', () => {
        expect(parseDiseaseXref('SNOMEDCT_US:80394007')).toEqual({ kind: 'code', value: '80394007' });
        expect(parseDiseaseXref('SNOMEDCT:80394007')).toEqual({ kind: 'code', value: '80394007' });
        expect(parseDiseaseXref('snomed:80394007')).toEqual({ kind: 'code', value: '80394007' });
    });
    it('UMLS CUI -> kind cui', () => {
        expect(parseDiseaseXref('UMLS:C0011849')).toEqual({ kind: 'cui', value: 'C0011849' });
    });
    it('non-SNOMED xref -> null (MONDO/EFO are not SNOMED-resolvable)', () => {
        expect(parseDiseaseXref('MONDO:0005148')).toBe(null);
        expect(parseDiseaseXref('EFO:0000400')).toBe(null);
        expect(parseDiseaseXref('garbage')).toBe(null);
    });
});

describe('index builders over FULL stamped concepts', () => {
    it('byCode / byCui / byString index stamped concepts; un-stamped skipped', () => {
        const { byCode, missingSid } = buildSnomedByCode([concept(), concept({ code: 'X', sid_s: undefined })]);
        expect(byCode.get('73211009')).toBe('a409595b11d0aabe31aecd559a84e04a');
        expect(byCode.has('X')).toBe(false);
        expect(missingSid).toBe(1);

        const { byCui } = buildSnomedByCui([concept()]);
        expect(byCui.get('C0011849')).toBe('a409595b11d0aabe31aecd559a84e04a');

        const { byString } = buildSnomedByString([concept()]);
        expect(byString.get(normalizeSnomedString('condition-placeholder'))).toBe('a409595b11d0aabe31aecd559a84e04a');
        expect(byString.get('syn-placeholder')).toBe('a409595b11d0aabe31aecd559a84e04a');
    });
});

describe('disease cross-link -- exact_code_join + cui_join (high confidence)', () => {
    it('SNOMEDCT_US:<code> db_xref -> exact_code_join confidence 1.0; PUBLIC shape', () => {
        const { byCode } = buildSnomedByCode([concept()]);
        const { byCui } = buildSnomedByCui([concept()]);
        const tel = emptySnomedTelemetry();
        const disease = { db_xrefs: ['SNOMEDCT_US:73211009', 'MONDO:0005148'] };
        const links = buildSnomedLinksForDisease(disease, { byCode, byCui }, tel);
        expect(links).toHaveLength(1);
        assertPublicLinkShape(links[0]);
        expect(links[0].match_method).toBe(MATCH_EXACT_CODE);
        expect(links[0].confidence).toBe(CONFIDENCE_EXACT_CODE);
        expect(links[0].confidence).toBe(1.0);
        expect(links[0].snomed_sid).toBe('a409595b11d0aabe31aecd559a84e04a');
        expect(tel.exact_code_join_hits).toBe(1);
    });

    it('UMLS:C<digits> db_xref -> cui_join confidence 0.95', () => {
        const { byCode } = buildSnomedByCode([concept()]);
        const { byCui } = buildSnomedByCui([concept()]);
        const tel = emptySnomedTelemetry();
        const disease = { db_xrefs: ['UMLS:C0011849'] };
        const links = buildSnomedLinksForDisease(disease, { byCode, byCui }, tel);
        expect(links).toHaveLength(1);
        assertPublicLinkShape(links[0]);
        expect(links[0].match_method).toBe(MATCH_CUI);
        expect(links[0].confidence).toBe(CONFIDENCE_CUI);
        expect(links[0].confidence).toBe(0.95);
        expect(tel.cui_join_hits).toBe(1);
    });
});

describe('trial cross-link -- fuzzy_string_resolve (LOW confidence, NOT withheld)', () => {
    it('condition string-resolves to a LOW-confidence public link that IS published', () => {
        const { byString } = buildSnomedByString([concept()]);
        const tel = emptySnomedTelemetry();
        const trial = { conditions: ['Condition-Placeholder'] }; // case-insensitive match
        const links = buildSnomedLinksForTrial(trial, { byString }, tel);
        expect(links).toHaveLength(1); // LOW confidence link is PRESENT, not withheld
        assertPublicLinkShape(links[0]);
        expect(links[0].match_method).toBe(MATCH_FUZZY_STRING);
        expect(links[0].confidence).toBe(CONFIDENCE_FUZZY_STRING);
        expect(links[0].confidence).toBe(0.4);
        expect(tel.fuzzy_string_resolve_hits).toBe(1);
    });
});

describe('no-match -> bucketed (not thrown, not dropped)', () => {
    it('unknown code + unknown cui + unknown condition are counted', () => {
        const { byCode } = buildSnomedByCode([concept()]);
        const { byCui } = buildSnomedByCui([concept()]);
        const { byString } = buildSnomedByString([concept()]);
        const tel = emptySnomedTelemetry();
        buildSnomedLinksForDisease({ db_xrefs: ['SNOMEDCT_US:000', 'UMLS:C9999999'] }, { byCode, byCui }, tel);
        buildSnomedLinksForTrial({ conditions: ['totally unknown'] }, { byString }, tel);
        expect(tel.no_match).toBe(3);
        expect(tel.no_match_samples).toContain('code:000');
        expect(tel.no_match_samples).toContain('cui:C9999999');
        expect(tel.no_match_samples).toContain('str:totally unknown');
    });
});

describe('fail-soft -- one bad xref does not abort the record', () => {
    it('a no-match code does not drop the valid cui link', () => {
        const { byCode } = buildSnomedByCode([concept()]);
        const { byCui } = buildSnomedByCui([concept()]);
        const tel = emptySnomedTelemetry();
        const links = buildSnomedLinksForDisease({ db_xrefs: ['SNOMEDCT_US:000', 'UMLS:C0011849'] }, { byCode, byCui }, tel);
        expect(links).toHaveLength(1);
        expect(links[0].match_method).toBe(MATCH_CUI);
        expect(tel.no_match).toBe(1);
        expect(tel.cui_join_hits).toBe(1);
    });
});

describe('enrichWithSnomedLinks -- telemetry + idempotent overwrite + ALL links published', () => {
    it('attaches disease + trial snomed_links; high AND low confidence BOTH present', () => {
        const concepts = [concept()];
        const diseases = [{ id: 'd1', db_xrefs: ['SNOMEDCT_US:73211009'] }];
        const trials = [{ id: 't1', conditions: ['condition-placeholder'] }];
        const tel = enrichWithSnomedLinks(diseases, trials, concepts);
        expect(tel.diseases_processed).toBe(1);
        expect(tel.trials_processed).toBe(1);
        expect(tel.exact_code_join_hits).toBe(1);
        expect(tel.fuzzy_string_resolve_hits).toBe(1);
        // HIGH (1.0) and LOW (0.4) links BOTH published -- nothing withheld.
        expect(diseases[0].snomed_links[0].confidence).toBe(1.0);
        expect(trials[0].snomed_links[0].confidence).toBe(0.4);
        assertPublicLinkShape(diseases[0].snomed_links[0]);
        assertPublicLinkShape(trials[0].snomed_links[0]);
    });

    it('idempotent -- re-run OVERWRITES (no duplicate) + never touches sid_s/sid_c', () => {
        const concepts = [concept()];
        const diseases = [{ id: 'd1', sid_s: 'D_SID_S', sid_c: 'D_SID_C', db_xrefs: ['SNOMEDCT_US:73211009'] }];
        const trials = [];
        enrichWithSnomedLinks(diseases, trials, concepts);
        const firstLen = diseases[0].snomed_links.length;
        enrichWithSnomedLinks(diseases, trials, concepts); // re-run
        expect(diseases[0].snomed_links.length).toBe(firstLen);
        expect(diseases[0].snomed_links).toHaveLength(1);
        expect(diseases[0].sid_s).toBe('D_SID_S');
        expect(diseases[0].sid_c).toBe('D_SID_C');
    });
});
