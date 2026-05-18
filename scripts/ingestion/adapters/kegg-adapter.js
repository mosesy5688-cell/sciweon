/**
 * KEGG REST Adapter — Sciweon V0.3.5 #3
 *
 * KEGG (Kyoto Encyclopedia of Genes and Genomes) — Kyoto University,
 * international biology/medicine reference. Provides drug → target →
 * pathway → disease network not available in other primary sources.
 *
 * API docs: https://rest.kegg.jp/
 * Base: https://rest.kegg.jp
 *
 * KEGG REST returns flat-file text records (not JSON). Each entry is a
 * multi-line text block; we parse only the PRIMARY-DATA sections.
 *
 * PRIMARY-DATA contract:
 *   Consumed (international IDs / standard naming):
 *     - ENTRY / NAME (raw drug name)
 *     - FORMULA / EXACT_MASS / MOL_WEIGHT (objective chemistry)
 *     - ATC code (WHO international standard — already accepted)
 *     - DBLINKS:PubChem / DBLINKS:ChEBI / DBLINKS:ChEMBL (cross-ref IDs)
 *     - TARGET: Gene symbol + NCBI Gene ID (HSA:#####) + KEGG Orthology
 *       (KO:#####) — international gene nomenclature, primary
 *     - PATHWAY: KEGG pathway map IDs (international pathway taxonomy,
 *       authoritative-source exempt like MeSH)
 *     - DISEASE: KEGG disease ID + indication text (raw curated indication)
 *
 *   NOT consumed (KEGG team derived classifications):
 *     - CLASS (DG#### KEGG drug class hierarchy — internal taxonomy)
 *     - EFFICACY (curator-supplied prose description, not enum)
 *     - COMMENT (curator notes)
 */

// V2 adapter contract: reactive drug-name/D-number lookup — no date-based incremental API.
export const supportsIncremental = false;

const KEGG_BASE = 'https://rest.kegg.jp';
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_DELAY_MS = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
        if (res.status === 404) return null;
        if (res.status === 429 || res.status === 503) {
            await sleep(5000);
            const retry = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            if (!retry.ok) throw new Error(`HTTP ${retry.status}: ${url}`);
            return retry.text();
        }
        throw new Error(`HTTP ${res.status}: ${url}`);
    }
    return res.text();
}

/**
 * Search KEGG drug DB by compound name. Returns array of D-numbers with names.
 * Best match = first entry where the query name appears as primary name (not synonym).
 */
export async function searchDrugByName(name) {
    if (!name) return [];
    try {
        const text = await fetchText(`${KEGG_BASE}/find/drug/${encodeURIComponent(name)}`);
        if (!text) return [];
        return text.split('\n').filter(Boolean).map(line => {
            const [id, names] = line.split('\t');
            return {
                d_number: id.replace(/^dr:/, ''),
                names: names ? names.split(';').map(n => n.trim()) : [],
            };
        });
    } catch (e) {
        console.warn(`[KEGG] find ${name}: ${e.message}`);
        return [];
    }
}

/**
 * Fetch a KEGG drug entry by D-number. Returns parsed PRIMARY-only object.
 */
export async function fetchDrugEntry(dNumber) {
    if (!dNumber) return null;
    try {
        const text = await fetchText(`${KEGG_BASE}/get/dr:${encodeURIComponent(dNumber)}`);
        if (!text) return null;
        return parseDrugEntry(text);
    } catch (e) {
        console.warn(`[KEGG] get ${dNumber}: ${e.message}`);
        return null;
    }
}

/**
 * Parse KEGG flat-file drug entry text. Extracts PRIMARY-only fields.
 */
export function parseDrugEntry(text) {
    if (!text) return null;
    const lines = text.split('\n');
    const result = {
        d_number: null,
        names: [],
        formula: null,
        atc_codes: [],
        chebi_id: null,
        chembl_id: null,
        targets: [], // {gene_symbol, ncbi_gene_id, kegg_orthology}
        pathways: [], // KEGG pathway IDs (map#####)
        diseases: [], // {kegg_disease_id, indication}
    };

    let currentSection = null;
    for (const rawLine of lines) {
        const sectionMatch = rawLine.match(/^([A-Z_]+)\s+(.*)$/);
        const continuationMatch = rawLine.match(/^\s{12}(.*)$/);
        const isSubSection = rawLine.match(/^\s\s([A-Z_]+)\s+(.*)$/);

        if (sectionMatch && !rawLine.startsWith(' ')) {
            const [, section, payload] = sectionMatch;
            currentSection = section;
            handleLine(result, section, payload);
        } else if (isSubSection) {
            const [, section, payload] = isSubSection;
            currentSection = section;
            handleLine(result, section, payload);
        } else if (continuationMatch && currentSection) {
            handleLine(result, currentSection, continuationMatch[1]);
        }
    }
    return result;
}

function handleLine(result, section, payload) {
    if (!payload) return;
    if (section === 'ENTRY') {
        const m = payload.match(/^(D\d{5})/);
        if (m) result.d_number = m[1];
    } else if (section === 'NAME') {
        for (const n of payload.split(';')) {
            const t = n.trim().replace(/\s*\([^)]+\)\s*$/, '');
            if (t) result.names.push(t);
        }
    } else if (section === 'FORMULA') {
        result.formula = payload.trim();
    } else if (section === 'REMARK') {
        const atcMatch = payload.match(/ATC code:\s*([A-Z0-9 ]+)/);
        if (atcMatch) {
            result.atc_codes.push(...atcMatch[1].trim().split(/\s+/).filter(Boolean));
        }
    } else if (section === 'DBLINKS') {
        // KEGG's DBLINKS PubChem field returns SID (substance ID) not CID — unreliable.
        // We already have authoritative PubChem CID from Sciweon ingestion;
        // skip this field. ChEBI/ChEMBL are reliable for cross-validation.
        const chebiMatch = payload.match(/ChEBI:\s*(\d+)/);
        if (chebiMatch) result.chebi_id = `CHEBI:${chebiMatch[1]}`;
        const chemblMatch = payload.match(/ChEMBL:\s*(CHEMBL\d+)/);
        if (chemblMatch) result.chembl_id = chemblMatch[1];
    } else if (section === 'TARGET') {
        const m = payload.match(/^(\S+)(?:\s*\([^)]+\))?\s*\[HSA:(\d+)\](?:\s*\[KO:(K\d+)\])?/);
        if (m) {
            result.targets.push({
                gene_symbol: m[1],
                ncbi_gene_id: m[2],
                kegg_orthology: m[3] || null,
            });
        }
    } else if (section === 'PATHWAY') {
        const m = payload.match(/(map\d{5}|hsa\d{5})/g);
        if (m) result.pathways.push(...m);
    } else if (section === 'DISEASE') {
        const m = payload.match(/^([^[]+)\[DS:(H\d{5})\]/);
        if (m) {
            result.diseases.push({
                indication: m[1].trim(),
                kegg_disease_id: m[2],
            });
        }
    }
}

export { REQUEST_DELAY_MS };
