/**
 * Sciweon MCP server — JSON-RPC 2.0 over HTTP POST per MCP spec.
 *
 * This module owns the wire envelope (JSONRPC parsing, error translation,
 * CORS headers, method dispatch). Per-tool semantics live in
 * src/worker/lib/mcp-handlers.ts. The tool catalog lives in
 * src/worker/lib/mcp-tools.ts.
 *
 * Methods supported:
 *   initialize          handshake; returns server capabilities + version
 *   tools/list          enumerate Sciweon tools
 *   tools/call          invoke a specific tool with args
 *
 * Tools available (V0.6 cycle 20):
 *   sciweon_search                  fuzzy search over compounds
 *   sciweon_get_negative_evidence   negative signals per compound
 *   sciweon_resolve_entity          exact identifier -> canonical compound
 *   sciweon_get_repurposing_evidence  3-layer fusion verdict per compound
 *   sciweon_get_target_drugs        target (UniProt) -> compounds/trials/neg
 *
 * Error contract: -32600 invalid request / -32601 method not found /
 * -32602 invalid params / -32603 internal / -32000 tool execution error.
 */

import type { Env } from '../../worker';
import { MCP_TOOLS } from '../lib/mcp-tools';
import {
    ToolError,
    handleToolSearch,
    handleToolNegativeEvidence,
    handleToolResolveEntity,
    handleToolRepurposingEvidence,
    handleToolGetTargetDrugs,
} from '../lib/mcp-handlers';

const SERVER_INFO = { name: 'sciweon', version: '0.6.0' };
const PROTOCOL_VERSION = '2025-03-26';

const JSONRPC_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'x-sciweon-mcp-version': '0.6.0',
};

function jsonrpcResult(id: unknown, result: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
        status: 200, headers: JSONRPC_HEADERS,
    });
}

function jsonrpcError(id: unknown, code: number, message: string, data?: unknown): Response {
    const body: { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string; data?: unknown } } = {
        jsonrpc: '2.0', id, error: { code, message },
    };
    if (data !== undefined) body.error.data = data;
    return new Response(JSON.stringify(body), { status: 200, headers: JSONRPC_HEADERS });
}

async function handleInitialize(_params: Record<string, unknown>): Promise<unknown> {
    return {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
    };
}

async function handleToolsList(): Promise<unknown> {
    return { tools: MCP_TOOLS };
}

async function handleToolsCall(params: Record<string, unknown>, env: Env, req: Request): Promise<unknown> {
    const toolName = params?.name;
    const args = (params?.arguments && typeof params.arguments === 'object')
        ? params.arguments as Record<string, unknown> : {};
    if (typeof toolName !== 'string') {
        throw new ToolError(-32602, 'Invalid params: name is required and must be a string');
    }
    switch (toolName) {
        case 'sciweon_search':
            return handleToolSearch(args, env);
        case 'sciweon_get_negative_evidence':
            return handleToolNegativeEvidence(args, env, req);
        case 'sciweon_resolve_entity':
            return handleToolResolveEntity(args, env);
        case 'sciweon_get_repurposing_evidence':
            return handleToolRepurposingEvidence(args, env, req);
        case 'sciweon_get_target_drugs':
            return handleToolGetTargetDrugs(args, env);
        default:
            throw new ToolError(-32601, `Unknown tool: ${toolName}`);
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

export { MCP_TOOLS as TOOLS, SERVER_INFO, PROTOCOL_VERSION };
