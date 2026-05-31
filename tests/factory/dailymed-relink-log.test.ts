// @ts-nocheck
/**
 * PR-MD-1f-probe Collar 1: formatDailymedRelinkLog (moved out of dailymed-crosslink.js
 * into its own lib). Locks the THREE log prefixes operators grep separately and the
 * typed-split fields.
 */

import { describe, it, expect } from 'vitest';
import { formatDailymedRelinkLog } from '../../scripts/factory/lib/dailymed-relink-log.js';

const rl = {
    labelsRehydrated: 3, dmByRxcuiSize: 10, dmLinked: 190,
    buckets: {
        reverse_map_available: true, total_label_rxcui: 10, productive: 187,
        in_corpus_unstamped: 0, in_corpus_stamp_drift: 0, not_in_corpus: 165, no_unii_bridge: 225,
        samples: { not_in_corpus: [], no_unii_bridge: [] },
    },
    labelProductivity: {
        labels_linked: 188, labels_zero_productive: 12, labels_no_rxcui: 4, total_labels_with_rxcui: 200,
        harm_reason: { projection_gap_typed: 3, projection_gap_null_tty: 7, not_in_corpus: 2, mixed_or_other: 0 },
        typed_breakdown: { in_present: 1, no_in_rxnrel_reachable: 1, no_in_tradename_bn: 1, no_in_name_type: 0, no_in_other: 0 },
        samples: { zero_productive: [{ setid: 'X', reason: 'projection_gap_null_tty', rxcui: [] }], typed_no_in: [] },
    },
};

describe('formatDailymedRelinkLog', () => {
    it('emits THREE prefixed lines: relink + label-harm + typed-split', () => {
        const lines = formatDailymedRelinkLog(rl).split('\n');
        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain('[BACKFILL/dailymed-relink] labels_rehydrated=3');
        expect(lines[1]).toContain('[BACKFILL/dailymed-label-harm] labels_linked=188 labels_zero_productive=12');
        expect(lines[1]).toContain('projection_gap_typed=3 projection_gap_null_tty=7');
    });

    it('typed-split line carries the breakdown + the Collar-2 edge-TBD framing', () => {
        const line = formatDailymedRelinkLog(rl).split('\n')[2];
        expect(line).toContain('[BACKFILL/dailymed-typed-split] in_present=1');
        expect(line).toContain('no_in_rxnrel_reachable=1 (TTY-eligible; edge-existence TBD)');
        expect(line).toContain('no_in_tradename_bn=1');
        expect(line).toContain('no_in_name_type=0 (no RXNREL path)');
    });
});
