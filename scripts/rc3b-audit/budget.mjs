/**
 * RC-3B-P0B -- per-run Budget: the single source of truth for cap enforcement.
 *
 * Every read primitive RESERVES its quota here BEFORE constructing/sending a
 * command. A reservation that would exceed a cap THROWS (fail-before-network)
 * and, when the cap represents budget EXHAUSTION (counts, cumulative bytes,
 * objects touched, runtime), flips the run to STOPPED so no further network
 * call is attempted. Per-request oversize (a single Range or GET-META object
 * larger than its ceiling) is rejected for that request only.
 *
 * Stop / rejection reason codes are drawn from the evidence-schema enum.
 */

import { resolveCaps } from './caps.mjs';

export const STOP_REASONS = Object.freeze([
    'NONE', 'CAP_REACHED', 'OUT_OF_ALLOWLIST', 'MUTATION_ATTEMPT',
    'UNRESOLVED_PLACEHOLDER', 'INTEGRITY_ANOMALY', 'MISSING_AUTHORIZATION',
    'FORMAT_NOT_SEEKABLE', 'OPERATOR_ABORT',
]);

export class RunStoppedError extends Error {}
export class CapExceededError extends Error {}

export class Budget {
    constructor(planCaps = {}, now = () => Date.now()) {
        this.caps = resolveCaps(planCaps);
        this._now = now;
        this.startedAt = now();
        this.stopped = false;
        this.stopReasons = new Set();
        this.rejectionReasons = new Set();
        this.counters = {
            listPages: 0, listKeys: 0, headRequests: 0, getMetaRequests: 0,
            getLocatorRequests: 0, locatorValues: 0, locatorValueBytes: 0,
            rangeRequests: 0, bytesGetMeta: 0, bytesGetLocator: 0, bytesRange: 0, rejectedBeforeNetwork: 0,
        };
        this.touched = new Set();
        // Per-request reserved byte amount (upper bound), reconciled to ACTUAL
        // bytes received by commitGetMetaActualBytes / commitRangeActualBytes.
        this._pendingGetMetaBytes = 0;
        this._pendingGetLocatorBytes = 0;
        this._pendingRangeBytes = 0;
    }

    // ---- stop / reject bookkeeping ------------------------------------------
    _reason(code) { return STOP_REASONS.includes(code) ? code : 'OPERATOR_ABORT'; }

    stop(code) {
        this.stopped = true;
        this.stopReasons.add(this._reason(code));
        return this;
    }

    noteRejection(code) {
        this.counters.rejectedBeforeNetwork += 1;
        this.rejectionReasons.add(this._reason(code));
        return this;
    }

    /**
     * Reject the current request BEFORE network; never reaches the store. An
     * INTEGRITY_ANOMALY also STOPS the run (a provider that violated an invariant
     * is not trusted for any further network call).
     */
    reject(code, message) {
        this.noteRejection(code);
        if (this._reason(code) === 'INTEGRITY_ANOMALY') this.stop('INTEGRITY_ANOMALY');
        throw new CapExceededError(`[RC3B BUDGET] ${message} (reason=${this._reason(code)})`);
    }

    ensureRunning() {
        if (this.stopped) {
            throw new RunStoppedError('[RC3B BUDGET] run is STOPPED -- no further network call permitted');
        }
        this._checkRuntime();
    }

