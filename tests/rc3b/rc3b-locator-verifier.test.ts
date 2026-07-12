// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { verifyLocatorArtifact } from '../../scripts/rc3b-audit/verify-artifact.mjs';
import { recomputeLocatorArtifactSha256 } from '../../scripts/rc3b-audit/locator-artifact.mjs';
import { canonicalScalarBytes } from '../../scripts/rc3b-audit/locator-extract.mjs';
import { authorizedScenario, runScenario } from './rc3b-authorized-fixtures';

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function reseal(a) { a.integrity.artifact_sha256 = recomputeLocatorArtifactSha256(a); return a; }
function rowSeal(row) {
    const b = canonicalScalarBytes(row.normalized_scalar_value, row.scalar_type);
    row.value_utf8_bytes = b.length; row.value_sha256 = createHash('sha256').update(b).digest('hex');
}
async function clean() {
    const scn = authorizedScenario(); const result = await runScenario(scn);
    return { scn, result, artifact: clone(result.locatorArtifact), input: { plan: scn.plan, templatePolicy: JSON.parse((await import('fs')).default.readFileSync(scn.policy.path)), evidence: result.evidence } };
}
function verify(c, artifact = c.artifact, input = c.input) { return verifyLocatorArtifact(artifact, input); }

describe('Gate 3 V0-V17 clean external join', () => {
    it('all V0-V17 checks pass on independently re-read synthetic artifacts', async () => {
        const c = await clean(); const r = verify(c);
        expect(r.ok).toBe(true);
        for (let i = 0; i <= 17; i += 1) expect(r.checks[`V${i}`]).not.toBe(false);
    });
    it('V0/N15/N16 rejects a tampered or anchor-inconsistent run plan first', async () => {
        const c = await clean(); const plan = clone(c.input.plan); plan.structural_locator_specs[0].max_utf8_bytes -= 1;
        expect(verify(c, c.artifact, { ...c.input, plan }).checks.V0).toBe(false);
    });
    it('V1/CE4/N36 rejects missing, duplicate, unknown groups and cursor omission', async () => {
        const c = await clean();
        for (const groups of [[], [c.artifact.object_group_results[0], c.artifact.object_group_results[0]], [{ ...c.artifact.object_group_results[0], source_object_key: 'synthetic/unknown.json' }]]) {
            const a = reseal({ ...clone(c.artifact), object_group_results: groups });
            expect(verify(c, a).checks.V1).toBe(false);
        }
    });
    it('V2/V3/N23 empty or silently dropped required rows can never be COMPLETE', async () => {
        const c = await clean(); const a = clone(c.artifact);
        a.resolved_locators = []; a.unresolved_locators = [];
        a.object_group_results[0].resolved_spec_count = 0; a.coverage.resolved_required_count = 0;
        reseal(a); const r = verify(c, a);
        expect(r.checks.V2).toBe(false); expect(r.checks.V3).toBe(false); expect(r.checks.V14).toBe(false);
    });
    it('V4/N24 rejects unknown spec_id', async () => {
        const c = await clean(); const a = clone(c.artifact); a.resolved_locators[0].spec_id = 'UNKNOWN_SPEC'; reseal(a);
        expect(verify(c, a).checks.V4).toBe(false);
    });
    it('V5/N25 rejects duplicate spec_id', async () => {
        const c = await clean(); const a = clone(c.artifact); a.resolved_locators[1].spec_id = a.resolved_locators[0].spec_id; reseal(a);
        expect(verify(c, a).checks.V5).toBe(false);
    });
    it('V6/N26 rejects resolved/unresolved overlap', async () => {
        const c = await clean(); const a = clone(c.artifact); const r = a.resolved_locators[0];
        a.unresolved_locators.push({ spec_id: r.spec_id, source_object_key: r.source_object_key, reason_code: 'LOCATOR_VALUE_INVALID' }); reseal(a);
        expect(verify(c, a).checks.V6).toBe(false);
    });
    it('V7/N29 rejects key/field/shape/semantic/scalar drift from the authorized spec', async () => {
        const fields = { source_object_key: 'synthetic/other.json', field_path: 'other', pointer_shape: 'cursor_v1', semantic_type: 'OBJECT_KEY', scalar_type: 'integer' };
        for (const [field, value] of Object.entries(fields)) {
            const c = await clean(); const a = clone(c.artifact); a.resolved_locators[0][field] = value; reseal(a);
            expect(verify(c, a).checks.V7).toBe(false);
        }
    });
    it('V8/N27 rejects scalar JSON-type mismatch', async () => {
        const c = await clean(); const a = clone(c.artifact); a.resolved_locators[0].normalized_scalar_value = 1; reseal(a);
        expect(verify(c, a).checks.V8).toBe(false);
    });
    it('V9/V10/N28 independently recomputes byte length and hash', async () => {
        const c = await clean();
        const a = clone(c.artifact); a.resolved_locators[0].value_utf8_bytes += 1; reseal(a); expect(verify(c, a).checks.V9).toBe(false);
        const b = clone(c.artifact); b.resolved_locators[0].value_sha256 = '0'.repeat(64); reseal(b); expect(verify(c, b).checks.V10).toBe(false);
    });
    it('V11 rejects a normalized value outside its committed pattern', async () => {
        const c = await clean(); const a = clone(c.artifact); const row = a.resolved_locators.find((r) => r.spec_id === 'SYN_SNAPSHOT_DATE');
        row.normalized_scalar_value = '2026-02-31'; rowSeal(row); reseal(a);
        expect(verify(c, a).checks.V11).toBe(false);
    });
    it('V12/N30/N31 recomputes source-specific cross-field equality', async () => {
        const c = await clean(); const a = clone(c.artifact); const row = a.resolved_locators.find((r) => r.spec_id === 'SYN_COMPOUNDS_MANIFEST');
        row.normalized_scalar_value = 'snapshots/2026-01-01/1-1/other.json'; rowSeal(row); reseal(a);
        expect(verify(c, a).checks.V12).toBe(false);
    });
    it('V13 rejects inconsistent source ETag/length/hash within one object', async () => {
        const c = await clean(); const a = clone(c.artifact); a.resolved_locators[1].source_etag = 'different'; reseal(a);
        expect(verify(c, a).checks.V13).toBe(false);
    });
    it('V14 rejects builder-supplied false coverage or COMPLETE', async () => {
        const c = await clean(); const a = clone(c.artifact); a.coverage.applicable_spec_count = 0; reseal(a);
        expect(verify(c, a).checks.V14).toBe(false);
    });
    it('V15 any required unresolved cannot remain COMPLETE', async () => {
        const c = await clean(); const a = clone(c.artifact); const row = a.resolved_locators.pop();
        a.unresolved_locators.push({ spec_id: row.spec_id, source_object_key: row.source_object_key, reason_code: 'LOCATOR_VALUE_INVALID' });
        a.object_group_results[0].resolved_spec_count -= 1; a.object_group_results[0].unresolved_spec_count += 1;
        a.coverage.resolved_required_count -= 1; a.coverage.unresolved_required_count += 1; a.artifact_status = 'COMPLETE'; reseal(a);
        expect(verify(c, a).checks.V15).toBe(false);
    });
    it('V16 rejects different-run identity or authorization substitution', async () => {
        const c = await clean(); const a = clone(c.artifact); a.run_identity.workflow_run_id = '999'; reseal(a);
        expect(verify(c, a).checks.V16).toBe(false);
        const b = clone(c.artifact); b.authorization.authorized_harness_sha = 'b'.repeat(40); reseal(b);
        expect(verify(c, b).checks.V16).toBe(false);
    });
    it('V17/N35 source mismatch requires FAILED and cannot overlap an admitted row', async () => {
        const c = await clean(); const a = clone(c.artifact); const row = a.resolved_locators[0];
        a.unresolved_locators.push({ spec_id: row.spec_id, source_object_key: row.source_object_key, reason_code: 'LOCATOR_SOURCE_MISMATCH' });
        a.artifact_status = 'COMPLETE'; reseal(a);
        expect(verify(c, a).checks.V17).toBe(false);
    });
    it('N11 extra artifact property fails the closed schema', async () => {
        const c = await clean(); const a = clone(c.artifact); a.unexpected = true; reseal(a);
        expect(verify(c, a).checks.schema).toBe(false);
    });
    it('N14 post-run mutation without resealing fails artifact integrity', async () => {
        const c = await clean(); const a = clone(c.artifact); a.artifact_status = 'FAILED';
        expect(verify(c, a).checks.integrity).toBe(false);
    });
});
