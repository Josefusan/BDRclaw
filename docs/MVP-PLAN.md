# BDRclaw MVP Completion Plan

> Produced 2026-07-08 from a five-stream research run: codebase audit, Obsidian vault mining,
> and deep channel research (SMS / LinkedIn / Twitter / WhatsApp, all 2026-current with sources).
> Companion to `ISA.md` (the system of record) — every work item below maps to project ISC numbers.

---

## 1. Where the MVP actually stands

**The good news: this is a wiring problem, not a building problem.**

- `npm run typecheck` passes clean (ISC-37 ✓). All seven channels' `sendMessage()` are **real implementations** — Twilio SMS (`src/channels/sms.ts:85`), Twilio WhatsApp (`whatsapp.ts:87`), Playwright LinkedIn (`linkedin.ts:269`), twitter-api-v2 DMs (`twitter.ts:83`), Gmail, Telegram, Instagram. Daily caps throw when hit (ISC-30 ✓). All self-register (ISC-29 ✓).
- The agent layer is real, not skeleton: loop with error isolation + SIGTERM handling (ISC-1..4 ✓), Sonnet composer, Haiku quality gate (11 passing tests), 7-way reply classifier, conversational campaign builder, three CRM adapters (HubSpot/Salesforce/Monday).
- ~1,900 lines of **uncommitted** agent-swarm work sits in this working copy: `bdr-manager` (VP-of-Sales oversight), `cold-outreach-agent`, `crm-agent`, `meeting-intelligence`, `oration`, `second-brain`, `deals-db`, `integrations/{instantly,otter,salesforge,zoom}`. Typechecks clean. This IS the swarm architecture the vault's war-room notes describe (maker → checker → oversight). **Commit it.**

**The two breaks that make it non-functional:**

- **Break A — inbound is dead-ended.** `processReply` (`src/agents/reply-handler.ts:132`) is imported at `src/index.ts:70` and called **nowhere**. Every channel's inbound stops at `storeMessage()` (`index.ts:560-586`). No prospect-by-contact lookup exists in `bdr-db.ts` (only `getProspectById`), so replies can't even be mapped to prospects. Kills ISC-16..20, 31, 32 — unsubscribe enforcement, hot-lead alerts, stage changes, CRM sync on reply.
- **Break B — the gated message is thrown away.** `loop.ts:299-317` composes via Sonnet, gates via Haiku, then stores the approved text as `enrichment.__campaign_message` — which **no action handler ever reads**. Every `*-bdr-actions.ts` sends its own hardcoded template instead. The product's core promise (AI-composed, quality-gated messages) never reaches the wire. Violates ISC-5/6/7/15 semantically.
- **Break C — never deployed.** `bdrclaw.dev/api/health` → 404 (static landing page only). Twilio webhooks have nowhere to land. ISC-40 fails.

Everything else is polish: `whatsapp_dm`/`instagram_dm` action handlers missing, `campaign-runner.ts` orphaned (dead code), blocked touches logged as `'bounced'` not `'blocked'` (ISC-13, `loop.ts:224`), no Twilio signature validation, `npm run auth` points at a nonexistent file, BDR layer essentially untested beyond the quality gate.

---

## 2. Channel strategy — what 2026 reality permits (researched, sourced)

| Channel | Verdict | Path | Cost | Key constraint |
|---|---|---|---|---|
| **Email** | ✅ Cold-viable, already built | Gmail OAuth (done) | ~$0 | Add List-Unsubscribe header, CAN-SPAM address |
| **SMS** | ✅ Cold-viable with compliance engine | Twilio A2P 10DLC — **start registration day one** (1–4 wks, EIN ≥30 days old); toll-free verification (3–5 days, free) as pilot bridge | ~$60 one-time, ~$45-60/mo @ 100/day | TCPA: $500–1,500/msg statutory damages. Consent attestation, quiet hours (8am–9pm recipient-local; FL/OK/WA 8–8, TX 9–9), STOP + natural-language opt-out, suppression list — all enforced in code |
| **LinkedIn DM** | ✅ Viable via intermediary | **Unipile** (~$55/mo, 10 accounts, real Node SDK, hosted white-label auth, 1–2 days integration). Keep Playwright→**Patchright** self-hosted as fallback behind the same channel interface | $55/mo | Official API is a dead end; HeyReach got publicly hit Mar 2026 — avoid centralized cloud-fleet pattern; ≤20–25 connections/day, ≤50 DMs/day, warm-up ramps |
| **Twitter/X DM** | ⚠️ **Warm/inbound only** | Official pay-per-use API ($0.015/DM send; Feb 2026 killed Basic/Pro for new signups). OAuth2 PKCE `dm.read dm.write` — twitter-api-v2 v1.29 supports it | ~$35-50/mo @ 50/day | Cold DMs: banned by policy AND mostly undeliverable (DM privacy settings). Reposition as engage-publicly → DM-on-reply |
| **WhatsApp** | ⚠️ **US cold outreach is platform-dead** | Meta paused ALL marketing templates to US numbers Apr 2025 — still active, no end date. Keep Twilio WhatsApp (already coded) for international prospects + inbound/service replies | ~$0.006-0.025/msg intl | Template approval, 24h service window, quality-rating monitor. Reject Baileys/whatsapp-web.js (2–8 week ban timelines) |
| Telegram | ✅ Works now (long-poll, no webhook needed) | Already built | ~$0 | — |
| Instagram | Warm-only (Meta ToS) | Already built | — | Enforce warm-only in code, not comments |

