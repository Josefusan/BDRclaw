# BDRclaw — System Specification

> Version 0.1 — March 2026
> Status: Active development

---

## 1. Purpose

BDRclaw is an AI-native BDR (Business Development Representative) team that automates top-of-funnel sales activity. It runs Claude agents in isolated Linux containers, connects to every channel a prospect lives on, and orchestrates multi-touch outreach sequences autonomously.

The goal is to eliminate cognitive load from prospecting, sequencing, enrichment, and CRM hygiene — so the human closer can focus exclusively on qualified conversations.

---

## 2. Design Principles

### 2.1 Small Enough to Understand
One Node.js process. A handful of source files. No microservices. If you want to understand the full BDRclaw codebase, ask Claude Code to walk you through it.

### 2.2 Secure by Isolation
Agents run in Linux containers (Docker or Apple Container). They can only access explicitly mounted directories. Bash access is safe because commands run inside the container, not on the host. Security is OS-level, not application-level.

### 2.3 Prospect-First Memory Model
Each prospect gets their own isolated `CLAUDE.md` context file. Agents read this file before taking any action on a prospect. All decisions are grounded in history.

### 2.4 Skills Over Features
New capabilities are added via Claude Code skills (`/add-hubspot`, `/add-linkedin`) that modify the user's fork. The core codebase stays minimal. Users get clean code that does exactly what they need.

### 2.5 Open Core
The base framework is MIT licensed. Premium skills (advanced AI scoring, multi-touch attribution, enterprise CRM connectors) are maintained separately under a commercial license.

---

## 3. System Architecture

### 3.1 High-Level Flow

```
Inbound Signals
  (email replies, LinkedIn DMs, Slack messages, SMS)
          ↓
    Channel Adapters
  (gmail / linkedin / slack / twilio / whatsapp)
          ↓
      SQLite Queue
  (messages, tasks, prospect_events)
          ↓
    Polling Loop (src/index.ts)
          ↓
  Per-Prospect Queue + Concurrency Controller
          ↓
  Container Runner → Linux Container
          ↓
  Claude Agent SDK  ←→  prospects/*/CLAUDE.md
          ↓
  Outbound Actions
  (send email / DM / SMS / update CRM / notify closer)
```

### 3.2 Component Map

| Component | File | Responsibility |
|---|---|---|
| Orchestrator | `src/index.ts` | State, message loop, agent invocation |
| Channel Registry | `src/channels/registry.ts` | Self-registration at startup |
| IPC Watcher | `src/ipc.ts` | IPC watcher, task processing |
| Router | `src/router.ts` | Message formatting, outbound routing |
| Prospect Queue | `src/prospect-queue.ts` | Per-prospect queue, global concurrency limit |
| Container Runner | `src/container-runner.ts` | Spawns streaming agent containers |
| Task Scheduler | `src/task-scheduler.ts` | Runs scheduled BDR tasks (daily brain, follow-ups) |
| Database | `src/db.ts` | SQLite operations |
| BDR Brain | `src/bdr-brain.ts` | Daily pipeline review, action queuing, signal detection |

### 3.3 Container Model

Each agent invocation spawns an isolated Linux container:

- **macOS**: Apple Container (lightweight, native) or Docker
- **Linux**: Docker
- **Mounts**: Only `prospects/<id>/` and `groups/<channel>/` directories are mounted
- **No host access**: Containers cannot access the host filesystem, network interfaces, or other container namespaces

---

## 4. Data Model

### 4.1 Prospect

```typescript
interface Prospect {
  id: string;                    // slug: "john-smith-acme"
  name: string;
  email?: string;
  linkedin_url?: string;
  phone?: string;
  company: string;
  title: string;
  stage: ProspectStage;
  assigned_channel: Channel[];   // active outreach channels
  created_at: string;
  last_touch_at: string;
  next_action_at: string;
  next_action_type: ActionType;
  enrichment: EnrichmentData;
  tags: string[];
}

type ProspectStage =
  | 'identified'
  | 'outreach_sent'
  | 'follow_up'
  | 'replied'
  | 'interested'
  | 'meeting_booked'
  | 'handed_off'
  | 'not_interested'
  | 'unsubscribed';

type ActionType =
  | 'send_email'
  | 'linkedin_connect'
  | 'linkedin_dm'
  | 'send_sms'
  | 'slack_connect'
  | 'enrich'
  | 'update_crm'
  | 'notify_closer'
  | 'wait';
```

