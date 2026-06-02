#!/usr/bin/env node
/**
 * SID -> SNOMED rehydration CLI (Node ESM, ZERO runtime deps, ships ZERO SNOMED content).
 *
 * Recovers human-readable SNOMED CODE + STR for Sciweon's published {sid_s, sid_c} by
 * RE-DERIVING sid_s from the researcher's OWN licensed MRCONSO.RRF and hash-matching.
 * There is NO CUI join anywhere -- the published snapshot withholds CUI, so the local
 * SID-S re-derive is the ONLY rehydration path.
 *
 * Usage:
 *   node rehydrate.mjs --snapshot <dir> --mrconso <MRCONSO.RRF> [--out <file>] [--mode rehydrate|verify]
 *
 * Modes:
 *   rehydrate (default) -- join published sid_s -> local map -> emit
 *       { sid_s, sid_c, code, preferred_str, synonyms[] }; resolve disease/trial
 *       snomed_links snomed_sid -> { code, preferred_str }.
 *   verify -- re-derive sid_s from the local codes and report how many published
 *       sid_s the local MRCONSO can recover (proves the anchor; no output file needed).
 *
 * LICENSE: you must hold a UMLS Metathesaurus / SNOMED CT Affiliate license. This tool
 * reads ONLY your local MRCONSO and Sciweon's hash-only public snapshot; it ships no
 * SNOMED content. See README.md.
 */

import { writeFileSync } from 'node:fs';
import { buildSidMapFromMrconso } from './mrconso-join.mjs';
import {
    readSnomedPublic, readCrossLinkFile, collectCrossLinkSids,
    DISEASES_FILE, TRIALS_FILE,
} from './snapshot-read.mjs';
import { SNOMED_ENTITY_CLASS, SNOMED_CANON_VERSION } from './sid-derive.mjs';

const LICENSE_BANNER = [
    '============================================================================',
    ' Sciweon SID -> SNOMED rehydration tool',
    ' LICENSE PREREQUISITE: you must hold a valid UMLS Metathesaurus / SNOMED CT',
    ' Affiliate license. This tool reads ONLY your own local MRCONSO.RRF and',
    ' Sciweon\'s hash-only public snapshot. It ships ZERO SNOMED content; all',
    ' recovered CODE/STR come from YOUR licensed data, never from Sciweon.',
    ` Targets entity_class=${SNOMED_ENTITY_CLASS}, canon=${SNOMED_CANON_VERSION}.`,
    '============================================================================',
].join('\n');

