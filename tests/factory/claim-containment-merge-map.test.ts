/**
 * Lane 3S section 4 -- the three bypassing routes, pinned.
 *
 * `bioactivities`, `papers` and `trials` return plain `Response.json` and never
 * reach the shared rights filter. The Founder ruled they must NOT be modified,
 * because they cannot carry the claim containers: the merger registers a
 * deep-merge strategy for exactly two of its nine merged files, and Lane 3
 * rules the drug-label axis out of scope, so only compound records gain the
 * six keys.
 *
 * This test pins the premise that ruling rests on. If a third file ever gains
 * a deep-merge strategy, the "cannot carry" argument fails and this goes red.
 *
 * ASSERT ON THE KEY SET, NEVER ON THE FUNCTION IDENTITIES. Lane 3 replaces the
 * `compounds-enriched.jsonl` VALUE; a value-identity assertion would break it,
 * and Lane 3 cannot edit this test.
 *
 * SCOPE LIMIT, stated rather than closed: those three routes also bypass the
 * pre-existing FAERS/MedDRA/KEGG containment. That is a SEPARATE PRE-EXISTING
 * GAP, a candidate for a future Founder-owned lane. It is not closed here, and
 * it is not closed by this paragraph.
 */

import { describe, it, expect } from 'vitest';
import { MERGE_STRATEGY_PER_FILE, MERGE_FILES } from '../../scripts/factory/lib/aggregated-merger.js';

describe('the deep-merge strategy map -- key set pinning', () => {
    it('registers a strategy for exactly the two named files', () => {
        expect(Object.keys(MERGE_STRATEGY_PER_FILE).sort())
            .toEqual(['compounds-enriched.jsonl', 'drug-labels.jsonl']);
    });
    it('the control: the merged-file list is strictly larger than the strategy map', () => {
        // KNOWN POSITIVE / KNOWN NEGATIVE with DIFFERENT values -- if the map
        // and the file list were the same size the assertion above would be
        // vacuous, so the gap is what makes the pin meaningful.
        expect(MERGE_FILES.length).toBeGreaterThan(Object.keys(MERGE_STRATEGY_PER_FILE).length);
        expect(Object.keys(MERGE_STRATEGY_PER_FILE)).toHaveLength(2);
    });
    it('names no bioactivity, paper or trial file', () => {
        for (const key of Object.keys(MERGE_STRATEGY_PER_FILE)) {
            expect(key).not.toMatch(/bioactivit|paper|trial/i);
        }
    });
});
