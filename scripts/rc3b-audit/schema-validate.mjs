/**
 * RC-3B-P0B -- minimal, self-contained JSON-Schema Draft-07 validator.
 *
 * Covers exactly the keyword subset used by RC3B_EVIDENCE_SCHEMA_v0.1.json:
 * type (object/array/string/integer/number/boolean), required, properties,
 * additionalProperties:false, enum, const, pattern, minimum, minItems,
 * minLength, items, allOf, and if/then. No network, no dependency (ajv is not
 * installed). Draft-07 if/then semantics: when `if` validates, `then` must
 * validate; when `if` fails, `then` is not applied (there is no `else` here).
 */

function typeOk(type, data) {
    switch (type) {
        case 'object': return data !== null && typeof data === 'object' && !Array.isArray(data);
        case 'array': return Array.isArray(data);
        case 'string': return typeof data === 'string';
        case 'integer': return typeof data === 'number' && Number.isInteger(data);
        case 'number': return typeof data === 'number' && Number.isFinite(data);
        case 'boolean': return typeof data === 'boolean';
        case 'null': return data === null;
        default: return true;
    }
}

function collect(schema, data, path, errors) {
    if (schema == null || typeof schema !== 'object') return;

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some((t) => typeOk(t, data))) {
            errors.push(`${path}: expected type ${types.join('|')}, got ${Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data}`);
            return; // a wrong-typed node cannot be checked further
        }
    }
    if (schema.const !== undefined && data !== schema.const) {
        errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === data)) {
        errors.push(`${path}: value ${JSON.stringify(data)} not in enum`);
    }
    if (typeof data === 'string') {
        if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(data)) {
            errors.push(`${path}: string does not match pattern ${schema.pattern}`);
        }
        if (schema.minLength !== undefined && data.length < schema.minLength) {
            errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
        }
    }
    if (typeof data === 'number') {
        if (schema.minimum !== undefined && data < schema.minimum) {
            errors.push(`${path}: number ${data} < minimum ${schema.minimum}`);
        }
    }
    if (Array.isArray(data)) {
        if (schema.minItems !== undefined && data.length < schema.minItems) {
            errors.push(`${path}: array shorter than minItems ${schema.minItems}`);
        }
        if (schema.items) data.forEach((el, i) => collect(schema.items, el, `${path}[${i}]`, errors));
    }
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        collectObject(schema, data, path, errors);
    }
    if (Array.isArray(schema.allOf)) {
        for (const sub of schema.allOf) collect(sub, data, path, errors);
    }
    if (schema.if !== undefined) {
        if (isValid(schema.if, data) && schema.then !== undefined) {
            collect(schema.then, data, path, errors);
        } else if (!isValid(schema.if, data) && schema.else !== undefined) {
            collect(schema.else, data, path, errors);
        }
    }
}

function collectObject(schema, data, path, errors) {
    if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
            if (!(key in data)) errors.push(`${path}: missing required property "${key}"`);
        }
    }
    if (schema.properties) {
        for (const [key, sub] of Object.entries(schema.properties)) {
            if (key in data) collect(sub, data[key], `${path}.${key}`, errors);
        }
    }
    if (schema.additionalProperties === false && schema.properties) {
        const known = new Set(Object.keys(schema.properties));
        for (const key of Object.keys(data)) {
            if (!known.has(key)) errors.push(`${path}: additional property "${key}" is not allowed`);
        }
    }
}

function isValid(schema, data) {
    const e = [];
    collect(schema, data, '$', e);
    return e.length === 0;
}

/**
 * @param {object} schema  a Draft-07 schema (the subset above)
 * @param {*} data
 * @returns {{valid:boolean, errors:string[]}}
 */
export function validateDraft07(schema, data) {
    const errors = [];
    collect(schema, data, '$', errors);
    return { valid: errors.length === 0, errors };
}