function parseArgs(argv) {
    const args = { mode: 'rehydrate', out: null, snapshot: null, mrconso: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--snapshot') args.snapshot = argv[++i];
        else if (a === '--mrconso') args.mrconso = argv[++i];
        else if (a === '--out') args.out = argv[++i];
        else if (a === '--mode') args.mode = argv[++i];
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    return args;
}

function requireArg(args, name) {
    if (!args[name]) throw new Error(`--${name} is required`);
}

/**
 * Join published concepts against the local sid_s map. Pure: no I/O.
 * Returns { rehydrated[], stats } -- never drops a concept (no-match -> counted).
 */
export function rehydrateConcepts(publicConcepts, localBySidS) {
    const rehydrated = [];
    let matched = 0;
    let noMatch = 0;
    for (const c of publicConcepts) {
        const sid = c?.sid_s;
        const local = typeof sid === 'string' ? localBySidS.get(sid) : undefined;
        if (local) {
            matched++;
            rehydrated.push({
                sid_s: sid, sid_c: c.sid_c ?? null,
                code: local.code, preferred_str: local.preferred_str, synonyms: local.synonyms,
            });
        } else {
            noMatch++;
            rehydrated.push({
                sid_s: sid ?? null, sid_c: c?.sid_c ?? null,
                code: null, preferred_str: null, synonyms: [], no_sid_match: true,
            });
        }
    }
    return {
        rehydrated,
        stats: { concepts_total: publicConcepts.length, sid_matched: matched, no_sid_match: noMatch },
    };
}

/**
 * Resolve cross-link snomed_sid references (disease/trial) -> readable {code, preferred_str}.
 * Pure: no I/O. Returns { resolved[], stats }.
 */
export function resolveCrossLinks(label, crossSidMap, localBySidS) {
    const resolved = [];
    let matched = 0;
    let noMatch = 0;
    for (const [sid, info] of crossSidMap) {
        const local = localBySidS.get(sid);
        if (local) {
            matched++;
            resolved.push({
                source: label, snomed_sid: sid, code: local.code,
                preferred_str: local.preferred_str, ref_count: info.count, sample_ids: info.sample_ids,
            });
        } else {
            noMatch++;
            resolved.push({
                source: label, snomed_sid: sid, code: null, preferred_str: null,
                ref_count: info.count, sample_ids: info.sample_ids, no_sid_match: true,
            });
        }
    }
    return { resolved, stats: { source: label, distinct_sids: crossSidMap.size, sid_matched: matched, no_sid_match: noMatch } };
}

function emitOutput(args, payload) {
    const lines = payload.map(r => JSON.stringify(r)).join('\n') + (payload.length > 0 ? '\n' : '');
    if (args.out) {
        writeFileSync(args.out, lines, 'utf-8');
        console.log(`[rehydrate] wrote ${payload.length} records -> ${args.out}`);
    } else {
        process.stdout.write(lines);
    }
}

async function runRehydrate(args, localBySidS, mapStats) {
    const { records: publicConcepts } = readSnomedPublic(args.snapshot);
    const { rehydrated, stats } = rehydrateConcepts(publicConcepts, localBySidS);

    const crossOut = [];
    const crossStats = [];
    for (const file of [DISEASES_FILE, TRIALS_FILE]) {
        const read = readCrossLinkFile(args.snapshot, file);
        if (!read) { console.warn(`[rehydrate] ${file}[.gz] absent in snapshot -- skipping cross-links`); continue; }
        const sidMap = collectCrossLinkSids(read.records);
        const { resolved, stats: cs } = resolveCrossLinks(file, sidMap, localBySidS);
        crossOut.push(...resolved);
        crossStats.push(cs);
    }

    emitOutput(args, [...rehydrated, ...crossOut.map(r => ({ ...r, _cross_link: true }))]);
    console.log('[rehydrate] --- TELEMETRY (no silent drop) ---');
    console.log(`[rehydrate] local MRCONSO: rows=${mapStats.rows_total} snomed_kept=${mapStats.snomed_rows_kept} distinct_codes=${mapStats.distinct_codes} sid_collisions=${mapStats.collisions}`);
    console.log(`[rehydrate] concepts: total=${stats.concepts_total} sid_matched=${stats.sid_matched} no_sid_match=${stats.no_sid_match}`);
    for (const cs of crossStats) {
        console.log(`[rehydrate] cross-links ${cs.source}: distinct_sids=${cs.distinct_sids} sid_matched=${cs.sid_matched} no_sid_match=${cs.no_sid_match}`);
    }
}

function runVerify(args, localBySidS, mapStats) {
    const { records: publicConcepts } = readSnomedPublic(args.snapshot);
    let recoverable = 0;
    let unrecoverable = 0;
    for (const c of publicConcepts) {
        if (typeof c?.sid_s === 'string' && localBySidS.has(c.sid_s)) recoverable++;
        else unrecoverable++;
    }
    console.log('[verify] --- ANCHOR PROOF (local re-derive vs published sid_s) ---');
    console.log(`[verify] local MRCONSO: distinct_codes=${mapStats.distinct_codes} sid_collisions=${mapStats.collisions}`);
    console.log(`[verify] published concepts=${publicConcepts.length} recoverable=${recoverable} unrecoverable=${unrecoverable}`);
    const pct = publicConcepts.length > 0 ? ((recoverable / publicConcepts.length) * 100).toFixed(2) : '0.00';
    console.log(`[verify] anchor match rate: ${pct}% (proves sidS(local code) == published sid_s)`);
}

async function main() {
    console.log(LICENSE_BANNER);
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log('Usage: node rehydrate.mjs --snapshot <dir> --mrconso <MRCONSO.RRF> [--out <file>] [--mode rehydrate|verify]'); return; }
    requireArg(args, 'snapshot');
    requireArg(args, 'mrconso');
    if (args.mode !== 'rehydrate' && args.mode !== 'verify') throw new Error(`--mode must be rehydrate|verify (got ${args.mode})`);

    console.log(`[rehydrate] building local sid_s map from ${args.mrconso} (streaming, SNOMEDCT_US only) ...`);
    const mapStats = await buildSidMapFromMrconso(args.mrconso);
    const localBySidS = mapStats.bySidS;

    if (args.mode === 'verify') runVerify(args, localBySidS, mapStats);
    else await runRehydrate(args, localBySidS, mapStats);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('rehydrate.mjs');
if (isMain) {
    main().catch(err => { console.error(`[rehydrate] FAILED: ${err.message}`); process.exit(1); });
}
