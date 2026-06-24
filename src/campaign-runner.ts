/**
 * Campaign Runner — maps campaign enrollments to BDR brain actions.
 *
 * Runs alongside the BDR brain's daily cycle. For each active enrollment:
 *   1. Check if the current step is due (delay_days elapsed since last_step_at)
 *   2. If the step's condition is met (no_reply, opened, etc.), execute it
 *   3. Advance to the next step or mark enrollment complete
 *
 * Messages are personalized: {{firstName}}, {{company}}, {{title}} are replaced
 * from prospect data before sending. Sends are jittered by campaign.jitter_minutes
 * to avoid pattern-matching by spam filters.
 *
 * Import this module in src/index.ts to activate.
 */

import crypto from 'crypto';

import {
  getActiveEnrollments,
  getCampaignById,
  getCampaignSteps,
  getProspectById,
  recordTouch,
  updateEnrollment,
  updateProspectNextAction,
  updateProspectStage,
} from './bdr-db.js';
import { getActionHandler } from './bdr-brain.js';
import { logger } from './logger.js';
import type {
  BDRProspect,
  CampaignEnrollment,
  CampaignStep,
} from './bdr-types.js';

// ── Personalization ───────────────────────────────────────────────────────────

export function personalize(template: string, prospect: BDRProspect): string {
  const firstName = prospect.name.split(' ')[0] ?? prospect.name;
  return template
    .replace(/\{\{firstName\}\}/g, firstName)
    .replace(/\{\{name\}\}/g, prospect.name)
    .replace(/\{\{company\}\}/g, prospect.company)
    .replace(/\{\{title\}\}/g, prospect.title)
    .replace(/\{\{email\}\}/g, prospect.email ?? '')
    .replace(/\{\{phone\}\}/g, prospect.phone ?? '');
}

// ── Jitter ────────────────────────────────────────────────────────────────────

function jitterMs(minutes: number): number {
  // Random value in [-minutes, +minutes] converted to ms
  return (Math.random() * 2 - 1) * minutes * 60 * 1000;
}

// ── Step condition check ──────────────────────────────────────────────────────

function conditionMet(
  step: CampaignStep,
  enrollment: CampaignEnrollment,
): boolean {
  if (step.condition === 'always') return true;
  // For no_reply / opened / clicked we'd check the touch record; for now,
  // treat no_reply as "always" since we don't yet track open pixels.
  if (step.condition === 'no_reply') return true;
  return false;
}

// ── Step execution ────────────────────────────────────────────────────────────

async function executeStep(
  step: CampaignStep,
  prospect: BDRProspect,
  enrollment: CampaignEnrollment,
): Promise<boolean> {
  const personalizedText = personalize(step.template, prospect);
  const personalizedSubject = step.subject
    ? personalize(step.subject, prospect)
    : undefined;

  // For email steps, mutate the prospect's enrichment so the email action
  // handler can pick up the subject override.
  if (step.action_type === 'send_email' && personalizedSubject) {
    try {
      const existing = prospect.enrichment
        ? JSON.parse(prospect.enrichment)
        : {};
      prospect = {
        ...prospect,
        enrichment: JSON.stringify({
          ...existing,
          __campaign_subject: personalizedSubject,
        }),
      };
    } catch {
      // ignore parse errors
    }
  }

  // Try registered action handlers first (email, linkedin, sms, etc.)
  const handler = getActionHandler(step.action_type);
  if (handler) {
    // Inject the campaign message into the prospect's memory so action handlers
    // use this exact text instead of their default template.
    const enriched = injectCampaignMessage(prospect, personalizedText);
    try {
      await handler(enriched);
      return true;
    } catch (err) {
      logger.error(
        { err, prospectId: prospect.id, stepId: step.id },
        'Campaign step execution failed',
      );
      return false;
    }
  }

  logger.warn(
    { actionType: step.action_type },
    'No handler for campaign step action_type',
  );
  return false;
}

function injectCampaignMessage(
  prospect: BDRProspect,
  message: string,
): BDRProspect {
  try {
    const existing = prospect.enrichment ? JSON.parse(prospect.enrichment) : {};
    return {
      ...prospect,
      enrichment: JSON.stringify({ ...existing, __campaign_message: message }),
    };
  } catch {
    return prospect;
  }
}

// ── Main runner tick ──────────────────────────────────────────────────────────

export async function runCampaignTick(): Promise<void> {
  const enrollments = getActiveEnrollments();
  if (enrollments.length === 0) return;

  logger.info({ count: enrollments.length }, 'Campaign runner tick');

  for (const enrollment of enrollments) {
    try {
      await processEnrollment(enrollment);
    } catch (err) {
      logger.error(
        { err, enrollmentId: enrollment.id },
        'Campaign enrollment processing error',
      );
    }
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

  // Find the step we need to execute next
  const nextStep =
    steps.find((s) => s.step_number > enrollment.current_step) ??
    steps.find((s) => s.step_number === enrollment.current_step);

  // If all steps done, complete enrollment
  if (
    !nextStep ||
    enrollment.current_step >= steps[steps.length - 1].step_number
  ) {
    updateEnrollment(enrollment.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    logger.info(
      { enrollmentId: enrollment.id },
      'Campaign enrollment completed',
    );
    return;
  }

  // Check if it's time to send this step
  const lastStepAt = enrollment.last_step_at
    ? new Date(enrollment.last_step_at).getTime()
    : new Date(enrollment.enrolled_at).getTime();

  const jitter = jitterMs(campaign.jitter_minutes);
  const dueAt = lastStepAt + nextStep.delay_days * 86_400_000 + jitter;

  if (Date.now() < dueAt) return; // not yet due

  if (!conditionMet(nextStep, enrollment)) return;

  const ok = await executeStep(nextStep, prospect, enrollment);
  if (!ok) return;

  const now = new Date().toISOString();
  const isLastStep =
    nextStep.step_number === steps[steps.length - 1].step_number;

  updateEnrollment(enrollment.id, {
    current_step: nextStep.step_number,
    last_step_at: now,
    ...(isLastStep ? { status: 'completed', completed_at: now } : {}),
  });

  logger.info(
    {
      campaignId: campaign.id,
      prospectId: prospect.id,
      step: nextStep.step_number,
    },
    'Campaign step sent',
  );
}

// ── Self-registration with BDR brain ─────────────────────────────────────────
// Called once at startup to add the campaign tick to the brain's daily cycle.

let _registered = false;

export function registerCampaignRunner(): void {
  if (_registered) return;
  _registered = true;
  // The BDR brain's runCycle() will call this — we hook it by exporting
  // runCampaignTick and having bdr-brain import and call it.
  logger.info('Campaign runner registered');
}
