/**
 * Open Targets schema-extension tests (cycle 23 PR-OT-2).
 *
 * Pins the registry entry shape + confidence weight against the design
 * locked 2026-05-24 in [[project_cycle23_pr_ot_1_shipped]] memory:
 *   - top-level field naming (known_drug_info, target_associations[],
 *     genetic_evidence[]) - matches existing chembl_id / drug_status
 *     convention, NOT nested under external_ids
 *   - drug_status denominator gate (PR-OT-6 re-scope from chembl_id) -
 *     OT only enriches KNOWN DRUGS, so the eligible denominator mirrors
 *     the chembl source's drug_status gate; the wider chembl_id-bearing
 *     set is surfaced as scope_boundary_gate telemetry, not the denominator.
 *     (OT still bridges through the ChEMBL molecule key at merge time; the
 *     gate is the completeness DENOMINATOR, not the join key.)
 *   - confidence weight=8 per SCIWEON_DATA_SOURCES_GLOBAL.md §619
 *   - aggregated bundle file = compounds-enriched.jsonl (OT enriches
 *     the compound entity, not new entity types per DATA_SOURCES §672)
 *
 * These pins exist so that PR-OT-3 (ingest) / PR-OT-4 (stage-3 merge) /
 * PR-OT-5 (cron + completeness) cannot accidentally drift the contract
 * without an explicit test update.
 */

import { describe, it, expect } from 'vitest';
import { SOURCE_REQUIRED_FIELDS } from '../../scripts/factory/lib/source-required-fields.js';
// @ts-ignore - confidence-scorer.js has no .d.ts; test reads runtime export only
import * as ConfScorer from '../../scripts/factory/lib/confidence-scorer.js';

describe('Open Targets registry entry (PR-OT-2)', () => {
    const ot = (SOURCE_REQUIRED_FIELDS as any).open_targets;

    it('is registered in SOURCE_REQUIRED_FIELDS', () => {
        expect(ot).toBeDefined();
    });

    it('routes to the compound enrichment file (not new entity)', () => {
        expect(ot.file).toBe('compounds-enriched.jsonl');
    });

    it('gates by drug_status (PR-OT-6 re-scope: OT-eligible = known-drug set, mirrors chembl)', () => {
        expect(ot.denominator_gate).toBe('drug_status');
    });

    it('surfaces the wider chembl_id-bearing set as scope_boundary_gate telemetry (PR-OT-6)', () => {
        expect(ot.scope_boundary_gate).toBe('chembl_id');
    });

    it('required_paths uses known_drug_info.chembl_id as strict-enriched proxy', () => {
        expect(ot.required_paths).toEqual(['known_drug_info.chembl_id']);
    });

    it('carries pre-ingest severity thresholds (PR-OT-5 refines)', () => {
        expect(ot.severity_thresholds).toEqual({ hardfail: 10, warn: 20, info: 35 });
    });

    it('entry + nested arrays are frozen (matches the rest of the registry)', () => {
        expect(Object.isFrozen(ot)).toBe(true);
        expect(Object.isFrozen(ot.required_paths)).toBe(true);
        expect(Object.isFrozen(ot.severity_thresholds)).toBe(true);
    });
});

describe('Open Targets confidence weight (PR-OT-2)', () => {
    it('scoreDataPoint treats open_targets with derived-aggregation weight=8', () => {
        // single-source path: score = 40 + min(20, weight) = 40 + 8 = 48
        const r = ConfScorer.scoreDataPoint(['open_targets']);
        expect(r).toBe(48);
    });

    it('open_targets is BELOW truth-source weight 10 in single-source mode', () => {
        // truth source pubchem: 40 + min(20, 10) = 50
        const truth = ConfScorer.scoreDataPoint(['pubchem']);
        const ot = ConfScorer.scoreDataPoint(['open_targets']);
        expect(truth).toBeGreaterThan(ot);
    });

    it('open_targets is ABOVE secondary-source weight 5 in single-source mode', () => {
        // secondary openalex: 40 + min(20, 5) = 45
        const sec = ConfScorer.scoreDataPoint(['openalex']);
        const ot = ConfScorer.scoreDataPoint(['open_targets']);
        expect(ot).toBeGreaterThan(sec);
    });

    it('open_targets + pubchem multi-source consensus stays >= 80 floor', () => {
        const r = ConfScorer.scoreDataPoint(['pubchem', 'open_targets']);
        expect(r).toBeGreaterThanOrEqual(80);
    });
});
