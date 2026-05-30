/**
 * DailyMed-linked 502-ceiling diagnostic: MTHSPL NDC recovery + format topology
 * (PR-MD-1a-probe, diagnostic-only).
 *
 * F2 telemetry (run 26671680627) showed the DailyMed cross-link ceiling is now
 * LABEL-side: NDC->RxCUI hydration excluded_unmapped_ndc=1482 (malformed=0,
 * unmapped=1482) -> DailyMed RxCUI=502. The NDCs are well-formed but absent from
 * the bulk map because loadIngredientAttributes hard-locks NDC_ACCEPTED_SABS=
 * ['RXNORM']. The 2b harvest SAB distribution showed MTHSPL carries 239,449 NDC
 * rows (DailyMed = FDA SPL = same source as MTHSPL). This probe measures, before
 * any production widen, the twin axes that gate PR-MD-1b:
 *   Dimension A (yield): how many DailyMed labels gain >=1 rxcui ONLY via MTHSPL.
 *   Dimension B (format): the format topology of MTHSPL NDCs + whether the
 *     existing normalizeNdcTo11Digit (SSoT) can canonicalize them (hyphenless-10
 *     ambiguous would silently fail the join -> secondary drop risk).
 *
 * Telemetry-only: no R2 writes, no cursor mutation, no schema change.
 * Reuses umls-auth + Full RRF stream + RXNSAT_COLUMNS + normalizeNdcTo11Digit
 * (the SSoT under test) + loadRxnormBulkMaps (current RXNORM control map) + the
 * R2 client pattern. Auth/download mirror diagnostic-rxnorm-full-probe.js.
 *
 * Exit: 0 OK / 1 args (no UMLS_API_KEY) / 2 auth / 3 download-or-parse
 */

import { createWriteStream, statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { gunzipSync } from 'zlib';
import StreamZip from 'node-stream-zip';
import { parse as parseCsv } from 'csv-parse';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { RXNSAT_COLUMNS, findRrfEntry } from './lib/rxnorm-rrf-streams.js';
import { normalizeNdcTo11Digit } from './lib/ndc-normalize.js';
import { firstMondayOfMonth, formatMMDDYYYY, formatIsoDate } from './lib/rxnorm-release-discovery.js';
import { umlsDownloadUrl } from './lib/umls-auth.js';
import { loadRxnormBulkMaps, lookupByNdc } from '../ingestion/adapters/rxnorm-bulk-adapter.js';

const FULL_RRF_BASE = 'https://download.nlm.nih.gov/umls/kss/rxnorm/';
const SAMPLE_LIMIT = 20;

/**
 * Pure shape classifier for a raw NDC string. Assigns a human-readable `shape`
 * bucket for telemetry, but DELEGATES normalizability entirely to the SSoT
 * normalizeNdcTo11Digit -- it does NOT re-implement the segment-width rules
 * (a 3-segment string like 5-4-3 is shape 'hyphenated-3seg' yet normalizable=false
 * because the SSoT rejects it). canonical === normalizeNdcTo11Digit(raw).
 */
export function classifyNdcFormat(rawNdc) {
    if (typeof rawNdc !== 'string' || rawNdc.trim().length === 0) {
        return { shape: 'invalid', normalizable: false, canonical: null };
    }
    const cleaned = rawNdc.trim();
    const canonical = normalizeNdcTo11Digit(cleaned);
    let shape = 'other';
    if (/^\d+-\d+-\d+$/.test(cleaned)) shape = 'hyphenated-3seg';
    else if (/^\d{11}$/.test(cleaned)) shape = 'hyphenless-11';
    else if (/^\d{10}$/.test(cleaned)) shape = 'hyphenless-10';
    else if (/^\d{12}$/.test(cleaned)) shape = 'hyphenless-12';
    return { shape, normalizable: canonical !== null, canonical };
}

function parseArgs() {
    let fullUrl = null;
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--full-url=')) fullUrl = a.slice('--full-url='.length);
    }
    if (!process.env.UMLS_API_KEY) throw new Error('UMLS_API_KEY env required');
    return { fullUrl };
}

function defaultFullRrfUrl(now = new Date()) {
    const monday = firstMondayOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
    return { url: `${FULL_RRF_BASE}RxNorm_full_${formatMMDDYYYY(monday)}.zip`, release_date: formatIsoDate(monday) };
}

