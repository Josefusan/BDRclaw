# Railway Deploy Runbook

> Everything below is staged and verified. The ONLY human-gated step is `railway login`
> (interactive browser auth). Once logged in, this is a mechanical checklist.

## 0. Prerequisites (done)

- Dockerfile: tzdata installed, devDeps→build→prune, Chromium removed, `PORT` honored.
- `railway.json`: DOCKERFILE builder, `healthcheckPath: /api/health`, ON_FAILURE restart.
- `.dockerignore`: excludes `.env`, `store/`, `.git`, `*.log`.
- Auth: `BDR_DASHBOARD_PASSWORD` gates the dashboard; session secret auto-persists to `store/session-secret`.
- Gmail tokens seed from `GMAIL_TOKEN_<N>_B64` env on first boot (fresh volume has none).

## 1. Generate secrets FIRST (put them in a password manager)

```bash
openssl rand -base64 32   # → BDR_DASHBOARD_PASSWORD   (you'll type this to log in)
openssl rand -hex 32      # → BDR_SESSION_SECRET
openssl rand -hex 32      # → BDR_UNSUBSCRIBE_SECRET
# Base64 the local Gmail token(s) for env seeding:
base64 -i store/gmail-tokens/account-1.json   # → GMAIL_TOKEN_1_B64
```

## 2. Login + init (the gated step)

```bash
railway login          # ← opens browser; only you can do this
cd ~/Documents/Coding/BDRclaw
railway init            # create/select the "bdrclaw" project + service
```

## 3. Volume (data survives redeploys — ISC-91)

Add a volume mounted at `/app/store` (Railway dashboard → service → Settings → Volumes,
or `railway volume add`). SQLite DB, session secret, and OAuth tokens live here.

## 4. Env vars (batch-set all at once)

Core: `ANTHROPIC_API_KEY`, `BDR_COMPANY_NAME`, `BDR_CLOSER_EMAIL`, `BDR_BRAIN_HOUR`, `TZ`,
`BDR_WEB_HOST=0.0.0.0`, `BDR_PUBLIC_URL=https://bdrclaw.dev`.
Auth: `BDR_DASHBOARD_PASSWORD`, `BDR_SESSION_SECRET` (from step 1).
Gmail: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_ACCOUNT_1`, `GMAIL_SENDER_NAME`,
`GMAIL_TOKEN_1_B64` (from step 1).
Booking: `CALENDLY_URL`, and `CALENDLY_WEBHOOK_SIGNING_KEY` (from step 6 — the webhook fails
CLOSED without it once auth is on, so it can be added after first deploy).
Compliance: `BDR_LEGAL_NAME`, `BDR_MAILING_ADDRESS`, `BDR_UNSUBSCRIBE_SECRET`.
Do NOT set `PORT` (Railway injects it). Do NOT push LinkedIn/Twitter creds (no server session).

## 5. Deploy + domain

```bash
railway up              # Docker build ~5-10 min first time
railway domain          # generates the public URL (or attach bdrclaw.dev)
```

## 6. Post-deploy verification (flips ISC-90)

```bash
HOST=<railway-url>
curl -s $HOST/api/health                       # → {"status":"ok"}   (bare, auth on)
curl -s -o /dev/null -w "%{http_code}\n" $HOST/ # → 302 (redirects to /login)
curl -s $HOST/login | grep "Sign in"           # → login page served
```
Then in a browser: log in with `BDR_DASHBOARD_PASSWORD`, confirm the dashboard loads and
Channels shows Email Verified (proves the seeded Gmail token works).

## 7. Calendly webhook (flips ISC-82 live)

Calendly → Integrations → Webhooks → subscribe `invitee.created` to
`https://<host>/api/webhooks/calendly`. Copy the signing key into
`CALENDLY_WEBHOOK_SIGNING_KEY` and redeploy. Test with a real booking → prospect flips to
`meeting_booked`.

## Gotchas
- Fresh volume + no `GMAIL_TOKEN_*_B64` = email disabled (warns, doesn't crash).
- The brain schedules first touch for next-day 10:00 — nothing sends the instant you deploy.
- Health check timeout is 120s; the first Docker build is slow but the running app answers fast.
