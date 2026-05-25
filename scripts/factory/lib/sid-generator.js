/**
 * SID Generator — Phase 1.1a pure-function implementation per V1.0 Phase 0
 * Schema Spec Constitution (SCIWEON_SID_ARCHITECTURE.md V1.0 LOCKED 2026-05-24).
 *
 * This module implements the two SID derivation algorithms locked at V1.0:
 *
 *   SID-S (Structural Derivable ID) — V1.0 §3.1 + §26 + §40 + §44 lineage:
 *     SID-S = sha256("sciweon:<entity_class>:<canonicalization_version>:<canonical_identity_payload>")
 *             truncated to first 32 hex characters (128-bit)
 *
 *   SID-C (Canonical Governed Entity ID) — V1.0 §40 lock:
 *     SID-C = sha256("sciweon:<entity_class>:<systematic_global_counter>")
 *             truncated to first 32 hex characters (128-bit)
 *
 * Both algorithms are deterministic, salt-free, publicly derivable per V1.0
 * §35 (Dual-SID Architecture) + §40 (Distributed-verifiable Counter Lock).
 * Anyone with the canonical anchor + spec_version (for SID-S) or the counter
 * ledger entry (for SID-C) can independently re-derive the SID.
 *
 * Phase 1.1a scope: pure-function generators only. Counter ledger (per V1.0
 * §44 Counter Ingestion Batching) and crosswalk table operations land in
 * Phase 1.1b. Stamping pipeline integration lands in Phase 1.1c.
 *
 * Semantic Weight Isolation (V1.0 Phase 0.5 §49): SID values are
 * continuity anchors, NOT truth values. Callers must never associate
 * factual claims with raw SID values. Truth lives in Layer 3 SAL
 * Assertion records.
 */

import crypto from 'crypto';

export const SID_LENGTH = 32;       // 128-bit hex per V0.5 §3.1 + V0.7 §35
export const NAMESPACE = 'sciweon'; // V0.3 strategic-fork B open derivability
export const SPEC_VERSION = '1.0';  // Sciweon SID Constitution version

/**
 * Generate the Structural Derivable SID (SID-S) for an atomic entity.
 *
 * @param {string} entityClass — one of the V0.5 §26 entity class taxonomy
 *   values (small_molecule, biologic, adc, peptide, mixture, formulation,
 *   nanomaterial, polymer, partially_defined_substance,
 *   manufacturing_dependent_therapeutic, bioactivity, trial, paper,
 *   target, disease, sal_assertion, negevidence)
 * @param {string} canonicalIdentityPayload — per-entity-class canonical
 *   anchor string per V0.5 §26 table (e.g. for small_molecule:
 *   `inchikey:BSYNRYMUTXBXSQ-UHFFFAOYSA-N`)
 * @param {string} canonicalizationVersion — versioned canonicalization
 *   rule identifier per V0.5 §25 (e.g. `compound.inchikey.v1.0`)
 * @returns {string} 32-char hex SID-S
 *
 * Throws if any argument is missing or non-string (entity-ID
 * deterministic-construction guarantee per V0.7 §22 Permanence Doctrine
 * + V0.5 §3.1 invariants).
 */
export function generateSID_S(entityClass, canonicalIdentityPayload, canonicalizationVersion) {
    if (typeof entityClass !== 'string' || entityClass.length === 0) {
        throw new Error('[SID-S] entityClass must be non-empty string');
    }
    if (typeof canonicalIdentityPayload !== 'string' || canonicalIdentityPayload.length === 0) {
        throw new Error('[SID-S] canonicalIdentityPayload must be non-empty string');
    }
    if (typeof canonicalizationVersion !== 'string' || canonicalizationVersion.length === 0) {
        throw new Error('[SID-S] canonicalizationVersion must be non-empty string');
    }
    const canonicalString = `${NAMESPACE}:${entityClass}:${canonicalizationVersion}:${canonicalIdentityPayload}`;
    return crypto.createHash('sha256').update(canonicalString).digest('hex').substring(0, SID_LENGTH);
}

/**
 * Generate the Canonical Governed Entity SID (SID-C) for an issued entity.
 *
 * @param {string} entityClass — V0.5 §26 entity class
 * @param {number|bigint} systematicGlobalCounter — monotonic integer from
 *   the Counter Ledger per V1.0 §40 + §44 Counter Ingestion Batching
 * @returns {string} 32-char hex SID-C
 *
 * Throws if any argument is missing, wrong type, or counter is not a
 * non-negative integer. Counter ledger management (atomic increment,
 * batch reservation, archival) is the caller's responsibility per V1.0
 * §44; this function is the pure derivation step.
 */
export function generateSID_C(entityClass, systematicGlobalCounter) {
    if (typeof entityClass !== 'string' || entityClass.length === 0) {
        throw new Error('[SID-C] entityClass must be non-empty string');
    }
    if (typeof systematicGlobalCounter !== 'number' && typeof systematicGlobalCounter !== 'bigint') {
        throw new Error('[SID-C] systematicGlobalCounter must be number or bigint');
    }
    if (typeof systematicGlobalCounter === 'number') {
        if (!Number.isInteger(systematicGlobalCounter) || systematicGlobalCounter < 0) {
            throw new Error('[SID-C] systematicGlobalCounter must be non-negative integer');
        }
    } else if (systematicGlobalCounter < 0n) {
        throw new Error('[SID-C] systematicGlobalCounter must be non-negative bigint');
    }
    const canonicalString = `${NAMESPACE}:${entityClass}:${systematicGlobalCounter}`;
    return crypto.createHash('sha256').update(canonicalString).digest('hex').substring(0, SID_LENGTH);
}

/**
 * Build the canonical_identity_payload string for a small_molecule
 * entity from its InChIKey. This is the V0.5 §26 + V1.0 §3.3 anchor
 * convention for the small_molecule class. Throws on missing or
 * non-string InChIKey.
 *
 * Per V1.0 §27 Anti-Over-Collapsing Doctrine: compounds without
 * InChIKey route to the partially_defined_substance class, not
 * small_molecule. Caller filters before calling this helper.
 */
export function smallMoleculeCanonicalAnchor(inchiKey) {
    if (typeof inchiKey !== 'string' || inchiKey.length === 0) {
        throw new Error('[SID] InChIKey required for small_molecule anchor');
    }
    return `inchikey:${inchiKey}`;
}

/**
 * Default canonicalization version string for the small_molecule entity
 * class at Phase 1 lock. Future ontology revisions (e.g. InChI standard
 * upgrade) increment this version per V0.5 §25 Canonicalization
 * Versioning Doctrine; old SIDs persist forever per V0.7 §22 Permanence.
 */
export const SMALL_MOLECULE_CANONICALIZATION_VERSION = 'compound.inchikey.v1.0';
