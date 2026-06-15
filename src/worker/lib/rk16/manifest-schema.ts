/**
 * RK-16A1 — family manifest schema (PURE SHAPES + runtime validators).
 *
 * TS types + non-throwing validators ({ ok, errors[] }) for the substrate
 * family-manifest contract. A1 only DEFINES the shapes and validates them; it
 * registers NO concrete family, derives NO keys, and is NOT wired to the worker.
 *
 * `crypto_mode` is locked to the literal 'passthrough_v1' in A1 — there is NO
 * real encryption and NO HMAC in this substrate; a real crypto mode is a
 * separate, later cutover and is intentionally out of scope here.
 */

export const CRYPTO_MODE_PASSTHROUGH = 'passthrough_v1' as const;
export type CryptoMode = typeof CRYPTO_MODE_PASSTHROUGH;

/** Page-sizing policy: the producer's targets/ceilings for one page. */
export interface PageSizePolicy {
    readonly record_count_target: number;
    readonly compressed_bytes_ceiling: number;
    readonly parsed_heap_ceiling: number;
}

/** The full producer/codec tuple that makes a page's bytes reproducible. */
export interface ProducerTuple {
    readonly codec_name: string;
    readonly codec_impl: string;
    readonly codec_version: string;
    readonly codec_level: number;
    readonly dictionary_hash: string | null;
    readonly crypto_mode: CryptoMode;
    readonly record_serialization: string;
    readonly serialization_version: string;
    readonly sort_order: string;
}

/** A single family's published manifest. */
export interface FamilyManifest {
    readonly family_id: string;
    readonly bucket: string;
    readonly object_prefix: string;
    readonly snapshot_id: string;
    readonly layout_version: string;
    readonly schema_version: number;
    readonly shard_hashes: readonly string[];
    readonly record_total: number;
    readonly page_total: number;
    readonly index_key_total: number;
    readonly page_size_policy: PageSizePolicy;
    readonly producer_tuple: ProducerTuple;
    /** Optional attestation that referential integrity was checked at build. */
    readonly referential_integrity_attestation_hash?: string;
}

export interface ValidationResult {
    readonly ok: boolean;
    readonly errors: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function reqStr(o: Record<string, unknown>, k: string, e: string[]): void {
    if (typeof o[k] !== 'string' || (o[k] as string).length === 0) {
        e.push(`${k} must be a non-empty string`);
    }
}
function reqInt(o: Record<string, unknown>, k: string, e: string[]): void {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        e.push(`${k} must be a non-negative integer`);
    }
}

export function validatePageSizePolicy(v: unknown): ValidationResult {
    const e: string[] = [];
    if (!isObj(v)) return { ok: false, errors: ['page_size_policy must be an object'] };
    reqInt(v, 'record_count_target', e);
    reqInt(v, 'compressed_bytes_ceiling', e);
    reqInt(v, 'parsed_heap_ceiling', e);
    return { ok: e.length === 0, errors: e };
}

export function validateProducerTuple(v: unknown): ValidationResult {
    const e: string[] = [];
    if (!isObj(v)) return { ok: false, errors: ['producer_tuple must be an object'] };
    reqStr(v, 'codec_name', e);
    reqStr(v, 'codec_impl', e);
    reqStr(v, 'codec_version', e);
    reqInt(v, 'codec_level', e);
    if (!(v.dictionary_hash === null || typeof v.dictionary_hash === 'string')) {
        e.push('dictionary_hash must be a string or null');
    }
    if (v.crypto_mode !== CRYPTO_MODE_PASSTHROUGH) {
        e.push(`crypto_mode must be the literal "${CRYPTO_MODE_PASSTHROUGH}"`);
    }
    reqStr(v, 'record_serialization', e);
    reqStr(v, 'serialization_version', e);
    reqStr(v, 'sort_order', e);
    return { ok: e.length === 0, errors: e };
}

export function validateFamilyManifest(v: unknown): ValidationResult {
    const e: string[] = [];
    if (!isObj(v)) return { ok: false, errors: ['manifest must be an object'] };
    reqStr(v, 'family_id', e);
    reqStr(v, 'bucket', e);
    reqStr(v, 'object_prefix', e);
    reqStr(v, 'snapshot_id', e);
    reqStr(v, 'layout_version', e);
    reqInt(v, 'schema_version', e);
    if (!Array.isArray(v.shard_hashes) || !v.shard_hashes.every(h => typeof h === 'string')) {
        e.push('shard_hashes must be an array of strings');
    }
    reqInt(v, 'record_total', e);
    reqInt(v, 'page_total', e);
    reqInt(v, 'index_key_total', e);
    const psp = validatePageSizePolicy(v.page_size_policy);
    if (!psp.ok) e.push(...psp.errors.map(m => `page_size_policy.${m}`));
    const pt = validateProducerTuple(v.producer_tuple);
    if (!pt.ok) e.push(...pt.errors.map(m => `producer_tuple.${m}`));
    if (v.referential_integrity_attestation_hash !== undefined
        && typeof v.referential_integrity_attestation_hash !== 'string') {
        e.push('referential_integrity_attestation_hash, when present, must be a string');
    }
    return { ok: e.length === 0, errors: e };
}