**Strategic consequence:** the cold trio is **Email + SMS + LinkedIn**. X and WhatsApp remain in the product as warm/reply channels (the code already exists) — which is still a differentiator, honestly scoped.

---

## 3. Build plan — ordered, with project-ISA mapping

### Phase 0 — Paperwork day one (parallel with all code)
| # | Item | ISCs | Effort |
|---|---|---|---|
| 0.1 | Commit the uncommitted swarm work (review → commit → push) | — | 1h |
| 0.2 | Twilio: paid account, buy 10DLC number, submit brand + campaign registration (honest opt-in description); submit toll-free verification as bridge | ISC-31 prereq | 2h + 1-4 wk wait |
| 0.3 | Unipile trial signup (7-day, no card) | ISC-29 | 15 min |

### Phase 1 — Close the loop (the actual MVP)
| # | Item | ISCs | Effort |
|---|---|---|---|
| 1.1 | **Fix Break B by contract**: change action-handler signature to accept `{body, subject}` explicitly (type-enforced, not enrichment-smuggled); handlers prefer composed message, template only as fallback | ISC-5,6,7,9,15 | 0.5–1 day |
| 1.2 | **Fix Break A**: add `getProspectByContact()` (phone/email/handle/chat-id) to `bdr-db.ts`; route `channelOpts.onMessage` → `processReply()` after `storeMessage()`. Guards: idempotency watermark (first boot will replay stored messages), dedupe double CRM push (reply-handler + `updateProspectStage` both push) | ISC-16..20,31,32 | 1–1.5 days |
| 1.3 | **Deterministic compliance pre-gate**: STOP/UNSUBSCRIBE keyword handling in webhook path BEFORE any Claude call; global suppression list checked inside `sendMessage` path | ISC-17 | 0.5 day |
| 1.4 | One **end-to-end edge test**: enroll → compose → gate → assert wire payload === gated body → simulated reply → stage change → CRM event. This is the test that would have caught both breaks | ISC-15 test | 0.5 day |
| 1.5 | Fix ISC-13: `'blocked'` not `'bounced'` (`loop.ts:224`); retire `campaign-runner.ts` properly — `runCampaignTick` is never called, but `index.ts:495` registers it and `loop.ts:33` imports `personalize` from it, so relocate `personalize` + remove the registration before removing the file (naive delete breaks the build); remove unused imports (lint passes) | ISC-13 | 2h |

### Phase 2 — Deploy (unblocks webhooks)
| # | Item | ISCs | Effort |
|---|---|---|---|
| 2.1 | Railway deploy (Dockerfile + railway.json exist), env vars, volume-mount SQLite; point bdrclaw.dev DNS at service (landing page moves to `/` route or subdomain) | ISC-38..40 | 0.5 day |
| 2.2 | Twilio webhook signature validation (`twilio.validateRequest`) on `/webhooks/sms` + `/webhooks/whatsapp`; point numbers at bdrclaw.dev | ISC-31, ISC-36 | 2h |
| 2.3 | Verify: `curl https://bdrclaw.dev/api/health` → `{status:"ok"}`; live SMS round-trip once 10DLC/toll-free approves | ISC-40 | 1h |

### Phase 3 — SMS compliance engine (before any SMS campaign activates)
| # | Item | ISCs | Effort |
|---|---|---|---|
| 3.1 | Consent fields (`consent_source`, `consent_timestamp`) on prospects; block sends without them; attestation checkbox at CSV import | new ISC | 0.5 day |
| 3.2 | Quiet-hours engine: recipient-local 8am–9pm + state table (FL/OK/WA/TX); `timezone.ts` already exists — wire it | new ISC | 0.5 day |
| 3.3 | TCPA 2-touch cap: count from `bdr_touches` (not regex over memory text, current `sms-bdr-actions.ts:57` approach) | ISA constraint | 2h |
| 3.4 | Consent/opt-out event log (litigation defense) | new ISC | 2h |

