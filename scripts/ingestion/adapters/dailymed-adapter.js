/**
 * DailyMed Adapter V2 — Sciweon DataSourceAdapterV2 interface (§11.2).
 *
 * Incremental harvest of FDA/NLM DailyMed drug labels (SPL format).
 *   checkForUpdates(sinceToken) → { hasUpdates, count, nextSinceToken }
 *   fetchIncremental(sinceToken) → { records, nextSinceToken }
 *   normalize(meta, sections) → DrugLabel entity
 *
 * sinceToken: YYYY-MM-DD; null bootstrap → today − 7 days.
 * Phase A scope: HUMAN PRESCRIPTION DRUG only (OTC deferred V0.5.5).
 * HTTP helpers and utilities live in dailymed-fetcher.js.
 */

import { scoreDataPoint } from '../../factory/lib/confidence-scorer.js';
import {
    sleep, todayIso, bootstrapSince,
    normalizeDailyMedDate, isAcceptedLabelType, buildNullSections,
    fetchJson, fetchSections, listSplPage, fetchLabelMeta,
    DAILYMED_BASE, DELAY_MS, LIST_PAGE_SIZE,
} from './dailymed-fetcher.js';

export const supportsIncremental     = true;
export const fallbackFullRefreshDays = 90;

export function normalize(meta, sections) {
    if (!meta?.setid) return null;
    const timestamp = new Date().toISOString();
    const rxcuiRaw = meta.rxcui;
    const rxcui = Array.isArray(rxcuiRaw)
        ? rxcuiRaw.map(String).filter(Boolean)
        : rxcuiRaw ? [String(rxcuiRaw)] : [];
    const resolvedSections = sections ?? buildNullSections();
    return {
        id: `sciweon::drug_label::setid::${meta.setid}`,
        setid: meta.setid,
        spl_version: meta.spl_version != null ? String(meta.spl_version) : null,
        title: (meta.title ?? '').slice(0, 500),
        label_type: meta.label_type ?? null,
        rxcui,
        application_numbers: Array.isArray(meta.application_numbers)
            ? meta.application_numbers.map(String).filter(Boolean)
            : [],
        dosage_forms: Array.isArray(meta.dosage_forms)
            ? meta.dosage_forms.map(String).filter(Boolean).slice(0, 20)
            : [],
        sections: resolvedSections,
        has_boxed_warning: resolvedSections.boxed_warning != null,
        sections_extracted: sections !== null,
        published_date: normalizeDailyMedDate(meta.published_date),
        provenance: {
            sources: [{ source: 'dailymed', source_id: meta.setid,
                timestamp, extraction_method: 'dailymed_rest_v2' }],
            last_updated: timestamp,
        },
        confidence: {
            overall: scoreDataPoint(['dailymed']),
            method: 'cross_source_consensus_v2',
            cross_source_agreement: { structural_match: false, conflicts: [] },
        },
    };
}

export async function checkForUpdates(sinceToken) {
    const startDate = sinceToken ?? bootstrapSince();
    try {
        const params = new URLSearchParams({
            startdate: startDate, pagesize: '1', page: '1',
            labeltype: 'HUMAN PRESCRIPTION DRUG',
        });
        const data = await fetchJson(`${DAILYMED_BASE}/spls.json?${params}`);
        const total = data.metadata?.total ?? 0;
        return { hasUpdates: total > 0, count: total, nextSinceToken: todayIso() };
    } catch (e) {
        console.warn(`[DAILYMED] checkForUpdates: ${e.message}`);
        return { hasUpdates: false, count: 0, nextSinceToken: sinceToken };
    }
}

export async function fetchIncremental(sinceToken, limit = Infinity) {
    const startDate = sinceToken ?? bootstrapSince();
    const records = [];
    let page = 1;
    let total = null;
    let fetched = 0;
    let skipped = 0;

    console.log(`[DAILYMED] fetchIncremental since=${startDate}${limit < Infinity ? ` limit=${limit}` : ''}`);

    while (fetched < limit) {
        const { total: pageTotal, items } = await listSplPage(startDate, page);
        await sleep(DELAY_MS);

        if (total === null) {
            total = pageTotal;
            console.log(`[DAILYMED] ${total} prescription labels updated since ${startDate}`);
        }
        if (items.length === 0) break;

        for (const item of items) {
            if (fetched >= limit) break;
            const setid = item.setid;
            if (!setid) { skipped++; continue; }

            try {
                const meta = await fetchLabelMeta(setid);
                await sleep(DELAY_MS);
                if (!meta) { skipped++; continue; }
                if (!isAcceptedLabelType(meta.label_type)) { skipped++; continue; }

                const sections = await fetchSections(setid);
                await sleep(DELAY_MS);

                const entity = normalize(meta, sections);
                if (!entity) { skipped++; continue; }

                records.push(entity);
                fetched++;
                if (fetched % 50 === 0) {
                    console.log(`[DAILYMED] progress: ${fetched} fetched, ${skipped} skipped`);
                }
            } catch (e) {
                console.warn(`[DAILYMED] setid ${setid} failed: ${e.message} — skipping`);
                skipped++;
            }
        }

        const maxPage = Math.ceil((total ?? 0) / LIST_PAGE_SIZE);
        if (page >= maxPage) break;
        page++;
    }

    console.log(`[DAILYMED] Done: ${records.length} labels fetched, ${skipped} skipped`);
    return { records, nextSinceToken: todayIso() };
}
