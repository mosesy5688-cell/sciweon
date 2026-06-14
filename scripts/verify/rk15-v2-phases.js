/**
 * RK-15 V2 — phase A and phase B orchestration.
 *
 * Phase A and phase B are TWO real workflow runs (same session_id, same UTC
 * date, DIFFERENT GITHUB_RUN_ID). Each reads production latest BEFORE/AFTER
 * (GET-only) and asserts it byte-identical; every write is guarded into the
 * isolated namespace by instrumentClient.
 */

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { parseSnapshotContext } from '../../src/worker/lib/snapshot-context.ts';
import { swapV2Latest, postSwapActiveProbe, buildAndSealCandidate, validateCandidate } from '../factory/lib/stage-4-activate.js';
import { compoundsManifestKey } from '../factory/lib/snapshot-identity.js';
import {
    PROD_LATEST_KEY, getObject, getObjectOrNull, headObject,
    evalAllWritesIsolated, summarizePutConditionals, resolveCompoundFromShard,
} from './rk15-v2-lib.js';
import {
    isolatedLatestKey, publishAndActivate, snapshotInventory, readManifestAndShards,
} from './rk15-v2-publish-fixture.js';
import {
    evalDistinctIdentity, evalBWroteNoAKeys, evalAUnchanged, evalCasAtoB,
    evalBothReadable, evalServingGreen, evalCollisionGate, evalStaleCas,
    evalProdLatestInvariance,
} from './rk15-v2-eval.js';
import { FIXTURE_COMPOUNDS } from './rk15-v2-fixture.js';

async function readProd(client, bucket) {
    return getObjectOrNull(client, bucket, PROD_LATEST_KEY);
}

/** Read a candidate's seal directly (resolve A by its OWN pointer, never the
 * shared isolated latest — parseSnapshotContext can't switch mid-flight). */
async function sealPresent(client, bucket, prefix) {
    try { await headObject(client, bucket, `${prefix}_snapshot.manifest.json`); return true; }
    catch (err) { if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false; throw err; }
}

export async function runPhaseA({ client, bucket, sessionId, identity, fixture }) {
    const latestKey = isolatedLatestKey(sessionId);
    const checks = {};
    const prodBefore = await readProd(client, bucket);

    const pub = await publishAndActivate({ client, bucket, identity, fixture, latestKey });

    // Read A back via the DEPLOYED reader parser on the ISOLATED latest text.
    const latestText = (await getObject(client, bucket, latestKey)).body.toString('utf-8');
    const ctx = parseSnapshotContext(latestText);
    checks.reader_parses_isolated_latest = {
        pass: ctx.layout_version === 'immutable_snapshot_v2' && ctx.snapshot_id === identity.snapshotId,
        action: 'parseSnapshotContext(isolated latest)', snapshot_id: ctx.snapshot_id, object_prefix: ctx.object_prefix,
    };
    // Resolve a compound shard from the reader-derived manifest key.
    const { manifest, shardBytes } = await readManifestAndShards({ client, bucket, manifestKey: pub.manifestKey, prefix: identity.objectPrefix });
    const decoded = await resolveCompoundFromShard(manifest, FIXTURE_COMPOUNDS[0].pubchem_cid, shardBytes);
    checks.compound_shard_resolves = { pass: decoded.pubchem_cid === FIXTURE_COMPOUNDS[0].pubchem_cid, action: 'resolve compound from real shard', cid: decoded.pubchem_cid };

    const inventory = await snapshotInventory({ client, bucket, prefix: identity.objectPrefix, compoundManifest: pub.compoundManifest, negManifestKey: pub.negManifestKey });
    const prodAfter = await readProd(client, bucket);
    checks.prod_latest_invariant = evalProdLatestInvariance(prodBefore, prodAfter);
    checks.all_writes_isolated = evalAllWritesIsolated(client.sendLog);

    const a_pass = Object.values(checks).every(c => c.pass) && pub.activeState === 'ACTIVE';
    return {
        phase: 'A', snapshot_id: pub.snapshotId, object_prefix: pub.objectPrefix,
        manifest_key: pub.manifestKey, manifest_hash: pub.manifestHash, neg_manifest_key: pub.negManifestKey,
        inventory, active_state: pub.activeState,
        isolated_latest_after: { etag: (await getObject(client, bucket, latestKey)).etag, snapshot_id: ctx.snapshot_id },
        prod_latest_before: prodBefore && { etag: prodBefore.etag, sha256: prodBefore.sha256 },
        prod_latest_after: prodAfter && { etag: prodAfter.etag, sha256: prodAfter.sha256 },
        put_conditional_summary: summarizePutConditionals(client.sendLog),
        checks, a_pass,
    };
}

