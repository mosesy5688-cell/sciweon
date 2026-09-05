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
 *   sciweon_get_repurposing_evidence  3-layer evidence bundle per compound (no verdict)
 *   sciweon_get_target_drugs        target (UniProt) -> compounds/trials/neg
 *
 * Error contract: -32600 invalid request / -32601 method not found /
 * -32602 invalid params / -32603 internal / -32000 tool execution error.
 *
 * Infrastructure-failure carriers travel in `error.data` as
 * {failure_class, retryable}; the message carries prose only. Invalid-params
 * (-32602) is client input and deliberately carries NO carriers.
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
import { SnapshotContractError } from '../lib/snapshot-context';
import { classifyThrown, failureData } from '../lib/failure-contract';

const SERVER_INFO = { name: 'sciweon', version: '0.6.1' };
const PROTOCOL_VERSION = '2025-03-26';

const JSONRPC_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'x-sciweon-mcp-version': '0.6.1',
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
        // Observer census: every tool that rethrows lands here, so this typed
        // branch is what makes ONE fault carry ONE class across all five tool
        // aliases. 6e freezes the code this path already returned (-32603).
        if (err instanceof SnapshotContractError) {
            return jsonrpcError(
                body.id, -32603,
                'The snapshot pointer failed contract validation. Nothing is served from an unrecognized contract.',
                failureData('snapshot_contract'),
            );
        }
        // Residual, only after every typed error in the union has been tested.
        // The underlying message is NEVER echoed - it can carry R2 object keys.
        return jsonrpcError(body.id, -32603, 'Internal server error', failureData(classifyThrown(err)));
    }
}

export { MCP_TOOLS as TOOLS, SERVER_INFO, PROTOCOL_VERSION };