### 4.2 Prospect Memory File

Each prospect has a `prospects/<id>/CLAUDE.md`:

```markdown
# Prospect: John Smith — Acme Corp

## Profile
- Title: VP of Sales
- Company: Acme Corp (Series B, 120 employees, SaaS)
- Email: john@acme.com
- LinkedIn: linkedin.com/in/johnsmith
- Phone: +1 555 123 4567

## Stage
interested — replied to email #2, asked about pricing

## Sequence
- [2026-03-10] Email #1 sent — no reply
- [2026-03-14] LinkedIn connection sent — accepted
- [2026-03-17] Email #2 sent — replied (see below)
- [2026-03-18] Replied: "Interesting, what does pricing look like?"
- [2026-03-18] Follow-up sent with pricing overview

## Next Action
2026-03-21 — Send meeting link if no reply in 48h

## Notes
- Mentioned they're evaluating 2 other vendors
- Budget cycle ends Q2
- Warm to the LinkedIn connection, responded quickly

## Enrichment
- Recent news: Acme raised $12M Series B (March 2026)
- Tech stack: Salesforce, Outreach, ZoomInfo
- Headcount growth: +40% YoY
```

### 4.3 SQLite Schema

```sql
-- Core tables
CREATE TABLE prospects (
  id TEXT PRIMARY KEY,
  data JSON NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  prospect_id TEXT,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL, -- inbound | outbound
  content TEXT NOT NULL,
  metadata JSON,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,       -- follow_up | enrich | crm_sync | brain_cycle
  prospect_id TEXT,
  scheduled_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  result JSON
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  name TEXT,
  metadata JSON
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  group_id TEXT,
  prospect_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
```

---

## 5. The BDR Brain

The BDR Brain (`src/bdr-brain.ts`) is a scheduled agent that runs on a configurable cycle (default: daily at 6am). It is the strategic layer of BDRclaw.

### 5.1 Daily Cycle

```
1. Load all active prospects from SQLite
2. For each prospect:
   a. Read prospects/<id>/CLAUDE.md
   b. Evaluate stage and last touch
   c. Check for buying signals (job change, funding, web visit)
   d. Determine next action and schedule it
3. Flag hot leads → notify closer via main channel
4. Generate daily summary report
5. Sync updated stages to CRM
```

### 5.2 Buying Signal Detection

The brain monitors for:
- **Job change**: Prospect moved to a new company (re-prospect)
- **Funding round**: Company raised capital (buying trigger)
- **Hiring signal**: Job postings for roles BDRclaw solves for
- **Technology change**: New tools adopted (competitive displacement)
- **Web visit**: Prospect visited your website (intent signal, via Clearbit/RB2B)
- **Email open/click**: Engagement signal from email provider

### 5.3 Reply Classification

When a reply is received, Claude classifies it:

| Classification | Action |
|---|---|
| `interested` | Update stage, notify closer, queue meeting link |
| `not_now` | Schedule re-engage in 30/60/90 days |
| `referral` | Extract referral contact, add to prospects |
| `not_interested` | Mark closed_lost, suppress from sequences |
| `unsubscribe` | Hard remove from all sequences, log compliance |
| `question` | Auto-respond with answer if confidence > 0.85, else escalate |
| `out_of_office` | Pause sequence, resume after OOO end date |

---

## 6. Sequence Engine

### 6.1 Sequence Definition

Sequences are defined in `groups/<channel>/sequences/` as markdown files:

```markdown
# Cold Outbound — SaaS VP Sales

## Touch 1 — Email (Day 0)
Subject: {first_name}, quick question about {company}'s pipeline
Body: ...

## Touch 2 — LinkedIn Connect (Day 2)
Message: Hi {first_name} — sent you an email earlier...

## Touch 3 — Email Follow-up (Day 5)
Subject: Re: quick question
Body: ...

## Touch 4 — SMS (Day 8)
Body: Hey {first_name}, Joseph here — sent a couple emails...

## Touch 5 — Email Breakup (Day 14)
Subject: Closing the loop
Body: ...
```

### 6.2 Personalization Variables

