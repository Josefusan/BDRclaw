/**
 * BDR Brain — the strategic intelligence layer of BDRclaw.
 *
 * Runs on a configurable daily schedule (default: 6am).
 * Responsibilities:
 *   1. Review all active prospects — evaluate stage, timing, buying signals
 *   2. Queue next-touch actions for due prospects
 *   3. Flag hot leads and notify the closer
 *   4. Generate a daily pipeline summary
 *   5. Reset daily account send limits
 *
 * Channel skills (/add-gmail, /add-linkedin) hook into the action queue
 * to execute the actual sends. The brain decides WHAT to do; channels do HOW.
 */

import fs from 'fs';
import path from 'path';

import {
  completeBrainRun,
  getActiveProspects,
  getDueProspects,
  getLastBrainRun,
  getPipelineStats,
  resetDailySendCounts,
  startBrainRun,
  updateProspectNextAction,
  updateProspectStage,
} from './bdr-db.js';
import { logger } from './logger.js';
import type { ActionType, BDRProspect, ReplyClassification } from './bdr-types.js';

// ── Config ────────────────────────────────────────────────────────────────────

const BRAIN_SCHEDULE_HOUR = parseInt(process.env.BDR_BRAIN_HOUR ?? '6', 10);
const PROSPECTS_DIR = path.resolve(process.cwd(), 'prospects');

// Days between outreach touches per stage transition
const FOLLOW_UP_DAYS: Record<string, number> = {
  outreach_sent_to_follow_up: 3,
  follow_up_to_linkedin: 5,
  follow_up_to_breakup: 14,
};

// ── Entry Point ───────────────────────────────────────────────────────────────

export function startBDRBrain(): void {
  logger.info({ scheduleHour: BRAIN_SCHEDULE_HOUR }, 'BDR Brain starting');
  scheduleNextRun();
}

