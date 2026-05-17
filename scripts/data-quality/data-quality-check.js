/**
 * Sciweon Data Quality Audit — 6-principle quantification against latest R2 snapshot.
 *
 * Per Sciweon first principles:
 *   1. Machine-readable types + units + ranges
 *   2. Validation, not "existence"
 *   3. Explicit gaps (unknown / not_collected / excluded)
 *   4. Provenance per data point (DOI + timestamp + extraction method)
 *   5. Quantified confidence (single source <=60, multi-source >80)
 *   6. Negative evidence collected equally with positive
 *
 * Reads snapshots/latest.json pointer from R2, downloads that date's
 * jsonl.gz files, decompresses, and computes pass/fail per principle.
 * Output: human-readable report to stdout + machine-readable JSON if
 * --json=<path> is given.
 *
 * Run locally: R2_ENDPOINT=... R2_BUCKET=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
 *              node scripts/audit/data-quality-audit.js
 * Run in CI:  see .github/workflows/data-quality-audit.yml
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'zlib';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
for (const k of REQUIRED_ENV) if (!process.env[k]) { console.error(`Missing env: ${k}`); process.exit(2); }

const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.find(a => a.startsWith('--json='))?.split('=')[1];

const client = new S3Client({
    endpoint: process.env.R2_ENDPOINT,
    region: 'auto',
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

async function r2Get(key) {
    const res = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    return streamToBuffer(res.Body);
}

const SNAPSHOT_FILES = [
    'compounds-enriched.jsonl', 'bioactivities.jsonl', 'trials.jsonl', 'trial-links.jsonl',
    'papers.jsonl', 'paper-links.jsonl', 'negative-evidence-raw.jsonl', 'neg-evidence.jsonl',
];

async function loadSnapshot() {
    const pointer = JSON.parse((await r2Get('snapshots/latest.json')).toString());
    const date = pointer.latest_snapshot_date;
    console.log(`[AUDIT] Target snapshot: ${date}`);
    const data = {};
    for (const fname of SNAPSHOT_FILES) {
        try {
            const buf = await r2Get(`snapshots/${date}/${fname}.gz`);
            const text = gunzipSync(buf).toString('utf-8');
            data[fname.replace('.jsonl', '')] = text.split('\n').filter(Boolean).map(JSON.parse);
        } catch (e) {
            console.warn(`[AUDIT] Skipping ${fname}.gz: ${e.name || e.message}`);
            data[fname.replace('.jsonl', '')] = [];
        }
    }
    return { date, data };
}

function pct(n, d) { return d === 0 ? null : +(100 * n / d).toFixed(1); }

function audit(data) {
    const c = data['compounds-enriched'] || [];
    const b = data.bioactivities || [];
    const t = data.trials || [];
    const p = data.papers || [];
    const n = data['neg-evidence'] || [];
    const pl = data['paper-links'] || [];
    const tl = data['trial-links'] || [];
    const nr = data['negative-evidence-raw'] || [];

    const results = { counts: {}, principles: {} };
    for (const [k, v] of Object.entries(data)) results.counts[k] = v.length;

    // Principle 1: machine-readable types + units + ranges
    results.principles.p1 = {
        compounds_mw_structured: pct(c.filter(x => x.molecular_weight?.value != null && x.molecular_weight?.unit).length, c.length),
        compounds_tpsa_structured: pct(c.filter(x => x.properties?.tpsa?.value != null && x.properties?.tpsa?.unit).length, c.length),
        bioactivities_value_numeric: pct(b.filter(x => typeof x.value === 'number' && x.unit !== undefined).length, b.length),
    };

    // Principle 2: validation, not existence
    results.principles.p2 = {
        bioactivities_is_active_explicit: pct(b.filter(x => typeof x.is_active === 'boolean' || (x.is_active === null && x.is_active_method)).length, b.length),
        compounds_smiles_valid: pct(c.filter(x => x.smiles_canonical && x.smiles_canonical.length > 5).length, c.length),
        compounds_inchi_valid: pct(c.filter(x => x.inchi_key && x.inchi_key.includes('-')).length, c.length),
    };

    // Principle 3: explicit gaps
    results.principles.p3 = {
        compounds_drug_status_explicit: pct(c.filter(x => x.drug_status === null || x.drug_status).length, c.length),
        trials_status_reason_explicit: pct(t.filter(x => x.status_reason === null || x.status_reason).length, t.length),
    };

    // Principle 4: provenance per data point (nested object form)
    const hasFullProv = x => {
        if (!x.provenance) return false;
        if (x.provenance.primary_source) return !!x.provenance.extraction_timestamp && !!x.provenance.extraction_method;
        const s = x.provenance.sources?.[0];
        return s?.source && s?.timestamp && s?.extraction_method;
    };
    results.principles.p4 = {
        compounds: pct(c.filter(hasFullProv).length, c.length),
        bioactivities: pct(b.filter(hasFullProv).length, b.length),
        trials: pct(t.filter(hasFullProv).length, t.length),
        papers: pct(p.filter(hasFullProv).length, p.length),
        neg_evidence: pct(n.filter(hasFullProv).length, n.length),
        paper_links: pct(pl.filter(hasFullProv).length, pl.length),
        trial_links: pct(tl.filter(hasFullProv).length, tl.length),
        negative_evidence_raw: pct(nr.filter(hasFullProv).length, nr.length),
    };

    // Principle 5: quantified confidence + rules
    const hasConf = x => (typeof x.confidence?.overall === 'number') || (typeof x.sciweon_confidence === 'number') || (x.failure?.extraction_confidence != null);
    results.principles.p5 = {
        coverage: {
            compounds: pct(c.filter(hasConf).length, c.length),
            bioactivities: pct(b.filter(hasConf).length, b.length),
            trials: pct(t.filter(hasConf).length, t.length),
            papers: pct(p.filter(hasConf).length, p.length),
            neg_evidence: pct(n.filter(hasConf).length, n.length),
        },
        rule_check: {
            papers_multi_source_high_conf: (() => {
                const m = p.filter(x => x.provenance?.sources?.length > 1);
                return { pass: m.filter(x => (x.confidence?.overall || 0) > 80).length, total: m.length, pct: pct(m.filter(x => (x.confidence?.overall || 0) > 80).length, m.length) };
            })(),
            papers_single_source_low_conf: (() => {
                const s = p.filter(x => x.provenance?.sources?.length === 1);
                return { pass: s.filter(x => (x.confidence?.overall || 99) <= 60).length, total: s.length, pct: pct(s.filter(x => (x.confidence?.overall || 99) <= 60).length, s.length) };
            })(),
        },
    };

    // Principle 6: negative evidence
    const negCats = {};
    for (const r of n) negCats[r.evidence_type] = (negCats[r.evidence_type] || 0) + 1;
    results.principles.p6 = {
        neg_evidence_categories: negCats,
        papers_retracted_explicit: pct(p.filter(x => x.is_retracted === true || x.is_retracted === false).length, p.length),
        papers_retracted_count: p.filter(x => x.is_retracted === true).length,
        trials_negative_outcome: pct(t.filter(x => x.is_negative_outcome === true).length, t.length),
    };

    return results;
}

function printReport(date, r) {
    const line = (label, val, threshold = 95) => {
        const v = val == null ? 'N/A' : `${val}%`;
        const status = val == null ? '   ' : (val >= threshold ? ' ✅' : ' ⚠️');
        console.log(`  ${label.padEnd(50)} ${v.padStart(7)}${status}`);
    };
    console.log(`\n========== Sciweon Data Quality Audit — ${date} ==========`);
    console.log('Record counts:');
    for (const [k, v] of Object.entries(r.counts)) console.log(`  ${k.padEnd(28)} ${v.toLocaleString().padStart(9)}`);
    console.log('\n[Principle 1] Machine-readable types + units + ranges');
    for (const [k, v] of Object.entries(r.principles.p1)) line(k, v);
    console.log('\n[Principle 2] Validation, not "existence"');
    for (const [k, v] of Object.entries(r.principles.p2)) line(k, v);
    console.log('\n[Principle 3] Explicit gaps');
    for (const [k, v] of Object.entries(r.principles.p3)) line(k, v);
    console.log('\n[Principle 4] Provenance per data point (nested object form)');
    for (const [k, v] of Object.entries(r.principles.p4)) line(k, v);
    console.log('\n[Principle 5] Quantified confidence');
    console.log('  Coverage:');
    for (const [k, v] of Object.entries(r.principles.p5.coverage)) line(`  ${k}`, v);
    console.log('  Rule check (single-source ≤60, multi-source >80):');
    const m = r.principles.p5.rule_check.papers_multi_source_high_conf;
    const s = r.principles.p5.rule_check.papers_single_source_low_conf;
    line(`  papers multi-source AND >80 (${m.pass}/${m.total})`, m.pct, 90);
    line(`  papers single-source AND ≤60 (${s.pass}/${s.total})`, s.pct, 90);
    console.log('\n[Principle 6] Negative evidence');
    console.log('  Categories:');
    for (const [k, v] of Object.entries(r.principles.p6.neg_evidence_categories)) console.log(`    ${k.padEnd(34)} ${v.toString().padStart(7)}`);
    line('papers.is_retracted explicit (true OR false)', r.principles.p6.papers_retracted_explicit);
    console.log(`  papers retracted count: ${r.principles.p6.papers_retracted_count}`);
    line('trials.is_negative_outcome = true', r.principles.p6.trials_negative_outcome, 0);
    console.log('\n========== Audit Complete ==========\n');
}

async function main() {
    const { date, data } = await loadSnapshot();
    const r = audit(data);
    printReport(date, r);
    if (JSON_OUT) {
        const fs = await import('fs/promises');
        await fs.writeFile(JSON_OUT, JSON.stringify({ snapshot_date: date, ...r }, null, 2));
        console.log(`[AUDIT] JSON report written to ${JSON_OUT}`);
    }
}

main().catch(err => { console.error('[AUDIT] Fatal:', err); process.exit(1); });
