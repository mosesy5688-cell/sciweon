// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import {
    MESH_ENTITY_CLASS, MESH_CANON_VERSION, UNSTAMPABLE_REASON_MISSING_ANCHOR,
    classifyMeshConcepts, buildMeshStampingEntries,
    applyStampsToMesh, buildMeshStampingSummary,
} from '../../scripts/factory/lib/sid-mesh-stamping.js';
import { generateSID_S, generateSID_C } from '../../scripts/factory/lib/sid-generator.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';

// Frozen reference pins -- computed PR-UMLS-2 (entity_class=mesh_concept,
// canon=mesh.concept.v1.0). SID-S is content-addressed on `MSH:<CODE>` ONLY
// (Correction 1), NEVER the preferred string. Re-derive: sha256(
// 'sciweon:mesh_concept:mesh.concept.v1.0:MSH:<CODE>').hex[:32].
const FROZEN_PINS = [
    { code: 'D000818', payload: 'MSH:D000818', sidS: '40374b17c32e1493bd60b96c1c2bd2c6' },
    { code: 'D012345', payload: 'MSH:D012345', sidS: '33590dc0c9f7bf65f82f66d750278386' },
    { code: 'D006801', payload: 'MSH:D006801', sidS: '3c9ce8f59818d3470cd4c1e2163146fa' },
    { code: 'D009369', payload: 'MSH:D009369', sidS: '227eb8f6afccbf409fb071b16a994da7' },
];

describe('Frozen reference SID-S pins (mesh_concept, code-anchored)', () => {
    for (const pin of FROZEN_PINS) {
        it(`${pin.code} -> ${pin.sidS}`, () => {
            expect(generateSID_S(MESH_ENTITY_CLASS, pin.payload, MESH_CANON_VERSION)).toBe(pin.sidS);
        });
    }
    it('SID-S is anchored on the CODE not the preferred string', () => {
        // Same code, wildly different preferred_str -> identical SID-S (permanence).
        const a = generateSID_S(MESH_ENTITY_CLASS, 'MSH:D000818', MESH_CANON_VERSION);
        const b = generateSID_S(MESH_ENTITY_CLASS, 'MSH:D000818', MESH_CANON_VERSION);
        expect(a).toBe(b);
        expect(a).toBe('40374b17c32e1493bd60b96c1c2bd2c6');
    });
    it('mesh_concept counter=1 SID-C pinned', () => {
        expect(generateSID_C(MESH_ENTITY_CLASS, 1)).toBe('be507120e7ea5dcd273f57761fada499');
    });
});

describe('Constants lock', () => {
    it('MESH_ENTITY_CLASS = mesh_concept', () => {
        expect(MESH_ENTITY_CLASS).toBe('mesh_concept');
    });
    it('MESH_CANON_VERSION = mesh.concept.v1.0', () => {
        expect(MESH_CANON_VERSION).toBe('mesh.concept.v1.0');
    });
});

