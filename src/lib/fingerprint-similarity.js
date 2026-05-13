/**
 * Tanimoto similarity over PubChem CACTVS 881-bit fingerprints.
 *
 * V0.3.5 scale: brute-force pairwise on 5000 compounds = 12.5M pairs, < 1 sec.
 * V0.1b scale: 111M compounds will require ANN index (HNSW); this function
 * stays valid for verification + small-scale queries.
 *
 * Fingerprint format (PubChem documentation):
 *   - 4-byte big-endian bit count header (always 881)
 *   - 110 bytes (881 bits, last 7 bits padding)
 *   - Total 114 bytes -> 152 base64 chars + padding (typically 156 with '==')
 *
 * Tanimoto coefficient: |A ∩ B| / |A ∪ B|  in [0, 1]
 */

function base64ToBytes(b64) {
    return Buffer.from(b64, 'base64');
}

function popcount8(byte) {
    byte = byte - ((byte >> 1) & 0x55);
    byte = (byte & 0x33) + ((byte >> 2) & 0x33);
    return (byte + (byte >> 4)) & 0x0f;
}

export function tanimoto(fpA, fpB) {
    if (!fpA || !fpB) return 0;
    const a = base64ToBytes(fpA);
    const b = base64ToBytes(fpB);
    // Skip 4-byte bit-count header
    const len = Math.min(a.length, b.length) - 4;
    if (len <= 0) return 0;
    let intersection = 0;
    let union = 0;
    for (let i = 4; i < 4 + len; i++) {
        const x = a[i];
        const y = b[i];
        intersection += popcount8(x & y);
        union += popcount8(x | y);
    }
    return union === 0 ? 0 : intersection / union;
}

/**
 * Find top-K compounds most similar to a query fingerprint.
 * Compounds: array of {id, fingerprint: {cactvs_881}}.
 */
export function topKSimilar(queryFp, compounds, k = 10) {
    const scored = [];
    for (const c of compounds) {
        const fp = c.fingerprint?.cactvs_881;
        if (!fp) continue;
        scored.push({ compound: c, similarity: tanimoto(queryFp, fp) });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
}
