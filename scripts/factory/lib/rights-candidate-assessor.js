/**
 * rights-candidate-assessor.js -- resolves a caller-supplied (source, field)
 * pair against the frozen registry and returns a value. Always a value.
 *
 * NEVER THROWS FOR A RIGHTS OUTCOME. Every outcome is a returned value,
 * including for non-object input, absent keys, throwing getters and circular
 * references. A caller cannot build a publish gate out of control flow here,
 * because there is no control flow to catch.
 *
 * NO TERMINAL STATE IS A PERMISSION. The maximal UnitAssessment state is
 * ADJUDICATED_OBLIGATIONS_UNDISCHARGED, which exists to be reported, not
 * compared against. This module exports no ordering, rank, comparison or
 * severity over the states, because an ordering makes a numeric comparison a
 * publish gate with no banned identifier in sight.
 *
 * FAIL CLOSED. UNRESOLVED is the default for anything the registry does not
 * adjudicate. NOT_IN_ANY_APPROVED_OUTPUT_PLANE is EQUAL IN EFFECT to it: the
 * two results differ in nothing but their name and the echoed pair, which is
 * asserted mechanically by the equal-effect test.
 *
 * SOURCE IS CALLER-SUPPLIED and is not verified by anything here, which is
 * why the adjudicated state is named ADJUDICATED_AS_ASSERTED and why every
 * result carries source_assertion: 'caller_supplied' and
 * source_independently_verified: false.
 *
 * UNIT SHAPE, defined by this lane (a design choice, not a rights question,
 * because the module is wired to nothing):
 *
 *   Unit = { source?: string, field?: string }
 *
 * Any other input shape is accepted and resolves to UNRESOLVED. A non-string
 * source or field is echoed as the empty string, so the emitted key set and
 * value types never vary.
 *
 * VOCABULARY RULE: do not introduce synonyms of the guarded stems --
 * "air-gapped", "segregated", "quarantined", "separate memory" and the like.
 * The guard pattern cannot be widened to catch them because two module_limits
 * keys legitimately contain the substring "separat". Reword the prose.
 */

import {
    has,
    planeOf,
    planeRecord,
    obligationsForPlane,
    isSourceWithoutPlaneMembership,
    moduleLimits,
} from './rights-candidate-registry-data.js';
import { manifestFindings } from './rights-manifest-consistency.js';

const CALLER_SUPPLIED = 'caller_supplied';

/** Reads a string property without ever throwing. Anything else becomes ''. */
function readString(unit, key) {
    try {
        if (unit === null || typeof unit !== 'object') return '';
        const value = unit[key];
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

/**
 * Computes a FieldVerdict. Takes exactly ONE parameter: no manifest is
 * reachable from this call path, in this function or anything it calls.
 * `assess(unit, manifest)` delegates to `verdict(unit)`, never the reverse.
 *
 * Resolution order:
 *   source in the frozen four -> NOT_IN_ANY_APPROVED_OUTPUT_PLANE (any field)
 *   else pair in the 25       -> ADJUDICATED_AS_ASSERTED, plane + rights_state
 *   else                      -> UNRESOLVED
 *
 * All seven keys are present in every state. `plane` and `rights_state` are
 * null unless the state is ADJUDICATED_AS_ASSERTED.
 */
export function verdict(unit) {
    const source = readString(unit, 'source');
    const field = readString(unit, 'field');
    let state = 'UNRESOLVED';
    let plane = null;
    let rightsState = null;
    try {
        if (isSourceWithoutPlaneMembership(source)) {
            state = 'NOT_IN_ANY_APPROVED_OUTPUT_PLANE';
        } else if (has(source, field)) {
            const resolved = planeOf(source, field);
            const record = resolved === null ? null : planeRecord(resolved);
            if (record !== null) {
                state = 'ADJUDICATED_AS_ASSERTED';
                plane = resolved;
                rightsState = record.rights_state;
            }
        }
    } catch {
        state = 'UNRESOLVED';
        plane = null;
        rightsState = null;
    }
    return Object.freeze({
        state,
        source,
        field,
        plane,
        rights_state: rightsState,
        source_assertion: CALLER_SUPPLIED,
        source_independently_verified: false,
    });
}

function unitStateFor(verdictState) {
    if (verdictState === 'ADJUDICATED_AS_ASSERTED') {
        return 'ADJUDICATED_OBLIGATIONS_UNDISCHARGED';
    }
    if (verdictState === 'NOT_IN_ANY_APPROVED_OUTPUT_PLANE') {
        return 'NOT_IN_ANY_APPROVED_OUTPUT_PLANE';
    }
    return 'UNRESOLVED';
}

/**
 * Computes a UnitAssessment. Five keys are mandatory; `obligations` and
 * `findings` are present if and only if non-empty. Neither is ever emitted as
 * an empty array, because an empty array is a publish signal.
 *
 * The optional `manifest` can only APPEND findings. Remove `findings` from
 * the result and what remains is byte-for-byte what `assess(unit)` returns.
 */
export function assess(unit, manifest) {
    const fieldVerdict = verdict(unit);
    const out = {
        state: unitStateFor(fieldVerdict.state),
        verdict: fieldVerdict,
        module_limits: moduleLimits(),
        source_assertion: CALLER_SUPPLIED,
        source_independently_verified: false,
    };
    if (fieldVerdict.state === 'ADJUDICATED_AS_ASSERTED') {
        const obligations = obligationsForPlane(fieldVerdict.plane);
        if (Array.isArray(obligations) && obligations.length > 0) {
            out.obligations = obligations;
        }
    }
    let findings;
    try {
        findings = manifestFindings(fieldVerdict, manifest);
    } catch {
        findings = undefined;
    }
    if (Array.isArray(findings) && findings.length > 0) {
        out.findings = findings;
    }
    return Object.freeze(out);
}

/** The limits of this module, as a fresh frozen copy. Stated positively. */
export function limits() {
    return moduleLimits();
}
