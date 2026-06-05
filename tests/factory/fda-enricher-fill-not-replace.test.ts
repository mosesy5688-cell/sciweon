// @ts-nocheck
/**
 * FIX B1 ([[cross_cycle_silent_data_loss]]) — fda-enricher FILL-not-replace.
 *
 * fda-enricher runs BEFORE the faers enricher every cron, non-cursored over the
 * full withUnii set. The openFDA aggregateSignals object carries NO faers_*
 * fields, so the prior `c.fda_signals = signals` FULL-replaced the object and
 * WIPED the prior-cycle FAERS Cat-E signal (faers_top_adr_terms /
 * faers_total_top_count) that compound-faers-enricher had stamped onto the SAME
 * record.fda_signals. mergeFdaSignals spread-merges so faers_* (and any other
 * pre-existing) fields SURVIVE while the fresh openFDA fields win.
 */

import { describe, it, expect } from 'vitest';
import { mergeFdaSignals } from '../../scripts/factory/fda-enricher.js';

describe('fda-enricher mergeFdaSignals (FILL-not-replace)', () => {
    it('keeps a pre-existing FAERS Cat-E signal when openFDA signals stamp', () => {
        // Prior cycle: faers enricher stamped these onto c.fda_signals.
        const existing = {
            faers_top_adr_terms: ['NAUSEA', 'HEADACHE', 'DIZZINESS'],
            faers_total_top_count: 12345,
        };
        // This cycle: openFDA aggregateSignals returns a fresh object, NO faers_*.
        const signals = {
            label_count: 3,
            recall_count: 1,
            has_boxed_warning: true,
            pharm_classes: ['NSAID'],
        };
        const merged = mergeFdaSignals(existing, signals);
        // The FAERS Cat-E signal SURVIVES (the bug being fixed wiped it).
        expect(merged.faers_top_adr_terms).toEqual(['NAUSEA', 'HEADACHE', 'DIZZINESS']);
        expect(merged.faers_total_top_count).toBe(12345);
        // The openFDA fields are present + current.
        expect(merged.label_count).toBe(3);
        expect(merged.recall_count).toBe(1);
        expect(merged.has_boxed_warning).toBe(true);
        expect(merged.pharm_classes).toEqual(['NSAID']);
    });

    it('overlapping openFDA fields take the fresh value (current cycle wins)', () => {
        const existing = { label_count: 1, faers_total_top_count: 99 };
        const signals = { label_count: 5, recall_count: 0, has_boxed_warning: false };
        const merged = mergeFdaSignals(existing, signals);
        expect(merged.label_count).toBe(5); // fresh openFDA value wins
        expect(merged.faers_total_top_count).toBe(99); // untouched faers_* preserved
        expect(merged.recall_count).toBe(0);
    });

    it('no pre-existing fda_signals (undefined) → just the openFDA object', () => {
        const signals = { label_count: 2, recall_count: 0, has_boxed_warning: false };
        const merged = mergeFdaSignals(undefined, signals);
        expect(merged).toEqual(signals);
    });
});
