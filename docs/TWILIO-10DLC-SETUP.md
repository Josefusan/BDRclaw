# Twilio A2P 10DLC Registration — Step-by-Step (BDRclaw SMS)

> **Why:** US carriers require every application-to-person SMS from a 10-digit local number to be registered
> with The Campaign Registry (TCR). Unregistered traffic is blocked. This is the longest external lead-time
> on the MVP critical path (1–4 weeks), so start it first.
>
> **You do the account steps** (login, EIN, payment — type `! <command>` for any CLI login). This doc is the
> checklist + the campaign copy written for you.

---

## Prerequisites (confirm before starting)

- [ ] **EIN ≥ 30 days old.** Brand registration rejects EINs younger than ~30 days. Confirm the entity's EIN issue date. (A brand-new Delaware C-corp waits ~30 days.)
- [ ] **Paid Twilio account** — trial accounts cannot register. Upgrade at console.twilio.com.
- [ ] **Business legal name + address exactly as on the IRS EIN letter** (CP-575). Mismatches are the #1 rejection cause.
- [ ] **Company website** live (bdrclaw.dev counts) — TCR reviewers check it.

---

## Step 1 — Buy a local 10DLC number (~$1.15/mo)
Console → Phone Numbers → Buy a number → local, SMS-capable, in your area code. Or CLI:
```bash
twilio phone-numbers:buy:local --country-code US --sms-enabled
```

## Step 2 — Brand registration (~$44–48 one-time, mins to 1–3 days)
Console → Messaging → Regulatory Compliance → A2P 10DLC → **Create Brand**.
- Standard brand (not sole-proprietor, unless that matches your entity).
- Enter legal name, EIN, address **exactly** as IRS records.
- Standard vetting is included; approval usually same-day to 3 business days.

## Step 3 — Campaign registration (~$15 one-time + $1.50–10/mo, 3–7 business days)
Console → same page → **Create Campaign** under the approved brand.

**Use case:** `Mixed` (or `Marketing`) — conversational sales outreach + follow-ups.

**Campaign description** (copy verbatim — honest opt-in is what gets it approved; "cold outreach" language gets it rejected):
> BDRclaw sends business development outreach and follow-up messages to business contacts who have
> opted in by submitting their phone number through our web form, verbal agreement logged at point of
> contact, or an existing business relationship. Messages include personalized introductions, meeting
> scheduling links, and replies to inbound questions. Every message identifies the sender and includes
> opt-out instructions. Recipients can reply STOP at any time to be removed immediately.

**Sample messages** (provide 2–3 that match what the code sends):
> 1. `Hi {name}, this is {sender} from {company}. Saw {personalized_hook} — worth a quick 15 min to explore {value_prop}? Reply STOP to opt out.`
> 2. `Following up, {name} — still happy to send over the details whenever you've got a moment. — {sender}. Reply STOP to opt out.`
> 3. `Thanks {name}! Here's my calendar: {calendly_url}. Looking forward to it. Reply STOP to opt out.`

**Opt-in description:** describe the web form / point-of-contact consent capture. **Must be truthful** — this is what the code's consent fields (Phase 3.1) enforce.

**Opt-out & help:** STOP / HELP keywords — the compliance engine (Phase 1.3 + 3) handles these; state that here.

## Step 4 — Toll-free bridge (parallel, free, 3–5 days)
Run this alongside Step 3 so you can pilot while the 10DLC campaign clears.
- Console → Phone Numbers → buy a **toll-free** number ($2.15/mo) → Regulatory Compliance → **Toll-Free Verification**.
- Free, no TCR campaign. **Note:** since Feb 17 2026, a Business Registration Number (EIN) is mandatory on new toll-free submissions.
- Unverified toll-free numbers are fully blocked from sending — verification is not optional.
- Toll-free reads as "business robotext" (lower reply rate) — use it only as a pilot bridge, migrate to the 10DLC number once approved.

## Step 5 — Wire the number into BDRclaw
```bash
# .env (already gitignored)
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX      # the 10DLC (or toll-free bridge) number
SMS_ENABLED=true
SMS_DAILY_MSG_LIMIT=100
```
Point the number's Messaging webhook at `https://bdrclaw.dev/webhooks/sms` **after deploy** (Phase 2). Until then, use an ngrok reserved domain for local testing.

---

## Cost summary
| Item | Cost |
|---|---|
| Brand registration | ~$44–48 one-time |
| Campaign vetting | ~$15 one-time |
| Campaign monthly | $1.50–10/mo |
| Local number | $1.15/mo |
| Toll-free number (bridge) | $2.15/mo |
| Per-SMS all-in (base + carrier surcharge) | ~$0.011–0.013/segment |
| **~100 msgs/day (~3,000/mo)** | **~$45–60/mo + ~$60 one-time** |

## Compliance the CODE must enforce (not optional — TCPA is $500–1,500/message)
These are Phases 1.3 + 3 of the MVP plan — the registration above assumes they exist:
- Consent record on every contact before first send (`consent_source`, `consent_timestamp`); attestation at CSV import.
- Quiet hours: recipient-local 8am–9pm federal; FL/OK/WA 8am–8pm; TX 9am–9pm Mon–Sat, noon–9pm Sun. (`src/timezone.ts` exists — wire it.)
- Opt-out: STOP/UNSUBSCRIBE/CANCEL/QUIT/END keywords **+** natural-language ("stop texting me") per FCC "any reasonable method" rule (April 2025). Immediate global suppression; one confirmation message max.
- Sender identification in the first message.
- TCPA 2-touch cap counted from `bdr_touches` (not regex over memory text).
- Consent + opt-out event log — this is the litigation defense.

*Sources: Twilio A2P 10DLC quickstart, Twilio Help Center 10DLC fees, FCC one-to-one rule status (vacated Jan 2025, deleted Sept 2025), TCPA 2026 guidance. Full citations in the research thread that produced the MVP plan.*
