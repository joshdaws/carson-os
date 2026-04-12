# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in CarsonOS, please report it responsibly.

**Do not open a public issue.** Instead, email security concerns to josh@joshdaws.com with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

I'll respond within 48 hours and work with you on a fix before any public disclosure.

## Scope

CarsonOS is a self-hosted application that runs on localhost. The primary threat model is:

- **Local process attacks** -- other software on the same machine accessing the API
- **Cross-origin attacks** -- malicious websites making requests to localhost
- **Prompt injection** -- manipulating agent behavior through user-controlled content
- **Data exposure** -- sensitive family data (conversations, profiles, bot tokens) leaking

## Known Limitations (v0.1)

These are documented, not bugs:

- **No API authentication** -- all API routes are unauthenticated. Mitigated by localhost-only binding and CORS.
- **Telegram bot tokens stored in plaintext** -- in the SQLite database. Same threat model as the DB file itself.
- **Hard evaluators disabled** -- constitution enforcement is prompt-based only. Hard clause evaluators (keyword_block, age_gate) are built but feature-flagged off.
- **bypassPermissions on Agent SDK** -- required for autonomous operation. Trust levels are the mitigation.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
