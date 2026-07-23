# DOWNLOAD_FLOWS — BDRclaw data & processing pipelines

> BDRclaw has no literal "downloads" — its pipelines are the distinct data/processing flows that
> move a prospect from identified → outreach → reply → booking → CRM. Each is documented with its
> trigger, ordered steps (with `file:line`), external services, what makes it fundamentally
> different, and where it must stay in sync with the others.
>
> _Grounded against commit `b2cc497` — re-verify `file:line` anchors after edits._

**Startup wiring** (`src/index.ts:515 main()`): `initDatabase()` → `initCore()` (`bootstrap.ts` — inits BDR DB + imports all 7 `*-bdr-actions` handlers) → `loadState()` → `startWebUI()` (`:533`) → `startBDRBrain()` (`:534`, pipeline 4) → `startAgenticLoop()` (`:535`, pipeline 3) → CRM adapter imports (`:74`) → `startSchedulerLoop()` (`:693`, NanoClaw container tasks — distinct from the BDR brain). Channels get a shared `onMessage` = storeMessage + `routeInboundToReplyHandler` (pipeline 5).

---

## 1. Prospect import / ingestion

**Trigger:** CLI `npm run import-csv [--dry-run] <file>` (`setup/import-csv.ts`) · dashboard `POST /api/prospects/import` (`web-ui.ts:859`) or `POST /api/prospects` (`:824`) · or CRM pull (pipeline 7).

```
CSV file / form ─► parse (csv-parse/sync) ─► normalize() import-csv.ts:42
                                              │  (tolerant column aliases)
                                              ▼
                            require name/company/title
                                              ▼
                    addProspect() bdr-db.ts:348 ─► upsertProspect() :317 (INSERT OR REPLACE)
                                              ▼
                              stage = 'identified'  (bdr-db.ts:372)
```

- **External services:** none (local SQLite only).
- **Fundamentally different:** the only pipeline that *creates* prospect rows from an external file/human — batch, synchronous, no AI, no network.
- **Sync points:** initial `stage='identified'` must match the brain's `determineNextAction` (`identified → send_email`, `bdr-brain.ts:252`). The id/slug + email/phone/JID keys must be resolvable later by `getProspectByContact` (`bdr-db.ts:400`) used by inbound (5) and Calendly (6).

## 2. Campaign building

**Trigger:** dashboard `POST /api/campaigns/builder/start` (`web-ui.ts:1072`) then `POST /api/campaigns/builder/chat` (`:1082`).

```
user chat ─► builderChat() campaign-builder.ts:119 ─► Claude (claude-sonnet-4-6, SYSTEM_PROMPT :42)
                                              │
                       detect ```campaign``` JSON fence :148 ─► parseCampaignJson :203
                                              ▼
                 saveCampaign :212 ─► upsertCampaign + upsertCampaignStep  (status: draft)
```

- **External services:** Anthropic API.
- **Fundamentally different:** conversational/stateful (session history persisted in SQLite between stateless Claude calls); it produces campaign + step *definitions* and sends nothing.
- **Sync points:** step `action_type` values MUST match registered handlers + `bootstrap.ts` imports (PARITY Drop Point 2). Two parallel sequence sources must not drift: DB campaign steps (builder) vs `groups/main/sequences/*.md` (used by the email engine in pipeline 3).

## 3. Outreach send loop  *(tactical execution — high frequency)*

**Trigger:** `startAgenticLoop()` (`index.ts:535`) → self-scheduling `setTimeout` every `BDR_LOOP_INTERVAL_MS` (default 5 min) → `runTickOnce()` (`loop.ts:129`).

