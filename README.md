# Sciweon

**Data infrastructure for AI agents.**

Cross-industry scientific data and evidence infrastructure, so AI agents get cross-source facts, provenance, quantified confidence, and the rights state of every value — not guesses.

Landing: [sciweon.com](https://sciweon.com)

## Domains

| Domain | Status | Notes |
|--------|--------|-------|
| Drug Discovery | Alpha | Compound / bioactivity / clinical trial / regulatory data |

Pharmaceutical and life-science work is the first commercial beachhead, not the
limit of the architecture. Additional scientific domains are planned; none is
announced.

## For AI agents

API and MCP server are in private alpha. Public access targeting Q3 2026.
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

Every API response carries the identity of the snapshot it was served from.
Snapshots are immutable and retained, so any result can be re-derived exactly.
**No refresh cadence is promised**; read `snapshot_date` on the response rather
than assuming currency.

## License

**Code: MIT** (see `LICENSE`). This covers the source in this repository and
nothing else.

**Data: not a single licence, and not all redistributable.** Rights are
qualified **per source and per field**, not per dataset. The short version:

| Class | Example sources | Redistribution |
|-------|-----------------|----------------|
| Field-qualified public | PubChem | Per-field; NCBI transfers no third-party rights, and depositor-contributed fields may carry their own terms |
| Share-alike | ChEMBL (CC BY-SA 3.0 Unported) | Attribution **and** share-alike attach to distributed derivatives |
| Attribution-only, no licence granted | PubMed / NLM | Attribution required; NLM additionally requires a currency disclosure when data is republished |
| Withheld | UniProt, UniChem, MedDRA, KEGG | Not served and not redistributed |

The code licence says nothing about the data licence, and a permissive code
licence does not make any bundled or served data permissive. Anyone reusing
Sciweon output must comply with the most restrictive applicable upstream terms
for the specific fields they use.

Sciweon makes no warranty as to upstream accuracy or completeness.

**Research use only.** Sciweon reports observed records with provenance. It
does not assess causality or clinical significance and makes no clinical,
diagnostic, dosing or regulatory recommendation.
