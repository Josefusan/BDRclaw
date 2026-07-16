# BDRclaw — Session Hand-off

> **Last updated:** 2026-07-16 · **Branch:** `main` · **Head:** `34b79e1`

## ✅ Done 2026-07-16 (auth + deploy prep + war-room sweep)

| Item | Detail |
|------|--------|
| **Dashboard auth SHIPPED** | `BDR_DASHBOARD_PASSWORD` gates everything; HMAC session cookie (random secret auto-persisted to `store/session-secret`, NOT password-derived); rate-limited login; webhooks/health/legal pages exempt. Live-verified. |
| **Deploy fully staged** | Dockerfile fixed (devDeps for tsc → build → prune; **first build would have failed** without this), tzdata added, Chromium cut (~700MB), `PORT` honored, `healthcheckPath` set, Gmail tokens seed from `GMAIL_TOKEN_<N>_B64`. Runbook: `docs/DEPLOY-RAILWAY.md`. |
| **War-room: 4 Fable agents** | +20 tests (loop lifecycle, HubSpot self-disable, CRM pull, full booking-flow e2e). Suite **365/365**. |
| **Security audit + fixes** | Adversarial Fable agent (Cato-substitute). Fixed: webhook fails CLOSED on deploy w/o signing key (was pipeline-injection hole), session secret independent-random, rate-limiter bounded, constant-time compares, same-origin CORS. `searchProspects` SQLi flag = false alarm (parameterized). |
| **Live-verified in browser** | Builder chat → `done:true` campaign (ISC-75), activate→enroll (ISC-70/24), all zero console errors. |
| Env bug fixed | `.env`/`.env.example` said `HUBSPOT_API_KEY`, code reads `HUBSPOT_ACCESS_TOKEN` — adapter could never enable from the template. |

### 🎯 THE deploy is one step from done
**Run `railway login` (interactive — only you can), then follow `docs/DEPLOY-RAILWAY.md`.** Everything else is staged & verified. Generate `BDR_DASHBOARD_PASSWORD` + `BDR_SESSION_SECRET` with openssl first (runbook step 1).

### Known product bugs (not deploy blockers — logged as ISC-93/94/95 in ISA)
- ISC-93: `send_meeting_link` bypasses the daily send-limit accounting.
- ISC-94: interested-branch inline reply is dead at the `routeInboundToReplyHandler` seam — the calendar link only sends on the next daily brain cycle (up-to-24h stall on the hottest lead).
- ISC-95: HubSpot `mapStage()` is dead code — no deal-pipeline stage is written.

### Still open / blocked
- ISC-90/91: live Railway probes — blocked on `railway login`.
- ISC-71: GHL live pull — needs Joseph's GHL creds.
- ISC-74: war-room perpetual loop — UNBUILT (ask Joseph if still wanted).
- Cato cross-vendor audit — Tailscale logged out 4 sessions running.

---

## Previous session (2026-07-15 resume)

## ✅ Done 2026-07-15 (resume session — booking detection + verification sweep)

| Item | Detail |
|------|--------|
| **Booking detection is real now** | `meeting_booked` was being written at link-*send* — the flagship metric counted intentions. New stage `meeting_link_sent`; `POST /api/webhooks/calendly` (invitee.created, HMAC when `CALENDLY_WEBHOOK_SIGNING_KEY` set, idempotent on invitee URI) is the ONLY automated writer of `meeting_booked` — enforced by an executable source-walking test. Do NOT "fix" booking detection via reply classification (advisor-refuted: text intent ≠ booking). |
| CSRF guard | Origin-mismatch → 403 on all POST/PATCH; origin-less (server-to-server) passes. **Dashboard still has NO auth — fine on 127.0.0.1, MUST ship auth with the Railway public deploy.** |
| whatsapp_dm + instagram_dm handlers | Campaign builder listed both as valid action_types but no handlers existed → emitted steps silently no-oped. Both registered now, warm-only enforced in each channel's sendMessage. Landing WhatsApp copy made honest (warm-only). |
| GoHighLevel visible in UI | CRM Sync page has a GHL card + `GHL_API_KEY`/`GHL_LOCATION_ID` hint; adapter 8/8 tests, registration probed both directions. |
| bdrclaw.dev is LIVE | Joseph's DNS records landed — https://bdrclaw.dev serves the landing page (200, all sections). |
| Verification sweep | Dashboard write paths live-verified in real Chrome (drawer, loop confirm modal, stage PATCH, suppression) — zero console errors. Old ISCs 9-12/25/27/39 closed with named test evidence. ISC-23 tombstoned (wrong assumption), ISC-25 reworded. |
| Suite | **337/337**, typecheck 0, pushed (`8ad67b8`, `552a9e9`). Session work is **Cato-unattested** (Tailscale still logged out). |

