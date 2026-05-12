# Sciweon — AI-Driven Scientific Discovery

**"Where AI Agents Do Science"**
**"Sci. We. On."** — Science. We. On it.

Sciweon is the data foundation for AI agents doing scientific discovery. We aggregate, validate, and serve cross-database scientific data designed for AI Agent consumption — not human browsing.

## Status

🟢 Phase 1 — V0.1a in development (architecture + PubChem adapter + 1000 compound validation)

## Vertical Products

| Product | Status | Headline |
|---------|--------|----------|
| **Sciweon Drug** | V0.1 active | "AI-Driven Drug Discovery" — PubChem + ChEMBL + ClinicalTrials.gov + Papers |
| Sciweon Material | V0.5+ planned | "AI-Driven Materials Discovery" |
| Sciweon Bio | V0.7+ planned | "AI-Driven Biotechnology Research" |

## First Principles (Constitutional)

1. **AI Agent is the direct user, not humans.** API + MCP server are the only deliverables for V0.1-0.4. No interactive UI.
2. **Data quality is the lifeline.** All data must be safe for AI Agent consumption. 6 quality principles enforced via Validation Gate.

See `docs/PRINCIPLES.md` for detail.

## Architecture

- Pipeline (1/4 → 4/4 daily cron) for batch ingestion
- Strict schema with type + unit + range validation
- Provenance Graph (every datapoint traceable)
- Confidence Scoring (cross-source consensus)
- Negative Evidence DB (V0.4+ moat)
- MCP + API delivery layer

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT (data follows source licenses: CC0 / Public Domain / CC BY)

---

Built on architecture validated by [Free2AITools](https://github.com/mosesy5688-cell/ai-nexus) (AI/ML data pipeline, 500K+ entities).
