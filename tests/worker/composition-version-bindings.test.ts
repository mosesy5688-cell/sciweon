/**
 * Composition integration gate (F-3) - version binding and version-sync tests.
 *
 * These bindings are MONOTONIC RESPONSE-CONTRACT MARKERS, not product SemVer
 * claims. They exist so a cached pre-composition body is distinguishable from
 * a post-composition one at the serving boundary. Bumping them asserts nothing
 * about feature level, stability or API compatibility.
 *
 * SERVER_INFO.version and the x-sciweon-mcp-version response header are TWO
 * DISTINCT BINDINGS that happen to carry the same string. Asserting one does
 * not assert the other, and nothing in the source prevents them diverging --
 * hence the explicit sync test below.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleMcp, SERVER_INFO, PROTOCOL_VERSION } from '../../src/worker/api/mcp';
import type { Env } from '../../src/worker';

function apiSource(file: string): string {
    return readFileSync(
        fileURLToPath(new URL(`../../src/worker/api/${file}`, import.meta.url)),
        'utf-8',
    );
}

function schemaMinorLiterals(file: string): string[] {
    const re = /'x-sciweon-schema-minor':\s*'([^']+)'/g;
    return [...apiSource(file).matchAll(re)].map((m) => m[1]);
}

function rightsFilterLiterals(file: string): string[] {
    const re = /'x-sciweon-rights-filter':\s*'([^']+)'/g;
    return [...apiSource(file).matchAll(re)].map((m) => m[1]);
}

function makeEnv(): Env {
    return {
        ASSETS: { fetch: () => new Response('static') } as Fetcher,
        SCIWEON_R2: undefined,
    } as Env;
}

function fakeCtx(): ExecutionContext {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;
}

function mcpInitialize(): Request {
    return new Request('https://sciweon.com/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
}

// The six frozen F-3 bindings, located by content and not by line number.
const FROZEN_SCHEMA_MINOR: Array<[string, string]> = [
    ['negative-evidence.ts', '1.3'],
    ['repurposing-evidence.ts', '1.1'],
    ['target.ts', '0.6.1'],
    ['xrefs.ts', '1.2'],
];

const FROZEN_MCP_VERSION = '0.6.1';

describe('composition gate F-3: MCP version sync', () => {
    it('SERVER_INFO.version and x-sciweon-mcp-version carry the same string', async () => {
        const res = await handleMcp(mcpInitialize(), makeEnv(), fakeCtx());
        const header = res.headers.get('x-sciweon-mcp-version');
        expect(header).toBeTruthy();
        // The whole point of this test: two independent bindings, one value.
        expect(header).toBe(SERVER_INFO.version);
    });

    it('the serverInfo payload reports the same version as the header', async () => {
        const res = await handleMcp(mcpInitialize(), makeEnv(), fakeCtx());
        const body = await res.json() as { result?: { serverInfo?: { version?: string } } };
        expect(body.result?.serverInfo?.version).toBe(res.headers.get('x-sciweon-mcp-version'));
    });

    it('SERVER_INFO.version is at the frozen F-3 value', () => {
        expect(SERVER_INFO.version).toBe(FROZEN_MCP_VERSION);
    });

    it('the x-sciweon-mcp-version header is at the frozen F-3 value', async () => {
        const res = await handleMcp(mcpInitialize(), makeEnv(), fakeCtx());
        expect(res.headers.get('x-sciweon-mcp-version')).toBe(FROZEN_MCP_VERSION);
    });

    it('PROTOCOL_VERSION is NOT moved by the composition gate', () => {
        // The MCP wire protocol date is a spec identifier, not a Sciweon
        // response-contract binding. F-3 must never touch it.
        expect(PROTOCOL_VERSION).toBe('2025-03-26');
    });
});

describe('composition gate F-3: REST schema-minor bindings', () => {
    it.each(FROZEN_SCHEMA_MINOR)('%s carries exactly one schema-minor binding at %s', (file, want) => {
        const found = schemaMinorLiterals(file);
        expect(found).toHaveLength(1);
        expect(found[0]).toBe(want);
    });

    it('no api surface still carries a pre-composition schema-minor value', () => {
        const stale: Record<string, string> = {
            'negative-evidence.ts': '1.2',
            'repurposing-evidence.ts': '1.0',
            'target.ts': '0.6.0',
            'xrefs.ts': '1.1',
        };
        for (const [file, old] of Object.entries(stale)) {
            expect(schemaMinorLiterals(file)).not.toContain(old);
        }
    });
});

describe('composition gate: lane rights-filter marker survives composition', () => {
    // Verified, not authored, by the composition gate: the rc3a-v2 marker is
    // lane-owned. This test only proves the replay preserved all seven of them.
    const FILES = [
        'compound.ts',
        'negative-evidence.ts',
        'repurposing-evidence.ts',
        'target.ts',
        'xrefs.ts',
    ];

    it('every x-sciweon-rights-filter literal is rc3a-v2', () => {
        const all = FILES.flatMap((f) => rightsFilterLiterals(f));
        expect(all).toHaveLength(7);
        expect(all.every((v) => v === 'rc3a-v2')).toBe(true);
    });

    it('no rc3a-v1 marker remains on any api surface', () => {
        for (const f of FILES) {
            expect(apiSource(f)).not.toContain('rc3a-v1');
        }
    });
});
