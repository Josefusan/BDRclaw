# BDRClaw

> **A lightweight, container-isolated AI sales development platform built on Anthropic's Agent SDK.**
> Automates prospecting, outreach, follow-up, and CRM hygiene across every channel — LinkedIn, email, SMS, Slack, WhatsApp, Telegram, and Discord — so your team closes deals instead of filling spreadsheets.

---

## Vision

BDRClaw is what happens when you give a world-class BDR an AI brain, a memory system, and access to every sales tool in your stack — running securely in its own container so it can't go rogue, can't leak data, and can be audited line by line.

Built as an **open-core fork of NanoClaw**, BDRClaw keeps the same philosophy:

- **Small enough to understand.** One process, a handful of source files, no microservices.
- **Secure by isolation.** Agents run in Linux containers (Docker / Apple Container). Bash is safe because it runs inside the container, not on your host.
- **AI-native.** No setup wizard. No monitoring dashboard. No debugging tools. Ask Claude.
- **Skills over features.** New integrations ship as installable skills (`/add-hubspot`, `/add-linkedin`, `/add-apollo`), not as bloat in the core.

The base framework is MIT. Premium skills are the moat.

---

## What BDRClaw Automates

Everything a BDR does except getting on a call:

| Activity | Channel | Skill |
|---|---|---|
| Cold outreach sequences | Gmail / SMTP | `/add-gmail` |
| LinkedIn DMs + connection requests | LinkedIn | `/add-linkedin` |
| SMS follow-ups | Twilio | `/add-sms` |
| Slack prospecting | Slack | `/add-slack-outreach` |
| WhatsApp sequences | WhatsApp | `/add-whatsapp` |
| Telegram outreach | Telegram | `/add-telegram` |
| Contact enrichment | Apollo / Hunter / Clearbit | `/add-apollo` |
| CRM hygiene + deal stage updates | HubSpot / Attio / Salesforce | `/add-hubspot` |
| Pipeline review + follow-up queue | Internal scheduler | Built-in |
| Lead scoring + prioritization | Claude reasoning layer | Built-in |
| Meeting booking | Cal.com / Calendly | `/add-cal` |

---

## Architecture

```
Channels (Gmail, LinkedIn, SMS, Slack...)
        |
        v
    SQLite DB
        |
        v
   Polling Loop
        |
        v
  BDR Brain Agent  <----  prospects/*/CLAUDE.md (per-prospect memory)
        |
        v
  Container (Claude Agent SDK)
        |
        v
   Outbound Router  -->  Channel Registry  -->  Response
```

### Core Components

