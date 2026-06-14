/**
 * SNAPSHOT_REQUIRED_INVENTORY — THE single authoritative complete-snapshot
 * serving contract (RK-15 full-snapshot completeness fix).
 *
 * ============================ WHY THIS FILE EXISTS ============================
 * The V3-A immutable candidate `snapshots/2026-06-13/27467183738-1/` was
 * published with ONLY the compound shards + neg + xref + search and went LIVE
 * VALIDATED — yet it OMITTED every satellite snapshot file. After cutover the
 * satellite serving surfaces broke on the live product: papers/trials/
 * bioactivities/repurposing -> 503, target -> 404. Two root causes:
 *   1. the V3 candidate-build harness bypassed the real snapshot-builder's
 *      full-file publish (it published only 4 surfaces), AND
 *   2. validateCandidate only checked the compound/neg/xref/search keys, so an
 *      INCOMPLETE candidate passed VALIDATED.
 * RK-15's identity layer is immutable, but the DEFINITION of "complete snapshot"
 * was incomplete. This module is that definition — ONE SSoT, reverse-enumerated
 * from the READERS (src/worker/**) reconciled against the producer SNAPSHOT_FILES
 * (aggregated-files.js) — consumed by the candidate builder, the seal/manifest,
 * validateCandidate, the V3-A acceptance, AND the real F4 producer.
 *
 * ============================ HOW IT IS BUILT =================================
 * Every required serving object falls into ONE of two object classes:
 *
 *   SATELLITE  a whole gzipped file at `<object_prefix><fname>.gz`. The real F4
 *              snapshot-builder.js gzips EVERY SNAPSHOT_FILES entry to that key.
 *              The reader fetches it via fetchR2GunzippedText. The SATELLITE set
 *              here is reverse-enumerated from the readers and RECONCILED against
 *              SNAPSHOT_FILES (any reader key not in SNAPSHOT_FILES, or vice
 *              versa, is a CONTRACT BUG surfaced by the parity test). Each entry
 *              carries {snapshot_file, key_suffix, surface, reader, producer}.
 *
 *   STRUCTURED a multi-object surface (a manifest + shard family, or a single
 *              gzipped index) published NOT by the satellite gzip loop but by a
 *              dedicated producer path: the compound shard publisher, the neg
 *              shard publisher, and the xref/search projection PUTs. The reader
 *              derives these keys from the v2 pointer / a manifest, not from a
 *              date. These are declared so validateCandidate + the parity test
 *              treat them as REQUIRED serving surfaces too.
 *
 * The COMPLETE inventory a verifier must judge = SATELLITE_INVENTORY ∪ the
 * STRUCTURED surfaces. `requiredSatelliteKeys(objectPrefix)` returns the exact
 * `<prefix><fname>.gz` keys a complete candidate MUST carry; the seal lists them
 * and validateCandidate HEAD+decode-probes each.
 *
 * Reconciliation invariant (pinned by snapshot-inventory.test.ts +
 * stage-4-activate.test.ts): the SATELLITE snapshot_files set === the SATELLITE
 * subset of SNAPSHOT_FILES (every SNAPSHOT_FILES entry that a reader reads as a
 * whole gz file is covered; the STRUCTURED-only producer outputs that no reader
 * reads as a standalone gz — e.g. compounds-enriched is read only via the
 * sharded/whole-file compound path — are NOT double-counted as satellites).
 */

import { SNAPSHOT_FILES } from './aggregated-files.js';
import {
    compoundsManifestKey, negManifestKey, xrefIndexKey, searchProjectionKey,
} from './snapshot-identity.js';

/**
 * SATELLITE serving surfaces — reverse-enumerated from the worker readers, each
 * a whole `<prefix><snapshot_file>.gz` object. `reader` is file:line evidence of
 * the exact line that derives + fetches the key; `producer` is the F4 step that
 * writes it. The `snapshot_file` is the SNAPSHOT_FILES (pre-gzip) source name.
 *
 * THESE FOUR are the surfaces that broke at the V3-A cutover (papers/trials/
 * trial-links/bioactivities/target-index), PLUS the two whole-file legacy
 * fallbacks the readers still reach (compounds-enriched, neg-evidence whole-file)
 * which the snapshot-builder ALSO gzips. They are split out so the seal/validate
 * path can decode-probe each independently.
 */
