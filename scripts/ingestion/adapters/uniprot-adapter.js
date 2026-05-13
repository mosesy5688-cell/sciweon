/**
 * UniProt Adapter — Sciweon V0.2.2
 *
 * Cross-source verification for Bioactivity.target metadata.
 * UniProt (EMBL-EBI) is the international protein authority — same parent
 * institution as ChEMBL but independent curation track.
 *
 * API docs: https://www.uniprot.org/help/api_queries
 * Base: https://rest.uniprot.org/uniprotkb
 *
 * PRIMARY-DATA contract (feedback_no_secondary_processed_data):
 *   Consumed (raw IDs / international standard names / objective measurements):
 *     - primaryAccession           (international protein ID, like InChIKey for compounds)
 *     - uniProtkbId                (entry name; HGNC/IUBMB international consensus)
 *     - proteinDescription.recommendedName.fullName.value  (international standard)
 *     - organism.scientificName + organism.taxonId         (NCBI Taxonomy ID, international)
 *     - genes[0].geneName.value                            (HGNC gene symbol, international)
 *     - sequence.length + sequence.molWeight               (objective measurement)
 *
 *   REJECTED (UniProt curator secondary classifications):
 *     - keywords                   (UniProt internal classification taxonomy)
 *     - comments.subcellularLocations  (functional annotation)
 *     - features[]                 (functional / structural element annotations)
 *     - dbReferences               (Cross-refs that are themselves secondary indexed)
 *
 *   Rationale: protein name / gene symbol / organism / sequence are international
 *   standards transmitted from authoritative bodies (HGNC, NCBI Taxonomy, IUBMB).
 *   UniProt's own keyword taxonomy and functional annotations are curator-derived
 *   secondary processing and must not enter Sciweon's primary data graph.
 */

const UNIPROT_BASE = 'https://rest.uniprot.org/uniprotkb';
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_DELAY_MS = 200;
const BATCH_MAX = 100; // UniProt accessions endpoint comma-list limit

// Only request the PRIMARY fields we accept; this prevents accidental
// consumption of secondary fields like keywords/features.
const PRIMARY_FIELDS = [
    'accession',
    'id',
    'protein_name',
    'organism_name',
    'organism_id',
    'gene_names',
    'length',
    'mass',
].join(',');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        if (res.status === 404) return null;
        if (res.status === 429 || res.status === 503) {
            await sleep(5000);
            const retry = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!retry.ok) throw new Error(`HTTP ${retry.status}: ${url}`);
            return retry.json();
        }
        throw new Error(`HTTP ${res.status}: ${url}`);
    }
    return res.json();
}

/**
 * Batch lookup by UniProt accessions. Returns Map<accession, raw_uniprot_record>.
 * Each call carries up to BATCH_MAX accessions in the comma-separated query.
 */
export async function fetchByAccessionBatch(accessions) {
    if (!accessions?.length) return new Map();
    const unique = [...new Set(accessions.filter(Boolean))];
    const result = new Map();
    for (let i = 0; i < unique.length; i += BATCH_MAX) {
        const chunk = unique.slice(i, i + BATCH_MAX);
        const url = `${UNIPROT_BASE}/accessions?accessions=${chunk.join(',')}&format=json&fields=${PRIMARY_FIELDS}`;
        try {
            const data = await fetchJson(url);
            for (const r of (data?.results ?? [])) {
                if (r && r.primaryAccession) result.set(r.primaryAccession, r);
            }
        } catch (e) {
            console.warn(`[UNIPROT] batch ${i}-${i + chunk.length}: ${e.message}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }
    return result;
}

/**
 * Extract PRIMARY-ONLY fields from a raw UniProt record into a normalized
 * shape suitable for embedding in Bioactivity.target.
 */
export function extractPrimary(raw) {
    if (!raw || !raw.primaryAccession) return null;
    const protein_name = raw.proteinDescription?.recommendedName?.fullName?.value
        ?? raw.proteinDescription?.submissionNames?.[0]?.fullName?.value
        ?? null;
    const gene_symbol = raw.genes?.[0]?.geneName?.value ?? null;
    const taxonId = raw.organism?.taxonId;
    return {
        uniprot_accession: raw.primaryAccession,
        uniprot_id: raw.uniProtkbId ?? null,
        protein_name,
        organism: {
            taxon_id: typeof taxonId === 'number' ? taxonId : null,
            scientific_name: raw.organism?.scientificName ?? null,
        },
        gene_symbol,
        sequence_length: typeof raw.sequence?.length === 'number' ? raw.sequence.length : null,
        sequence_mol_weight: typeof raw.sequence?.molWeight === 'number' ? raw.sequence.molWeight : null,
    };
}