function scheduleNextRun(): void {
  const now = new Date();
  const next = new Date();
  next.setHours(BRAIN_SCHEDULE_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next.getTime() - now.getTime();
  const hh = Math.floor(ms / 3600000);
  logger.info({ nextRun: next.toISOString(), inHours: hh }, 'BDR Brain next run scheduled');
  setTimeout(() => {
    runCycle().catch((err) => logger.error({ err }, 'BDR Brain cycle failed'));
    scheduleNextRun();
  }, ms);
}

// ── Main Cycle ────────────────────────────────────────────────────────────────

export async function runCycle(): Promise<void> {
  const runId = startBrainRun();
  const startedAt = Date.now();
  logger.info({ runId }, 'BDR Brain cycle started');

  let prospectsReviewed = 0;
  let actionsQueued = 0;
  let hotLeadsFound = 0;
  const hotLeadNames: string[] = [];
  const actionLines: string[] = [];

  try {
    // 1. Reset daily send counts (runs at top of each cycle)
    resetDailySendCounts();

    // 2. Load all active prospects (not closed/unsubscribed)
    const prospects = getActiveProspects();
    prospectsReviewed = prospects.length;
    logger.info({ count: prospects.length }, 'BDR Brain reviewing prospects');

    // 3. Evaluate each prospect
    for (const prospect of prospects) {
      const result = evaluateProspect(prospect);

      if (result.isHotLead && result.hotSignal) {
        hotLeadsFound++;
        hotLeadNames.push(`${prospect.name} @ ${prospect.company} (${result.hotSignal})`);
        logger.info(
          { prospectId: prospect.id, signal: result.hotSignal },
          'Hot lead detected',
        );
      }

      if (result.nextAction) {
        actionsQueued++;
        actionLines.push(`${prospect.name} @ ${prospect.company}: ${result.nextAction}`);
        // Schedule the action for now (immediate) if no date set
        if (!prospect.next_action_at) {
          updateProspectNextAction(
            prospect.id,
            new Date().toISOString(),
            result.nextAction,
          );
        }
      }
    }

    // 4. Process prospects whose scheduled action is due
    const dueProspects = getDueProspects();
    logger.info({ count: dueProspects.length }, 'Processing due actions');
    for (const prospect of dueProspects) {
      await dispatchAction(prospect);
      actionsQueued++;
    }

    // 5. Generate and log summary
    const summary = buildSummary(prospectsReviewed, actionsQueued, hotLeadsFound, hotLeadNames, actionLines);
    logger.info({ summary: summary.slice(0, 200) }, 'BDR Brain daily summary');

    completeBrainRun(runId, {
      status: 'completed',
      duration_ms: Date.now() - startedAt,
      prospects_reviewed: prospectsReviewed,
      actions_queued: actionsQueued,
      hot_leads_found: hotLeadsFound,
      meetings_booked: 0,
      summary,
    });

    logger.info(
      { runId, prospectsReviewed, actionsQueued, hotLeadsFound },
      'BDR Brain cycle complete',
    );
  } catch (err) {
    completeBrainRun(runId, {
      status: 'error',
      duration_ms: Date.now() - startedAt,
      prospects_reviewed: prospectsReviewed,
      actions_queued: actionsQueued,
      hot_leads_found: hotLeadsFound,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ── Prospect Evaluation ───────────────────────────────────────────────────────

interface EvaluationResult {
  nextAction?: ActionType;
  isHotLead?: boolean;
  hotSignal?: string;
}

function evaluateProspect(prospect: BDRProspect): EvaluationResult {
  const memory = readProspectMemory(prospect.id);
  const daysSinceTouch = prospect.last_touch_at
    ? daysSince(prospect.last_touch_at)
    : null;

  // Hot lead detection (signal-based)
  const hotSignal = detectHotSignal(prospect, memory);
  if (hotSignal) {
    return { isHotLead: true, hotSignal, nextAction: 'notify_closer' };
  }

  // Determine next action based on stage + timing
  const nextAction = determineNextAction(prospect, daysSinceTouch);
  return { nextAction };
}

// ── Hot Signal Detection ──────────────────────────────────────────────────────

const HOT_KEYWORDS = [
  'pricing', 'price', 'cost', 'budget', 'quote',
  'demo', 'trial', 'proof of concept', 'poc',
  'contract', 'agreement', 'sign',
  'timeline', 'when can we', 'how soon',
  'evaluation', 'shortlist', 'vendor',
  'decision', 'next steps',
];

function detectHotSignal(prospect: BDRProspect, memory: string): string | null {
  // Stage-based signals
  if (prospect.stage === 'interested') return 'expressed interest';
  if (prospect.stage === 'meeting_booked') return 'meeting booked';

  // Keywords in prospect memory (replies, notes)
  if (memory) {
    const lower = memory.toLowerCase();
    for (const kw of HOT_KEYWORDS) {
      if (lower.includes(kw)) return `mentioned "${kw}"`;
    }
  }

  // Timing signal: replied quickly (within 24h of last touch)
  if (prospect.stage === 'replied' && prospect.last_touch_at) {
    return 'replied to outreach';
  }

  return null;
}

// ── Action Determination ──────────────────────────────────────────────────────

function determineNextAction(
  prospect: BDRProspect,
  daysSinceTouch: number | null,
): ActionType | undefined {
  const { stage } = prospect;

  switch (stage) {
    case 'identified':
      return 'send_email';

    case 'outreach_sent':
      if (daysSinceTouch === null) return undefined;
      if (daysSinceTouch >= FOLLOW_UP_DAYS.outreach_sent_to_follow_up) return 'send_email';
      if (daysSinceTouch >= 5) return 'linkedin_connect';
      if (daysSinceTouch >= FOLLOW_UP_DAYS.follow_up_to_breakup) return 'send_email'; // breakup
      return undefined;

    case 'follow_up':
      if (daysSinceTouch !== null && daysSinceTouch >= FOLLOW_UP_DAYS.follow_up_to_linkedin) {
        return 'linkedin_dm';
      }
      return undefined;

    case 'replied':
      return 'classify_reply';

    case 'interested':
      return 'send_meeting_link';

    default:
      return undefined;
  }
}

// ── Action Dispatch ───────────────────────────────────────────────────────────
// Channel skills plug in here. Each skill registers a handler for its action type.
// Until a skill is installed, actions are logged and deferred.

type ActionHandler = (prospect: BDRProspect) => Promise<void>;
const actionHandlers = new Map<string, ActionHandler>();

export function registerActionHandler(actionType: ActionType, handler: ActionHandler): void {
  actionHandlers.set(actionType, handler);
  logger.info({ actionType }, 'BDR Brain: action handler registered');
}

async function dispatchAction(prospect: BDRProspect): Promise<void> {
  const actionType = prospect.next_action_type;
  if (!actionType) return;

  const handler = actionHandlers.get(actionType);
  if (!handler) {
    logger.warn(
      { prospectId: prospect.id, actionType },
      'No handler for action type — install the channel skill to enable this action',
    );
    // Reschedule for tomorrow so it doesn't block
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(BRAIN_SCHEDULE_HOUR, 0, 0, 0);
    updateProspectNextAction(prospect.id, tomorrow.toISOString(), actionType);
    return;
  }

  try {
    await handler(prospect);
    logger.info({ prospectId: prospect.id, actionType }, 'Action dispatched');
  } catch (err) {
    logger.error({ prospectId: prospect.id, actionType, err }, 'Action dispatch failed');
  }
}

// ── Prospect Memory ───────────────────────────────────────────────────────────

export function readProspectMemory(prospectId: string): string {
  const memPath = path.join(PROSPECTS_DIR, prospectId, 'CLAUDE.md');
  try {
    return fs.readFileSync(memPath, 'utf-8');
  } catch {
    return '';
  }
}

export function writeProspectMemory(prospectId: string, content: string): void {
  const dir = path.join(PROSPECTS_DIR, prospectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content, 'utf-8');
}

export function initProspectMemory(prospect: BDRProspect): void {
  const enrichment = prospect.enrichment ? JSON.parse(prospect.enrichment) : {};
  const tags = prospect.tags ? JSON.parse(prospect.tags) : [];

  const content = `# Prospect: ${prospect.name} — ${prospect.company}

## Profile
- **Title:** ${prospect.title}
- **Company:** ${prospect.company}
- **Email:** ${prospect.email ?? '_unknown_'}
- **LinkedIn:** ${prospect.linkedin_url ?? '_unknown_'}
- **Phone:** ${prospect.phone ?? '_unknown_'}
- **Source:** ${prospect.source}
- **Tags:** ${tags.length > 0 ? tags.join(', ') : '_none_'}

## Stage
${prospect.stage}

## Sequence
_(no touches yet)_

## Next Action
${prospect.next_action_at ? `${prospect.next_action_at} — ${prospect.next_action_type ?? 'TBD'}` : '_TBD_'}

## Notes
_(add notes here)_

## Enrichment
${Object.keys(enrichment).length > 0
  ? Object.entries(enrichment).map(([k, v]) => `- **${k}:** ${v}`).join('\n')
  : '_(pending enrichment)_'}
`;
  writeProspectMemory(prospect.id, content);
}

// ── Reply Classification ──────────────────────────────────────────────────────

/**
 * Classify an inbound reply and update the prospect stage accordingly.
 * The Claude agent in the container does the actual LLM classification —
 * this function applies the result.
 */
export function applyReplyClassification(
  prospectId: string,
  classification: ReplyClassification,
): void {
  const stageMap: Partial<Record<ReplyClassification, string>> = {
    interested: 'interested',
    not_now: 'follow_up',
    not_interested: 'not_interested',
    unsubscribe: 'unsubscribed',
    referral: 'replied', // keep in pipeline, add referral as new prospect
    question: 'replied', // auto-respond if confident
    out_of_office: 'follow_up', // pause and resume
  };
  const newStage = stageMap[classification];
  if (newStage) {
    updateProspectStage(prospectId, newStage);
    logger.info({ prospectId, classification, newStage }, 'Reply classified, stage updated');
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function daysSince(isoString: string): number {
  return Math.floor((Date.now() - new Date(isoString).getTime()) / 86_400_000);
}

function buildSummary(
  reviewed: number,
  queued: number,
  hotLeads: number,
  hotNames: string[],
  actions: string[],
): string {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const lines = [
    `## BDR Brain — Daily Summary — ${date}`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Prospects reviewed | ${reviewed} |`,
    `| Actions queued | ${queued} |`,
    `| Hot leads flagged | ${hotLeads} |`,
  ];

  if (hotNames.length > 0) {
    lines.push(``, `### 🔥 Hot Leads`);
    for (const name of hotNames) lines.push(`- ${name}`);
  }

  if (actions.length > 0) {
    lines.push(``, `### Action Queue`);
    for (const a of actions.slice(0, 20)) lines.push(`- ${a}`);
    if (actions.length > 20) lines.push(`- ...and ${actions.length - 20} more`);
  }

  lines.push(``, `_Generated by BDR Brain at ${new Date().toISOString()}_`);
  return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export { getLastBrainRun, getPipelineStats };
