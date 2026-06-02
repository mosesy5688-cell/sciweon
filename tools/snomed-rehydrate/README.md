# Sciweon SID -> SNOMED rehydration tool

A standalone, dependency-free Node ESM tool that recovers human-readable SNOMED CT
US `CODE` + `STR` for the SNOMED concepts in a Sciweon public snapshot -- using
**your own** licensed UMLS / SNOMED data. It is a researcher-side serving tool. It
does **not** run in CI, never touches Sciweon's R2, and ships **zero** SNOMED content.

## License prerequisite (read this first)

Rehydrating SNOMED `CODE` / `STR` from the Sciweon snapshot requires a valid
**UMLS Metathesaurus / SNOMED CT Affiliate license held by you, the consumer.**
Obtain a UMLS license at <https://uts.nlm.nih.gov> and download `MRCONSO.RRF`. That
is YOUR licensed copy of the SNOMED content. This tool reads only that local file
plus Sciweon's hash-only public snapshot. Sciweon publishes only its own SID hashes
and its own provenance and makes no SNOMED content available to non-licensees.

## Why this tool exists (the compliance model)

SNOMED CT is distributed under the SNOMED CT Affiliate License via the UMLS
Metathesaurus. Its strings (`STR`), raw codes (`SCTID` / `CODE`), and the UMLS
structural identifier (`CUI`) are licensed content. Sciweon's public snapshot is
served to researchers who may not individually hold a SNOMED / UMLS license, so it
exposes **zero** SNOMED proprietary content:

- `snomed-concepts-public.jsonl` carries **exactly `{ sid_s, sid_c }`** per concept --
  no `STR`, no raw `CODE`, and **no `CUI`** either.
- disease / trial cross-links carry **exactly `{ snomed_sid, confidence, match_method }`**.

`sid_s` and `sid_c` are Sciweon-original, content-addressed SHA-256 hashes
(Sciweon-produced provenance), so they are redistribution-safe.

## The rehydration path (SID-S re-derive ONLY -- no CUI join)

Because `CUI` is withheld, the **SID-S re-derive is the only rehydration path** (there
is no CUI join anywhere). For the `snomed_concept` entity class:

```
sid_s = sha256(
  "sciweon:snomed_concept:snomed.concept.v1.0:SNOMEDCT_US:" + CODE
).hexdigest()[:32]
```

where `CODE` is the SNOMED CT US concept code (`SCTID`) exactly as it appears in the
`MRCONSO.CODE` column for rows with `SAB = SNOMEDCT_US`, `SUPPRESS = N`, `LAT = ENG`.
The anchor is content-addressed on the code only (never the mutable preferred string),
so the hash is stable across releases.

The tool:

1. Streams **your** local `MRCONSO.RRF`, filters to `SAB=SNOMEDCT_US` + `SUPPRESS=N` +
   `LAT=ENG`, and collapses atoms to one concept per distinct `CODE` using the **same
   preferred-atom precedence Sciweon uses** (rank 1 = `ISPREF=Y & TS=P & STT=PF`;
   2 = `ISPREF=Y & TS=P`; 3 = `TS=P`; 4 = first-seen; lower wins; an old preferred
   string demotes to a synonym). This parity is drift-guarded by a shared fixture
   asserted in both this tool's test and the pipeline's `umls-concept-streams` test.
2. For each distinct `CODE`, computes `sid_s = sidS(code)` -> builds a local map
   `sid_s -> { code, preferred_str, synonyms[] }`.
3. Joins Sciweon's published `sid_s` (from `snomed-concepts-public.jsonl` and from any
   `snomed_links[].snomed_sid` on a disease / trial record) against that local map to
   recover `CODE` + `STR`. **No `CUI` anywhere.**

## Target snapshot contract

This tool targets `entity_class = snomed_concept`, `canonicalization_version =
snomed.concept.v1.0`. Confirm those match the snapshot you downloaded (run `--mode
verify`, below) before trusting a join; a `canonicalization_version` bump would change
every `sid_s`.

## Usage

```sh
# Rehydrate every public SNOMED concept + resolve disease/trial cross-links.
node tools/snomed-rehydrate/rehydrate.mjs \
  --snapshot /path/to/snapshots/2026-06-02 \
  --mrconso  /path/to/your/licensed/MRCONSO.RRF \
  --out      rehydrated.jsonl

# Prove the anchor: how many published sid_s your local MRCONSO can recover.
node tools/snomed-rehydrate/rehydrate.mjs \
  --snapshot /path/to/snapshots/2026-06-02 \
  --mrconso  /path/to/your/licensed/MRCONSO.RRF \
  --mode     verify
```

`--snapshot` is a directory containing the public snapshot files (the tool reads both
`*.jsonl` and the gzipped `*.jsonl.gz` form the public snapshot ships). `--out` is
optional; without it, records are written to stdout. A loud telemetry footer reports
`concepts_total`, `sid_matched`, and `no_sid_match` -- no concept is ever silently
dropped (an unmatched `sid_s` is emitted with `no_sid_match: true`).

### Output shape (`rehydrate` mode)

```jsonc
// one line per public concept
{ "sid_s": "...", "sid_c": "...", "code": "<SCTID>", "preferred_str": "...", "synonyms": ["..."] }
// one line per distinct cross-link snomed_sid (disease/trial), _cross_link: true
{ "source": "diseases.jsonl", "snomed_sid": "...", "code": "<SCTID>", "preferred_str": "...",
  "ref_count": 3, "sample_ids": ["..."], "_cross_link": true }
```

`code` / `preferred_str` come entirely from YOUR licensed MRCONSO. Sciweon supplied
only the hashes and its own provenance.

## Design

- Node ESM, **zero runtime dependencies** (`node:crypto`, `node:readline`, `node:zlib`,
  `node:fs` only). The pipe-splitter is vendored (no `csv-parse`) so the tool is
  trivially auditable.
- Mirrors `scripts/factory/lib/sid-generator.js` (`generateSID_S`) and
  `scripts/factory/lib/umls-concept-streams.js` (atom collapse + filters) so the
  rehydrated values match what Sciweon stamped. It does **not** import or run any
  pipeline orchestrator and does **not** touch R2.
