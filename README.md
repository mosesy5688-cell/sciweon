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
2. **Data quality is the lifeline.** Six intended quality properties: machine-readable
   types, validation, explicit gaps, provenance, quantified confidence and negative
   evidence. These are design commitments and are enforced to differing degrees; they
   are not claimed as uniformly enforced today.

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
| Not in any approved plane | UniProt, UniChem -- Gate-5B placed no field of either in an output plane |

Any source or field **not** in that adjudicated set is unresolved, and must be
treated as restricted rather than assumed open.

### Two different things, kept apart

**What Gate-5B APPROVED FOR OUTPUT** is the 25-field set above. UniProt and
UniChem have no field in any approved plane, so nothing from them is approved
for output. That is an adjudication outcome about what may be published.

**What the RUNTIME ACTUALLY ENFORCES** today is narrower and different: a
limited MedDRA/KEGG containment filter at the serving boundary. There is no
runtime mechanism that enforces the 25-field allowlist, and none that enforces
the UniProt or UniChem position.

An adjudication is not an enforcement. This repository should not be read as
providing per-field rights enforcement, and a reader must not infer from the
approved-plane table that a runtime control exists behind it.

The code licence conveys no data, model, trademark or name rights. Anyone
reusing Sciweon output must comply with the most restrictive applicable
upstream terms for the specific fields they use, and should verify those terms
against the upstream source rather than relying on this file.

Sciweon makes no warranty as to upstream accuracy or completeness.

**Research use only.** Sciweon reports observed records with their provenance.
It does not assess causality or clinical significance and makes no clinical,
diagnostic, dosing or regulatory recommendation.
