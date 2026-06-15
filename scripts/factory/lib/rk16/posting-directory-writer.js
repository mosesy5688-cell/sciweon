/**
 * RK-16A2 — posting directory writer (PURE MECHANISM, OFFLINE/FIXTURE only).
 *
 * Given the PostingPageRef[] for ONE index key, decide()s whether it stays flat
 * or goes two-level. If two-level: write the page-ref array as ONE directory
 * NXVF entity via the reused ShardWriter and return a PostingDirectoryRef
 * (refs.ts shape, directory_depth implicitly 1). Else return the flat array.
 *
 * Build FAILS LOUD if asked to emit a flat list that exceeds the threshold (a
 * directory entry holds page refs, never another directory — depth stays 1).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ShardWriter } from '../shard-writer.js';
import { sha256Bytes } from './content-hash.js';
import { decide, DIRECTORY_DEPTH } from './posting-threshold.js';

function freshTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rk16-dir-'));
}

/** Serialize a posting list (flat) but THROW if it exceeds the threshold. */
export function emitFlatOrThrow(pageRefs) {
    const d = decide(pageRefs);
    if (d.two_level) {
        throw new Error(
            `[POSTING-DIRECTORY] refusing to emit a FLAT posting list that exceeds ` +
            `the threshold (count=${d.page_ref_count}, inline_bytes=${d.inline_bytes}, ` +
            `reason=${d.reason}) — it MUST be two-level.`,
        );
    }
    return pageRefs;
}

/**
 * Write the posting list for one index key, flat or two-level as decide() dictates.
 *
 * @param {object[]} pageRefs  PostingPageRef[] for one index key
 * @param {object} opts { directoryShardKey?, outputDir?, namePrefix? }
 * @returns {{
 *   two_level:boolean,
 *   posting_list: object[] | object,  // flat PostingPageRef[] OR PostingDirectoryRef
 *   directory_bytes?: Buffer,
 *   directory_shard_key?: string
 * }}
 */
export async function writePostingList(pageRefs, opts = {}) {
    const d = decide(pageRefs);
    if (!d.two_level) {
        return { two_level: false, posting_list: pageRefs };
    }

    if (d.directory_depth !== DIRECTORY_DEPTH) {
        throw new Error(`[POSTING-DIRECTORY] directory_depth must be exactly ${DIRECTORY_DEPTH}`);
    }

    const namePrefix = opts.namePrefix || 'posting-dir-shard';
    const outputDir = opts.outputDir || freshTmpDir();
    const directoryShardKey = opts.directoryShardKey || `${namePrefix}-000.bin`;

    const writer = new ShardWriter(outputDir, namePrefix);
    await writer.init();
    const name = writer.open();

    // ONE directory NXVF entity = the whole page-ref array (depth 1).
    const payload = Buffer.from(JSON.stringify(pageRefs), 'utf-8');
    const { offset, size } = writer.writeEntity(payload);
    writer.finalize();

    const directory_bytes = fs.readFileSync(path.join(outputDir, name));

    const ref = {
        kind: 'posting_directory_ref',
        directory_shard_key: directoryShardKey,
        directory_offset: offset,
        directory_length: size,
        page_ref_count: pageRefs.length,
        directory_sha256: sha256Bytes(payload),
    };

    return {
        two_level: true,
        posting_list: ref,
        directory_bytes,
        directory_shard_key: directoryShardKey,
    };
}
