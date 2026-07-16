/**
 * Loop lifecycle tests — ISC-1, ISC-2, ISC-3, ISC-4, ISC-8, ISC-24.
 *
 * ISC-2  Error isolation: one prospect's send failure never stops the others.
 * ISC-1  Recovery + heartbeat: the loop keeps ticking after an error; every
 *        tick emits its start-heartbeat log.
 * ISC-3  Structured error logging: every catch logs { err, prospectId, phase }.
 * ISC-4  Clean shutdown: SIGTERM/SIGINT handlers only set running=false
 *        (loop.ts startAgenticLoop — no process.exit), and stopAgenticLoop()
 *        clears the pending timer while an in-flight tick runs to completion.
 * ISC-8  Bounded send-time jitter of ±campaign.jitter_minutes.
 * ISC-24 Activate → enroll → the enrolled prospect is processed on one tick.
 *
 * Harness follows loop.e2e.test.ts: mocked @anthropic-ai/sdk, in-memory DB via
 * _initBDRTestDatabase(), capturing handlers via registerActionHandler, and
 * runTickOnce() as the deterministic tick driver.
 */

import crypto from 'crypto';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared, hoisted state the mocked SDK factory can safely reference.
const h = vi.hoisted(() => ({
  composerCalls: 0,
  // When set, the composer throws for the prospect whose name appears in the
  // request — drives the compose-phase structured-error path (ISC-3).
  failComposeForName: null as string | null,
  GATED_BODY:
    'Hi, quick question about scaling your pipeline — worth 15 minutes?',
}));

// Composer-only Anthropic mock (no classifier needed in these tests).
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn(async (params: { messages?: unknown }) => {
        h.composerCalls++;
        if (
          h.failComposeForName &&
          JSON.stringify(params.messages ?? '').includes(h.failComposeForName)
        ) {
          throw new Error('synthetic compose failure');
        }
        return { content: [{ type: 'text', text: h.GATED_BODY }] };
      }),
    };
  },
}));

// Rule-layer quality gate only (read at reviewMessage call time, not import).
process.env.QUALITY_GATE_AI = 'false';

import {
  _initBDRTestDatabase,
  addProspect,
  enrollProspect,
  getActiveEnrollments,
  getEnrollment,
  getTouchesForProspect,
  recordTouch,
  upsertCampaign,
  upsertCampaignStep,
} from '../bdr-db.js';
import { enrollAllActiveProspects } from '../campaign-builder.js';
import { registerActionHandler } from '../bdr-brain.js';
import { logger } from '../logger.js';
import {
  computeStepDueAt,
  getLoopStatus,
  runTickOnce,
  startAgenticLoop,
  stopAgenticLoop,
} from './loop.js';
import type { BDRProspect } from '../bdr-types.js';

const CAMPAIGN_ID = 'camp-lifecycle';
const PAST = () => new Date(Date.now() - 86_400_000).toISOString();

function seedCampaign(
  opts: { jitterMinutes?: number; status?: 'active' | 'draft' } = {},
): void {
  const now = new Date().toISOString();
  upsertCampaign({
    id: CAMPAIGN_ID,
    name: 'Lifecycle Test Campaign',
    value_proposition: 'more pipeline',
    tone: 'friendly',
    jitter_minutes: opts.jitterMinutes ?? 0,
    status: opts.status ?? 'active',
    created_at: now,
    updated_at: now,
  });
  upsertCampaignStep({
    id: 'step-1',
    campaign_id: CAMPAIGN_ID,
    step_number: 1,
    action_type: 'send_sms',
    delay_days: 0,
    template: 'Hi {{firstName}}, template fallback that should NOT be sent.',
    condition: 'always',
  });
}

/** addProspect generates its own slug id — always use the returned prospect. */
function seedProspect(name: string, phone: string): BDRProspect {
  return addProspect({
    name,
    company: `${name} Co`,
    title: 'VP Sales',
    phone,
  });
}

function enroll(prospectId: string, enrolledAt: string = PAST()): string {
  const id = `enr-${prospectId}`;
  enrollProspect({
    id,
    campaign_id: CAMPAIGN_ID,
    prospect_id: prospectId,
    current_step: 0,
    status: 'active',
    enrolled_at: enrolledAt,
  });
  return id;
}

