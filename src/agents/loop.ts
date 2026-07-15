/**
 * BDRclaw Agentic Loop — ISC-1 through ISC-4.
 *
 * The main orchestration loop. Runs every BDR_LOOP_INTERVAL_MS (default: 5 min).
 * On each tick:
 *   1. Process all due campaign enrollments:
 *      a. BDR Agent composes a personalized message
 *      b. Quality Gate audits it (ISC-9 — never bypassed)
 *      c. Channel sends it (or blocks are logged)
 *      d. Touch recorded, enrollment advanced, CRM synced
 *
 * Inbound replies are handled event-driven in the channel onMessage path
 * (src/index.ts → processReply), not polled here.
 *
 * Error isolation: errors on one prospect NEVER stop processing others.
 * Every catch block logs { err, prospectId, phase } — no silent failures.
 * Loop continues after any error (ISC-1, ISC-2, ISC-3).
 * SIGTERM/SIGINT set a running=false flag; the loop exits cleanly after
 * the current tick completes (ISC-4).
 */

import crypto from 'crypto';

import {
  getActiveEnrollments,
  getCampaignById,
  getCampaignSteps,
  getProspectById,
  isProspectSuppressed,
  recordTouch,
  updateEnrollment,
} from '../bdr-db.js';
import { pushToCRMs } from '../crm/registry.js';
import { logger } from '../logger.js';
import { composeMessage } from './bdr-agent.js';
import { reviewMessage } from './quality-gate.js';
import type {
  Campaign,
  CampaignEnrollment,
  CampaignStep,
} from '../bdr-types.js';

// ── Config ────────────────────────────────────────────────────────────────────

const LOOP_INTERVAL_MS = parseInt(
  process.env.BDR_LOOP_INTERVAL_MS ?? String(5 * 60 * 1000),
  10,
);
const TICK_LABEL = 'bdr-loop-tick';

// ── State ─────────────────────────────────────────────────────────────────────

let running = false;
let tickCount = 0;
let pendingTick: NodeJS.Timeout | null = null;
let signalHandlersRegistered = false;

// ── Entry point ───────────────────────────────────────────────────────────────

