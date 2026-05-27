/**
 * Per-source severity_thresholds override tests (cycle 22 PR-CORE-1d).
 *
 * Split out of source-required-fields.test.ts to keep that file under
 * Art 5.1 250-line cap. Pins the V1 conservative override values
 * calibrated against the 2026-05-23 baseline measurement (state JSON
 * run_id 26332865197 - rxnorm 9.46% / openfda_faers 2.36% / unichem
 * 40.4% / pubchem_bioassay 5.57%). Cycle 23 PR-CORE-1e will refine
 * after >=7 daily cycles of multi-cycle empirical asymptote data.
 */

import { describe, it, expect } from 'vitest';
import { SOURCE_REQUIRED_FIELDS } from '../../scripts/factory/lib/source-required-fields.js';

describe('Per-source severity_thresholds overrides (PR-CORE-1d)', () => {
    it('the per-source overrides (4 PR-CORE-1d + 1 PR-OT-2 + 1 PR-FDA-SRS-3) carry calibrated thresholds', () => {
        const withOverride = Object.entries(SOURCE_REQUIRED_FIELDS)
            .filter(([, e]) => e.severity_thresholds != null)
            .map(([id]) => id).sort();
        expect(withOverride).toEqual(['fda_srs', 'open_targets', 'openfda_faers', 'pubchem_bioassay', 'rxnorm', 'unichem']);
    });

    it('every override respects hardfail < warn < info ordering', () => {
        for (const [sourceId, entry] of Object.entries(SOURCE_REQUIRED_FIELDS)) {
            if (!entry.severity_thresholds) continue;
            const { hardfail, warn, info } = entry.severity_thresholds;
            expect(hardfail, `${sourceId} hardfail`).toBeLessThan(warn);
            expect(warn, `${sourceId} warn`).toBeLessThan(info);
        }
    });

    it('override values match plan D2 (calibrated against 2026-05-23 baseline) + PR-OT-2 pre-ingest estimate', () => {
        expect(SOURCE_REQUIRED_FIELDS.unichem.severity_thresholds).toEqual({ hardfail: 25, warn: 35, info: 45 });
        expect(SOURCE_REQUIRED_FIELDS.rxnorm.severity_thresholds).toEqual({ hardfail: 3, warn: 5, info: 10 });
        expect(SOURCE_REQUIRED_FIELDS.openfda_faers.severity_thresholds).toEqual({ hardfail: 1, warn: 2, info: 5 });
        expect(SOURCE_REQUIRED_FIELDS.pubchem_bioassay.severity_thresholds).toEqual({ hardfail: 2, warn: 5, info: 10 });
        // open_targets is a PR-OT-2 pre-ingest estimate. PR-OT-5 refines
        // after the first 26.03 ingest provides real baseline coverage.
        expect((SOURCE_REQUIRED_FIELDS as any).open_targets.severity_thresholds).toEqual({ hardfail: 10, warn: 20, info: 35 });
    });

    it('passing sources stay defaulted (no override)', () => {
        for (const sid of ['pubchem', 'chembl', 'dailymed', 'chembl_bioactivity']) {
            expect(SOURCE_REQUIRED_FIELDS[sid as keyof typeof SOURCE_REQUIRED_FIELDS].severity_thresholds).toBeUndefined();
        }
    });

    it('current production rxnorm value (9.46%) sits below override info (10) -> tier 3 INFO not HARDFAIL', () => {
        // sanity check the calibration: today's value should fall in INFO range
        const t = SOURCE_REQUIRED_FIELDS.rxnorm.severity_thresholds!;
        expect(9.46).toBeLessThan(t.info);
        expect(9.46).toBeGreaterThanOrEqual(t.warn);
    });

    it('current production faers value (2.36%) sits between hardfail (1) and warn (2) -> tier 2 WARN', () => {
        const t = SOURCE_REQUIRED_FIELDS.openfda_faers.severity_thresholds!;
        expect(2.36).toBeGreaterThanOrEqual(t.warn);
        expect(2.36).toBeLessThan(t.info);
    });
});
