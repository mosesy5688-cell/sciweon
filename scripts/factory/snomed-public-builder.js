/**
 * SNOMED Public Builder -- PR-UMLS-3 COMPLIANCE CORE (RULING 1, founder NON-NEGOTIABLE).
 *
 * Reads the FULL stamped internal working copy output/linked/snomed-concepts.jsonl
 * (STR + raw CODE + CUI + sid_s + sid_c) and writes the PUBLIC artifact
 * output/linked/snomed-concepts-public.jsonl containing EXACTLY {sid_s, sid_c} per
 * concept (via projectSnomedPublic, a strict allowlist -- CUI annihilated, no STR/CODE).
 *
 * Runs in F3 AFTER the SNOMED SID stamper (so every concept carries sid_s + sid_c) and is
 * the producer of the ONLY SNOMED-derived file in SNAPSHOT_FILES. The FULL file is kept in
 * AGGREGATED_FILES (internal F3->F4 round-trip) but DELIBERATELY OMITTED from SNAPSHOT_FILES.
 *
 * Hard-fail per [[cross_cycle_silent_data_loss]]: a stamped concept missing sid_s/sid_c is
 * an upstream regression (the stamper hard-fails first); we additionally HALT here if any
 * projected record lacks sid_s/sid_c, refusing to publish a malformed public artifact.
 */

import { readFileSync, writeFileSync } from 'fs';
import { projectSnomedPublic } from './lib/snomed-public-projection.js';

const LABEL = 'SNOMED-PUBLIC';
const FULL_INPUT = 'output/linked/snomed-concepts.jsonl';
const PUBLIC_OUTPUT = 'output/linked/snomed-concepts-public.jsonl';

function loadJsonl(file) {
    let raw;
    try {
        raw = readFileSync(file, 'utf-8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            // The full stamped file MUST exist (F3 linker + stamper ran first). A missing
            // file would silently publish an empty public artifact -> HALT loud.
            throw new Error(`[${LABEL}] HALT: ${file} not found -- the SNOMED F3 linker + stamper must run first (no silent empty public artifact)`);
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
    console.log(`[${LABEL}] PR-UMLS-3 public projection | ${FULL_INPUT} -> ${PUBLIC_OUTPUT} ({sid_s,sid_c} ONLY)`);
    const { records, parseErrors } = loadJsonl(FULL_INPUT);
    if (parseErrors > 0) throw new Error(`[${LABEL}] ${parseErrors} JSON parse errors in ${FULL_INPUT} -- aborting`);
    console.log(`[${LABEL}] Loaded ${records.length} full (internal) stamped SNOMED concepts`);

    if (records.length === 0) {
        throw new Error(`[${LABEL}] HALT: 0 SNOMED concepts in ${FULL_INPUT} -- the F3 placement + stamper must run first (refusing to publish an empty public artifact, no silent drop)`);
    }

    const projected = [];
    let missingSid = 0;
    for (const c of records) {
        const pub = projectSnomedPublic(c);
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
    console.log(`[${LABEL}] Wrote ${PUBLIC_OUTPUT} (${projected.length} {sid_s,sid_c} records, ${Buffer.byteLength(output)}B)`);
    console.log(`[${LABEL}] RULING 1 enforced: public artifact = Sciweon SID hashes ONLY (no CUI / STR / CODE)`);
    console.log(`[${LABEL}] SUCCESS`);
}

try {
    main();
} catch (err) {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
}