### Phase 4 — LinkedIn via Patchright self-hosted *(DECIDED 2026-07-08: Joseph chose self-hosted over Unipile)*
Rationale: lowest detection surface (runs in the user's real browser, own machine, own residential IP — the posture LinkedIn's 2026 enforcement treats most leniently), zero per-account SaaS fee, and it evolves the code that already exists rather than adding a vendor dependency. Cost: ownership of the selector-drift + anti-bot arms race.
| # | Item | ISCs | Effort |
|---|---|---|---|
| 4.1 | Swap `playwright` → **`patchright`** (drop-in fork, ~same API, patches 40+ fingerprint properties vs playwright-stealth's ~12). Update `src/channels/linkedin.ts` import + `linkedin-auth` setup | ISA constraint | 0.5 day |
| 4.2 | Human-pacing engine: randomized 300–2000ms micro-delays, 45–120s between profile views/messages, `headless:false` + Xvfb on Linux | ISA constraint | 0.5 day |
| 4.3 | Keep 20 connections/day + 50 DMs/day caps (already enforced `linkedin.ts:105,129`); add account-age warm-up ramp for <150-connection accounts; fingerprint hygiene per account | ISA constraint | 0.5 day |
| 4.4 | Robust selector-drift handling (LinkedIn changes DOM frequently — the main maintenance tax); wire LinkedIn inbound poll → `processReply` (part of Break A fix, Phase 1.2) | ISC-32 | 0.5 day |
| — | *Deferred option:* abstract behind the channel interface so Unipile (~$55/mo, faster) can drop in later if self-hosted maintenance proves too heavy | — | later |

### Phase 5 — Reposition X + WhatsApp honestly
| # | Item | Effort |
|---|---|---|
| 5.1 | X: migrate OAuth 1.0a → OAuth2 PKCE, pay-per-use credits with spend cap; gate DM sends to prospects with prior inbound/engagement | 1 day |
| 5.2 | WhatsApp: `whatsapp_dm` action handler (currently missing — channel can't campaign-send); restrict to international numbers + 24h-window replies; template management via Twilio Content API | 1 day |
| 5.3 | Instagram: enforce warm-only in code (has-prior-inbound-touch check); add `instagram_dm` handler | 0.5 day |

### Phase 6 — Test the BDR layer
Vitest for reply-handler classifications (7/7), bdr-agent no-placeholder/no-repeat, loop error-injection — per ISA Test Strategy table. ~1–2 days.

### Phase 3.5 — Email deliverability (before email volume scales)
SPF + DKIM + DMARC records on the sending domain; gradual volume warmup (or delegate to an Instantly/Smartlead-style warmup pool per ROADMAP Phase 3); List-Unsubscribe + RFC 8058 one-click header; CAN-SPAM physical address; cross-account suppression list. ~1 day engineering + 2–4 weeks warmup running in background.

**Effort, split honestly:**
- **Engineering: ~9–12 working days** (Phases 1–6 above)
- **External lead-time (runs in parallel, not engineering)**: Twilio 10DLC 1–4 weeks · toll-free bridge 3–5 days · email domain warmup 2–4 weeks · Meta business verification 3–10 days (only if intl WhatsApp) · Unipile same-day
- **Critical path to demoable MVP: Phase 1 + 2 on email alone = ~3–4 days** — no external approvals required; SMS/LinkedIn light up as registrations clear.

---

## 4. What the vault contributed

- **Swarm doctrine** (`AI/How to Build a Swarm...`): maker-checker split ✓ (agent→gate), state persistence ✓ (prospect memory), specialist agents ✓ (uncommitted swarm files) — missing piece was *"no external stopping condition"* → the e2e edge test (1.4) is that external verifier.
- **War Room patterns** (vault + `~/war-room` constitution): one anchor file per sub-agent role → consider per-agent context docs later; mandatory risk gate before user approval → hot-lead notifications should propose, not auto-commit.
- **No prior BDRclaw planning notes exist in the vault** — the repo's ISA/ROADMAP are the freshest thinking. This plan is now the bridge between them and 2026 platform reality.

## 5. Decisions — RESOLVED 2026-07-08

1. **LinkedIn**: ✅ **Patchright self-hosted** (free, ~2 days, lowest ban surface, evolves existing Playwright code). Unipile kept as a documented later-swap option behind the channel interface. → Phase 4.
2. **Channel scope**: ✅ **Cold trio (Email + SMS + LinkedIn) + X/WhatsApp as warm/reply channels.** Landing-page copy needs updating to stop promising cold outreach on X/WhatsApp/Instagram. → new Phase 7.
3. **Twilio**: ✅ **Start 10DLC registration this week with Joseph's EIN.** See `docs/TWILIO-10DLC-SETUP.md`. Toll-free bridge in parallel.
4. **Push**: ✅ Committed swarm work + plan pushed to GitHub `main` (68e64df).

### Phase 7 — Landing-page honesty pass *(new, from scope decision)*
Update `public/index.html` / `index.html`: reframe X, WhatsApp, Instagram as "warm follow-up & reply" channels; keep Email/SMS/LinkedIn as the cold-outreach headline. ~2h. Prevents a promise the platform policies won't let the product keep.
