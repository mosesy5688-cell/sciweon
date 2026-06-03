// @ts-nocheck
/**
 * PR-UMLS-4b LOINC cross-link tests (network-free; SYNTHETIC placeholder tokens ONLY, NO real
 * LOINC strings). Locks: PUBLIC link itemShape {loinc_sid,confidence,match_method} (no cui/code/
 * str); per-string-max Token-Set Jaccard; the <=2 token filter; ANCHOR = primary outcome titles
 * NOT conditions; ALL links published incl low-confidence (floor = RAW Jaccard > 0, nothing
 * withheld); no_match bucketed not thrown; idempotent byte-identical re-run; HALT on 0 concepts;
 * plus the 4 PR-4b review fixes (per-string max / non-destructive load / 0.01 clamp / max+sort).
 */
import { describe, it, expect } from 'vitest';
import {
    tokenize, jaccard, jaccardRaw,
    buildLoincTokenIndex, resolveOutcomeTitle,
    buildLoincLinksForTrial, enrichTrialsWithLoincLinks,
    assertLoincConceptsLoaded, assertTrialsLoaded, emptyLoincTelemetry,
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
    // ZERO NLM/LOINC content -- cui/code/str MUST be absent (scan the keys).
    for (const k of ['cui', 'code', 'str', 'preferred_str', 'synonyms']) expect(Object.prototype.hasOwnProperty.call(link, k)).toBe(false);
}
describe('tokenizer -- lowercase, split non-alnum, drop tokens of length <= 2', () => {
    it('drops short tokens (<=2) and dedups into a Set', () => {
        const toks = tokenize('Hemoglobin A1c at of in by HB');
        expect(toks.has('hemoglobin')).toBe(true);
        expect(toks.has('a1c')).toBe(true);
        // <=2 chars dropped: "at","of","in","by","hb" all length 2
        for (const t of ['at', 'of', 'in', 'by', 'hb']) expect(toks.has(t)).toBe(false);
    });
    it('non-string -> empty set', () => {
        expect(tokenize(undefined).size).toBe(0);
        expect(tokenize(null).size).toBe(0);
        expect(tokenize(42).size).toBe(0);
    });
    it('jaccard {abg} vs {bgd}->0.5; {abc} vs {a}->0.33; identical->1; disjoint->0; empty->0', () => {
        expect(jaccard(new Set(['alpha', 'beta', 'gamma']), new Set(['beta', 'gamma', 'delta']))).toBe(0.5); // 2/4
        expect(jaccard(new Set(['aaa', 'bbb', 'ccc']), new Set(['aaa']))).toBe(0.33); // 1/3
        expect(jaccard(new Set(['aaa', 'bbb']), new Set(['aaa', 'bbb']))).toBe(1);
        expect(jaccard(new Set(['aaa']), new Set(['zzz']))).toBe(0);
        expect(jaccard(new Set(), new Set(['aaa']))).toBe(0);
    });
});
describe('index builder + resolve -- PUBLIC shape + cui ABSENT', () => {
    it('builds the inverted index; un-stamped concept skipped + counted', () => {
        const { index, missingSid } = buildLoincTokenIndex([concept(), concept({ code: 'X', sid_s: undefined })]);
        expect(index.has('alpha')).toBe(true);
        expect(missingSid).toBe(1);
    });
    it('resolves a title to the EXACT public link {loinc_sid,confidence,match_method}; cui ABSENT', () => {
        const { index } = buildLoincTokenIndex([concept()]); // preferred_str 'alpha beta gamma'
        const link = resolveOutcomeTitle('alpha beta gamma', index); // identical token set -> 1.0
        assertPublicLinkShape(link);
        expect(link.loinc_sid).toBe('sid-alpha-0001');
        expect(link.confidence).toBe(1);
    });
    it('no shared token -> Jaccard 0 -> null (no link)', () => {
        expect(resolveOutcomeTitle('zzz9 yyy8 www7', buildLoincTokenIndex([concept()]).index)).toBeNull();
    });
    it('synonym-only matching still resolves (per-string max keeps recall; FIX 1)', () => {
        const { index } = buildLoincTokenIndex([concept({ preferred_str: 'alpha', synonyms: ['delta epsilon'] })]);
        // 'delta epsilon' is carried ONLY by the synonym; per-string max scores its set at 1.0.
        const link = resolveOutcomeTitle('delta epsilon', index);
        expect(link.loinc_sid).toBe('sid-alpha-0001');
        expect(link.confidence).toBe(1);
    });
    it('deterministic tie-break -- equal Jaccard -> lowest sid_s lexicographically wins', () => {
        const { index } = buildLoincTokenIndex([
            concept({ sid_s: 'sid-zzz', preferred_str: 'alpha beta gamma' }),
            concept({ sid_s: 'sid-aaa', preferred_str: 'alpha beta gamma' }),
        ]);
        expect(resolveOutcomeTitle('alpha beta gamma', index).loinc_sid).toBe('sid-aaa'); // lower wins, any insert order
    });
});
describe('ANCHOR guardrail -- primary_outcomes[].title ONLY, NOT conditions (category error)', () => {
    it('a conditions value that WOULD match a concept produces NO link; only the outcome title links', () => {
        // conditions WOULD overlap the concept tokens but must NEVER be anchored (disease axis = SNOMED);
        // only primary_outcomes[].title is the anchor.
        const { index } = buildLoincTokenIndex([concept()]);
        const tel = emptyLoincTelemetry();
        const trial = {
            conditions: ['alpha beta gamma'], // must be ignored
            results: { primary_outcomes: [{ title: 'alpha beta gamma' }] }, // the ONLY anchor
        };
        const links = buildLoincLinksForTrial(trial, index, tel);
        expect(links).toHaveLength(1);
        expect(tel.terms_total).toBe(1); // only the outcome title counted
        assertPublicLinkShape(links[0]);
    });
    it('a matching condition but NO primary outcomes yields ZERO links', () => {
        const tel = emptyLoincTelemetry();
        const links = buildLoincLinksForTrial({ conditions: ['alpha beta gamma'], results: { primary_outcomes: [] } }, buildLoincTokenIndex([concept()]).index, tel);
        expect(links).toHaveLength(0);
        expect(tel.terms_total).toBe(0);
    });
});
describe('cross-link policy + no-match bucketing', () => {
    it('a LOW Jaccard (0.2) link IS published, not dropped by any threshold', () => {
        // title {alpha,beta,gamma,delta,epsilon} vs concept {alpha} -> 1/5 -> 0.2
        const { index } = buildLoincTokenIndex([concept({ preferred_str: 'alpha', synonyms: [] })]);
        const link = resolveOutcomeTitle('alpha beta gamma delta epsilon', index);
        expect(link.confidence).toBe(0.2); // LOW but PUBLISHED
        assertPublicLinkShape(link);
    });
    it('an unresolved outcome title is bucketed in no_match (not thrown, not dropped)', () => {
        const tel = emptyLoincTelemetry();
        const links = buildLoincLinksForTrial({ results: { primary_outcomes: [{ title: 'zzz9 yyy8 www7' }] } }, buildLoincTokenIndex([concept()]).index, tel);
        expect(links).toHaveLength(0);
        expect(tel.no_match).toBe(1);
        expect(tel.no_match_samples[0]).toContain('title:zzz9 yyy8 www7');
        expect(tel.jaccard_hits).toBe(0);
    });
});
describe('enrichTrialsWithLoincLinks -- telemetry + idempotent OVERWRITE + HALT on 0 concepts', () => {
    it('attaches trial.loinc_links; ALL links published; sid_s/sid_c untouched', () => {
        const trials = [{ id: 't1', sid_s: 'T_SID_S', sid_c: 'T_SID_C', results: { primary_outcomes: [{ title: 'alpha beta gamma' }] } }];
        const tel = enrichTrialsWithLoincLinks(trials, [concept()]);
        expect(tel.trials_processed).toBe(1);
        expect(tel.jaccard_hits).toBe(1);
        expect(trials[0].loinc_links).toHaveLength(1);
        assertPublicLinkShape(trials[0].loinc_links[0]);
        expect(trials[0].sid_s).toBe('T_SID_S'); // untouched
        expect(trials[0].sid_c).toBe('T_SID_C'); // untouched
    });
    it('determinism -- running twice + re-run-in-place yield BYTE-IDENTICAL loinc_links', () => {
        const concepts = [
            concept({ sid_s: 'sid-zzz', preferred_str: 'alpha beta gamma' }),
            concept({ sid_s: 'sid-aaa', preferred_str: 'alpha beta gamma' }),
        ];
        const mk = () => [{ id: 't1', results: { primary_outcomes: [{ title: 'alpha beta gamma delta' }] } }];
        const a = mk(); enrichTrialsWithLoincLinks(a, concepts);
        const b = mk(); enrichTrialsWithLoincLinks(b, concepts);
        expect(JSON.stringify(a[0].loinc_links)).toBe(JSON.stringify(b[0].loinc_links));
        const first = JSON.stringify(a[0].loinc_links);
        enrichTrialsWithLoincLinks(a, concepts); // re-run on same array = idempotent overwrite
        expect(JSON.stringify(a[0].loinc_links)).toBe(first);
    });
    it('assertLoincConceptsLoaded throws on empty / non-array (no silent zero-out)', () => {
        expect(() => assertLoincConceptsLoaded([])).toThrow(/HALT: 0 LOINC concepts/);
        expect(() => assertLoincConceptsLoaded(undefined)).toThrow(/HALT: 0 LOINC concepts/);
        expect(() => assertLoincConceptsLoaded([concept()])).not.toThrow();
    });
});
// --- PR-4b review fixes 1-4 (SYNTHETIC tokens only). bigStr = a 200-token concept string for a
// tiny-overlap Jaccard. ---
const bigStr = Array.from({ length: 200 }, (_, i) => `tok${i}`).join(' ');
describe('FIX 1 -- per-string MAX Jaccard (drop the synonym-UNION scoring bias)', () => {
    it('a synonym-rich canonical concept (preferred_str matches) WINS over a sparse coincidence', () => {
        // CANONICAL preferred_str == title (1.0) but +30 noise synonyms; OLD UNION inflated |B| so it
        // scored ~0.02 and LOST to SPARSE (1 coincidental token). Per-string MAX must now pick canonical.
        const noiseSyns = Array.from({ length: 30 }, (_, i) => `noisea${i} noiseb${i} noisec${i} noised${i}`);
        const canonical = concept({ sid_s: 'sid-canonical', preferred_str: 'hemoglobin a1c', synonyms: noiseSyns });
        const sparse = concept({ sid_s: 'sid-sparse', preferred_str: 'glucose a1c', synonyms: [] });
        const link = resolveOutcomeTitle('hemoglobin a1c', buildLoincTokenIndex([canonical, sparse]).index);
        expect(link.loinc_sid).toBe('sid-canonical'); // per-string max picks canonical
        expect(link.confidence).toBe(1);
        assertPublicLinkShape(link);
    });
    it('the index entry stores the per-string token-set LIST (tokenSets), not a single union set', () => {
        const { index } = buildLoincTokenIndex([
            concept({ sid_s: 'sid-x', preferred_str: 'alpha beta', synonyms: ['gamma delta'] }),
        ]);
        const entry = index.get('alpha')[0]; // tokenSets = [{alpha,beta},{gamma,delta}]
        expect(entry.tokenSets).toHaveLength(2);
        expect(entry.tokenSets.every((s: Set<string>) => s instanceof Set)).toBe(true);
        expect(index.has('gamma')).toBe(true); // candidacy union still indexes a synonym-only token
    });
});
describe('FIX 2 -- non-destructive trials load + assertTrialsLoaded guard', () => {
    it('assertTrialsLoaded throws on empty / non-array (refuses to overwrite trials.jsonl)', () => {
        expect(() => assertTrialsLoaded([])).toThrow(/HALT: 0 trials/);
        expect(() => assertTrialsLoaded(undefined)).toThrow(/HALT: 0 trials/);
        expect(() => assertTrialsLoaded([{ id: 't1' }])).not.toThrow();
    });
    it('a present-but-MALFORMED JSONL line THROWS (not []) -- ENOENT-only swallow', async () => {
        // Mirror the enricher loadJsonl contract: ENOENT -> []; any other error (incl a parse) rethrows.
        const loadJsonl = async (read: () => Promise<string>) => {
            let c: string;
            try { c = await read(); } catch (err: any) { if (err?.code === 'ENOENT') return []; throw err; }
            return c.split('\n').filter(Boolean).filter(l => !l.startsWith('#')).map(l => JSON.parse(l));
        };
        const throwCode = (code: string) => async () => { const e: any = new Error(code); e.code = code; throw e; };
        await expect(loadJsonl(throwCode('ENOENT'))).resolves.toEqual([]);            // absent -> []
        await expect(loadJsonl(async () => '{"ok":1}\n{bad json}\n')).rejects.toThrow(); // malformed -> throws
        await expect(loadJsonl(throwCode('EIO'))).rejects.toThrow('EIO');             // read error -> throws
    });
});
describe('FIX 3 -- raw-Jaccard floor + 0.01 clamp (a tiny real overlap is published, not dropped)', () => {
    it('jaccardRaw is UNROUNDED; a 1/201 overlap is > 0 but rounds to 0.00', () => {
        const big = new Set(Array.from({ length: 201 }, (_, i) => `tok${i}`));
        const title = new Set(['tok0']); // int 1, union 201 -> raw 1/201 ~ 0.004975
        expect(jaccardRaw(title, big)).toBeGreaterThan(0);
        expect(jaccardRaw(title, big)).toBeLessThan(0.005); // below the 0.005 round-up boundary
        expect(jaccard(title, big)).toBe(0); // ROUNDED floors to 0.00 (the OLD drop trap)
    });
    it('a raw Jaccard in (0,0.005) is PUBLISHED at 0.01, not dropped / not no_match', () => {
        const { index } = buildLoincTokenIndex([concept({ sid_s: 'sid-big', preferred_str: bigStr })]);
        const tel = emptyLoincTelemetry();
        const links = buildLoincLinksForTrial({ results: { primary_outcomes: [{ title: 'tok0 zzzword' }] } }, index, tel);
        expect(links).toHaveLength(1);
        expect(links[0].confidence).toBe(0.01); // clamped up from sub-0.005 raw (NOT 0.00, NOT dropped)
        expect(links[0].match_method).toBe(MATCH_TOKEN_SET_JACCARD);
        expect(tel.no_match).toBe(0); // NOT mislabeled no_match
        assertPublicLinkShape(links[0]);
    });
});
describe('FIX 4 -- max-confidence dedup across outcomes + sid-sort (no first-write-wins loss)', () => {
    it('outcomes [weak->X, strong->X] publish X at the MAX confidence (not first)', () => {
        // concept 'aaa bbb ccc ddd'; weak title shares 1/8 -> ~0.13, strong == 4/4 -> 1.0; same sid.
        const { index } = buildLoincTokenIndex([concept({ sid_s: 'sid-X', preferred_str: 'aaa bbb ccc ddd' })]);
        const tel = emptyLoincTelemetry();
        const trial = { results: { primary_outcomes: [{ title: 'aaa zzz1 zzz2 zzz3 zzz4' }, { title: 'aaa bbb ccc ddd' }] } };
        const links = buildLoincLinksForTrial(trial, index, tel);
        expect(links).toHaveLength(1);       // deduped to ONE link for sid-X
        expect(links[0].confidence).toBe(1); // MAX wins (NOT the first/weak)
        expect(tel.jaccard_hits).toBe(1);    // 1 distinct published link per sid
    });
    it('the published links array is SORTED by loinc_sid (byte-deterministic vs outcome order)', () => {
        const { index } = buildLoincTokenIndex([
            concept({ sid_s: 'sid-ccc', preferred_str: 'ccword ccextra' }),
            concept({ sid_s: 'sid-aaa', preferred_str: 'aaword aaextra' }),
            concept({ sid_s: 'sid-bbb', preferred_str: 'bbword bbextra' }),
        ]);
        const trial = { results: { primary_outcomes: [
            { title: 'ccword ccextra' }, { title: 'aaword aaextra' }, { title: 'bbword bbextra' },
        ] } };
        const links = buildLoincLinksForTrial(trial, index, emptyLoincTelemetry());
        expect(links.map(l => l.loinc_sid)).toEqual(['sid-aaa', 'sid-bbb', 'sid-ccc']);
        // a re-ORDERED outcome array yields a byte-identical links array (sort guard).
        const reordered = { results: { primary_outcomes: [...trial.results.primary_outcomes].reverse() } };
        const links2 = buildLoincLinksForTrial(reordered, index, emptyLoincTelemetry());
        expect(JSON.stringify(links2)).toBe(JSON.stringify(links));
    });
});
