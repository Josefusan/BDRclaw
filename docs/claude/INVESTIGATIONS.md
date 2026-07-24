# Investigation Log

Append-only. Never delete old entries. Newest entries at the top.
Format: Date — One-line summary, then details.

The bottom entries are seeded from prior sessions (see `docs/HANDOFF.md` and `ISA.md`) to
establish the format and preserve hard-won lessons. Do not repeat these investigations.

---

## 2026-07-24 — Two claimed "P0" send bugs verified FALSE (do not re-chase)

**Context:** a go-live handoff carried forward two candidate P0 bugs. Both were checked against
source before assigning agent work; both are non-issues.
**Finding 1 — "`send_meeting_link` bypasses the daily send cap":** FALSE. The handler
(`src/gmail-bdr-actions.ts:232`) sends via `channel.sendBDREmail`, which itself enforces
`assertNotSuppressed('email', opts.to)` (`src/channels/gmail.ts:136`) and the daily cap
`msgsSentToday >= DAILY_MSG_LIMIT` (`gmail.ts:140`). No bypass.
**Finding 2 — "interested inbound reply is dropped":** FALSE. `routeInboundToReplyHandler`
(`src/index.ts:601`) routes every real inbound prospect message to `processReply`, wired into the
shared `onMessage` callback at `src/index.ts:652` ("Break A fix").
**Real residue:** the ONLY verified gap nearby is defense-in-depth parity — `telegram.ts` and
`instagram.ts` don't import the `assertNotSuppressed` backstop the other 5 channels do. Not a
live escape (both send entry points guard suppression upstream), so it's P2 hardening, not a bug.
**Lesson:** a claimed bug inherited across a compaction is a hypothesis, not a fact. Grep the
enforcement site before spending agent-hours. Two phantom P0s cost ~5 greps to disprove.

---

## 2026-07-15 — Booking metric counted intentions, not bookings

**Symptom:** `meeting_booked` (the flagship funnel metric) incremented the moment a calendar link
was *sent*, so the dashboard reported "meetings booked" for prospects who never booked.
**Root cause:** the stage was written at link-send time; there was no signal distinguishing "link
sent" from "invitee actually scheduled."
**Fix:** introduced a distinct `meeting_link_sent` stage; made `POST /api/webhooks/calendly`
(invitee.created, HMAC-verified when `CALENDLY_WEBHOOK_SIGNING_KEY` is set, idempotent on invitee
URI) the ONLY automated writer of `meeting_booked`, guarded by an executable source-walking test.
See `src/calendly-webhook.test.ts`, `src/booking-flow.e2e.test.ts`.
**Lesson:** do NOT infer bookings from reply-text classification (advisor-refuted: text intent ≠
booking). A flagship metric needs a single authoritative writer tied to a real external event.

---

## 2026-07-16 — Campaign updates silently wiped all steps (false-green trap)

**Symptom:** activating/pausing/renaming a campaign from the dashboard enrolled prospects but the
loop then sent nothing — the campaign had zero steps.
**Root cause:** `upsertCampaign` used `INSERT OR REPLACE`, which cascade-deleted all child
campaign steps on any parent-row update.
**Fix:** changed to `ON CONFLICT DO UPDATE`; reproduced and added a regression test (ISC-24).
Commit `9290a94`.
**Lesson:** verify the *post-condition* (campaign still has its steps), not the visible *signal*
(the "enrolled" toast). A browser check that only saw the toast was a false green. This lesson is
also recorded in the PAI memory system.
