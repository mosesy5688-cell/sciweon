/**
 * Tests for V0.6 SDF parser + PubChem schema mapper.
 * Verifies V2000 streaming parse + Sciweon Compound schema mapping.
 */

import { describe, it, expect } from 'vitest';
import { parseSdfText, parseSdfStream } from '../../scripts/factory/lib/sdf-parser.js';
import { mapPubchemRecord } from '../../scripts/factory/lib/pubchem-sdf-mapper.js';

const ASPIRIN_SDF = `2244
  -OEChem-

 13 13  0  0  0  0  0  0  0  0999 V2000
    3.7321    1.2500    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
[atom and bond data truncated for test brevity]
M  END
> <PUBCHEM_COMPOUND_CID>
2244

> <PUBCHEM_COMPOUND_CANONICALIZED>
1

> <PUBCHEM_CACTVS_COMPLEXITY>
212

> <PUBCHEM_CACTVS_HBOND_ACCEPTOR>
4

> <PUBCHEM_CACTVS_HBOND_DONOR>
1

> <PUBCHEM_CACTVS_ROTATABLE_BOND>
3

> <PUBCHEM_CACTVS_SUBSKEYS>
AAADceB7sAAAAAAAAAAAAAAAAAAAAAAAAAA8YIAAAAAAAFgB+AAAHgAQCAAACDDjpJiCCgGZIAACQAAQAOAIAACQACAACBCAAACAAAgQAIiBAAQAACBCAAQABAAAAQQAACAAAA==

> <PUBCHEM_IUPAC_OPENEYE_NAME>
2-acetoxybenzoic acid

> <PUBCHEM_IUPAC_NAME>
2-acetyloxybenzoic acid

> <PUBCHEM_IUPAC_INCHI>
InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)

> <PUBCHEM_IUPAC_INCHIKEY>
BSYNRYMUTXBXSQ-UHFFFAOYSA-N

> <PUBCHEM_MOLECULAR_FORMULA>
C9H8O4

> <PUBCHEM_MOLECULAR_WEIGHT>
180.16

> <PUBCHEM_OPENEYE_CAN_SMILES>
CC(=O)OC1=CC=CC=C1C(=O)O

> <PUBCHEM_OPENEYE_ISO_SMILES>
CC(=O)OC1=CC=CC=C1C(=O)O

> <PUBCHEM_XLOGP3>
1.2

> <PUBCHEM_CACTVS_TPSA>
63.6

> <PUBCHEM_HEAVY_ATOM_COUNT>
13

$$$$
`;

const TWO_COMPOUNDS_SDF = ASPIRIN_SDF + `1983
  -OEChem-

 11 11  0  0  0  0  0  0  0  0999 V2000
M  END
> <PUBCHEM_COMPOUND_CID>
1983

> <PUBCHEM_IUPAC_INCHIKEY>
RZVAJINKPMORJF-UHFFFAOYSA-N

> <PUBCHEM_IUPAC_NAME>
N-(4-hydroxyphenyl)acetamide

> <PUBCHEM_MOLECULAR_FORMULA>
C8H9NO2

> <PUBCHEM_MOLECULAR_WEIGHT>
151.16

> <PUBCHEM_OPENEYE_CAN_SMILES>
CC(=O)NC1=CC=C(C=C1)O

> <PUBCHEM_IUPAC_INCHI>
InChI=1S/C8H9NO2/c1-6(10)9-7-2-4-8(11)5-3-7/h2-5,11H,1H3,(H,9,10)

> <PUBCHEM_XLOGP3>
0.5

> <PUBCHEM_CACTVS_HBOND_DONOR>
2

> <PUBCHEM_CACTVS_HBOND_ACCEPTOR>
2

$$$$
`;

