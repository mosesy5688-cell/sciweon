# Contributing to Sciweon

Sciweon is data infrastructure for AI agents — cross-source structured
intelligence pipeline serving the AI for Science ecosystem. Contributions
that improve data quality, expand source coverage, or sharpen the Agent
integration surface are welcome.

This is an early-stage project. Foundational architecture is locked but
implementation surfaces are actively evolving.

## Quick start

```sh
# Prerequisites: Node 22+, Python 3.10+
git clone https://github.com/mosesy5688-cell/sciweon
cd sciweon
npm install

# Run the local landing page
npm run dev

# Run the compliance gatekeeper (CES) — required to pass CI
npm run ces

# Run unit + contract tests
npm test
```

## Repository layout

```
src/
  pages/             Astro static site (landing only)
  lib/schemas/       Sciweon entity schemas (Compound / Trial / Paper /
                     Bioactivity / NegEvidence)
  worker/            Cloudflare Worker (API endpoints + R2 read layer)
scripts/
  factory/           4-stage harvest → process → aggregate → upload chain
    lib/             Shared factory helpers (R2 bridge, validation gate,
                     retry queue, etc.)
  ingestion/adapters/  Per-source data adapters (PubChem, ChEMBL, etc.)
  validation/        Agent simulator + verify-fixes utilities
  data-quality/      Per-principle audit script
  check_compliance.py  CES gatekeeper (file size, secret patterns, IP
                       protection)
tests/               Vitest unit + contract tests
.github/workflows/   CI + factory cron + deploy
```

## Code rules

These are enforced by `scripts/check_compliance.py` (CES) which CI runs on
every PR. CI failure = PR cannot merge.

1. **Anti-monolith** (Article 5.1): No source file > 250 lines.
2. **Security**: No D1 credentials, JWT tokens, GitHub PATs, OpenAI keys,
   AWS keys, or any other secrets committed in code. CES grep blocks all
   common secret patterns.
3. **English mandate** (Article 8.1): Code, comments, commit messages, PR
   descriptions, and documentation in English. Non-ASCII characters in
   code/comments are CES violations.
4. **IP protection** (Article 9.1): Internal strategy / planning / audit
   documents must never enter the repo. `.gitignore` blocks filename
   patterns; CES blocks by content.
5. **Primary-data-only**: Adapters extract raw primary fields; never
   consume upstream curators' secondary classifications. If you add a new
   source, the PR must document the primary fields collected and explain
   why any derived/curated fields are excluded.

## Commit messages

Conventional Commits style. Examples:

```
feat(api): add /api/v1/search endpoint
fix(schema): widen compound log_p.value max 30 -> 80
chore(deps): bump vitest to 2.1.10
docs(setup): clarify R2 secret configuration steps
test(api): add contract test for out-of-corpus response
```

Body: explain WHY the change. Reference issue numbers if applicable.

## PR flow

1. **Fork** the repo + create a feature branch (`feat/...`, `fix/...`,
   `chore/...`, `docs/...`, `test/...`).
2. **Make your change** + run `npm test` + `npm run ces` locally.
3. **Open a PR** against `main`. Use the PR template provided.
4. **CI must pass** (4 checks: enforce-compliance / schema-validate /
   security-scan / test).
5. **Wait for review**. The repo owner reviews every PR (CODEOWNERS
   policy). Solo maintainer = expect 1-7 day turnaround.
6. **Address feedback** if requested. Push new commits to the same branch.
7. **Merge** is done by the owner via squash-merge only.

## What's in scope

Welcomed:

- Bug fixes in factory pipeline, adapters, validation logic
- New source adapters (must follow primary-data-only contract)
- Schema improvements (widening evidence-based; new field additions)
- API endpoint hardening (error contract, response shape consistency)
- Test coverage additions
- Documentation improvements
- Performance optimizations with measured benefit

Out of scope:

- Architecture changes without prior discussion (open a Discussion first)
- Marketing copy / positioning changes
- Adding closed-source / commercial-only dependencies
- Strategic / planning documents (blocked by CES Art 9.1)
- Auto-generated dependency-bump PRs without rationale
- Auto-scanner findings (SafeSkill-style PRs) without verified context

## Data adapter contributions

If you add a new source adapter:

1. Create `scripts/ingestion/adapters/<source>-adapter.js`
2. Document the upstream license in `LICENSE` data-license section
3. Document primary fields collected (entity by entity)
4. Document what secondary/derived fields are explicitly NOT consumed
5. Add the source to KNOWN_SOURCES in `scripts/factory/source-health-monitor.js`
6. Update the appropriate entity schema with new provenance source enum
7. Include test coverage in `tests/`

## Reporting bugs / issues

For now Issues are limited to verified reproducible bugs. For:

- Security: see `SECURITY.md` (private email, never open public issue)
- Feature ideas: open a Discussion (Issues disabled for ideation)
- Data quality concerns: include the entity ID + specific field + expected
  vs observed value + source URL

## Code of conduct

This project follows the
[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)
v2.1. Be respectful, focus on technical merit, assume good faith.

Spam PRs (automated scanner findings without verified context, badge-pushing
PRs, etc.) are subject to interaction limits and account-level blocking.
This is not censorship — it is reduction of noise.
