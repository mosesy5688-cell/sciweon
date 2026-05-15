/**
 * Validation Gate — Sciweon V0.5.x
 *
 * Enforces Sciweon 6 first principles:
 *   1. Machine-readable (type + unit + range)
 *   2. Validated (not just present)
 *   3. Explicit gaps (unknown/not_collected/excluded)
 *   4. Provenance mandatory
 *   5. Confidence quantified
 *   6. Negative data equal-class
 *
 * Modes (2026-05-15 policy upgrade — data quality is the lifeline):
 *   - REJECT (default): bad data throws and halts the chain. Production
 *     pipelines must never upload non-compliant records to R2; first
 *     violation aborts the run with a full error message, no records
 *     emitted, no partial pollution. User rule (verbatim): any bad data
 *     must stop the run and report the error.
 *   - WARN (opt-in via VALIDATION_MODE=warn): logs violations and
 *     accepts data. Use only for local schema iteration / debugging.
 *
 * V0.1a started in WARN mode while the schema was iterating; V0.5.x
 * defaults to REJECT because the schema is stable and any production
 * violation is now a real integrity gap that must surface immediately.
 */

export const MODE_WARN = 'warn';
export const MODE_REJECT = 'reject';

let CURRENT_MODE = process.env.VALIDATION_MODE || MODE_REJECT;

export function setMode(mode) {
    if (![MODE_WARN, MODE_REJECT].includes(mode)) throw new Error(`Invalid mode: ${mode}`);
    CURRENT_MODE = mode;
}

export function validate(entity, schema, context = '') {
    const errors = [];
    for (const [field, rule] of Object.entries(schema)) {
        const value = entity[field];
        const fieldErrors = validateField(value, rule, `${context}.${field}`);
        errors.push(...fieldErrors);
    }
    return { valid: errors.length === 0, errors };
}

function validateField(value, rule, path) {
    const errors = [];
    if (rule.required && (value === undefined || value === null)) {
        errors.push({ path, error: 'required field missing' });
        return errors;
    }
    if (value === undefined || value === null) return errors;
    if (rule.type === 'string' && typeof value !== 'string') errors.push({ path, error: `expected string, got ${typeof value}` });
    if (rule.type === 'number' && (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value))) errors.push({ path, error: 'expected finite number' });
    if (rule.type === 'integer' && (!Number.isInteger(value))) errors.push({ path, error: 'expected integer' });
    if (rule.type === 'boolean' && typeof value !== 'boolean') errors.push({ path, error: `expected boolean, got ${typeof value}` });
    if (rule.type === 'array' && !Array.isArray(value)) errors.push({ path, error: `expected array, got ${typeof value}` });
    if (rule.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) errors.push({ path, error: 'expected object' });

    if (rule.min !== undefined && value < rule.min) errors.push({ path, error: `${value} < min ${rule.min}` });
    if (rule.max !== undefined && value > rule.max) errors.push({ path, error: `${value} > max ${rule.max}` });
    if (rule.pattern && typeof value === 'string' && !rule.pattern.test(value)) errors.push({ path, error: `pattern mismatch: ${rule.pattern}` });
    if (rule.enum && !rule.enum.includes(value)) errors.push({ path, error: `not in enum: ${rule.enum.join(',')}` });
    if (rule.maxLength && value.length > rule.maxLength) errors.push({ path, error: `length ${value.length} > maxLength ${rule.maxLength}` });
    if (rule.maxItems && value.length > rule.maxItems) errors.push({ path, error: `items ${value.length} > maxItems ${rule.maxItems}` });
    if (rule.minItems && value.length < rule.minItems) errors.push({ path, error: `items ${value.length} < minItems ${rule.minItems}` });

    if (rule.format === 'iso8601' && typeof value === 'string') {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) errors.push({ path, error: 'invalid ISO 8601 timestamp' });
    }

    if (rule.shape && rule.type === 'object') {
        errors.push(...validate(value, rule.shape, path).errors);
    }
    if (rule.itemShape && rule.type === 'array') {
        value.forEach((item, i) => errors.push(...validate(item, rule.itemShape, `${path}[${i}]`).errors));
    }
    if (rule.itemType && rule.type === 'array') {
        value.forEach((item, i) => {
            if (typeof item !== rule.itemType) errors.push({ path: `${path}[${i}]`, error: `expected ${rule.itemType}, got ${typeof item}` });
        });
    }
    return errors;
}

export function gate(entity, schema, context = 'entity') {
    const { valid, errors } = validate(entity, schema, context);
    if (valid) return { passed: true, entity };

    if (CURRENT_MODE === MODE_WARN) {
        console.warn(`[VALIDATION] ${context}: ${errors.length} violations (WARN mode, accepting)`);
        for (const e of errors.slice(0, 5)) console.warn(`  - ${e.path}: ${e.error}`);
        return { passed: true, entity, warnings: errors };
    }

    // REJECT mode: fail-fast. Bad data must NEVER pollute production R2.
    // Throwing here halts the producer (harvester / linker / aggregator),
    // returns a non-zero exit code, and prevents the downstream stage from
    // triggering. Callers cannot silently `continue` past a violation.
    const detail = errors.slice(0, 10).map(e => `  - ${e.path}: ${e.error}`).join('\n');
    const truncated = errors.length > 10 ? `\n  ... (${errors.length - 10} more)` : '';
    throw new Error(
        `[VALIDATION] ${context}: ${errors.length} violations — chain halted (REJECT mode)\n${detail}${truncated}`
    );
}
