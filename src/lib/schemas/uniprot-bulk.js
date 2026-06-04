/**
 * UniProt SwissProt bulk artifact-record schema + validator (PR-UNIPROT-1).
 *
 * This is the schema for the FULL-CORPUS UniProt bulk artifact record emitted by
 * scripts/factory/lib/uniprot-dat-stream.js -> processed/bulk/uniprot/<release>/sprot.jsonl.zst.
 * It is DELIBERATELY SEPARATE from src/lib/schemas/target.js: PR-UNIPROT-1 produces the
 * R2 artifact ONLY (no target merge). The target.js extension + the F3 enrich-into-target-
 * by-accession merge is PR-UNIPROT-2; this schema validates the raw bulk record shape.
 *
 * FULL-RECORD / FULL-CORPUS (founder ruling "preserve all source data as queryable base
 * data"): NO organism filter, NO DR-source whitelist. The record carries every parsed
 * field + every DR xref. taxon_id may be null (the no_ox edge -- COUNTED not dropped), so
 * organism.taxon_id is OPTIONAL here; the merge boundary (PR-2) decides organism scope.
 *
 * The canonical UniProt accession regex is shared verbatim with target.js / sid-target-
 * stamping.js (6-char [OPQ][0-9][A-Z0-9]{3}[0-9] or the 10-char extended form).
 */

export const UNIPROT_ACCESSION_PATTERN = /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/;
export const UNIPROT_BULK_LICENSE = 'cc-by-4.0';
export const UNIPROT_BULK_SCHEMA_VERSION = 'pr-uniprot-1';

export const UNIPROT_BULK_SCHEMA = {
    accession: { type: 'string', required: true, pattern: UNIPROT_ACCESSION_PATTERN },
    secondary_accessions: { type: 'array', required: true, itemType: 'string', maxItems: 200 },
    recommended_name: { type: 'string', required: false, nullable: true, maxLength: 1000 },
    ec_numbers: { type: 'array', required: true, itemType: 'string', maxItems: 50 },
    gene_symbol: { type: 'string', required: false, nullable: true, maxLength: 100 },
    organism: {
        type: 'object', required: true,
        shape: {
            scientific_name: { type: 'string', required: false, nullable: true, maxLength: 500 },
            taxon_id: { type: 'integer', required: false, nullable: true },
        },
    },
    sequence_length: { type: 'integer', required: false, nullable: true },
    sequence_mol_weight: { type: 'integer', required: false, nullable: true },
    function_descriptions: { type: 'array', required: true, itemType: 'string', maxItems: 1000 },
    db_xrefs: {
        type: 'array', required: true, maxItems: 4096,
        items: {
            source: { type: 'string', required: true, maxLength: 100 },
            id: { type: 'string', required: false, maxLength: 200 },
        },
    },
    license: { type: 'string', required: true, enum: [UNIPROT_BULK_LICENSE] },
};

/**
 * validateUniprotBulkRecord -- structural validation of one bulk record. Returns
 * { valid:boolean, errors:string[] }. Used by the harvest orchestrator as a hard
 * gate on a sample (and unit-tested directly). NOT a schema mutation of target.js.
 *
 * @param {object} rec
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateUniprotBulkRecord(rec) {
    const errors = [];
    if (!rec || typeof rec !== 'object') {
        return { valid: false, errors: ['record is not an object'] };
    }
    if (typeof rec.accession !== 'string' || !UNIPROT_ACCESSION_PATTERN.test(rec.accession)) {
        errors.push(`accession invalid: ${JSON.stringify(rec.accession)}`);
    }
    if (!Array.isArray(rec.secondary_accessions)) errors.push('secondary_accessions must be an array');
    if (!Array.isArray(rec.ec_numbers)) errors.push('ec_numbers must be an array');
    if (!Array.isArray(rec.function_descriptions)) errors.push('function_descriptions must be an array');
    if (rec.gene_symbol !== null && rec.gene_symbol !== undefined && typeof rec.gene_symbol !== 'string') {
        errors.push('gene_symbol must be string or null');
    }
    if (!rec.organism || typeof rec.organism !== 'object') {
        errors.push('organism must be an object');
    } else {
        const t = rec.organism.taxon_id;
        if (t !== null && t !== undefined && !Number.isInteger(t)) {
            errors.push('organism.taxon_id must be an integer or null');
        }
    }
    if (!Array.isArray(rec.db_xrefs)) {
        errors.push('db_xrefs must be an array');
    } else {
        for (let i = 0; i < rec.db_xrefs.length; i++) {
            const x = rec.db_xrefs[i];
            if (!x || typeof x.source !== 'string' || x.source.length === 0) {
                errors.push(`db_xrefs[${i}].source must be a non-empty string`);
                break;
            }
        }
    }
    if (rec.license !== UNIPROT_BULK_LICENSE) {
        errors.push(`license must be '${UNIPROT_BULK_LICENSE}', got ${JSON.stringify(rec.license)}`);
    }
    return { valid: errors.length === 0, errors };
}
