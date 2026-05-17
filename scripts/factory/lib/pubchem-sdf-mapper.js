/**
 * PubChem SDF → Sciweon Compound Schema Mapper — V0.6 Bulk Backfill
 *
 * Translates the raw property dict from sdf-parser.js into a Sciweon
 * Compound entity matching src/lib/schemas/compound.js. Used by V0.6 bulk
 * pipeline to convert 111M PubChem CURRENT-Full records into Tier 2
 * sharded JSONL.zst entries.
 *
 * Tier 2 scope (per §8 + §10): PubChem basics only. NO cross-source
 * enrichment (no ChEMBL bioactivity / no clinical trials / no NegEvidence).
 * Tier 2 promotion to Tier 1 (full enrichment via existing factory chain)
 * is on-demand when an Agent queries a Tier 2 CID via /api/v1/entity/.
 *
 * Provenance: source='pubchem', extraction_method='pubchem_ftp_sdf_v2000'.
 * Confidence: structural=80, overall=70 (single PubChem source, primary
 * authoritative computed properties; not yet cross-validated against
 * ChEMBL InChIKey match — that happens at Tier 1 promotion).
 */

const EXTRACTION_METHOD = 'pubchem_ftp_sdf_v2000';

function toNumber(s) {
    if (s === undefined || s === null || s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function toInteger(s) {
    if (s === undefined || s === null || s === '') return null;
    const n = parseInt(String(s), 10);
    return Number.isInteger(n) ? n : null;
}

function firstNonEmpty(rec, ...keys) {
    for (const k of keys) {
        const v = rec[k];
        if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
}

export function mapPubchemRecord(rec, { timestamp } = {}) {
    const cid = toInteger(rec.PUBCHEM_COMPOUND_CID);
    if (!cid) return null;

    const inchiKey = firstNonEmpty(rec, 'PUBCHEM_IUPAC_INCHIKEY');
    if (!inchiKey) return null; // InChIKey is the cross-source primary key; required

    const inchi = firstNonEmpty(rec, 'PUBCHEM_IUPAC_INCHI');
    const smiles = firstNonEmpty(rec, 'PUBCHEM_OPENEYE_CAN_SMILES', 'PUBCHEM_OPENEYE_ISO_SMILES');
    const molFormula = firstNonEmpty(rec, 'PUBCHEM_MOLECULAR_FORMULA');
    const molWeight = toNumber(rec.PUBCHEM_MOLECULAR_WEIGHT);
    const iupacName = firstNonEmpty(rec, 'PUBCHEM_IUPAC_NAME', 'PUBCHEM_IUPAC_OPENEYE_NAME');

    const properties = {};
    const logP = toNumber(rec.PUBCHEM_XLOGP3);
    if (logP !== null) properties.log_p = { value: logP, method: 'XLogP3' };
    const tpsa = toNumber(rec.PUBCHEM_CACTVS_TPSA);
    if (tpsa !== null) properties.tpsa = { value: tpsa, unit: 'angstrom_squared' };
    const complexity = toNumber(rec.PUBCHEM_CACTVS_COMPLEXITY);
    if (complexity !== null) properties.complexity = complexity;
    const hbondDonors = toInteger(rec.PUBCHEM_CACTVS_HBOND_DONOR);
    if (hbondDonors !== null) properties.h_bond_donors = hbondDonors;
    const hbondAcceptors = toInteger(rec.PUBCHEM_CACTVS_HBOND_ACCEPTOR);
    if (hbondAcceptors !== null) properties.h_bond_acceptors = hbondAcceptors;
    const rotatableBonds = toInteger(rec.PUBCHEM_CACTVS_ROTATABLE_BOND);
    if (rotatableBonds !== null) properties.rotatable_bonds = rotatableBonds;

    const fingerprint = {};
    const cactvs881 = firstNonEmpty(rec, 'PUBCHEM_CACTVS_SUBSKEYS');
    if (cactvs881) {
        fingerprint.cactvs_881 = cactvs881;
        fingerprint.source = 'pubchem_cactvs_v2';
    }

    const ts = timestamp || new Date().toISOString();

    const out = {
        id: `sciweon::compound::CID:${cid}`,
        pubchem_cid: cid,
        inchi_key: inchiKey,
        inchi: inchi || '',
        smiles_canonical: smiles || '',
        molecular_formula: molFormula || '',
        molecular_weight: { value: molWeight !== null ? molWeight : 0, unit: 'Da' },
        iupac_name: iupacName || null,
        synonyms: [], // bulk SDF has no synonyms; promotion to Tier 1 fetches them
        provenance: {
            sources: [{
                source: 'pubchem',
                source_id: String(cid),
                timestamp: ts,
                extraction_method: EXTRACTION_METHOD,
            }],
            last_updated: ts,
        },
        confidence: {
            overall: 70,
            structural: 80,
            bioactivity: 0,
            clinical: 0,
            method: 'cross_source_consensus_v1',
            cross_source_agreement: {
                structural_match: false, // single source = not yet validated
                conflicts: [],
            },
        },
    };

    if (Object.keys(properties).length > 0) out.properties = properties;
    if (Object.keys(fingerprint).length > 0) out.fingerprint = fingerprint;

    return out;
}

export { EXTRACTION_METHOD };
