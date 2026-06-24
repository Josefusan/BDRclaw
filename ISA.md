# ISA — BDRclaw v1.0 (Ship)

> **Tier:** E4 | **Status:** EXECUTE | **Updated:** 2026-06-24

---

## Problem

One person cannot be an entire revenue team. A solo high-ticket closer or founder running outbound needs to research leads, write personalized messages on 7 channels, follow up at the right cadence, handle replies intelligently, book meetings, and keep a CRM clean — simultaneously, 24 hours a day, without burning bridges or getting accounts banned. Hiring a full SDR/setter team costs $10-25k/month and still produces inconsistent, low-quality outreach. Existing tools (Apollo, Lemlist, Instantly) automate blasting but not thinking — they send the same template to everyone and call it "personalized." The market needs one AI that replaces the thinking SDR, not a template launcher wearing a tuxedo.

---

## Vision

A high-ticket closer opens BDRclaw, describes their offer in a 3-minute conversation with BDR Claude, and walks away. By the next morning their calendar has booked calls, their CRM has been updated, and every prospect has received a message that reads like it was written by someone who did an hour of research on them specifically. The closer never writes a single outreach message. The system handles replies, asks qualifying questions, sends the calendar link at the right moment, and flags the ones worth picking up the phone for. One person is now more productive at top-of-funnel than a five-person SDR team — without the management overhead, without the inconsistency, without the cost.

---

## Out of Scope

BDRclaw v1 does not include a mobile native app — the web dashboard and channel bots are the full interface. It does not provide its own phone number for cold calling or voice AI — the product is async text-based outreach only. It does not include a built-in lead database or list-buying service — users bring their own prospects via CSV, CRM sync, or the agentic builder's target definition. It does not replace the closer on the actual sales call — BDRclaw's job ends when the meeting is booked and the hot-lead notification fires. It does not support self-hosted LLMs in v1 — Claude via Anthropic API is the only intelligence layer. White-label reselling and multi-tenant SaaS billing are Phase 4 work, not v1 scope.

---

## Principles

1. **The AI does the thinking, not just the sending.** Every outbound message is generated fresh by Claude with full prospect context — stage, touches, enrichment, campaign, company research. Template-filling is not intelligence.
2. **A quality gate on every message.** No message leaves without a second Claude agent reviewing it for accuracy, tone, personalization, and spam-trigger words. Human-likeness is enforced architecturally, not hoped for.
3. **Channel diversity is a ban-prevention strategy.** Spread across email, LinkedIn, SMS, WhatsApp, Telegram, and Twitter. Respect daily limits. Jitter send times. Vary message length. Never send identical content on two channels.
4. **The loop never dies.** Errors on one prospect never block others. Every agent call is wrapped, logged, and retried with exponential backoff. The system is operational at degraded capacity, not down, when one subsystem fails.
5. **Context compounds.** Every reply, every touch, every enrichment datum is written back to the prospect's memory. The next message always knows everything the previous ones did. Amnesia is a product bug.
6. **Compliance is not optional.** TCPA limits on SMS, GDPR one-click unsubscribe on email, LinkedIn connection-request daily caps, Instagram warm-lead-only policy — these are baked into the channel logic, not left to the user.
7. **Ship beats perfect.** A working feature on bdrclaw.dev beats a perfect feature in a PR. The ISA is a living document; the product iterates.

---

## Constraints

- Node.js 20+ / TypeScript / ESM modules — no Python, no CommonJS.
- SQLite via `better-sqlite3` — single-file database, volume-mounted in production.
- Anthropic Claude via `@anthropic-ai/sdk` — no other LLM providers in v1.
- No external web framework — Node `http` module only for the dashboard server.
- Channels self-register via the registry pattern — no hardcoded channel lists anywhere in orchestration code.
- CRM adapters self-register via the CRM registry pattern.
- Every outbound message passes the quality gate before send — this check is never bypassed.
- Playwright used only for LinkedIn automation; no browser automation on any other channel.
- TCPA: max 2 unsolicited SMS touches per prospect, enforced in `sms.ts`.
- Instagram: warm-lead only (inbound-first), enforced in `instagram.ts`.
- LinkedIn: ≤20 connection requests/day, ≤50 DMs/day — enforced in `linkedin.ts`.
- All secrets via environment variables — no secrets in code or git history.

