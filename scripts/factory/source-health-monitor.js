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
import { runBoundaryChecks } from './lib/boundary-health.js';

const HEALTHY_MAX_HOURS = 36;
const STALE_MAX_HOURS = 96;

// PR-OPS-1: 15 -> 13. Dropped `semantic_scholar` (canonical writer is `s2`
// per paper-linker.js) and `pubmed` (no adapter writes; openalex covers).
export const KNOWN_SOURCES = [
    'pubchem', 'pubchem_bioassay', 'chembl', 'clinicaltrials', 'ctis',
    'kegg', 'openalex', 'openfda', 'retraction_watch',
    'rxnorm', 's2', 'unichem', 'uniprot',
];

const SCAN_DIRS = ['output/linked', 'snapshots'];

// PR-OPS-1: records>0 + no timestamp is HEALTHY (enricher fingerprint
// without per-source ts is still presence-of-data). MISSING reserved for
// records===0 (true absence).
export function statusFor(hours, records) {
    if (records === 0) return 'MISSING';
    if (hours == null) return 'HEALTHY';
    if (hours <= HEALTHY_MAX_HOURS) return 'HEALTHY';
    if (hours <= STALE_MAX_HOURS) return 'STALE';
    return 'CRITICAL';
}

// PR-OPS-1 dual-path hydration. Merges creator lineage
// (provenance.sources[]) with enricher fingerprint (external_ids.sources[])
// for one entity; per-entity dedup so records++ exactly once per source.
// last_seen takes max across both paths. Pure + unit-testable.
export function collectEntityStats(entity, stats) {
    if (!entity) return;
    const fallbackTs = entity.provenance?.last_updated ?? entity.last_modified ?? null;
    const perEntity = new Map();
    const mergeTs = (source, ts) => {
        const cur = perEntity.has(source) ? perEntity.get(source) : null;
        if (!perEntity.has(source) || (ts && (cur == null || ts > cur))) {
            perEntity.set(source, ts ?? cur ?? null);
        }
    };
    for (const s of entity.provenance?.sources ?? []) {
        if (s?.source) mergeTs(s.source, s.timestamp ?? null);
    }
    for (const id of entity.external_ids?.sources ?? []) {
        if (typeof id === 'string' && id.length > 0) mergeTs(id, fallbackTs);
    }
    for (const [source, ts] of perEntity) {
        const slot = stats[source] ?? { records: 0, last_seen: null };
        slot.records++;
        if (ts && (slot.last_seen == null || ts > slot.last_seen)) slot.last_seen = ts;
        stats[source] = slot;
    }
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
                collectEntityStats(entity, stats);
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
            status: statusFor(hours, st.records),
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

    // Boundary checks (V0.5.2 — PR #19 deferred A.3): retry queue depth +
    // sustained-WARN aggregate. Skipped silently when R2 env is absent so
    // local `npm run health` still works on developer machines.
    let boundary = null;
    if (process.env.R2_ENDPOINT && process.env.R2_BUCKET) {
        console.log('');
        console.log('Boundary Health Checks');
        console.log('======================');
        try {
            boundary = await runBoundaryChecks();
            for (const c of boundary.checks) {
                console.log(`[${c.status.padEnd(4)}] ${c.check}: ${c.message}`);
            }
        } catch (err) {
            console.warn(`[WARN] Boundary checks failed: ${err.message}`);
            boundary = { status: 'WARN', checks: [], error: err.message };
        }
    } else {
        console.log('');
        console.log('[skip] Boundary checks (R2 env not configured)');
    }

    const report = {
        generated_at: new Date().toISOString(),
        total_entities_scanned: totalEntities,
        thresholds: {
            healthy_max_hours: HEALTHY_MAX_HOURS,
            stale_max_hours: STALE_MAX_HOURS,
        },
        sources: rows,
        boundary,
    };
    const outPath = 'output/source-health.json';
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(report, null, 2));
    console.log(`Report: ${outPath}`);

    const hasCritical = rows.some(r => r.status === 'CRITICAL');
    const hasStale = rows.some(r => r.status === 'STALE');
    const boundaryStatus = boundary?.status || 'OK';

    // Exit code: highest severity across sources AND boundary checks wins.
    // 2=CRITICAL/FAIL, 1=STALE/WARN, 0=OK. Boundary FAIL maps to exit 2 so
    // the workflow surface escalates (queue cap breach = real upstream outage).
    if (hasCritical || boundaryStatus === 'FAIL') {
        if (hasCritical) console.log('[FAIL] One or more sources are CRITICAL.');
        if (boundaryStatus === 'FAIL') console.log('[FAIL] Boundary check exceeded FAIL threshold.');
        process.exit(2);
    }
    if (hasStale || boundaryStatus === 'WARN') {
        if (hasStale) console.log('[WARN] One or more sources are STALE.');
        if (boundaryStatus === 'WARN') console.log('[WARN] Boundary check surfaced WARN signal.');
        process.exit(1);
    }
    console.log('[OK] All sources HEALTHY, boundary checks clean.');
    process.exit(0);
}

main().catch(err => {
    console.error('[ERROR]', err.message);
    process.exit(3);
});
