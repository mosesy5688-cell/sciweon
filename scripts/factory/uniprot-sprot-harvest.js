/**
 * UniProt SwissProt FULL-corpus bulk harvest orchestrator (PR-UNIPROT-1).
 *
 * Streams uniprot_sprot.dat.gz (660 MiB compressed / 4.18 GB uncompressed --
 * MUST-STREAM) from the anonymous UniProt FTP-over-HTTPS current_release endpoint
 * through lib/stream-fetch-retry.js (gunzip-aware, retry-from-byte-0) + the pure
 * lib/uniprot-dat-stream.js parser, writes ALL ~574,627 records to a JSONL with a
 * license_metadata #-header, zstd-compresses (native zstd CLI, level pinned), PUTs to
 * R2 processed/bulk/uniprot/<release>/sprot.jsonl.zst + writes the cursor
 * state/uniprot-bulk-cursor.json.
 *
 * FULL CORPUS / FULL RECORD (founder ruling "preserve all source data"): NO organism
 * filter, NO DR-source whitelist. Every record + every DR xref captured; per-taxon
 * tally + no_ox count are TELEMETRY only.
 *
 * ARTIFACT ONLY: writes the bulk artifact + cursor; does NOT touch target.js /
 * targets.jsonl / the SID ledger (the enrich-into-target merge is PR-UNIPROT-2).
 *
 * DETERMINISM (GEMINI.md Sec 7, byte-identical): records are written in INPUT
 * STREAM ORDER (the .dat is a stable file; a retry re-downloads from byte 0 ->
 * identical input/output). Inner arrays sorted by the pure parser. zstd level
 * pinned (ZSTD_LEVEL). No Date.now / Math.random in any artifact field.
 *
 * NO SILENT DROP ([[cross_cycle_silent_data_loss]]): a parser throw (no-AC record)
 * is FATAL (non-zero exit, no partial artifact); no_ox is COUNTED + logged. (There is
 * no DR cap: PR-UNIPROT-1b removed DR_XREF_CAP -- every DR xref is captured.)
 *
 * Usage: node scripts/factory/uniprot-sprot-harvest.js [--release=2026_01] [--dry-run]
 * Exit: 0 OK / 1 args / 2 release-discovery / 3 stream-or-parse / 4 zstd / 5 R2.
 */

import { createWriteStream, readFileSync, statSync, unlinkSync } from 'fs';
import { once } from 'events';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { downloadAndConsume } from './lib/stream-fetch-retry.js';
import {
    splitRecordBlocks, isNonEmptyBlock, parseUniprotRecord, recordToJsonl,
    newTaxonTally, tallyTaxon, RECORD_DELIMITER, UNIPROT_LICENSE, SCHEMA_VERSION,
} from './lib/uniprot-dat-stream.js';

const TAG = '[UNIPROT-HARVEST]';
const BASE = 'https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/complete';
const RELDATE_URL = `${BASE}/reldate.txt`;
const DAT_GZ_URL = `${BASE}/uniprot_sprot.dat.gz`;
const CURSOR_KEY = 'state/uniprot-bulk-cursor.json';
const ZSTD_LEVEL = 19; // pinned for byte-identical compressed output
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

const ATTRIBUTION = 'Data from UniProt (The UniProt Consortium), CC BY 4.0';

function parseArgs() {
    const args = { release: null, dryRun: false };
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--release=')) args.release = a.slice('--release='.length);
        else if (a === '--dry-run') args.dryRun = true;
        else { console.error(`${TAG} bad arg: ${a}`); process.exit(1); }
    }
    return args;
}

async function discoverRelease() {
    const res = await fetch(RELDATE_URL);
    if (!res.ok) { console.error(`${TAG} reldate HTTP ${res.status} ${res.statusText}`); return null; }
    const text = await res.text();
    const m = text.match(/Release\s+(\d{4}_\d{2})/);
    return m ? m[1] : null;
}

function buildLicenseMetadata(release, ingestionDate) {
    return {
        upstream_source: 'uniprot_swissprot',
        upstream_license: UNIPROT_LICENSE,
        upstream_release: release,
        ingestion_date: ingestionDate,
        attribution: ATTRIBUTION,
        extracted_content: [
            'accession', 'secondary_accessions', 'recommended_name', 'ec_numbers',
            'gene_symbol', 'organism(scientific_name,taxon_id)', 'sequence_length',
            'sequence_mol_weight', 'function_descriptions', 'db_xrefs(all_sources)',
        ],
    };
}

// Streaming consumer: split the gunzipped .dat on //, parse + write each record to the
// JSONL IN INPUT ORDER, accumulate telemetry. A parse throw is fatal (no silent drop).
function makeDatConsumer(stream, state) {
    return async (decompressed) => {
        let remainder = '';
        decompressed.setEncoding('utf-8');
        for await (const chunk of decompressed) {
            state.uncompressedBytes += Buffer.byteLength(chunk, 'utf-8');
            const { blocks, remainder: rem } = splitRecordBlocks(remainder + chunk);
            remainder = rem;
            for (const block of blocks) await consumeBlock(stream, state, block);
        }
        // Flush any trailing complete record (file may end without a final //).
        const { blocks } = splitRecordBlocks(remainder + '\n' + RECORD_DELIMITER);
        for (const block of blocks) await consumeBlock(stream, state, block);
    };
}

async function consumeBlock(stream, state, block) {
    if (!isNonEmptyBlock(block)) return;
    let rec;
    try {
        rec = parseUniprotRecord(block);
    } catch (err) {
        // No silent drop: a malformed record HARD-FAILS the whole harvest.
        throw new Error(`fatal parse error at record #${state.recordCount + 1}: ${err.message}`);
    }
    state.recordCount += 1;
    if (rec._meta.no_ox) state.noOxCount += 1;
    tallyTaxon(state.taxa, rec);
    if (!stream.write(recordToJsonl(rec) + '\n')) await once(stream, 'drain');
}