---

## Goal

BDRclaw v1 ships to `bdrclaw.dev` as a working SaaS: one person configures their offer via a conversation with BDR Claude, the system generates and executes a full multi-channel outreach campaign, a quality-gate agent audits every message before send, a reply-handler agent manages inbound and books meetings, and the CRM stays current automatically. The closer gets notified when a lead is hot and finds a booked meeting on their calendar. Zero SDR headcount required.

---

## Criteria

### Core Loop — Must Never Break
- [ ] ISC-1: The agentic loop (`src/agents/loop.ts`) starts without error, logs a heartbeat every tick, and recovers automatically after any single-prospect processing error without stopping.
- [ ] ISC-2: The loop processes all due campaign enrollments on each tick without skipping prospects whose neighbors errored.
- [ ] ISC-3: Loop errors are logged with `{ err, prospectId, phase }` structured fields — never swallowed silently.
- [ ] ISC-4: The loop can be stopped cleanly via `SIGTERM`/`SIGINT` without leaving a prospect in a half-sent state.

### BDR Agent — Message Generation
- [ ] ISC-5: `BDRAgent.compose()` returns a personalized message that references the prospect's `name`, `company`, or `title` — never sends a template with unfilled `{{placeholder}}` tokens.
- [ ] ISC-6: The agent reads the full prospect memory (stage, previous touches, enrichment) before composing — it never repeats a message already in the touch history.
- [ ] ISC-7: The agent selects the appropriate channel for the current campaign step — it does not email when the step is `linkedin_dm`.
- [ ] ISC-8: The agent applies send-time jitter of ±`campaign.jitter_minutes` to every outbound message.

### Quality Gate — Every Message Audited Before Send
- [ ] ISC-9: `QualityGate.review()` is called on every outbound message before it reaches the channel's `sendMessage()`.
- [ ] ISC-10: The quality gate returns `{ pass: false, reason }` when it detects an unfilled placeholder (`{{` in the message body).
- [ ] ISC-11: The quality gate returns `{ pass: false, reason }` when the message body contains a known spam-trigger word from the blocklist.
- [ ] ISC-12: The quality gate returns `{ pass: false, reason }` when the message exceeds the channel's maximum character limit (SMS: 320, email: unlimited, LinkedIn DM: 300, Twitter DM: 10000).
- [ ] ISC-13: When the quality gate fails, the message is NOT sent — it is logged with `status: 'blocked'` in `bdr_touches`.
- [ ] ISC-14: The quality gate's `pass`/`fail` decision and reason are logged for every message evaluated.
- [ ] Anti: ISC-15: `sendMessage()` is never called without a preceding `QualityGate.review()` call in the execution path — verifiable by tracing the call chain in `loop.ts`.

### Reply Handler — Inbound Intelligence
- [ ] ISC-16: `ReplyHandler.process()` classifies every inbound message into one of: `interested`, `not_now`, `referral`, `not_interested`, `unsubscribe`, `question`, `out_of_office`.
- [ ] ISC-17: An `unsubscribe` classification immediately sets `prospect.stage = 'unsubscribed'` and halts all further outbound for that prospect.
- [ ] ISC-18: An `interested` classification fires a hot-lead notification (console log + optional webhook) and sends the Calendly/meeting link if `CALENDLY_URL` is set.
- [ ] ISC-19: A `question` classification generates a Claude-powered answer grounded in the campaign's `value_proposition` and sends it on the same channel as the inbound.
- [ ] ISC-20: The reply handler updates `prospect.stage` and records the touch with `direction: 'inbound'` and the classification in `reply_classification`.

### Campaign Builder
- [ ] ISC-21: `POST /api/campaigns/builder/start` returns `{ sessionId, message }` with BDR Claude's opening question within 5 seconds.
- [ ] ISC-22: `POST /api/campaigns/builder/chat` returns `{ done: true, campaign }` after sufficient context is gathered — campaign includes at minimum 3 steps across at least 2 channels.
- [ ] ISC-23: The built campaign's message templates contain no unfilled placeholders — the quality gate passes on all generated templates at build time.
- [ ] ISC-24: `PATCH /api/campaigns/:id { status: "active" }` enrolls all active prospects and begins the loop processing them within one tick.

