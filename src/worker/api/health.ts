/**
 * GET /api/v1/_health -- P0.2 deployment identity.
 *
 * Production must be able to name the commit it is running. The Cloudflare
 * `version_metadata` binding (declared in wrangler.toml as [version_metadata]
 * and bound as CF_VERSION_METADATA) carries `id`, `tag` and `timestamp`.
 * Cloudflare does NOT guarantee that `tag` is a Git SHA, so every value is
 * validated strictly and nothing is normalised, sliced or repaired on the way
 * out. An uppercase 40-hex tag is `unavailable`, not "nearly right".
 *
 * Response contract, structural on EVERY path (available and all five
 * unavailable reasons alike): HTTP 200, `Cache-Control: no-store`, and exactly
 * the eight keys built in `healthResponse`.
 *
 * What the fields are, said plainly:
 *   git_sha            `binding.tag` VERBATIM when it validates -- not a copy,
 *                      slice or re-render. It is the commit label supplied by
 *                      the deploying CI run (`wrangler deploy --tag <sha>`),
 *                      NOT independently derived from the running bundle.
 *   worker_version_id  platform-generated; the only field here that identifies
 *                      the deployed bundle itself.
 *   r2_binding         `!!env.SCIWEON_R2`, never hard-coded. `false` means the
 *                      binding is not observable; it does NOT assert that the
 *                      binding is absent.
 *   status             always `"ok"`; it never flips on identity loss. Lost
 *                      deployment identity is reported in the identity fields,
 *                      not by claiming the worker is unhealthy.
 */

import type { Env } from '../../worker';

/**
 * Open, `unknown`-valued view of the version_metadata binding -- the "at least
 * contains" contract. Deliberately NOT the ambient `WorkerVersionMetadata`:
 * that type declares all three fields non-optional, a claim the platform does
 * not make. This field describes an untrusted runtime object and must not be
 * typed as a guarantee.
 */
export interface VersionMetadataView {
    id?: unknown;
    tag?: unknown;
    timestamp?: unknown;
}

/** Five reason codes. The sixth value of the field is `null` (available). */
export type DeploymentIdentityReason =
    | 'binding_read_failed'
    | 'binding_absent'
    | 'tag_absent'
    | 'tag_empty'
    | 'tag_not_40_lowercase_hex';

export interface DeploymentIdentity {
    deployment_identity_status: 'available' | 'unavailable';
    git_sha: string | null;
    worker_version_id: string | null;
    worker_version_timestamp: string | null;
    deployment_identity_reason: DeploymentIdentityReason | null;
}

/**
 * Flags MUST be empty. `i` accepts uppercase and defeats the ruling; `m`
 * accepts "<40 hex>\nEVIL"; `g` makes `.test()` alternate across calls. The
 * flag-free literal also rejects a trailing newline.
 */
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The `id` / `timestamp` bound: a string of length 1..128 containing only
 * printable ASCII (0x20-0x7E). Reject or pass through whole -- no truncation,
 * no escaping, no sanitising.
 */
const BOUNDED_STRING_RE = /^[\x20-\x7e]{1,128}$/;

function boundedString(value: unknown): string | null {
    return typeof value === 'string' && BOUNDED_STRING_RE.test(value) ? value : null;
}

function makeIdentity(
    reason: DeploymentIdentityReason | null,
    gitSha: string | null,
    workerVersionId: string | null,
    workerVersionTimestamp: string | null,
): DeploymentIdentity {
    return {
        deployment_identity_status: reason === null ? 'available' : 'unavailable',
        git_sha: gitSha,
        worker_version_id: workerVersionId,
        worker_version_timestamp: workerVersionTimestamp,
        deployment_identity_reason: reason,
    };
}

/**
 * Stand-in for a version_metadata binding that could not be read off `env` at
 * all. Its `tag` getter throws, so `resolveDeploymentIdentity` produces its own
 * `binding_read_failed` and stays the sole owner of that outcome. Reporting
 * `binding_absent` there would assert the platform omitted a binding we merely
 * failed to observe.
 */
const UNREADABLE_BINDING: VersionMetadataView = {
    get tag(): never {
        throw new Error();
    },
};

