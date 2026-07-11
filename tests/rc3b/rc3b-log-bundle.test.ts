// @ts-nocheck
/**
 * RC-3B-P0B real structural log bundle + INDEPENDENT verification (CHANGE C).
 * The verifier READS the actual written log file, recomputes its sha256, and
 * re-runs the leak scan on the actual parsed lines -- it is NOT a self-asserted
 * 64-hex. A clean bundle passes; a one-byte mutation fails the hash; a poisoned
 * line fails scanLogs; a missing file fails; an arbitrary declared hash (file
 * differs) fails; an empty legitimate log passes only when the exact empty-file
 * sha256 is recorded. Without a log path the two log checks are SKIPPED.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
    serializeLogBundle, logBundleSha256, parseLogBundle,
} from '../../scripts/rc3b-audit/log-bundle.mjs';
import { scanLogs } from '../../scripts/rc3b-audit/leak-scanner.mjs';
import { verifyArtifact } from '../../scripts/rc3b-audit/verify-artifact.mjs';
import { recomputeArtifactSha256 } from '../../scripts/rc3b-audit/evidence-builder.mjs';
import { runReadOnlyAudit } from '../../scripts/rc3b-audit/harness.mjs';
import { buildEvidenceFromRun } from '../../scripts/rc3b-audit/evidence-assembly.mjs';
import {
    syntheticRunManifest, syntheticRunMetadata, makeSyntheticFakeClient, SYNTHETIC_ALLOWED_BUCKETS,
} from '../../scripts/rc3b-audit/self-test.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc3b-log-'));
const OFFLINE = {};

async function cleanRun() {
    const plan = syntheticRunManifest();
    const runResult = await runReadOnlyAudit(plan, Buffer.from('{}'), {
        allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS, clientOverride: makeSyntheticFakeClient(),
    });
    const built = buildEvidenceFromRun(runResult, plan, { run_metadata: syntheticRunMetadata(plan) });
    return { evidence: built.evidence, logLines: runResult.logLines };
}

function writeLog(name, bytes) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    return p;
}

describe('RC-3B-P0B log-bundle: pure serializer', () => {
    it('serialize/parse round-trip; empty file is zero lines (not [""])', () => {
        expect(serializeLogBundle(['a', 'b'])).toBe('a\nb');
        expect(parseLogBundle('a\nb')).toEqual(['a', 'b']);
        expect(parseLogBundle('')).toEqual([]);
        expect(logBundleSha256([])).toBe(createHash('sha256').update(Buffer.from('', 'utf-8')).digest('hex'));
    });
});

describe('RC-3B-P0B log-bundle: independent verify-artifact', () => {
    it('a clean real log bundle passes the hash + scan', async () => {
        const { evidence, logLines } = await cleanRun();
        const logPath = writeLog('clean.jsonl', serializeLogBundle(logLines));
        const r = await verifyArtifact(evidence, OFFLINE, logPath);
        expect(r.checks.log_bundle_sha256).toBe(true);
        expect(r.checks.log_scan_result).toBe(true);
        expect(r.ok).toBe(true);
    });

    it('a one-byte log mutation fails the hash', async () => {
        const { evidence, logLines } = await cleanRun();
        const bytes = Buffer.from(serializeLogBundle(logLines) + 'X', 'utf-8');
        const logPath = writeLog('mutated.jsonl', bytes);
        const r = await verifyArtifact(evidence, OFFLINE, logPath);
        expect(r.checks.log_bundle_sha256).toBe(false);
        expect(r.ok).toBe(false);
    });

    it('a poisoned log line fails scanLogs (hash matched, scan fails)', async () => {
        const { evidence, logLines } = await cleanRun();
        const poisoned = [...logLines, 'X'.repeat(400)]; // blob-like run
        const bytes = Buffer.from(serializeLogBundle(poisoned), 'utf-8');
        const logPath = writeLog('poisoned.jsonl', bytes);
        // Record the poisoned file's true sha so the HASH check passes; the SCAN must fail.
        evidence.integrity_evidence.log_bundle_sha256 = createHash('sha256').update(bytes).digest('hex');
        evidence.integrity_evidence.artifact_sha256 = recomputeArtifactSha256(evidence);
        const r = await verifyArtifact(evidence, OFFLINE, logPath);
        expect(r.checks.log_bundle_sha256).toBe(true);
        expect(r.checks.log_scan_result).toBe(false);
        expect(r.ok).toBe(false);
        expect(scanLogs(parseLogBundle(bytes.toString('utf-8'))).result).toBe('FAIL');
    });

    it('a missing log file fails (not throws)', async () => {
        const { evidence } = await cleanRun();
        const r = await verifyArtifact(evidence, OFFLINE, path.join(dir, 'does-not-exist.jsonl'));
        expect(r.checks.log_bundle_sha256).toBe(false);
        expect(r.checks.log_scan_result).toBe(false);
        expect(r.ok).toBe(false);
    });

    it('an artifact declaring an arbitrary nonzero log hash (file differs) fails', async () => {
        const { evidence, logLines } = await cleanRun();
        const logPath = writeLog('clean2.jsonl', serializeLogBundle(logLines));
        evidence.integrity_evidence.log_bundle_sha256 = 'a'.repeat(64);
        evidence.integrity_evidence.artifact_sha256 = recomputeArtifactSha256(evidence);
        const r = await verifyArtifact(evidence, OFFLINE, logPath);
        expect(r.checks.log_bundle_sha256).toBe(false);
        expect(r.ok).toBe(false);
    });

    it('an empty legitimate log passes only when the exact empty-file sha256 is recorded', async () => {
        const { evidence } = await cleanRun();
        const emptyPath = writeLog('empty.jsonl', serializeLogBundle([]));
        // Wrong (non-empty) hash for an empty file -> fail.
        evidence.integrity_evidence.log_bundle_sha256 = logBundleSha256(['something']);
        evidence.integrity_evidence.artifact_sha256 = recomputeArtifactSha256(evidence);
        let r = await verifyArtifact(evidence, OFFLINE, emptyPath);
        expect(r.checks.log_bundle_sha256).toBe(false);
        // Exact empty-file sha -> pass.
        evidence.integrity_evidence.log_bundle_sha256 = logBundleSha256([]);
        evidence.integrity_evidence.artifact_sha256 = recomputeArtifactSha256(evidence);
        r = await verifyArtifact(evidence, OFFLINE, emptyPath);
        expect(r.checks.log_bundle_sha256).toBe(true);
        expect(r.checks.log_scan_result).toBe(true);
    });

    it('without a log path, the two log checks are SKIPPED', async () => {
        const { evidence } = await cleanRun();
        const r = await verifyArtifact(evidence, OFFLINE);
        expect(r.checks.log_bundle_sha256).toBe('SKIPPED');
        expect(r.checks.log_scan_result).toBe('SKIPPED');
    });
});
