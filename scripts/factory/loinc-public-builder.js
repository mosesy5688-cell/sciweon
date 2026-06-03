/**
 * LOINC Public Builder -- PR-UMLS-4 COMPLIANCE CORE (Cat-0 public projection).
 *
 * NON-CONFLATION NOTE: this LOINC axis is the UMLS LNC *concept vocabulary*. It is DISTINCT
 * from lib/spl-parser.js LOINC_SECTIONS (SPL document-section codes) -- a different axis.
 *
 * Reads the FULL stamped internal working copy output/linked/loinc-concepts.jsonl (code +
 * cui + preferred_str + sid_s + sid_c) and writes the PUBLIC artifact
 * output/linked/loinc-concepts-public.jsonl containing EXACTLY {sid_s, sid_c, code, str} per
 * concept (via projectUmlsPublic('LOINC', record), the shared cui-withhold allowlist -- CUI
 * annihilated, Cat-0 code+str KEPT; LOINC code+str are redistributable at no cost under the
 * Regenstrief license, only the NLM-proprietary CUI is dropped).
 *
 * The full loinc-concepts.jsonl is AGGREGATED-only (internal F3->F4 round-trip for a future
 * PR-4b cross-link enricher, which needs the full code/cui/string indices) and OMITTED from
 * the public snapshot; loinc-concepts-public.jsonl is the ONLY LOINC-derived file in the
 * snapshot.
 *
 * REGENSTRIEF ATTRIBUTION (verbatim, founder-locked): the public artifact carries the
 * required LOINC license notice as a leading `#`-comment metadata header line (one of the two
 * real public-facing layers PR-UMLS-4 produces; the other is the snapshot manifest
 * license_notices block). Downstream parsers already skip `#`-prefixed lines.
 *
 * Runs in F3 AFTER the LOINC SID stamper (so every concept carries sid_s + sid_c), mirroring
 * the MeSH public builder. Hard-fail per [[cross_cycle_silent_data_loss]]: a missing input
 * file or a projected record missing sid_s/sid_c HALTS (no silent empty/short public artifact).
 */

import { readFileSync, writeFileSync } from 'fs';
import { projectUmlsPublic } from './lib/umls-public-projection.js';
import { LOINC_ATTRIBUTION } from './lib/umls-concept-streams.js';

const LABEL = 'LOINC-PUBLIC';
const FULL_INPUT = 'output/linked/loinc-concepts.jsonl';
const PUBLIC_OUTPUT = 'output/linked/loinc-concepts-public.jsonl';

function loadJsonl(file) {
    let raw;
    try {
        raw = readFileSync(file, 'utf-8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            // The full stamped file MUST exist (F3 linker + stamper ran first). A missing
            // file would silently publish an empty public artifact -> HALT loud.
            throw new Error(`[${LABEL}] HALT: ${file} not found -- the LOINC F3 linker + stamper must run first (no silent empty public artifact)`);
        }
        throw err;
    }
    const records = [];
    let parseErrors = 0;
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        try { records.push(JSON.parse(t)); } catch { parseErrors++; }
    }
    return { records, parseErrors };
}

function main() {
    console.log(`[${LABEL}] PR-UMLS-4 public projection | ${FULL_INPUT} -> ${PUBLIC_OUTPUT} ({sid_s,sid_c,code,str}; cui DROPPED)`);
    const { records, parseErrors } = loadJsonl(FULL_INPUT);
    if (parseErrors > 0) throw new Error(`[${LABEL}] ${parseErrors} JSON parse errors in ${FULL_INPUT} -- aborting`);
    console.log(`[${LABEL}] Loaded ${records.length} full (internal) stamped LOINC concepts`);

    if (records.length === 0) {
        throw new Error(`[${LABEL}] HALT: 0 LOINC concepts in ${FULL_INPUT} -- the F3 placement + stamper must run first (refusing to publish an empty public artifact, no silent drop)`);
    }

    const projected = [];
    let missingSid = 0;
    for (const c of records) {
        const pub = projectUmlsPublic('LOINC', c);
        if (typeof pub.sid_s !== 'string' || pub.sid_s.length === 0
            || typeof pub.sid_c !== 'string' || pub.sid_c.length === 0) {
            missingSid++;
            continue;
        }
        projected.push(pub);
    }
    if (missingSid > 0) {
        throw new Error(`[${LABEL}] HALT: ${missingSid}/${records.length} concepts missing sid_s/sid_c post-stamp -- upstream stamper regression (per [[cross_cycle_silent_data_loss]])`);
    }

    // Leading `#`-comment metadata header carrying the verbatim Regenstrief LOINC attribution
    // (founder-locked). This public artifact is one of the two real public-facing layers; the
    // notice rides as a header line that downstream JSONL parsers skip (`#`-prefix).
    const header = '#' + JSON.stringify({ loinc_attribution: LOINC_ATTRIBUTION }) + '\n';
    // Defect-15 lesson: records.map(...).join('\n') is stack-safe at any size.
    const body = projected.map(r => JSON.stringify(r)).join('\n') + (projected.length > 0 ? '\n' : '');
    writeFileSync(PUBLIC_OUTPUT, header + body, 'utf-8');
    console.log(`[${LABEL}] Wrote ${PUBLIC_OUTPUT} (${projected.length} {sid_s,sid_c,code,str} records + Regenstrief header, ${Buffer.byteLength(header + body)}B)`);
    console.log(`[${LABEL}] COMPLIANCE enforced: public LOINC artifact carries NO cui (UMLS proprietary identifier withheld) + verbatim Regenstrief attribution header`);
    console.log(`[${LABEL}] SUCCESS`);
}

try {
    main();
} catch (err) {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
}
