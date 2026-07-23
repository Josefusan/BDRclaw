# TECH_STACK — BDRclaw architecture reference

> Reference map (not a code dump). Every path is verified against the tree. BDRclaw is a fork of
> **NanoClaw** — some inherited files/labels still say "NanoClaw" (see **Reality Notes** at the
> bottom). Node/TypeScript, ESM (`"type": "module"`), single process.
>
> _Grounded against commit `b2cc497`. `file:line` anchors are valid as of that commit — re-verify after edits (line numbers rot fastest)._

## 1. Frontend

Two separate front-ends live in this repo:

- **The app dashboard — `public/index.html` (+ `public/app.js`, `public/styles.css`, `public/favicon.svg`).** A single-page app with **no build step**: Tailwind, Alpine.js 3, and Chart.js all load from CDN; Alpine `x-data` bindings drive the UI and `fetch()` hits the `/api/*` backend. Served by a raw Node `http` server in `src/web-ui.ts` (`PUBLIC_DIR` = `../public`, SPA fallback to `index.html` for unmatched non-API GETs). Port = `process.env.PORT ?? BDR_WEB_PORT ?? 3000`. Client-side "pages": overview/stats, prospects, hot leads, campaigns, imports, brain runs, suppression, settings.
- **The marketing site — root `index.html`, `privacy.html`, `terms.html`.** Tailwind CDN, no Alpine; served via GitHub Pages (`CNAME`, `.nojekyll`). The *deployed app* renders its own `/privacy` and `/terms` dynamically from `src/legal-pages.ts` (env-templated for CAN-SPAM / Twilio 10DLC), so legal content exists twice — static (marketing) and dynamic (app).

## 2. Backend

**Two SQLite databases (better-sqlite3) — a key fact:**

| DB file | Owner | Domain |
|---------|-------|--------|
| `store/bdr.db` | `src/bdr-db.ts` (1253 lines, 15 tables) | The BDR domain: `bdr_prospects`, `bdr_touches`, `bdr_campaigns`, `bdr_campaign_steps`, `bdr_campaign_enrollments`, `bdr_brain_runs`, `bdr_import_jobs`, `bdr_builder_sessions`, `bdr_closed_deals`, `bdr_documents`, `bdr_suppression`, `bdr_processed_inbound`, `bdr_accounts`, `bdr_second_brain`, `bdr_agent_runs` |
| `store/messages.db` | `src/db.ts` (697 lines) | Inherited NanoClaw core: `chats`, `messages`, `scheduled_tasks`, `task_run_logs`, `router_state`, `sessions`, `registered_groups` |

`src/deals-db.ts` owns no tables — it's a helper layer over `bdr_closed_deals` / `bdr_documents` (revenue rollups, base64 document storage).

- **Migrations:** two mechanisms. (1) Inline idempotent DDL in `db.ts` `createSchema()` — `CREATE TABLE IF NOT EXISTS` + try/catch `ALTER TABLE ADD COLUMN`, plus one-time JSON→SQLite import in `migrateJsonState()`. `bdr-db.ts` uses `CREATE TABLE IF NOT EXISTS` only. (2) A cross-version upgrade runner `scripts/run-migrations.ts` that executes `migrations/<semver>/index.ts` in order (the `migrations/` dir does not exist yet — tooling for upgrading the forked core).
- **Auth (`src/dashboard-auth.ts`):** stateless HMAC-SHA256 cookie (`bdr_session`, HttpOnly, 7-day TTL), enabled only when `BDR_DASHBOARD_PASSWORD` is set. Signing key = `BDR_SESSION_SECRET` or a random secret persisted to `store/session-secret` (0600, **not** password-derived). Login rate-limited 5 / 15 min per IP. `isAuthExempt()` whitelists `/login`, `/api/login`, `/api/health`, `/unsubscribe`, `/privacy`, `/terms`, `/favicon.svg`, `/api/zoom/webhook`, `/api/webhooks/*`.
- **HTTP API surface (all in `src/web-ui.ts`, raw Node http):** reads `GET /api/{stats,accounts,prospects,prospects/hot,prospects/:id,brain/runs,imports,activity,channels/status,settings/env,suppression,campaigns,crm/adapters,otter/transcripts}`; writes `POST /api/{prospects,prospects/import,suppression,loop/start,loop/stop,crm/pull,meetings/analyze,oration}`; campaign builder `POST /api/campaigns/builder/{start,chat}`; integrations `POST /api/integrations/{instantly,salesforge}/sync`; webhooks `POST /api/webhooks/calendly`, `POST /api/zoom/webhook`; session `POST /api/{login,logout}`.
- **Process model — single Node process** (`node dist/index.js`). `main()` in `src/index.ts` boots in order: `initDatabase()` (messages.db) → `initCore()` (`src/bootstrap.ts`: bdr.db + registers all channel handlers + CRM adapters) → container-runtime probe (degrades to "containerless mode") → `loadState()` → `startWebUI()` → `startBDRBrain()` (daily timer) → `startAgenticLoop()` (2 s poll) → `startCredentialProxy()` (port 3001). `src/task-scheduler.ts` polls `scheduled_tasks` every 60 s. `npm run web` / `npm run brain` boot standalone through the same `initCore()` composition root.