| Variable | Source |
|---|---|
| `{first_name}` | Prospect profile |
| `{company}` | Prospect profile |
| `{title}` | Prospect profile |
| `{recent_news}` | Enrichment data |
| `{tech_stack}` | Enrichment data |
| `{mutual_connection}` | LinkedIn enrichment |
| `{funding_round}` | Enrichment data |
| `{custom_line}` | AI-generated per prospect |

The `{custom_line}` variable is filled by Claude at send time using the prospect's enrichment data — no two emails are identical.

---

## 7. CRM Integration Model

BDRclaw treats CRM as a sync target, not a system of record. The system of record is `prospects/*/CLAUDE.md`.

### 7.1 Sync Events

| BDRclaw Event | CRM Action |
|---|---|
| Prospect created | Create contact + deal |
| Stage updated | Update deal stage |
| Email sent | Log activity |
| Reply received | Log activity + update stage |
| Meeting booked | Create meeting record, notify owner |
| Not interested | Mark closed_lost |

### 7.2 Supported CRMs (via skills)

- HubSpot (`/add-hubspot`)
- Attio (`/add-attio`)
- Salesforce (`/add-salesforce`)
- Pipedrive (`/add-pipedrive`)
- Close (`/add-close`)

---

## 8. Channel Architecture

Channels self-register at startup via `src/channels/registry.ts`. A channel is active if its credentials are present in `.env`.

### 8.1 Channel Interface

```typescript
interface Channel {
  name: string;
  type: 'inbound' | 'outbound' | 'bidirectional';
  init(): Promise<void>;
  send(prospectId: string, message: OutboundMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
```

### 8.2 Channel Skill Map

| Channel | Skill | Direction |
|---|---|---|
| Gmail | `/add-gmail` | Bidirectional |
| LinkedIn | `/add-linkedin` | Bidirectional |
| Twilio SMS | `/add-twilio` | Bidirectional |
| Slack | `/add-slack-outreach` | Bidirectional |
| WhatsApp | `/add-whatsapp` | Bidirectional |
| Telegram | `/add-telegram` | Bidirectional |
| Discord | `/add-discord` | Outbound |

---

## 9. Security Model

See `docs/SECURITY.md` for full details.

### Summary
- Agents run in Linux containers, not behind application-level permission checks
- Each agent can only access explicitly mounted directories
- Per-prospect session isolation — no cross-contamination of context
- No credentials stored inside containers
- Secrets managed via `.env` on host, injected at container spawn time
- All outbound actions are logged to SQLite before execution (audit trail)

---

## 10. Open Core Model

| Layer | License | Description |
|---|---|---|
| Core framework | MIT | Orchestrator, container runner, DB, scheduler, router |
| Base channel skills | MIT | `/add-gmail`, `/add-slack-outreach`, `/add-twilio` |
| BDR brain (basic) | MIT | Daily cycle, stage management, reply classification |
| Premium skills | Commercial | Advanced AI scoring, Clay/Apollo deep integration, multi-touch attribution |
| Enterprise skills | Commercial | Salesforce, Outreach.io, SSO, team management |

---

## 11. Roadmap

### v0.1 — Foundation
- [ ] BDRclaw branding and README
- [ ] Prospect memory model (`prospects/*/CLAUDE.md`)
- [ ] BDR brain scaffold
- [ ] `/add-gmail` skill
- [ ] Basic sequence engine

### v0.2 — Outreach
- [ ] `/add-linkedin` skill
- [ ] `/add-twilio` skill
- [ ] Reply classification
- [ ] Sequence personalization with `{custom_line}`

### v0.3 — CRM
- [ ] `/add-hubspot` skill
- [ ] `/add-attio` skill
- [ ] CRM sync engine

### v0.4 — Intelligence
- [ ] Buying signal detection
- [ ] Hot lead notifications
- [ ] Daily summary reports
- [ ] Meeting booking detection + closer handoff

### v1.0 — Open Core Launch
- [ ] Premium skills framework
- [ ] Documentation site
- [ ] Discord community
- [ ] `/setup` full automation

---

## 12. Non-Goals

BDRclaw will not:
- Replace a CRM (it syncs to one)
- Get on calls (human closers do that)
- Send spam (all sequences are permission-aware and comply-unsubscribe)
- Become a monolithic sales platform
- Add features to core that belong in skills

---

*Inspired by NanoClaw (MIT) — qwibitai/nanoclaw*
