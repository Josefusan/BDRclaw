# BDRclaw — Session Hand-off

> **Last updated:** 2026-07-09 · **Branch:** `main` · **Head:** `d870ae2`
> Read this first when you come back. It's the "where did I leave off" file.
> Full detail: `ISA.md` (build system-of-record), `docs/MVP-PLAN.md` (the plan), `docs/TWILIO-10DLC-SETUP.md` (SMS paperwork).

---

## TL;DR — where things stand

**The MVP's core loop is now alive and tested.** BDRclaw compiled cleanly before, but the agentic loop was dead at both ends: inbound replies never reached the reply handler, and the AI-composed/quality-gated message was thrown away before sending. **Both are now fixed, tested (233/233), committed, and pushed.**

What's left to make it a *demoable* MVP is mostly **deployment + external paperwork**, not code:
1. Deploy to Railway (kills the `bdrclaw.dev/api/health` 404).
2. Twilio 10DLC registration (1–4 week lead time — start ASAP).
3. Then channel-specific build-out (LinkedIn Patchright, SMS compliance engine).

---

## ✅ Done (committed + pushed to GitHub)

| Commit | What |
|--------|------|
| `68e64df` | Agent-swarm layer (bdr-manager, cold-outreach, crm-agent, meeting-intelligence, oration, second-brain) + deals-db + integrations + `MVP-PLAN.md` |
| `7d184bc` | Decision lock (LinkedIn=Patchright, channel scope) + `TWILIO-10DLC-SETUP.md` |
| `d870ae2` | **Phase 1 — closed both wiring breaks** (the real MVP fix) |

**Phase 1 in detail (commit `d870ae2`):**
- **Break B fixed** — composed + quality-gated message now reaches the channel handler as a typed `ComposedOutbound` arg via `resolveOutboundBody()`. The old `enrichment.__campaign_message` smuggling is gone.
- **Break A fixed** — inbound routes `src/index.ts` onMessage → `getProspectByContact()` → `processReply()`, with exactly-once idempotency (`bdr_processed_inbound` table).
- **Compliance** — deterministic STOP/UNSUBSCRIBE pre-gate (before any Claude call) + global `bdr_suppression` list enforced at both outbound entry points.
- **Cleanup** — blocked-touch status `'bounced'`→`'blocked'` (ISC-13); CRM double-push deduped; orphaned `campaign-runner.ts` deleted.
- **Test** — `src/agents/loop.e2e.test.ts` guards both breaks. Full suite **233/233 pass**, typecheck 0 errors, lint clean on touched files.

---

## 👉 Next actions (in priority order)

### 1. Twilio 10DLC registration — DO THIS FIRST (longest lead time: 1–4 weeks)
External paperwork, not code. Follow `docs/TWILIO-10DLC-SETUP.md` step by step.
- **Blocker to confirm:** which entity's EIN to use — it must be **≥30 days old**, and you need a **paid** Twilio account (trial can't register).
- Submit brand + campaign registration (campaign copy is pre-written in the guide).
- Optionally submit toll-free verification in parallel (free, ~3–5 days) as a pilot bridge.

### 2. Phase 2 — Deploy to Railway (~0.5 day, unblocks webhooks)
- `Dockerfile` + `railway.json` already exist. Deploy, set env vars, volume-mount the SQLite DB.
- Point `bdrclaw.dev` DNS at the service (landing page moves to `/` or a subdomain).
- Add Twilio webhook signature validation (`twilio.validateRequest`) on `/webhooks/sms` + `/webhooks/whatsapp`.
- **Verify:** `curl https://bdrclaw.dev/api/health` → `{"status":"ok"}` (currently 404).
- This also flips the two `[DEFERRED-VERIFY]` ISCs (ISC-31/32) to live-verified once a real SMS/Telegram round-trip works.

