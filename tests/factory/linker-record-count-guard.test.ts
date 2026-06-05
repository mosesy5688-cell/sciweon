// @ts-nocheck
/**
 * FIX M7 ([[cross_cycle_silent_data_loss]]) — target/disease-linker record_count guard.
 *
 * target-linker.js + disease-linker.js logged otRecordCount/totalOtRows but had
 * NO assert, unlike their cursor-backed siblings (uniprot-target-enrich.js:107-109,
 * mesh/loinc/snomed-concept-linker) which HALT LOUD on records!=cursor.record_count.
 * A clean truncation / cursor-drift therefore under-read the OT bulk SILENTLY.
 * assertOtRecordCount copies the exact sibling shape (records_seen vs
 * cursor.record_count; cursor.record_count = records.length written by the
 * harvest, verified in open-targets-target-harvest.js:126).
 */

import { describe, it, expect } from 'vitest';
import { assertOtRecordCount as assertTarget } from '../../scripts/factory/lib/target-linker-helpers.js';
import { assertOtRecordCount as assertDisease } from '../../scripts/factory/lib/disease-linker-helpers.js';

describe('target-linker assertOtRecordCount', () => {
    it('THROWS when streamed count < cursor.record_count (silent under-read)', () => {
        expect(() => assertTarget(46999, 47000, 'TARGET-LINKER')).toThrow(/HALT/);
        expect(() => assertTarget(46999, 47000, 'TARGET-LINKER')).toThrow(/records_seen=46999 != cursor.record_count=47000/);
    });
    it('THROWS when streamed count > cursor.record_count (drift)', () => {
        expect(() => assertTarget(47001, 47000)).toThrow(/HALT/);
    });
    it('no throw when counts match', () => {
        expect(() => assertTarget(47000, 47000)).not.toThrow();
    });
});

describe('disease-linker assertOtRecordCount', () => {
    it('THROWS when streamed count != cursor.record_count', () => {
        expect(() => assertDisease(46000, 47123, 'DISEASE-LINKER')).toThrow(/records_seen=46000 != cursor.record_count=47123/);
    });
    it('no throw when counts match', () => {
        expect(() => assertDisease(47123, 47123)).not.toThrow();
    });
});
