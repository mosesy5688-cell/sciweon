/**
 * V0.5.8 Wave I-3 — R2 lifecycle TTL configuration.
 *
 * Single source of truth for the bucket-wide expiry rules. Generates the
 * S3-compatible LifecycleConfiguration object that R2 accepts via
 * PutBucketLifecycleConfigurationCommand. Driven by the $10/month R2 cost
 * cap and the 6-Wave plan I-3 row.
 *
 * Rules (non-overlapping prefixes, so order does not matter):
 *   raw/                       14 days
 *   processed/baseline/        30 days
 *   processed/enriched/        30 days
 *   processed/aggregated/      30 days
 *   staging/incremental/        7 days
 *
 * Explicitly excluded (no rule = no expiry):
 *   processed/cache/   — chembl negative cache + future helpers
 *   snapshots/          — API-facing historical snapshots
 *
 * processed/aggregated/latest.json is safe under the 30-day rule because
 * stage-3-aggregate.js rewrites it every cron, resetting the lifecycle
 * clock on each PutObject.
 */

export const LIFECYCLE_RULES = [
    { id: 'expire-raw-14d',                prefix: 'raw/',                  days: 14 },
    { id: 'expire-baseline-30d',           prefix: 'processed/baseline/',   days: 30 },
    { id: 'expire-enriched-30d',           prefix: 'processed/enriched/',   days: 30 },
    { id: 'expire-aggregated-30d',         prefix: 'processed/aggregated/', days: 30 },
    { id: 'expire-staging-incremental-7d', prefix: 'staging/incremental/',  days: 7 },
];

export const PRESERVED_PREFIXES = [
    'processed/cache/',
    'snapshots/',
];

export function buildLifecycleConfig() {
    return {
        Rules: LIFECYCLE_RULES.map(r => ({
            ID: r.id,
            Status: 'Enabled',
            Filter: { Prefix: r.prefix },
            Expiration: { Days: r.days },
        })),
    };
}
