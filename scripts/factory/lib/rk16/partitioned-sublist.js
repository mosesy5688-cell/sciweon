/**
 * RK-16A2 — generic PartitionedSublist builder (PURE MECHANISM).
 *
 * Builds a PartitionedSublist (family-policy.ts shape): partition_name -> its
 * posting sublist, which is EITHER a single PostingDirectoryRef (large) OR an
 * ordered PostingPageRef[] (small). This is the GENERIC substrate mechanism — it
 * does NOT enumerate or hardcode ANY partition names (no is_active /
 * activity_type / verdict / namespace). Names are supplied by the caller (a
 * family's business policy decides them at registration, OUT of the substrate).
 *
 * OFFLINE/FIXTURE use only.
 */

/**
 * @param {Array<{partition_name:string, posting_list: object[]|object}>} entries
 *   each posting_list is a flat PostingPageRef[] OR a PostingDirectoryRef
 *   (as returned by posting-directory-writer.writePostingList).
 * @returns {{
 *   partition_names: string[],
 *   get(name:string): (object[]|object|undefined)
 * }}  conforms to family-policy.ts PartitionedSublist.
 */
export function buildPartitionedSublist(entries) {
    const map = new Map();
    for (const { partition_name, posting_list } of entries) {
        if (typeof partition_name !== 'string' || partition_name.length === 0) {
            throw new Error('[PARTITIONED-SUBLIST] partition_name must be a non-empty string');
        }
        if (map.has(partition_name)) {
            throw new Error(`[PARTITIONED-SUBLIST] duplicate partition_name "${partition_name}"`);
        }
        map.set(partition_name, posting_list);
    }
    // Stable, name-sorted ordering — no semantic meaning attached to any name.
    const partition_names = [...map.keys()].sort();
    return {
        partition_names,
        get(name) { return map.get(name); },
    };
}