### CRM Sync
- [ ] ISC-25: When `HUBSPOT_ACCESS_TOKEN` is set and a prospect stage changes, `pushToCRMs()` is called within the same logical operation (not async-fire-and-forget).
- [ ] ISC-26: `POST /api/crm/pull` returns `{ contacts, count }` and each returned contact maps to `CRMContact` shape without TypeScript errors.
- [ ] ISC-27: CRM push failure does NOT block the prospect's stage change — it logs a warning and continues.
- [ ] Anti: ISC-28: Removing `HUBSPOT_ACCESS_TOKEN` from `.env` results in zero HubSpot API calls on the next run — the adapter self-disables cleanly.

### Channels — Core Delivery
- [ ] ISC-29: All seven channels (`email`, `linkedin`, `twitter`, `instagram`, `telegram`, `whatsapp`, `sms`) self-register when their respective env vars are present.
- [ ] ISC-30: Each channel's `sendMessage()` enforces its daily limit and throws when the limit is reached — never silently drops the message.
- [ ] ISC-31: Twilio inbound webhooks for SMS and WhatsApp reach `ReplyHandler.process()` within one request cycle.
- [ ] ISC-32: Telegram long-polling delivers inbound messages to `ReplyHandler.process()` within 35 seconds of the user sending.

### Web Dashboard
- [ ] ISC-33: `GET /api/stats` returns `PipelineStats` with correct `by_stage` counts matching the DB.
- [ ] ISC-34: `GET /` serves the dashboard HTML with no 404 or 500 status.
- [ ] ISC-35: `GET /api/health` returns `{ status: "ok" }` within 200ms.
- [ ] Anti: ISC-36: No API route exposes raw SQL errors in the response body — all 500 responses return `{ error: "Internal error" }`.

### Deployment
- [ ] ISC-37: `npm run build` (`tsc`) completes with zero TypeScript errors.
- [ ] ISC-38: `Dockerfile` builds successfully and the resulting image starts with `node dist/index.js`.
- [ ] ISC-39: `railway.json` specifies `Dockerfile` builder and `ON_FAILURE` restart policy.
- [ ] ISC-40: The running service on `bdrclaw.dev` responds to `GET /api/health` with `{ status: "ok" }`.
- [ ] Anti: ISC-41: No `.env` file is present in the built Docker image — secrets are env vars only.

---

## Test Strategy

| ISC | Type | Check | Threshold | Tool |
|-----|------|-------|-----------|------|
| ISC-1 | Integration | Start loop, force a prospect error, observe recovery and continued heartbeat | Loop ticks ≥2 after injected error | `npm run dev` + inspect logs |
| ISC-2 | Integration | Enroll 3 prospects, cause error on prospect 2, verify prospect 3 is processed | Prospect 3 touch recorded in DB | SQLite query after run |
| ISC-3 | Code review | Grep for `catch` blocks that don't log `err` field | 0 silent catches | `grep -n "catch" src/agents/loop.ts` |
| ISC-5 | Unit | Call `BDRAgent.compose()` with a prospect; assert no `{{` in result | 0 placeholder leaks | `npm test` |
| ISC-6 | Unit | Pre-populate prospect memory with touch; assert new composition differs | No repeated message | `npm test` |
| ISC-9 | Code review | Trace `sendMessage` call sites in loop.ts; verify `QualityGate.review` precedes each | 0 unguarded call sites | Manual + grep |
| ISC-10 | Unit | Pass message `"Hi {{firstName}}"` to gate; assert `pass: false` | `pass === false` | `npm test` |
| ISC-11 | Unit | Pass message with `"guaranteed results"` to gate; assert `pass: false` | `pass === false` | `npm test` |
| ISC-12 | Unit | Pass 321-char string as SMS message; assert `pass: false` | `pass === false` | `npm test` |
| ISC-13 | Integration | Force gate failure; assert `bdr_touches` has entry with `status: 'blocked'` | 1 blocked touch in DB | SQLite query |
| ISC-16 | Unit | Pass sample replies for each classification; assert correct label | 7/7 classifications correct | `npm test` |
| ISC-17 | Integration | Send "unsubscribe" reply; assert prospect stage = `unsubscribed` and no further touches | Stage update + 0 new touches | SQLite query |
| ISC-21 | API | `curl -X POST /api/campaigns/builder/start`; assert response has `sessionId` and `message` | HTTP 200, both fields present | curl |
| ISC-37 | Build | `npm run build` | Exit code 0, zero tsc errors | CI / local |
| ISC-40 | E2E | `curl https://bdrclaw.dev/api/health` | `{"status":"ok"}` | curl |