```
runTickOnce loop.ts:129 ─► getActiveEnrollments() ─► Promise.allSettled (per-prospect isolation)
      ▼
 processEnrollment loop.ts:171 ─► suppression gate :185 (unsubscribed/not_interested/suppressed)
      ▼
 find next due step ─► computeStepDueAt jitter :225 ─► sendStep :236
      ▼
 composeMessage() bdr-agent.ts:56 (Anthropic) ─► reviewMessage() quality-gate.ts:70  ◄── MANDATORY (ISC-9)
      │                                                      │ blocked ─► recordTouch(status:'blocked'), return
      ▼ passed
 getActionHandler(action_type) loop.ts:294 ─► handler(prospect,{body,subject})
      ▼                                          └─ channel.sendMessage + recordTouch + updateProspectStage
 updateEnrollment (advance) ─► pushToCRMs({type:'touch_sent'}) loop.ts:335
```

- **External services:** Anthropic (compose + gate) + the channel API the handler uses.
- **Fundamentally different:** the only high-frequency, always-on send loop; per-prospect error isolation; the **one path that runs the quality gate before every send**.
- **Sync points:** shares channel handlers with pipeline 4 — both must honor suppression/compliance identically. `updateProspectStage` inside a handler triggers pipeline 7. `getNextEmail` (`gmail-sequences.ts:122`) counts prior email touches, so `recordTouch` must fire on every send or steps repeat.

## 4. Daily BDR brain review  *(strategic planner — low frequency)*

**Trigger:** `startBDRBrain()` (`index.ts:534`) → self-scheduling `setTimeout` anchored to `BDR_BRAIN_HOUR` (default 6) → `runCycle()` (`bdr-brain.ts:76`).

```
runCycle bdr-brain.ts:76 ─► resetDailySendCounts() :89  ◄── resets per-account caps for the day
      ▼
 getActiveProspects() ─► per prospect: evaluateProspect :180
        detectHotSignal :222  +  determineNextAction :245 (stage+timing → action_type)
      ▼
 updateProspectNextAction (queue) ─► getDueProspects() ─► dispatchAction :334
        suppression gate :340 ─► actionHandlers.get(actionType) :348 ─► handler(...)
      ▼
 buildSummary :465 ─► completeBrainRun
```

- **External services:** none directly in `runCycle` (handlers invoke channel APIs).
- **Fundamentally different:** runs once/day; decides *what* action each prospect needs and *resets the daily counters* that gate pipeline 3. (Distinct from `task-scheduler.ts` `startSchedulerLoop` — that's NanoClaw's container-task runner.)
- **Sync points:** `resetDailySendCounts` timing gates pipeline 3's caps. `determineNextAction`'s stage→action map must match the registered `action_type` set. Same suppression semantics as `processEnrollment`.

## 5. Inbound reply handling  *(event-driven)*

**Trigger:** channel `onMessage` (`index.ts:625`) → `routeInboundToReplyHandler` (`:601`) → `processReply` (`reply-handler.ts:137`), fire-and-forget; idempotency via `markInboundProcessed(msg.id)` (`index.ts:616`).

```
inbound msg ─► skip self/bot echo ─► parseProspectJid ─► getProspectByContact bdr-db.ts:400
      ▼
 markInboundProcessed  ─►  STOP pre-gate  OPT_OUT_RE reply-handler.ts:152   ◄── BEFORE any Claude call
      │ matched ─► recordTouch(inbound) ─► updateProspectStage('unsubscribed') :163 ─► addProspectToSuppression :164 ─► return
      ▼ not opt-out
 classifyReply :44 (Claude, 7 categories) ─► recordTouch(inbound) ─► append prospects/<id>/CLAUDE.md
      ▼
 act per classification (interested/question/not_now/…) — each branch calls updateProspectStage
```

- **External services:** Anthropic (classification/answer); channel APIs deliver inbound (Twilio webhooks, Telegram long-poll, IG poll…).
- **Fundamentally different:** event-driven (not polled); the only pipeline where compliance can't depend on AI reachability — deterministic opt-out runs first.
- **Sync points:** stage writes flow to pipeline 7. `getProspectByContact` must resolve the same identifiers import/channel layers persist. **ISC-94 dead branch:** the `interested` inline-reply return value is dropped by the caller (see PARITY Drop Point 5).

## 6. Booking detection  *(externally authenticated)*

