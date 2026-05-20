/**
 * C1-4 vitest smoke test for descriptor-precompute.py --self-test.
 *
 * Shells out to the Python script and asserts exit 0. Catches:
 *   - Missing/wrong RDKit version in dev env
 *   - Python script syntax errors
 *   - Drift in QED/AromaticRings/Alerts known-value fixtures
 *
 * Skipped by default (Python+RDKit is GHA-only). Set RUN_PY_TESTS=1 to run
 * locally after `pip install rdkit==2024.9.1`. GHA workflow runs the same
 * --self-test inline in factory-1-harvest.yml as a hard gate before any
 * record write — this vitest case is the dev-machine mirror.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

const PY = process.env.PYTHON || 'python';
const SCRIPT = 'scripts/factory/descriptor-precompute.py';

describe.skipIf(!process.env.RUN_PY_TESTS)('descriptor-precompute --self-test', () => {
    it('exits 0 with aspirin/metformin/ibuprofen fixtures within tolerance', () => {
        const result = spawnSync(PY, [SCRIPT, '--self-test'], { encoding: 'utf-8' });
        if (result.error) {
            throw new Error(`Failed to spawn python (set PYTHON env or install RDKit): ${result.error.message}`);
        }
        if (result.status !== 0) {
            throw new Error(`Python --self-test exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        }
        expect(result.stdout).toMatch(/self-test PASS \(3 fixtures\)/);
    });
});
