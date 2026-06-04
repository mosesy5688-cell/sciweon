// @ts-nocheck
/**
 * PR-HEALTH per-source cadence policy tests.
 *
 * The Source Health Monitor applies ONE staleness window to every source. That
 * caused a FALSE POSITIVE (run 26932559226): corpus_add_seed -- a MANUAL seed-add
 * source with no daily freshness expectation -- crossed ~48h and tripped the
 * `hasStale -> exit 1` fail-trigger. The fix scopes the fail decision to only
 * 'daily'-cadence sources (lib/source-health-policy.js). These tests lock:
 *   - the SOURCE_HEALTH_POLICY map + cadenceFor/contributesToFail helpers, and
 *   - the end-to-end exit code of the REAL monitor (spawned in a temp cwd) so a
 *     'daily' source going stale STILL fails while exempt sources do not.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    cadenceFor, contributesToFail, SOURCE_HEALTH_POLICY,
    NON_FAILING_CADENCES, DEFAULT_CADENCE,
} from '../../scripts/factory/lib/source-health-policy.js';

const MONITOR = resolve('scripts/factory/source-health-monitor.js');
const HOUR_MS = 3600 * 1000;

// Provenance entity stamping `source` with last_seen `ageHours` before now
// (per-source timestamp -> deterministic HEALTHY/STALE/CRITICAL band).
function entityWithSource(source: string, ageHours: number) {
    const ts = new Date(Date.now() - ageHours * HOUR_MS).toISOString();
    return { provenance: { sources: [{ source, timestamp: ts }] } };
}

// Run the REAL monitor in a temp cwd seeded with the given entities. Boundary
// checks are skipped (R2 env stripped) so the exit code is driven purely by
// source cadence + staleness.
function runMonitor(entities: object[]) {
    const workDir = mkdtempSync(join(tmpdir(), 'src-health-'));
    try {
        mkdirSync(join(workDir, 'output', 'linked'), { recursive: true });
        const jsonl = entities.map(e => JSON.stringify(e)).join('\n') + '\n';
        writeFileSync(join(workDir, 'output', 'linked', 'data.jsonl'), jsonl, 'utf-8');
        const env = { ...process.env };
        delete env.R2_ENDPOINT;
        delete env.R2_BUCKET;
        const res = spawnSync(process.execPath, [MONITOR], { cwd: workDir, encoding: 'utf-8', env });
        return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }
}

describe('PR-HEALTH cadence policy: SOURCE_HEALTH_POLICY map + helpers', () => {
    it('the daily F1-cron producers are classified daily (must fail on staleness)', () => {
        for (const s of [
            'chembl', 'chembl_bioactivity', 'clinicaltrials', 'ctis', 'dailymed',
            'fda_srs', 'open_targets', 'openalex', 'pubchem', 'rxnorm', 's2', 'unichem',
        ]) {
            expect(cadenceFor(s)).toBe('daily');
            expect(contributesToFail(s)).toBe(true);
        }
    });

    it('corpus_add_seed is manual -> excluded from the fail decision', () => {
        expect(cadenceFor('corpus_add_seed')).toBe('manual');
        expect(contributesToFail('corpus_add_seed')).toBe(false);
    });

    it('kegg is not_ingested (by-design layered substitute) -> never fails', () => {
        expect(cadenceFor('kegg')).toBe('not_ingested');
        expect(contributesToFail('kegg')).toBe(false);
    });

    it('not-yet-built producers are planned -> never fail', () => {
        for (const s of ['pubchem_bioassay', 'openfda', 'retraction_watch', 'uniprot']) {
            expect(cadenceFor(s)).toBe('planned');
            expect(contributesToFail(s)).toBe(false);
        }
    });

    it('an UNKNOWN source defaults to daily (fail-loud safe default)', () => {
        expect(DEFAULT_CADENCE).toBe('daily');
        expect(cadenceFor('some_brand_new_source')).toBe('daily');
        expect(contributesToFail('some_brand_new_source')).toBe(true);
    });

    it('every non-daily class is in NON_FAILING_CADENCES; daily is not', () => {
        for (const [src, cls] of Object.entries(SOURCE_HEALTH_POLICY)) {
            if (cls === 'daily') {
                expect(NON_FAILING_CADENCES).not.toContain(cls);
                expect(contributesToFail(src)).toBe(true);
            } else {
                expect(NON_FAILING_CADENCES).toContain(cls);
                expect(contributesToFail(src)).toBe(false);
            }
        }
    });
});

describe('PR-HEALTH cadence-aware fail-trigger (end-to-end, spawned monitor)', () => {
    it('corpus_add_seed STALE @50.5h is the ONLY non-healthy source -> exit 0 (the fixed false positive)', () => {
        const r = runMonitor([
            entityWithSource('pubchem', 1),            // daily, fresh
            entityWithSource('chembl', 2),             // daily, fresh
            entityWithSource('corpus_add_seed', 50.5), // manual, STALE by raw age
        ]);
        expect(r.stdout).toContain('STALE');                  // reported STALE
        expect(r.stdout).toContain('manual');                 // cadence shown
        expect(r.stdout).toContain('[NOTE] corpus_add_seed'); // loud exemption note
        expect(r.status).toBe(0);                             // ...but does NOT fail
    });

    it('a daily source (chembl) STALE @50h -> exit 1 (meaningful signal preserved)', () => {
        const r = runMonitor([
            entityWithSource('pubchem', 1),
            entityWithSource('chembl', 50), // daily, STALE
        ]);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('[WARN] One or more sources are STALE.');
    });

    it('a daily source (chembl) CRITICAL @120h -> exit 2 (meaningful signal preserved)', () => {
        const r = runMonitor([
            entityWithSource('pubchem', 1),
            entityWithSource('chembl', 120), // daily, CRITICAL >96h
        ]);
        expect(r.status).toBe(2);
        expect(r.stdout).toContain('[FAIL] One or more sources are CRITICAL.');
    });

    it('kegg MISSING (0 records, not_ingested) -> never fails', () => {
        // kegg unseeded -> KNOWN_SOURCES backfill gives records=0 -> MISSING.
        const r = runMonitor([entityWithSource('pubchem', 1)]);
        expect(r.stdout).toMatch(/kegg\b.*MISSING.*not_ingested/);
        expect(r.status).toBe(0);
    });

    it('an UNKNOWN source going CRITICAL still alarms (default daily) -> exit 2', () => {
        const r = runMonitor([
            entityWithSource('pubchem', 1),
            entityWithSource('some_brand_new_source', 200), // unknown -> daily -> CRITICAL
        ]);
        expect(r.stdout).toContain('some_brand_new_source');
        expect(r.status).toBe(2);
    });

    it('report shows a CADENCE column + each source cadence class', () => {
        const r = runMonitor([
            entityWithSource('pubchem', 1),
            entityWithSource('corpus_add_seed', 50.5),
        ]);
        expect(r.stdout).toContain('CADENCE');                 // header column
        expect(r.stdout).toMatch(/pubchem\b.*daily/);          // daily shown
        expect(r.stdout).toMatch(/corpus_add_seed\b.*manual/); // manual shown
        expect(r.stdout).toMatch(/kegg\b.*not_ingested/);      // exempt shown
    });

    it('determinism: same input -> identical exit code + identical report body', () => {
        const input = [
            entityWithSource('pubchem', 1),
            entityWithSource('chembl', 2),
            entityWithSource('corpus_add_seed', 50.5),
        ];
        const a = runMonitor(input);
        const b = runMonitor(input);
        expect(a.status).toBe(b.status);
        // Strip the only nondeterministic content (absolute LAST SEEN timestamps,
        // generated_at, fractional ages). The STATUS/CADENCE columns + exit are stable.
        const strip = (s: string) => s
            .split('\n')
            .filter(l => !l.startsWith('[health]') && !l.includes('LAST SEEN'))
            .map(l => l.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<TS>').replace(/\s+\d+\.\d+\s/g, ' <AGE> '))
            .join('\n');
        expect(strip(a.stdout)).toBe(strip(b.stdout));
    });
});
