# BDRclaw Roadmap

## Vision

BDRclaw becomes the agentic layer on top of every outreach surface — channels you own (email, SMS, WhatsApp) and platforms you rent (LinkedIn Sales Navigator, Tweet Hunter, HubSpot sequences). Users talk to BDR Claude; BDR Claude builds, launches, and runs every campaign for them.

---

## Phase 1 — Agentic Campaign Builder *(core differentiator)*

Users converse with a Claude-powered campaign builder to define their ICP, value proposition, and outreach strategy. The agent outputs a structured `Campaign` record with personalized message templates and a multi-touch, multi-channel sequence. No forms. No spreadsheets. Just a conversation.

**Key capabilities:**

- **Campaign creation via chat** — BDR Claude asks: product, ICP, value prop, pain points, desired channels, tone, and schedule. Generates the full sequence in one shot.
- **Sequence editing via chat** — "Make the LinkedIn message shorter" or "Add a WhatsApp follow-up on day 7" — the agent patches the campaign in real time.
- **Per-prospect personalization** — templates use `{{firstName}}`, `{{company}}`, `{{title}}`, and the agent pulls enrichment data to fill them before every send.
- **Human-likeness controls** — random send-window jitter (±30 min), variable message length per touch, emoji density setting, typo injection mode (opt-in).
- **Campaign cloning** — fork an existing campaign, A/B test message variants, promote the winner.

**Files to build:**

| File | Purpose |
|------|---------|
| `src/campaign-builder.ts` | Claude conversation loop that produces a `Campaign` |
| `src/campaign-runner.ts` | Maps campaigns → BDR brain actions per prospect |
| `src/campaigns-db.ts` | SQLite tables: campaigns, campaign_steps, campaign_enrollments |
| `src/bdr-types.ts` | Add `Campaign`, `CampaignStep`, `CampaignEnrollment` types |
| `src/web-ui.ts` | `/api/campaigns` CRUD + `/chat/campaign-builder` WebSocket |

---

## Phase 2 — CRM Integrations

Plugin architecture: every CRM adapter self-registers at boot (same pattern as channels). The BDR brain calls `crm.push(prospect)` on every stage change and `crm.pull()` on startup to import new leads.

### Built-in adapters (priority order)

| CRM | Integration | Notes |
|-----|-------------|-------|
| **HubSpot** | REST API v3 | Contacts, deals, timeline events; OAuth 2.0 |
| **Salesforce** | REST + Bulk API | Leads, contacts, opportunities; OAuth 2.0 |
| **Monday.com** | GraphQL API | Items in a board = prospects; status columns = stages |
| **Pipedrive** | REST API | Persons + deals; native webhook inbound |
| **Notion** | API v1 | Database rows; good for solo operators |
| **Airtable** | REST API | Flexible schema mapping |
| **Close.io** | REST API | Built for outbound sales teams |

### Plugin interface (`src/crm/types.ts`)

```typescript
export interface CRMAdapter {
  name: string;
  push(prospect: BDRProspect, event: CRMEvent): Promise<void>;
  pull(): Promise<CRMContact[]>;
  mapStage(stage: ProspectStage): string; // maps to CRM's stage vocabulary
}
```

### Files to build

| File | Purpose |
|------|---------|
| `src/crm/types.ts` | `CRMAdapter`, `CRMEvent`, `CRMContact` interfaces |
| `src/crm/registry.ts` | Self-registration + `getCRMAdapters()` |
| `src/crm/hubspot.ts` | HubSpot REST v3 adapter |
| `src/crm/salesforce.ts` | Salesforce REST + Bulk adapter |
| `src/crm/monday.ts` | Monday.com GraphQL adapter |
| `src/crm/pipedrive.ts` | Pipedrive REST adapter |
| `src/crm/notion.ts` | Notion API adapter |
| `setup/hubspot-auth.ts` | OAuth 2.0 callback server, saves tokens to .env |
| `setup/salesforce-auth.ts` | Same for Salesforce |

### Two-way sync

- **Outbound** (BDRclaw → CRM): stage changes, new touches, meeting booked, reply classified
- **Inbound** (CRM → BDRclaw): new leads created in CRM auto-enroll in a campaign; deal won/lost removes from active sequences

---

## Phase 3 — Legacy Platform Integrations

BDRclaw becomes the orchestration brain that drives these platforms rather than replacing them. Users who already pay for LinkedIn Sales Navigator or Tweet Hunter get AI automation on top of their existing subscriptions.

### LinkedIn Sales Navigator

- **What**: BDR Claude identifies prospects via Sales Navigator search, then hands them to the LinkedIn channel for outbound
- **How**: Playwright browser automation on `linkedin.com/sales` (same pattern as the existing LinkedIn channel)
- **Adds**: Boolean search templates, "look-alike ICP" searches, auto-import discovered profiles as prospects

### Tweet Hunter / TweetDM

- **What**: Schedule Claude-written tweets to warm up audiences before cold DM sequences; coordinate DM campaigns with tweet content calendar
- **How**: Tweet Hunter API (if available) or direct Twitter API v2; BDR brain queues tweets as campaign steps
- **Adds**: `tweet` action type, tweet scheduling, audience engagement tracking before DM send

### Open Tweet

- **What**: Same as Tweet Hunter but via Open Tweet's API if preferred
- **How**: Twitter API v2 under the hood; use whichever platform the user pays for

### Apollo.io

- **What**: Pull enriched leads directly from Apollo searches into BDRclaw campaigns
- **How**: Apollo REST API; `apollo_search` as a prospect source type
- **Adds**: Instant enrichment (company size, funding, tech stack, emails, phone numbers)

### Clay

- **What**: Receive Clay waterfall-enriched rows as prospect imports (webhook or CSV)
- **How**: Inbound webhook at `/webhooks/clay`; maps Clay columns to `BDRProspect` fields
- **Adds**: The richest enrichment pipeline available feeds directly into campaigns

### Instantly / Lemlist / Smartlead

- **What**: Sync BDRclaw email campaigns to these deliverability-focused senders
- **How**: REST APIs; BDRclaw handles sequence logic, delegates actual send to the warmup-pool platform
- **Adds**: Inbox rotation, deliverability scores, warmup pools — without rebuilding them

---

## Phase 4 — Multi-tenant SaaS

Each user (seat) gets isolated campaigns, prospects, and channel credentials. A team account shares a CRM connection and prospect pool but individual reps run their own sequences.

### Architecture changes

| Area | Change |
|------|--------|
| Auth | Add JWT session auth; per-user row-level isolation in SQLite or Postgres |
| Billing | Stripe integration; seat-based pricing + channel add-ons |
| Onboarding | First-launch wizard runs campaign builder conversation automatically |
| Admin UI | Team view: all reps, pipeline roll-up, hot lead alerts |
| White-label | Custom domain + logo for agency resellers |

---

## Milestone Summary

| Phase | Goal | Unlock |
|-------|------|--------|
| **1** | Agentic campaign builder | Users ship campaigns without touching config files |
| **2** | CRM sync (HubSpot first) | Two-way prospect/deal sync; no manual data entry |
| **3** | Sales Navigator + Tweet Hunter | AI layer on existing platform subscriptions |
| **4** | Multi-tenant + billing | Sell BDRclaw as a SaaS product |
