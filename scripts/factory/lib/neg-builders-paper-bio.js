/**
 * NegEvidence builders for paper-retraction + inactive-bioassay signals.
 */

export function* buildPaperRetraction(papers) {
    const now = new Date().toISOString();
    for (const p of papers) {
        if (!p.is_retracted) continue;
        const source = p.retraction_source === 'crossref_retraction_watch'
            ? 'retraction_watch'
            : (p.retraction_source === 'pubmed' ? 'pubmed_pubtype' : 'retraction_watch');
        const crossSource = [];
        if (p.retraction_source === 'multi_source_consensus') {
            crossSource.push(
                { source: 'retraction_watch', agreement: 'full' },
                { source: 'pubmed_pubtype', agreement: 'full' },
            );
        }
        yield {
            id: `sciweon::neg::retraction::${p.doi ? p.doi.replace(/[^a-zA-Z0-9.]/g, '_') : p.openalex_id ?? p.pmid ?? 'unknown'}`,
            evidence_type: 'paper_retraction',
            subject: { paper_id: p.id },
            failure: {
                reason_category: p.retraction_nature ?? 'Retraction',
                extraction_method: source === 'retraction_watch'
                    ? 'retraction_watch_canonical'
                    : 'pubmed_pubtype_canonical',
                extraction_confidence: 95,
            },
            detail: {
                doi: p.doi,
                pmid: p.pmid,
                retraction_doi: p.retraction_doi,
                journal: p.venue,
                title: (p.title ?? '').slice(0, 300),
            },
            occurred_date: p.retraction_date ?? null,
            observed_date: now,
            severity: 'major',
            confidence: {
                overall: crossSource.length > 0 ? 100 : 90,
                extraction_quality: 95,
                source_reliability: 90,
                method: 'negative_evidence_v1',
            },
            provenance: {
                primary_source: source,
                source_id: p.retraction_doi ?? p.doi ?? p.pmid ?? p.openalex_id,
                extraction_timestamp: now,
                extraction_method: 'multi_source_retraction_v0.2.3',
            },
            cross_source_confirmations: crossSource.length > 0 ? crossSource : undefined,
        };
    }
}

export function* buildBioassayInactive(bioactivities) {
    const now = new Date().toISOString();
    for (const b of bioactivities) {
        if (b.is_active !== false) continue;
        // Method tag from Sciweon bioactivity-scorer (V0.2.2)
        const method = b.is_active_method ?? 'sciweon_value_threshold_v1';
        if (method.includes('inconclusive')) continue; // skip gray-zone
        const isStandardMetric = ['concentration_threshold_v1', 'inhibition_threshold_v1'].includes(method);
        yield {
            id: `sciweon::neg::bioassay::${b.id.replace('sciweon::bioactivity::', '')}`,
            evidence_type: 'inactive_bioassay',
            subject: {
                compound_id: b.compound_id,
                target_id: b.target?.uniprot_accession
                    ? `uniprot::${b.target.uniprot_accession}`
                    : (b.target_id ?? undefined),
                bioactivity_id: b.id,
            },
            failure: {
                reason_category: 'measured_inactive',
                extraction_method: 'sciweon_value_threshold_v1',
                extraction_confidence: isStandardMetric ? 85 : 50,
            },
            detail: {
                activity_type: b.activity_type,
                value: b.value,
                unit: b.unit,
                is_active_method: method,
                assay_type: b.assay_type,
                target_protein_name: b.target?.protein_name ?? null,
            },
            occurred_date: null,
            observed_date: now,
            severity: 'minor',
            confidence: {
                overall: b.sciweon_confidence ?? 60,
                extraction_quality: isStandardMetric ? 85 : 50,
                source_reliability: 80,
                method: 'negative_evidence_v1',
            },
            provenance: {
                primary_source: 'chembl_inactive',
                source_id: b.provenance?.sources?.[0]?.source_id ?? b.id,
                extraction_timestamp: now,
                extraction_method: 'sciweon_bioactivity_scorer_v1',
            },
        };
    }
}
