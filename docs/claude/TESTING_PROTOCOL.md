# TESTING_PROTOCOL — BDRclaw

> Grounded in the repo's real setup, not an imported convention. Read
> `docs/claude/PARITY_CHECKLIST.md` for the surface list this protocol protects.

## 1. Framework & runner

- **Vitest** (`^4.0.18`), coverage via `@vitest/coverage-v8`.
- `npm test` → `vitest run` (CI/one-shot) · `npm run test:watch` → `vitest` (watch).
- **Two configs, different scopes:**
  - `vitest.config.ts` → includes `src/**/*.test.ts` and `setup/**/*.test.ts` — the application/unit suite (this is what `npm test` exercises).
  - `vitest.skills.config.ts` → includes `.claude/skills/**/tests/*.test.ts` — a separate suite for skill packages (no matching files yet).
- Tests stub all I/O with `vi.mock` / `vi.hoisted` (Twilio, `bdr-db`, logger, googleapis) — **zero live network** in the suite.
- Current size: **34** `*.test.ts` under `src/` (**38** including `setup/`).

## 2. Naming convention (the repo's actual patterns)

Tests are **co-located** with the code they cover and named for it:

| Pattern | Meaning | Examples |
|---------|---------|----------|
| `<module>.test.ts` | Unit/integration for that module (the norm) | `src/channels/sms.test.ts`, `src/db.test.ts`, `src/dashboard-auth.test.ts` |
| `<module>.e2e.test.ts` | End-to-end wiring across seams | `src/agents/loop.e2e.test.ts`, `src/booking-flow.e2e.test.ts` |
| `<module>.lifecycle.test.ts` | State-machine / lifecycle coverage | `src/agents/loop.lifecycle.test.ts` |

**Rule:** one test file per module; within it, one `describe` block per surface/behavior, each **traced to its ISC** (`ISA.md` requirement id). Do **not** introduce a `*.spec.ts` family — it's inconsistent with everything here.

Every channel MUST keep its **self-disable test** (factory returns `null` with zero network calls when the channel's env flag/creds are absent) — see `src/channels/sms.test.ts` "self-disable (ISC-60)".

## 3. Merge gate

**No PR merges until, on `main`:**
- `npm test` is fully green (all `src/**` + `setup/**` tests pass), and
- `npm run typecheck` reports **0 errors**, and
- every surface in `docs/claude/PARITY_CHECKLIST.md` touched by the change has a passing test.

The pre-commit hook runs `prettier --write` but does **not** re-stage — run `npm run format:fix` before committing.

## 4. When tests are required

Add or update tests for any change that touches:
- an **outbound send path** (a `src/channels/*.ts` `sendMessage`, a `src/*-bdr-actions.ts` handler, `processEnrollment`, or `dispatchAction`) — must assert suppression/compliance/caps still hold;
- **compliance** (`src/channels/compliance.ts`, `src/email-compliance.ts`, `src/twilio-signature.ts`, suppression);
- the **`/api/*` surface** in `src/web-ui.ts` (add/verify a route test alongside `src/dashboard-api.test.ts` / `src/dashboard-write-api.test.ts`);
- a **pipeline** in `docs/claude/DOWNLOAD_FLOWS.md` (loop, brain, reply-handler, booking, CRM sync);
- the **booking single-writer** rule (`meeting_booked` may only be written by the Calendly webhook — keep the source-walking guard test);
- a new **channel or CRM adapter** (register it + add its self-disable test).

## 5. Test structure template

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// vi.mock('../bdr-db', ...) etc. — stub all I/O

describe('<surface> — <behavior> (ISC-NN)', () => {
  beforeEach(() => { vi.clearAllMocks(); /* reset env */ });

  it('does the expected thing and touches no network when it should not', () => {
    // arrange env/mocks → act → assert
    expect(result).toBe(expected);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
```

Assert the **post-condition**, never just the signal — e.g. after a campaign update, assert the campaign still has its steps, not that a success toast fired (see `docs/claude/INVESTIGATIONS.md`, 2026-07-16).
