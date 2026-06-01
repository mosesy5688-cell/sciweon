/**
 * UMLS Metathesaurus release probe (PR-UMLS-1; thin, RxNorm rxnorm-probe.js analog).
 *
 * Discovers the latest real full-release inner URL via the shared discovery lib (BYTE-probe
 * + ZIP-magic guard, NOT first-HTTP-200), parses the release tag (e.g. 2026AA) OUT OF the
 * resolved URL (NOT hardcoded), and emits a single probe-json line to stdout for the
 * harvest job:  { release, inner_url }.
 *
 * Pure discovery: NO download of the multi-GB body, NO extraction, NO mutation, NO R2.
 * Exit codes: 0 OK / 1 args (UMLS_API_KEY absent) / 2 no real release found / 3 unparsable tag.
 */

import { umlsApiKey } from './lib/umls-auth.js';
import { discoverRelease, parseReleaseTag } from './lib/umls-release-discovery.js';

function parseArgs() {
    let fullUrl = null;
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--full-url=')) fullUrl = a.slice('--full-url='.length);
    }
    umlsApiKey();  // fail-closed before any network call when UMLS_API_KEY absent
    return { fullUrl, now: new Date() };
}

async function main() {
    const args = parseArgs();
    const inner = await discoverRelease(args);
    if (!inner) {
        console.error('[UMLS-PROBE] no Metathesaurus full-release ZIP found (pass --full-url=<inner> from the NLM release page).');
        process.exit(2);
    }
    const release = parseReleaseTag(inner);
    if (!release) {
        console.error(`[UMLS-PROBE] could not parse release tag from inner URL: ${inner}`);
        process.exit(3);
    }
    console.error(`[UMLS-PROBE] resolved release=${release} inner_url=${inner}`);
    console.log(JSON.stringify({ release, inner_url: inner }));
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch((err) => { console.error('[UMLS-PROBE] FATAL:', err.message); process.exit(1); });