function makeR2Client() {
    return new S3Client({
        endpoint: process.env.R2_ENDPOINT, region: 'auto',
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

async function r2GetBuffer(client, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    return streamToBuffer(res.Body);
}

async function downloadFullRrf(innerUrl, tmpPath) {
    const res = await fetch(umlsDownloadUrl(innerUrl));
    if (!res.ok) throw new Error(`Full RRF download HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpPath));
    return statSync(tmpPath).size;
}

// Load cumulative DailyMed label records (each carries raw ndcs[]) from the
// latest published snapshot via the latest.json pointer.
async function loadDailymedLabels(client) {
    const latest = JSON.parse((await r2GetBuffer(client, 'snapshots/latest.json')).toString('utf-8'));
    const date = latest.latest_snapshot_date;
    if (!date) throw new Error(`snapshots/latest.json missing latest_snapshot_date: ${JSON.stringify(latest)}`);
    const gz = await r2GetBuffer(client, `snapshots/${date}/drug-labels.jsonl.gz`);
    const text = gunzipSync(gz).toString('utf-8');
    const labels = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    console.log(`[DIAGNOSTIC] loaded ${labels.length} DailyMed labels from snapshots/${date}/`);
    return labels;
}

// Stream RXNSAT.RRF; build MTHSPL NDC(11-digit) -> Set<rxcui> + format topology.
async function buildMthsplNdcMap(tmpZip) {
    const zip = new StreamZip.async({ file: tmpZip });
    const mthsplNdc = new Map();           // canonical 11-digit -> Set<rxcui>
    const shapeCounts = new Map();         // shape -> count
    let total = 0, normalizable = 0, rejected = 0;
    const rejectedSamples = [];
    try {
        const target = findRrfEntry(await zip.entries(), 'RXNSAT.RRF');
        if (!target) throw new Error('RXNSAT.RRF entry not found');
        const parser = (await zip.stream(target.name)).pipe(parseCsv({
            delimiter: '|', columns: RXNSAT_COLUMNS, trim: false,
            relax_quotes: true, relax_column_count: true, skip_empty_lines: true,
        }));
        for await (const row of parser) {
            if (row.ATN !== 'NDC' || row.SAB !== 'MTHSPL') continue;
            if (row.SUPPRESS && row.SUPPRESS !== 'N') continue;
            total++;
            const c = classifyNdcFormat(row.ATV);
            shapeCounts.set(c.shape, (shapeCounts.get(c.shape) || 0) + 1);
            if (c.normalizable) {
                normalizable++;
                if (!mthsplNdc.has(c.canonical)) mthsplNdc.set(c.canonical, new Set());
                if (row.RXCUI) mthsplNdc.get(c.canonical).add(row.RXCUI);
            } else {
                rejected++;
                if (rejectedSamples.length < SAMPLE_LIMIT) rejectedSamples.push(`${row.ATV}[${c.shape}]`);
            }
        }
    } finally { await zip.close(); }
    const shapeDist = Object.fromEntries([...shapeCounts.entries()].sort((a, b) => b[1] - a[1]));
    console.log(`[DIM-B FORMAT] mthspl_ndc_rows=${total} normalizable=${normalizable} rejected=${rejected} shape_dist=${JSON.stringify(shapeDist)}`);
    if (rejectedSamples.length) console.log(`[DIM-B FORMAT] rejected_samples=${JSON.stringify(rejectedSamples)}`);
    return mthsplNdc;
}

// Dimension A: per label, does it gain rxcui via RXNORM (control) and/or MTHSPL?
function measureYield(labels, rxnormMaps, mthsplNdc) {
    let viaRxnorm = 0, viaMthsplNet = 0, orphan = 0, noNdc = 0;
    for (const lab of labels) {
        const ndcs = Array.isArray(lab.ndcs) ? lab.ndcs : [];
        if (ndcs.length === 0) { noNdc++; continue; }
        let rxnormHit = false, mthsplHit = false;
        for (const ndc of ndcs) {
            if (lookupByNdc(rxnormMaps, ndc).size > 0) rxnormHit = true;
            const can = normalizeNdcTo11Digit(typeof ndc === 'string' ? ndc.trim() : '');
            if (can && (mthsplNdc.get(can)?.size ?? 0) > 0) mthsplHit = true;
        }
        if (rxnormHit) viaRxnorm++;
        else if (mthsplHit) viaMthsplNet++;   // recoverable ONLY via MTHSPL
        else orphan++;
    }
    console.log(`[DIM-A YIELD] labels=${labels.length} no_ndc=${noNdc} via_rxnorm(control)=${viaRxnorm} net_recoverable_via_mthspl=${viaMthsplNet} residual_orphan=${orphan}`);
    return { viaRxnorm, viaMthsplNet, orphan, noNdc };
}

async function main() {
    const { fullUrl } = parseArgs();
    const target = fullUrl ? { url: fullUrl, release_date: 'override' } : defaultFullRrfUrl();
    console.log(`[DIAGNOSTIC-START] full_rrf=${target.url}`);

    const client = makeR2Client();
    const labels = await loadDailymedLabels(client);
    const rxnormMaps = await loadRxnormBulkMaps();
    console.log(`[DIAGNOSTIC] control RXNORM map: ndc_keys=${rxnormMaps.ndcToRxcuis.size}`);

    const tmpZip = join(tmpdir(), `rxnorm-full-md-${Date.now()}.zip`);
    try {
        const bytes = await downloadFullRrf(target.url, tmpZip);
        console.log(`[DIAGNOSTIC] Full RRF zip=${bytes} bytes (~${(bytes / 1e9).toFixed(2)} GB)`);
        const mthsplNdc = await buildMthsplNdcMap(tmpZip);
        console.log(`[DIAGNOSTIC] mthspl normalizable NDC keys=${mthsplNdc.size}`);
        const y = measureYield(labels, rxnormMaps, mthsplNdc);
        console.log(`[DIAGNOSTIC-SUMMARY] net_recoverable_via_mthspl=${y.viaMthsplNet} (control via_rxnorm=${y.viaRxnorm}, orphan=${y.orphan}); mthspl_ndc_keys=${mthsplNdc.size}`);
        console.log('[DIAGNOSTIC-END]');
    } finally {
        try { unlinkSync(tmpZip); } catch { /* ignore */ }
    }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => {
        console.error('[DIAGNOSTIC-FATAL]', err.message);
        process.exit(err.message.includes('UMLS_API_KEY') ? 1 : 3);
    });
}
