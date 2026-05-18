/**
 * Adapter Cross-Linker — enriches compounds with data from the adapter cumulative.
 *
 * WHO-ATC: expands drug_status.atc_codes with full 5-level hierarchy descriptions
 *          sourced from the WHO-ATC adapter (via ChEMBL /atc_class endpoint).
 * DailyMed: links FDA drug labels to compounds via RxCUI match, adding
 *           drug_labels[] with boxed-warning flag and publication date.
 *
 * Input:  output/linked/compounds-enriched.jsonl
 *         output/linked/adapter-cumulative.jsonl  (written by adapter-bridge.js)
 * Output: output/linked/compounds-enriched.jsonl  (in-place enrichment)
 *
 * Non-fatal if adapter-cumulative.jsonl is absent — first run before adapters
 * have collected data. Logs and exits 0.
 */

import fs from 'fs/promises';

const COMPOUNDS = './output/linked/compounds-enriched.jsonl';
const ADAPTER   = './output/linked/adapter-cumulative.jsonl';

function parseJsonl(text) {
    return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

async function main() {
    let adapterRecords;
    try {
        adapterRecords = parseJsonl(await fs.readFile(ADAPTER, 'utf-8'));
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log('[ADAPTER-LINKER] No adapter cumulative found — skipping (first run)');
            return;
        }
        throw e;
    }
    console.log(`[ADAPTER-LINKER] ${adapterRecords.length} adapter records loaded`);

    // Build lookup maps — only WHO-ATC and DailyMed entities are consumed here;
    // other adapter types (chembl, clinicaltrials, etc.) have dedicated enrichers.
    const atcMap = new Map();           // level5 code → ATC entity
    const dailymedByRxcui = new Map();  // rxcui string → label summary[]

    for (const r of adapterRecords) {
        if (!r?.id) continue;
        if (r.id.startsWith('sciweon::atc_class::') && r.level5) {
            atcMap.set(r.level5, r);
        }
        if (r.id.startsWith('sciweon::drug_label::')) {
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
    console.log(`[ADAPTER-LINKER] WHO-ATC: ${atcMap.size} codes | DailyMed RxCUI: ${dailymedByRxcui.size}`);

    const compounds = parseJsonl(await fs.readFile(COMPOUNDS, 'utf-8'));
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

    await fs.writeFile(COMPOUNDS, enriched.map(c => JSON.stringify(c)).join('\n') + '\n', 'utf-8');
    console.log(`[ADAPTER-LINKER] Done — ATC codes expanded: ${atcExpanded} | DailyMed linked: ${dmLinked} compounds`);
}

main().catch(err => { console.error('[ADAPTER-LINKER] Fatal:', err.message); process.exit(1); });
