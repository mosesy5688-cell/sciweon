// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { parseReleases, parseDatasets } from '../../scripts/factory/open-targets-probe.js';

describe('open-targets-probe parsers', () => {
    it('extracts release-version dirs ignoring sort anchors + non-version dirs', () => {
        const html = `
            <a href="?C=N;O=D">Name</a>
            <a href="/pub/databases/opentargets/">Parent</a>
            <a href="16.04/">16.04/</a>
            <a href="25.12/">25.12/</a>
            <a href="26.03/">26.03/</a>
            <a href="manifest.json">manifest.json</a>
        `;
        expect(parseReleases(html)).toEqual(['16.04', '25.12', '26.03']);
    });

    it('orders releases by (major, minor) so 26.03 sorts after 25.12', () => {
        const html = 'href="26.03/" href="25.12/" href="24.06/"';
        const sorted = parseReleases(html);
        expect(sorted[sorted.length - 1]).toBe('26.03');
        expect(sorted[0]).toBe('24.06');
    });

    it('dedupes repeated release entries from messy HTML', () => {
        const html = 'href="26.03/" href="26.03/"';
        expect(parseReleases(html)).toEqual(['26.03']);
    });

    it('returns empty when no version-shaped dirs present', () => {
        expect(parseReleases('href="?C=N;O=D" href="db/"')).toEqual([]);
    });

    it('extracts dataset dir names (snake_case, trailing slash)', () => {
        const html = `
            <a href="?C=N;O=D">Name</a>
            <a href="drug_molecule/">drug_molecule/</a>
            <a href="evidence/">evidence/</a>
            <a href="association_overall_direct/">association_overall_direct/</a>
            <a href="manifest.json">manifest.json</a>
            <a href="_SUCCESS">_SUCCESS</a>
        `;
        expect(parseDatasets(html)).toEqual([
            'association_overall_direct',
            'drug_molecule',
            'evidence',
        ]);
    });

    it('skips entries without trailing slash (files, sort anchors)', () => {
        const html = 'href="manifest.json" href="release_data_integrity" href="drug_molecule/"';
        expect(parseDatasets(html)).toEqual(['drug_molecule']);
    });
});
