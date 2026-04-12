# Changelog

All notable changes to CarsonOS will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - 2026-04-11

Initial open source release.

### Added

- **Onboarding:** 3-step setup flow (Family, Agent, Done) with Telegram bot token entry
- **Constitution engine:** Prompt-based enforcement with constitution-first system prompt ordering
- **Memory system:** 13 memory types (fact, preference, event, decision, commitment, person, project, media, place, routine, relationship, goal, skill) backed by QMD markdown search
- **Memory tools:** search_memory, save_memory, update_memory, delete_memory, update_instructions with dedup (search before save)
- **Google integration:** Calendar (list, create, get events), Gmail (triage, read, compose, reply, drafts), Drive (search, list) via gws CLI
- **Claude Agent SDK adapter:** Streaming responses, MCP tool execution, session resume, model selection (Sonnet 4.6, Opus 4.6, Haiku 4.5)
- **Trust levels:** Full (Bash + all tools), Standard (read-only), Restricted (memory tools only)
- **Telegram streaming:** Edit-in-place with markdown-aware formatting and debouncing
- **Dashboard:** Household overview, family member cards, agent management, Getting Started checklist
- **Staff management:** Add/edit agents with modal form, model selector, trust level, Telegram bot config, tool grants, operating instructions, personality interviews
- **Profile interviews:** First-contact behavior suggests profile interview instead of auto-compiling
- **Personality interviews:** Build agent personality through guided conversation
- **Constitution interviews:** Build family constitution through guided conversation
- **Settings page:** Adapter config, household name/timezone (loads from DB correctly)
- **Conversations page:** View conversation history with member/staff filters
- **Dev sandbox:** `pnpm dev:sandbox` for isolated development on port 3301
- **Security:** CORS middleware (same-origin only), member slug sanitization (path traversal prevention)
- **setup.sh:** Prerequisite checks, dependency install, data directory creation
- **MIT license**
