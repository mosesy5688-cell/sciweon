/**
 * TEST-ONLY entry point for the three legacy source-rights mechanisms
 * (Lane 3S / L3S-1 guard c, A-5).
 *
 * WHY THIS FILE EXISTS. The alternative -- giving `applySourceRightsFilter` an
 * options argument -- would make
 * `applySourceRightsFilter(payload, { removeClaimContainers: false })` a
 * supported, tested call that DISABLES containment on a public endpoint. That
 * option is deleted. The regression baseline for the three legacy mechanisms
 * is obtained here instead, through a module NO SERVING PATH IMPORTS.
 *
 * DIRECTION IS ONE-WAY: this module imports FROM `source-rights-filter.ts`,
 * which stays import-free. The reverse is forbidden.
 *
 * The single exported identifier below must appear NOWHERE ELSE under `src/**`
 * -- including `source-rights-filter.ts` itself, which is where the serving
 * boundary `jsonWithRights` lives. `tests/worker/claim-containment-filter.test.ts`
 * asserts exactly that.
 */

import {
    withholdFaersSignal,
    withholdObjectKeys,
    pruneIdListArrays,
} from './source-rights-filter';

export const claimContainmentLegacyMechanisms = {
    withholdFaersSignal,
    withholdObjectKeys,
    pruneIdListArrays,
};
