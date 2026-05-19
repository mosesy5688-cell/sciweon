/**
 * V0.5.8 — MCP tools registry.
 *
 * Extracted from src/worker/api/mcp.ts to keep that file under the 250-line
 * CES cap as new tools are added. Each tool entry follows the MCP spec
 * (https://modelcontextprotocol.io) tools/list shape.
 *
 * Current tools:
 *   sciweon_search                — fuzzy substring + scored ranking
 *   sciweon_get_negative_evidence — Layer-3 moat surface with event_type filter
 *   sciweon_resolve_entity        — exact-identifier -> canonical compound (V0.5.8)
 */

import { EVIDENCE_TYPES } from './event-type-taxonomy';

export const MCP_TOOLS = [
    {
        name: 'sciweon_search',
        description: 'Search the Sciweon compound database by name, synonym, molecular formula, ChEMBL ID, or PubChem CID. Returns a ranked list of matching compounds with key metadata. Use this to identify the correct compound (and its CID) before calling sciweon_get_negative_evidence. Results include pubchem_cid, chembl_id, drug_status.max_phase, and confidence_overall. Matching is case-insensitive substring; exact matches score highest. For exact identifier lookup (CHEMBL25, InChIKey, DrugBank, etc.) prefer sciweon_resolve_entity.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search term — compound name, synonym, molecular formula (e.g. "C9H8O4"), ChEMBL ID (e.g. "CHEMBL25"), or PubChem CID (e.g. "2244"). Examples: "aspirin", "metformin", "ibuprofen".',
                },
                limit: {
                    type: 'integer',
                    description: 'Maximum number of results to return (1-25, default 10).',
                    default: 10,
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'sciweon_get_negative_evidence',
        description: 'Get the negative evidence profile for a drug compound by PubChem CID. Returns 0+ signals across the canonical event_type taxonomy (see event_types enum), grouped by severity (critical / major / minor / unknown), with provenance and confidence per signal. Pass event_types to narrow the response server-side. The result includes a synthesized verdict + agent_recommendation; agents may ignore the synthesis and read signals[] directly. Read-only.',
        inputSchema: {
            type: 'object',
            properties: {
                cid: {
                    type: 'string',
                    description: 'PubChem CID. Accepts canonical "sciweon::compound::CID:2244", short "CID:2244", or bare "2244". Examples: 2244 aspirin, 4091 metformin, 3672 ibuprofen.',
                },
                event_types: {
                    type: 'array',
                    description: 'Optional filter — only return signals whose evidence_type is in this list. Omit or pass [] to retrieve all types.',
                    items: { type: 'string', enum: [...EVIDENCE_TYPES] },
                    maxItems: 7,
                },
            },
            required: ['cid'],
        },
    },
    {
        name: 'sciweon_resolve_entity',
        description: 'Resolve a single external identifier to its canonical Sciweon compound. Returns the canonical Sciweon ID + matched_on (which identifier kind hit) or {resolved: false} when no exact match exists. Use this when the agent has a precise identifier (CHEMBL25, InChIKey, DrugBank, ChEBI, KEGG, UNII, RxCUI, or PubChem CID) and wants the canonical entity — not a fuzzy ranked list. For substring discovery use sciweon_search instead. Read-only.',
        inputSchema: {
            type: 'object',
            properties: {
                identifier: {
                    type: 'string',
                    description: 'Any of: PubChem CID (bare "2244" or "CID:2244"), ChEMBL ID ("CHEMBL\\d+"), 27-char InChIKey, "UNII:XXXXXXXXXX", "DB#####", "CHEBI:n", "KEGG:Dn" or bare "Dn", "RXCUI:n".',
                },
            },
            required: ['identifier'],
        },
    },
    {
        name: 'sciweon_get_repurposing_evidence',
        description: 'Get the complete drug-repurposing assessment for a compound by PubChem CID. Fuses three evidence layers in one call: positive (progressed trials + active bioactivities), negative (NegEvidence v2 typed taxonomy signals), and retracted (papers with is_retracted=true). Returns layer summaries with counts + examples, plus a verdict (strong / mixed / weak / none) and a human-readable recommendation. Use this when an agent needs a single repurposing decision rather than stitching 4 endpoints client-side. Read-only.',
        inputSchema: {
            type: 'object',
            properties: {
                cid: {
                    type: 'string',
                    description: 'PubChem CID. Accepts canonical "sciweon::compound::CID:2244", short "CID:2244", or bare "2244". Examples: 2244 aspirin, 4091 metformin.',
                },
            },
            required: ['cid'],
        },
    },
];
