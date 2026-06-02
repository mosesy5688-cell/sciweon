# SNOMED CT US Rehydration (PR-UMLS-3)

## Why the public snapshot carries no SNOMED content

SNOMED CT is distributed under the SNOMED CT Affiliate License via the UMLS
Metathesaurus. Its concept strings (STR), raw concept codes (SCTID / CODE), and
the UMLS structural identifier (CUI) are licensed content. Sciweon's public
snapshot is served to researchers who may NOT individually hold a SNOMED / UMLS
license, so it must expose ZERO SNOMED proprietary structural content.

Founder constitutional rulings (NON-NEGOTIABLE), per the verbatim Appendix-2
review of the SNOMED CT Affiliate + UMLS Metathesaurus redistribution terms:

- RULING 1 -- the public `snomed-concepts-public.jsonl` payload is "Born-Clean":
  EXACTLY `{ sid_s, sid_c }` per concept. No STR, no raw CODE, and (escalated
  final ruling) no CUI either. `sid_s` and `sid_c` are Sciweon-original,
  content-addressed SHA-256 hashes -- Sciweon-produced provenance, not SNOMED
  content -- so they are redistribution-safe.
- RULING 2 -- the FULL artifact (STR + raw CODE + CUI) lives ONLY under an
  internal R2 prefix (`internal/processed/bulk/umls/<release>/`) and is never
  placed in a publicly-servable path or in the public snapshot file list.

Cross-links published on disease / trial records use the same discipline: each
public `snomed_links` item is EXACTLY `{ snomed_sid, confidence, match_method }`.
`snomed_sid` is the pure Sciweon hash; `confidence` (a numeric scalar) and
`match_method` (a lineage tag) are 100% Sciweon-produced provenance computed
offline. No cui / code / str ever appears in a link. ALL links are published
(high AND low confidence) so the licensed consumer can filter; the platform
never withholds evidence.

## How sid_s is derived (the bridge anchor)

For the `snomed_concept` entity class:

```
sid_s = sha256(
  "sciweon:snomed_concept:snomed.concept.v1.0:SNOMEDCT_US:" + CODE
).hexdigest()[:32]
```

where `CODE` is the SNOMED CT US concept code (SCTID) exactly as it appears in
the MRCONSO `CODE` column for rows with `SAB = SNOMEDCT_US`. The anchor is
content-addressed on the code ONLY (never the mutable preferred string), so the
hash is stable across releases and string revisions.

Worked numeric example (code only, no SNOMED strings):

```
CODE 73211009  -> sid_s a409595b11d0aabe31aecd559a84e04a
CODE 38341003  -> sid_s b42be5e83138ee10246972aba4ec248d
```

## Compliant rehydration for a licensed researcher

A researcher who holds their OWN UMLS / SNOMED CT license can recover the
SNOMED CODE and string for any Sciweon SID without Sciweon ever shipping SNOMED
content. NO CUI is needed.

1. License prerequisite: obtain a UMLS license (https://uts.nlm.nih.gov) and
   download the UMLS Metathesaurus MRCONSO.RRF. This is YOUR licensed copy.

2. Iterate YOUR local MRCONSO rows where `SAB = SNOMEDCT_US`. For each such row,
   take the `CODE` and the `STR`, and recompute the same Sciweon anchor:

   ```python
   import hashlib
   def sciweon_snomed_sid_s(code):
       payload = "sciweon:snomed_concept:snomed.concept.v1.0:SNOMEDCT_US:" + code
       return hashlib.sha256(payload.encode()).hexdigest()[:32]
   ```

3. Build a local map `sid_s -> { code, str }` from your licensed MRCONSO.

4. Join Sciweon's published `sid_s` (from `snomed-concepts-public.jsonl`, or from
   any `snomed_links[].snomed_sid` on a disease / trial record) against your
   local map. The matching entry gives you back the SNOMED CODE and string --
   from YOUR licensed data, never from Sciweon.

Because the join key is a Sciweon-original hash derived from the code, the
researcher's licensed MRCONSO is the only place SNOMED content lives in the
rehydrated dataset. Sciweon ships only the hashes plus its own provenance.

## License prerequisite notice

Rehydrating SNOMED CODE / STR from the published Sciweon SIDs requires a valid
UMLS Metathesaurus / SNOMED CT Affiliate license held by the consumer. Sciweon
publishes only Sciweon-produced SID hashes and Sciweon-produced provenance and
makes no SNOMED content available to non-licensees.
