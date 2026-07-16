# ISA — BDRclaw v1.0 (Ship)

> **Tier:** E4 | **Status:** EXECUTE (session complete 2026-07-15; open: ISC-70/74/75 + deploy-blocked) | **Updated:** 2026-07-15T14:40:00Z | **Iteration:** v1.4 — booking detection + session-resume verification (ISC-80..84) — Landing page, dashboard completion, GHL, war-room loop (ISC-61..76) — Dashboard v2, runtime hardening, channel completion (ISC-42..60)

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
- [x] ISC-5: `BDRAgent.compose()` returns a personalized message that references the prospect's `name`, `company`, or `title` — never sends a template with unfilled `{{placeholder}}` tokens. *(2026-07-08: composed message now reaches the wire by contract; e2e test asserts no `{{` leak.)*
- [x] ISC-6: The agent reads the full prospect memory (stage, previous touches, enrichment) before composing — it never repeats a message already in the touch history.
- [x] ISC-7: The agent selects the appropriate channel for the current campaign step — it does not email when the step is `linkedin_dm`.
- [ ] ISC-8: The agent applies send-time jitter of ±`campaign.jitter_minutes` to every outbound message.

### Quality Gate — Every Message Audited Before Send
- [x] ISC-9: `QualityGate.review()` is called on every outbound message before it reaches the channel's `sendMessage()`. *(2026-07-15: loop.ts:244→289; loop.e2e.test.ts "Break B" drives compose→gate→handler.)*
- [x] ISC-10: The quality gate returns `{ pass: false, reason }` when it detects an unfilled placeholder (`{{` in the message body). *(quality-gate.test.ts "placeholder check (ISC-10)".)*
- [x] ISC-11: The quality gate returns `{ pass: false, reason }` when the message body contains a known spam-trigger word from the blocklist. *(quality-gate.test.ts "spam word check (ISC-11)".)*
- [x] ISC-12: The quality gate returns `{ pass: false, reason }` when the message exceeds the channel's maximum character limit (SMS: 320, email: unlimited, LinkedIn DM: 300, Twitter DM: 10000). *(quality-gate.test.ts "channel length check (ISC-12)"; Twitter 10000 in code, untested.)*
- [x] ISC-13: When the quality gate fails, the message is NOT sent — it is logged with `status: 'blocked'` in `bdr_touches`. *(2026-07-08: was `'bounced'`, now `'blocked'`; `TouchStatus` gained the value.)*
- [x] ISC-14: The quality gate's `pass`/`fail` decision and reason are logged for every message evaluated.
- [x] Anti: ISC-15: `sendMessage()` is never called without a preceding `QualityGate.review()` call in the execution path — verifiable by tracing the call chain in `loop.ts`. *(2026-07-08: the composed+gated body now travels to the handler as a typed `ComposedOutbound` arg via `resolveOutboundBody`; handlers no longer send un-gated templates when a composed message is present.)*

### Reply Handler — Inbound Intelligence
- [x] ISC-16: `ReplyHandler.process()` classifies every inbound message into one of: `interested`, `not_now`, `referral`, `not_interested`, `unsubscribe`, `question`, `out_of_office`. *(2026-07-08: inbound now routed here from `index.ts` onMessage via `getProspectByContact`; e2e test asserts classification.)*
- [x] ISC-17: An `unsubscribe` classification immediately sets `prospect.stage = 'unsubscribed'` and halts all further outbound for that prospect. *(2026-07-08: plus a deterministic STOP/UNSUBSCRIBE pre-gate runs before any Claude call, and a global suppression list is enforced in both outbound entry points.)*
- [x] ISC-18: An `interested` classification fires a hot-lead notification (console log + optional webhook) and sends the Calendly/meeting link if `CALENDLY_URL` is set.
- [x] ISC-19: A `question` classification generates a Claude-powered answer grounded in the campaign's `value_proposition` and sends it on the same channel as the inbound.
- [x] ISC-20: The reply handler updates `prospect.stage` and records the touch with `direction: 'inbound'` and the classification in `reply_classification`.

### Campaign Builder
- [x] ISC-21: `POST /api/campaigns/builder/start` returns `{ sessionId, message }` with BDR Claude's opening question within 5 seconds.
- [x] ISC-22: `POST /api/campaigns/builder/chat` returns `{ done: true, campaign }` after sufficient context is gathered — campaign includes at minimum 3 steps across at least 2 channels.
- [ ] ISC-23: [DROPPED — see Decisions 2026-07-15: builder templates intentionally carry `{{placeholders}}` filled at compose time; the gate guards the wire (loop.e2e), not build time]
- [ ] ISC-24: `PATCH /api/campaigns/:id { status: "active" }` enrolls all active prospects and begins the loop processing them within one tick.

