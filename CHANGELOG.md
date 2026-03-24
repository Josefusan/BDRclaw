# Changelog

All notable changes to BDRclaw will be documented in this file.

## [0.3.0] — Gmail Skill (Phase 3)

- **Gmail OAuth** — multi-account support (up to 3 accounts), offline refresh tokens, auto-rotation (`src/gmail-auth.ts`)
- **GmailChannel** — MIME email builder, reply polling every 5 min, self-registers on startup when `GMAIL_ACCOUNT_*` is set (`src/channels/gmail.ts`)
- **Sequence engine** — loads `groups/main/sequences/*.md` templates, tracks touch count per prospect, `{{firstName}}`/`{{company}}`/`{{senderName}}` variable substitution (`src/gmail-sequences.ts`)
- **BDR brain handlers** — `send_email`, `classify_reply`, `send_meeting_link` registered at startup (`src/gmail-bdr-actions.ts`)
- **Reply classification** — keyword-based classifier (positive / negative / OOO / referral / question / not_now) updates prospect stage automatically
- **Thread tracking** — stores Gmail `threadId` + `messageId` per prospect for proper reply threading
- **OAuth setup CLI** — `npm run gmail-auth` interactive flow (`setup/gmail-auth.ts`)
- **3-step default sequence** — initial outreach → follow-up → breakup (`groups/main/sequences/`)
- **Meeting link sending** — `CALENDLY_URL` injected automatically when prospect stage = `interested`

## [0.2.0] — BDR System (Phase 1 + 2)

- **Type system** — 9 prospect stages, accounts, touches, brain runs, pipeline stats (`src/bdr-types.ts`)
- **BDR database** — SQLite layer for prospects, accounts, touches, brain runs with indexes (`src/bdr-db.ts`)
- **BDR brain** — daily 6am scheduler, hot lead detection (20+ buying signal keywords), multi-touch cadence engine, pluggable action handler registry (`src/bdr-brain.ts`)
- **Web dashboard** — HTTP server on :3000, 7 REST API endpoints, pipeline funnel, hot leads, account status, today's activity, blue/black theme (`src/web-ui.ts`)
- **Setup wizard** — 8-step interactive CLI with ANSI colors, account provisioning, `.env` generation (`setup/wizard.ts`)

## [0.1.0] — Foundation

Initial release. Fork of NanoClaw repurposed for AI sales development.

- BDRclaw branding and README
- Prospect memory model (`prospects/*/CLAUDE.md`)
- BDR brain scaffold (`src/bdr-brain.ts`)
- Basic sequence engine
- Channel skill architecture (self-registration at startup)
- Open core model (MIT base + commercial premium skills)
