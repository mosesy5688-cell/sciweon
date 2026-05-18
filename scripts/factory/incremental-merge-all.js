/**
 * V0.7 Incremental Merge All — fan-in after all source workers complete.
 *
 * Runs with `if: always()` in GHA — must guard against zero deltas to
 * avoid overwriting the last good cumulative with empty data.
 *
 * Flow:
 *   1. Detect zero deltas (refinement 1) — exit 0 if nothing to merge
 *   2. Load previous cumulative from R2 latest.json pointer
 *   3. Apply each source delta in importance order (replace-by-id)
 *   4. Upload new aggregated + meta → advance latest.json
 *   5. Cleanup staging files for this runId
 *
 * Usage:
 *   node incremental-merge-all.js [--run-id=YYYY-MM-DD] [--dry-run]
 */

import {
    makeIncrementalR2,
} from './lib/incremental-cursors.js';
import {
    detectZeroDeltas, loadStagingDelta, loadPreviousAggregated,
    uploadAggregated, cleanupStaging,
} from './lib/incremental-merge-helpers.js';

// Source importance order: primary structural sources first.
// Determines which source "wins" when same entity id appears in multiple deltas.
const SOURCE_ORDER = [
    'pubchem', 'chembl', 'clinicaltrials', 'ctis', 'dailymed',
    'pubmed', 'openalex', 'openfda', 'retraction-watch',
    'uniprot', 'unichem', 'rxnorm', 'semanticscholar',
    'pubchem-bioassay', 'kegg', 'orangebook', 'who-atc', 'nci-thesaurus',
];

function parseArgs() {
    const args  = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const runId  = args.find(a => a.startsWith('--run-id='))?.split('=')[1]
        ?? new Date().toISOString().slice(0, 10);
    return { dryRun, runId };
}

// Replace-by-id merge: new record wins on conflict; provenance sources are union-merged.
function applyDelta(cumulative, records, source) {
    let added = 0, updated = 0;
    for (const record of records) {
        if (!record?.id) continue;
        if (cumulative.has(record.id)) {
            const existing = cumulative.get(record.id);
            const merged   = { ...existing, ...record };
            // Union-merge provenance sources to preserve multi-source tracking
            const existingSrcs = existing.provenance?.sources ?? [];
            const newSrcs      = record.provenance?.sources ?? [];
            const seen = new Set(existingSrcs.map(s => s.source));
            const allSrcs = [...existingSrcs, ...newSrcs.filter(s => !seen.has(s.source))];
            if (merged.provenance) merged.provenance.sources = allSrcs;
            cumulative.set(record.id, merged);
            updated++;
        } else {
            cumulative.set(record.id, record);
            added++;
        }
    }
    console.log(`[MERGE] ${source}: +${added} added, ~${updated} updated`);
    return { added, updated };
}

async function main() {
    const { dryRun, runId } = parseArgs();
    console.log(`[MERGE-ALL] V0.7 fan-in — runId=${runId}${dryRun ? ' [dry-run]' : ''}`);

    const r2 = makeIncrementalR2();
    if (!r2) {
        console.warn('[MERGE-ALL] R2 not configured — nothing to merge');
        return;
    }
    const { client, bucket } = r2;

    // Step 1: zero-delta guard (refinement 1)
    const stagingCount = await detectZeroDeltas(client, bucket, runId);
    if (stagingCount === 0) {
        console.log('[MERGE-ALL] Zero deltas — no workers produced data. Preserving last good cumulative.');
        return;
    }
    console.log(`[MERGE-ALL] ${stagingCount} staging file(s) detected. Proceeding.`);

    // Step 2: load previous cumulative
    const cumulative = await loadPreviousAggregated(client, bucket);

    // Step 3: apply source deltas in importance order
    const sourceMeta = {};
    for (const source of SOURCE_ORDER) {
        const records = await loadStagingDelta(client, bucket, source, runId);
        if (!records) { sourceMeta[source] = 0; continue; }
        const { added, updated } = applyDelta(cumulative, records, source);
        sourceMeta[source] = records.length;
        void added; void updated;
    }

    const allRecords = Array.from(cumulative.values());
    console.log(`[MERGE-ALL] Cumulative after merge: ${allRecords.length} entities`);

    // Step 4: upload + advance latest.json
    if (!dryRun) {
        await uploadAggregated(client, bucket, runId, allRecords, {
            runId,
            timestamp: new Date().toISOString(),
            entity_count: allRecords.length,
            source_deltas: sourceMeta,
        });
        console.log(`[MERGE-ALL] Uploaded → processed/aggregated/${runId}/`);

        // Step 5: cleanup staging
        await cleanupStaging(client, bucket, runId);
        console.log('[MERGE-ALL] Staging cleaned');
    } else {
        console.log(`[MERGE-ALL] [dry-run] Would upload ${allRecords.length} entities — skipped`);
    }

    console.log('[MERGE-ALL] Done');
}

main().catch(err => { console.error('[MERGE-ALL] Fatal:', err); process.exit(1); });
