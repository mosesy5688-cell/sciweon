/**
 * Open Targets bulk probe (cycle 23 PR-OT-1).
 *
 * Probe-only: walks the EBI FTP HTTP mirror to (a) discover the latest
 * Open Targets Platform release and (b) enumerate the available output
 * dataset directories. NO R2 writes, NO Parquet downloads here - that
 * job is left to the workflow's duckdb step, which curls one part file
 * directly and runs DESCRIBE.
 *
 * Endpoint choice: the 2026-05-18 SCIWEON_DATA_SOURCES_GLOBAL.md
 * amendment recorded "GCS anonymous read" via
 * gs://open-targets-data-releases/. PR-OT-1 probe (2026-05-24) showed
 * that bucket is requester-pays - anonymous reads return HTTP 400.
 * The EBI FTP HTTP mirror at ftp.ebi.ac.uk is the working alternative,
 * auth-free and listing-enabled (Apache directory index HTML).
 *
 * Usage:
 *   node scripts/factory/open-targets-probe.js
 *
 * Exit codes:
 *   0  probe succeeded - prints JSON {release, datasets[]}
 *   1  upstream unreachable / unexpected HTML shape
 */

const ROOT = 'https://ftp.ebi.ac.uk/pub/databases/opentargets/platform/';

/**
 * Extract release-version directory names from an Apache index HTML page.
 * Matches the pattern href="MM.NN/" where MM.NN looks like "26.03". Skips
 * sort-link anchors (href="?C=...") and parent-dir links.
 */
export function parseReleases(html) {
    const matches = html.match(/href="(\d+\.\d+)\/"/g) || [];
    const versions = matches.map(m => m.replace(/href="|\/"/g, ''));
    // Dedup + sort by (major, minor) ascending.
    return [...new Set(versions)].sort((a, b) => {
        const [am, an] = a.split('.').map(Number);
        const [bm, bn] = b.split('.').map(Number);
        return am === bm ? an - bn : am - bm;
    });
}

/**
 * Extract dataset directory names from a release's output/ index HTML.
 * Matches href="name/" entries; excludes sort-link anchors, file entries
 * (those without trailing slash), and any non-alphanumeric-underscore
 * dataset name. OT dataset dirs are conventionally snake_case.
 */
export function parseDatasets(html) {
    const matches = html.match(/href="([a-z][a-z0-9_]*)\/"/gi) || [];
    return [...new Set(matches.map(m => m.replace(/href="|\/"/g, '')))].sort();
}

async function fetchText(url) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
}

async function main() {
    const rootHtml = await fetchText(ROOT);
    const releases = parseReleases(rootHtml);
    if (releases.length === 0) {
        throw new Error('no releases found in EBI mirror index');
    }
    const latest = releases[releases.length - 1];

    const outputHtml = await fetchText(`${ROOT}${latest}/output/`);
    const datasets = parseDatasets(outputHtml);
    if (datasets.length === 0) {
        throw new Error(`no datasets found in release ${latest} output/`);
    }

    const report = {
        endpoint: ROOT,
        releases_seen: releases.length,
        latest_release: latest,
        datasets_count: datasets.length,
        datasets,
    };
    console.log(JSON.stringify(report, null, 2));
}

const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
    || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
    main().catch(err => {
        console.error('[OT-PROBE] failed:', err.message);
        process.exit(1);
    });
}