**Trigger:** `POST /api/webhooks/calendly` (`web-ui.ts:596`). No `src/calendly-webhook.ts` source exists — handler is inline in `web-ui.ts` (test: `src/calendly-webhook.test.ts`, e2e: `src/booking-flow.e2e.test.ts`).

```
Calendly webhook ─► HMAC-SHA256 verify (fail-closed) web-ui.ts:599 (CALENDLY_WEBHOOK_SIGNING_KEY)
      ▼
 filter event === 'invitee.created' :651 ─► require payload.email
      ▼
 idempotency markInboundProcessed(invitee URI) :664 ─► getProspectByContact('email',…) :668
      ▼
 recordTouch(inbound) ─► updateProspectStage('meeting_booked') :684   ◄── THE ONLY WRITER
      ▼
 fireHotLeadNotification
```

- **External services:** Calendly (inbound webhook); CRMs via the stage push.
- **Fundamentally different:** the only externally-authenticated inbound pipeline; the single writer of the terminal-positive `meeting_booked` stage. `send_meeting_link` sets only `meeting_link_sent` (`gmail-bdr-actions.ts:286`).
- **Sync points:** matches prospects on the same email key as import; the stage write fans out to pipeline 7 exactly once. **Never add a second `meeting_booked` writer.**

## 7. CRM hygiene / sync  *(bidirectional)*

**Trigger:** push — implicit on *every* `updateProspectStage` (`bdr-db.ts:642`, pipelines 3/4/5/6) + `touch_sent` from `loop.ts:335`. Pull — `POST /api/crm/pull` (`web-ui.ts:1139`) → `pullFromCRMs()` (`src/crm/registry.ts:48`). AI hygiene — `runCRMAgent()` (`crm-agent.ts:39`, **no wired trigger in `src/` — skill-invoked or pending**).

```
any updateProspectStage bdr-db.ts:627 ─► DB write ─► lazy import crm/registry
      ▼
 pushToCRMs({type:'stage_change', prospect, details}) registry.ts:33
      ▼
 Promise.allSettled over adapters ─► adapter.push(event)   (HubSpot/Salesforce/Monday/GHL; failures logged, not thrown)

 [pull]  POST /api/crm/pull ─► pullFromCRMs() ─► adapter.pull() ─► upsertProspect (re-enters pipeline 1 keys)
 [agent] runCRMAgent ─► gather secondBrain + prospects + stats ─► Claude ─► recommendations JSON
```

- **External services:** HubSpot / Salesforce / Monday / GoHighLevel; Anthropic (only for `runCRMAgent`).
- **Fundamentally different:** the only bidirectional external-system pipeline; the push half is a *side-effect embedded in a DB write*, not a standalone loop.
- **Sync points:** `updateProspectStage` is the shared authoritative push for pipelines 3–6 — any new stage-writing path auto-syncs and must **not** double-push (reply-handler deliberately skips a second `reply_received` push, `reply-handler.ts:274`). `pull()` results re-enter via the same `upsertProspect`/`getProspectByContact` keys as pipeline 1.

---

## Cross-pipeline sync map (the load-bearing seams)

| Seam | Pipelines that share it | Invariant |
|------|-------------------------|-----------|
| `updateProspectStage` (`bdr-db.ts:627`) | 3, 4, 5, 6 → 7 | single authoritative CRM `stage_change` push; never double-push |
| Suppression gate | 3 (`loop.ts:185`), 4 (`bdr-brain.ts:340`), 5 (STOP), channel `compliance.ts` | opt-out must hold on every send path; Telegram/IG gate upstream only |
| `action_type` set | 2 (builder) ↔ handlers ↔ 3, 4 dispatch | 3 lists in sync or steps no-op silently |
| `getProspectByContact` keys | 1, 5, 6, 7-pull | same email/phone/JID identity everywhere |
| `resetDailySendCounts` (`bdr-brain.ts:89`) | 4 gates 3 | daily caps reset once/day before the loop consumes them |
| `meeting_booked` writer | 6 only | exactly one writer; `send_meeting_link` writes `meeting_link_sent` |