## 3. External Services

| Service | File(s) | Purpose |
|---------|---------|---------|
| Gmail | `src/channels/gmail.ts`, `src/gmail-auth.ts`, `setup/gmail-auth.ts` | Cold email send + reply polling (googleapis OAuth) |
| Telegram | `src/channels/telegram.ts` | Long-polling bot (node-telegram-bot-api) |
| SMS (Twilio) | `src/channels/sms.ts`, `src/twilio-signature.ts` | Programmable Messaging, TCPA caps + inbound signature validation |
| WhatsApp (Twilio) | `src/channels/whatsapp.ts` | Twilio WhatsApp API (shares Twilio creds with SMS), warm-only |
| Twitter/X | `src/channels/twitter.ts` | DM send+poll (twitter-api-v2), warm-reply-only |
| Instagram | `src/channels/instagram.ts` | Graph API DM, warm follow-up only |
| LinkedIn | `src/channels/linkedin.ts`, `setup/linkedin-auth.ts`, `src/channels/linkedin-usage.ts` | DM via Playwright browser automation + persisted daily caps |
| HubSpot | `src/crm/hubspot.ts` | CRM adapter |
| GoHighLevel | `src/crm/gohighlevel.ts` | CRM adapter (LeadConnector) |
| Monday.com | `src/crm/monday.ts` | CRM adapter |
| Salesforce | `src/crm/salesforce.ts` | CRM adapter |
| Instantly.ai | `src/integrations/instantly.ts` | Lead push / campaign sync |
| Otter.ai | `src/integrations/otter.ts` | Transcript fetch |
| Salesforge | `src/integrations/salesforge.ts` | Contact / sequence push |
| Zoom | `src/integrations/zoom.ts` | Webhook receive + signature verify |
| Calendly | inline in `src/web-ui.ts` (`POST /api/webhooks/calendly`); `src/calendly-webhook.test.ts` | Booking detection (HMAC, idempotent on invitee URI) |
| Anthropic | `@anthropic-ai/sdk`, used in `src/agents/*.ts` + `src/campaign-builder.ts` | Direct Messages API, model `claude-sonnet-4-6` |

Registration is presence-keyed: each channel/CRM adapter self-disables (returns null) when its credentials are absent.

## 4. Component Map

| Directory | `*.ts` files | What lives here |
|-----------|-------------|-----------------|
| `src/` (root) | 65 (~28 tests) | Composition root + cross-cutting services: entry (`index.ts`), boot (`bootstrap.ts`, `load-env.ts`), config (`config.ts`, `env.ts`), DBs (`db.ts`, `bdr-db.ts`, `deals-db.ts`), orchestration (`ipc.ts`, `router.ts`, `task-scheduler.ts`, `bdr-brain.ts`, `group-queue.ts`, `group-folder.ts`), web (`web-ui.ts`, `dashboard-auth.ts`, `legal-pages.ts`), per-channel action handlers (`*-bdr-actions.ts`), compliance (`email-compliance.ts`, `twilio-signature.ts`, `sender-allowlist.ts`), container infra (`container-runner.ts`, `container-runtime.ts`, `credential-proxy.ts`, `mount-security.ts`), plus campaign/webhook/remote-control glue |
| `src/agents/` | 13 (10 impl + 3 test) | Anthropic-API "brains": `loop.ts`, `bdr-agent.ts`, `bdr-manager.ts`, `cold-outreach-agent.ts`, `crm-agent.ts`, `reply-handler.ts`, `quality-gate.ts`, `meeting-intelligence.ts`, `second-brain.ts`, `oration.ts` |
| `src/channels/` | 16 (12 impl + 4 test) | Channel adapters + `registry.ts` (self-registration) + `compliance.ts` + `linkedin-usage.ts` |
| `src/crm/` | 8 (6 impl + 2 test) | CRM adapters + `registry.ts` + `types.ts` |
| `src/integrations/` | 4 (0 test) | Instantly, Otter, Salesforge, Zoom |

