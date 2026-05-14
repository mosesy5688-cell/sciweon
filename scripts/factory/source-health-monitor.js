/**
 * Source Health Monitor V0.5.0
 *
 * Scans entity files for provenance.sources[] entries and reports per-source
 * record counts + freshness. Surfaces stale or missing data sources so the
 * factory pipeline can be tuned before users see degraded data.
 *
 * Inputs (read-only, all optional):
 *   output/linked/*.jsonl      - latest enriched / linked pipeline output
 *   snapshots/<date>/*.jsonl.gz - daily snapshot archives
 *
 * Output:
 *   stdout                     - human-readable table
 *   output/source-health.json  - machine-readable report (for CI / dashboards)
 *
 * Exit codes:
 *   0   all sources HEALTHY
 *   1   one or more STALE
 *   2   one or more CRITICAL (older than 96h)
 *   3   script error
 *
 * Usage:
 *   node scripts/factory/source-health-monitor.js
 *   npm run health
 */

import fs from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';
import readline from 'readline';
import { createGunzip } from 'zlib';

const HEALTHY_MAX_HOURS = 36;
const STALE_MAX_HOURS = 96;

const KNOWN_SOURCES = [
    'pubchem', 'pubchem_bioassay', 'chembl', 'clinicaltrials', 'ctis',
    'kegg', 'openalex', 'openfda', 'pubmed', 'retraction_watch',
    'rxnorm', 'semantic_scholar', 's2', 'unichem', 'uniprot',
];

const SCAN_DIRS = ['output/linked', 'snapshots'];

function statusFor(hours) {
    if (hours == null) return 'MISSING';
    if (hours <= HEALTHY_MAX_HOURS) return 'HEALTHY';
    if (hours <= STALE_MAX_HOURS) return 'STALE';
    return 'CRITICAL';
}

function openLineStream(filePath) {
    const isGz = filePath.endsWith('.gz');
    const raw = createReadStream(filePath);
    const stream = isGz ? raw.pipe(createGunzip()) : raw;
    return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

async function collectStats(filePath, stats) {
    let count = 0;
    try {
        const rl = openLineStream(filePath);
        for await (const line of rl) {
            if (!line.trim()) continue;
            try {
                const entity = JSON.parse(line);
                count++;
                const sources = entity?.provenance?.sources;
                if (!Array.isArray(sources)) continue;
                for (const s of sources) {
                    const id = s?.source;
                    if (!id) continue;
                    const slot = stats[id] ?? { records: 0, last_seen: null };
                    slot.records++;
                    const ts = s?.timestamp;
                    if (ts && (slot.last_seen == null || ts > slot.last_seen)) {
                        slot.last_seen = ts;
                    }
                    stats[id] = slot;
                }
            } catch {
                // malformed line - skip
            }
        }
    } catch (err) {
        console.warn(`[warn] could not read ${filePath}: ${err.message}`);
    }
    return count;
}

async function findFiles(dir) {
    const out = [];
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                out.push(...(await findFiles(full)));
            } else if (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.gz')) {
                out.push(full);
            }
        }
    } catch {
        // dir does not exist - silently skip
    }
    return out;
}

async function main() {
    console.log('[health] Source Health Monitor V0.5.0');
    const stats = {};
    let totalEntities = 0;
    for (const dir of SCAN_DIRS) {
        const files = await findFiles(dir);
        if (files.length === 0) {
            console.log(`[scan] ${dir} - no jsonl files found`);
            continue;
        }
        console.log(`[scan] ${dir} - ${files.length} files`);
        for (const f of files) {
            totalEntities += await collectStats(f, stats);
        }
    }
    for (const src of KNOWN_SOURCES) {
        if (!stats[src]) stats[src] = { records: 0, last_seen: null };
    }
    const now = Date.now();
    const rows = Object.entries(stats).map(([source, st]) => {
        const hours = st.last_seen
            ? (now - new Date(st.last_seen).getTime()) / 3600000
            : null;
        return {
            source,
            records: st.records,
            last_seen: st.last_seen,
            age_hours: hours == null ? null : Math.round(hours * 10) / 10,
            status: statusFor(hours),
        };
    });
    rows.sort((a, b) => a.source.localeCompare(b.source));

    console.log('');
    console.log('Source Health Report');
    console.log('====================');
    const head = 'SOURCE                    RECORDS    LAST SEEN              AGE(h)    STATUS';
    console.log(head);
    for (const r of rows) {
        const last = r.last_seen ? r.last_seen.slice(0, 19) : 'NEVER';
        const age = r.age_hours == null ? '    N/A' : String(r.age_hours).padStart(7);
        console.log(
            `${r.source.padEnd(25)} ${String(r.records).padStart(7)} ${last.padEnd(22)} ${age}    ${r.status}`
        );
    }
    console.log('');
    const seen = rows.filter(r => r.records > 0).length;
    console.log(`Total entities scanned: ${totalEntities}`);
    console.log(`Sources with data: ${seen} of ${KNOWN_SOURCES.length} known`);

    const report = {
        generated_at: new Date().toISOString(),
        total_entities_scanned: totalEntities,
        thresholds: {
            healthy_max_hours: HEALTHY_MAX_HOURS,
            stale_max_hours: STALE_MAX_HOURS,
        },
        sources: rows,
    };
    const outPath = 'output/source-health.json';
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(report, null, 2));
    console.log(`Report: ${outPath}`);

    const hasCritical = rows.some(r => r.status === 'CRITICAL');
    const hasStale = rows.some(r => r.status === 'STALE');
    if (hasCritical) {
        console.log('[FAIL] One or more sources are CRITICAL.');
        process.exit(2);
    }
    if (hasStale) {
        console.log('[WARN] One or more sources are STALE.');
        process.exit(1);
    }
    console.log('[OK] All sources HEALTHY.');
    process.exit(0);
}

main().catch(err => {
    console.error('[ERROR]', err.message);
    process.exit(3);
});