### CRM Sync
- [x] ISC-25: Every prospect stage change triggers `pushToCRMs()` from inside `updateProspectStage()` — the single authoritative sync path; the push is deliberately best-effort (detached, failure-swallowing) so a CRM outage can never block a stage change. *(refined 2026-07-15 per evidence sweep — "same logical operation, awaited" contradicted ISC-27's non-blocking requirement; bdr-db.ts:641-655.)*
- [ ] ISC-26: `POST /api/crm/pull` returns `{ contacts, count }` and each returned contact maps to `CRMContact` shape without TypeScript errors.
- [x] ISC-27: CRM push failure does NOT block the prospect's stage change — it logs a warning and continues. *(registry.ts allSettled + gohighlevel.test.ts "push logs a warning and does not throw on API error (ISC-27)".)*
- [ ] Anti: ISC-28: Removing `HUBSPOT_ACCESS_TOKEN` from `.env` results in zero HubSpot API calls on the next run — the adapter self-disables cleanly.

### Channels — Core Delivery
- [x] ISC-29: All seven channels (`email`, `linkedin`, `twitter`, `instagram`, `telegram`, `whatsapp`, `sms`) self-register when their respective env vars are present.
- [x] ISC-30: Each channel's `sendMessage()` enforces its daily limit and throws when the limit is reached — never silently drops the message.
- [DEFERRED-VERIFY] ISC-31: Twilio inbound webhooks for SMS and WhatsApp reach `ReplyHandler.process()` within one request cycle. *(2026-07-08: wired in code — onMessage → `getProspectByContact('sms'|'whatsapp')` → `processReply`, with per-message idempotency. Live-probe deferred: needs a deployed public webhook URL (Phase 2). Follow-up: live SMS round-trip after Railway deploy.)*
- [DEFERRED-VERIFY] ISC-32: Telegram long-polling delivers inbound messages to `ReplyHandler.process()` within 35 seconds of the user sending. *(2026-07-08: wired in code — same onMessage path resolves `telegram:<chatId>`. Live-probe deferred: needs a running bot + real chat. Follow-up: live Telegram round-trip.)*

### Web Dashboard
- [x] ISC-33: `GET /api/stats` returns `PipelineStats` with correct `by_stage` counts matching the DB.
- [x] ISC-34: `GET /` serves the dashboard HTML with no 404 or 500 status.
- [x] ISC-35: `GET /api/health` returns `{ status: "ok" }` within 200ms.
- [x] Anti: ISC-36: No API route exposes raw SQL errors in the response body — all 500 responses return `{ error: "Internal error" }`.

### Deployment
- [x] ISC-37: `npm run build` (`tsc`) completes with zero TypeScript errors.
- [ ] ISC-38: `Dockerfile` builds successfully and the resulting image starts with `node dist/index.js`.
- [x] ISC-39: `railway.json` specifies `Dockerfile` builder and `ON_FAILURE` restart policy. *(2026-07-15: read-verified — DOCKERFILE builder, ON_FAILURE maxRetries 5.)*
- [ ] ISC-40: The running service on `bdrclaw.dev` responds to `GET /api/health` with `{ status: "ok" }`.
- [ ] Anti: ISC-41: No `.env` file is present in the built Docker image — secrets are env vars only.

### Dashboard v2 — SaaS-Grade UI (added 2026-07-14)
- [x] ISC-42: `GET /` serves the SPA and every nav page (Overview, Prospects, Campaigns, Channels, Activity, Settings) renders without browser console errors.
- [x] ISC-43: Every dashboard page shows a meaningful empty state with a call-to-action when its data set is empty — no blank panels or spinner deadlocks.
- [x] ISC-44: The Overview page renders pipeline funnel counts that match `GET /api/stats` `by_stage` values.
- [x] ISC-45: The Prospects page supports search, stage filter, add-prospect, and CSV import against the existing `/api/prospects*` endpoints.
- [x] ISC-46: The campaign builder conversation is reachable from the dashboard UI and drives `/api/campaigns/builder/start` + `/chat` to a `{ done: true }` campaign.
- [x] ISC-47: The Channels page shows, per channel, configured-vs-verified status and daily-limit meters sourced from `GET /api/channels/status` — env-var presence alone is never displayed as "working".
- [x] ISC-48: The Activity page renders real `bdr_touches` rows including `direction` and `blocked` status.
- [x] ISC-49: The Settings page lists, per channel, which required env vars are missing to activate it.
- [x] Anti: ISC-50: No dashboard page requires an external build step — static assets in `public/` served by the Node `http` server only.

### Runtime Hardening (added 2026-07-14)
- [x] ISC-51: `npm run brain` runs standalone without crashing — it initializes the BDR database and loads channels before `runCycle()`.
- [x] ISC-52: The orchestrator boots and serves the dashboard + BDR loop on a machine with no Docker daemon — container runtime degrades gracefully (agent containers are only required for conversational group-chat sessions).
- [x] ISC-53: `GET /api/channels/status` returns `{ channel, configured, verified, dailyLimit, usedToday }` for all seven channels.
- [x] Anti: ISC-54: A machine without Docker never sees `FATAL` from `ensureContainerSystemRunning` — degraded mode is logged, not fatal.

### Channel Completion — LinkedIn / Twitter / SMS / WhatsApp (added 2026-07-14)
- [x] ISC-55: The SMS send path enforces the TCPA 2-unsolicited-touch cap and the suppression list, verified by unit tests.
- [x] ISC-56: WhatsApp outbound is warm-only — a send to a prospect with zero inbound WhatsApp touches is refused, verified by unit test.
- [DEFERRED-VERIFY] ISC-57: The LinkedIn DM sender is code-complete with ≤20 connection-requests/day and ≤50 DMs/day caps enforced; live send is [DEFERRED-VERIFY] pending an authenticated LinkedIn session.
- [x] ISC-58: Twitter/X DM outbound is warm/reply-only — cold DM attempts are refused; warm replies send via `twitter-api-v2` when creds present.
- [x] Anti: ISC-59: No channel's send path bypasses the quality gate or the suppression check — both outbound entry points (`processEnrollment`, `dispatchAction`) enforce both.
- [x] Anti: ISC-60: A channel with absent env credentials performs zero network calls and does not register — self-disable is clean and logged.

### Landing Page — bdrclaw.dev (added 2026-07-15)
- [x] ISC-61: Root `index.html` rebuilt as a sales landing page — single static file, no build step, same zinc-950/orange scheme as the dashboard. *(2026-07-15 resume: live curl 200 on bdrclaw.dev serving the repo file.)*
- [x] ISC-62: Hero shows the multi-channel command-center positioning with a "Start free trial" primary CTA above the fold. *(live HTML title "The AI BDR that books meetings on every channel" + trial CTA present.)*
- [x] ISC-63: Pricing section renders 3 tiers with monthly prices, per-tier feature lists, and a free-trial CTA on each tier. *(12 pricing/free-trial matches in live HTML.)*
- [x] ISC-64: Channel section shows all of: Email, LinkedIn, Instagram, Twitter/X, SMS, WhatsApp, Telegram — with the safety caps framed as protection. *(live grep: all seven present.)*
- [x] ISC-65: CSS transitions throughout: scroll-reveal on sections, hover lifts on cards, smooth anchor scrolling — no external JS libraries beyond the existing CDN stack. *(66 transition/reveal class hits in live HTML.)*
- [x] ISC-66: Anti: the landing page contains no fabricated social proof (no fake testimonials, logos, user counts) and promises no feature that does not exist in the repo today. *(2026-07-15 resume: code-review found WhatsApp outbound overclaim; fixed both sides — whatsapp_dm handler now registered AND copy states warm-only honestly; redeployed, verified live.)*
- [x] ISC-67: The landing page is live and reachable — GitHub Pages build green (`.nojekyll` present); bdrclaw.dev serves it. *(2026-07-15 resume: DNS records landed — https://bdrclaw.dev returns 200 with correct content; deferral lifted.)*

### Dashboard — Fully Functional (added 2026-07-15)
- [x] ISC-68: `POST /api/loop/start` and `POST /api/loop/stop` control the agentic loop from the dashboard; `/api/health` reflects the true state; UI toggle works. *(2026-07-15 resume: live curl round-trip running true→false; honest 409 when no channels; dashboard-write-api tests.)*
- [x] ISC-69: `GET /api/prospects/:id` returns the prospect with full touch timeline; clicking a prospect row opens a detail drawer rendering it. *(live curl + real-Chrome drawer screenshot: header, stage control, contact, timeline with actual sent email.)*
- [ ] ISC-70: Campaigns can be activated AND paused from the UI; state round-trips through PATCH. *(pause tested; activate→enrollment untested — blocked on a real campaign existing; unblocks with ISC-75 demo.)*
- [DEFERRED-VERIFY] ISC-71: The CRM page lists registered adapters (incl. GoHighLevel when configured) and manual pull/push works from the UI. *(2026-07-15 resume: GHL card + env hint added and screenshot-verified; live pull needs Joseph's GHL creds — follow-up: set GHL_API_KEY/GHL_LOCATION_ID and click Pull from CRM.)*
- [ ] ISC-75: The campaign-builder chat driven from the browser UI (not curl) produces a `done:true` campaign — live probe. *(consumes Claude API + creates a campaign; run as the demo that also closes ISC-70/24.)*

- [x] ISC-77: Prospect stage can be changed from the UI (detail drawer control) and round-trips through `updateProspectStage` — the single authoritative CRM-push path. *(live PATCH replied→restore round-trip; enum validation on bogus stage; drawer control screenshot.)*
- [x] ISC-78: The Settings page shows the suppression list entries and supports manually adding a contact to suppression from the UI. *(live POST /api/suppression 201 + entry listed; Settings markup renders suppressionEntries + manual-add form, index.html:726-742.)*
- [x] ISC-79: Anti: starting the agentic loop from the dashboard requires an explicit confirm step warning that real messages will send; the toggle reflects true loop state after page refresh. *(real-Chrome screenshot of the modal: "Starting the loop will send real messages to due prospects"; confirmLoopToggle re-polls /api/health for server truth.)*

### CRM — GoHighLevel (added 2026-07-15)
- [x] ISC-72: A GoHighLevel adapter (`src/crm/gohighlevel.ts`) self-registers when `GHL_API_KEY` + `GHL_LOCATION_ID` are present, pushes stage changes as contact upsert + tag, and is unit-tested with a mocked client. *(2026-07-15 resume: 8/8 tests; synthetic-env probe logs "CRM adapter registered: gohighlevel".)*
- [x] ISC-73: Anti: with GHL env absent, zero GoHighLevel network calls occur and the adapter does not register. *(gohighlevel.test.ts "with env absent (ISC-73)" + env-absent probe → registry empty.)*

### Booking Detection — the last link (added 2026-07-15, session resume)
- [x] ISC-80: Sending a meeting link never sets `meeting_booked` — the email `send_meeting_link` path now writes the new intermediate stage `meeting_link_sent`; a static test asserts the write and forbids `meeting_booked` in that file. *(refined: intermediate stage per advisor, clearer funnel than staying at `interested`.)*
- [x] ISC-81: `meeting_booked` has exactly one automated writer in the codebase — the Calendly webhook handler in `web-ui.ts`; an executable test walks `src/**/*.ts` and fails on any other `updateProspectStage(..., 'meeting_booked')` call site. *(calendly-webhook.test.ts "single-writer invariant" green.)*
- [x] ISC-82: `POST /api/webhooks/calendly` matches the invitee email to a prospect, sets `meeting_booked`, records an inbound touch, and fires the closer notification; HMAC-verified when `CALENDLY_WEBHOOK_SIGNING_KEY` is set; idempotent on invitee URI. *(5 unit tests + localhost live round-trip booked a real prospect row; Calendly-side delivery to a public URL still rides the Railway deploy blocker — covered by ISC-40.)*
- [x] ISC-83: Anti: booking-detection changes land with the full suite green and typecheck 0 — no regression to the 328-test baseline. *(337/337, typecheck exit 0.)*
- [x] ISC-84: The dashboard funnel, stage pills, and stats render the new `meeting_link_sent` stage without falling into an unknown-stage code path. *(real-Chrome screenshot: funnel row "Link sent" between Interested and Meeting booked; PATCH enum lists it.)*

### Dashboard Auth + Railway Deploy (added 2026-07-16)
- [ ] ISC-85: With `BDR_DASHBOARD_PASSWORD` set, every dashboard page and `/api/*` route requires a valid session — unauthenticated page GETs 302 to `/login`, unauthenticated API calls get 401 JSON.
- [ ] ISC-86: `POST /api/login` with the correct password sets an HttpOnly `bdr_session` cookie and grants access; a wrong password returns 401; more than 5 failures per IP per 15 minutes returns 429.
- [ ] ISC-87: Anti: `/api/webhooks/*`, `/unsubscribe`, `/privacy`, `/terms`, and `/api/health` remain reachable WITHOUT auth — Calendly, Twilio, mail providers, and Railway health checks cannot log in.
- [ ] ISC-88: Anti: with `BDR_DASHBOARD_PASSWORD` unset, behavior is unchanged — the full pre-auth test suite passes unmodified.
- [ ] ISC-89: The session cookie is HMAC-signed with an expiry; a tampered or expired token is rejected (unit test).
- [ ] ISC-90: The deployed Railway service answers `GET /api/health` 200 on its public URL and serves `/login` (not the dashboard) to an unauthenticated browser.
- [ ] ISC-91: SQLite + `store/` live on a Railway volume mounted at `/app/store` — data survives a redeploy.
- [ ] ISC-92: The web server honors Railway's injected `PORT` env (falls back to `BDR_WEB_PORT`, then 3000).

### War Room Operations (added 2026-07-15)
- [ ] ISC-74: A perpetual war-room loop is scheduled and documented: each iteration integrates agent output, runs the full suite, live-verifies, pushes, updates ISA/handoff, and re-arms — stopping only when all remaining work is blocked on Joseph. *(2026-07-15 resume: UNBUILT — this is a scope gap, not an environment blocker; no loop artifact exists in docs/, scripts/, or launchd/. Surfaced to Joseph: confirm whether this is still wanted before building.)*
- [ ] ISC-76: Anti: the loop never marks an ISC passed without tool evidence, and never re-litigates decisions recorded in `## Decisions`.


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
- **2026-07-08** — Break B fixed by contract, not by patching the smuggle: `ActionHandler` now takes `(prospect, composed?: ComposedOutbound)` and every message-composition handler routes its body through the shared `resolveOutboundBody(composed, fallback)` helper. Reason: TS can't force a runtime preference, but a required signature + a single audited helper makes "prefer the gated message, else template" one code path a future handler can't silently skip. The prior enrichment-smuggling (`__campaign_message`) is deleted.
- **2026-07-08** — CRM double-push on reply deduped: kept `updateProspectStage`'s automatic `stage_change` push as the single authoritative sync (it fires in every reply branch and is the ISC-25 invariant across all paths) and removed the redundant `reply_received` push from `processReply`. Tradeoff: the distinct `reply_received` event type is dropped; classification still flows to CRM via the stage change.
- **2026-07-08** — Inbound idempotency via a `bdr_processed_inbound(message_id)` table + `markInboundProcessed()` (INSERT OR IGNORE): processReply runs exactly once per message id, so boot re-scans, Twilio webhook retries, and Telegram long-poll redelivery cannot replay history.
- **2026-07-08** — Deleted `src/campaign-runner.ts` (orphaned — `runCampaignTick` never called). The agentic loop is the single live send path; `personalize` lived there but was unused by the loop.
- **2026-07-08** — Channel scope decision (Joseph): cold outreach = Email + SMS + LinkedIn (LinkedIn via self-hosted Patchright); X/Twitter and WhatsApp are warm/reply-only (X cold DMs are policy-banned + mostly undeliverable; Meta paused US marketing templates since Apr 2025). See `docs/MVP-PLAN.md`. This narrows — but does not remove — the "Playwright only for LinkedIn" constraint; Patchright is a drop-in Playwright fork.

- **2026-07-14** — Compliance branch `worktree-agent-afa8559908df401d8` reviewed and merged to main: CAN-SPAM footer + List-Unsubscribe, `/unsubscribe` → `bdr_suppression`, Twilio signature validation, `/privacy` + `/terms`. Suite 256/256, typecheck clean post-merge.
- **2026-07-14** — Dashboard v2 + channel completion executed by three parallel Fable subagents with strict file ownership (Backend: `web-ui.ts`/`index.ts`/`bdr-brain.ts`/`container-runtime.ts`; Frontend: `public/**`; Channels: `src/channels/**` + `*-bdr-actions.ts`). Reason: Joseph's explicit directive ("three subagents of Fable"); ownership partitioning replaces worktree isolation to avoid a 3-way merge.
- **2026-07-14** — Forge auto-include (E4 coding) and Cato cross-vendor audit are environmentally blocked: codex routes to a tailnet Ollama host and Tailscale is logged out (documented in HANDOFF gotchas). Show-your-math: delegation floor met with 3× Fable agents; Cato audit deferred with follow-up "run Cato after `tailscale up`".
- **2026-07-14** — EnterPlanMode skipped despite E4: Joseph's message is an explicit execute directive ("Please finish this"), not a planning request.
- **2026-07-14** — ISC floor (E4 ≥128) not inflated to quota: project ISA carries 60 real criteria. Show-your-math: padding to 128 would violate the granularity-first rule that criteria describe the actual ideal state.
- **2026-07-15** — War-room panel (Strategist/Quant/Critic, 2 rounds, fresh Auditor) decided landing positioning + pricing; full record: War Room DEC-2026-07-15. Auditor FAILED the raw panel output; synthesis shipped only audit-fixed claims (no unsourced SDR dollar figure, no fabricated LTV:CAC on page, LinkedIn as "guided setup").
- **2026-07-15** — E5 Interview-before-BUILD gate waived (show-your-math): principal issued an execute directive and is not available for interactive interview; the war-room panel + prior handoffs stand in as elicitation. CheckCompleteness run instead.
- **2026-07-15** — Forge auto-include and Cato remain environmentally blocked (Tailscale logged out); fleet is 3× Fable + sonnet panel per principal's standing "Fable subagents" directive.
- **2026-07-15** — GH Pages build "errored" root-caused to Jekyll processing repo files containing `{{ }}`; fix is `.nojekyll` (landing agent owns). bdrclaw.dev DNS nonexistent — Joseph-blocked; exact records: A @ → 185.199.108.153/109/110/111, CNAME www → josefusan.github.io.
- **2026-07-15 (session resume)** — Booking detection mechanism decided per advisor: the Calendly `invitee.created` webhook is the ONLY writer of `meeting_booked`; the email `send_meeting_link` path writes the new intermediate stage `meeting_link_sent` (was wrongly writing `meeting_booked` at link-send — the flagship metric counted link-sends). Reply-classification booking detection REJECTED: text intent ("I'll grab a slot") is not a booking; a false positive silently drops the prospect out of follow-up and loses the meeting — worse than the bug it replaces because it feels correct. Do not later "fix" booking detection by making the reply handler authoritative.
- **2026-07-15 (session resume)** — EnterPlanMode skipped at E4: "we need to finish it" is an execute directive; session is autonomous. Forge/Cato remain environmentally blocked (`tailscale status` → "Logged out."); delegation floor met with code-reviewer + Explore Fable agents on the 4 unreviewed lost-session commits. **The booking-detection + CSRF work shipped this session is Cato-unattested** — run the cross-vendor audit after `tailscale up`.
- **2026-07-15 (session resume)** — refined: ISC-23 dropped. The evidence sweep showed builder templates *by design* carry `{{firstName}}`/`{{company}}` placeholders that compose-time fills; a build-time gate would fail every correct template. The wire is the enforcement point (loop.e2e asserts no `{{` leak). Tombstoned, not renumbered.
- **2026-07-15 (session resume)** — refined: ISC-25 reworded. "Within the same logical operation (not async-fire-and-forget)" contradicted ISC-27 (push failure must never block the stage change). Decided semantics: push is triggered synchronously-in-code-path from `updateProspectStage` but detached and failure-swallowing. `updateProspectStage` stays sync (better-sqlite3); awaiting the push would ripple async through every caller for no user-visible gain.
- **2026-07-15 (session resume)** — CSRF guard design: Origin-header check on all POST/PATCH (mismatch → 403). Origin-less requests pass — that is how Calendly/Twilio/mail-provider servers call us, and local curl. Browser CSRF is closed (browsers always attach Origin to cross-origin POSTs). Residual: the dashboard has NO auth — acceptable only while bound to 127.0.0.1. **Auth must ship with (or before) the Railway public deploy.**
- **2026-07-15 (session resume)** — instagram_dm + whatsapp_dm handlers registered (warm-only enforced inside each channel's sendMessage). Root cause of the seam: campaign-builder's action_type vocabulary grew faster than the handler registry, and nothing failed loudly when they diverged — `getActionHandler()` returning undefined just skipped the send.


---

## Changelog

- **2026-07-15** — conjectured: "the meeting-booking loop was closed" — sending the Calendly link and flipping `stage: meeting_booked` was treated as the end of the funnel, and the dashboard's flagship "Meetings booked" stat counted it. refuted_by: an IterativeDepth trace of the full chain (outbound → reply → interested → link → booked → CRM → notify) found no booking-detection mechanism anywhere — `meeting_booked` was written at link-*send* (gmail-bdr-actions.ts:286), so the metric counted intentions, not meetings; the advisor further refuted the proposed reply-classification fix (text intent "I'll grab a slot" is not a booking; a false positive silently drops the prospect out of follow-up and loses the meeting). learned: a pipeline stage must be written by the system that *observes* the event, not the system that *hopes* for it — hard signals (Calendly `invitee.created`) book meetings, soft signals (message text) only stage intent; and single-writer invariants are only real when an executable test enforces them. criterion_now: ISC-80 (link send → `meeting_link_sent`, never `meeting_booked`), ISC-81 (webhook is the sole automated writer, enforced by a source-walking test), ISC-82 (webhook books, records, notifies — HMAC + idempotent).

- **2026-07-08** — conjectured: "the module existing = the feature existing" — the agent layer (compose, gate, reply-handler) was fully built and unit-tested. refuted_by: an end-to-end trace showed inbound `processReply` was imported but never called, and the composed+gated message was written to `enrichment.__campaign_message` which no handler read — so the delivered message never passed the gate and no reply was ever classified. learned: unit tests on modules don't catch open seams *between* modules; the wiring breaks lived exactly where two pipelines (the agentic loop and the legacy NanoClaw `*-bdr-actions` handlers) joined by convention (enrichment-JSON smuggling, a never-called import) rather than by types. criterion_now: a single end-to-end edge test (`src/agents/loop.e2e.test.ts`) asserts the channel payload equals the gated body and that an inbound reply changes stage — the missing feedback loop that would have caught both breaks. `ISC-15`'s original "manual grep" verification is why it didn't.

---

## Verification

- **ISC-5/6/7/15 (Break B)** — `src/agents/loop.e2e.test.ts` › "the composed + gated message reaches the channel handler": registers a capturing `send_sms` handler, runs one tick, asserts `captured === GATED_BODY` and `not.toMatch(/\{\{/)`. Passes (3/3 in file). Pre-fix this assertion fails: the old `injectMessage` smuggle passed the handler a `prospect` with no `composed` arg, so `captured` would be `undefined`.
- **ISC-13** — `loop.ts` blocked-touch path now writes `status: 'blocked'`; `TouchStatus` union + `getRecentActivity` mapping updated. `npm run typecheck` exit 0.
- **ISC-16/20 (Break A)** — e2e test › "an inbound reply is classified and moves the prospect stage": `processReply` → stage `interested`, inbound touch recorded with `reply_classification`. Passes.
- **ISC-17** — e2e test › "a deterministic STOP unsubscribes without any AI call and halts outbound": stage → `unsubscribed`, classifier call count `=== 0` (pre-gate ran first), and a subsequent tick does not invoke the send handler (suppression + stage skip). Passes.
- **ISC-31/32** — `[DEFERRED-VERIFY]`: wired in `src/index.ts` onMessage → `getProspectByContact` → `processReply`; live round-trip requires the Phase 2 deploy (public webhook URL / running bot). Verified in-code by typecheck + the e2e inbound path using the `'sms'` channel.
- **Full suite** — `npm test`: 233 passed / 20 files. `npm run typecheck`: exit 0. `npm run lint`: zero errors on touched files (pre-existing repo-wide `no-catch-all` warnings only). Grep probes: `__campaign_message` 0 matches, `campaign-runner` 0 (code) refs, `runCampaignTick`/`registerCampaignRunner` 0.

### 2026-07-14 — Dashboard v2 + runtime hardening + channel completion

- **ISC-29/30/60** — `src/channels/{sms,whatsapp,twitter,linkedin,registry}.test.ts`: factories return null without env (zero client calls asserted); every sendMessage() throws at its daily cap. 40/40 targeted channel tests green.
- **ISC-33/34/35/36** — `src/dashboard-api.test.ts` (12 tests) + live probes: `GET /api/health` → `{"status":"ok",...}` instant; `GET /` → 200 SPA; all 500s routed through `internalError()`.
- **ISC-37** — `tsc --noEmit` exit 0 post-integration.
- **ISC-42..45/47..50** — live browser verification (claude-in-chrome, real Chrome): Overview funnel matches `by_stage` (1 outreach_sent = Jordan Testwell), Prospects table + Import CSV/Add prospect controls, Channels page shows email Configured+Verified (real OAuth token) with limit meters + cap messaging, Activity feed renders the real 2026-07-10 touch with content preview, Settings shows health + per-channel missing env names ("All set" for email). Zero console errors on fresh load. Empty states confirmed on Campaigns and Hot Leads.
- **ISC-46** — builder chat UI present and wired (CTA verified on Campaigns page); full conversation round-trip to `{done:true}` not yet driven — pending live demo (consumes Claude API + composes campaign).
- **ISC-51** — `npm run brain` standalone: 8 handlers registered, cycle ran, exit 0 (no Docker present).
- **ISC-52/54** — boot with docker absent: probe returns false, warning logged, process continues; `runContainerAgent()` returns per-session `{status:'error'}` instead of process death.
- **ISC-53** — live curl: 7-channel array with configured/verified/dailyLimit/usedToday; email true/true after .env hydration (`src/load-env.ts`, closes handoff bug 3 as hydrate-at-startup).
- **ISC-55/56/58** — sms.test.ts (TCPA cap + suppression throw), whatsapp.test.ts (warm-only refusal), twitter.test.ts (cold DM refused pre-network, warm reply sends). 
- **ISC-57 [DEFERRED-VERIFY]** — cap logic + persistence (`store/linkedin-daily-usage.json`) unit-tested with browser mocked. Follow-up: run `npm run linkedin-auth`, set `LINKEDIN_ENABLED=true`, smoke-check DOM selectors on first live send.
- **ISC-59** — channel-level suppression/gate backstops inside sendMessage() + `loop.e2e.test.ts` gated-body assertion; both entry points enforce suppression.
- **Full suite** — 307 passed / 30 files (was 233 pre-session). Typecheck 0. Compliance branch merged (List-Unsubscribe, /unsubscribe→bdr_suppression, Twilio signature validation, /privacy, /terms).
- **ISC-21/22/46 (live, 2026-07-14)** — builder round-trip driven against the running server with the real Claude API: `/builder/start` → sessionId + opening question (<5s); two chat turns → `{done:true}` with campaign "BDRclaw - Solo Founder Pipeline Builder", 7 steps spanning send_email / linkedin_connect / linkedin_dm / send_sms. Advisor gate: 401 shadow-key failure diagnosed (shell env key outranked .env by design) — restart without shell key succeeded; `{error:"Internal error"}` surfaced to client while the real 401 stayed server-side (ISC-36 behaving under real failure).
- **ISC-59 (email backstop, 2026-07-14)** — `assertNotSuppressed('email', to)` added to `sendBDREmail()`; email now has the same channel-level suppression chokepoint as sms/whatsapp/twitter/linkedin. Typecheck 0; channels+e2e 43/43.

### 2026-07-15 (session resume) — booking detection + full-stack verification

- **ISC-61..67 (landing, live)** — `curl https://bdrclaw.dev/` → 200 with correct title, 3-tier pricing, all 7 channels, 66 transition/reveal class hits; DNS records now exist (ISC-67 deferral lifted). WhatsApp copy fixed to warm-only and re-verified live post-push.
- **ISC-68/69/77/78/79 (dashboard write paths, live)** — real-Chrome session: prospect drawer with touch timeline + stage dropdown ("Stage changes push to every connected CRM"), loop-start confirm modal ("will send real messages"), zero console errors on every page visited; curl round-trips: stage PATCH replied→restore with enum validation, loop start/stop with `/api/health` truth, suppression POST 201 + list.
- **ISC-70** — pause covered by dashboard-write-api tests; activate→enroll→tick untested pending a real campaign (unblocks with the ISC-75 demo).
- **ISC-71 [DEFERRED-VERIFY]** — GoHighLevel card + `GHL_API_KEY`/`GHL_LOCATION_ID` hint added to CRM Sync page, screenshot-verified; live pull requires Joseph's GHL creds.
- **ISC-72/73 (GHL)** — 8/8 adapter tests (upsert+tag push, CRMContact pull mapping, ISC-27 non-throw, env-absent zero-fetch); synthetic-env probe: registered with env, absent without.
- **ISC-80..84 (booking detection)** — calendly-webhook.test.ts 9/9: booking round-trip (stage + inbound touch), idempotent retry, unknown-invitee 200, non-booking event ignored, HMAC reject/accept, CSRF 403 cross-origin + same-origin/server-to-server pass, single-writer source walk, meeting-link-sender static probe. Localhost live probe: webhook booked the real Jordan Testwell row (`stage after webhook: meeting_booked`), restored after. Funnel renders "Link sent" (screenshot).
- **Full suite** — 337 passed / 33 files (was 328/32 at session start); `tsc --noEmit` exit 0; pushed as 8ad67b8 + 552a9e9.
- **Cato** — NOT run (Tailscale logged out, third consecutive session). This session's work is cross-vendor-unattested.
