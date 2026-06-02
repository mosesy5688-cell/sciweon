/**
 * Reads Sciweon's PUBLIC snapshot artifacts (dependency-free; node:zlib for .gz).
 *
 * Sciweon's public snapshot (snapshots/<date>/) gzips every JSONL (snapshot-builder.js
 * gzipSync). This reader transparently handles both `.jsonl` and `.jsonl.gz`.
 *
 * Public shapes (RULING 1, NO SNOMED content):
 *   snomed-concepts-public.jsonl  -> { sid_s, sid_c }              (NO cui/code/str)
 *   diseases.jsonl / trials.jsonl -> record.snomed_links[] of
 *                                    { snomed_sid, confidence, match_method }
 *
 * Ships ZERO SNOMED content: only reads Sciweon-produced hashes + provenance.
 */

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

export const SNOMED_PUBLIC_FILE = 'snomed-concepts-public.jsonl';
export const DISEASES_FILE = 'diseases.jsonl';
export const TRIALS_FILE = 'trials.jsonl';

/**
 * Resolve a base file name to its on-disk path inside a snapshot dir, preferring
 * the gzipped form (the public snapshot is gzipped). Returns null if neither exists.
 */
export function resolveSnapshotFile(snapshotDir, baseName) {
    const gz = join(snapshotDir, `${baseName}.gz`);
    if (existsSync(gz)) return gz;
    const plain = join(snapshotDir, baseName);
    if (existsSync(plain)) return plain;
    return null;
}

/** Read a (possibly .gz) JSONL file into an array of parsed records. */
export function readJsonl(filePath) {
    const buf = readFileSync(filePath);
    const text = filePath.endsWith('.gz') ? gunzipSync(buf).toString('utf-8') : buf.toString('utf-8');
    const records = [];
    let parseErrors = 0;
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        try { records.push(JSON.parse(t)); } catch { parseErrors++; }
    }
    return { records, parseErrors };
}

/**
 * Read the public SNOMED concept artifact -> array of { sid_s, sid_c }.
 * Throws if the file is absent (refuse a silent empty rehydration).
 */
export function readSnomedPublic(snapshotDir) {
    const path = resolveSnapshotFile(snapshotDir, SNOMED_PUBLIC_FILE);
    if (!path) {
        throw new Error(`[snapshot-read] ${SNOMED_PUBLIC_FILE}[.gz] not found in ${snapshotDir}`);
    }
    return readJsonl(path);
}

/**
 * Read a cross-link file (diseases/trials) if present -> array of records each
 * potentially carrying snomed_links[]. Missing file is non-fatal (returns null);
 * a snapshot may not ship trials in every build. Caller reports the absence loudly.
 */
export function readCrossLinkFile(snapshotDir, baseName) {
    const path = resolveSnapshotFile(snapshotDir, baseName);
    if (!path) return null;
    return readJsonl(path);
}

/**
 * Collect every distinct snomed_sid referenced by a cross-link record set, with the
 * record ids that reference it. Returns Map<snomed_sid, { count, sample_ids[] }>.
 */
export function collectCrossLinkSids(records) {
    const bySid = new Map();
    for (const rec of records || []) {
        const links = Array.isArray(rec?.snomed_links) ? rec.snomed_links : [];
        for (const link of links) {
            const sid = link?.snomed_sid;
            if (typeof sid !== 'string' || sid.length === 0) continue;
            if (!bySid.has(sid)) bySid.set(sid, { count: 0, sample_ids: [] });
            const e = bySid.get(sid);
            e.count++;
            const id = rec?.id ?? rec?.sid_c ?? rec?.sid_s ?? null;
            if (id && e.sample_ids.length < 5 && !e.sample_ids.includes(id)) e.sample_ids.push(id);
        }
    }
    return bySid;
}