### 👉 Next actions (2026-07-15)
1. **Railway deploy + auth** — deploy flips ISC-31/32/40 and gives Calendly a public webhook URL; **add dashboard auth in the same move** (no-auth is only safe on localhost).
2. **Calendly webhook subscription** — after deploy: create webhook subscription for `invitee.created` → `https://<host>/api/webhooks/calendly`, set `CALENDLY_WEBHOOK_SIGNING_KEY`.
3. **GHL live creds** — set `GHL_API_KEY` + `GHL_LOCATION_ID`, click "Pull from CRM" (flips ISC-71).
4. **Builder live demo from browser UI** (flips ISC-75, then ISC-70/24 via activate).
5. **ISC-74 (war-room perpetual loop)** — UNBUILT, not blocked. Joseph: still wanted?
6. Carried from 07-14: LinkedIn live auth (ISC-57), Twitter creds, Twilio 10DLC, deliverability warmup.

---

## Previous session (2026-07-14)
> Read this first when you come back. It's the "where did I leave off" file.
> Full detail: `ISA.md` (build system-of-record), `docs/MVP-PLAN.md` (the plan), `docs/TWILIO-10DLC-SETUP.md` (SMS paperwork).

---

## TL;DR — where things stand

**BDRclaw is now a real web application.** Three parallel Fable agents finished the product in one session (2026-07-14): a six-page SaaS dashboard (Overview funnel, Prospects + CSV import, Campaigns + AI builder chat, Channels with configured-vs-verified + cap meters, Activity feed, Settings) live-verified in real Chrome with zero console errors; the compliance branch merged; the two boot bugs fixed at their ingestion points (composition root `src/bootstrap.ts` + containerless mode); `.env` hydration at startup (`src/load-env.ts`); and the four outbound channels completed with compliance enforced *inside* `sendMessage()` (SMS TCPA 2-touch + suppression, WhatsApp warm-only, LinkedIn persisted daily caps, Twitter warm-reply-only, email suppression backstop). **The AI campaign builder round-trip ran live**: BDR Claude built a 7-step / 4-channel campaign from a 2-message conversation (`done:true`). Suite: **307/307**, typecheck 0, pushed.

Start it: `npm run web` → http://localhost:8931 (or BDR_WEB_PORT). `npm run brain` now works standalone. Docker no longer required to boot.

---

## ✅ Done this session (2026-07-14)

| Item | Detail |
|------|--------|
| Compliance branch merged | CAN-SPAM footer + List-Unsubscribe, `/unsubscribe` → `bdr_suppression`, Twilio signature validation, `/privacy` + `/terms` |
| Dashboard v2 | `public/` rebuilt (index.html + app.js + styles.css), no build step, Tailwind CDN + Alpine, inline-SVG funnel/sparkline/meters, empty states everywhere, honest loop-stopped + configured-vs-verified states |
| Backend APIs | `/api/channels/status` (7-channel configured/verified/limits/usedToday), `/api/settings/env` (missing var names), `/api/suppression`; all 500s → `{error:"Internal error"}` |
| Bug 1 (brain crash) | Composition root `src/bootstrap.ts` (`initCore()`), real entry `src/brain-cli.ts` — verified exit 0 standalone |
| Bug 2 (Docker fatal) | `isContainerRuntimeAvailable()` probe at boot (warn + continue), check moved to point-of-use in `runContainerAgent()` — verified boot without Docker |
| Bug 3 (.env hydration) | DECIDED: hydrate at startup. `src/load-env.ts`, first import of all three entry points; deployment env vars always win |
| Channels | Compliance inside `sendMessage()` per channel (`src/channels/compliance.ts`): SMS TCPA+suppression, WhatsApp warm-only, LinkedIn caps persisted (`store/linkedin-daily-usage.json`), Twitter warm-reply-only (cold-DM template deleted), email suppression backstop, self-disable tests. 40+ new channel tests |
| Live builder round-trip | `/api/campaigns/builder/start`+`/chat` → 7-step campaign, `done:true`, real Claude API |

