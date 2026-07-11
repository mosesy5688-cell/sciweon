/**
 * RC-3B-P0B -- leak scanner (name + version + policy hash).
 *
 * Scans the evidence artifact and the log bundle against leak-policy.mjs and
 * returns PASS/FAIL per dimension:
 *   - forbidden_property_scan_result: no forbidden property NAME anywhere;
 *   - artifact_scan_result: every string leaf is a compact locator/token
 *     (no whitespace / no prose / bounded length);
 *   - log_scan_result: no log line carries a dumped blob or over-long line.
 * A result is 'PASS' or 'FAIL'. The positive control (a clean artifact) yields
 * all PASS; the negative control (a poisoned artifact/log) yields FAIL.
 */

import {
    LEAK_SCANNER_NAME, LEAK_SCANNER_VERSION, leakPolicySha256,
    FORBIDDEN_PROPERTY_NAMES, isAllowedStringValue,
    LOG_BLOB_RUN_THRESHOLD, MAX_LOG_LINE_LENGTH,
} from './leak-policy.mjs';

const FORBIDDEN = new Set(FORBIDDEN_PROPERTY_NAMES);
const BLOB_RE = new RegExp(`[^\\s]{${LOG_BLOB_RUN_THRESHOLD},}`);

function walkProps(node, path, hits) {
    if (Array.isArray(node)) {
        node.forEach((v, i) => walkProps(v, `${path}[${i}]`, hits));
    } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (FORBIDDEN.has(k)) hits.push(`${path}.${k}`);
            walkProps(v, `${path}.${k}`, hits);
        }
    }
}

function walkStrings(node, path, hits) {
    if (typeof node === 'string') {
        if (!isAllowedStringValue(node)) hits.push(`${path}=${JSON.stringify(node.slice(0, 48))}`);
    } else if (Array.isArray(node)) {
        node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, hits));
    } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walkStrings(v, `${path}.${k}`, hits);
    }
}

export function scanForbiddenProperties(artifact) {
    const hits = [];
    walkProps(artifact, '$', hits);
    return { result: hits.length ? 'FAIL' : 'PASS', hits };
}

export function scanArtifactValues(artifact) {
    const hits = [];
    walkStrings(artifact, '$', hits);
    return { result: hits.length ? 'FAIL' : 'PASS', hits };
}

export function scanLogs(logLines = []) {
    const hits = [];
    logLines.forEach((line, i) => {
        const s = String(line);
        if (s.length > MAX_LOG_LINE_LENGTH) hits.push(`line ${i}: over-long (${s.length})`);
        else if (BLOB_RE.test(s)) hits.push(`line ${i}: blob-like run >= ${LOG_BLOB_RUN_THRESHOLD}`);
    });
    return { result: hits.length ? 'FAIL' : 'PASS', hits };
}

/**
 * Run the full scan.
 * @param {{artifact:object, logLines?:string[]}} input
 * @returns {object} scanner identity + per-dimension results + a PASS/FAIL roll-up
 */
export function runLeakScan({ artifact, logLines = [] }) {
    const props = scanForbiddenProperties(artifact);
    const values = scanArtifactValues(artifact);
    const logs = scanLogs(logLines);
    const pass = props.result === 'PASS' && values.result === 'PASS' && logs.result === 'PASS';
    return {
        leak_scanner_name: LEAK_SCANNER_NAME,
        leak_scanner_version: LEAK_SCANNER_VERSION,
        leak_policy_sha256: leakPolicySha256(),
        forbidden_property_scan_result: props.result,
        artifact_scan_result: values.result,
        log_scan_result: logs.result,
        pass,
        details: { forbidden: props.hits, values: values.hits, logs: logs.hits },
    };
}
