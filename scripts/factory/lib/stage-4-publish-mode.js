/**
 * P-8 recovery control — stage-4 AUTO/MANUAL publish-mode resolution + gates.
 *
 * Extracted from stage-4-upload.js (Art 5.1 250-line cap). Three entrypoints:
 *   - resolveAggregatedRunId(): SET -> MANUAL mode; EMPTY -> AUTO mode.
 *   - runAutoPublishGate(): GAP-A. on:workflow_run path. Follows the latest
 *     pointer + per-run policy sidecar. PROCEED -> return; MANUAL_ONLY -> clean
 *     NO-OP exit 0 (latest untouched); missing/mismatch -> fail-loud exit 11.
 *   - runManualAttestAndDownload(): GAP-C. workflow_dispatch path. Reads the
 *     EXACT processed/aggregated/<runId>/ (NEVER latest.json), asserts the
 *     policy triplet + byte-stable HEAD before==after, writes the ATTESTED
 *     bytes to LINKED_DIR so the build consumes exactly the attested bytes.
 *
 * The S3 client factory is injected so the SAME construction the producer uses
 * is exercised by harnesses. process.exit on the terminal NO-OP/FAIL outcomes.
 */

import fs from 'fs/promises';
import path from 'path';
import { decideAutoPublish, attestManualSource } from './r2-publish-policy.js';

const LINKED_DIR = './output/linked';

export function resolveAggregatedRunId() {
    const arg = process.argv.find(a => a.startsWith('--aggregated-run-id='))?.split('=')[1];
    const v = (arg ?? process.env.AGGREGATED_RUN_ID ?? '').trim();
    return v.length > 0 ? v : null;
}

export async function runAutoPublishGate({ makeClient, bucket = process.env.R2_BUCKET, log = console } = {}) {
    log.log('\n[STAGE-4] === P-8 AUTO publication-policy gate ===');
    const client = makeClient();
    const decision = await decideAutoPublish({ client, bucket });
    if (decision.action === 'PROCEED') {
        log.log(`[STAGE-4] AUTO gate PROCEED: run=${decision.runId} policy=AUTO_ALLOWED -> publishing`);
        return decision;
    }
    if (decision.action === 'NOOP') {
        log.log(`[STAGE-4] AUTO gate NO-OP: run=${decision.runId} policy=MANUAL_ONLY -> NOT publishing (backfill_only artifact awaits explicit MANUAL F4). latest.json untouched.`);
        process.exit(0);
    }
    log.error(`[STAGE-4] AUTO gate FAIL-LOUD: ${decision.reason} -> refusing to publish.`);
    process.exit(11);
}

export async function runManualAttestAndDownload({ makeClient, bucket = process.env.R2_BUCKET, aggregatedRunId, files, linkedDir = LINKED_DIR, log = console }) {
    log.log(`\n[STAGE-4] === P-8 MANUAL mode: attest + download processed/aggregated/${aggregatedRunId}/ ===`);
    const client = makeClient();
    const att = await attestManualSource({ client, bucket, aggregatedRunId, files });
    await fs.mkdir(linkedDir, { recursive: true });
    for (const fname of files) {
        await fs.writeFile(path.join(linkedDir, fname), att.buffers[fname]);
    }
    log.log(`[STAGE-4] MANUAL attestation OK: source_run_id=${att.source_run_id} policy=${att.policy.publication_policy}/${att.policy.mode} attestation_hash=${att.aggregate_attestation_hash} files=${att.inventory.length}`);
    return att;
}
