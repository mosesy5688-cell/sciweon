/**
 * Adapter Cross-Linker — enriches compounds with data from the adapter cumulative.
 *
 * WHO-ATC: expands drug_status.atc_codes with full 5-level hierarchy descriptions
 *          sourced from the WHO-ATC adapter (via ChEMBL /atc_class endpoint).
 * DailyMed: links FDA drug labels to compounds via RxCUI match, adding
 *           drug_labels[] with boxed-warning flag and publication date.
 * DailyMed (cycle 21): also emits the full DrugLabel entities to a standalone
 *           drug-labels.jsonl that snapshot-builder publishes. Before this
 *           emit step, snapshot-builder.js logged `(absent, skip)` every cron
 *           and no published snapshot ever carried drug-labels.jsonl.gz —
 *           blocking C2-7 (label vs FAERS PT contradictions matcher).
 *
 * Input:  output/linked/compounds-enriched.jsonl
 *         output/linked/adapter-cumulative.jsonl  (written by adapter-bridge.js)
 * Output: output/linked/compounds-enriched.jsonl  (in-place enrichment)
 *         output/linked/drug-labels.jsonl         (full DrugLabel entities)
 *
 * Non-fatal if adapter-cumulative.jsonl is absent — first run before adapters
 * have collected data. Logs and exits 0.
 */

import fs from 'fs/promises';
import { loadRxnormBulkMaps, lookupByNdc } from '../ingestion/adapters/rxnorm-bulk-adapter.js';
import { normalizeNdcTo11Digit } from './lib/ndc-normalize.js';

const COMPOUNDS    = './output/linked/compounds-enriched.jsonl';
const ADAPTER      = './output/linked/adapter-cumulative.jsonl';
const DRUG_LABELS  = './output/linked/drug-labels.jsonl';

