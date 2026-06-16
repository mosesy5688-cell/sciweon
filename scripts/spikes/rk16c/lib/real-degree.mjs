/**
 * RK-16C FULL-CORPUS SPIKE (G) — REAL-DEGREE distribution module (OFFLINE).
 *
 * Computes the degree distribution from the CORPUS ITSELF (no synthetic
 * substitute at full-corpus run time): max + p50/p95/p99/p99.9 tail, identifies
 * the record/structural class that causes the max degree, distinguishes
 * legit-high-degree vs anomaly vs duplicate-edge, and reports STRATIFIED if the
 * degree semantics differ across entity/relationship types.
 *
 * BUILD-phase callers MAY feed a SYNTHETIC fixture — but the result MUST be
 * LABELED (corpus_grounded:false). At full-corpus run time the fixture flag is
 * false and the input is the real materialized corpus rows.
 */

function quantile(sortedDesc, q) {
    if (sortedDesc.length === 0) return 0;
    // sortedDesc is highest-first; convert the percentile to an index.
    const idx = Math.min(sortedDesc.length - 1, Math.floor((1 - q) * (sortedDesc.length - 1)));
    return sortedDesc[idx];
}

/** Degree distribution for an axis keyed by keyFn, over `rows`. */
export function degreeDistribution(rows, keyFn) {
    const counts = new Map();
    for (const r of rows) {
        const k = keyFn(r);
        if (k == null) continue;
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    const degrees = [...counts.values()].sort((a, b) => b - a);
    let maxKey = null; let maxDeg = 0;
    for (const [k, d] of counts) if (d > maxDeg) { maxDeg = d; maxKey = k; }
    return {
        distinct_keys: counts.size,
        total_edges: rows.length,
        degree_max: degrees[0] || 0,
        degree_p50: quantile(degrees, 0.50),
        degree_p95: quantile(degrees, 0.95),
        degree_p99: quantile(degrees, 0.99),
        degree_p999: quantile(degrees, 0.999),
        max_degree_key: maxKey,
    };
}

/**
 * Classify the max-degree key as legit-high-degree vs anomaly vs duplicate-edge.
 *   - duplicate-edge: the same (canonical_id) appears >1 time under the key
 *     (an illegal duplicate edge, not real fan-out);
 *   - anomaly: a placeholder/null/sentinel key absorbing rows (e.g. missing id);
 *   - legit: distinct real members, no duplicate canonical_id.
 */
export function classifyMaxDegree(rows, keyFn, maxKey, idOf = (r) => r.canonical_id ?? r.id) {
    const members = rows.filter((r) => keyFn(r) === maxKey);
    const ids = members.map((m) => String(idOf(m)));
    const distinct = new Set(ids);
    const duplicate_edge_count = ids.length - distinct.size;
    const SENTINELS = new Set(['null', 'undefined', '', 'chembl:null', 'chembl:undefined', 'chembl:']);
    const is_sentinel_key = SENTINELS.has(String(maxKey).toLowerCase());
    let classification = 'legit_high_degree';
    if (duplicate_edge_count > 0) classification = 'duplicate_edge';
    else if (is_sentinel_key) classification = 'anomaly_sentinel_key';
    return {
        max_degree_key: maxKey,
        member_count: members.length,
        distinct_member_ids: distinct.size,
        duplicate_edge_count,
        is_sentinel_key,
        classification,
    };
}

/**
 * Full real-degree report for the target + compound axes, plus stratification by
 * is_active when those degree semantics differ. corpus_grounded MUST reflect
 * whether the input is the real corpus (true) or a synthetic fixture (false).
 */
export function realDegreeReport(rows, opts = {}) {
    const corpus_grounded = opts.corpus_grounded === true;
    const targetKey = opts.targetKey || ((r) => `chembl:${r.target_id}`);
    const compoundKey = opts.compoundKey || ((r) => r.compound_id);

    const target = degreeDistribution(rows, targetKey);
    const compound = degreeDistribution(rows, compoundKey);
    const target_max_class = classifyMaxDegree(rows, targetKey, target.max_degree_key);

    // stratify by is_active — degree semantics differ if active/inactive fan-out
    // is materially skewed (a relationship-type difference worth reporting).
    const active = rows.filter((r) => r.is_active === true);
    const inactive = rows.filter((r) => r.is_active === false);
    const stratified = (active.length && inactive.length) ? {
        active_target: degreeDistribution(active, targetKey),
        inactive_target: degreeDistribution(inactive, targetKey),
        semantics_differ:
            Math.abs(degreeDistribution(active, targetKey).degree_max
                - degreeDistribution(inactive, targetKey).degree_max) > 0,
    } : { note: 'insufficient active/inactive split to stratify' };

    return {
        label: corpus_grounded ? 'CORPUS-GROUNDED' : 'SYNTHETIC-FIXTURE (LABELED, not corpus-grounded)',
        corpus_grounded,
        target_axis: target,
        compound_axis: compound,
        target_max_degree_classification: target_max_class,
        stratified_by_is_active: stratified,
    };
}
