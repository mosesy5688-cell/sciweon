/**
 * RxNorm FULL RRF + UMLS-auth diagnostic probe (PR-RXN-2a, diagnostic-only).
 *
 * De-risks the Full-RRF switch (PR-RXN-2b) per [[external_dataset_diagnostic_first]].
 *   1. UMLS auth -- probes BOTH download paths head-to-head in one run:
 *      (A) the API-key download proxy
 *          https://uts-ws.nlm.nih.gov/download?url=<inner>&apiKey=<key>
 *      (B) the legacy CAS TGT/Service-Ticket flow.
 *      HTTP 200/206 is the SOLE verdict; reports which path won. (Run 26667631988:
 *      BOTH returned 200; apiKey-proxy locked.)
 *   2. UNII payoff -- measures the CORRECT source. PR-RXN-2a-1 scanned RXNSAT
 *      ATN='UNII' and found 0 of 7.6M rows: RxNorm carries UNII NOT in RXNSAT but
 *      in RXNCONSO under SAB='MTHSPL' TTY='SU' CODE (the PR-RXN-1f axis). So this
 *      probe streams RXNCONSO.RRF and counts the Full release's MTHSPL/SU canonical
 *      UNII keys vs today's narrow Prescribable-subset baseline of 7234.
 *
 * Telemetry-only: no R2 writes, no cursor mutation, no schema change.
 * Reuses production RXNCONSO_COLUMNS + isCanonicalUnii SSoT (csv-parse named
 * columns, NOT positional line.split -- column boundary identical to the
 * harvester, immune to the PR-RXN-1 column-order trap) + release-discovery helpers.
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
import { RXNCONSO_COLUMNS, findRrfEntry, isCanonicalUnii } from './lib/rxnorm-rrf-streams.js';
import { firstMondayOfMonth, formatMMDDYYYY, formatIsoDate } from './lib/rxnorm-release-discovery.js';

const SAMPLE_LIMIT = 100;
const FULL_RRF_BASE = 'https://download.nlm.nih.gov/umls/kss/rxnorm/';
const DOWNLOAD_PROXY = 'https://uts-ws.nlm.nih.gov/download';
const CAS_APIKEY_URL = 'https://utslogin.nlm.nih.gov/cas/v1/api-key';
const PRESCRIBABLE_BASELINE = 7234;

/**
 * Pure classifier for one RXNCONSO row on the UNII axis. is_mthspl_su iff the
 * row is SAB='MTHSPL' TTY='SU'; unii_shape iff that row's CODE is a canonical
 * NLM UNII (trim+upper). A non-MTHSPL/SU row never counts as UNII even when its
 * CODE happens to be UNII-shaped (the column-trap guard). Locked under unit test.
 */
export function classifyMthsplConsoRow(row) {
    const isMthsplSu = row?.SAB === 'MTHSPL' && row?.TTY === 'SU';
    const code = typeof row?.CODE === 'string' ? row.CODE.trim().toUpperCase() : '';
    return { is_mthspl_su: isMthsplSu, unii_shape: isMthsplSu && isCanonicalUnii(code), unii: code };
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

// Stream RXNCONSO.RRF; count Full-release MTHSPL/SU canonical UNII keys vs baseline.
async function dumpMthsplConsoUnii(tmpZip) {
    const zip = new StreamZip.async({ file: tmpZip });
    let total = 0, mthsplSu = 0, shapeOk = 0, sample = 0;
    const distinctUnii = new Set();
    const uniiByRxcui = new Map();
    try {
        const target = findRrfEntry(await zip.entries(), 'RXNCONSO.RRF');
        if (!target) throw new Error('RXNCONSO.RRF entry not found in ZIP');
        const parser = (await zip.stream(target.name)).pipe(parseCsv({
            delimiter: '|', columns: RXNCONSO_COLUMNS, trim: false,
            relax_quotes: true, relax_column_count: true, skip_empty_lines: true,
        }));
        for await (const row of parser) {
            total++;
            if (row.SUPPRESS && row.SUPPRESS !== 'N') continue;
            const c = classifyMthsplConsoRow(row);
            if (!c.is_mthspl_su) continue;
            mthsplSu++;
            if (c.unii_shape) {
                shapeOk++;
                distinctUnii.add(c.unii);
                if (!uniiByRxcui.has(row.RXCUI)) uniiByRxcui.set(row.RXCUI, c.unii);
            }
            if (sample < SAMPLE_LIMIT) {
                sample++;
                console.log(`[MTHSPL-SU-${sample}] RXCUI=${row.RXCUI} CODE='${row.CODE}' shape=${c.unii_shape} STR=${(row.STR ?? '').slice(0, 60)}`);
            }
        }
    } finally { await zip.close(); }
    const pct = mthsplSu > 0 ? ((shapeOk / mthsplSu) * 100).toFixed(2) : '0.00';
    console.log(`[DIAGNOSTIC-SUMMARY] total_rxnconso_rows=${total} mthspl_su_rows=${mthsplSu} unii_shape_ok=${shapeOk} unii_shape_pct=${pct}% distinct_full_unii=${distinctUnii.size} distinct_unii_rxcui=${uniiByRxcui.size} vs_prescribable_baseline=${PRESCRIBABLE_BASELINE}`);
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
        await dumpMthsplConsoUnii(tmpZip);
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
