/**
 * SDF V2000 Streaming Parser — V0.6 Bulk Backfill
 *
 * Parses PubChem CURRENT-Full SDF dump (250 chunk files × ~600MB decompressed
 * each) into structured compound objects. Streaming line-based: never holds
 * more than one compound in memory at a time → fits 8GB GHA runner easily.
 *
 * Format reference: PubChem provides SDF V2000 with proprietary property
 * blocks (`> <TAG>` headers) for each compound, terminated by `$$$$`.
 * Mol block (atom/bond table) is intentionally NOT parsed — Sciweon only
 * needs the property tags; canonical SMILES + InChI are richer than the
 * raw atom table for downstream consumers.
 *
 * This parser is pure (no I/O): it takes an async iterable of lines and
 * yields property dictionaries. Caller wires up gunzip + readline streams
 * (see scripts/factory/bulk-pubchem-harvest.js when that lands).
 *
 * Per-compound property dict shape:
 *   {
 *     PUBCHEM_COMPOUND_CID: '2244',
 *     PUBCHEM_IUPAC_NAME: '2-acetyloxybenzoic acid',
 *     PUBCHEM_OPENEYE_CAN_SMILES: 'CC(=O)Oc1ccccc1C(=O)O',
 *     PUBCHEM_IUPAC_INCHIKEY: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
 *     PUBCHEM_MOLECULAR_FORMULA: 'C9H8O4',
 *     PUBCHEM_MOLECULAR_WEIGHT: '180.16',
 *     PUBCHEM_XLOGP3: '1.2',
 *     PUBCHEM_CACTVS_TPSA: '63.6',
 *     PUBCHEM_CACTVS_HBOND_DONOR: '1',
 *     PUBCHEM_CACTVS_HBOND_ACCEPTOR: '4',
 *     PUBCHEM_CACTVS_ROTATABLE_BOND: '3',
 *     PUBCHEM_CACTVS_COMPLEXITY: '212',
 *     PUBCHEM_CACTVS_SUBSKEYS: '<base64>',
 *     ...
 *   }
 *
 * Skips records lacking PUBCHEM_COMPOUND_CID (degenerate / deprecated CIDs).
 * Caller decides whether to halt on parse errors or continue (degraded harvest).
 */

const TAG_HEADER_RE = /^> <([^>]+)>(?:\s*\(\d+\))?\s*$/;
const RECORD_SEPARATOR = '$$$$';

/**
 * Async generator: parses an async iterable of lines into compound dicts.
 *
 * State machine:
 *   - Idle: scanning for `> <TAG>` header
 *   - InTag(name): accumulating value lines until blank line OR next tag/end
 *   - On `$$$$`: yield current compound, reset
 *
 * PubChem SDF tag values are typically single-line, but multi-line is allowed
 * (e.g., long InChI strings sometimes wrap). We join with '\n' and trim.
 */
export async function* parseSdfStream(linesIterable) {
    let current = {};
    let inTag = null;
    let tagBuffer = [];

    function commitTag() {
        if (inTag !== null) {
            current[inTag] = tagBuffer.join('\n').trim();
        }
        inTag = null;
        tagBuffer = [];
    }

    for await (const rawLine of linesIterable) {
        const line = rawLine.replace(/\r$/, ''); // tolerate CRLF

        if (line === RECORD_SEPARATOR) {
            commitTag();
            if (current.PUBCHEM_COMPOUND_CID) {
                yield current;
            }
            current = {};
            continue;
        }

        const headerMatch = TAG_HEADER_RE.exec(line);
        if (headerMatch) {
            // New property tag begins; commit previous if any.
            commitTag();
            inTag = headerMatch[1];
            tagBuffer = [];
            continue;
        }

        if (inTag !== null) {
            // Empty line ends the tag value (PubChem convention).
            if (line === '') {
                commitTag();
            } else {
                tagBuffer.push(line);
            }
        }
        // Lines outside any tag (mol block, blank delimiters) are ignored.
    }

    // Tail compound without trailing `$$$$` (defensive — should not occur
    // in well-formed PubChem SDF but tolerate truncated input).
    commitTag();
    if (current.PUBCHEM_COMPOUND_CID) {
        yield current;
    }
}

/**
 * Convenience wrapper: parse a string buffer into an array of compounds.
 * Used for tests and small samples. NOT for production bulk (110M compounds
 * doesn't fit in memory; use parseSdfStream + readline directly).
 */
export async function parseSdfText(text) {
    const lines = text.split('\n');
    async function* iter() { for (const l of lines) yield l; }
    const out = [];
    for await (const rec of parseSdfStream(iter())) out.push(rec);
    return out;
}

export { RECORD_SEPARATOR, TAG_HEADER_RE };
