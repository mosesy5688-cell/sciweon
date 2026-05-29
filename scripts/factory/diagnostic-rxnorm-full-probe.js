/**
 * RxNorm FULL RRF + UMLS-auth diagnostic probe (PR-RXN-2a, diagnostic-only).
 *
 * De-risks the two unverifiable externals before any production switch
 * (PR-RXN-2b) per [[external_dataset_diagnostic_first]]:
 *   1. UMLS auth -- probes BOTH download paths head-to-head in one run:
 *      (A) the API-key download proxy
 *          https://uts-ws.nlm.nih.gov/download?url=<inner>&apiKey=<key>
 *      (B) the legacy CAS TGT/Service-Ticket flow (utslogin -> ticket -> GET).
 *      HTTP 200/206 is the SOLE verdict; reports which path won. Do NOT trust
 *      the doc -- empirical status only.
 *   2. UNII payoff -- streams RXNSAT.RRF from the Full archive and dumps the
 *      ATN='UNII' row count, canonical-shape pct (re-confirms the locked
 *      ...ATN,SAB,ATV... column order survives the Full release), distinct
 *      UNII->ingredient-RXCUI count (vs today's narrow 7234 MTHSPL keys), the
 *      SAB distribution of UNII rows, and the archive size.
 *
 * Telemetry-only: no R2 writes, no cursor mutation, no schema change.
 * Reuses production RXNSAT_COLUMNS + isCanonicalUnii SSoT (column boundary
 * identical to rxnorm-harvest.js) + release-discovery date helpers.
 *
 * Exit: 0 OK / 1 args (no UMLS_API_KEY) / 2 auth (both paths failed) / 3 download-or-parse
 */

import { createWriteStream, statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import StreamZip from 'node-stream-zip';
import { parse as parseCsv } from 'csv-parse';
import { RXNSAT_COLUMNS, findRrfEntry, isCanonicalUnii } from './lib/rxnorm-rrf-streams.js';
import { firstMondayOfMonth, formatMMDDYYYY, formatIsoDate } from './lib/rxnorm-release-discovery.js';

const SAMPLE_LIMIT = 100;
const FULL_RRF_BASE = 'https://download.nlm.nih.gov/umls/kss/rxnorm/';
const DOWNLOAD_PROXY = 'https://uts-ws.nlm.nih.gov/download';
const CAS_APIKEY_URL = 'https://utslogin.nlm.nih.gov/cas/v1/api-key';

/**
 * Pure classifier for one RXNSAT row. is_unii_attr iff ATN==='UNII';
 * unii_shape iff the ATV value is a canonical NLM UNII (trim+upper).
 * Non-object / missing fields -> both false. Locked under unit test so the
 * column boundary cannot drift from the harvester.
 */
export function classifyRxnsatUniiRow(row) {
    const isUnii = row?.ATN === 'UNII';
    const atv = typeof row?.ATV === 'string' ? row.ATV.trim().toUpperCase() : '';
    return { is_unii_attr: isUnii, unii_shape: isUnii && isCanonicalUnii(atv), unii: atv };
}

function defaultFullRrfUrl(now = new Date()) {
    const monday = firstMondayOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
    return { url: `${FULL_RRF_BASE}RxNorm_full_${formatMMDDYYYY(monday)}.zip`, release_date: formatIsoDate(monday) };
}

function parseArgs() {
    let fullUrl = null;
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--full-url=')) fullUrl = a.slice('--full-url='.length);
    }
    const apiKey = process.env.UMLS_API_KEY;
    if (!apiKey) throw new Error('UMLS_API_KEY env required');
    return { fullUrl, apiKey };
}

// Cheap status-only probe (Range so a 200-no-range never downloads the body).
async function statusProbe(url, init = {}) {
    const res = await fetch(url, { ...init, headers: { Range: 'bytes=0-1', ...(init.headers || {}) } });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return res.status;
}

function proxyUrl(inner, apiKey) {
    return `${DOWNLOAD_PROXY}?url=${encodeURIComponent(inner)}&apiKey=${encodeURIComponent(apiKey)}`;
}

// CAS flow: api-key -> TGT (parse form action) -> single-use Service Ticket.
async function mintServiceTicket(apiKey, service) {
    const form = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const tgtRes = await fetch(CAS_APIKEY_URL, form(`apikey=${encodeURIComponent(apiKey)}`));
    if (tgtRes.status !== 201 && !tgtRes.ok) throw new Error(`CAS TGT HTTP ${tgtRes.status}`);
    const m = (await tgtRes.text()).match(/action="([^"]+)"/);
    if (!m) throw new Error('CAS TGT action URL not found in response');
    const stRes = await fetch(m[1], form(`service=${encodeURIComponent(service)}`));
    if (!stRes.ok) throw new Error(`CAS ST HTTP ${stRes.status}`);
    return (await stRes.text()).trim();
}

