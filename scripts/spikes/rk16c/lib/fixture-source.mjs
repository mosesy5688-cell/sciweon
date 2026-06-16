/**
 * RK-16C FULL-CORPUS SPIKE — BUILD-phase fixture source (OFFLINE).
 *
 * Supplies projection rows for the matrix in the BUILD phase WITHOUT fetching
 * the 475k production corpus. Order of preference (each LABELED):
 *   1. the LOCAL 2026-05-13 corpus file if present (corpus_grounded:true, but a
 *      SMALLER/OLDER stand-in — NOT the 475k production corpus);
 *   2. else a deterministic SYNTHETIC fixture (corpus_grounded:false, LABELED).
 *
 * It NEVER reads production R2. The 475k corpus is consumed ONLY by the
 * read-only adapter's --execute path (the future READ-ONLY RUN GATE).
 */

import { loadCorpus, corpusExists } from './corpus.mjs';
import { buildCanonical, projectRows } from './build-axis.mjs';
import { makeHeavyHitterRows } from './heavy-hitter.mjs';

/** Build a deterministic synthetic fixture (LABELED) of N bioactivity rows. */
export function makeSyntheticFixture(n = 4000) {
    const rows = new Array(n);
    const types = ['IC50', 'Ki', 'EC50', 'Kd'];
    const units = ['nM', 'uM', 'mM'];
    for (let i = 0; i < n; i++) {
        const seq = String(i).padStart(6, '0');
        // skewed fan-out: a few hot targets carry most rows (real-ish tail).
        const targetBucket = i % 11 === 0 ? 'HOT' : `T${i % 400}`;
        rows[i] = {
            id: `sciweon::bioactivity::FIX_${seq}`,
            compound_id: `sciweon::compound::CID:FIX_${String(i % 1500).padStart(5, '0')}`,
            target_id: targetBucket,
            target: { chembl_id: `CHEMBL_FIX_${i % 400}`, uniprot_accession: i % 4 ? 'P0FIX1' : null },
            activity_type: types[i % types.length],
            value: (i % 900) + 1,
            unit: units[i % units.length],
            is_active: i % 3 === 0 ? true : i % 3 === 1 ? false : null,
        };
    }
    return rows;
}

/**
 * Resolve the BUILD-phase fixture rows + projection rows + a provenance label.
 * @returns {Promise<{ rows, proj, corpus_grounded, label, record_count, source }>}
 */
export async function resolveFixture(opts = {}) {
    const useLocal = opts.preferLocal !== false && corpusExists();
    let rows; let corpus_grounded; let source; let label;
    if (useLocal) {
        rows = loadCorpus().rows;
        corpus_grounded = true;
        source = 'local-2026-05-13';
        label = 'LOCAL 2026-05-13 corpus (corpus-grounded stand-in; SMALLER/OLDER than '
            + 'the 475k production corpus — NOT a production read)';
    } else {
        rows = makeSyntheticFixture(opts.syntheticRows || 4000);
        corpus_grounded = false;
        source = 'synthetic';
        label = 'SYNTHETIC fixture (LABELED, not corpus-grounded)';
    }
    if (opts.limit && rows.length > opts.limit) rows = rows.slice(0, opts.limit);
    const { byCanonicalId } = await buildCanonical(rows, opts.outputDir);
    const proj = projectRows(rows, byCanonicalId);
    return { rows, proj, corpus_grounded, label, record_count: rows.length, source };
}

export { makeHeavyHitterRows };