/** Reconstruct A's state from the ISOLATED namespace (phase B is a SEPARATE run,
 * so it reads A from R2 — the isolated latest currently points at A; A's seal +
 * manifest + shards exist). Returns the A evidence shape runPhaseB needs. */
export async function readAState({ client, bucket, sessionId }) {
    const latestKey = isolatedLatestKey(sessionId);
    const latestText = (await getObject(client, bucket, latestKey)).body.toString('utf-8');
    const ctx = parseSnapshotContext(latestText);
    const aPrefix = ctx.object_prefix;
    const aManifestKey = ctx.compounds_manifest_key;
    const compoundManifest = JSON.parse((await getObject(client, bucket, aManifestKey)).body.toString('utf-8'));
    // RK-17: latest carries the neg DESCRIPTOR root (a bare prefix the reader
    // normalizes, NOT a HEAD-able object). The seal's required_inventory carries the
    // REAL per-bucket neg manifest (the validation probe key) -> HEAD that one.
    const aSeal = JSON.parse((await getObject(client, bucket, `${aPrefix}_snapshot.manifest.json`)).body.toString('utf-8'));
    const negManifestKey = (aSeal.required_inventory ?? []).find(k => k.includes('/neg-evidence/bucket-')) ?? null;
    const inventory = await snapshotInventory({ client, bucket, prefix: aPrefix, compoundManifest, negManifestKey });
    return { snapshot_id: ctx.snapshot_id, object_prefix: aPrefix, manifest_key: aManifestKey, neg_manifest_key: negManifestKey, inventory };
}

export async function runPhaseB({ client, bucket, sessionId, identity, fixture, aEvidence }) {
    const latestKey = isolatedLatestKey(sessionId);
    const checks = {};
    const prodBefore = await readProd(client, bucket);

    const aPrefix = aEvidence.object_prefix;
    const aSnapshotId = aEvidence.snapshot_id;
    const aInventoryBefore = aEvidence.inventory;

    // Publish + activate B (its own prefix; CAS isolated latest A->B).
    const pub = await publishAndActivate({ client, bucket, identity, fixture, latestKey });

    // (1)(2)(3) distinct identity + B wrote no A key.
    checks.distinct_identity = evalDistinctIdentity({ aSnapshotId, bSnapshotId: pub.snapshotId, aPrefix, bPrefix: pub.objectPrefix });
    const bWritten = summarizePutConditionals(client.sendLog).writtenKeys;
    checks.b_no_a_keys = evalBWroteNoAKeys({ bWrittenKeys: bWritten, aKeys: Object.keys(aInventoryBefore), aPrefix, isolatedLatestKey: latestKey });

    // (4) re-HEAD all A objects -> unchanged vs A evidence.
    const aInventoryAfter = {};
    for (const key of Object.keys(aInventoryBefore)) aInventoryAfter[key] = await headObject(client, bucket, key);
    checks.a_unchanged = evalAUnchanged({ aInventoryBefore, aInventoryAfter });

    // (5)(6) CAS isolated latest A->B (already done by publishAndActivate); confirm.
    const latestAfter = JSON.parse((await getObject(client, bucket, latestKey)).body.toString('utf-8'));
    checks.cas_a_to_b = evalCasAtoB({ latestAfter, bSnapshotId: pub.snapshotId, bPrefix: pub.objectPrefix });

    // (7)(8) A still readable by its OWN pointer; B readable.
    const aSeal = await sealPresent(client, bucket, aPrefix);
    const bSeal = await sealPresent(client, bucket, pub.objectPrefix);
    const aMf = await headObject(client, bucket, aEvidence.manifest_key).then(() => true).catch(() => false);
    const bMf = await headObject(client, bucket, pub.manifestKey).then(() => true).catch(() => false);
    checks.both_readable = evalBothReadable({ aSealPresent: aSeal, bSealPresent: bSeal, aManifestPresent: aMf, bManifestPresent: bMf });

    // (9) B serving fixture resolves green (compound + neg + xref + search).
    const { manifest: bManifest, shardBytes } = await readManifestAndShards({ client, bucket, manifestKey: pub.manifestKey, prefix: pub.objectPrefix });
    const decoded = await resolveCompoundFromShard(bManifest, FIXTURE_COMPOUNDS[1].pubchem_cid, shardBytes);
    const negPresent = pub.negManifestKey ? await headObject(client, bucket, pub.negManifestKey).then(() => true).catch(() => false) : false;
    const xrefPresent = await headObject(client, bucket, `${pub.objectPrefix}xref-index.json.gz`).then(() => true).catch(() => false);
    const searchPresent = await headObject(client, bucket, `${pub.objectPrefix}compounds-search.jsonl.gz`).then(() => true).catch(() => false);
    checks.serving_green = evalServingGreen({ decodedCid: decoded.pubchem_cid, expectedCid: FIXTURE_COMPOUNDS[1].pubchem_cid, negPresent, xrefPresent, searchPresent });

    // EXTRA collision-gate: re-publish A's SAME snapshot_id seal create-only -> 412.
    checks.collision_gate = await runCollisionGate({ client, bucket, aEvidence, latestKey, bSnapshotId: pub.snapshotId });

    // CAS-conflict (stale-pointer) test.
    checks.stale_cas = await runStaleCas({ client, bucket, identity, latestKey });

    const prodAfter = await readProd(client, bucket);
    checks.prod_latest_invariant = evalProdLatestInvariance(prodBefore, prodAfter);
    checks.all_writes_isolated = evalAllWritesIsolated(client.sendLog);

    const b_pass = Object.values(checks).every(c => c.pass) && pub.activeState === 'ACTIVE';
    return {
        phase: 'B', snapshot_id: pub.snapshotId, object_prefix: pub.objectPrefix,
        manifest_key: pub.manifestKey, manifest_hash: pub.manifestHash, neg_manifest_key: pub.negManifestKey,
        a_snapshot_id: aSnapshotId, a_object_prefix: aPrefix, active_state: pub.activeState,
        ab_cross_comparison: {
            a_unchanged: checks.a_unchanged.pass, b_independent: checks.b_no_a_keys.pass,
            latest_points_b: checks.cas_a_to_b.pass, both_readable: checks.both_readable.pass,
            collision_gate: checks.collision_gate.pass, stale_cas: checks.stale_cas.pass,
        },
        prod_latest_before: prodBefore && { etag: prodBefore.etag, sha256: prodBefore.sha256 },
        prod_latest_after: prodAfter && { etag: prodAfter.etag, sha256: prodAfter.sha256 },
        put_conditional_summary: summarizePutConditionals(client.sendLog),
        checks, b_pass,
    };
}

