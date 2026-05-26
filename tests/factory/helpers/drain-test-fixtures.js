/**
 * Test fixtures for drain-adapter-backlog (cycle 23 PR-CORE-Drain).
 *
 * Extracted per Art 5.1 250-line cap on the main test file. Provides
 * mock record factories, mock enrichOne implementations, and timing
 * helpers used across the 11 defense matrices.
 */

// Generate count mock records with stable lex-sortable ids. enrichedInit
// controls whether records start with the 'enriched' tag (used by the
// all-records-enriched / cursor-readback scenarios).
export function makeMockRecords(count, { prefix = 'mock', enrichedInit = false } = {}) {
    const out = [];
    for (let i = 0; i < count; i++) {
        // Pad to 6 digits so lex order matches numeric order (mock::000001 < mock::000002).
        const padded = String(i + 1).padStart(6, '0');
        const r = { id: `sciweon::${prefix}::${padded}`, enriched: enrichedInit };
        out.push(r);
    }
    return out;
}

// Async enricher mock: mutates record.enriched = true (in-place), optionally
// sleeps msPerCall, optionally throws on a specific record id.
export function makeMockEnrichOne({ msPerCall = 0, throwOnId = null } = {}) {
    return async function enrichOne(record) {
        if (throwOnId && record.id === throwOnId) {
            throw new Error(`mock enrichOne abort on ${record.id}`);
        }
        if (msPerCall > 0) await new Promise(r => setTimeout(r, msPerCall));
        record.enriched = true;
        return record;
    };
}

// Synchronous "burn N ms of wall clock" — used to validate that the
// predictive budget gate observes blocking time, not just async I/O.
export function burnSyncMs(ms) {
    const target = Date.now() + ms;
    // eslint-disable-next-line no-empty
    while (Date.now() < target) {}
}

// Predicate equivalent of compound-id-resolver isEligible — generic version
// based on .enriched flag for unit tests.
export function isEligibleMock(r) {
    return r && !r.enriched;
}

// Default isEligible filter applied on top of makeMockRecords output.
export function filterEligibleMock(records) {
    return records.filter(isEligibleMock);
}
