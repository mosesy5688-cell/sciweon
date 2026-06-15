/**
 * RK-16C OFFLINE SPIKE — local corpus loader (READ-ONLY, OFFLINE).
 *
 * Loads the LOCAL 2026-05-13 bioactivities snapshot (gunzip with Node zlib).
 * NOT production R2, NO network. Records its provenance (path + sha256 +
 * record_count) so every corpus-grounded result is traceable. Substrate spike
 * only: NO family registration, NO production object access.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// repo root is four levels up: lib -> rk16c -> spikes -> scripts -> root
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

export const CORPUS_REL_PATH = 'snapshots/2026-05-13/bioactivities.jsonl.gz';

/** True iff the LOCAL corpus file is present. It is absent in CI (snapshots/ is
 * gitignored), so corpus-grounded tests skip there -- the offline spike uses an
 * EXISTING LOCAL copy, never CI/production. */
export function corpusExists() {
    return fs.existsSync(path.join(REPO_ROOT, CORPUS_REL_PATH));
}

/** sha256 (hex) of a buffer. */
function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * Load + parse the local corpus. Returns rows + provenance.
 * @returns {{ rows: object[], provenance: {
 *   source_path: string, sha256: string, record_count: number,
 *   note: string } }}
 */
export function loadCorpus() {
    const abs = path.join(REPO_ROOT, CORPUS_REL_PATH);
    const gz = fs.readFileSync(abs);
    const digest = sha256(gz);
    const text = zlib.gunzipSync(gz).toString('utf-8');
    const rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    return {
        rows,
        provenance: {
            source_path: CORPUS_REL_PATH,
            sha256: digest,
            record_count: rows.length,
            note:
                'LOCAL 2026-05-13 snapshot (offline file, NOT production R2). ' +
                'Smaller + older than production (~475,112 rows) and contains NO ' +
                'degree-43,364 target; heavy-hitter results use a synthetic fixture.',
        },
    };
}

/**
 * Coverage report for the two materialized axes (compound + target) and the
 * optional uniprot alias. Used by the spike report to justify target_id (not
 * uniprot) as the target authority.
 */
export function coverage(rows) {
    let hasTargetId = 0;
    let hasTargetObj = 0;
    let hasUniprot = 0;
    const compounds = new Set();
    const targets = new Set();
    const uniprots = new Set();
    for (const r of rows) {
        if (r.target_id) { hasTargetId += 1; targets.add(r.target_id); }
        if (r.target && typeof r.target === 'object') hasTargetObj += 1;
        const acc = r.target && r.target.uniprot_accession;
        if (acc) { hasUniprot += 1; uniprots.add(acc); }
        if (r.compound_id) compounds.add(r.compound_id);
    }
    return {
        record_count: rows.length,
        distinct_compound_id: compounds.size,
        distinct_target_id: targets.size,
        distinct_uniprot_accession: uniprots.size,
        rows_with_target_id: hasTargetId,
        rows_with_target_object: hasTargetObj,
        rows_with_uniprot_accession: hasUniprot,
        target_id_coverage_pct: pct(hasTargetId, rows.length),
        uniprot_coverage_pct: pct(hasUniprot, rows.length),
    };
}

function pct(n, d) {
    return d === 0 ? 0 : Math.round((n / d) * 10000) / 100;
}

/** Degree distribution (rows per key) for an axis keyed by `keyFn`. */
export function degrees(rows, keyFn) {
    const counts = new Map();
    for (const r of rows) {
        const k = keyFn(r);
        if (k == null) continue;
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    const sorted = [...counts.values()].sort((a, b) => b - a);
    return { distinct_keys: counts.size, max_degree: sorted[0] || 0, top: sorted.slice(0, 5) };
}
