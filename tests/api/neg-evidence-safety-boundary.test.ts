/**
 * P0 PUBLIC SCIENTIFIC-SAFETY REPAIR — regression guards.
 *
 * The negative-evidence surface previously emitted a synthesized `verdict`
 * carrying `highest_severity` and a hardcoded `agent_recommendation`. On a
 * threshold of ONE critical signal it told any caller -- including autonomous
 * agents -- to treat the compound as carrying critical risk and to require
 * explicit justification for clinical-decision use.
 *
 * That was wrong on three axes at once:
 *   - scientifically: the `critical` bucket is dominated by spontaneous
 *     adverse-event reports, which have no exposure denominator, plus
 *     inactive-bioassay records, where inactivity is frequently desirable;
 *   - contractually: the product's stated non-goals exclude clinical decisions
 *     and final scientific or regulatory judgments;
 *   - operationally: the terms behind those counts may be rights-withheld, so
 *     the grade was asserted while its evidence was suppressed.
 *
 * These tests operate on the pure shaping functions -- no R2 mock needed --
 * and exist so the verdict cannot be reintroduced silently.
 */

import { describe, it, expect } from 'vitest';
import {
    shapePagedResponse,
    evidenceUseBoundary,
    type NegEvidenceRecord,
} from '../../src/worker/lib/neg-evidence-response';
import type { NegManifestEntry } from '../../src/worker/lib/neg-manifest-loader';

const BASE = 'https://sciweon.com';

function entry(sev: [number, number, number, number], byType: Record<string, number>): NegManifestEntry {
    const total = sev.reduce((a, b) => a + b, 0);
    return { total, severity_rollup: sev, type_rollup: byType } as unknown as NegManifestEntry;
}

function record(id: string, type: string, severity: NegEvidenceRecord['severity']): NegEvidenceRecord {
    return {
        id,
        evidence_type: type,
        severity,
        provenance: { primary_source: 'openfda_faers', source_id: id },
    };
}

describe('no synthesized verdict is emitted on the negative-evidence surface', () => {
    it('a critical-heavy FAERS profile yields no verdict, grade or recommendation', () => {
        const e = entry([30, 0, 26, 0], { faers_adr_signal: 30, inactive_bioassay: 26 });
        const out = shapePagedResponse(
            'sciweon::compound::CID:2244', e,
            [record('n1', 'faers_adr_signal', 'critical')],
            0, 50, '2026-06-14', BASE,
        ) as Record<string, unknown>;

        expect(out.verdict).toBeUndefined();
        const raw = JSON.stringify(out);
        for (const banned of [
            'agent_recommendation', 'highest_severity', 'critical risk',
            'clinical-decision', 'clinical decision', 'risk-benefit',
        ]) {
            expect(raw).not.toContain(banned);
        }
    });

    it('preserves raw evidence: counts, pagination, provenance and unknown types', () => {
        const e = entry([30, 0, 26, 0], { faers_adr_signal: 30, inactive_bioassay: 26 });
        const out = shapePagedResponse(
            'sciweon::compound::CID:2244', e,
            [record('n1', 'faers_adr_signal', 'critical')],
            0, 50, '2026-06-14', BASE,
        );
        // Source-classified severity counts survive verbatim -- the repair
        // removes the ADJUDICATION, never the evidence.
        expect(out.signals_by_severity).toEqual({ critical: 30, major: 0, minor: 26, unknown: 0 });
        expect(out.negative_signals_count).toBe(56);
        expect(out.pagination).toEqual({
            offset: 0, limit: 50, returned: 1, has_more: true, next_offset: 1,
        });
        expect(out.signals[0].provenance).toEqual({ primary_source: 'openfda_faers', source_id: 'n1' });
    });

    it('zero signals is not reported as a reassuring conclusion', () => {
        const out = shapePagedResponse(
            'sciweon::compound::CID:1111', null, [], 0, 50, '2026-06-14', BASE,
        ) as Record<string, unknown>;
        expect(out.verdict).toBeUndefined();
        expect(out.negative_signals_count).toBe(0);
        expect(JSON.stringify(out)).not.toMatch(/no negative evidence found/i);
    });
});

describe('evidence-use boundary', () => {
    it('disclaims causality, incidence and clinical decision support', () => {
        const b = evidenceUseBoundary();
        expect(b.research_use_only).toBe(true);
        expect(b.clinical_decision_support).toBe(false);
        expect(b.causality_assessed).toBe(false);
        expect(b.incidence_or_rate_derivable).toBe(false);
    });

    it('states the spontaneous-report limits unconditionally', () => {
        const b = evidenceUseBoundary();
        expect(b.spontaneous_report_caveat).toContain('cannot establish causation');
        expect(b.spontaneous_report_caveat).toContain('no exposure');
        expect(b.spontaneous_report_caveat).toMatch(/incidence/);
        // Absence of reports must never be presented as absence of risk.
        expect(b.spontaneous_report_caveat).toContain('not evidence of absence');
    });

    it('reports which spontaneous-report types are actually present', () => {
        expect(evidenceUseBoundary({ faers_adr_signal: 30, inactive_bioassay: 26 })
            .spontaneous_report_types_present).toEqual(['faers_adr_signal']);
        expect(evidenceUseBoundary({ trial_failure: 3 })
            .spontaneous_report_types_present).toEqual([]);
        // Unenumerable caller (aggregator): empty list, caveat still carried.
        expect(evidenceUseBoundary().spontaneous_report_types_present).toEqual([]);
    });

    it('travels on the paged response itself', () => {
        const out = shapePagedResponse(
            'sciweon::compound::CID:2244',
            entry([1, 0, 0, 0], { faers_adr_signal: 1 }),
            [record('n1', 'faers_adr_signal', 'critical')],
            0, 50, '2026-06-14', BASE,
        );
        expect(out.evidence_use_boundary.spontaneous_report_types_present).toEqual(['faers_adr_signal']);
        expect(out.evidence_use_boundary.research_use_only).toBe(true);
    });
});
