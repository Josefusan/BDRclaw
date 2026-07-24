# BDRclaw — Go-Live Handoff

*Captured 2026-07-24. Read this first when resuming the "make channels live" thread.*

Two audiences: **Part A** = things only Joseph can do (credentials + interactive
auth). **Part B** = things the war room / agents can do now with no human gate.
Everything in Part B was verified against the code in this session — including two
"bugs" from prior notes that turned out to be **false** (see Part B, top).

---

## State (2026-07-24)

| Thing | Status |
|-------|--------|
| Repo | `main` clean, in sync with `origin/main` @ `14781fb`. No secrets tracked (`.env`, `store/`, `prospects/` git-ignored). |
| Railway deploy | Live — hosts dashboard + webhook-driven channels (Gmail/SMS/WhatsApp/Calendly). One `railway login` from redeploys. |
| **LinkedIn** | Code-complete + `LINKEDIN_ENABLED=true`, but **NOT authed** — no `store/linkedin-session.json` yet. This is the only blocker to first live DM. |
| WhatsApp | Code-complete, warm-only. Blocked on Twilio credentials (3 env vars) + public webhook. |
| Twitter | Code-complete, warm/reply-only. Blocked on paid Basic tier ($100/mo) + 4 keys. |

---

## Part A — Only Joseph can do these (human-gated)

Ordered by value ÷ effort. **LinkedIn is the fastest real win — free, ready, highest cold value.**

### 1. LinkedIn go-live (~5 min)
```bash
npm run linkedin-auth          # opens a browser — just log in (2FA fine).
                               # Auto-detects your feed and saves the session.
                               # No terminal interaction; works through the `!` prefix.
```
Then hand me a **1st-degree connection's** profile URL. I run the no-send selector check:
```bash
npm run linkedin-verify -- https://www.linkedin.com/in/<connection>
```
If it passes, we do one **supervised** live DM to a target you name. That's LinkedIn live.

### 2. Load real prospects
```bash
npm run import-csv <file.csv>  # or add them in the dashboard
```

### 3. WhatsApp (when you want it)
Create a Twilio account → set in `.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`WHATSAPP_NUMBER`. Warm-only (message the sandbox first). Inbound needs the app publicly
reachable → use the Railway deploy or a tunnel.

### 4. Twitter (when you want it)
Buy Basic tier ($100/mo) → put the 4 keys in `.env` → `npm run twitter-auth`
(callback-port bug already fixed to `:3456`).

### 5. Railway (optional, unblocks the webhook channels + hosted dashboard)
```bash
railway login                  # then redeploys are available
```

---

## Part B — War room / agents can do these NOW (no human gate)

### First: two prior "P0 bugs" are FALSE — do not chase them
Verified in-code this session (verification doctrine — the point of checking before acting):

- ❌ **"`send_meeting_link` bypasses the daily send cap."** FALSE. It calls
  `channel.sendBDREmail`, which enforces `assertNotSuppressed('email', …)` **and**
  `msgsSentToday >= DAILY_MSG_LIMIT` internally (`src/channels/gmail.ts:136,140`).
- ❌ **"Interested inbound reply is dropped."** FALSE. `routeInboundToReplyHandler`
  (`src/index.ts:601`) routes every real inbound prospect message to `processReply`
  ("Break A fix"), wired at `src/index.ts:652`.

### Verified agent-actionable queue (priority order)

1. **[P2 — verified real] Channel-level compliance parity.**
   `telegram.ts` and `instagram.ts` are the only 2 of 7 channels that do **not** import
   `assertNotSuppressed` from `./compliance.js` (the other 5 —
   gmail/sms/linkedin/twitter/whatsapp — do).
   *Not a live escape*: both send entry points (`processEnrollment` in `loop.ts`,
   `dispatchAction` in `bdr-brain.ts:338`) already guard suppression upstream. This is a
   **defense-in-depth parity gap** — the channel-level backstop is missing.
   **Task:** add `assertNotSuppressed` at the telegram + instagram channel send path, plus a
   regression test, matching the other 5. Owner: Forge / Engineer.

2. **[P2] Ready-to-fire LinkedIn campaign template.**
   Seed a `linkedin_connect → wait → linkedin_dm` sequence (DB/dashboard) so the moment the
   session file exists, there's a live campaign to enroll prospects into. No creds needed.

3. **[P3] Guarded live-send harness.**
   Extend beyond `linkedin-verify` (no-send) to a single-DM path with an explicit `--dry-run`
   flag, for the supervised first send. No creds needed to build.

4. **[Standing] Verification doctrine on every "it works" claim.**
   Assert the post-condition / deployed state, not the push or the toast. This handoff itself
   is the proof: two phantom P0s were caught before they became agent-hours.

---

## Part C — One architecture decision (make it once)

"Fully functional" is inherently **hybrid**:
- **LinkedIn = LOCAL only** — Playwright/Chromium is not in the Railway image → runs on the
  Mac via launchd (`com.bdrclaw.plist`).
- **WhatsApp / SMS / dashboard / Calendly webhook = Railway** — needs the public URL.

Decision: keep hybrid (simplest), or containerize Playwright into the Railway image to run
LinkedIn in the cloud too (more work, one deploy target).

---

## Part D — Next-session resume checklist

```bash
git -C ~/Documents/Coding/BDRclaw status -sb      # expect: ## main...origin/main
ls store/linkedin-session.json                    # present? → LinkedIn is authed
env -u ANTHROPIC_API_KEY npm run dev              # run daemon locally (shell key shadows .env → 401s)
```
Docs entry points: `docs/claude/TECH_STACK.md` → `PARITY_CHECKLIST.md` → `INVESTIGATIONS.md`.
