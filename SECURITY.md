# Security Policy

## Reporting a vulnerability

Please report security issues **privately** rather than opening a public
issue or PR:

- Email: **hello@sciweon.com**
- Subject prefix: `[SECURITY]`
- PGP / encrypted channels: not currently supported; plain email is OK

Include:

- A clear description of the vulnerability
- Steps to reproduce (proof-of-concept code is welcome)
- Affected versions / commits if known
- Your suggested fix if any

We will acknowledge receipt within 7 days and aim to provide a status
update within 30 days. We may request additional information.

## What we consider in-scope

- Authentication / authorization bypass
- Remote code execution
- SQL / command injection
- Server-side request forgery (SSRF) against the API surface
- Data exposure via the API beyond documented response shape
- Cache poisoning of R2 / Cloudflare Worker isolates
- Dependency vulnerabilities that materially affect Sciweon

## What we consider out-of-scope (please do not report)

- Automated scanner findings (SafeSkill-style "20/100" scores) without
  context demonstrating actual exploitability. Sciweon uses standard
  Node + Cloudflare Workers patterns; raw pattern matches from scanners
  are not actionable security reports.
- Social engineering targeting the maintainer or Cloudflare account
- Physical attacks against contributors
- Vulnerabilities in third-party services we consume (PubChem, ChEMBL,
  Cloudflare R2, etc.) — please report to the respective provider
- Best-practice suggestions ("you should add Content-Security-Policy
  header") without demonstrated attack scenario. Open a Discussion
  instead.

## Public disclosure

We will coordinate public disclosure with you after a fix is shipped.
Default timeline: 90 days from initial report. Critical issues with
active exploitation may be disclosed sooner.

## Acknowledgments

Researchers who report verified security issues will be acknowledged in
the release notes for the fix (unless you prefer anonymity).
