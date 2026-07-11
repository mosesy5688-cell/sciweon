/**
 * RC-3B-P0B -- policy / run-plan path security (CHANGE E; H4.8). PURE (fs+path).
 *
 * The authorized run-plan path and template-policy path are external inputs. A
 * hostile or accidental value could point OUTSIDE the trusted carrier checkout
 * (a `..` traversal, an absolute path elsewhere, or a symlink whose real target
 * escapes the root). assertSafeCarrierPath resolves the path -- following any
 * symlink via fs.realpathSync where the file exists (or the parent, when it does
 * not) -- and throws `[RC3B PATH] ...` unless the REAL resolved location is
 * inside rootDir. It is wired BEFORE any read of those files in authorized-run
 * and verify-artifact, so an escape fails before any client / network.
 */

import fs from 'fs';
import path from 'path';

/**
 * @param {string} p            the candidate path
 * @param {{rootDir:string}} o  the trusted carrier root (repo root or scripts/rc3b-audit)
 * @returns {string} the safe, real, resolved absolute path (inside rootDir)
 * @throws {Error} message begins `[RC3B PATH] ` on ANY failure
 */
export function assertSafeCarrierPath(p, { rootDir } = {}) {
    const fail = (msg) => { throw new Error(`[RC3B PATH] ${msg}`); };
    if (typeof p !== 'string' || !p) fail('empty or non-string path');
    if (typeof rootDir !== 'string' || !rootDir) fail('no rootDir provided');

    // Reject any '..' traversal segment in the RAW input (before any resolution).
    const segments = p.split(/[\\/]+/);
    if (segments.includes('..')) fail(`path ${JSON.stringify(p)} contains a '..' traversal segment`);

    let rootReal;
    try { rootReal = fs.realpathSync(rootDir); } catch { fail(`rootDir ${JSON.stringify(rootDir)} does not exist`); }

    // Resolve p to its REAL location: realpath when it exists (follows symlinks),
    // else the real parent + basename (so a non-existent target still cannot
    // escape through a symlinked parent directory).
    let resolved;
    if (fs.existsSync(p)) {
        resolved = fs.realpathSync(p);
    } else {
        const parent = path.dirname(path.resolve(p));
        let parentReal;
        try { parentReal = fs.realpathSync(parent); } catch { fail(`parent directory of ${JSON.stringify(p)} does not exist`); }
        resolved = path.join(parentReal, path.basename(p));
    }

    const rel = path.relative(rootReal, resolved);
    if (rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
        fail(`path ${JSON.stringify(p)} resolves OUTSIDE the carrier root (real=${JSON.stringify(resolved)})`);
    }
    return resolved;
}
