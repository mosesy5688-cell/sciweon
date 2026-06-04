/**
 * UniProt SwissProt (.dat) diagnostic row-dump probe (PR-UNIPROT-0, diagnostic-only).
 *
 * The FIRST UniProt ingest PR, per [[external_dataset_diagnostic_first]]: it NEVER
 * trusts the UniProt .dat-format documentation as schema truth. It DOWNLOADS/STREAMS
 * uniprot_sprot.dat.gz (anonymous HTTPS, no auth) through gunzip and:
 *   1. DISCOVERS the release from current_release/.../reldate.txt (Release YYYY_MM).
 *   2. CONFIRMS format + sizes: HEAD the .dat.gz / .xml.gz / .fasta.gz; stream .dat.gz
 *      and report compressed (header) AND uncompressed (counted) byte size.
 *   3. DUMPS the first 5 COMPLETE raw // record blocks VERBATIM (doc-immune).
 *   4. Prints a TENTATIVE field map for the first ~200 records (reviewer confirms which
 *      line code holds each field -- explicitly NOT the ingest parser).
 *   5. MEASURES from the rows: total //-record count (FLAG vs REST 574627); per-taxon
 *      tally 9606/10090/10116 (FLAG vs REST); DR xref-source distribution (top ~30);
 *      count of records with NO parseable OX (silent-drop guard).
 *   6. CONFIRMS delimiter is // + prints a MUST-STREAM verdict + CC BY 4.0 PASS/FAIL.
 *
 * ZERO extraction-for-ingest / field-filter / stamp / mutation / R2 write / schema
 * change. The TENTATIVE field map is for reviewer verification only; the production
 * parser is PR-UNIPROT-1, built from THIS probe's verified output.
 *
 * Exit: 0 OK / 1 bad args / 2 release-not-found / 3 download-or-parse anomaly.
 */

import { downloadAndConsume } from './lib/stream-fetch-retry.js';
import {
    splitRecordBlocks, isNonEmptyBlock, extractFieldMapTentative,
    tallyTaxon, newTaxonTally, tallyDrSources, newDrSourceTally, topDrSources,
    hasCcByLicense, RECORD_DELIMITER, REST_TOTAL_BASELINE, REST_TAXON_BASELINE, TARGET_TAXA,
} from './lib/uniprot-sprot-probe.js';

const BASE = 'https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/complete';
const RELDATE_URL = `${BASE}/reldate.txt`;
const FILES = ['uniprot_sprot.dat.gz', 'uniprot_sprot.xml.gz', 'uniprot_sprot.fasta.gz'];
const DAT_GZ_URL = `${BASE}/uniprot_sprot.dat.gz`;
const RAW_DUMP_LIMIT = 5;        // first N complete record blocks dumped VERBATIM
const FIELD_MAP_LIMIT = 200;     // first N records for the TENTATIVE field map
const TAG = '[UNIPROT-PROBE]';
// Sane in-memory bound for the MUST-STREAM verdict: uncompressed SwissProt is multi-GB,
// far beyond any single-buffer Node string -> the harvester MUST stream, never buffer.
const MEMORY_BOUND_BYTES = 512 * 1024 * 1024; // 512 MiB

function parseArgs() {
    for (const a of process.argv.slice(2)) {
        if (a !== '--help' && a !== '-h') { console.error(`${TAG} bad arg: ${a}`); process.exit(1); }
        console.log(`${TAG} usage: node diagnostic-uniprot-sprot-probe.js (no args; anonymous, no UNIPROT_* env)`);
        process.exit(0);
    }
    // Assert no UNIPROT_* secret is needed: anonymous FTP-over-HTTPS only.
    const leaked = Object.keys(process.env).filter((k) => k.startsWith('UNIPROT_'));
    if (leaked.length) console.log(`${TAG} note: UNIPROT_* env present (${leaked.join(',')}) but UNUSED -- access is anonymous.`);
}

async function discoverRelease() {
    const res = await fetch(RELDATE_URL);
    if (!res.ok) { console.error(`${TAG} reldate HTTP ${res.status} ${res.statusText}`); return null; }
    const text = await res.text();
    const m = text.match(/Release\s+(\d{4}_\d{2})/);
    console.log(`${TAG} reldate.txt head: ${text.split('\n').slice(0, 3).join(' | ').slice(0, 200)}`);
    return m ? m[1] : null;
}

async function headSizes() {
    const sizes = {};
    for (const f of FILES) {
        const res = await fetch(`${BASE}/${f}`, { method: 'HEAD' });
        const len = res.headers.get('content-length');
        sizes[f] = res.ok ? (len ?? 'unknown') : `HTTP ${res.status}`;
        console.log(`${TAG} HEAD ${f} content-length=${sizes[f]} status=${res.status}`);
    }
    return sizes;
}

// Streaming consumer: line-buffer the gunzipped .dat, split on //, MEASURE everything.
// Pure helpers do the splitting/extraction/tally; this only wires the stream to them.
function makeDatConsumer(state) {
    return async (decompressed) => {
        let remainder = '';
        decompressed.setEncoding('utf-8');
        for await (const chunk of decompressed) {
            state.uncompressedBytes += Buffer.byteLength(chunk, 'utf-8');
            const { blocks, remainder: rem } = splitRecordBlocks(remainder + chunk);
            remainder = rem;
            for (const block of blocks) consumeBlock(state, block);
        }
        // Flush any trailing complete record (file may end without a final newline).
        const { blocks } = splitRecordBlocks(remainder + '\n' + RECORD_DELIMITER);
        for (const block of blocks) if (isNonEmptyBlock(block)) consumeBlock(state, block);
    };
}