function zstdCompressFile(input, output, level) {
    const result = spawnSync('zstd', [`-${level}`, '-f', '-o', output, input]);
    if (result.error) { console.error(`${TAG} zstd spawn: ${result.error.message}`); process.exit(4); }
    if (result.status !== 0) {
        console.error(`${TAG} zstd exit ${result.status}: ${result.stderr?.toString()}`); process.exit(4);
    }
}

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) { console.error(`${TAG} missing env: ${missing.join(', ')}`); process.exit(5); }
    return new S3Client({
        region: 'auto', endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

function buildCursor(release, state, jsonlBytes, zstBytes, dataKey, ingestedAt) {
    const perTaxon = {};
    for (const [k, v] of [...state.taxa.entries()].sort((a, b) => (b[1] - a[1]))) {
        perTaxon[String(k)] = v;
    }
    return {
        source: 'uniprot_swissprot',
        release_version: release,
        record_count: state.recordCount,
        no_ox_count: state.noOxCount,
        dropped_malformed_count: 0, // a malformed record hard-fails; published artifact has 0
        per_taxon_count: perTaxon,
        byte_size_uncompressed_stream: state.uncompressedBytes,
        byte_size_jsonl: jsonlBytes,
        byte_size_compressed: zstBytes,
        r2_key: dataKey,
        schema_version: SCHEMA_VERSION,
        last_success_at: ingestedAt,
    };
}

async function main() {
    const args = parseArgs();
    const ingestedAt = new Date().toISOString();
    const ingestionDate = ingestedAt.slice(0, 10);

    let release = args.release;
    if (!release) {
        release = await discoverRelease();
        if (!release) { console.error(`${TAG} could not resolve release from reldate.txt`); process.exit(2); }
    }
    console.log(`${TAG} START release=${release} dry-run=${args.dryRun} url=${DAT_GZ_URL}`);

    const tmpJsonl = join(tmpdir(), `uniprot-sprot-${process.pid}.jsonl`);
    const tmpZst = `${tmpJsonl}.zst`;
    const state = {
        recordCount: 0, noOxCount: 0,
        uncompressedBytes: 0, taxa: newTaxonTally(),
    };

    try {
        const stream = createWriteStream(tmpJsonl, { encoding: 'utf-8' });
        const header = '#' + JSON.stringify({ license_metadata: buildLicenseMetadata(release, ingestionDate) }) + '\n';
        if (!stream.write(header)) await once(stream, 'drain');

        try {
            await downloadAndConsume(DAT_GZ_URL, {
                consume: makeDatConsumer(stream, state),
                onRetry: (n, err) => console.warn(`${TAG} retry #${n} after: ${err.message}`),
            });
        } catch (err) {
            console.error(`${TAG} FATAL during stream/parse: ${err.message}`);
            process.exit(3);
        }
        stream.end();
        await once(stream, 'finish');

        // HARD-FAIL on zero records (never publish an empty artifact).
        if (state.recordCount === 0) {
            console.error(`${TAG} ANOMALY: zero records parsed from a non-empty stream`);
            process.exit(3);
        }
        const jsonlBytes = statSync(tmpJsonl).size;
        console.log(`${TAG} parsed records=${state.recordCount} no_ox=${state.noOxCount} `
            + `uncompressed_stream=${(state.uncompressedBytes / 1e9).toFixed(2)}GB jsonl=${jsonlBytes}B`);
        const topTaxa = [...state.taxa.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        console.log(`${TAG} top taxa (telemetry, NOT a filter): ${JSON.stringify(topTaxa)}`);

        zstdCompressFile(tmpJsonl, tmpZst, ZSTD_LEVEL);
        const zstBytes = statSync(tmpZst).size;
        const ratio = (zstBytes / jsonlBytes * 100).toFixed(1);
        console.log(`${TAG} zstd(-${ZSTD_LEVEL}) jsonl=${jsonlBytes}B -> zst=${zstBytes}B ratio=${ratio}%`);

        const dataKey = `processed/bulk/uniprot/${release}/sprot.jsonl.zst`;
        const cursor = buildCursor(release, state, jsonlBytes, zstBytes, dataKey, ingestedAt);

        if (args.dryRun) {
            console.log(`${TAG} DRY-RUN: would PUT ${dataKey} (${zstBytes}B) + ${CURSOR_KEY}`);
            console.log(`${TAG} cursor preview: ${JSON.stringify(cursor)}`);
            return;
        }

        const s3 = makeR2Client();
        const bucket = process.env.R2_BUCKET;
        await s3.send(new PutObjectCommand({
            Bucket: bucket, Key: dataKey, Body: readFileSync(tmpZst),
            ContentType: 'application/zstd', ContentEncoding: 'zstd',
        }));
        console.log(`${TAG} uploaded ${dataKey}`);
        await s3.send(new PutObjectCommand({
            Bucket: bucket, Key: CURSOR_KEY,
            Body: Buffer.from(JSON.stringify(cursor, null, 2), 'utf-8'),
            ContentType: 'application/json',
        }));
        console.log(`${TAG} cursor written ${CURSOR_KEY}`);
        console.log(`${TAG} SUCCESS`);
    } finally {
        for (const p of [tmpJsonl, tmpZst]) { try { unlinkSync(p); } catch { /* ignore */ } }
    }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '');
if (isDirectRun) main().catch(err => { console.error(`${TAG} FATAL:`, err.message); process.exit(3); });
