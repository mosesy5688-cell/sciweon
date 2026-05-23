/**
 * Source completeness helpers - cycle 22 PR-CORE-1 pure-function layer.
 *
 * Extracted from source-completeness.js (entry script) to keep both files
 * under Art 5.1 250-line cap and to isolate the testable pure-function
 * surface from the R2/IO entry script.
 *
 * Public functions:
 *   - getPath(record, dottedPath)           dotted-path resolver
 *   - checkRequiredPath(record, encoded)    encoding-aware predicate
 *   - checkGate(record, gate)               denominator gate predicate
 *   - isFullyEnriched(record, sourceEntry)  strict-enriched test
 *   - severityTierForPct(pct)               percentage -> tier 0/1/2/3
 *   - aggregateSeverity(perSourceStats)     worst-case tier
 *   - listBelowThreshold(stats, threshold)  source ids below cutoff
 *   - scanFile(lineStream, sourcesForFile)  streaming aggregation
 *   - pct(numer, denom)                     NaN-safe % round to 2dp
 *   - initStat(sourceEntry)                 zeroed counter object
 */

import { SEVERITY_THRESHOLDS, SOURCE_REQUIRED_FIELDS } from './source-required-fields.js';

// Per-source threshold lookup with global fallback. PR-CORE-1d (2026-05-23)
// added per-source overrides for sources with natural ceilings well below
// the global 50/80/95 default (rxnorm/openfda_faers/unichem/pubchem_bioassay).
// Sources without override fall back to the global SEVERITY_THRESHOLDS.
function thresholdsFor(source) {
    if (source && SOURCE_REQUIRED_FIELDS[source]?.severity_thresholds) {
        return SOURCE_REQUIRED_FIELDS[source].severity_thresholds;
    }
    return SEVERITY_THRESHOLDS;
}

// Walk a dotted path on a record, returning undefined if any segment is
// absent. Does not throw - caller decides whether undefined fails the
// required check.
export function getPath(record, dottedPath) {
    if (record == null) return undefined;
    const segs = dottedPath.split('.');
    let cur = record;
    for (const seg of segs) {
        if (cur == null) return undefined;
        cur = cur[seg];
    }
    return cur;
}

// Evaluate one required_paths entry against a record. Supports plain
// dotted path (non-null check), [] suffix (array length>=1), ===literal
// suffix (strict equality), and ~~literal suffix (array.includes).
// Returns boolean. The encoding lives here, not in callers, so the
// tracker can iterate registry entries uniformly.
export function checkRequiredPath(record, encoded) {
    // === literal equality
    const eqIdx = encoded.indexOf('===');
    if (eqIdx !== -1) {
        const path = encoded.slice(0, eqIdx);
        const literal = JSON.parse(encoded.slice(eqIdx + 3));
        return getPath(record, path) === literal;
    }
    // ~~ array contains literal
    const inIdx = encoded.indexOf('~~');
    if (inIdx !== -1) {
        const path = encoded.slice(0, inIdx);
        const literal = JSON.parse(encoded.slice(inIdx + 2));
        const v = getPath(record, path);
        return Array.isArray(v) && v.includes(literal);
    }
    // [] array non-empty
    if (encoded.endsWith('[]')) {
        const path = encoded.slice(0, -2);
        const v = getPath(record, path);
        return Array.isArray(v) && v.length >= 1;
    }
    // plain non-null
    const v = getPath(record, encoded);
    return v != null;
}

// Evaluate gate predicate (a dotted path that must resolve to non-null)
// or `null` (no gate - always passes).
export function checkGate(record, gate) {
    if (gate == null) return true;
    return getPath(record, gate) != null;
}

// True iff every required path passes for this source on this record.
export function isFullyEnriched(record, sourceEntry) {
    for (const p of sourceEntry.required_paths) {
        if (!checkRequiredPath(record, p)) return false;
    }
    return true;
}

// Map a 0-100 percentage to a severity tier (0=healthy, 1=hardfail,
// 2=warn, 3=info). NaN / missing data treated as worst-case hardfail.
// Optional `source` id triggers per-source threshold override lookup
// (PR-CORE-1d). When omitted, uses global SEVERITY_THRESHOLDS for
// backward compatibility with legacy callers.
export function severityTierForPct(p, source) {
    if (!Number.isFinite(p)) return 1;
    const t = thresholdsFor(source);
    if (p < t.hardfail) return 1;
    if (p < t.warn) return 2;
    if (p < t.info) return 3;
    return 0;
}

// Aggregate per-source tiers into a single worst-case exit-code tier.
// Severity ordering (worst -> best): 1 (hardfail) > 2 (warn) > 3 (info)
// > 0 (healthy). Returns the most-severe (lowest non-zero) tier present.
// Per-source threshold lookup: passes the source id to severityTierForPct
// so each source is evaluated against its own override (if any).
export function aggregateSeverity(perSourceStats) {
    let anyHardfail = false, anyWarn = false, anyInfo = false;
    for (const [source, stat] of Object.entries(perSourceStats)) {
        const t = severityTierForPct(stat.gate_adjusted_pct, source);
        if (t === 1) anyHardfail = true;
        else if (t === 2) anyWarn = true;
        else if (t === 3) anyInfo = true;
    }
    if (anyHardfail) return 1;
    if (anyWarn) return 2;
    if (anyInfo) return 3;
    return 0;
}

// Sources whose gate_adjusted_pct is below their info threshold (per-source
// or global default). When `threshold` is explicitly passed, that single
// value is used for all sources (preserved for tests / overrides).
export function listBelowThreshold(perSourceStats, threshold) {
    const out = [];
    for (const [source, stat] of Object.entries(perSourceStats)) {
        const cutoff = threshold != null ? threshold : thresholdsFor(source).info;
        if (!(stat.gate_adjusted_pct >= cutoff)) out.push(source);
    }
    return out;
}

// Round to 2 decimal places, NaN-safe. denom<=0 yields 100 (empty set
// is treated as vacuously complete; the caller may zero it explicitly
// when total is zero by design).
export function pct(numer, denom) {
    if (denom <= 0) return 100;
    return +(100 * numer / denom).toFixed(2);
}

// Initialize a per-source counter object.
export function initStat(sourceEntry) {
    return {
        file: sourceEntry.file,
        total: 0,
        gate_pass: 0,
        fully_enriched: 0,
        raw_pct: 0,
        gate_adjusted_pct: 0,
    };
}

// One streaming pass over a file, updating all source counters whose
// `file` matches. Returns {total, dailymedLinkedCompoundCount} for the
// file. Per [[cross-cycle-silent-data-loss]] a malformed JSONL line
// throws rather than being silently skipped.
export async function scanFile(lineStream, sourcesForThisFile) {
    let total = 0;
    let dailymedLinkedCompoundCount = 0;
    const trackDailyMedLinked = sourcesForThisFile.some(
        ([, e]) => e.file === 'compounds-enriched.jsonl',
    );
    for await (const line of lineStream) {
        if (!line) continue;
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            throw new Error(`Malformed JSONL line encountered (skipping not permitted): ${line.slice(0, 120)}...`);
        }
        total++;
        for (const [, entry] of sourcesForThisFile) {
            entry._stat.total++;
            if (checkGate(rec, entry.denominator_gate)) {
                entry._stat.gate_pass++;
                if (isFullyEnriched(rec, entry)) {
                    entry._stat.fully_enriched++;
                }
            }
        }
        if (trackDailyMedLinked && Array.isArray(rec.drug_labels) && rec.drug_labels.length > 0) {
            dailymedLinkedCompoundCount++;
        }
    }
    return { total, dailymedLinkedCompoundCount };
}
