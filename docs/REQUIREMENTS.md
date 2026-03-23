# BDRClaw Requirements

Original requirements and design decisions for the BDRClaw sales development platform.

---

## Why This Exists

BDRClaw is what happens when you give a world-class BDR an AI brain, a memory system, and access to every sales tool in your stack — running securely in its own container so it can't go rogue, can't leak data, and can be audited line by line.

Built as an open-core fork of NanoClaw, BDRClaw repurposes the lightweight container-isolated agent framework for automated sales development: prospecting, outreach, follow-up, and CRM hygiene across every channel.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems, agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Each prospect gets their own container sandbox. A compromised LinkedIn skill cannot access Gmail credentials — separate containers, separate mounts.

### AI-Native Development

No installation wizard — Claude Code guides the setup. No monitoring dashboard — ask Claude what's happening. No debugging tools — describe the problem and Claude fixes it. The codebase assumes you have an AI collaborator.

### Skills Over Features

New integrations ship as installable skills (`/add-hubspot`, `/add-linkedin`, `/add-apollo`), not as bloat in the core. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need.

### Open Core Model

The base framework is MIT. Premium skills (LinkedIn automation, CRM integrations, enrichment providers, advanced intelligence) are the moat.

---

## What BDRClaw Automates

Everything a BDR does except getting on a call:

- Cold outreach sequences (multi-channel, multi-step)
- LinkedIn DMs + connection requests
- Email follow-ups
- SMS sequences
- Slack / WhatsApp / Telegram outreach
- Contact enrichment
- CRM hygiene + deal stage updates
- Pipeline review + follow-up queue
- Lead scoring + prioritization
- Meeting booking

---

## Architecture Decisions

### Per-Prospect Isolation

Each prospect gets their own `CLAUDE.md` memory file, isolated filesystem context, and runs in its own container sandbox. The agent that handles Acme Corp cannot see data from Widget Co.

### Prospect Data Model

Each prospect lives at `prospects/{id}/CLAUDE.md` with structured sections: Identity, Pipeline Stage, Touchpoint History, Notes, Next Action. This is the agent's memory for that prospect.

### Sequence Engine

Sequences are defined in `sequences/*.md` with steps (day + channel + action) and exit conditions. The agent reads the sequence, checks the prospect's touchpoint history, and executes only the next appropriate step — never double-sending across channels.

### BDR Brain Scheduler

A master scheduled agent runs on a configurable cadence (default: daily at 7am):
- Reviews the full pipeline
- Scores and prioritizes leads
- Queues follow-up actions across channels
- Flags hot leads for human review
- Triggers next steps in active sequences

### Skill Branches

Integrations ship as Git branches, not PRs to main. Users run `/add-hubspot` and get clean code that does exactly what they need — not a system trying to support every CRM at once.

### Channel System

The core ships with no channels built in. Each channel is installed as a skill that self-registers at startup. Channels with missing credentials are skipped.

### Message Routing

- Trigger: `@BDR` prefix (configurable via `TRIGGER_WORD` env var)
- Main channel receives pipeline reports and admin commands
- Outbound messages route through the channel registry to the appropriate channel

### Auto-Send vs. Human Review

`AUTO_SEND=false` (default) queues all outreach for human review before sending. `AUTO_SEND=true` allows the agent to send without review. This is the primary safety valve for outbound communication.

---

## RFS (Request for Skills)

Skills we'd love contributors to build:

### Core (Free)
- `/add-gmail` — Gmail / SMTP outreach
- `/add-telegram` — Telegram channel
- `/add-whatsapp` — WhatsApp channel
- `/add-slack` — Slack channel

### Pro
- `/add-linkedin` — LinkedIn DM + connection automation
- `/add-hubspot` — Full CRM sync (deals, contacts, activities)
- `/add-salesforce` — Salesforce integration
- `/add-attio` — Attio CRM sync
- `/add-apollo` — Contact enrichment + lead import
- `/add-sms` — Twilio SMS sequences
- `/add-cal` — Cal.com / Calendly booking automation
- `/add-clearbit` — Company enrichment

---

## Vision

An AI sales development agent accessible via any channel, with per-prospect memory, automated sequences, and CRM integration.

**Core components:**
- **Claude Agent SDK** as the core agent
- **Containers** for isolated agent execution (Linux VMs)
- **Multi-channel** I/O (Gmail, LinkedIn, SMS, Slack, WhatsApp, Telegram, Discord)
- **Per-prospect memory** via `prospects/*/CLAUDE.md`
- **Sequence engine** for multi-step outreach
- **BDR Brain scheduler** for daily pipeline review
- **CRM integration** via skills

**Implementation approach:**
- Fork NanoClaw, rebrand to BDRClaw
- Extend the group/memory system for prospect isolation
- Add sequence engine (step runner, exit conditions, multi-channel dedup)
- Add BDR Brain scheduled agent
- Ship channel integrations as skills (core free, premium paid)