export const SATELLITE_INVENTORY = Object.freeze([
    {
        snapshot_file: 'papers.jsonl',
        key_suffix: 'papers.jsonl.gz',
        surface: 'papers (compound papers) + repurposing aggregation',
        reader: 'src/worker/lib/paper-loader.ts:25 (loadPapersForCompound) <- repurposing-aggregator.ts:205',
        producer: 'snapshot-builder.js gzip loop over SNAPSHOT_FILES -> <prefix>papers.jsonl.gz',
    },
    {
        snapshot_file: 'trial-links.jsonl',
        key_suffix: 'trial-links.jsonl.gz',
        surface: 'trials (compound->NCT link map) + repurposing',
        reader: 'src/worker/lib/trial-loader.ts:17 (collectNctIds) <- repurposing-aggregator.ts:203',
        producer: 'snapshot-builder.js gzip loop over SNAPSHOT_FILES -> <prefix>trial-links.jsonl.gz',
    },
    {
        snapshot_file: 'trials.jsonl',
        key_suffix: 'trials.jsonl.gz',
        surface: 'trials (trial entities) + repurposing',
        reader: 'src/worker/lib/trial-loader.ts:38 (loadTrialsForCompound) <- repurposing-aggregator.ts:203',
        producer: 'snapshot-builder.js gzip loop over SNAPSHOT_FILES -> <prefix>trials.jsonl.gz',
    },
    {
        snapshot_file: 'bioactivities.jsonl',
        key_suffix: 'bioactivities.jsonl.gz',
        surface: 'bioactivities + repurposing',
        reader: 'src/worker/lib/bioactivity-loader.ts:22 (loadBioactivitiesForCompound) <- repurposing-aggregator.ts:204',
        producer: 'snapshot-builder.js gzip loop over SNAPSHOT_FILES -> <prefix>bioactivities.jsonl.gz',
    },
    {
        snapshot_file: 'target-index.json',
        key_suffix: 'target-index.json.gz',
        surface: 'target (inverse-pivot index; getTargetEntry 404 distinguished from a missing index)',
        reader: 'src/worker/lib/target-loader.ts:28,83 (loadTargetIndex) <- mcp-handlers.ts:160',
        producer: 'snapshot-builder.js gzip loop over SNAPSHOT_FILES -> <prefix>target-index.json.gz',
    },
    {
        snapshot_file: 'compounds-enriched.jsonl',
        key_suffix: 'compounds-enriched.jsonl.gz',
        surface: 'compound whole-file legacy fallback + entity-resolver whole-file scan + search-corpus fallback',
        reader: 'src/worker/lib/compound-loader.ts:172, entity-resolver.ts:150, compound-search.ts:123',
        producer: 'snapshot-builder.js gzip loop over SNAPSHOT_FILES -> <prefix>compounds-enriched.jsonl.gz',
    },
    {
        snapshot_file: 'neg-evidence.jsonl',
        key_suffix: 'neg-evidence.jsonl.gz',
        surface: 'negative-evidence whole-file legacy fallback (sharded path is STRUCTURED, below)',
        reader: 'src/worker/lib/neg-evidence-loader.ts:149 (loadNegEvidenceLegacy)',
        producer: 'snapshot-builder.js STREAMING_FILES -> <prefix>neg-evidence.jsonl.gz',
    },
]);

/**
 * STRUCTURED serving surfaces — NOT a single satellite gz; a manifest+shard
 * family or a dedicated gzipped projection, published by a dedicated producer
 * path. Declared so validateCandidate + the parity test treat them as required.
 * `key_pattern` is informational (the actual keys are derived per-bucket / from
 * the manifest at validate time, hence the `derive` reference).
 */