### 3. Phase 3 — SMS compliance engine (before any SMS campaign goes active)
Consent fields + attestation at import, quiet-hours engine (wire the existing `src/timezone.ts`), TCPA 2-touch cap counted from `bdr_touches` (not regex over memory), consent/opt-out event log. Details in `MVP-PLAN.md` §Phase 3.

### 4. Phase 4 — LinkedIn via Patchright (DECIDED: self-hosted)
Swap `playwright` → `patchright` (drop-in fork), add human-pacing engine, keep 20 conn/50 DM daily caps, wire LinkedIn inbound poll → `processReply`. `MVP-PLAN.md` §Phase 4.

### 5. Phases 5–7
X→OAuth2 PKCE + DM-on-reply only; WhatsApp `whatsapp_dm` handler (international + inbound only); Instagram warm-only enforcement; landing-page copy honesty pass. Plus BDR-layer test coverage.

**Estimate:** ~9–12 engineering days total; **~3–4 days to a demoable MVP on email alone** while Twilio registration clears in the background.

---

## 🧭 Decisions already made (don't re-litigate)

| Decision | Choice | Why |
|----------|--------|-----|
| LinkedIn integration | **Patchright self-hosted** | Lowest ban surface (user's own browser/IP), no per-account SaaS fee, evolves existing Playwright code. Unipile kept as documented later-swap. |
| Channel scope | **Cold: Email+SMS+LinkedIn; Warm-only: X+WhatsApp** | X cold DMs are policy-banned + mostly undeliverable; Meta paused US WhatsApp marketing templates (Apr 2025, still active). |
| SMS provider | **Twilio** (already integrated) | Alternatives save ~$18/mo at MVP scale — not worth switching. |
| CRM double-push | Keep `updateProspectStage`'s `stage_change` as the single authoritative push | It's the ISC-25 invariant firing in every path. |

---

## ⚠️ Gotchas / environment notes

- **Forge (GPT-5.4) is currently unreachable.** codex routes to a self-hosted Ollama on your tailnet (`100.119.10.74:11434`) and **Tailscale is logged out**. To restore Forge: `tailscale up` (re-auth), confirm with `nc -z 100.119.10.74 11434`. Phase 1 was implemented directly (Claude) from Forge's saved spec at `<scratchpad>/forge-prompt.md`.
- **Pre-commit hook runs `prettier --write`** (`.husky/pre-commit` → `npm run format:fix`) but does NOT re-stage. Run `npm run format:fix` yourself before committing so the committed version is already formatted, or you'll see formatting-only diffs reappear.
- **`prospects/` is now gitignored** — it holds runtime per-prospect memory; the e2e test writes there.
- **Two outbound send entry points** exist (agentic loop `processEnrollment`, brain `dispatchAction`) — both now enforce suppression. If you add a third, guard it too.

---

## 🔁 Resume commands

```bash
cd ~/Documents/Coding/BDRclaw
git log --oneline -4          # confirm you're at d870ae2 or later
npm run typecheck             # expect 0 errors
npm test                      # expect 233 passing
git status                    # expect clean

# When ready to restore Forge for AI-assisted coding:
tailscale up && nc -z 100.119.10.74 11434
```

## 📍 Key files

| File | What |
|------|------|
| `ISA.md` | Build system-of-record — 41 ISCs, which pass, Changelog, Verification |
| `docs/MVP-PLAN.md` | The full ordered build plan (Phases 0–7) with effort estimates |
| `docs/TWILIO-10DLC-SETUP.md` | SMS registration checklist + pre-written campaign copy |
| `src/agents/loop.ts` | Agentic loop — the live send path (`runTickOnce`) |
| `src/agents/reply-handler.ts` | Inbound classification + STOP pre-gate |
| `src/index.ts` | `parseProspectJid` + onMessage→processReply routing |
| `src/bdr-db.ts` | `getProspectByContact`, suppression, idempotency |
| `src/agents/loop.e2e.test.ts` | End-to-end test guarding both wiring breaks |