---

## Features

| Name | Description | Satisfies | Depends On | Parallelizable |
|------|-------------|-----------|------------|----------------|
| **agentic-loop** | `src/agents/loop.ts` — main orchestration tick, error isolation, heartbeat logging, graceful shutdown | ISC-1,2,3,4 | bdr-agent, quality-gate, reply-handler | No |
| **bdr-agent** | `src/agents/bdr-agent.ts` — Claude-powered message composer with prospect context, channel awareness, jitter | ISC-5,6,7,8 | campaign-runner | Yes |
| **quality-gate** | `src/agents/quality-gate.ts` — second-agent auditor; placeholder check, spam-word check, length check, structured verdict | ISC-9,10,11,12,13,14,15 | — | Yes |
| **reply-handler** | `src/agents/reply-handler.ts` — Claude classifier for inbound; unsubscribe enforcement, hot-lead notification, question answering | ISC-16,17,18,19,20 | — | Yes |
| **crm-push-on-stage-change** | Wire `pushToCRMs()` into `updateProspectStage()` in `bdr-db.ts` so every stage change syncs to CRM | ISC-25,26,27,28 | crm-registry | Yes |
| **channel-reply-routing** | Route all inbound messages (Twilio webhooks, Telegram poll, Twitter poll) through `ReplyHandler.process()` | ISC-31,32 | reply-handler | Yes |
| **quality-gate-tests** | Vitest unit tests for QualityGate: unfilled placeholder, spam word, channel limits, pass cases | ISC-10,11,12 | quality-gate | Yes |
| **bdr-agent-tests** | Vitest unit tests for BDRAgent.compose: no placeholder leak, no repeat, channel selection | ISC-5,6,7 | bdr-agent | Yes |
| **reply-handler-tests** | Vitest unit tests for ReplyHandler: all 7 classifications, unsubscribe enforcement | ISC-16,17 | reply-handler | Yes |
| **deploy-railway** | Push to Railway, set env vars, confirm `bdrclaw.dev/api/health` returns 200 | ISC-38,39,40,41 | all features | No |

---

## Decisions

- **2026-06-24** — Use a second Claude call (quality gate) rather than a regex/rules engine for message auditing. Reason: rules cannot catch contextual failures like a message that technically has no `{{` tokens but still addresses the wrong company because the name was hardcoded. Claude catches semantic failures; regex catches syntactic ones. Both are needed but Claude is primary.
- **2026-06-24** — Loop runs on a configurable interval (`BDR_LOOP_INTERVAL_MS`, default 5 minutes) rather than being driven by the BDR brain's daily schedule. Reason: the brain is for strategic review; the loop is for tactical execution. Inbound replies should be handled within minutes, not 24 hours.
- **2026-06-24** — Quality gate uses `claude-haiku-4-5` (fast, cheap) not `claude-sonnet-4-6`. Reason: the gate is a binary pass/fail check on a single message — it does not need frontier-level reasoning. Haiku completes in ~200ms; Sonnet would add 2-3s latency per message with no quality benefit on this narrow task.
- **2026-06-24** — BDR agent uses `claude-sonnet-4-6` for message composition. Reason: message quality is the product's core value. Haiku produces noticeably worse personalization on complex enrichment contexts.
- **2026-06-24** — Reply handler uses `claude-sonnet-4-6` for classification + response drafting. Reason: misclassifying an "interested" reply as "not_interested" is a revenue-destroying bug. The cost of a Sonnet call on inbound is acceptable.
- **2026-06-24** — All agent files live in `src/agents/` to make the self-auditing structure explicit and navigable.

---

## Changelog

*(Populated during VERIFY phase as errors are found and corrected.)*

---

## Verification

*(Populated after each ISC passes — quoted command output or log evidence.)*
