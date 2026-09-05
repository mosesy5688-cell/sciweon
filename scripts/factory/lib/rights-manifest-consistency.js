/**
 * rights-manifest-consistency.js -- compares a caller-supplied manifest
 * against the registry verdict and reports disagreements as findings.
 *
 * NO SELF-CERTIFICATION. A manifest may only APPEND findings. It may not
 * change the verdict, the state, or any other field, in either direction.
 * There is no success signal here: agreement produces no finding, no state,
 * and no key. A manifest that agrees with the registry is indistinguishable
 * in the emitted result from a manifest that was never supplied at all.
 *
 * Nothing here is enforcement. Every finding carries enforced: false and
 * discharged_by_this_module: false. Findings are a report, not a control, and
 * this module is wired to no serving and no packaging path.
 *
 * MANIFEST SHAPE, defined by this lane (a design choice, not a rights
 * question, because the module is wired to nothing):
 *
 *   Manifest = {
 *     source?:       string,          // the source the caller claims
 *     field?:        string,          // the field the caller claims
 *     plane?:        string | null,   // the output plane the caller claims
 *     rights_state?: string | null,   // the rights state the caller claims
 *   }
 *
 * Only keys the manifest actually declares are compared. An absent key is not
 * a claim and produces no finding.
 *
 * FINDING SHAPE, defined by this lane:
 *
 *   Finding = {
 *     code:                      'MANIFEST_DISAGREES_WITH_REGISTRY',
 *     aspect:                    'source' | 'field' | 'plane' | 'rights_state',
 *     manifest_value:            unknown,
 *     registry_value:            string | null,
 *     enforced:                  false,
 *     discharged_by_this_module: false,
 *   }
 */

export const MANIFEST_DISAGREEMENT_CODE = 'MANIFEST_DISAGREES_WITH_REGISTRY';

/** The manifest aspects inspected. This ranks nothing; states are not ranked. */
const MANIFEST_ASPECTS = Object.freeze(['source', 'field', 'plane', 'rights_state']);

/** Reads one own property without ever throwing, even for a throwing getter. */
function safeOwn(target, key) {
    try {
        if (target === null || typeof target !== 'object') return { present: false, value: null };
        if (!Object.prototype.hasOwnProperty.call(target, key)) {
            return { present: false, value: null };
        }
        return { present: true, value: target[key] };
    } catch {
        return { present: false, value: null };
    }
}

function buildFinding(aspect, manifestValue, registryValue) {
    return Object.freeze({
        code: MANIFEST_DISAGREEMENT_CODE,
        aspect,
        manifest_value: manifestValue,
        registry_value: registryValue,
        enforced: false,
        discharged_by_this_module: false,
    });
}

/**
 * Compares `manifest` against an already-computed FieldVerdict.
 *
 * Returns a non-empty frozen Finding[] when the manifest disagrees, and
 * `undefined` otherwise. It NEVER returns an empty array: an empty array is a
 * publish signal, so the key is omitted instead.
 *
 * The verdict is an input here and is never recomputed, so this module cannot
 * influence it. Never throws for any input, including manifests with throwing
 * getters and circular references.
 */
export function manifestFindings(fieldVerdict, manifest) {
    if (manifest === null || typeof manifest !== 'object') return undefined;
    const findings = [];
    for (const aspect of MANIFEST_ASPECTS) {
        const claimed = safeOwn(manifest, aspect);
        if (!claimed.present) continue;
        const registryValue = safeOwn(fieldVerdict, aspect).value;
        if (claimed.value !== registryValue) {
            findings.push(buildFinding(aspect, claimed.value, registryValue));
        }
    }
    return findings.length > 0 ? Object.freeze(findings) : undefined;
}

/** The manifest aspects this module inspects, as a fresh frozen copy. */
export function manifestAspects() {
    return Object.freeze([...MANIFEST_ASPECTS]);
}
