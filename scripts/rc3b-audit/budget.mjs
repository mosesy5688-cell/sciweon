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
            rangeRequests: 0, bytesGetMeta: 0, bytesRange: 0, rejectedBeforeNetwork: 0,
        };
        this.touched = new Set();
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

    /** Reject the current request BEFORE network; never reaches the store. */
    reject(code, message) {
        this.noteRejection(code);
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
        this.counters.bytesGetMeta += objectBytes;
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
        this.counters.bytesRange += length;
    }

    _reserveTotalBytes(n) {
        const total = this.counters.bytesGetMeta + this.counters.bytesRange + n;
        if (total > this.caps.MAX_BYTES_TOTAL_PER_RUN) {
            this.stop('CAP_REACHED');
            throw new RunStoppedError(`[RC3B BUDGET] cumulative byte cap reached (${total} > ${this.caps.MAX_BYTES_TOTAL_PER_RUN}) -- STOPPED`);
        }
    }

    touchObject(key) {
        this.touched.add(key);
        if (this.touched.size > this.caps.MAX_OBJECTS_TOUCHED_PER_RUN) {
            this.stop('CAP_REACHED');
        }
    }

    get partial() { return this.stopped; }
    get objectsTouched() { return this.touched.size; }

    stopReasonList() {
        const all = new Set([...this.stopReasons, ...this.rejectionReasons]);
        return all.size ? [...all] : ['NONE'];
    }
}
