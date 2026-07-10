# BDRclaw — Session Hand-off

> **Last updated:** 2026-07-10 · **Branch:** `main` · **Head:** `514cfd6`
> Read this first when you come back. It's the "where did I leave off" file.
> Full detail: `ISA.md` (build system-of-record), `docs/MVP-PLAN.md` (the plan), `docs/TWILIO-10DLC-SETUP.md` (SMS paperwork).

---

## TL;DR — where things stand

**BDRclaw sent its first live email today.** Full chain verified end-to-end on real infrastructure: prospect imported via CSV → BDR Brain reviewed the pipeline and queued a `send_email` action → Gmail channel connected via OAuth → sequence step 1 delivered to a real inbox (Gmail messageId `19f4daebfeaba24f`). Claude API key live-verified. Gmail OAuth working (the flow itself needed a fix — see Done).

That send used the sequence **template** path (`composed: false`). The AI-composed + quality-gated path (campaign loop) is the next demo tier.

---

## ✅ Done this session (2026-07-10)

| Item | Detail |
|------|--------|
| Gmail OAuth fixed + shipped | `514cfd6` — Google killed the OOB flow (Jan 2023); replaced with loopback redirect on `localhost:8976` + auto-catch server in the setup CLI |
| Claude API | Key installed in `.env`, live-verified with a real Messages call |
| Gmail account authorized | Sending account 1 authorized; refresh token in `store/gmail-tokens/account-1.json` |
| First live email | Test prospect (Jordan Testwell / Acme Widgets) received sequence step 1; thread tracking active |
| Railway CLI installed | v5.26.0 — `railway login` still pending (interactive) |
| Compliance build (agent branch, **unmerged**) | CAN-SPAM footer + List-Unsubscribe/RFC 8058 headers, `/unsubscribe` endpoint → `bdr_suppression`, Twilio webhook signature validation, `/privacy` + `/terms` pages with 10DLC-required clauses. On local worktree branch `worktree-agent-afa8559908df401d8` — review, merge, test, push |

---

## 🐛 Bugs found by the live test (fixes scoped, not yet written)

1. **`npm run brain` crashes standalone** — the script never calls `initBDRDatabase()` (only `src/index.ts` does). Fix: give the script a proper runner that inits DB (+ loads channels so action handlers register).
2. **Hard Docker dependency kills production** — `ensureContainerSystemRunning()` FATALs when Docker is absent. The Railway container has no Docker daemon, so **the current code cannot boot on Railway** (blocks ISC-38..40). Fix: containerless mode — probe runtime availability, degrade gracefully (agent containers are only needed for conversational group-chat sessions; the BDR loop, webhooks, and reply handler don't use them).
3. **Agents need `ANTHROPIC_API_KEY` in process env** — nothing hydrates `.env` into `process.env` for the `new Anthropic()` call sites; works only if the launcher exports it (launchd plist, Railway env vars, or `set -a; source .env`). Decide: keep as deployment contract (document it) or hydrate at startup.

---

## 👉 Next actions (in priority order)

### Code (next session)
1. **Merge the compliance branch** — review `worktree-agent-afa8559908df401d8`, run full suite, merge to main, push.
2. **Containerless mode** (bug 2) — required before Railway deploy can work at all.
3. **Fix `npm run brain`** (bug 1).
4. **AI-composed campaign demo** — run the campaign loop (`processEnrollment`) so Claude composes a personalized message and the quality gate judges it; this is the real product demo vs. the template send.

### External / operator paperwork (parallel track)
5. **Railway**: `railway login`, then deploy (volume-mount SQLite, env vars, DNS) → kills the `bdrclaw.dev/api/health` 404 → flips ISC-31/32 from DEFERRED-VERIFY once webhooks round-trip.
6. **Twilio 10DLC**: confirm EIN is ≥30 days old (also gates the toll-free bridge since Feb 2026), upgrade to paid account, get legal entity name + mailing address (also needed for the CAN-SPAM footer), and file **only after** the privacy/opt-in pages are live — filing against a bare site risks rejection + clock restart. Treat "campaign denied" as a live branch.
7. **Email deliverability** (before real campaigns): SPF/DKIM/DMARC + domain warmup (2–4 weeks); demo on seeded inboxes until then. Ship List-Unsubscribe/CAN-SPAM (item 1) before any real email campaign activates.

**Honest effort accounting:** ~9–12 engineering days remain for the full MVP (SMS compliance engine, LinkedIn Patchright swap, phases 5–7). "Mostly paperwork" is true only of the email-demo milestone.

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