| File | Role |
|---|---|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel self-registration at startup |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/group-queue.ts` | Per-prospect queue with global concurrency limit |
| `src/container-runner.ts` | Spawns streaming agent containers |
| `src/task-scheduler.ts` | Runs scheduled BDR tasks (daily pipeline review, follow-up triggers) |
| `src/db.ts` | SQLite operations (prospects, touchpoints, sequences, CRM state) |
| `prospects/*/CLAUDE.md` | Per-prospect memory: last touchpoint, stage, notes, response history |

### Key Architectural Decisions

**Per-prospect isolation.** Each prospect gets their own `CLAUDE.md` memory file, isolated filesystem context, and runs in its own container sandbox. The agent that handles Acme Corp cannot see data from Widget Co.

**Skill branches.** Integrations ship as Git branches, not PRs to main. Users run `/add-hubspot` and get clean code that does exactly what they need — not a system trying to support every CRM at once.

**BDR Brain scheduler.** A master scheduled agent runs on a configurable cadence (default: daily at 7am) and:
- Reviews the full pipeline
- Scores and prioritizes leads
- Queues follow-up actions across channels
- Flags hot leads for human review
- Triggers next steps in active sequences

---

## Prospect Data Model

Each prospect lives at `prospects/{id}/CLAUDE.md` and contains:

```markdown
# Prospect: {Full Name}

## Identity
- Company: 
- Title: 
- LinkedIn: 
- Email: 
- Phone: 

## Pipeline Stage
- Stage: [new | contacted | engaged | qualified | meeting_set | closed_lost]
- Lead Score: /10
- Last Updated: 

## Touchpoint History
| Date | Channel | Message Summary | Response |
|------|---------|----------------|----------|

## Notes
- 

## Next Action
- Action: 
- Channel: 
- Scheduled: 
```

---

## Sequence Engine

BDRClaw sequences are defined in `sequences/*.md` and executed by the scheduler:

```markdown
# Sequence: Cold Outreach v1

## Steps
1. Day 0  — LinkedIn connection request (personalized note)
2. Day 2  — LinkedIn DM (value-first, no pitch)
3. Day 5  — Cold email (problem + social proof)
4. Day 8  — Email follow-up #1 (short, bump)
5. Day 12 — Email follow-up #2 (breakup email)
6. Day 15 — SMS (if phone available)

## Exit Conditions
- Reply on any channel → move to [engaged], notify human
- Meeting booked → move to [meeting_set]
- Unsubscribe / negative reply → move to [closed_lost], halt sequence
```

The agent reads the sequence, checks the prospect's touchpoint history, and executes only the next appropriate step — never double-sending across channels.

---

## Open Core Model

### What's Free (MIT)

- Core orchestrator + container runner
- SQLite message/prospect/sequence storage
- Polling loop + task scheduler
- BDR Brain agent logic
- Prospect memory system (`prospects/*/CLAUDE.md`)
- Base skills: `/add-gmail`, `/add-telegram`, `/add-whatsapp`, `/add-slack`

### What's Paid (BDRClaw Pro Skills)

- `/add-linkedin` — LinkedIn DM + connection automation
- `/add-apollo` — Contact enrichment + lead import
- `/add-hubspot` — Full CRM sync (deals, contacts, activities)
- `/add-salesforce` — Salesforce integration
- `/add-attio` — Attio CRM sync
- `/add-sms` — Twilio SMS sequences
- `/add-cal` — Cal.com / Calendly booking automation
- `/add-clearbit` — Company enrichment
- `sequences/` — Premium sequence library
- BDR Brain Pro — Advanced lead scoring, A/B sequence testing, reply classification

---

## Skills Taxonomy

Skills follow the NanoClaw pattern: each skill is a branch containing a `SKILL.md` that Claude Code uses to transform your fork.

```
skills/
  core/
    add-gmail/         SKILL.md
    add-telegram/      SKILL.md
    add-whatsapp/      SKILL.md
    add-slack/         SKILL.md
  pro/
    add-linkedin/      SKILL.md
    add-hubspot/       SKILL.md
    add-apollo/        SKILL.md
    add-sms/           SKILL.md
    add-cal/           SKILL.md
```

### Skill Interface Contract

Every skill must:
1. Self-register in `src/channels/registry.ts` at startup if credentials are present
2. Export a `send(prospectId, message)` function
3. Export a `receive()` polling function
4. Write all events to SQLite via `src/db.ts`
5. Update `prospects/{id}/CLAUDE.md` after every touchpoint

---

## BDR Brain Agent

The heart of BDRClaw. Runs on a schedule and acts as the strategic layer:

```
System Prompt (abbreviated):

You are a world-class BDR. You have access to the full prospect database,
all active sequences, and every communication channel. Your job is to:

1. Review all prospects in the pipeline
2. Score each lead 1-10 based on engagement signals
3. Identify who needs a follow-up today and on which channel
4. Draft the next message for each prospect (do not send — queue for review unless auto-send is enabled)
5. Flag any hot leads (replied, opened 3+ times, visited pricing page)
6. Update each prospect's CLAUDE.md with your assessment
7. Generate a daily pipeline summary and send to the main channel

