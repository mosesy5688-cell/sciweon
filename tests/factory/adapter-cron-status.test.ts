/**
 * Tests for V0.5.8 Wave I-6 — GHA matrix jobs -> canary-shaped report.
 *
 * Pure transform: given the parsed output of `gh run view --json jobs`,
 * pick out Adapter [<source>] matrix jobs, normalize to canary report shape.
 * Lets the same canary-issue-manage.js script handle both I-5 canary
 * (upstream API probe) and I-6 factory-cron (real ingest run) signals.
 */

import { describe, it, expect } from 'vitest';
import { transformGhaJobsToReport } from '../../scripts/factory/lib/adapter-cron-status.js';

describe('transformGhaJobsToReport', () => {
    it('empty jobs array -> empty adapters list', () => {
        const r = transformGhaJobsToReport([], 'run-1');
        expect(r.adapter_count).toBe(0);
        expect(r.passed).toBe(0);
        expect(r.failed).toBe(0);
        expect(r.adapters).toEqual([]);
        expect(r.run_id).toBe('run-1');
    });

    it('all adapter jobs succeed -> all passed', () => {
        const jobs = [
            { name: 'Adapter [chembl]', conclusion: 'success', startedAt: '2026-05-19T10:00:00Z', completedAt: '2026-05-19T10:00:42Z' },
            { name: 'Adapter [pubmed]', conclusion: 'success', startedAt: '2026-05-19T10:00:00Z', completedAt: '2026-05-19T10:00:30Z' },
        ];
        const r = transformGhaJobsToReport(jobs, 'r1');
        expect(r.passed).toBe(2);
        expect(r.failed).toBe(0);
        expect(r.adapters.every(a => a.passed)).toBe(true);
    });

    it('mixed pass/fail -> counts correct + error on failures', () => {
        const jobs = [
            { name: 'Adapter [chembl]', conclusion: 'success', startedAt: '2026-05-19T10:00:00Z', completedAt: '2026-05-19T10:00:10Z' },
            { name: 'Adapter [pubmed]', conclusion: 'failure', startedAt: '2026-05-19T10:00:00Z', completedAt: '2026-05-19T10:00:05Z' },
            { name: 'Adapter [ctis]', conclusion: 'success', startedAt: '2026-05-19T10:00:00Z', completedAt: '2026-05-19T10:00:20Z' },
            { name: 'Adapter [openalex]', conclusion: 'failure', startedAt: '2026-05-19T10:00:00Z', completedAt: '2026-05-19T10:00:08Z' },
            { name: 'Adapter [retraction-watch]', conclusion: 'cancelled', startedAt: '2026-05-19T10:00:00Z', completedAt: '2026-05-19T10:00:02Z' },
        ];
        const r = transformGhaJobsToReport(jobs, 'r2');
        expect(r.passed).toBe(2);
        expect(r.failed).toBe(3);
        const pubmed = r.adapters.find(a => a.source === 'pubmed');
        expect(pubmed?.passed).toBe(false);
        expect(pubmed?.error).toContain('failure');
        const ret = r.adapters.find(a => a.source === 'retraction-watch');
        expect(ret?.error).toContain('cancelled');
    });

    it('non-adapter jobs ignored (pubchem, merge-adapters, health-summary)', () => {
        const jobs = [
            { name: 'PubChem Harvest', conclusion: 'success' },
            { name: 'Merge Adapters (fan-in)', conclusion: 'success' },
            { name: 'Adapter Cron Health Summary', conclusion: 'success' },
            { name: 'Adapter [chembl]', conclusion: 'success', startedAt: '2026-05-19T10:00:00Z', completedAt: '2026-05-19T10:00:10Z' },
        ];
        const r = transformGhaJobsToReport(jobs, 'r3');
        expect(r.adapter_count).toBe(1);
        expect(r.adapters[0].source).toBe('chembl');
    });

    it('job conclusion null (in_progress) -> failed + error contains unknown', () => {
        const jobs = [{ name: 'Adapter [chembl]', conclusion: null, startedAt: '2026-05-19T10:00:00Z' }];
        const r = transformGhaJobsToReport(jobs, 'r4');
        expect(r.passed).toBe(0);
        expect(r.failed).toBe(1);
        expect(r.adapters[0].error).toContain('unknown');
    });

    it('duration_ms computed from startedAt/completedAt', () => {
        const jobs = [
            { name: 'Adapter [chembl]', conclusion: 'success', startedAt: '2026-05-19T10:00:00Z', completedAt: '2026-05-19T10:01:30Z' },
        ];
        const r = transformGhaJobsToReport(jobs, 'r5');
        expect(r.adapters[0].duration_ms).toBe(90000); // 1m30s
    });

    it('missing timestamps -> duration_ms = 0 (defensive)', () => {
        const jobs = [
            { name: 'Adapter [chembl]', conclusion: 'success' },
            { name: 'Adapter [pubmed]', conclusion: 'failure', startedAt: '2026-05-19T10:00:00Z' /* no completedAt */ },
        ];
        const r = transformGhaJobsToReport(jobs, 'r6');
        expect(r.adapters[0].duration_ms).toBe(0);
        expect(r.adapters[1].duration_ms).toBe(0);
    });

    it('null/undefined jobs input -> empty result, no crash', () => {
        expect(transformGhaJobsToReport(null, 'r7').adapter_count).toBe(0);
        expect(transformGhaJobsToReport(undefined, 'r7').adapter_count).toBe(0);
    });

    // Cycle 21 — stalled-cursor cross-check. GHA-success alone is not
    // enough: cursor poisoning (pre-fix) let DailyMed/WHO-ATC "succeed"
    // every cron with zero fetches. This layer surfaces the regression
    // class via Issues if it ever recurs.
    describe('stalled-cursor detection', () => {
        const NOW = '2026-05-22T12:00:00Z';
        const okJob = (src: string) => ({
            name: `Adapter [${src}]`, conclusion: 'success',
            startedAt: '2026-05-22T10:00:00Z', completedAt: '2026-05-22T10:00:10Z',
        });

        it('adapter with fresh last_success_at -> passes', () => {
            const cursors = new Map([['dailymed', {
                last_success_at: '2026-05-20T00:00:00Z', // 2 days ago
                status: 'success',
            }]]);
            const r = transformGhaJobsToReport([okJob('dailymed')], 'r-s1', NOW, {
                cursors, stalledThresholdDays: 14,
            });
            expect(r.adapters[0].passed).toBe(true);
            expect(r.adapters[0].stalled).toBeUndefined();
        });

        it('adapter with stale last_success_at -> marked stalled + failed', () => {
            const cursors = new Map([['dailymed', {
                last_success_at: '2026-04-01T00:00:00Z', // ~51 days ago
                status: 'no_updates',
            }]]);
            const r = transformGhaJobsToReport([okJob('dailymed')], 'r-s2', NOW, {
                cursors, stalledThresholdDays: 14,
            });
            expect(r.adapters[0].passed).toBe(false);
            expect(r.adapters[0].stalled).toBe(true);
            expect(r.adapters[0].error).toContain('stalled');
            expect(r.adapters[0].error).toContain('51');
            expect(r.passed).toBe(0);
            expect(r.failed).toBe(1);
        });

        it('adapter that never succeeded -> stalled (cursor exists, no last_success_at)', () => {
            const cursors = new Map([['who-atc', {
                last_updated: '2026-04-01T00:00:00Z',
                status: 'no_updates',
            }]]);
            const r = transformGhaJobsToReport([okJob('who-atc')], 'r-s3', NOW, {
                cursors, stalledThresholdDays: 14,
            });
            expect(r.adapters[0].stalled).toBe(true);
            expect(r.adapters[0].error).toContain('never succeeded');
        });

        it('GHA-failed adapter is not re-tagged stalled (error already surfaced)', () => {
            const jobs = [{
                name: 'Adapter [dailymed]', conclusion: 'failure',
                startedAt: '2026-05-22T10:00:00Z', completedAt: '2026-05-22T10:00:05Z',
            }];
            const cursors = new Map([['dailymed', {
                last_success_at: '2026-04-01T00:00:00Z',
                status: 'failed',
            }]]);
            const r = transformGhaJobsToReport(jobs, 'r-s4', NOW, {
                cursors, stalledThresholdDays: 14,
            });
            expect(r.adapters[0].passed).toBe(false);
            expect(r.adapters[0].stalled).toBeUndefined();
            expect(r.adapters[0].error).toContain('failure');
        });

        it('no cursor for source -> not flagged (e.g. first-ever run before any worker fired)', () => {
            const r = transformGhaJobsToReport([okJob('chembl')], 'r-s5', NOW, {
                cursors: new Map(), stalledThresholdDays: 14,
            });
            expect(r.adapters[0].passed).toBe(true);
            expect(r.adapters[0].stalled).toBeUndefined();
        });

        it('back-compat: opts omitted entirely -> matches pre-cycle-21 behaviour', () => {
            const r = transformGhaJobsToReport([okJob('chembl')], 'r-s6');
            expect(r.adapters[0].passed).toBe(true);
            expect(r.adapters[0].stalled).toBeUndefined();
        });

        it('threshold boundary: exactly at threshold = not stalled, just over = stalled', () => {
            const cursors = (ts: string) => new Map([['dailymed', {
                last_success_at: ts, status: 'success',
            }]]);
            // 14 days exactly
            const exact = transformGhaJobsToReport([okJob('dailymed')], 'r-s7', NOW, {
                cursors: cursors('2026-05-08T12:00:00Z'), stalledThresholdDays: 14,
            });
            expect(exact.adapters[0].stalled).toBeUndefined();
            // 14.1 days
            const over = transformGhaJobsToReport([okJob('dailymed')], 'r-s7', NOW, {
                cursors: cursors('2026-05-08T09:36:00Z'), stalledThresholdDays: 14,
            });
            expect(over.adapters[0].stalled).toBe(true);
        });
    });
});
