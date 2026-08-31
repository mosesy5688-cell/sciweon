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
        detail: { report_count: 15000 },
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

    it('preserves RAW evidence while withholding the derived grade', () => {
        const e = entry([30, 0, 26, 0], { faers_adr_signal: 30, inactive_bioassay: 26 });
        const out = shapePagedResponse(
            'sciweon::compound::CID:2244', e,
            [record('n1', 'faers_adr_signal', 'critical')],
            0, 50, '2026-06-14', BASE,
        ) as Record<string, any>;
        // WITHHELD: the grade. Sciweon derives severity itself from raw report
        // counts (neg-builders-fda.js thresholds), so it is not evidence.
        expect(out.signals_by_severity).toBeUndefined();
        expect(out.signals[0].severity).toBeUndefined();
        // PRESERVED: everything the consumer needs to judge for itself.
        expect(out.negative_signals_count).toBe(56);
        expect(out.signals_by_evidence_type).toEqual({ faers_adr_signal: 30, inactive_bioassay: 26 });
        expect(out.pagination).toEqual({
            offset: 0, limit: 50, returned: 1, has_more: true, next_offset: 1,
        });
        expect(out.signals[0].evidence_type).toBe('faers_adr_signal');
        expect(out.signals[0].detail.report_count).toBe(15000);
        expect(out.signals[0].provenance).toEqual({ primary_source: 'openfda_faers', source_id: 'n1' });
    });

    it('publishes no risk-grade vocabulary anywhere in the payload', () => {
        const out = shapePagedResponse(
            'sciweon::compound::CID:2244',
            entry([30, 0, 26, 0], { faers_adr_signal: 30, inactive_bioassay: 26 }),
            [record('n1', 'faers_adr_signal', 'critical')],
            0, 50, '2026-06-14', BASE,
        );
        const raw = JSON.stringify(out);
        for (const banned of ['signals_by_severity', '"severity"', 'highest_severity',
            'agent_recommendation', 'critical risk', 'risk-benefit']) {
            expect(raw).not.toContain(banned);
        }
    });

    it('links only to routes that exist', () => {
        const out = shapePagedResponse(
            'sciweon::compound::CID:2244',
            entry([1, 0, 0, 0], { faers_adr_signal: 1 }),
            [record('n1', 'faers_adr_signal', 'critical')],
            0, 50, '2026-06-14', BASE,
        ) as Record<string, any>;
        // /api/v1/entity/... is not a registered route -- it must not be minted.
        expect(JSON.stringify(out)).not.toContain('/api/v1/entity/');
        expect(out.compound.url).toBe(`${BASE}/api/v1/compound/sciweon%3A%3Acompound%3A%3ACID%3A2244`);
        expect(out.signals[0].url).toBeUndefined();
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
        const withFaers = evidenceUseBoundary({ faers_adr_signal: 30, inactive_bioassay: 26 });
        expect(withFaers.spontaneous_report_types_enumerated).toBe(true);
        expect(withFaers.spontaneous_report_types_present).toEqual(['faers_adr_signal']);

        // Enumerated and genuinely none present -> [] is a true assertion.
        const withoutFaers = evidenceUseBoundary({ trial_failure: 3 });
        expect(withoutFaers.spontaneous_report_types_enumerated).toBe(true);
        expect(withoutFaers.spontaneous_report_types_present).toEqual([]);
    });

    it('UNKNOWN IS NOT EMPTY: an unenumerable caller gets null, never []', () => {
        // The repurposing aggregator cannot enumerate evidence types. Emitting
        // [] there would assert "no spontaneous-report data present", a fact
        // Sciweon does not have -- the same class of error as the removed
        // severity grade, one field further down.
        for (const b of [evidenceUseBoundary(), evidenceUseBoundary(undefined)]) {
            expect(b.spontaneous_report_types_enumerated).toBe(false);
            expect(b.spontaneous_report_types_present).toBeNull();
            expect(b.spontaneous_report_types_present).not.toEqual([]);
            // The caveat still travels regardless of enumerability.
            expect(b.spontaneous_report_caveat).toContain('cannot establish causation');
        }
    });

    it('the repurposing bundle reports unknown, not empty', async () => {
        const { evidenceUseBoundary: eub } = await import('../../src/worker/lib/neg-evidence-response');
        const b = eub();
        expect(b.spontaneous_report_types_enumerated).toBe(false);
        expect(b.spontaneous_report_types_present).toBeNull();
        expect(JSON.stringify(b)).not.toContain('"spontaneous_report_types_present":[]');
    });

    it('travels on the paged response itself', () => {
        const out = shapePagedResponse(
            'sciweon::compound::CID:2244',
            entry([1, 0, 0, 0], { faers_adr_signal: 1 }),
            [record('n1', 'faers_adr_signal', 'critical')],
            0, 50, '2026-06-14', BASE,
        );
        expect(out.evidence_use_boundary.spontaneous_report_types_present).toEqual(['faers_adr_signal']);
        expect(out.evidence_use_boundary.spontaneous_report_types_enumerated).toBe(true);
        expect(out.evidence_use_boundary.research_use_only).toBe(true);
    });
});
