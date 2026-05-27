// @ts-nocheck
/**
 * PR-HARVEST-SCOPE-TIER 2026-05-27: validation-gate scope-tier behavior.
 *
 * Triggered by F1 run 26512200020 PubChem Harvest cron halt on CID:111615
 * molecular_weight.value=18657 > max 10000 -- a known macromolecule outside
 * Sciweon's small-molecule drug-graph scope, halted the entire 5000-CID
 * batch in REJECT mode (1600 already-fetched records lost to halt-before-commit).
 *
 * Contract under scope tier:
 *   - Scope-only violations: return {passed: false, excluded: true,
 *     exclusion_reason, exclusions: [...]} -- NO throw, NO halt.
 *   - Primary co-present: throw (primary takes priority; scope co-present is
 *     reported in error message for ops visibility but does not cancel the throw).
 *   - Derived co-present (no primary, no scope): existing derived-warning path
 *     unchanged -- {passed: true, entity, warnings: [...]}.
 *
 * Uses a minimal local schema to isolate scope-tier behavior from the full
 * COMPOUND_SCHEMA's required-field complexity.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { gate, setMode, MODE_REJECT } from '../../scripts/factory/lib/validation-gate.js';

const MINI_SCHEMA = {
    inchi_key: { type: 'string', required: true, pattern: /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/ },
    molecular_weight: {
        type: 'object', required: true,
        shape: {
            value: { type: 'number', min: 0, max: 10000 },
            unit: { type: 'string', enum: ['Da'] },
        },
    },
};

beforeAll(() => setMode(MODE_REJECT));

describe('gate() scope-tier behavior (PR-HARVEST-SCOPE-TIER)', () => {
    it('1. macromolecule (molecular_weight > 10000) returns excluded, does NOT throw', () => {
        const entity = {
            inchi_key: 'AAAAAAAAAAAAAA-BBBBBBBBBB-N',
            molecular_weight: { value: 18657, unit: 'Da' },
        };
        const r = gate(entity, MINI_SCHEMA, 'CID:111615');
        expect(r.passed).toBe(false);
        expect(r.excluded).toBe(true);
        expect(r.exclusion_reason).toBe('macromolecule_out_of_scope');
        expect(Array.isArray(r.exclusions)).toBe(true);
        expect(r.exclusions.length).toBe(1);
        expect(r.exclusions[0].path).toMatch(/molecular_weight\.value$/);
    });

    it('2. ANTI-REGRESSION: scope exclusion does NOT halt harvester batch', () => {
        const entities = [
            { inchi_key: 'AAAAAAAAAAAAAA-BBBBBBBBBB-N', molecular_weight: { value: 100, unit: 'Da' } },
            { inchi_key: 'CCCCCCCCCCCCCC-DDDDDDDDDD-N', molecular_weight: { value: 18657, unit: 'Da' } },  // macromolecule
            { inchi_key: 'EEEEEEEEEEEEEE-FFFFFFFFFF-N', molecular_weight: { value: 250, unit: 'Da' } },
        ];
        let processed = 0, excluded = 0;
        for (let i = 0; i < entities.length; i++) {
            const r = gate(entities[i], MINI_SCHEMA, `CID:${i}`);  // must NOT throw
            if (r.excluded) excluded++;
            else if (r.passed) processed++;
        }
        expect(processed).toBe(2);
        expect(excluded).toBe(1);
    });

    it('3. primary violation still halts the chain (primary takes priority over scope)', () => {
        const entity = {
            inchi_key: 'INVALID',  // pattern mismatch = primary
            molecular_weight: { value: 18657, unit: 'Da' },  // also scope
        };
        expect(() => gate(entity, MINI_SCHEMA, 'CID:99')).toThrow(/primary violations/);
    });

    it('4. error message reports scope co-presence when primary halts', () => {
        const entity = {
            inchi_key: 'INVALID',
            molecular_weight: { value: 18657, unit: 'Da' },
        };
        try {
            gate(entity, MINI_SCHEMA, 'CID:99');
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.message).toMatch(/scope-exclusion violations co-present/);
        }
    });

    it('5. fully clean entity returns passed: true (unchanged behavior)', () => {
        const entity = {
            inchi_key: 'AAAAAAAAAAAAAA-BBBBBBBBBB-N',
            molecular_weight: { value: 300, unit: 'Da' },
        };
        const r = gate(entity, MINI_SCHEMA, 'CID:OK');
        expect(r.passed).toBe(true);
        expect(r.excluded).toBeUndefined();
    });

    it('6. molecular_weight at exact boundary 10000 passes (not scope)', () => {
        const entity = {
            inchi_key: 'AAAAAAAAAAAAAA-BBBBBBBBBB-N',
            molecular_weight: { value: 10000, unit: 'Da' },
        };
        const r = gate(entity, MINI_SCHEMA, 'CID:BOUNDARY');
        expect(r.passed).toBe(true);
    });
});
