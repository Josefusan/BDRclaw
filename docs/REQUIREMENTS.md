# BDRclaw Requirements

Design decisions and requirements for the BDRclaw sales development platform.

---

## Why This Exists

BDRclaw is an AI-native BDR team that automates top-of-funnel sales activity. It runs Claude agents in isolated Linux containers, connects to every channel a prospect lives on, and orchestrates multi-touch outreach sequences autonomously.

The goal is to eliminate cognitive load from prospecting, sequencing, enrichment, and CRM hygiene — so the human closer can focus exclusively on qualified conversations.

Built as a fork of NanoClaw, repurposed for automated sales development.

---

## Design Principles

### Small Enough to Understand

One Node.js process. A handful of source files. No microservices. If you want to understand the full BDRclaw codebase, ask Claude Code to walk you through it.

### Secure by Isolation

Agents run in Linux containers (Docker or Apple Container). They can only access explicitly mounted directories. Bash access is safe because commands run inside the container, not on the host. Security is OS-level, not application-level.

### Prospect-First Memory Model

Each prospect gets their own isolated `CLAUDE.md` context file. Agents read this file before taking any action on a prospect. All decisions are grounded in history.

### Skills Over Features

New capabilities are added via Claude Code skills (`/add-hubspot`, `/add-linkedin`) that modify the user's fork. The core codebase stays minimal. Users get clean code that does exactly what they need.

### Open Core

The base framework is MIT licensed. Premium skills (advanced AI scoring, multi-touch attribution, enterprise CRM connectors) are maintained separately under a commercial license.

---

## Architecture Decisions

### Per-Prospect Isolation

Each prospect gets their own `CLAUDE.md` memory file, isolated filesystem context, and runs in its own container sandbox. The agent handling Acme Corp cannot see data from Widget Co.

### BDR Brain

The BDR Brain (`src/bdr-brain.ts`) is a scheduled agent (default: daily at 6am) that reviews the full pipeline, detects buying signals, classifies replies, and queues follow-up actions.

### Sequence Engine

Sequences are defined as markdown files with touches (day + channel + action) and personalization variables. The `{custom_line}` variable is filled by Claude at send time — no two emails are identical.

### CRM as Sync Target

BDRclaw treats CRM as a sync target, not a system of record. The system of record is `prospects/*/CLAUDE.md`.

### Channel Self-Registration

The core ships with no channels built in. Each channel is installed as a skill that self-registers at startup via `src/channels/registry.ts`. Channels with missing credentials are skipped.

### Auto-Send vs. Human Review

Outbound actions default to queued-for-review. `AUTO_SEND=true` allows the agent to send without review.

---

## What BDRclaw Automates

Everything a BDR does except getting on a call:

- Multi-step cold email sequences with reply detection
- LinkedIn connection requests + DM sequences
- Twilio SMS outreach
- Slack Connect SDR sequences
- WhatsApp warm outreach
- Contact enrichment (Apollo, Hunter, Clay)
- CRM sync (HubSpot, Attio, Salesforce, Pipedrive, Close)
- Pipeline review + follow-up queue
- Buying signal detection (job changes, funding rounds, website visits)
- Reply classification (interested / not interested / referral / unsubscribe / OOO)
- Meeting booking detection + closer handoff

---

## Non-Goals

BDRclaw will not:
- Replace a CRM (it syncs to one)
- Get on calls (human closers do that)
- Send spam (all sequences are permission-aware and comply-unsubscribe)
- Become a monolithic sales platform
- Add features to core that belong in skills

---

## RFS (Request for Skills)

Skills we'd like to see contributed:

- `/add-salesforce` — Salesforce CRM sync
- `/add-outreach` — Outreach.io sequence integration
- `/add-apollo-sequences` — Apollo sequence automation
- `/add-signal` — Signal messaging channel
- `/add-instagram-dm` — Instagram DM outreach
- `/add-twitter-dm` — Twitter/X DM outreach
