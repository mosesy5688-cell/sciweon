/**
 * RC-3B-P0B -- unresolved-placeholder scanner (fail-before-network).
 *
 * The harness NEVER accepts a free-form prefix. Every prefix / key / target in
 * the run plan must be fully MATERIALIZED. Any unresolved template token (a
 * literal date/prefix/release placeholder, a dynamic backup-prefix expansion,
 * a wildcard, or a NNNN / MMM counter stub) means the plan was not resolved to
 * concrete objects and MUST be rejected BEFORE a single network call.
 *
 * This module is a PURE detector: no I/O, no network, no client construction.
 */

// Literal placeholder tokens (angle-bracket templates + bare counter stubs +
// glob wildcards). Matched as SUBSTRINGS so `<date>` inside a longer key is
// still caught. NNNN / MMM are matched as whole tokens to avoid flagging real
// hex/shard ids that merely contain those letters.
export const PLACEHOLDER_LITERALS = Object.freeze([
    '<date>', '<prefix>', '<release>', '<yyyy-mm>', '<backup-prefix>',
    '<caller-prefix>', '<snapshot>', '<snapshot-id>', '<run-id>', '<bucket>',
    '<id>', '<name>', '<version>', '<shard>', '<offset>', '<length>',
]);

// Regexes for structural placeholders: any <...> angle template, a bare `*`
// glob, and the NNNN / MMM counter stubs used in un-materialized templates.
export const PLACEHOLDER_PATTERNS = Object.freeze([
    /<[^>]*>/,            // any angle-bracket template token
    /\*/,                 // glob wildcard
    /(^|[^0-9A-Za-z])NNNN([^0-9A-Za-z]|$)/,  // bare NNNN counter stub
    /(^|[^0-9A-Za-z])MMM([^0-9A-Za-z]|$)/,   // bare MMM counter stub
]);

/**
 * @param {*} value  a single string to inspect
 * @returns {string|null} the offending token, or null if fully materialized
 */
export function findPlaceholder(value) {
    if (typeof value !== 'string') return null;
    const lower = value.toLowerCase();
    for (const lit of PLACEHOLDER_LITERALS) {
        if (lower.includes(lit)) return lit;
    }
    for (const re of PLACEHOLDER_PATTERNS) {
        const m = re.exec(value);
        if (m) return m[0];
    }
    return null;
}

/**
 * Deep-scan an arbitrary value (string / array / object) for placeholders.
 *
 * @param {*} node
 * @param {string} path  breadcrumb for diagnostics
 * @returns {{path:string, token:string}[]} every hit (empty => clean)
 */
export function scanForPlaceholders(node, path = '$') {
    const hits = [];
    if (typeof node === 'string') {
        const tok = findPlaceholder(node);
        if (tok) hits.push({ path, token: tok });
    } else if (Array.isArray(node)) {
        node.forEach((v, i) => hits.push(...scanForPlaceholders(v, `${path}[${i}]`)));
    } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            hits.push(...scanForPlaceholders(v, `${path}.${k}`));
        }
    }
    return hits;
}
