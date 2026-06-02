/**
 * MeSH Public Builder -- PR-UMLS-2a COMPLIANCE REMEDIATION (founder FINAL RULING).
 *
 * THE BREACH: the FULL stamped mesh-concepts.jsonl carries `cui` (an NLM-proprietary
 * UMLS Metathesaurus identifier whose public redistribution the license forbids). Before
 * this PR, mesh-concepts.jsonl shipped DIRECTLY into the public snapshot -> an active
 * redistribution breach. This builder is the remediation: it reads the FULL stamped
 * internal working copy output/linked/mesh-concepts.jsonl (code + cui + preferred_str +
 * sid_s + sid_c) and writes the PUBLIC artifact output/linked/mesh-concepts-public.jsonl
 * containing EXACTLY {sid_s, sid_c, code, str} per concept (via projectUmlsPublic('MESH',
 * record), the shared cui-withhold allowlist -- CUI annihilated, Cat-0 code+str KEPT).
 *
 * The full mesh-concepts.jsonl is now AGGREGATED-only (internal F3->F4 round-trip for the
 * cross-link enricher, which needs the full code/cui/string indices) and OMITTED from the
 * public snapshot; mesh-concepts-public.jsonl is the ONLY MeSH-derived file in the snapshot.
 *
 * Runs in F3 AFTER the MeSH SID stamper (so every concept carries sid_s + sid_c), mirroring
 * the SNOMED public builder. Hard-fail per [[cross_cycle_silent_data_loss]]: a missing input
 * file or a projected record missing sid_s/sid_c HALTS (no silent empty/short public artifact).
 */

import { readFileSync, writeFileSync } from 'fs';
import { projectUmlsPublic } from './lib/umls-public-projection.js';

const LABEL = 'MESH-PUBLIC';
const FULL_INPUT = 'output/linked/mesh-concepts.jsonl';
const PUBLIC_OUTPUT = 'output/linked/mesh-concepts-public.jsonl';

function loadJsonl(file) {
    let raw;
    try {
        raw = readFileSync(file, 'utf-8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            // The full stamped file MUST exist (F3 linker + stamper ran first). A missing
            // file would silently publish an empty public artifact -> HALT loud.
            throw new Error(`[${LABEL}] HALT: ${file} not found -- the MeSH F3 linker + stamper must run first (no silent empty public artifact)`);
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
    console.log(`[${LABEL}] PR-UMLS-2a public projection | ${FULL_INPUT} -> ${PUBLIC_OUTPUT} ({sid_s,sid_c,code,str}; cui DROPPED)`);
    const { records, parseErrors } = loadJsonl(FULL_INPUT);
    if (parseErrors > 0) throw new Error(`[${LABEL}] ${parseErrors} JSON parse errors in ${FULL_INPUT} -- aborting`);
    console.log(`[${LABEL}] Loaded ${records.length} full (internal) stamped MeSH concepts`);

    if (records.length === 0) {
        throw new Error(`[${LABEL}] HALT: 0 MeSH concepts in ${FULL_INPUT} -- the F3 placement + stamper must run first (refusing to publish an empty public artifact, no silent drop)`);
    }

    const projected = [];
    let missingSid = 0;
    for (const c of records) {
        const pub = projectUmlsPublic('MESH', c);
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

    // Defect-15 lesson: records.map(...).join('\n') is stack-safe at any size.
    const output = projected.map(r => JSON.stringify(r)).join('\n') + (projected.length > 0 ? '\n' : '');
    writeFileSync(PUBLIC_OUTPUT, output, 'utf-8');
    console.log(`[${LABEL}] Wrote ${PUBLIC_OUTPUT} (${projected.length} {sid_s,sid_c,code,str} records, ${Buffer.byteLength(output)}B)`);
    console.log(`[${LABEL}] COMPLIANCE enforced: public MeSH artifact carries NO cui (UMLS proprietary identifier withheld)`);
    console.log(`[${LABEL}] SUCCESS`);
}

try {
    main();
} catch (err) {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
}
