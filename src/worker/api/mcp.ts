/**
 * Sciweon MCP server — V0.5.4 (Sprint 1b.2).
 *
 * JSON-RPC 2.0 protocol over HTTP POST per MCP spec
 * (https://modelcontextprotocol.io). Sciweon's Agent surface.
 *
 * Methods supported:
 *   initialize          — handshake; returns server capabilities + version
 *   tools/list          — enumerate Sciweon tools
 *   tools/call          — invoke a specific tool with args
 *
 * Tools available (V0.5.4):
 *   sciweon_search              — substring search over enriched compound snapshot
 *   sciweon_get_negative_evidence — Layer 3 moat surface. Returns 0-N
 *     negative signals for a compound (CID), severity-grouped + verdict.
 *
 * 1b.3 will add:
 *   sciweon_entity    — generic entity fetch (requires /api/v1/entity/:id)
 *
 * Error contract:
 *   -32600 Invalid Request
 *   -32601 Method not found
 *   -32602 Invalid params
 *   -32603 Internal error
 *   -32000 Tool execution error (custom)
 */

import type { Env } from '../../worker';
import { parseCompoundId } from '../lib/id-parse';
import { loadNegEvidenceForCompound } from '../lib/neg-evidence-loader';
import { searchCompounds } from '../lib/compound-search';
import { EVIDENCE_TYPES, isKnownEvidenceType, type EvidenceType } from '../lib/event-type-taxonomy';

const SERVER_INFO = {
    name: 'sciweon',
    version: '0.5.4',
};

const PROTOCOL_VERSION = '2025-03-26';

const TOOLS = [
    {
        name: 'sciweon_search',
        description: 'Search the Sciweon compound database by name, synonym, molecular formula, ChEMBL ID, or PubChem CID. Returns a ranked list of matching compounds with key metadata. Use this to identify the correct compound (and its CID) before calling sciweon_get_negative_evidence. Results include pubchem_cid, chembl_id, drug_status.max_phase, and confidence_overall. Matching is case-insensitive substring; exact matches score highest.',
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
];

const JSONRPC_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'x-sciweon-mcp-version': '0.5.4',
};

function jsonrpcResult(id: unknown, result: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
        status: 200,
        headers: JSONRPC_HEADERS,
    });
}

function jsonrpcError(id: unknown, code: number, message: string, data?: unknown): Response {
    const body: { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string; data?: unknown } } = {
        jsonrpc: '2.0',
        id,
        error: { code, message },
    };
    if (data !== undefined) body.error.data = data;
    return new Response(JSON.stringify(body), { status: 200, headers: JSONRPC_HEADERS });
}

async function handleInitialize(_params: Record<string, unknown>): Promise<unknown> {
    return {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: {
            tools: { listChanged: false },
        },
    };
}

async function handleToolsList(): Promise<unknown> {
    return { tools: TOOLS };
}

async function handleToolSearch(args: Record<string, unknown>, env: Env): Promise<unknown> {
    const q = args?.query;
    if (typeof q !== 'string' || q.trim().length === 0) {
        throw new ToolError(-32602, 'Invalid params: query is required and must be a non-empty string');
    }
    if (q.trim().length > 200) {
        throw new ToolError(-32602, 'Invalid params: query must be 200 characters or fewer');
    }
    const rawLimit = typeof args.limit === 'number' ? args.limit : 10;
    const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 25);
    if (!env.SCIWEON_R2) {
        throw new ToolError(-32603, 'Data layer not configured (R2 binding missing)');
    }
    const results = await searchCompounds(env.SCIWEON_R2, q.trim().toLowerCase(), limit);
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({ query: q.trim(), count: results.length, results }, null, 2),
        }],
    };
}

async function handleToolNegativeEvidence(args: Record<string, unknown>, env: Env, req: Request): Promise<unknown> {
    const cidArg = args?.cid;
    if (typeof cidArg !== 'string' || cidArg.length === 0) {
        throw new ToolError(-32602, 'Invalid params: cid is required and must be a string');
    }
    const parsed = parseCompoundId(cidArg);
    if ('error' in parsed) {
        throw new ToolError(-32602, `Invalid compound ID: ${parsed.error}`);
    }
    if (!env.SCIWEON_R2) {
        throw new ToolError(-32603, 'Data layer not configured (R2 binding missing)');
    }
    // V0.5.8 Phase 1: optional event_types filter. Reject unknown tokens at the
    // MCP boundary so Agent gets a clear error rather than silent drop.
    let eventTypeFilter: Set<EvidenceType> | null = null;
    if (Array.isArray(args.event_types) && args.event_types.length > 0) {
        eventTypeFilter = new Set<EvidenceType>();
        for (const t of args.event_types) {
            if (!isKnownEvidenceType(t)) throw new ToolError(-32602, `Invalid event_types token: ${JSON.stringify(t)} — must be one of ${EVIDENCE_TYPES.join(', ')}`);
            eventTypeFilter.add(t);
        }
    }
    const baseUrl = (() => {
        try { return new URL(req.url).origin; } catch { return 'https://sciweon.com'; }
    })();
    const response = await loadNegEvidenceForCompound(env.SCIWEON_R2, parsed.canonical, baseUrl, eventTypeFilter);
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(response, null, 2),
            },
        ],
    };
}

async function handleToolsCall(params: Record<string, unknown>, env: Env, req: Request): Promise<unknown> {
    const toolName = params?.name;
    const args = (params?.arguments && typeof params.arguments === 'object') ? params.arguments as Record<string, unknown> : {};
    if (typeof toolName !== 'string') {
        throw new ToolError(-32602, 'Invalid params: name is required and must be a string');
    }
    switch (toolName) {
        case 'sciweon_search':
            return handleToolSearch(args, env);
        case 'sciweon_get_negative_evidence':
            return handleToolNegativeEvidence(args, env, req);
        default:
            throw new ToolError(-32601, `Unknown tool: ${toolName}`);
    }
}

class ToolError extends Error {
    constructor(public code: number, message: string, public data?: unknown) {
        super(message);
    }
}

export async function handleMcp(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: JSONRPC_HEADERS });
    }
    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
    }

    let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
        body = await req.json() as typeof body;
    } catch {
        return jsonrpcError(null, -32700, 'Parse error: invalid JSON body');
    }

    if (body.jsonrpc !== '2.0') {
        return jsonrpcError(body.id ?? null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    }
    if (typeof body.method !== 'string') {
        return jsonrpcError(body.id ?? null, -32600, 'Invalid Request: method must be a string');
    }

    const params = body.params || {};

    try {
        switch (body.method) {
            case 'initialize':
                return jsonrpcResult(body.id, await handleInitialize(params));
            case 'tools/list':
                return jsonrpcResult(body.id, await handleToolsList());
            case 'tools/call':
                return jsonrpcResult(body.id, await handleToolsCall(params, env, req));
            case 'notifications/initialized':
                // Notifications return no result per JSON-RPC 2.0; honor with 204.
                return new Response(null, { status: 204, headers: JSONRPC_HEADERS });
            default:
                return jsonrpcError(body.id, -32601, `Method not found: ${body.method}`);
        }
    } catch (err) {
        if (err instanceof ToolError) {
            return jsonrpcError(body.id, err.code, err.message, err.data);
        }
        const message = err instanceof Error ? err.message : String(err);
        const safe = message.length > 200 ? 'Internal server error' : message;
        return jsonrpcError(body.id, -32603, safe);
    }
}

export { TOOLS, SERVER_INFO, PROTOCOL_VERSION };