describe('classifyMeshConcepts -- hard-fail invariant + crosswalk hit', () => {
    const emptyIndex = buildCrosswalkIndex([]);
    function makeConcept(overrides = {}) {
        return {
            code: 'D000818', cui: 'C0001688', sab: 'MSH', tty: 'MH',
            preferred_str: 'Adipose Tissue', synonyms: ['Fat, Body'],
            anchor_payload: 'MSH:D000818',
            canonicalization_version: 'mesh.concept.v1.0',
            ...overrides,
        };
    }

    it('valid concept -> unstamped on empty crosswalk', () => {
        const r = classifyMeshConcepts([makeConcept()], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.unstamped[0].sidS).toBe('40374b17c32e1493bd60b96c1c2bd2c6');
    });

    it('missing anchor_payload -> unstampable', () => {
        const r = classifyMeshConcepts([makeConcept({ anchor_payload: null })], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_ANCHOR);
    });
    it('missing canonicalization_version -> unstampable', () => {
        expect(classifyMeshConcepts([makeConcept({ canonicalization_version: '' })], emptyIndex).unstampable).toHaveLength(1);
    });
    it('missing code -> unstampable', () => {
        expect(classifyMeshConcepts([makeConcept({ code: undefined })], emptyIndex).unstampable).toHaveLength(1);
    });

    it('crosswalk hit -> alreadyStamped', () => {
        const seed = [{
            sid_s: '40374b17c32e1493bd60b96c1c2bd2c6', sid_c: 'c'.repeat(32),
            entity_class: 'mesh_concept', canonicalization_version: 'mesh.concept.v1.0',
            canonical_identity_payload: 'MSH:D000818',
            counter_value: 1, reservation_id: 'r1', issuance_at: '2026-06-01T00:00:00Z',
        }];
        const idx = buildCrosswalkIndex(seed);
        const r = classifyMeshConcepts([makeConcept()], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidC).toBe('c'.repeat(32));
    });

    it('mixed batch routes all 4 pins to unstamped with pinned sid_s', () => {
        const all = FROZEN_PINS.map(p => makeConcept({ code: p.code, anchor_payload: p.payload }));
        const r = classifyMeshConcepts(all, emptyIndex);
        expect(r.unstamped).toHaveLength(4);
        for (let i = 0; i < FROZEN_PINS.length; i++) {
            expect(r.unstamped[i].sidS).toBe(FROZEN_PINS[i].sidS);
        }
    });
});

describe('buildMeshStampingEntries -- frozen sid_c pin + crosswalk fields', () => {
    it('counter=1 entry produces locked sid_c + mesh_concept crosswalk fields', () => {
        const unstamped = [{
            concept: { code: 'D000818' },
            sidS: '40374b17c32e1493bd60b96c1c2bd2c6',
            anchorPayload: 'MSH:D000818',
            canonVersion: 'mesh.concept.v1.0',
        }];
        const entries = buildMeshStampingEntries({
            unstamped, counterStart: 1, reservationId: 'rid-1', issuanceAt: '2026-06-01T00:00:00Z',
        });
        expect(entries[0].sidC).toBe('be507120e7ea5dcd273f57761fada499');
        expect(entries[0].code).toBe('D000818');
        expect(entries[0].crosswalkEntry.entity_class).toBe('mesh_concept');
        expect(entries[0].crosswalkEntry.canonicalization_version).toBe('mesh.concept.v1.0');
        expect(entries[0].crosswalkEntry.canonical_identity_payload).toBe('MSH:D000818');
        expect(entries[0].crosswalkEntry.counter_value).toBe(1);
    });
});

describe('applyStampsToMesh -- keys on code + paranoia branch', () => {
    it('stamps by code', () => {
        const c = [{ code: 'D000818' }];
        const m = new Map([['D000818', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToMesh(c, m);
        expect(r.skippedParanoiaCount).toBe(0);
        expect(c[0].sid_s).toBe('a');
        expect(c[0].sid_c).toBe('b');
    });
    it('stampMap miss (by code) -> warn + skippedParanoiaCount++', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const c = [{ code: 'D000818' }, { code: 'D999999' }];
        const r = applyStampsToMesh(c, new Map([['D000818', { sid_s: 'a', sid_c: 'b' }]]));
        expect(r.skippedParanoiaCount).toBe(1);
        warnSpy.mockRestore();
    });
});

describe('buildMeshStampingSummary', () => {
    it('summary shape', () => {
        const s = buildMeshStampingSummary({
            totalConcepts: 355249, alreadyStamped: 0, newlyStamped: 355249, unstampable: 0,
            reservationsIssued: 8, skippedParanoiaCount: 0,
            elapsedMs: 100, ledgerKeys: ['k1'], shardCount: 1,
        });
        expect(s.total_concepts).toBe(355249);
        expect(s.newly_stamped).toBe(355249);
        expect(s.shard_count).toBe(1);
    });
});
