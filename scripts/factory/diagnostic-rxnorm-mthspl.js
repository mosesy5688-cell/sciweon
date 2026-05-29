/**
 * RxNorm RXNCONSO MTHSPL diagnostic probe (PR-RXN-1e, diagnostic-only).
 *
 * Verifies the hypothesis that RxNorm Prescribable Subset RXNCONSO.RRF rows
 * with SAB='MTHSPL' carry FDA UNII codes in the CODE column. If confirmed,
 * a follow-up PR can repoint the bulk harvester's uniiToRxcui projection
 * at this source (compound-side ghost component zero-cost revival) instead
 * of relying on RXNSAT UNII attributes that the Prescribable subset omits.
 *
 * Telemetry-only: no R2 writes, no cursor mutation, no schema change.
 * Reuses production csv-parse RRF column SSoT (RXNCONSO_COLUMNS) so the
 * column boundary is identical to rxnorm-harvest.js. Caller passes the
 * archive URL via --probe-json (same arg shape as rxnorm-harvest.js).
 *
 * Output (stdout):
 *   [DIAGNOSTIC-START] ...
 *   [MTHSPL-ROW-N] RXCUI=... | TTY=... | CODE='...' (UNII_SHAPE=true|false) | STR=...
 *   [DIAGNOSTIC-SUMMARY] total_mthspl_rows=N unii_shape_matches=M unii_shape_pct=P% distinct_tty_count=T tty_distribution={...}
 *   [DIAGNOSTIC-END]
 *
 * Exit codes: 0 OK / 1 args / 2 download / 3 parse
 */

import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import StreamZip from 'node-stream-zip';
import { RXNCONSO_COLUMNS, findRrfEntry } from './lib/rxnorm-rrf-streams.js';
import { parse as parseCsv } from 'csv-parse';

const SAMPLE_LIMIT = 100;
const UNII_SHAPE = /^[A-Z0-9]{10}$/;

/**
 * Pure classifier for an RXNCONSO CODE value under SAB='MTHSPL'. Returns
 * `{ unii_shape, length }`. Treats non-string input as zero-length shape miss.
 * Locked under unit test for column boundary safety.
 */
export function classifyMthsplCode(code) {
    if (typeof code !== 'string') return { unii_shape: false, length: 0 };
    return { unii_shape: UNII_SHAPE.test(code), length: code.length };
}

function parseArgs() {
    const args = { probeJson: null };
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--probe-json=')) args.probeJson = a.slice('--probe-json='.length);
    }
    if (!args.probeJson) throw new Error('--probe-json=<path> required');
    return args;
}

async function fetchArchive(url, tmpPath) {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpPath, buf);
    return buf.length;
}

async function main() {
    const args = parseArgs();
    const probe = JSON.parse(readFileSync(args.probeJson, 'utf-8'));
    const { release_date, archive_url } = probe;
    if (!release_date || !archive_url) throw new Error('probe JSON missing release_date / archive_url');
    console.log(`[DIAGNOSTIC-START] release=${release_date} url=${archive_url}`);

    const tmpZip = join(tmpdir(), `rxnorm-diag-${Date.now()}.zip`);
    try {
        const zipBytes = await fetchArchive(archive_url, tmpZip);
        console.log(`[DIAGNOSTIC] downloaded zip=${zipBytes} bytes`);

        const zip = new StreamZip.async({ file: tmpZip });
        let sampleCount = 0;
        let totalMthsplRows = 0;
        let uniiShapeMatches = 0;
        const ttyCounts = new Map();

        try {
            const entries = await zip.entries();
            const target = findRrfEntry(entries, 'RXNCONSO.RRF');
            if (!target) throw new Error('RXNCONSO.RRF entry not found in ZIP');

            const stream = await zip.stream(target.name);
            const parser = stream.pipe(parseCsv({
                delimiter: '|', columns: RXNCONSO_COLUMNS, trim: false,
                relax_quotes: true, relax_column_count: true, skip_empty_lines: true,
            }));

            for await (const row of parser) {
                if (row.SAB !== 'MTHSPL') continue;
                if (row.SUPPRESS && row.SUPPRESS !== 'N') continue;
                totalMthsplRows++;
                const { unii_shape } = classifyMthsplCode(row.CODE);
                if (unii_shape) uniiShapeMatches++;
                ttyCounts.set(row.TTY, (ttyCounts.get(row.TTY) || 0) + 1);

                if (sampleCount < SAMPLE_LIMIT) {
                    sampleCount++;
                    const strSnip = (row.STR ?? '').slice(0, 80);
                    console.log(`[MTHSPL-ROW-${sampleCount}] RXCUI=${row.RXCUI} | TTY=${row.TTY} | CODE='${row.CODE}' (UNII_SHAPE=${unii_shape}) | STR=${strSnip}`);
                }
            }
        } finally {
            await zip.close();
        }

        const pct = totalMthsplRows > 0
            ? ((uniiShapeMatches / totalMthsplRows) * 100).toFixed(2)
            : '0.00';
        const ttyDist = Object.fromEntries(
            [...ttyCounts.entries()].sort((a, b) => b[1] - a[1])
        );
        console.log(`[DIAGNOSTIC-SUMMARY] total_mthspl_rows=${totalMthsplRows} unii_shape_matches=${uniiShapeMatches} unii_shape_pct=${pct}% distinct_tty_count=${ttyCounts.size} tty_distribution=${JSON.stringify(ttyDist)}`);
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
        process.exit(err.message.includes('--probe-json') ? 1 : 2);
    });
}