export const STRUCTURED_INVENTORY = Object.freeze([
    {
        id: 'compounds',
        key_pattern: '<prefix>compounds/bucket-NNNN/manifest.json + shard-MMM.bin',
        surface: 'compound resolve/load (sharded NXVF)',
        reader: 'src/worker/lib/compound-loader.ts + compound-bucket-router.ts (manifestKeyForCtx/shardKeyForCtx)',
        producer: 'compound-shard-publisher.js publishCompoundShards',
        derive: (prefix, bucket = 0) => compoundsManifestKey(prefix, bucket),
    },
    {
        id: 'neg-evidence',
        key_pattern: '<prefix>neg-evidence/bucket-NNNN/manifest.json + shard-MMM.bin',
        surface: 'negative-evidence sharded paged read',
        reader: 'src/worker/lib/neg-evidence-loader.ts (negManifestKeyForCtx)',
        producer: 'neg-shard-publisher.js publishNegShards',
        derive: (prefix, bucket = 0) => negManifestKey(prefix, bucket),
    },
    {
        id: 'xref-index',
        key_pattern: '<prefix>xref-index.json.gz',
        surface: 'xref/routing (id->cid for 7 namespaces)',
        reader: 'src/worker/lib/xref-index-loader.ts:137 (xrefIndexKeyForCtx)',
        producer: 'rk15-v3-candidate-publish.js putCreateOnly(xrefIndexKey) / F4 snapshot-builder gzip',
        derive: (prefix) => xrefIndexKey(prefix),
    },
    {
        id: 'compounds-search',
        key_pattern: '<prefix>compounds-search.jsonl.gz',
        surface: 'compound free-text search projection',
        reader: 'src/worker/lib/compound-search.ts:120,122 (fetchSearchCorpus, SEARCH_PROJECTION)',
        producer: 'rk15-v3-candidate-publish.js putCreateOnly(searchProjectionKey) / F4 snapshot-builder stream',
        derive: (prefix) => searchProjectionKey(prefix),
    },
]);

/**
 * The exact satellite serving keys a COMPLETE candidate must carry under
 * `objectPrefix`. Used by the candidate builder (publish), the seal (declare),
 * and validateCandidate (HEAD + decode-probe).
 */
export function requiredSatelliteKeys(objectPrefix) {
    return SATELLITE_INVENTORY.map(e => `${objectPrefix}${e.key_suffix}`);
}

/** The satellite entry whose published key ends with `keySuffix` (or null). */
export function satelliteFor(keySuffix) {
    return SATELLITE_INVENTORY.find(e => e.key_suffix === keySuffix) ?? null;
}

/**
 * Reconciliation view: the SNAPSHOT_FILES entries that the SATELLITE set covers
 * (every satellite's `snapshot_file` MUST be a real SNAPSHOT_FILES member) and
 * the SNAPSHOT_FILES entries NOT covered as satellites (the STRUCTURED-only
 * producer outputs no reader reads as a standalone gz). The parity test asserts
 * the cover set is a subset of SNAPSHOT_FILES and that every reader-read whole-gz
 * surface is present, so a future new reader surface cannot silently drift.
 */
export function reconcileWithSnapshotFiles() {
    const snapshotSet = new Set(SNAPSHOT_FILES);
    const coveredSnapshotFiles = SATELLITE_INVENTORY.map(e => e.snapshot_file);
    const notInSnapshotFiles = coveredSnapshotFiles.filter(f => !snapshotSet.has(f));
    const satelliteSet = new Set(coveredSnapshotFiles);
    const snapshotOnly = SNAPSHOT_FILES.filter(f => !satelliteSet.has(f));
    return { coveredSnapshotFiles, notInSnapshotFiles, snapshotOnly };
}

/** Stable, sorted list of every required serving surface id (satellites by key
 * suffix + structured ids) — for the parity contract test + diagnostics. */
export function allRequiredSurfaceIds() {
    return [
        ...SATELLITE_INVENTORY.map(e => e.key_suffix),
        ...STRUCTURED_INVENTORY.map(e => e.id),
    ].sort();
}
