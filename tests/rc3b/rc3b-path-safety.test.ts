// @ts-nocheck
/**
 * RC-3B-P0B policy / run-plan path security (CHANGE E). assertSafeCarrierPath
 * accepts a path INSIDE the carrier root and rejects a `..` traversal, an
 * absolute path outside the root, and a symlink/junction whose REAL target
 * escapes the root. Wired into runAuthorizedAudit it fails BEFORE the client
 * (0 network).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertSafeCarrierPath } from '../../scripts/rc3b-audit/path-safety.mjs';
import { authorizedScenario, runScenario } from './rc3b-authorized-fixtures';

const mkdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));

describe('RC-3B-P0B path-safety: assertSafeCarrierPath (pure)', () => {
    it('accepts a real file INSIDE the carrier root', () => {
        const root = mkdir('rc3b-ps-root-');
        const f = path.join(root, 'run-plan.json');
        fs.writeFileSync(f, '{}');
        expect(() => assertSafeCarrierPath(f, { rootDir: root })).not.toThrow();
    });

    it('rejects a ".." traversal segment', () => {
        const root = mkdir('rc3b-ps-root-');
        const traversal = `${root}${path.sep}..${path.sep}run-plan.json`;
        expect(() => assertSafeCarrierPath(traversal, { rootDir: root })).toThrow(/RC3B PATH/);
    });

    it('rejects an absolute path OUTSIDE the root', () => {
        const root = mkdir('rc3b-ps-root-');
        const outside = mkdir('rc3b-ps-out-');
        const f = path.join(outside, 'evil.json');
        fs.writeFileSync(f, '{}');
        expect(() => assertSafeCarrierPath(f, { rootDir: root })).toThrow(/RC3B PATH/);
    });

    it('rejects a symlink/junction whose real target ESCAPES the root', () => {
        const root = mkdir('rc3b-ps-root-');
        const outside = mkdir('rc3b-ps-out-');
        fs.writeFileSync(path.join(outside, 'evil.json'), '{}');
        const link = path.join(root, 'link');
        let linked = false;
        try { fs.symlinkSync(outside, link, 'junction'); linked = true; } catch { linked = false; }
        if (!linked) return; // symlink privilege unavailable -> nothing to assert
        const escape = path.join(link, 'evil.json');
        expect(() => assertSafeCarrierPath(escape, { rootDir: root })).toThrow(/RC3B PATH/);
    });
});

describe('RC-3B-P0B path-safety: wired into runAuthorizedAudit (fail-before-client)', () => {
    it('a traversal run-plan path -> 0 network', async () => {
        const scn = authorizedScenario();
        const traversal = `${scn.dir}${path.sep}..${path.sep}run-plan.json`;
        scn.env.RC3B_RUN_PLAN_PATH = traversal;
        scn.env.RC3B_AUTHORIZED_RUN_PLAN_PATH = traversal;
        const spy = { sends: 0, async send() { this.sends += 1; return {}; } };
        await expect(runScenario(scn, spy)).rejects.toThrow(/RC3B PATH/);
        expect(spy.sends).toBe(0);
    });
});