export function startAgenticLoop(): void {
  if (running) {
    logger.warn('Agentic loop already running');
    return;
  }
  running = true;
  logger.info(
    { intervalMs: LOOP_INTERVAL_MS },
    'BDRclaw agentic loop starting',
  );

  // Register graceful shutdown (once per process — the loop can now be
  // started/stopped repeatedly via the dashboard without leaking listeners)
  if (!signalHandlersRegistered) {
    signalHandlersRegistered = true;
    const stop = (signal: string) => {
      logger.info(
        { signal },
        'Agentic loop: shutdown signal received, will stop after current tick',
      );
      running = false;
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
  }

  scheduleNextTick();
}

/**
 * Stop the agentic loop cleanly. Safe to call when the loop is not running
 * (no-op). Clears the pending tick timer immediately; a tick already in
 * flight completes its current prospects, then the scheduler exits.
 */
export function stopAgenticLoop(): void {
  if (!running) {
    if (pendingTick) {
      clearTimeout(pendingTick);
      pendingTick = null;
    }
    return;
  }
  running = false;
  if (pendingTick) {
    clearTimeout(pendingTick);
    pendingTick = null;
  }
  logger.info('Agentic loop stopped via stopAgenticLoop()');
}

function scheduleNextTick(): void {
  if (!running) {
    logger.info('Agentic loop stopped cleanly');
    return;
  }
  pendingTick = setTimeout(async () => {
    pendingTick = null;
    await runTickOnce();
    scheduleNextTick();
  }, LOOP_INTERVAL_MS);
}

// ── Main tick ─────────────────────────────────────────────────────────────────

/**
 * Run exactly one loop tick. Exported as the deterministic single-tick entry
 * point so tests can drive a tick without the scheduler; production behavior is
 * identical (the scheduler just calls this on an interval).
 */
export async function runTickOnce(): Promise<void> {
  tickCount++;
  const tickId = `tick-${tickCount}`;
  logger.info({ tickId, ts: new Date().toISOString() }, `${TICK_LABEL}: start`);

  const enrollments = getActiveEnrollments();
  logger.info(
    { tickId, count: enrollments.length },
    `${TICK_LABEL}: processing enrollments`,
  );

  // Process enrollments with per-prospect error isolation
  await Promise.allSettled(
    enrollments.map((enrollment) => processEnrollmentSafe(enrollment, tickId)),
  );

  logger.info({ tickId }, `${TICK_LABEL}: complete`);
}

// ── Per-enrollment processing ─────────────────────────────────────────────────

async function processEnrollmentSafe(
  enrollment: CampaignEnrollment,
  tickId: string,
): Promise<void> {
  try {
    await processEnrollment(enrollment);
  } catch (err) {
    // ISC-3: every error logged with structured fields — never swallowed
    logger.error(
      {
        err,
        prospectId: enrollment.prospect_id,
        enrollmentId: enrollment.id,
        tickId,
        phase: 'enrollment',
      },
      `${TICK_LABEL}: enrollment processing error (prospect isolated, loop continues)`,
    );
  }
}

async function processEnrollment(
  enrollment: CampaignEnrollment,
): Promise<void> {
  const campaign = getCampaignById(enrollment.campaign_id);
  if (!campaign || campaign.status !== 'active') return;

  const steps = getCampaignSteps(campaign.id);
  if (steps.length === 0) return;

  const prospect = getProspectById(enrollment.prospect_id);
  if (!prospect) return;

  // Skip unsubscribed/not_interested prospects, and any contact on the global
  // suppression list (opted out via a different prospect record — ISC-17).
  if (
    prospect.stage === 'unsubscribed' ||
    prospect.stage === 'not_interested' ||
    isProspectSuppressed(prospect)
  ) {
    updateEnrollment(enrollment.id, { status: 'paused' });
    return;
  }

  // Find next due step
  const nextStep = steps.find((s) => s.step_number > enrollment.current_step);
  if (!nextStep) {
    // All steps complete
    updateEnrollment(enrollment.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    return;
  }

  // Check timing: is this step due yet?
  const lastAt = enrollment.last_step_at
    ? new Date(enrollment.last_step_at).getTime()
    : new Date(enrollment.enrolled_at).getTime();
  const jitterMs = (Math.random() * 2 - 1) * campaign.jitter_minutes * 60_000;
  const dueAt = lastAt + nextStep.delay_days * 86_400_000 + jitterMs;
  if (Date.now() < dueAt) return;

  await sendStep(campaign, nextStep, enrollment);
}

// ── Step send — the core guarded path ────────────────────────────────────────

async function sendStep(
  campaign: Campaign,
  step: CampaignStep,
  enrollment: CampaignEnrollment,
): Promise<void> {
  const prospect = getProspectById(enrollment.prospect_id);
  if (!prospect) return;

  // ISC-5 to ISC-8: BDR Agent composes personalized message
  let composed: Awaited<ReturnType<typeof composeMessage>>;
  try {
    composed = await composeMessage(prospect, step, campaign);
  } catch (err) {
    logger.error(
      {
        err,
        prospectId: prospect.id,
        step: step.step_number,
        phase: 'compose',
      },
      'BDR agent compose failed',
    );
    return;
  }

  // ISC-9 to ISC-15: Quality Gate — MANDATORY, never bypassed
  const gate = await reviewMessage(
    composed.body,
    composed.channel,
    prospect.name,
    campaign.tone,
  );

  // ISC-13: blocked messages recorded but not sent
  if (!gate.pass) {
    recordTouch({
      id: crypto.randomUUID(),
      prospect_id: prospect.id,
      channel: composed.channel,
      direction: 'outbound',
      content: composed.body,
      status: 'blocked', // ISC-13: quality-gate-blocked, recorded but not sent
      sent_at: new Date().toISOString(),
      subject: composed.subject,
    });
    logger.warn(
      {
        prospectId: prospect.id,
        reason: gate.reason,
        channel: composed.channel,
      },
      'Message blocked by quality gate — not sent',
    );
    return;
  }

  // Dispatch to channel via registered action handler
  const { getActionHandler } = await import('../bdr-brain.js');
  const handler = getActionHandler(step.action_type);
  if (!handler) {
    logger.warn(
      { actionType: step.action_type },
      'No action handler registered — channel skill not installed',
    );
    return;
  }

  // ISC-5/6/7/15: pass the composed + gated message explicitly so the handler
  // sends THIS text (not its hardcoded template). Fix-by-contract: the message
  // travels as a typed argument, not smuggled through enrichment.
  try {
    await handler(prospect, {
      body: composed.body,
      subject: composed.subject,
    });
  } catch (err) {
    logger.error(
      { err, prospectId: prospect.id, step: step.step_number, phase: 'send' },
      'Channel send failed',
    );
    return;
  }

  // Advance enrollment
  const now = new Date().toISOString();
  const isLast =
    step.step_number ===
    (await import('../bdr-db.js')).getCampaignSteps(campaign.id).slice(-1)[0]
      ?.step_number;

  updateEnrollment(enrollment.id, {
    current_step: step.step_number,
    last_step_at: now,
    ...(isLast ? { status: 'completed', completed_at: now } : {}),
  });

  // CRM sync on outbound
  const updatedProspect = getProspectById(prospect.id);
  if (updatedProspect) {
    await pushToCRMs({
      type: 'touch_sent',
      prospect: updatedProspect,
      timestamp: now,
      details: { step: step.step_number, channel: composed.channel },
    }).catch((err) => logger.warn({ err }, 'CRM push failed after send'));
  }

  logger.info(
    {
      prospectId: prospect.id,
      step: step.step_number,
      channel: composed.channel,
    },
    'Campaign step sent via agentic loop',
  );
}

// ── Status ────────────────────────────────────────────────────────────────────

export function getLoopStatus(): {
  running: boolean;
  tickCount: number;
  intervalMs: number;
} {
  return { running, tickCount, intervalMs: LOOP_INTERVAL_MS };
}
