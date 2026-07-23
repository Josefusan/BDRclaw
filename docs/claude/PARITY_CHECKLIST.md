# PARITY_CHECKLIST — BDRclaw

> A "surface" is any place an outbound message or a feature must render/behave consistently. When
> you add or change a feature (a new step type, a compliance rule, a stage transition), verify it
> on **every** surface it touches. Paths use `file:line`, grounded against commit `b2cc497` —
> re-verify line anchors after edits.

## The surfaces

Every channel is a class implementing the `Channel` interface (`src/types.ts:82`, method
`sendMessage(jid, text)`). The "entry function" is where a message drops into that surface. The
"action wrapper" is the `registerActionHandler(action_type, …)` that the two send entry points
(`processEnrollment`, `dispatchAction`) look up.

| # | Surface | Transport / tech | Key file | Entry function | Compliance/caps enforced in-surface? |
|---|---------|------------------|----------|----------------|--------------------------------------|
| 1 | **Gmail** | googleapis OAuth | `src/channels/gmail.ts:69` | `sendMessage` (`:126`) → `sendBDREmail` | ✅ suppression + per-account daily cap |
| 2 | **Telegram** | node-telegram-bot-api | `src/channels/telegram.ts:95` | `sendMessage` (`:127`) | ⚠️ **daily cap only — NO suppression/`compliance.ts` backstop** |
| 3 | **SMS** | Twilio | `src/channels/sms.ts:42` | `sendMessage` (`:76`) | ✅ suppression + TCPA 2-touch cap |
| 4 | **Twitter/X** | twitter-api-v2 | `src/channels/twitter.ts:35` | `sendMessage` (`:73`) | ✅ suppression + warm-only |
| 5 | **WhatsApp** | Twilio | `src/channels/whatsapp.ts:42` | `sendMessage` (`:77`) | ✅ suppression + warm-only |
| 6 | **Instagram** | Meta Graph API | `src/channels/instagram.ts:48` | `sendMessage` (`:83`) | ⚠️ **daily cap only — NO suppression/`compliance.ts` backstop** |
| 7 | **LinkedIn** | Playwright automation | `src/channels/linkedin.ts:54` | `sendMessage` (`:131`); `sendConnectionRequest` (`:157`) | ✅ suppression + daily DM/connect caps (persisted) |
| 8 | **Dashboard** | Node http + Alpine/Tailwind/Chart.js | `src/web-ui.ts` + `public/` | activity `GET /api/activity` (`:738`); usage `GET /api/channels/status` (`:744`) | n/a (display of the above) |
| 9 | **CRM sync** | HubSpot/Salesforce/Monday/GHL | `src/crm/registry.ts` | **`pushToCRMs(event)` (`:33`)** via `updateProspectStage` (`src/bdr-db.ts:627`) | n/a (side-effect of DB stage write) |
| 10 | **Reply / inbound** | per-channel `onMessage` | `src/agents/reply-handler.ts` | `processReply` (`:137`); STOP pre-gate (`:152`) | ✅ deterministic opt-out before any AI |

Registry/compliance infra: `src/channels/registry.ts` (`registerChannel:18`, `getChannelFactory:22`), `src/channels/compliance.ts` (`assertNotSuppressed:55`, `assertWarmProspect:76`, `assertSmsTcpaCap:97`; all no-op when `getBdrDb()` is null), barrel `src/channels/index.ts` (imports all 7 to trigger self-registration), `src/channels/linkedin-usage.ts` (persisted LinkedIn counters). The dashboard's channel list const is `CHANNELS` (`web-ui.ts:148`): `email, linkedin, twitter, instagram, telegram, whatsapp, sms`. Authoritative CRM event types: `stage_change | touch_sent | reply_received | meeting_booked | enrolled_in_campaign` (`src/crm/types.ts`).

## Drop Points

The exact seams where a feature commonly gets lost. Check these first when a message "doesn't send" or a rule "doesn't apply everywhere":

1. **Two independent send entry points — a rule added to one is missing from the other.** `processEnrollment` (`src/agents/loop.ts:171`, agentic campaign loop) and `dispatchAction` (`src/bdr-brain.ts:334`, daily brain). Both gate suppression independently (`loop.ts:185`, `bdr-brain.ts:340`). Any new send path or compliance rule must be added to **both**.

2. **Three action-type lists must stay in sync.** (a) the campaign-builder prompt's valid `action_type` set (`src/campaign-builder.ts:89` — 8 types), (b) the `registerActionHandler` calls in the 7 `src/*-bdr-actions.ts` modules, (c) the import list in the composition root `src/bootstrap.ts:35-41`. A missing entry = a step that silently no-ops ("No action handler registered", `loop.ts:295`). (The old `whatsapp_dm`/`instagram_dm` gap is now closed.)

3. **Channel self-registration.** A channel module not imported by the barrel `src/channels/index.ts` never registers → `getChannelFactory` returns undefined → silent no-op. All 7 are currently imported.

4. **`compliance.ts` backstop is missing on Telegram & Instagram.** Only Gmail, SMS, Twitter, WhatsApp, LinkedIn call the shared suppression/warm checks. `src/channels/telegram.ts` and `src/channels/instagram.ts` enforce only an in-memory daily cap; suppression for them relies entirely on the upstream `processEnrollment`/`dispatchAction` gates. (The `instagram-bdr-actions.ts:88` comment overstates enforcement.) **Verify suppression on these two channels via the upstream gate, not the channel.**

5. **`routeInboundToReplyHandler` drops the inline reply (ISC-94).** `src/index.ts:601` calls `processReply` fire-and-forget and discards its return value, so the `interested`-branch calendar-link reply (`reply-handler.ts:216`) never sends from this path — delivery happens later via the brain's `send_meeting_link`.

6. **`send_meeting_link` bypasses the daily send cap (ISC-93).** `src/gmail-bdr-actions.ts:232` neither checks `daily_send_limit` nor calls `incrementAccountSends`, unlike `send_email` (`:95`,`:161`).

7. **Booking = one writer only.** `meeting_booked` is written in exactly one place — the Calendly webhook `src/web-ui.ts:684`. `send_meeting_link` writes only `meeting_link_sent` (`gmail-bdr-actions.ts:286`). Never add a second writer (e.g. via reply classification).

## Merge rule

**No PR merges until every surface the change touches passes its check** — the co-located test is green, and for outbound changes the suppression/compliance assertion is verified on each affected channel (remembering surfaces 2 & 6 gate suppression upstream, not in-channel). See `docs/claude/TESTING_PROTOCOL.md`.