Never send the same message twice. Never contact a prospect who has unsubscribed.
Always personalize based on the prospect's CLAUDE.md history.
```

---

## Setup

```bash
gh repo fork josephclark/bdrclaw --clone
cd bdrclaw
claude
```

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup, and service configuration.

### Requirements

- macOS or Linux
- Node.js 22+
- Claude Code
- Docker (macOS/Linux) or Apple Container (macOS)
- Anthropic API key

### Environment Variables

```env
ANTHROPIC_API_KEY=
DATABASE_URL=./data/bdrclaw.db
TRIGGER_WORD=@BDR
MAIN_CHANNEL=telegram          # your admin channel
AUTO_SEND=false                # true = agent sends without review
DAILY_BRAIN_RUN=07:00          # when BDR Brain runs each day
```

---

## Usage

From your main channel (Telegram / WhatsApp / Slack self-chat):

```
@BDR add prospect: Sarah Chen, VP Eng at Acme Corp, sarah@acme.com, linkedin.com/in/sarahchen
@BDR enroll Sarah Chen in Cold Outreach v1 sequence
@BDR what's the pipeline looking like this week
@BDR who are our hottest leads right now
@BDR pause all outreach to Acme Corp
@BDR generate a pipeline report and send it to the team Slack
@BDR mark Sarah Chen as qualified, she replied and wants a call Thursday
```

---

## Roadmap

### v0.1 — Foundation
- [ ] Fork NanoClaw, rebrand to BDRClaw
- [ ] Prospect data model + `prospects/*/CLAUDE.md` system
- [ ] Sequence engine (step runner, exit conditions, multi-channel dedup)
- [ ] BDR Brain scheduler (daily pipeline review)
- [ ] Core skills: Gmail, Telegram, Slack

### v0.2 — Outreach
- [ ] `/add-linkedin` skill (Pro)
- [ ] `/add-sms` skill via Twilio (Pro)
- [ ] `/add-apollo` for contact enrichment (Pro)
- [ ] Reply classification (interested / not interested / unsubscribe / out of office)

### v0.3 — CRM Layer
- [ ] `/add-hubspot` full sync (Pro)
- [ ] `/add-attio` sync (Pro)
- [ ] Deal stage auto-update from agent signals
- [ ] Meeting booked detection + Calendly/Cal.com hook

### v0.4 — Intelligence
- [ ] Lead scoring model (engagement signals, company fit, timing)
- [ ] A/B sequence testing
- [ ] Reply quality scoring
- [ ] Pipeline forecasting via BDR Brain

### v1.0 — Public Launch
- [ ] Website: bdrclaw.dev
- [ ] Pro skills marketplace
- [ ] Discord community
- [ ] Hosted option (no self-hosting required)

---

## Contributing

Same philosophy as NanoClaw: **don't add features, add skills.**

If you want to add Salesforce support, don't open a PR that adds Salesforce to the core. Fork BDRClaw, build the skill on a branch, and open a PR. We'll create a `skills/add-salesforce` branch others can install.

### What Gets Merged to Core
- Security fixes
- Bug fixes
- Clear improvements to the base orchestrator

### What Ships as a Skill
- New channel integrations
- CRM connectors
- Enrichment providers
- Sequence templates
- OS/platform compatibility

---

## Security

Agents run in containers, not behind application-level permission checks. A compromised LinkedIn skill cannot access your Gmail credentials — they're in separate containers with separate mounts.

See `docs/SECURITY.md` for the full model.

---

## License

Core: MIT
Pro Skills: Commercial (see `LICENSE_PRO`)

---

## Built On

- [NanoClaw](https://github.com/qwibitai/nanoclaw) — the foundation
- [Anthropic Agent SDK](https://docs.anthropic.com) — the brain
- [Claude Code](https://claude.ai/code) — the builder

---

*BDRClaw is built by [Clark Tech Ventures LLC](https://clarktechventures.com). If you're using it to close deals, we'd love to hear about it.*
