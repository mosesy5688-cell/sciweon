"""
C1-4 RDKit descriptor precompute (V0.5.8 cycle 19).

Stage-1 post-step. Adds three fields per record:
    properties.qed              - QED drug-likeness (Bickerton 2012), [0, 1]
    properties.aromatic_rings   - aromatic ring count, integer
    properties.structural_alerts - list of {name, catalog} for PAINS/Brenk hits

Does NOT touch properties.lipinski_violations (pubchem-adapter is sole writer
of that field; double-writing would lose pubchem provenance).

Usage:
    python descriptor-precompute.py --self-test   # fixture-drift gate
    python descriptor-precompute.py --dir ./output/compounds   # batch
"""

import argparse
import glob
import json
import os
import sys
import time

try:
    from rdkit import Chem, RDLogger
    from rdkit.Chem.QED import qed as compute_qed
    from rdkit.Chem.FilterCatalog import FilterCatalogParams, FilterCatalog
except ImportError as e:
    print(f"[DESCRIPTOR] FATAL: rdkit import failed: {e}", file=sys.stderr)
    print("[DESCRIPTOR] install via: pip install 'rdkit==2024.9.1'", file=sys.stderr)
    sys.exit(2)

RDLogger.DisableLog("rdApp.*")

CATALOGS = [
    ("PAINS_A", FilterCatalogParams.FilterCatalogs.PAINS_A),
    ("PAINS_B", FilterCatalogParams.FilterCatalogs.PAINS_B),
    ("PAINS_C", FilterCatalogParams.FilterCatalogs.PAINS_C),
    ("Brenk",   FilterCatalogParams.FilterCatalogs.BRENK),
]


def build_filter_catalog():
    """One FilterCatalog covering PAINS_A/B/C + Brenk."""
    params = FilterCatalogParams()
    for _name, cat in CATALOGS:
        params.AddCatalog(cat)
    return FilterCatalog(params)


def compute_descriptors(smiles: str, catalog: FilterCatalog):
    """Return (qed_value, aromatic_ring_count, [{name, catalog}, ...]) or None on parse failure."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    qed_val = round(compute_qed(mol), 4)
    arom_rings = sum(1 for ring in mol.GetRingInfo().AtomRings()
                     if all(mol.GetAtomWithIdx(idx).GetIsAromatic() for idx in ring))
    alerts = []
    for match in catalog.GetMatches(mol):
        desc = match.GetDescription()
        # Description format varies; the catalog name lives in match.GetProp('Scope') in newer RDKit.
        try:
            scope = match.GetProp("Scope")
        except Exception:
            scope = ""
        cat_name = next((n for n, c in CATALOGS if c.name == scope or n.lower() in scope.lower()), "Brenk")
        alerts.append({"name": desc[:100], "catalog": cat_name})
    return qed_val, int(arom_rings), alerts


FIXTURES = [
    # (label, smiles, qed_target, qed_tol, aromatic_rings, expected_alerts_empty)
    ("aspirin",   "CC(=O)Oc1ccccc1C(=O)O",          0.55, 0.05, 1, True),
    ("metformin", "CN(C)C(=N)NC(=N)N",              0.21, 0.05, 0, True),
    ("ibuprofen", "CC(C)Cc1ccc(cc1)C(C)C(=O)O",     0.83, 0.05, 1, True),
]


def self_test():
    catalog = build_filter_catalog()
    failed = []
    for label, smi, qed_target, qed_tol, arom_target, alerts_empty in FIXTURES:
        result = compute_descriptors(smi, catalog)
        if result is None:
            failed.append(f"{label}: SMILES parse failed")
            continue
        qed_val, arom, alerts = result
        if abs(qed_val - qed_target) > qed_tol:
            failed.append(f"{label}: qed {qed_val} not within {qed_tol} of {qed_target}")
        if arom != arom_target:
            failed.append(f"{label}: aromatic_rings {arom} != expected {arom_target}")
        if alerts_empty and len(alerts) > 0:
            failed.append(f"{label}: expected no alerts, got {[a['name'] for a in alerts]}")
        print(f"[DESCRIPTOR] self-test {label}: qed={qed_val} aromatic_rings={arom} alerts={len(alerts)}")
    if failed:
        print("[DESCRIPTOR] FATAL: self-test drift detected:", file=sys.stderr)
        for line in failed:
            print(f"  - {line}", file=sys.stderr)
        sys.exit(1)
    print(f"[DESCRIPTOR] self-test PASS ({len(FIXTURES)} fixtures)")


def process_file(path: str, catalog: FilterCatalog):
    """Mutate one jsonl in-place atomically (write .tmp + rename). Returns (parsed, skipped, alerts_total)."""
    tmp_path = path + ".tmp"
    parsed = skipped = alerts_total = 0
    with open(path, "r", encoding="utf-8") as src, open(tmp_path, "w", encoding="utf-8") as dst:
        for line in src:
            line = line.rstrip("\n")
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                dst.write(line + "\n")
                continue
            smi = rec.get("smiles_canonical") or rec.get("smiles") or ""
            if smi:
                result = compute_descriptors(smi, catalog)
                if result is not None:
                    qed_val, arom, alerts = result
                    props = rec.setdefault("properties", {})
                    props["qed"] = qed_val
                    props["aromatic_rings"] = arom
                    props["structural_alerts"] = alerts
                    parsed += 1
                    alerts_total += len(alerts)
                else:
                    skipped += 1
            else:
                skipped += 1
            dst.write(json.dumps(rec, ensure_ascii=False) + "\n")
    os.replace(tmp_path, path)
    return parsed, skipped, alerts_total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--dir", default="./output/compounds")
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return

    catalog = build_filter_catalog()
    pattern = os.path.join(args.dir, "compounds-cid-*.jsonl")
    files = sorted(glob.glob(pattern))
    if not files:
        print(f"[DESCRIPTOR] FATAL: no jsonl files matched {pattern}", file=sys.stderr)
        sys.exit(3)
    start = time.time()
    total_parsed = total_skipped = total_alerts = 0
    for path in files:
        p, s, a = process_file(path, catalog)
        total_parsed += p
        total_skipped += s
        total_alerts += a
        print(f"[DESCRIPTOR] {os.path.basename(path)}: parsed={p} skipped={s} alerts={a}")
    elapsed = round(time.time() - start, 1)
    print(f"[DESCRIPTOR] Summary: files={len(files)} parsed={total_parsed} skipped={total_skipped} alerts_total={total_alerts} elapsed={elapsed}s")


if __name__ == "__main__":
    main()