Support trees: `setup/` (19 — wizard + auth + service install), `container/` (per-agent sandbox image + skills), `scripts/`, `groups/`, `prospects/`, `public/`, `launchd/`, `store/` (runtime, gitignored).

## 5. State Management

- **SQLite = source of truth:** `store/bdr.db` (all BDR domain) + `store/messages.db` (chats/tasks/sessions). `:memory:` under test.
- **JSON stores under `store/`:** `gmail-threads.json` (thread tracking), `gmail-tokens/account-<N>.json` (per-account OAuth, seeded on boot from `GMAIL_TOKEN_<N>_B64`), `session-secret` (HMAC key). LinkedIn daily counters persist as JSON in `STORE_DIR` via `src/channels/linkedin-usage.ts`. Legacy `router_state.json`/`sessions.json`/`registered_groups.json` migrate into `messages.db` on first boot, then renamed `.migrated`.
- **Env hydration:** `src/load-env.ts` (side-effect, must be the **first import** of every entry point) parses `.env` into `process.env` with **existing env always winning** (deploy vars authoritative). `src/env.ts` `readEnvFile(keys)` reads specific keys *without* mutating `process.env`. `src/config.ts` derives typed constants from both.
- **Per-entity Markdown memory (isolated):** `prospects/*/CLAUDE.md` (per-prospect context; only `prospects/sarah-acme-test/` present as fixture) and `groups/*/CLAUDE.md` (`groups/main/`, `groups/global/`). Sequences: `groups/main/sequences/{01-initial-outreach,02-follow-up,03-breakup}.md`.

## 6. Config Constants

- **`src/config.ts` — the central tunables module:** `ASSISTANT_NAME` (default `Andy`), `POLL_INTERVAL=2000`, `SCHEDULER_POLL_INTERVAL=60000`, `IPC_POLL_INTERVAL=1000`, `IDLE_TIMEOUT=1800000`, `CONTAINER_TIMEOUT=1800000`, `CONTAINER_MAX_OUTPUT_SIZE=10485760`, `CREDENTIAL_PROXY_PORT=3001`, `MAX_CONCURRENT_CONTAINERS=5`, `CONTAINER_IMAGE`, `TRIGGER_PATTERN`, `TIMEZONE`, and path constants (`STORE_DIR`, `GROUPS_DIR`, `DATA_DIR`, allowlist paths under `~/.config/nanoclaw/`).
- **`src/env.ts`** holds no constants — it is only the `readEnvFile()` parser.
- **Daily caps live per-domain, not centrally:** SMS `SMS_DAILY_MSG_LIMIT` (read in `src/channels/sms.ts`), LinkedIn caps in `src/channels/linkedin-usage.ts`, follow-up cadence `FOLLOW_UP_DAYS` in `src/bdr-brain.ts`, auth limits in `src/dashboard-auth.ts`.
- **`.env.example` (7.4 KB) = single source of env truth** (`.env` mirrors it; `npm run wizard` writes it). Categories: Core, Legal/CAN-SPAM compliance, Channels (Gmail/LinkedIn/Twitter/Instagram/Telegram/WhatsApp/SMS), CRM (HubSpot/Salesforce/Monday/GoHighLevel), Container/deploy.

## 7. Build & Deploy

