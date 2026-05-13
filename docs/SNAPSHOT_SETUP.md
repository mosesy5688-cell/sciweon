# Daily Snapshot — R2 Setup Guide

V0.4.3 launches Sciweon's Layer 4 time-series clock. Daily snapshots of the
entity graph are pushed to Cloudflare R2 to enable retroactive analysis
(citation trajectories, retraction lags, FDA approval shifts, cross-source
disagreement evolution).

## Why Layer 4 matters

Per `brain/SCIWEON_DATA_SOURCES_GLOBAL.md` four-layer moat analysis, time
is the only physically non-copyable resource. A competitor starting later
cannot retroactively obtain prior daily snapshots. Every missed day widens
the catch-up window for Sciweon's lead.

## Step 1: Cloudflare R2 bucket

1. Sign in to https://dash.cloudflare.com
2. R2 -> Create bucket -> name `sciweon-snapshots` (or your choice)
3. Region: auto (Cloudflare picks based on traffic)

## Step 2: R2 API token

1. R2 -> Manage R2 API Tokens -> Create API token
2. Permission: Object Read & Write on `sciweon-snapshots`
3. Save the Access Key ID and Secret Access Key (one-time display)
4. Note the S3-compatible endpoint:
   `https://<your-account-id>.r2.cloudflarestorage.com`

## Step 3: GitHub repo secrets

In the Sciweon repo Settings -> Secrets and variables -> Actions, add four
repository secrets:

| Name                   | Value                                             |
|------------------------|---------------------------------------------------|
| `R2_ENDPOINT`          | `https://<account-id>.r2.cloudflarestorage.com`   |
| `R2_BUCKET`            | `sciweon-snapshots`                               |
| `R2_ACCESS_KEY_ID`     | (from Step 2)                                     |
| `R2_SECRET_ACCESS_KEY` | (from Step 2)                                     |

## Step 4: Activate daily cron

The workflow `.github/workflows/daily-snapshot.yml` runs at 00:00 UTC
daily. Once the four secrets above are set, the upload step starts
working automatically — no code change required.

Manual trigger any time via GitHub Actions UI -> Daily Snapshot ->
"Run workflow".

## Snapshot layout in R2

```
sciweon-snapshots/
  snapshots/latest.json          (pointer to most recent date)
  snapshots/YYYY-MM-DD/
    manifest.json                (record counts + SHA-256 checksums)
    compounds-enriched.jsonl.gz
    bioactivities.jsonl.gz
    trials.jsonl.gz
    papers.jsonl.gz
    neg-evidence.jsonl.gz
    (and other supporting files)
```

## Local snapshot

To verify pipeline correctness without R2 configured:

```sh
npm run snapshot
# or with a custom date for backfill experiments:
node scripts/factory/snapshot-builder.js --date=2026-05-13
```

Snapshots land under `./snapshots/YYYY-MM-DD/` (gitignored — too large for
git history; R2 is the persistence layer).

## Cost estimate

Cloudflare R2 pricing (current free tier):
- 10 GB storage free
- Class A operations (writes): 1M/month free
- Class B operations (reads): 10M/month free
- Egress: $0 (Cloudflare's value prop vs S3)

Sciweon snapshot size today: ~5 MB uncompressed -> ~1-2 MB compressed.
At 1.5 MB/day, 1 year = 547 MB -> well inside free tier.
By V1.0 with 111M compound expansion, expect 100-200 MB/day -> ~50 GB/year
-> still under $1/month at standard R2 pricing.