describe('parseSdfText', () => {
    it('parses aspirin (CID 2244) with full PubChem property block', async () => {
        const records = await parseSdfText(ASPIRIN_SDF);
        expect(records.length).toBe(1);
        const rec = records[0];
        expect(rec.PUBCHEM_COMPOUND_CID).toBe('2244');
        expect(rec.PUBCHEM_IUPAC_INCHIKEY).toBe('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
        expect(rec.PUBCHEM_IUPAC_NAME).toBe('2-acetyloxybenzoic acid');
        expect(rec.PUBCHEM_MOLECULAR_FORMULA).toBe('C9H8O4');
        expect(rec.PUBCHEM_MOLECULAR_WEIGHT).toBe('180.16');
        expect(rec.PUBCHEM_OPENEYE_CAN_SMILES).toBe('CC(=O)OC1=CC=CC=C1C(=O)O');
        expect(rec.PUBCHEM_XLOGP3).toBe('1.2');
        expect(rec.PUBCHEM_CACTVS_TPSA).toBe('63.6');
        expect(rec.PUBCHEM_CACTVS_HBOND_DONOR).toBe('1');
        expect(rec.PUBCHEM_CACTVS_HBOND_ACCEPTOR).toBe('4');
        expect(rec.PUBCHEM_CACTVS_SUBSKEYS).toContain('AAADceB7sAAA');
    });

    it('parses two compounds (2244 + 1983)', async () => {
        const records = await parseSdfText(TWO_COMPOUNDS_SDF);
        expect(records.length).toBe(2);
        expect(records[0].PUBCHEM_COMPOUND_CID).toBe('2244');
        expect(records[1].PUBCHEM_COMPOUND_CID).toBe('1983');
        expect(records[1].PUBCHEM_IUPAC_INCHIKEY).toBe('RZVAJINKPMORJF-UHFFFAOYSA-N');
        expect(records[1].PUBCHEM_MOLECULAR_FORMULA).toBe('C8H9NO2');
    });

    it('skips records lacking PUBCHEM_COMPOUND_CID', async () => {
        const badSdf = `> <PUBCHEM_IUPAC_NAME>\nmystery compound\n\n$$$$\n`;
        const records = await parseSdfText(badSdf);
        expect(records.length).toBe(0);
    });

    it('tolerates CRLF line endings', async () => {
        const crlfSdf = ASPIRIN_SDF.replace(/\n/g, '\r\n');
        const records = await parseSdfText(crlfSdf);
        expect(records.length).toBe(1);
        expect(records[0].PUBCHEM_COMPOUND_CID).toBe('2244');
    });

    it('handles tag header with parenthesized index suffix', async () => {
        const sdf = `> <PUBCHEM_COMPOUND_CID> (2244)\n2244\n\n> <PUBCHEM_IUPAC_INCHIKEY>\nABC-DEF-G\n\n$$$$\n`;
        const records = await parseSdfText(sdf);
        expect(records.length).toBe(1);
        expect(records[0].PUBCHEM_COMPOUND_CID).toBe('2244');
        expect(records[0].PUBCHEM_IUPAC_INCHIKEY).toBe('ABC-DEF-G');
    });
});

describe('mapPubchemRecord (PubChem → Sciweon Compound)', () => {
    it('maps aspirin to full Compound schema', async () => {
        const [rawRec] = await parseSdfText(ASPIRIN_SDF);
        const compound = mapPubchemRecord(rawRec, { timestamp: '2026-05-17T00:00:00Z' });
        expect(compound).not.toBeNull();
        expect(compound.id).toBe('sciweon::compound::CID:2244');
        expect(compound.pubchem_cid).toBe(2244);
        expect(compound.inchi_key).toBe('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
        expect(compound.inchi).toContain('InChI=1S/C9H8O4');
        expect(compound.smiles_canonical).toBe('CC(=O)OC1=CC=CC=C1C(=O)O');
        expect(compound.molecular_formula).toBe('C9H8O4');
        expect(compound.molecular_weight).toEqual({ value: 180.16, unit: 'Da' });
        expect(compound.iupac_name).toBe('2-acetyloxybenzoic acid');
        expect(compound.properties.log_p).toEqual({ value: 1.2, method: 'XLogP3' });
        expect(compound.properties.tpsa).toEqual({ value: 63.6, unit: 'angstrom_squared' });
        expect(compound.properties.h_bond_donors).toBe(1);
        expect(compound.properties.h_bond_acceptors).toBe(4);
        expect(compound.properties.rotatable_bonds).toBe(3);
        expect(compound.properties.complexity).toBe(212);
        expect(compound.fingerprint.cactvs_881).toContain('AAADceB7sAAA');
        expect(compound.fingerprint.source).toBe('pubchem_cactvs_v2');
        expect(compound.provenance.sources[0].source).toBe('pubchem');
        expect(compound.provenance.sources[0].extraction_method).toBe('pubchem_ftp_sdf_v2000');
        expect(compound.confidence.overall).toBe(70);
        expect(compound.confidence.cross_source_agreement.structural_match).toBe(false);
    });

    it('rejects records missing inchi_key (Sciweon primary key)', async () => {
        const sdf = `> <PUBCHEM_COMPOUND_CID>\n9999\n\n> <PUBCHEM_IUPAC_NAME>\nmystery\n\n$$$$\n`;
        const [rawRec] = await parseSdfText(sdf);
        const compound = mapPubchemRecord(rawRec);
        expect(compound).toBeNull();
    });

    it('rejects records missing CID', async () => {
        const rawRec = { PUBCHEM_IUPAC_INCHIKEY: 'ABC' };
        const compound = mapPubchemRecord(rawRec);
        expect(compound).toBeNull();
    });

    it('handles partial property data (only required fields)', async () => {
        const minimalRec = {
            PUBCHEM_COMPOUND_CID: '12345',
            PUBCHEM_IUPAC_INCHIKEY: 'XYZ-ABC-D',
        };
        const compound = mapPubchemRecord(minimalRec);
        expect(compound).not.toBeNull();
        expect(compound.id).toBe('sciweon::compound::CID:12345');
        expect(compound.inchi_key).toBe('XYZ-ABC-D');
        expect(compound.properties).toBeUndefined();  // no optional fields → no properties block
        expect(compound.fingerprint).toBeUndefined();
    });

    it('1000-record streaming perf <2s smoke', async () => {
        // Build synthetic 1K-record SDF buffer
        const records = Array.from({ length: 1000 }, (_, i) => {
            const cid = 10000 + i;
            return `> <PUBCHEM_COMPOUND_CID>\n${cid}\n\n> <PUBCHEM_IUPAC_INCHIKEY>\nSTUB${cid}-AAA-A\n\n> <PUBCHEM_MOLECULAR_FORMULA>\nC${(i % 30) + 1}H${(i % 60) + 1}\n\n> <PUBCHEM_MOLECULAR_WEIGHT>\n${(100 + i * 0.5).toFixed(2)}\n\n$$$$\n`;
        }).join('');

        const t0 = Date.now();
        const out = await parseSdfText(records);
        const elapsed = Date.now() - t0;

        expect(out.length).toBe(1000);
        expect(elapsed).toBeLessThan(2000);
    });
});
