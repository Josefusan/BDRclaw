# BDRclaw — Deployment Status

> **Status: LIVE in production** · Deployed 2026-07-16 · Suite 366/366, typecheck 0

## Live URL

**https://bdrclaw-production.up.railway.app**

Railway project `bdrclaw` (`c88ab3c8-80c5-4dd0-a827-62795e3d2230`), production environment,
service `bdrclaw`, volume `bdrclaw-volume` mounted at `/app/store`.

Dashboard login is required — the password is in the operator's password manager
(`BDR_DASHBOARD_PASSWORD`). Sign in at the URL above.

## Verified live (post-conditions, not just "it responded")

| Check | Result |
|-------|--------|
| `GET /api/health` | `200 {"status":"ok"}` (bare body — auth on, no detail leaked) |
| `GET /` unauthenticated | `302 → /login` |
| `GET /api/stats` unauthenticated | `401` |
| `POST /api/login` with password | `200` + HttpOnly session cookie → authed API returns `200` |
| Seeded Gmail on fresh volume | email `configured + verified` (token from `GMAIL_TOKEN_1_B64` written to and read from the persistent volume) |
| Login page in real browser | renders cleanly, zero console errors |

## How it's deployed

- **Builder:** Dockerfile (Node 22 slim + tzdata; devDeps installed for `tsc`, pruned after build; Playwright Chromium deliberately omitted — LinkedIn's authenticated session only exists on the operator's machine).
- **Config:** `railway.json` — `healthcheckPath: /api/health`, `ON_FAILURE` restart. `PORT` is honored (Railway-injected).
- **Persistence:** Railway Volume at `/app/store` holds SQLite, the auto-generated session secret, and Gmail OAuth tokens — survives redeploys.
- **First-boot token seeding:** `GMAIL_TOKEN_<N>_B64` env vars hydrate the volume so email works on a fresh deploy.

Full step-by-step: [`DEPLOY-RAILWAY.md`](./DEPLOY-RAILWAY.md).

## Deploy gotcha (learned the hard way)

The Dockerfile must **not** contain a `VOLUME` instruction — Railway's Metal builder rejects
it (`dockerfile invalid: docker VOLUME ... is not supported, use Railway Volumes`). Persistence
is configured on the service, not baked into the image.

## Before running real campaigns (config, not code)

1. **Calendly webhook** — subscribe `invitee.created` to
   `https://bdrclaw-production.up.railway.app/api/webhooks/calendly`, then set
   `CALENDLY_WEBHOOK_SIGNING_KEY` in Railway. The booking webhook fails **closed** until the
   key is set (a deployed instance refuses unsigned bookings by design). Also set `CALENDLY_URL`
   so meeting links inject.
2. **CAN-SPAM** — set `BDR_LEGAL_NAME` and `BDR_MAILING_ADDRESS` (empty today); required on
   commercial email before sending.
3. **Custom domain** (optional) — `bdrclaw.dev` currently serves the static landing page; point
   it at the Railway service to host the app there.
4. **Deliverability** (before volume sending) — SPF/DKIM/DMARC + a 2-4 week warmup.

## Known follow-ups (tracked in `ISA.md`)

- **ISC-93** — `send_meeting_link` bypasses the daily send-limit accounting.
- **ISC-94** — the interested-branch inline reply is dead at the `routeInboundToReplyHandler`
  seam; the calendar link only goes out on the next daily brain cycle (up-to-24h stall on the
  hottest lead).
- **ISC-95** — HubSpot `mapStage()` is dead code (no deal-pipeline stage written).
- **ISC-74** — perpetual war-room loop is unbuilt (decide if still wanted).
- **Cato cross-vendor audit** — still unrun (Tailscale logged out); an adversarial Fable audit
  stood in and its findings were fixed.
