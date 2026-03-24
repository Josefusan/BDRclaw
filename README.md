# BDRclaw

> **The AI SDR team that never sleeps — books qualified meetings while you close deals.**

A lightweight AI-native BDR team that runs in containers. Connects to your CRM, email, LinkedIn, Slack, and SMS so you can focus on closing without burning cognitive load.

Built on the [Anthropic Agents SDK](https://docs.anthropic.com/en/docs/agents). Inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw).

---

## Why BDRclaw

Most sales automation tools are dashboards. You still have to think, decide, and execute. BDRclaw is different — it's an agent team. It prospects, sequences, follows up, enriches, and syncs your CRM automatically, across every channel your buyers live on.

No SDR hire. No burned cognitive load. Just qualified pipeline.

| What BDRclaw does | What you do |
|---|---|
| Prospect on LinkedIn | Run discovery calls |
| Send cold email sequences | Handle objections |
| Follow up via SMS & Slack | Negotiate and close |
| Enrich and update CRM records | Sign contracts |
| Flag hot leads and buying signals | Collect payment |

---

## Architecture

```
Channels (Email / LinkedIn / Slack / SMS / WhatsApp)
        ↓
    SQLite queue
        ↓
  Polling loop + router
        ↓
  Container (Claude Agent SDK)  ←→  prospects/*/CLAUDE.md
        ↓
   CRM sync + outbound actions
```

- **One Node.js process.** No microservices, no orchestration hell.
- **Container-isolated agents.** Each agent runs in its own Linux container (Docker or Apple Container). Bash access is safe because commands run inside the container, not on your host.
- **Prospect memory.** Each prospect gets a `prospects/*/CLAUDE.md` — last touchpoint, stage, reply history, enrichment data.
- **Skills over features.** Capabilities are added as Claude Code skills (`/add-linkedin`, `/add-hubspot`) — you get clean code that does exactly what you need, not a bloated system.

---

## What It Automates

### Outbound Channels
- **Email** — Multi-step cold sequences, follow-ups, reply detection
- **LinkedIn** — Connection requests, DM sequences, profile enrichment
- **SMS** — Twilio-powered text outreach
- **Slack** — SDR sequences via Slack Connect
- **WhatsApp** — Warm outreach for international prospects

### CRM & Enrichment
- **HubSpot / Attio / Salesforce** — Auto-create contacts, log touches, update stages
- **Apollo / Hunter / Clay** — Email finding and contact enrichment
- **LinkedIn Sales Navigator** — Signal-based prospecting

### Intelligence Layer
- Daily BDR brain: reviews pipeline, queues follow-ups, flags hot leads
- Buying signal detection (job changes, funding rounds, website visits)
- Reply classification (interested / not interested / referral / unsubscribe)
- Meeting booked → CRM stage auto-update → notify closer

---

## Quick Start

```bash
gh repo fork Josefusan/BDRclaw --clone
cd BDRclaw
claude
```

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup and service configuration.

> Commands prefixed with `/` are Claude Code skills. Type them inside the `claude` CLI prompt, not your terminal. If you don't have Claude Code, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

---

## Skills

BDRclaw is extended via skills — Claude Code commands that modify your fork cleanly.

### Available Skills

| Skill | Description |
|---|---|
| `/add-gmail` | Cold email sequences + reply detection |
| `/add-linkedin` | LinkedIn prospecting + DM sequences |
| `/add-hubspot` | CRM sync, stage updates, contact creation |
| `/add-attio` | Attio CRM integration |
| `/add-apollo` | Contact enrichment + email finding |
| `/add-twilio` | SMS outreach |
| `/add-slack-outreach` | Slack Connect SDR sequences |
| `/add-whatsapp` | WhatsApp outreach channel |
| `/add-calendly` | Meeting link injection + booking detection |
| `/add-clay` | Clay enrichment workflows |

### Open Core Model

The base BDRclaw framework is MIT licensed. Premium skills (advanced sequencing logic, multi-touch attribution, AI reply scoring) are maintained separately.

> The base framework is MIT. Premium skills are the moat.

---

## Prospect Memory Model

Each prospect gets an isolated context file:

```
prospects/
  john-smith-acme/
    CLAUDE.md       ← touchpoint history, stage, enrichment, notes
  sarah-jones-beta/
    CLAUDE.md
```

The BDR brain reads these files during its daily cycle and decides what action to take next per prospect, per channel.

---

## Customizing

BDRclaw doesn't use configuration files. To make changes, tell Claude Code what you want:

```
"Change the follow-up cadence to 3 days between touches"
"Add a P.S. line to all cold emails mentioning their recent funding round"
"Only prospect companies between 50-500 employees in SaaS"
"Flag any reply that mentions a competitor"
```

Or run `/customize` for guided changes.

---

## Requirements

- macOS or Linux
- Node.js 20+
- Claude Code
- Apple Container (macOS) or Docker (macOS/Linux)
- Anthropic API key

---

## Key Files

```
src/index.ts              — Orchestrator: state, message loop, agent invocation
src/channels/registry.ts  — Channel registry (self-registration at startup)
src/router.ts             — Message formatting and outbound routing
src/container-runner.ts   — Spawns streaming agent containers
src/task-scheduler.ts     — Runs scheduled BDR tasks
src/db.ts                 — SQLite operations
prospects/*/CLAUDE.md     — Per-prospect memory
groups/*/CLAUDE.md        — Per-channel group memory
docs/SPEC.md              — Full architecture and data model spec
```

---

## Philosophy

**Small enough to understand.** One process, a few source files. Ask Claude Code to walk you through the entire codebase.

**Secure by isolation.** Agents run in Linux containers, not behind application-level permission checks. They can only see explicitly mounted directories.

**Built for individual sellers and small teams.** Not a monolithic CRM replacement. BDRclaw fits around your existing stack and does the work you don't want to do.

**AI-native.**
- No setup wizard — Claude Code guides setup
- No monitoring dashboard — ask Claude what's happening
- No debugging tools — describe the problem and Claude fixes it

**Skills over features.** Don't add Salesforce to the core codebase. Add a `/add-salesforce` skill. You end up with clean code that does exactly what you need.

---

## Contributing

Don't add features. Add skills.

If you want to add Salesforce support, don't open a PR that adds Salesforce to the core codebase. Fork BDRclaw, make the changes on a branch, and open a PR. We'll create a `skill/salesforce` branch others can merge into their fork.

Only security fixes, bug fixes, and clear improvements will be accepted to base. Everything else lives as a skill.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Request for Skills (RFS)

Skills we'd like to see:

- `/add-salesforce` — Salesforce CRM sync
- `/add-outreach` — Outreach.io sequence integration
- `/add-apollo-sequences` — Apollo sequence automation
- `/add-signal` — Signal messaging channel
- `/add-instagram-dm` — Instagram DM outreach
- `/add-twitter-dm` — Twitter/X DM outreach

---

## Credits

Built on concepts from [NanoClaw](https://github.com/qwibitai/nanoclaw) by qwibitai. MIT licensed.

---

## License

MIT — see [LICENSE](./LICENSE)

> The base framework is open. Build on it, fork it, customize it.
> Premium skills are maintained separately under a commercial license.