function consumeBlock(state, block) {
    if (!isNonEmptyBlock(block)) return;
    state.total += 1;
    tallyTaxon(state.taxa, block);
    tallyDrSources(state.dr, block);
    if (hasCcByLicense(block)) state.ccByHits += 1;
    if (state.raw.length < RAW_DUMP_LIMIT) state.raw.push(block);
    if (state.fieldMaps.length < FIELD_MAP_LIMIT) state.fieldMaps.push(extractFieldMapTentative(block));
}

function reportRawDump(state) {
    console.log(`${TAG} === RAW record blocks (first ${state.raw.length}, VERBATIM, all line codes; delimiter='${RECORD_DELIMITER}') ===`);
    state.raw.forEach((b, i) => {
        console.log(`${TAG} --- RAW RECORD ${i + 1} BEGIN ---`);
        console.log(b);
        console.log(`${TAG} --- RAW RECORD ${i + 1} END (// delimiter) ---`);
    });
}

function reportFieldMap(state) {
    console.log(`${TAG} === TENTATIVE field map (probe diagnostic, NOT the ingest parser) -- first ${state.fieldMaps.length} records ===`);
    state.fieldMaps.slice(0, RAW_DUMP_LIMIT).forEach((fm, i) => {
        console.log(`${TAG} [TENTATIVE field-map ${i + 1}] ${JSON.stringify(fm)}`);
    });
    const have = (k) => state.fieldMaps.filter((fm) => fm[k] !== null && fm[k] !== undefined).length;
    const cov = ['id_len', 'accession', 'de_full', 'ec', 'gene', 'organism', 'taxid', 'sq_len', 'sq_mw']
        .map((k) => `${k}=${have(k)}/${state.fieldMaps.length}`).join(' ');
    console.log(`${TAG} [TENTATIVE field-map coverage] ${cov}`);
}

function reportSummary(state, release, sizes, datCompressedLen) {
    const drift = (got, base) => (got === base ? 'MATCH' : `DRIFT(got ${got} vs REST ${base}, delta ${got - base})`);
    const mustStream = state.uncompressedBytes > MEMORY_BOUND_BYTES;
    console.log(`${TAG} ===================== SUMMARY =====================`);
    console.log(`${TAG} release=${release}`);
    console.log(`${TAG} file sizes (Content-Length): ${JSON.stringify(sizes)}`);
    console.log(`${TAG} dat.gz compressed_bytes=${datCompressedLen ?? 'unknown'} uncompressed_bytes=${state.uncompressedBytes} (${(state.uncompressedBytes / 1e9).toFixed(2)} GB)`);
    console.log(`${TAG} delimiter CONFIRMED='${RECORD_DELIMITER}' (records split on a // line)`);
    console.log(`${TAG} MUST-STREAM verdict: ${mustStream ? 'YES' : 'NO'} (uncompressed ${state.uncompressedBytes} vs memory-bound ${MEMORY_BOUND_BYTES}=${(MEMORY_BOUND_BYTES / 1e6).toFixed(0)}MB)`);
    console.log(`${TAG} total //-records=${state.total} -- ${drift(state.total, REST_TOTAL_BASELINE)}`);
    for (const t of TARGET_TAXA) {
        console.log(`${TAG} taxon ${t} count=${state.taxa[t]} -- ${drift(state.taxa[t], REST_TAXON_BASELINE[t])}`);
    }
    console.log(`${TAG} taxon other=${state.taxa.other} no_ox=${state.taxa.no_ox} (no-OX = silent-drop guard; these are COUNTED not dropped)`);
    console.log(`${TAG} DR xref-source distinct=${state.dr.size}; top ${Math.min(30, state.dr.size)}:`);
    for (const [src, n] of topDrSources(state.dr, 30)) console.log(`${TAG}   DR ${src} = ${n}`);
    const ccVerdict = state.ccByHits > 0 ? 'PASS' : 'FAIL';
    console.log(`${TAG} CC BY 4.0 license notice present in dumped CC blocks: ${ccVerdict} (records with CC BY 4.0 in first ${state.fieldMaps.length}-window scan=${state.ccByHits})`);
    console.log(`${TAG} ==================================================`);
}

async function main() {
    parseArgs();
    console.log(`${TAG} START anonymous HTTPS probe (no auth, no R2, diagnostic-only). base=${BASE}`);

    const release = await discoverRelease();
    if (!release) { console.error(`${TAG} could not parse 'Release YYYY_MM' from reldate.txt`); process.exit(2); }
    console.log(`${TAG} release RESOLVED=${release}`);

    const sizes = await headSizes();

    // Compressed size from the HEAD (the dat.gz Content-Length); uncompressed measured
    // while streaming. The HEAD value settles compressed; the stream settles uncompressed.
    const datCompressedLen = sizes['uniprot_sprot.dat.gz'];

    const state = {
        total: 0, uncompressedBytes: 0, ccByHits: 0,
        taxa: newTaxonTally(), dr: newDrSourceTally(), raw: [], fieldMaps: [],
    };

    try {
        await downloadAndConsume(DAT_GZ_URL, { consume: makeDatConsumer(state) });
    } catch (err) {
        console.error(`${TAG} FATAL during stream/parse: ${err.message}`);
        process.exit(3);
    }

    reportRawDump(state);
    reportFieldMap(state);
    reportSummary(state, release, sizes, datCompressedLen);

    if (state.total === 0) { console.error(`${TAG} ANOMALY: zero //-records parsed from a non-empty stream`); process.exit(3); }
    process.exit(0);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '');
if (isDirectRun) {
    main().catch((err) => { console.error(`${TAG} FATAL:`, err.message); process.exit(3); });
}