async function downloadStream(url, tmpPath, init = {}) {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`download HTTP ${res.status} ${res.statusText}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpPath));
    return statSync(tmpPath).size;
}

// Probe both auth paths; return the winning { label, download() } or null.
async function resolveAuth(inner, apiKey) {
    let statusA = 'skip', statusB = 'skip';
    try { statusA = await statusProbe(proxyUrl(inner, apiKey)); }
    catch (e) { statusA = `err:${e.message}`; }
    try {
        const st = await mintServiceTicket(apiKey, inner);
        statusB = await statusProbe(`${inner}?ticket=${encodeURIComponent(st)}`);
    } catch (e) { statusB = `err:${e.message}`; }
    console.log(`[AUTH-PROBE] pathA(apiKey-proxy)=${statusA} | pathB(cas-tgt)=${statusB} | inner=${inner}`);

    const ok = (s) => s === 200 || s === 206;
    if (ok(statusA)) {
        return { label: 'apiKey-proxy', download: (p) => downloadStream(proxyUrl(inner, apiKey), p) };
    }
    if (ok(statusB)) {
        return { label: 'cas-tgt', download: async (p) => {
            const st = await mintServiceTicket(apiKey, inner);  // fresh single-use ticket
            return downloadStream(`${inner}?ticket=${encodeURIComponent(st)}`, p);
        } };
    }
    return null;
}

async function dumpRxnsatUnii(tmpZip) {
    const zip = new StreamZip.async({ file: tmpZip });
    let total = 0, uniiRows = 0, shapeOk = 0, sample = 0;
    const distinctUnii = new Set();
    const uniiByRxcui = new Map();
    const sabCounts = new Map();
    try {
        const target = findRrfEntry(await zip.entries(), 'RXNSAT.RRF');
        if (!target) throw new Error('RXNSAT.RRF entry not found in ZIP');
        const parser = (await zip.stream(target.name)).pipe(parseCsv({
            delimiter: '|', columns: RXNSAT_COLUMNS, trim: false,
            relax_quotes: true, relax_column_count: true, skip_empty_lines: true,
        }));
        for await (const row of parser) {
            total++;
            const c = classifyRxnsatUniiRow(row);
            if (!c.is_unii_attr) continue;
            uniiRows++;
            sabCounts.set(row.SAB, (sabCounts.get(row.SAB) || 0) + 1);
            if (c.unii_shape) {
                shapeOk++;
                distinctUnii.add(c.unii);
                if (!uniiByRxcui.has(row.RXCUI)) uniiByRxcui.set(row.RXCUI, c.unii);
            }
            if (sample < SAMPLE_LIMIT) {
                sample++;
                console.log(`[RXNSAT-UNII-${sample}] RXCUI=${row.RXCUI} ATN=${row.ATN} SAB=${row.SAB} ATV='${row.ATV}' shape=${c.unii_shape}`);
            }
        }
    } finally { await zip.close(); }
    const pct = uniiRows > 0 ? ((shapeOk / uniiRows) * 100).toFixed(2) : '0.00';
    const sabDist = Object.fromEntries([...sabCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15));
    console.log(`[DIAGNOSTIC-SUMMARY] total_rxnsat_rows=${total} atn_unii_rows=${uniiRows} unii_shape_ok=${shapeOk} unii_shape_pct=${pct}% distinct_unii=${distinctUnii.size} distinct_unii_rxcui=${uniiByRxcui.size} (vs current MTHSPL 7234) sab_distribution=${JSON.stringify(sabDist)}`);
}

async function main() {
    const { fullUrl, apiKey } = parseArgs();
    const target = fullUrl ? { url: fullUrl, release_date: 'override' } : defaultFullRrfUrl();
    console.log(`[DIAGNOSTIC-START] full_rrf=${target.url} release=${target.release_date}`);

    const auth = await resolveAuth(target.url, apiKey);
    if (!auth) { console.error('[DIAGNOSTIC-FATAL] both UMLS auth paths failed (no 200/206)'); process.exit(2); }
    console.log(`[AUTH-VERDICT] winning_path=${auth.label}`);

    const tmpZip = join(tmpdir(), `rxnorm-full-diag-${Date.now()}.zip`);
    try {
        const bytes = await auth.download(tmpZip);
        console.log(`[DIAGNOSTIC] downloaded Full RRF zip=${bytes} bytes (~${(bytes / 1e9).toFixed(2)} GB) via ${auth.label}`);
        await dumpRxnsatUnii(tmpZip);
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