/**
 * TOTAL over the whole input domain: never throws, never awaits, never parses
 * JSON. It OWNS the `binding_read_failed` outcome, which is scoped to the
 * `tag` read.
 *
 * Precedence, total and fixed:
 *   1. binding_read_failed        reading `binding.tag` threw
 *   2. binding_absent             undefined, null, or not an object
 *   3. tag_absent                 typeof tag !== 'string'
 *   4. tag_empty                  tag === ''
 *   5. tag_not_40_lowercase_hex   non-empty string failing GIT_SHA_RE
 *   6. null                       available
 *
 * `binding_absent` is tested before the guarded `tag` read because a null,
 * undefined or non-object binding has no properties that could fail: it is
 * never read, so `binding_read_failed` cannot apply to it. Position 1 still
 * wins wherever both could apply.
 *
 * Independence rule: `deployment_identity_status`, `git_sha` and
 * `deployment_identity_reason` are functions of `tag` ONLY.
 * `worker_version_id` and `worker_version_timestamp` are read and emitted
 * independently, each under its own guard, so a throwing `id` getter never
 * destroys identity and an invalid `tag` never suppresses a valid `id`.
 */
export function resolveDeploymentIdentity(binding: unknown): DeploymentIdentity {
    if (binding === null || typeof binding !== 'object') {
        return makeIdentity('binding_absent', null, null, null);
    }
    const view = binding as VersionMetadataView;

    let tag: unknown;
    let tagReadThrew = false;
    try {
        tag = view.tag;
    } catch {
        tagReadThrew = true;
    }

    let workerVersionId: string | null = null;
    try {
        workerVersionId = boundedString(view.id);
    } catch {
        workerVersionId = null;
    }

    let workerVersionTimestamp: string | null = null;
    try {
        workerVersionTimestamp = boundedString(view.timestamp);
    } catch {
        workerVersionTimestamp = null;
    }

    if (tagReadThrew) {
        return makeIdentity('binding_read_failed', null, workerVersionId, workerVersionTimestamp);
    }
    if (typeof tag !== 'string') {
        return makeIdentity('tag_absent', null, workerVersionId, workerVersionTimestamp);
    }
    if (tag === '') {
        return makeIdentity('tag_empty', null, workerVersionId, workerVersionTimestamp);
    }
    if (!GIT_SHA_RE.test(tag)) {
        // The rejected tag is NEVER echoed into `reason` or into any field.
        return makeIdentity('tag_not_40_lowercase_hex', null, workerVersionId, workerVersionTimestamp);
    }
    return makeIdentity(null, tag, workerVersionId, workerVersionTimestamp);
}

/**
 * The ONE place `_health` constructs a Response. Both the available and the
 * unavailable paths go through it, so HTTP 200, `Cache-Control: no-store` and
 * the exact eight-key body are structural, not coincidental. It takes the real
 * `r2_binding` boolean; that value is never hard-coded here.
 */
export function healthResponse(identity: DeploymentIdentity, r2Binding: boolean): Response {
    const body = {
        status: 'ok',
        r2_binding: r2Binding,
        timestamp: new Date().toISOString(),
        deployment_identity_status: identity.deployment_identity_status,
        git_sha: identity.git_sha,
        worker_version_id: identity.worker_version_id,
        worker_version_timestamp: identity.worker_version_timestamp,
        deployment_identity_reason: identity.deployment_identity_reason,
    };
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
        },
    });
}

/**
 * Matches the nine sibling handlers' signature and IS `async`, so the router
 * awaits it exactly like the others.
 *
 * `_health` is the only route in src/worker.ts with no try/catch around the
 * handler; the guards live HERE so the tests cover them. Each `env` read has
 * its own guard, so an unrelated failure can never relabel the tag-derived
 * reason and can never turn this route into a 500. Never `json500`.
 */
export async function handleHealth(_req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    let binding: unknown;
    try {
        binding = env.CF_VERSION_METADATA;
    } catch {
        binding = UNREADABLE_BINDING;
    }

    let r2Binding = false;
    try {
        r2Binding = !!env.SCIWEON_R2;
    } catch {
        r2Binding = false;
    }

    return healthResponse(resolveDeploymentIdentity(binding), r2Binding);
}