- **Build:** `npm run build` = `tsc` (ES2022, NodeNext, `src → dist`, strict). `npm run typecheck` = `tsc --noEmit`.
- **Run:** prod `npm start` = `node dist/index.js`; dev `npm run dev` = `tsx src/index.ts`. Aux entry points via `tsx`: `web`, `brain`, `wizard`, `gmail-auth`, `linkedin-auth`, `twitter-auth`, `import-csv`, `setup`.
- **Containerize:** root `Dockerfile` (`node:22-slim` + tzdata, `npm ci` → `npm run build` → `npm prune --omit=dev`, EXPOSE 3000, Chromium omitted). A second image (`container/Dockerfile` + `container/build.sh` + `container/agent-runner/` + `container/skills/*`) builds the per-agent sandbox.
- **Deploy:** `railway.json` — Dockerfile builder, `startCommand node dist/index.js`, `healthcheckPath /api/health`, `restartPolicyType ON_FAILURE`. SQLite/tokens/session persist via a Railway Volume at `/app/store`. Runbooks: `docs/DEPLOY-RAILWAY.md`, `docs/DEPLOYMENT.md`.
- **Self-host service:** macOS launchd (`launchd/com.nanoclaw.plist`) / Linux systemd (generated by `setup/service.ts`, platform detect in `setup/platform.ts`). Cross-version upgrades: `scripts/run-migrations.ts`.

## 8. Key Files

| # | File | Why it matters |
|---|------|----------------|
| 1 | `src/index.ts` | Daemon entry / orchestrator — `main()` wires everything |
| 2 | `src/bootstrap.ts` | Composition root `initCore()` — the single boot contract |
| 3 | `src/bdr-db.ts` | BDR domain DB (15 tables) — the schema everything reads/writes |
| 4 | `src/db.ts` | Inherited core DB (`messages.db`) + JSON→SQLite migrations |
| 5 | `src/bdr-brain.ts` | Daily pipeline review — stage advance, signal detect, follow-up cadence |
| 6 | `src/agents/loop.ts` | Agentic loop — the live send path (`runTickOnce`) |
| 7 | `src/web-ui.ts` | HTTP server — dashboard + entire `/api/*` surface + webhooks |
| 8 | `src/dashboard-auth.ts` | Stateless HMAC-cookie auth gate |
| 9 | `src/task-scheduler.ts` | Cron/interval scheduler over `scheduled_tasks` |
| 10 | `src/config.ts` | Central tunables (ports, timeouts, concurrency, paths) |
| 11 | `src/load-env.ts` | Mandatory first-import env hydration |
| 12 | `src/channels/registry.ts` | Channel self-registration mechanism |
| 13 | `Dockerfile` + `railway.json` | Production build + deploy contract |
| 14 | `public/index.html` + `public/app.js` | Alpine/Tailwind/Chart.js dashboard |
| 15 | `.env.example` | Single source of env truth |

## Reality Notes (drift to be aware of)

These are real mismatches between docs and code — trust the code:

- **`src/prospect-queue.ts` does not exist** (root CLAUDE.md lists it). The real queue is `src/group-queue.ts` (+ `src/group-folder.ts`).
- **`src/whatsapp-auth.ts` does not exist**, yet `package.json`'s `"auth"` script points at it (broken script; WhatsApp uses Twilio, needs no auth flow).
- **No `src/channels/slack.ts` / `discord.ts`** — CLAUDE.md's Quick Context lists Slack/Discord as channels; they aren't implemented (Slack exists only as `container/skills/slack-formatting/` + a planned `/add-slack-outreach`).
- **No `src/calendly-webhook.ts`** — Calendly is handled inline in `web-ui.ts`.
- **"Claude Agent SDK in containers"** (CLAUDE.md Quick Context) overstates the BDR path: BDR agents call the Anthropic Messages API directly (`claude-sonnet-4-6`). The container/agent-SDK path is inherited NanoClaw infra and degrades to containerless mode without Docker.
- **NanoClaw→BDRclaw naming drift:** launchd artifact is `com.nanoclaw.plist` (CLAUDE.md commands say `com.bdrclaw.plist`); `config.ts` default image `nanoclaw-agent:latest` vs `.env.example` `bdrclaw-agent:latest`; several file headers and all `assets/` still say NanoClaw.