    _checkRuntime() {
        const elapsed = (this._now() - this.startedAt) / 1000;
        if (elapsed > this.caps.MAX_RUNTIME_SECONDS) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError(`[RC3B BUDGET] runtime cap reached (${elapsed.toFixed(1)}s > ${this.caps.MAX_RUNTIME_SECONDS}s) -- STOPPED`);
        }
    }

    // ---- reservations (call BEFORE building the command) --------------------
    reserveListPage() {
        this.ensureRunning();
        if (this.counters.listPages + 1 > this.caps.MAX_LIST_PAGES_PER_RUN) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError(`[RC3B BUDGET] list-page cap reached (${this.caps.MAX_LIST_PAGES_PER_RUN}) -- STOPPED, no further list`);
        }
        this.counters.listPages += 1;
    }

    /** Account keys a page returned; exhausting the key cap STOPS pagination. */
    addListKeys(n) {
        this.counters.listKeys += n;
        if (this.counters.listKeys > this.caps.MAX_LIST_KEYS_PER_RUN) {
            this.stop('CAP_REACHED');
        }
    }

    /** Exact remaining LIST-key budget (never negative). */
    remainingListKeys() {
        return Math.max(0, this.caps.MAX_LIST_KEYS_PER_RUN - this.counters.listKeys);
    }

    reserveHead() {
        this.ensureRunning();
        if (this.counters.headRequests + 1 > this.caps.MAX_HEAD_REQUESTS_PER_RUN) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError(`[RC3B BUDGET] head cap reached (${this.caps.MAX_HEAD_REQUESTS_PER_RUN}) -- STOPPED`);
        }
        this.counters.headRequests += 1;
    }

    reserveGetMeta(objectBytes) {
        this.ensureRunning();
        if (objectBytes > this.caps.MAX_GET_META_OBJECT_BYTES) {
            this.reject('CAP_REACHED', `get-meta object too large (${objectBytes} > ${this.caps.MAX_GET_META_OBJECT_BYTES}) -- refusing body GET after HEAD`);
        }
        if (this.counters.getMetaRequests + 1 > this.caps.MAX_GET_META_REQUESTS_PER_RUN) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError(`[RC3B BUDGET] get-meta request cap reached (${this.caps.MAX_GET_META_REQUESTS_PER_RUN}) -- STOPPED`);
        }
        if (this.counters.bytesGetMeta + objectBytes > this.caps.MAX_GET_META_TOTAL_BYTES) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError(`[RC3B BUDGET] get-meta total-bytes cap reached (${this.caps.MAX_GET_META_TOTAL_BYTES}) -- STOPPED`);
        }
        this._reserveTotalBytes(objectBytes);
        this.counters.getMetaRequests += 1;
        this.counters.bytesGetMeta += objectBytes; // reserved (upper bound)
        this._pendingGetMetaBytes = objectBytes;
    }

    /**
     * Reconcile the GET-META byte counter from the RESERVED upper bound down to
     * the ACTUAL bytes received. Actual > reserved is an integrity anomaly (the
     * body exceeded the HEAD-declared size) -> STOP.
     */
    commitGetMetaActualBytes(actualBytes) {
        const reserved = this._pendingGetMetaBytes;
        this._pendingGetMetaBytes = 0;
        if (actualBytes > reserved) {
            this.reject('INTEGRITY_ANOMALY', `get-meta actual bytes ${actualBytes} exceed reserved ${reserved}`);
        }
        this.counters.bytesGetMeta += (actualBytes - reserved); // adjust down to actual
    }

    reserveGetLocator(objectBytes) {
        this.ensureRunning();
        if (objectBytes > this.caps.MAX_GET_META_OBJECT_BYTES) {
            this.reject('CAP_REACHED', `get-locator object too large (${objectBytes} > ${this.caps.MAX_GET_META_OBJECT_BYTES}) -- refusing body GET after HEAD`);
        }
        if (this.counters.getLocatorRequests + 1 > this.caps.MAX_GET_LOCATOR_REQUESTS_PER_RUN) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError(`[RC3B BUDGET] get-locator request cap reached (${this.caps.MAX_GET_LOCATOR_REQUESTS_PER_RUN}) -- STOPPED`);
        }
        if (this.counters.bytesGetMeta + this.counters.bytesGetLocator + objectBytes > this.caps.MAX_GET_META_TOTAL_BYTES) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError(`[RC3B BUDGET] structural body total-bytes cap reached (${this.caps.MAX_GET_META_TOTAL_BYTES}) -- STOPPED`);
        }
        this._reserveTotalBytes(objectBytes);
        this.counters.getLocatorRequests += 1;
        this.counters.bytesGetLocator += objectBytes;
        this._pendingGetLocatorBytes = objectBytes;
    }

    commitGetLocatorActualBytes(actualBytes) {
        const reserved = this._pendingGetLocatorBytes;
        this._pendingGetLocatorBytes = 0;
        if (actualBytes > reserved) this.reject('INTEGRITY_ANOMALY', `get-locator actual bytes ${actualBytes} exceed reserved ${reserved}`);
        this.counters.bytesGetLocator += (actualBytes - reserved);
    }

    reserveLocatorValues(rows) {
        this.ensureRunning();
        const count = rows.length;
        const bytes = rows.reduce((n, row) => n + row.value_utf8_bytes, 0);
        if (rows.some((row) => row.value_utf8_bytes > this.caps.MAX_LOCATOR_VALUE_BYTES_SINGLE)) {
            this.reject('CAP_REACHED', 'single locator value exceeds immutable byte ceiling');
        }
        if (this.counters.locatorValues + count > this.caps.MAX_LOCATOR_VALUES_PER_RUN
            || this.counters.locatorValueBytes + bytes > this.caps.MAX_LOCATOR_VALUE_BYTES_TOTAL) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError('[RC3B BUDGET] locator value cap reached -- STOPPED');
        }
        this.counters.locatorValues += count;
        this.counters.locatorValueBytes += bytes;
    }

    reserveRange(length) {
        this.ensureRunning();
        if (length > this.caps.MAX_SINGLE_RANGE_BYTES) {
            this.reject('CAP_REACHED', `single range too large (${length} > ${this.caps.MAX_SINGLE_RANGE_BYTES}) -- refusing range GET`);
        }
        if (this.counters.rangeRequests + 1 > this.caps.MAX_RANGE_REQUESTS_PER_RUN) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError(`[RC3B BUDGET] range request cap reached (${this.caps.MAX_RANGE_REQUESTS_PER_RUN}) -- STOPPED`);
        }
        this._reserveTotalBytes(length);
        this.counters.rangeRequests += 1;
        this.counters.bytesRange += length; // reserved (upper bound)
        this._pendingRangeBytes = length;
    }

    /**
     * Reconcile the Range byte counter from the RESERVED upper bound down to the
     * ACTUAL bytes received. Actual > reserved is an integrity anomaly (the
     * provider returned more than the requested Range) -> STOP.
     */
    commitRangeActualBytes(actualBytes) {
        const reserved = this._pendingRangeBytes;
        this._pendingRangeBytes = 0;
        if (actualBytes > reserved) {
            this.reject('INTEGRITY_ANOMALY', `range actual bytes ${actualBytes} exceed reserved ${reserved}`);
        }
        this.counters.bytesRange += (actualBytes - reserved); // adjust down to actual
    }

    _reserveTotalBytes(n) {
        const total = this.counters.bytesGetMeta + this.counters.bytesGetLocator + this.counters.bytesRange + n;
        if (total > this.caps.MAX_BYTES_TOTAL_PER_RUN) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError(`[RC3B BUDGET] cumulative byte cap reached (${total} > ${this.caps.MAX_BYTES_TOTAL_PER_RUN}) -- STOPPED`);
        }
    }

    /**
     * Reserve a unique object slot BEFORE any network call. If touching a NEW
     * key would exceed the object cap, STOP the run and throw (fail-before-network)
     * -- the object is never contacted. Re-touching an already-touched key is free.
     */
    reserveObject(key) {
        if (!this.touched.has(key) && this.touched.size + 1 > this.caps.MAX_OBJECTS_TOUCHED_PER_RUN) {
            this.stop('CAP_REACHED');
            this.reject('CAP_REACHED', `object cap reached (${this.caps.MAX_OBJECTS_TOUCHED_PER_RUN}) -- refusing a new object before network`);
        }
        this.touched.add(key);
    }

    /** Back-compat alias; identical fail-before-network reservation semantics. */
    touchObject(key) { return this.reserveObject(key); }

    get partial() { return this.stopped; }
    get objectsTouched() { return this.touched.size; }

    stopReasonList() {
        const all = new Set([...this.stopReasons, ...this.rejectionReasons]);
        return all.size ? [...all] : ['NONE'];
    }
}