/** Register a send_sms handler that records the touch like a real channel skill
 *  (e.g. sms-bdr-actions.ts) and optionally throws for specific prospect ids. */
function registerRecordingHandler(failFor: Set<string> = new Set()): string[] {
  const dispatched: string[] = [];
  registerActionHandler('send_sms', async (prospect, composed) => {
    if (failFor.has(prospect.id)) {
      throw new Error(`synthetic send failure for ${prospect.id}`);
    }
    dispatched.push(prospect.id);
    recordTouch({
      id: crypto.randomUUID(),
      prospect_id: prospect.id,
      channel: 'sms',
      direction: 'outbound',
      content: composed?.body ?? 'fallback',
      status: 'sent',
      sent_at: new Date().toISOString(),
    });
  });
  return dispatched;
}

function outboundTouches(prospectId: string) {
  return getTouchesForProspect(prospectId).filter(
    (t) => t.direction === 'outbound',
  );
}

describe('agentic loop lifecycle — ISC-1/2/3/4/8/24', () => {
  beforeEach(() => {
    h.composerCalls = 0;
    h.failComposeForName = null;
    _initBDRTestDatabase();
  });

  afterEach(() => {
    // Stop the loop and clear any pending scheduler timer left by a test.
    stopAgenticLoop();
    vi.restoreAllMocks();
  });

  it('ISC-2: one prospect erroring does not stop the others; the tick completes', async () => {
    seedCampaign();
    const p1 = seedProspect('Alice One', '+15550000001');
    const p2 = seedProspect('Bob Two', '+15550000002');
    const p3 = seedProspect('Cara Three', '+15550000003');
    for (const p of [p1, p2, p3]) enroll(p.id);

    const infoSpy = vi.spyOn(logger, 'info');
    const errorSpy = vi.spyOn(logger, 'error');
    registerRecordingHandler(new Set([p2.id]));

    await runTickOnce();

    // Prospects 1 and 3 got outbound touches; the failing one got none.
    expect(outboundTouches(p1.id)).toHaveLength(1);
    expect(outboundTouches(p3.id)).toHaveLength(1);
    expect(outboundTouches(p2.id)).toHaveLength(0);

    // Their enrollments advanced despite p2's failure.
    expect(getEnrollment(CAMPAIGN_ID, p1.id)?.current_step).toBe(1);
    expect(getEnrollment(CAMPAIGN_ID, p3.id)?.current_step).toBe(1);
    expect(getEnrollment(CAMPAIGN_ID, p2.id)?.current_step).toBe(0);

    // The error was logged (not swallowed) and the tick ran to completion.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ prospectId: p2.id, phase: 'send' }),
      'Channel send failed',
    );
    expect(
      infoSpy.mock.calls.some(([, msg]) => msg === 'bdr-loop-tick: complete'),
    ).toBe(true);
  });

  it('ISC-1: the loop recovers after an error — a second tick processes normally, with a heartbeat per tick', async () => {
    seedCampaign();
    const p1 = seedProspect('Dana Four', '+15550000004');
    const p2 = seedProspect('Evan Five', '+15550000005');
    enroll(p1.id);
    enroll(p2.id);

    const infoSpy = vi.spyOn(logger, 'info');
    const failFor = new Set([p2.id]);
    registerRecordingHandler(failFor);

    // Tick 1: p2's send throws; p1 succeeds.
    await runTickOnce();
    expect(outboundTouches(p1.id)).toHaveLength(1);
    expect(outboundTouches(p2.id)).toHaveLength(0);

    // Tick 2: the failure "resolves" — the loop was never stopped, so the
    // still-active p2 enrollment is processed normally.
    failFor.clear();
    await runTickOnce();
    expect(outboundTouches(p2.id)).toHaveLength(1);
    expect(getEnrollment(CAMPAIGN_ID, p2.id)?.status).toBe('completed');

    // Heartbeat: the per-tick start log fired for each of the two ticks.
    const heartbeats = infoSpy.mock.calls.filter(
      ([, msg]) => msg === 'bdr-loop-tick: start',
    );
    expect(heartbeats).toHaveLength(2);
    // Each heartbeat carries a distinct tickId + timestamp.
    const tickIds = heartbeats.map(
      ([fields]) => (fields as { tickId: string }).tickId,
    );
    expect(new Set(tickIds).size).toBe(2);
    for (const [fields] of heartbeats) {
      expect(fields).toEqual(
        expect.objectContaining({ tickId: expect.any(String), ts: expect.any(String) }),
      );
    }
  });

  it('ISC-3: errors are logged with structured { err, prospectId, phase } fields', async () => {
    seedCampaign();
    const pSend = seedProspect('Fay Sendfail', '+15550000006');
    const pCompose = seedProspect('Gus Composefail', '+15550000007');
    enroll(pSend.id);
    enroll(pCompose.id);

    const errorSpy = vi.spyOn(logger, 'error');
    h.failComposeForName = 'Gus Composefail';
    registerRecordingHandler(new Set([pSend.id]));

    await runTickOnce();

    // Send-phase failure (loop.ts sendStep handler catch): { err, prospectId, step, phase: 'send' }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        prospectId: pSend.id,
        step: 1,
        phase: 'send',
      }),
      'Channel send failed',
    );

    // Compose-phase failure (loop.ts sendStep compose catch): { err, prospectId, step, phase: 'compose' }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        prospectId: pCompose.id,
        step: 1,
        phase: 'compose',
      }),
      'BDR agent compose failed',
    );
  });

  // ISC-4 path taken: loop.ts:75-84 signal handlers ONLY set running=false and
  // log — they never call process.exit. That makes the handler safe to invoke
  // in-process. We invoke the exact listener startAgenticLoop registered rather
  // than process.emit('SIGTERM'), so vitest's own signal listeners are not
  // triggered as a side effect.
  it("ISC-4: SIGTERM handler sets running=false — loop stops scheduling, doesn't exit the process", () => {
    const beforeTerm = process.listeners('SIGTERM');
    const beforeInt = process.listeners('SIGINT');

    startAgenticLoop();
    expect(getLoopStatus().running).toBe(true);

    const addedTerm = process
      .listeners('SIGTERM')
      .filter((l) => !beforeTerm.includes(l));
    const addedInt = process
      .listeners('SIGINT')
      .filter((l) => !beforeInt.includes(l));
    expect(addedTerm).toHaveLength(1);
    expect(addedInt).toHaveLength(1);

    // Invoke the registered SIGTERM listener directly (safe: no process.exit).
    addedTerm[0]('SIGTERM');
    expect(getLoopStatus().running).toBe(false);

    // stopAgenticLoop() clears the still-pending tick timer; a fresh start works.
    stopAgenticLoop();
    expect(getLoopStatus().running).toBe(false);

    // Tidy up: the listeners are registered once per module; remove them so
    // nothing lingers on the shared process object after this file.
    process.removeListener('SIGTERM', addedTerm[0]);
    process.removeListener('SIGINT', addedInt[0]);
  });

  it('ISC-4: stopAgenticLoop() stops scheduling while an in-flight tick runs to completion (no half-sent state)', async () => {
    seedCampaign();
    const p = seedProspect('Hana Inflight', '+15550000008');
    enroll(p.id);

    let releaseSend!: () => void;
    const sendGate = new Promise<void>((r) => (releaseSend = r));
    let markStarted!: () => void;
    const handlerStarted = new Promise<void>((r) => (markStarted = r));

    registerActionHandler('send_sms', async (prospect, composed) => {
      markStarted();
      await sendGate; // hold the send in flight
      recordTouch({
        id: crypto.randomUUID(),
        prospect_id: prospect.id,
        channel: 'sms',
        direction: 'outbound',
        content: composed?.body ?? 'fallback',
        status: 'sent',
        sent_at: new Date().toISOString(),
      });
    });

    startAgenticLoop();
    expect(getLoopStatus().running).toBe(true);

    const tick = runTickOnce();
    await handlerStarted;

    // Stop while the send is mid-flight.
    stopAgenticLoop();
    expect(getLoopStatus().running).toBe(false);

    // At the moment of stop: nothing half-recorded.
    expect(outboundTouches(p.id)).toHaveLength(0);
    expect(getEnrollment(CAMPAIGN_ID, p.id)?.current_step).toBe(0);

    // The in-flight tick completes fully: touch recorded AND enrollment advanced.
    releaseSend();
    await tick;
    expect(outboundTouches(p.id)).toHaveLength(1);
    const enr = getEnrollment(CAMPAIGN_ID, p.id);
    expect(enr?.current_step).toBe(1);
    expect(enr?.status).toBe('completed');
    // And the loop is still stopped afterwards.
    expect(getLoopStatus().running).toBe(false);
  });

  it('ISC-8: computeStepDueAt applies bounded ±jitter_minutes jitter and is not constant', () => {
    const base = Date.UTC(2026, 0, 1);
    const jitterMin = 30;
    const jitterMs = jitterMin * 60_000;
    const dayMs = 86_400_000;

    // Deterministic bounds via a seeded Math.random.
    const rnd = vi.spyOn(Math, 'random');
    rnd.mockReturnValue(0); // → -jitter (lower bound)
    expect(computeStepDueAt(base, 1, jitterMin)).toBe(base + dayMs - jitterMs);
    rnd.mockReturnValue(0.5); // → zero jitter
    expect(computeStepDueAt(base, 1, jitterMin)).toBe(base + dayMs);
    rnd.mockReturnValue(0.999999); // → just under +jitter (upper bound)
    expect(computeStepDueAt(base, 1, jitterMin)).toBeLessThanOrEqual(
      base + dayMs + jitterMs,
    );
    expect(computeStepDueAt(base, 1, jitterMin)).toBeGreaterThan(base + dayMs);
    // jitter_minutes = 0 → exact due time regardless of random.
    expect(computeStepDueAt(base, 1, 0)).toBe(base + dayMs);
    rnd.mockRestore();

    // Real randomness: every sample within ±jitter, and not all identical.
    const samples = Array.from({ length: 100 }, () =>
      computeStepDueAt(base, 0, jitterMin),
    );
    for (const s of samples) {
      expect(Math.abs(s - base)).toBeLessThanOrEqual(jitterMs);
    }
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  it('ISC-8: the loop consults the jitter window when deciding if a step is due', async () => {
    // Campaign with 60-minute jitter; enrollment enrolled RIGHT NOW with a
    // 0-day delay, so due-ness is decided entirely by the jitter sign.
    seedCampaign({ jitterMinutes: 60 });
    const p = seedProspect('Ivy Jitter', '+15550000009');
    enroll(p.id, new Date().toISOString());

    const dispatched = registerRecordingHandler();
    const rnd = vi.spyOn(Math, 'random');

    // Max positive jitter → dueAt ≈ now + 60min → NOT sent this tick.
    rnd.mockReturnValue(0.999999);
    await runTickOnce();
    expect(dispatched).toHaveLength(0);

    // Max negative jitter → dueAt ≈ now - 60min → sent this tick.
    rnd.mockReturnValue(0);
    await runTickOnce();
    expect(dispatched).toEqual([p.id]);
    rnd.mockRestore();
  });

  it('ISC-24: activate → enrollAllActiveProspects → prospect processed within one tick', async () => {
    // Build a draft campaign the way campaign-builder.saveCampaign does.
    seedCampaign({ status: 'draft' });
    const p = seedProspect('Jack Fresh', '+15550000010');

    // Draft campaigns enroll nobody (guard inside enrollAllActiveProspects).
    expect(enrollAllActiveProspects(CAMPAIGN_ID)).toBe(0);

    // PATCH-equivalent activation, then enrollment of all active prospects.
    seedCampaign({ status: 'active' });
    expect(enrollAllActiveProspects(CAMPAIGN_ID)).toBe(1);

    const enrollment = getEnrollment(CAMPAIGN_ID, p.id);
    expect(enrollment?.status).toBe('active');
    expect(enrollment?.current_step).toBe(0);
    expect(getActiveEnrollments(CAMPAIGN_ID)).toHaveLength(1);

    // One tick processes the freshly-enrolled prospect end to end.
    const dispatched = registerRecordingHandler();
    await runTickOnce();

    expect(dispatched).toEqual([p.id]);
    const touches = outboundTouches(p.id);
    expect(touches).toHaveLength(1);
    expect(touches[0].content).toBe(h.GATED_BODY);
    expect(h.composerCalls).toBeGreaterThan(0);
    expect(getEnrollment(CAMPAIGN_ID, p.id)?.status).toBe('completed');
  });
});