function parseJsonl(text) {
    return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/**
 * PR-RXN-1b: hydrate drug_label.rxcui[] from drug_label.ndcs[] via RxNorm
 * bulk Map lookup. Pre-step for downstream dailymedByRxcui builder (which
 * iterates r.rxcui[]). DailyMed v2 API never emits rxcui on label metadata;
 * this function activates the cross-link path by resolving NDC -> ingredient
 * RxCUI through the architecturally graph-flattened RxNorm bulk index.
 *
 * Fail-soft per-NDC (architect lock 2026-05-28 +
 * [[scope_vs_quality_validation_segregation]]): a single unmapped NDC in a
 * multi-NDC label MUST NOT nuke parent label backlinks; bucket-counted in
 * excluded_unmapped_ndc_count telemetry.
 *
 * Combination-product 1:N: lookupByNdc returns Set<{rxcui,...}> per the
 * concept-level-graph design in PR-RXN-1. Combo NDC (e.g., Combivent =
 * ipratropium + albuterol) maps to 2 ingredient RxCUIs; label.rxcui[] gets
 * the dedup union across all NDCs in the label.
 *
 * Idempotent: r.rxcui[] already non-empty -> treat as already hydrated.
 *
 * Deterministic: [...resolved].sort() ensures byte-identical output across
 * runs on identical input (Constitution Art 7).
 *
 * Pure function: no I/O, mutates only r.rxcui on matching records, returns
 * telemetry by value.
 */
export function hydrateLabelRxcuisFromNdcs(adapterRecords, maps) {
    const telemetry = {
        labels_with_ndcs: 0,
        labels_hydrated: 0,
        labels_zero_match: 0,
        labels_skipped_already_populated: 0,
        // PR-RXN-1b-ndc-normalize: split exclusion bucket into malformed
        // (normalizer null -- bad shape) vs unmapped (normalized OK but
        // not in RxNorm map -- Prescribable subset boundary attrition or
        // genuine historical / discontinued labeler). Preserves
        // excluded_unmapped_ndc_count = malformed + unmapped for log
        // backward-compat.
        malformed_ndc_count: 0,
        unmapped_ndc_count: 0,
        excluded_unmapped_ndc_count: 0,
        sample_unmapped_ndcs: [],
    };
    if (!Array.isArray(adapterRecords)) return telemetry;
    for (const r of adapterRecords) {
        if (!r?.id?.startsWith?.('sciweon::drug_label::')) continue;
        if (!Array.isArray(r.ndcs) || r.ndcs.length === 0) continue;
        if (Array.isArray(r.rxcui) && r.rxcui.length > 0) {
            telemetry.labels_skipped_already_populated++;
            continue;
        }
        telemetry.labels_with_ndcs++;
        const resolved = new Set();
        for (const ndc of r.ndcs) {
            if (typeof ndc !== 'string' || ndc.length === 0) {
                telemetry.malformed_ndc_count++;
                telemetry.excluded_unmapped_ndc_count++;
                if (telemetry.sample_unmapped_ndcs.length < 10) {
                    telemetry.sample_unmapped_ndcs.push(`[MALFORMED] ${String(ndc)}`);
                }
                continue;
            }
            const normalized = normalizeNdcTo11Digit(ndc);
            if (!normalized) {
                telemetry.malformed_ndc_count++;
                telemetry.excluded_unmapped_ndc_count++;
                if (telemetry.sample_unmapped_ndcs.length < 10) {
                    telemetry.sample_unmapped_ndcs.push(`[MALFORMED] ${ndc}`);
                }
                continue;
            }
            const hits = lookupByNdc(maps, normalized);
            if (hits.size === 0) {
                telemetry.unmapped_ndc_count++;
                telemetry.excluded_unmapped_ndc_count++;
                if (telemetry.sample_unmapped_ndcs.length < 10) {
                    telemetry.sample_unmapped_ndcs.push(`[UNMAPPED] ${ndc} (${normalized})`);
                }
                continue;
            }
            for (const meta of hits) resolved.add(meta.rxcui);
        }
        if (resolved.size === 0) {
            telemetry.labels_zero_match++;
            continue;
        }
        r.rxcui = [...resolved].sort();
        telemetry.labels_hydrated++;
    }
    return telemetry;
}

export async function runCrossLinker({ compoundsPath = COMPOUNDS, adapterPath = ADAPTER, drugLabelsPath = DRUG_LABELS } = {}) {
    let adapterRecords;
    try {
        adapterRecords = parseJsonl(await fs.readFile(adapterPath, 'utf-8'));
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log('[ADAPTER-LINKER] No adapter cumulative found — skipping (first run)');
            return;
        }
        throw e;
    }
    console.log(`[ADAPTER-LINKER] ${adapterRecords.length} adapter records loaded`);

    // PR-RXN-1b: NDC->RxCUI hydration pre-step. Loads RxNorm bulk Map from R2
    // and populates drug_label.rxcui[] for records that have ndcs[] but lack
    // rxcui[] (the universal pre-PR-RXN-1b state because DailyMed v2 API
    // never emits rxcui on label metadata). Graceful degradation: if bulk
    // map unavailable (R2 transient / bootstrap), log warn + skip hydration;
    // cross-link falls back to pre-PR-RXN-1b empty-rxcui behavior (existing
    // 0% baseline) rather than halting F3.
    let bulkMaps = null;
    try { bulkMaps = await loadRxnormBulkMaps(); }
    catch (err) {
        console.warn(`[ADAPTER-LINKER] RxNorm bulk maps unavailable (${err.message}) -- skipping NDC->RxCUI hydration; cross-link will degrade to prior empty-rxcui behavior`);
    }
    if (bulkMaps) {
        const tele = hydrateLabelRxcuisFromNdcs(adapterRecords, bulkMaps);
        console.log(`[ADAPTER-LINKER] NDC->RxCUI hydration: labels_hydrated=${tele.labels_hydrated} excluded_unmapped_ndc=${tele.excluded_unmapped_ndc_count} (malformed=${tele.malformed_ndc_count} unmapped=${tele.unmapped_ndc_count}) zero_match=${tele.labels_zero_match} already_populated=${tele.labels_skipped_already_populated}`);
        if (tele.sample_unmapped_ndcs.length > 0) {
            console.log(`[ADAPTER-LINKER] sample unmapped NDCs (first ${tele.sample_unmapped_ndcs.length}): ${tele.sample_unmapped_ndcs.join(',')}`);
        }
    }

    // Build lookup maps — only WHO-ATC and DailyMed entities are consumed here;
    // other adapter types (chembl, clinicaltrials, etc.) have dedicated enrichers.
    const atcMap = new Map();           // level5 code → ATC entity
    const dailymedByRxcui = new Map();  // rxcui string → label summary[]
    const drugLabelRecords = [];        // full DrugLabel entities → drug-labels.jsonl

    for (const r of adapterRecords) {
        if (!r?.id) continue;
        if (r.id.startsWith('sciweon::atc_class::') && r.level5) {
            atcMap.set(r.level5, r);
        }
        if (r.id.startsWith('sciweon::drug_label::')) {
            drugLabelRecords.push(r);
            for (const rxcui of (r.rxcui ?? [])) {
                if (!dailymedByRxcui.has(rxcui)) dailymedByRxcui.set(rxcui, []);
                dailymedByRxcui.get(rxcui).push({
                    setid:            r.setid ?? null,
                    title:            (r.title ?? '').slice(0, 200) || null,
                    has_boxed_warning: r.has_boxed_warning ?? false,
                    published_date:   r.published_date ?? null,
                });
            }
        }
    }
    console.log(`[ADAPTER-LINKER] WHO-ATC: ${atcMap.size} codes | DailyMed RxCUI: ${dailymedByRxcui.size} | DrugLabel records: ${drugLabelRecords.length}`);

    const compounds = parseJsonl(await fs.readFile(compoundsPath, 'utf-8'));
    let atcExpanded = 0;
    let dmLinked    = 0;

    const enriched = compounds.map(c => {
        let out = c;
        const ds = c.drug_status ?? {};

        // WHO-ATC: expand atc_codes → atc_details with full hierarchy
        const codes = ds.atc_codes ?? [];
        if (codes.length > 0 && atcMap.size > 0) {
            const details = codes.map(code => {
                const e = atcMap.get(code);
                if (e) atcExpanded++;
                return e ? {
                    code,
                    who_name:           e.who_name ?? null,
                    level1:             e.level1 ?? null,
                    level1_description: e.level1_description ?? null,
                    level2:             e.level2 ?? null,
                    level2_description: e.level2_description ?? null,
                    level3:             e.level3 ?? null,
                    level3_description: e.level3_description ?? null,
                    level4:             e.level4 ?? null,
                    level4_description: e.level4_description ?? null,
                } : { code };
            });
            out = { ...out, drug_status: { ...ds, atc_details: details } };
        }

        // DailyMed: link labels via RxCUI
        const rxcui    = c.external_ids?.rxcui;
        const rxcuiArr = Array.isArray(rxcui) ? rxcui : (rxcui ? [String(rxcui)] : []);
        const labels   = rxcuiArr.flatMap(r => dailymedByRxcui.get(r) ?? []);
        if (labels.length > 0) {
            dmLinked++;
            out = { ...out, drug_labels: labels };
        }

        return out;
    });

    await fs.writeFile(compoundsPath, enriched.map(c => JSON.stringify(c)).join('\n') + '\n', 'utf-8');

    // Determinism (§7): sort by id before write so snapshot-builder produces
    // byte-identical drug-labels.jsonl.gz across runs on identical input.
    drugLabelRecords.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const drugLabelsText = drugLabelRecords.length > 0
        ? drugLabelRecords.map(r => JSON.stringify(r)).join('\n') + '\n'
        : '';
    await fs.writeFile(drugLabelsPath, drugLabelsText, 'utf-8');

    console.log(`[ADAPTER-LINKER] Done — ATC codes expanded: ${atcExpanded} | DailyMed linked: ${dmLinked} compounds | drug-labels emitted: ${drugLabelRecords.length}`);
    return { atcExpanded, dmLinked, drugLabelsCount: drugLabelRecords.length };
}

async function main() {
    await runCrossLinker();
}

main().catch(err => { console.error('[ADAPTER-LINKER] Fatal:', err.message); process.exit(1); });
