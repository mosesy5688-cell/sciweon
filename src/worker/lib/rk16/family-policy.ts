/**
 * RK-16A1 — generic family-policy INTERFACES (PURE MECHANISM, NO concrete family).
 *
 * The substrate shape for "how a family projects its canonical record into a
 * filterable projection row, and how it partitions its sublists." A1 defines
 * ONLY the generic interfaces — it hardcodes NO family. In particular it makes
 * NO is_active / activity_type / verdict / namespace decisions: those are C-time
 * (per-family-registration) business choices, deliberately OUT of the substrate.
 *
 * THE contract rule encoded here (see ProjectionRow): a projection row MUST
 * carry canonical_id + canonical_content_hash + projection_schema_version + a
 * record_locator, and MUST be re-derivable by calling project(canonical, policy)
 * on the canonical record — projection is a pure, reproducible function of the
 * canonical bytes + the policy, never hand-edited.
 */

import type { PostingDirectoryRef, PostingPageRef, RecordLocator } from './refs';

/**
 * The minimal substrate fields EVERY projection row carries, regardless of
 * family. A concrete family's ProjectionRow extends this with its own filterable
 * columns (those columns are family business policy, NOT defined in A1).
 */
export interface ProjectionRowBase {
    /** Identity of the canonical record this row projects. */
    readonly canonical_id: string;
    /** Integrity hash of the canonical record (binds row to canonical bytes). */
    readonly canonical_content_hash: string;
    /** Version of the projection function/schema that produced this row. */
    readonly projection_schema_version: string;
    /** How to reach the canonical record from this row. */
    readonly record_locator: RecordLocator;
}

/**
 * A pure, reproducible projection from a family's canonical record to its
 * projection row, parameterized by an opaque per-family `Policy`. The same
 * (canonical, policy) MUST always yield the same row (re-derivability).
 *
 * `Canonical` and `ProjectionRow` are family-specific; `ProjectionRow` must
 * extend ProjectionRowBase. A1 supplies NO implementation.
 */
export interface FamilyPolicy<
    Canonical,
    ProjectionRow extends ProjectionRowBase,
    Policy = unknown,
> {
    readonly family_id: string;
    readonly projection_schema_version: string;
    project(canonical: Canonical, policy: Policy): ProjectionRow;
}

/**
 * A partition primitive: maps a partition NAME to its posting sublist, which is
 * EITHER a single directory ref (large partition) OR an ordered list of page
 * refs (small partition). The partition NAMES themselves are family business
 * policy (e.g. a family MAY partition by some attribute) and are NOT enumerated
 * in the substrate — A1 only models the name -> sublist mapping shape.
 */
export interface PartitionedSublist {
    readonly partition_names: readonly string[];
    get(partition_name: string): PostingDirectoryRef | readonly PostingPageRef[] | undefined;
}
