# Replication Playbook — captured reusable prompt

> This is a **template**, not a task that ran. It's the "build once, deploy everywhere" workflow
> rendered as a reusable Claude Code prompt (derived, not verbatim, from the Replication Playbook
> source). Keep it here; paste it when you want to extract a working BDRclaw subsystem into a
> redeployable standard and roll it out to another project.

## When to use it

BDRclaw already has replication-shaped subsystems — the self-registering **channel skill**
pattern (`src/channels/registry.ts` + `src/channels/*.ts` + `src/*-bdr-actions.ts`), the
per-prospect isolated memory (`prospects/*/CLAUDE.md`), and the sequence engine
(`groups/*/sequences/*.md`). When you want to turn one of those into a standard that deploys to a
new channel/integration/site in an hour instead of a week, use the prompt below.

## The prompt

```text
I have a working implementation of [SYSTEM] in [PROJECT A]. I want to
turn it into a redeployable standard so deploying it to [PROJECT B]
takes an hour instead of weeks.

PHASE 1 — Extract the standard (investigation only, do not modify
[PROJECT A]):

1. Read the [PROJECT A] implementation end to end.
2. Split it into two parts:
   - SHARED FOUNDATION: what every deployment needs regardless of
     site (architecture, storage schema, session handling, detection
     logic, debug mode, QA)
   - MODULE CATALOG: independently deployable units. Each module gets
     its own section covering: business purpose, event/data schema,
     client-side code, server-side functions, downstream metrics,
     acceptance criteria, and bugs/lessons learned from [PROJECT A].
3. For each module, explicitly state which project types need it and
   which don't. Not every module ships everywhere — that's the point.
4. List every value that must change per deployment (identifiers,
   storage key prefixes, namespacing) as a config block at the top.

Save to docs/standards/[SYSTEM]_STANDARD.md and STOP.

PHASE 2 — Deploy to [PROJECT B] (after I approve Phase 1):

1. Read the standard. Given that [PROJECT B] is a [TYPE] with
   [CHARACTERISTICS], tell me which modules apply and which to skip.
   Justify each exclusion.
2. Generate the implementation for the selected modules only, with
   the per-deployment config values set for [PROJECT B].
3. Write automated tests that trigger each module and verify the
   payloads. Add a debug mode flag that logs every event and response
   to console.
4. Run the tests. Report what passed and what didn't.

PHASE 3 — Feed back:
Any bug found or pattern learned during the [PROJECT B] deployment
gets appended to the standard, so deployment three is faster than
deployment two.
```

## BDRclaw-specific fill-ins (examples)

- `[SYSTEM]` = "channel skill" · `[PROJECT A]` = BDRclaw's Gmail/SMS channels · `[PROJECT B]` = a new channel (e.g. Discord).
- The per-deployment config block for a new channel: channel id in `registry.ts`, daily-cap env var (`*_DAILY_MSG_LIMIT`), compliance rule in `src/channels/compliance.ts`, warm-only vs cold policy, and the `*-bdr-actions.ts` action wrapper.
- Feed Phase-3 lessons back into `docs/claude/INVESTIGATIONS.md` and `ISA.md`.
