/**
 * Simulator checks — unified dispatcher.
 *
 * Aggregates per-domain check maps so the simulator core does not need to know
 * how checks are organized. Keep individual domain files under 250 lines
 * (Art 5.1 Anti-Monolith).
 */

import {
    compoundChecks,
    bioactivityChecks,
    trialChecks,
    failureChecks,
} from './simulator-checks-data.js';

import {
    paperCoverageChecks,
    retractionChecks,
    crossLinkChecks,
    provenanceChecks,
} from './simulator-checks-paper.js';

export const CHECKS = {
    ...compoundChecks,
    ...bioactivityChecks,
    ...trialChecks,
    ...failureChecks,
    ...paperCoverageChecks,
    ...retractionChecks,
    ...crossLinkChecks,
    ...provenanceChecks,
};
