# Sciweon

**Data infrastructure for AI agents.**

Cross-industry scientific data and evidence infrastructure. Records carry the source they were built from, so an agent can check a claim instead of taking it on trust.

Landing: [sciweon.com](https://sciweon.com)

## Domains

| Domain | Status | Notes |
|--------|--------|-------|
| Drug Discovery | Alpha | Compound / bioactivity / clinical trial / regulatory data |

Pharmaceutical and life-science work is the first commercial beachhead, not the
limit of the architecture. Additional scientific domains are planned; none is
announced.

## For AI agents

API and MCP server are in private alpha. **No public release date is published.**
Request alpha access: [hello@sciweon.com](mailto:hello@sciweon.com)

## First principles

1. **Agent-first.** Designed for machines to consume directly. No human-search overhead in the data layer.
2. **Data quality is the lifeline.** Six enforced quality rules: machine-readable types + validation + explicit gaps + provenance + quantified confidence + negative evidence.

## Development

```bash
npm install
npm test
```

## Data freshness

Evidence responses report the `snapshot_date` they were served from, so an
answer can be pinned to a point in time. Read it rather than assuming currency:
**no refresh cadence is promised**, and the served snapshot may be substantially
older than today.

This does not apply to every route -- health, error and static responses carry
no snapshot identity -- and the reader still supports a legacy snapshot layout,
so exact re-derivation is not claimed as a guarantee across all historical
snapshots.

## License

**Code: MIT** (see `LICENSE`). This covers the source in this repository and
nothing else.

**Data is not covered by the MIT licence.** Data rights can vary by source, by
record, by field, by contributor, by how the value was transformed, and by the
form in which it is output. There is no single licence that describes
"Sciweon data".

What has actually been adjudicated is a **specific, frozen set of 25
rights-bearing fields** across three data planes -- not whole resources. A
source appearing below is qualified *for those adjudicated fields only*; it
does not mean the whole resource carries that class:

| Plane | Adjudicated scope |
|-------|-------------------|
| Field-qualified public | 5 named PubChem fields. Field-qualified, not a blanket public-domain grant; NCBI transfers no third-party rights and depositor-contributed fields may carry their own terms |
| Share-alike | 14 named ChEMBL fields. ChEMBL is CC BY-SA 3.0 Unported; attribution and share-alike attach to distributed derivatives |
| Bibliographic | 6 named PubMed fields. Attribution required; no licence granted. NLM additionally requires a currency disclosure when data is republished |
| Withheld | UniProt, UniChem, MedDRA, KEGG -- not served, not redistributed |

Any source or field **not** in that adjudicated set is unresolved, and must be
treated as restricted rather than assumed open.

**What the runtime actually enforces today is narrow.** There is limited
MedDRA/KEGG containment at the serving boundary. That is *not* a complete
per-field rights adjudication, and this repository should not be read as
providing one.

The code licence conveys no data, model, trademark or name rights. Anyone
reusing Sciweon output must comply with the most restrictive applicable
upstream terms for the specific fields they use, and should verify those terms
against the upstream source rather than relying on this file.

Sciweon makes no warranty as to upstream accuracy or completeness.

**Research use only.** Sciweon reports observed records with their provenance.
It does not assess causality or clinical significance and makes no clinical,
diagnostic, dosing or regulatory recommendation.