## ⚠️ New gotchas (2026-07-14)

- **Shell `ANTHROPIC_API_KEY` shadows `.env`** — hydration never overrides existing env vars, so a stale exported key (e.g. from a Claude Code session) causes 401s. Run `env -u ANTHROPIC_API_KEY npm run web` if the shell exports one.
- **LinkedIn daily counters** live in `store/linkedin-daily-usage.json` (not SQLite) — same durability home as session cookies.
- **`.claude/` is now gitignored** (agent worktrees were accidentally committable).

## 👉 Next actions

1. **Cato cross-vendor audit** — was blocked (Tailscale logged out → codex unreachable). `tailscale up`, then audit the compliance-critical send logic.
2. **LinkedIn live send** (flips ISC-57): `npm run linkedin-auth`, set `LINKEDIN_ENABLED=true`, smoke-check DOM selectors on first real DM.
3. **Twitter creds**: Basic-tier dev account + `npm run twitter-auth`.
4. **Railway deploy** (unchanged from last session): `railway login`, volume-mount SQLite, env vars, DNS → flips ISC-31/32/40. Containerless mode now makes this possible.
5. **Twilio 10DLC filing** — `/privacy` + `/terms` are now live-servable, so the filing prerequisite is met once deployed.
6. **Deliverability** (before real campaigns): SPF/DKIM/DMARC + 2-4 week warmup.

---

## 🧭 Decisions already made (don't re-litigate)

| Decision | Choice | Why |
|----------|--------|-----|
| LinkedIn integration | **Patchright self-hosted** | Lowest ban surface, no per-account SaaS fee. Unipile kept as documented later-swap. |
| Channel scope | **Cold: Email+SMS+LinkedIn; Warm-only: X+WhatsApp** | X cold DMs policy-banned; Meta paused US WhatsApp marketing templates. |
| SMS provider | **Twilio** (already integrated) | Alternatives save ~$18/mo at MVP scale — not worth switching. |
| CRM push | `updateProspectStage`'s `stage_change` is the single authoritative push | ISC-25 invariant. |

---

## ⚠️ Gotchas / environment notes

- **Google OAuth client is "Web application" type** — the loopback URI `http://localhost:8976/oauth2callback` must stay listed under Authorized redirect URIs, and any Gmail account you authorize must be on the consent screen's Test users list (403 `access_denied` otherwise).
- **`.env` values with spaces must be double-quoted** — some local test flows `source .env` in zsh, which breaks on unquoted spaces (dotenv-style parsers don't care; the shell does).
- **Brain schedules first touch for next-day 10:00** — new prospects won't send immediately; for testing, update `bdr_prospects.next_action_at` to the past and re-run a cycle.
- **Pre-commit hook runs `prettier --write` but does NOT re-stage.** Run `npm run format:fix` before committing.
- **Two outbound send entry points** (`processEnrollment`, `dispatchAction`) — both enforce suppression; any new send path must too.
- **Forge (GPT-5.4) unreachable** — codex routes to a tailnet Ollama host and Tailscale is logged out. `tailscale up` to restore.
- **`prospects/` and `store/` are gitignored** runtime state; never commit.

## 🔁 Resume commands

```bash
cd ~/Documents/Coding/BDRclaw
git log --oneline -4          # expect 514cfd6 or later
npm run typecheck             # expect 0 errors
npm test                      # expect 233 passing (pre-merge baseline)
git status                    # expect clean
git branch -a | grep worktree # compliance branch awaiting merge
```

## 📍 Key files

| File | What |
|------|------|
| `ISA.md` | Build system-of-record — ISCs, Changelog, Verification |
| `docs/MVP-PLAN.md` | The full ordered build plan (Phases 0–7) with effort estimates |
| `docs/TWILIO-10DLC-SETUP.md` | SMS registration checklist + pre-written campaign copy |
| `src/agents/loop.ts` | Agentic loop — the live send path (`runTickOnce`) |
| `src/agents/reply-handler.ts` | Inbound classification + STOP pre-gate |
| `src/gmail-auth.ts` / `setup/gmail-auth.ts` | OAuth loopback flow (fixed this session) |
| `src/bdr-db.ts` | `getProspectByContact`, suppression, idempotency |
| `src/agents/loop.e2e.test.ts` | End-to-end test guarding the loop wiring |
