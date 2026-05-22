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
    normalizeDailyMedDate, buildNullSections,
    fetchJson, fetchSections, listSplPage,
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
        // DailyMed v2 returns `total_elements` (not `total`). The earlier
        // `metadata.total ?? 0` always evaluated to 0 → hasUpdates=false on
        // every cron, and combined with cycle 21 cursor poisoning this
        // permanently blocked drug-labels publication. Verified live at
        // https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json
        // — response.metadata.total_elements = 156505 (full corpus).
        // [[feedback_local_verify_external_api]]
        const total = data.metadata?.total_elements ?? 0;
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
    let earlyStopped = false;

    console.log(`[DAILYMED] fetchIncremental since=${startDate}${limit < Infinity ? ` limit=${limit}` : ''}`);

    // Cycle 21 PR #8: client-side date cutoff with early-stop. DailyMed v2's
    // server-side `startdate` filter is broken (returns full 156505-label
    // corpus regardless of value, verified 2026-05-22). The list endpoint
    // sorts items by published_date desc, so we iterate newest→oldest and
    // STOP at the first item with published_date < sinceToken — everything
    // after is older too. Without this guard, daily cron times out the GHA
    // 6h job trying to ingest the entire corpus. Historical / full-corpus
    // backfill belongs in a separate bulk-harvest workflow (PLANNED row in
    // SCIWEON_BULK_ACQUISITION_TRACKER.md).
    outer: while (fetched < limit && !earlyStopped) {
        const { total: pageTotal, items } = await listSplPage(startDate, page);
        await sleep(DELAY_MS);

        if (total === null) {
            total = pageTotal;
            console.log(`[DAILYMED] ${total} total prescription labels in corpus (server startdate filter ignored; client-side cutoff @ ${startDate})`);
        }
        if (items.length === 0) break;

        for (const item of items) {
            if (fetched >= limit) break outer;
            const setid = item.setid;
            if (!setid) { skipped++; continue; }

            const itemDate = normalizeDailyMedDate(item.published_date);
            // Lexicographic ISO date compare works because both sides are
            // YYYY-MM-DD strings after normalize. If itemDate fails to
            // normalize (unrecognized format), don't early-stop — fall
            // through and let downstream skip/include decide. Conservative
            // because client cutoff is the ONLY date filter we trust.
            if (itemDate && /^\d{4}-\d{2}-\d{2}$/.test(itemDate) && itemDate < startDate) {
                console.log(`[DAILYMED] Early stop at page ${page}: item published_date=${itemDate} < startDate=${startDate}`);
                earlyStopped = true;
                break outer;
            }

            try {
                // Cycle 21 PR #6: bypass GET /spls/{setid}.json — returns
                // HTTP 415 for all setids as of 2026-05-22 (server-side
                // content-negotiation regression). Construct meta from the
                // list item fields directly. listSplPage already filters by
                // labeltype=HUMAN PRESCRIPTION DRUG, so we can hardcode
                // label_type (the per-item gate became redundant). rxcui /
                // application_numbers / dosage_forms are Stage-B work —
                // extract from the SPL XML inside the archive ZIP (cycle 22),
                // which fetchSections already downloads. C2-7 only needs
                // sections.adverse_reactions text, which IS preserved here.
                const meta = {
                    setid,
                    spl_version: item.spl_version ?? null,
                    title: item.title ?? '',
                    label_type: 'HUMAN PRESCRIPTION DRUG',
                    rxcui: [],
                    application_numbers: [],
                    dosage_forms: [],
                    published_date: item.published_date ?? null,
                };

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

    console.log(`[DAILYMED] Done: ${records.length} labels fetched, ${skipped} skipped${earlyStopped ? ' (early-stopped at sinceToken cutoff)' : ''}`);
    return { records, nextSinceToken: todayIso() };
}
