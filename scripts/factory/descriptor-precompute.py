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


def build_filter_catalogs():
    """Return list of (catalog_name, FilterCatalog) — one entry per source set.
    Separate catalogs (not merged) so structural_alerts can attribute each
    hit to its real source (PAINS_A/B/C or Brenk). A merged FilterCatalog
    loses provenance because the .GetMatches return value doesn't expose
    which sub-catalog produced each match.
    """
    out = []
    for cat_name, cat_id in CATALOGS:
        params = FilterCatalogParams()
        params.AddCatalog(cat_id)
        out.append((cat_name, FilterCatalog(params)))
    return out


def compute_descriptors(smiles: str, catalogs):
    """Return (qed_value, aromatic_ring_count, [{name, catalog}, ...]) or None on parse failure."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    qed_val = round(compute_qed(mol), 4)
    arom_rings = sum(1 for ring in mol.GetRingInfo().AtomRings()
                     if all(mol.GetAtomWithIdx(idx).GetIsAromatic() for idx in ring))
    alerts = []
    for cat_name, catalog in catalogs:
        for match in catalog.GetMatches(mol):
            alerts.append({"name": match.GetDescription()[:100], "catalog": cat_name})
    return qed_val, int(arom_rings), alerts


# Locked-in known-value fixtures from RDKit 2025.9.6 (also matches 2024.9.1 outputs).
# Format: (label, smiles, qed_target, qed_tol, aromatic_rings, expected_alerts).
# expected_alerts is set of (name, catalog) tuples for set-comparison drift detection.
FIXTURES = [
    ("aspirin",   "CC(=O)Oc1ccccc1C(=O)O",      0.55, 0.05, 1,
     frozenset({("phenol_ester", "Brenk")})),
    ("metformin", "CN(C)C(=N)NC(=N)N",          0.21, 0.05, 0,
     frozenset({("imine_1", "Brenk"), ("imine_2", "Brenk")})),
    ("ibuprofen", "CC(C)Cc1ccc(cc1)C(C)C(=O)O", 0.83, 0.05, 1,
     frozenset()),
]


def self_test():
    catalogs = build_filter_catalogs()
    failed = []
    for label, smi, qed_target, qed_tol, arom_target, expected_alerts in FIXTURES:
        result = compute_descriptors(smi, catalogs)
        if result is None:
            failed.append(f"{label}: SMILES parse failed")
            continue
        qed_val, arom, alerts = result
        observed_alerts = frozenset((a["name"], a["catalog"]) for a in alerts)
        if abs(qed_val - qed_target) > qed_tol:
            failed.append(f"{label}: qed {qed_val} not within {qed_tol} of {qed_target}")
        if arom != arom_target:
            failed.append(f"{label}: aromatic_rings {arom} != expected {arom_target}")
        if observed_alerts != expected_alerts:
            missing = expected_alerts - observed_alerts
            extra = observed_alerts - expected_alerts
            failed.append(f"{label}: alerts mismatch — missing={sorted(missing)} extra={sorted(extra)}")
        print(f"[DESCRIPTOR] self-test {label}: qed={qed_val} aromatic_rings={arom} alerts={sorted(observed_alerts)}")
    if failed:
        print("[DESCRIPTOR] FATAL: self-test drift detected:", file=sys.stderr)
        for line in failed:
            print(f"  - {line}", file=sys.stderr)
        sys.exit(1)
    print(f"[DESCRIPTOR] self-test PASS ({len(FIXTURES)} fixtures)")


def process_file(path: str, catalogs):
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
                result = compute_descriptors(smi, catalogs)
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

    catalogs = build_filter_catalogs()
    pattern = os.path.join(args.dir, "compounds-cid-*.jsonl")
    files = sorted(glob.glob(pattern))
    if not files:
        print(f"[DESCRIPTOR] FATAL: no jsonl files matched {pattern}", file=sys.stderr)
        sys.exit(3)
    start = time.time()
    total_parsed = total_skipped = total_alerts = 0
    for path in files:
        p, s, a = process_file(path, catalogs)
        total_parsed += p
        total_skipped += s
        total_alerts += a
        print(f"[DESCRIPTOR] {os.path.basename(path)}: parsed={p} skipped={s} alerts={a}")
    elapsed = round(time.time() - start, 1)
    print(f"[DESCRIPTOR] Summary: files={len(files)} parsed={total_parsed} skipped={total_skipped} alerts_total={total_alerts} elapsed={elapsed}s")


if __name__ == "__main__":
    main()
