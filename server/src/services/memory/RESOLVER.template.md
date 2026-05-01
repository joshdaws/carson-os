# RESOLVER — How to file family memory

You (the agent) decide where information goes by following this file.
Edit the **Family overrides** section at the bottom for household-specific
quirks not covered by the defaults.

## Two-layer rule (entity types only)

Eight types are **entities** with two-layer pages: `person`, `project`,
`place`, `media`, `relationship`, `commitment`, `goal`, `concept`.

- **Below `---` — atoms.** Append-only timeline with full provenance.
  Never mutated. Atoms are the truth.
- **Above `---` — compiled view.** v5.0: you write it. v5.1: regenerated
  nightly from the atoms. If wrong, append a corrective atom — never edit
  the compiled view directly.

The other six (`fact`, `preference`, `event`, `decision`, `routine`,
`skill`) are flat memories without a compiled view.

## The 14 types

- **fact** — verifiable claim about the world.
- **preference** — individual taste, value, or opinion.
- **event** — one-shot dated happening.
- **routine** — recurring pattern.
- **decision** — moment-in-time choice the family or person made.
- **commitment** — active promise with a counterparty and expected
  fulfillment.
- **goal** — future-state aspiration without a specific promise.
- **skill** — ability or competency held by a person.
- **person** — human entity outside the immediate family.
- **project** — coherent multi-step effort.
- **media** — book, movie, song, podcast, article, or game.
- **place** — physical or virtual location.
- **relationship** — connection between two people or entities.
- **concept** — reusable mental model, framework, or family value that
  predates and outlasts specific decisions.

## Disambiguation tests

Run these when two types both seem plausible:

- **fact vs concept** — observable claim → `fact`. Stance the family
  takes → `concept`.
- **preference vs concept** — personal taste → `preference`. Teachable
  framework → `concept`.
- **decision vs concept** — resolves a specific question → `decision`.
  Predates and outlasts the question → `concept`.
- **event vs routine** — one-shot → `event`. Recurring → `routine`.
- **commitment vs goal** — active obligation with counterparty →
  `commitment`. Aspiration → `goal`.
- **commitment vs decision** — promised future action → `commitment`.
  Choice already made → `decision`.
- **skill vs preference** — ability → `skill`. Taste → `preference`.
- **person vs relationship** — a human → `person`. The connection between
  two → `relationship`.

## Family overrides

<!--
Household-specific filing rules go here. Examples:

- "Wonderland production = `project`, not a series of `event` memories."
- "Grandparents are `person`, not `relationship`."
- "Medication info is always `verbatim: true` (exact dose matters)."
- "Always alias 'Mom' → 'becca' and 'Dad' → 'josh' for the kids' agents."
-->