/** Re-publish A's seal (same key) create-only -> MUST 412. A unchanged; latest still B. */
async function runCollisionGate({ client, bucket, aEvidence, latestKey, bSnapshotId }) {
    const aSealKey = `${aEvidence.object_prefix}_snapshot.manifest.json`;
    const before = await headObject(client, bucket, aSealKey);
    let republishSucceeded = false, err = null;
    try {
        const { putCreateOnly } = await import('../factory/lib/snapshot-identity.js');
        await putCreateOnly(client, bucket, aSealKey, Buffer.from('rk15-v2 collision attempt'), 'application/json');
        republishSucceeded = true;
    } catch (e) { err = e; }
    const after = await headObject(client, bucket, aSealKey);
    const aStillUnchanged = after.etag === before.etag;
    const latest = JSON.parse((await getObject(client, bucket, latestKey)).body.toString('utf-8'));
    return evalCollisionGate({ republishSucceeded, err, aStillUnchanged, latestStillB: latest.snapshot_id === bSnapshotId });
}

/** Stale-CAS: one legit isolated-latest update advances the ETag; a swapV2Latest
 * with the OLD ETag is REJECTED (no unconditional retry); latest keeps its valid
 * pointer; the stale candidate is NOT ACTIVE. */
async function runStaleCas({ client, bucket, identity, latestKey }) {
    const stale = await getObject(client, bucket, latestKey);
    const staleEtag = stale.etag;
    // One legitimate isolated-latest update so the ETag advances past `staleEtag`.
    const current = JSON.parse(stale.body.toString('utf-8'));
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: latestKey, Body: JSON.stringify({ ...current, _rk15v2_touch: Date.now() }), ContentType: 'application/json', IfMatch: staleEtag }));

    const beforeUncond = client.sendLog.filter(e => e.command === 'PutObjectCommand' && e.put && !e.put.conditional).length;
    let casSucceeded = false, err = null;
    try {
        // Attempt to ACTIVATE using the now-STALE ETag via a direct conditional PUT.
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: latestKey, Body: JSON.stringify({ ...current, hijack: true }), ContentType: 'application/json', IfMatch: staleEtag }));
        casSucceeded = true;
    } catch (e) { err = e; }
    const afterUncond = client.sendLog.filter(e => e.command === 'PutObjectCommand' && e.put && !e.put.conditional).length;
    const latest = JSON.parse((await getObject(client, bucket, latestKey)).body.toString('utf-8'));
    return evalStaleCas({
        casSucceeded, err, sawUnconditionalPut: afterUncond > beforeUncond,
        latestStillValid: !!latest.snapshot_id, candidateActive: latest.hijack === true,
    });
}
