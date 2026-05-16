/**
 * Boundary Health — Sciweon V0.5.2
 *
 * Two boundary-layer signals the daily source-health workflow surfaces
 * alongside the existing per-source attribution scan:
 *
 *   1. Retry queue depth (PubChem ingestion boundary)
 *      - OK:    depth <= 50
 *      - WARN:  50 < depth <= 200
 *      - FAIL:  depth > 200    (real PubChem outage signal)
 *
 *   2. Harvest WARN aggregate sustained signal
 *      - Reads last 2 harvest summaries from state/harvest-history/
 *      - OK:    latest cycle warned == 0
 *      - WARN:  latest warned > 0 but previous warned == 0   (transient)
 *      - WARN:  latest warned > 0 AND previous warned > 0    (sustained)
 *
 * Sustained-WARN escalation is the PR #19 deferred A.3 rule from
 * LABNEXUS_EXECUTION_DETAILS.md 2026-05-16: "any WARN is allowed in code,
 * but never invisible; sustained WARN is FAIL". The transient single-cycle
 * case stays WARN (not FAIL) because PubChem schema drift is a Postel-law
 * upstream boundary — one bad cycle should surface but not halt operations.
 *
 * Status precedence: FAIL > WARN > OK. The source-health-monitor merges
 * this status with the per-source attribution status using the same
 * precedence so the strictest signal wins.
 */

import { readQueue, MAX_QUEUE_DEPTH } from './harvest-retry-queue.js';
import { listLatestHarvests } from './harvest-history.js';

const QUEUE_WARN_THRESHOLD = 50;
const QUEUE_FAIL_THRESHOLD = 200;

function mergeStatus(a, b) {
    const rank = { OK: 0, WARN: 1, FAIL: 2 };
    return rank[a] >= rank[b] ? a : b;
}

async function checkRetryQueueDepth() {
    try {
        const queue = await readQueue();
        const depth = Array.isArray(queue?.entries) ? queue.entries.length : 0;
        let status = 'OK';
        let message = `Queue depth ${depth}`;
        if (depth > QUEUE_FAIL_THRESHOLD) {
            status = 'FAIL';
            message = `Queue depth ${depth} exceeds FAIL threshold ${QUEUE_FAIL_THRESHOLD}. PubChem ingestion likely in real outage.`;
        } else if (depth > QUEUE_WARN_THRESHOLD) {
            status = 'WARN';
            message = `Queue depth ${depth} exceeds WARN threshold ${QUEUE_WARN_THRESHOLD}. Pass-1 drain monitoring recommended.`;
        }
        return {
            check: 'retry_queue_depth',
            status,
            depth,
            thresholds: {
                warn: QUEUE_WARN_THRESHOLD,
                fail: QUEUE_FAIL_THRESHOLD,
                hard_cap: MAX_QUEUE_DEPTH,
            },
            message,
            last_updated: queue?.last_updated || null,
        };
    } catch (err) {
        return {
            check: 'retry_queue_depth',
            status: 'WARN',
            depth: null,
            error: err.message,
            message: `Could not read retry queue: ${err.message}`,
        };
    }
}

async function checkHarvestWarnAggregate() {
    try {
        const summaries = await listLatestHarvests(2);
        if (summaries.length === 0) {
            return {
                check: 'harvest_warn_aggregate',
                status: 'OK',
                cycles_read: 0,
                message: 'No harvest history yet (first cron post-deploy).',
            };
        }
        const latest = summaries[0];
        const previous = summaries[1] || null;
        const latestWarned = Number(latest.warned) || 0;
        const previousWarned = previous ? Number(previous.warned) || 0 : 0;
        let status = 'OK';
        let message = `Latest cycle ${latest.run_id} warned=${latestWarned}`;
        if (latestWarned > 0 && previousWarned > 0) {
            status = 'WARN';
            message = `Sustained WARN across 2 cycles (latest=${latestWarned}, previous=${previousWarned}). Schema drift candidate — investigate adapter/upstream change.`;
        } else if (latestWarned > 0) {
            status = 'WARN';
            message = `Latest cycle WARN=${latestWarned} (transient — previous cycle clean). Will escalate to sustained if next cycle also non-zero.`;
        }
        return {
            check: 'harvest_warn_aggregate',
            status,
            cycles_read: summaries.length,
            latest: {
                run_id: latest.run_id,
                completed_at: latest.completed_at,
                warned: latestWarned,
                fetch_failed_count: Number(latest.fetch_failed_count) || 0,
            },
            previous: previous ? {
                run_id: previous.run_id,
                completed_at: previous.completed_at,
                warned: previousWarned,
            } : null,
            message,
        };
    } catch (err) {
        return {
            check: 'harvest_warn_aggregate',
            status: 'WARN',
            cycles_read: 0,
            error: err.message,
            message: `Could not read harvest history: ${err.message}`,
        };
    }
}

export async function runBoundaryChecks() {
    const queue = await checkRetryQueueDepth();
    const warn = await checkHarvestWarnAggregate();
    const status = mergeStatus(queue.status, warn.status);
    return {
        status,
        checks: [queue, warn],
    };
}

export { mergeStatus };
