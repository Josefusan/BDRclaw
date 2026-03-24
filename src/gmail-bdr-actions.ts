/**
 * Gmail BDR action handlers.
 *
 * Registers with the BDR Brain at import time:
 *   - send_email: send the next sequence step to a prospect
 *   - classify_reply: classify an inbound reply and update prospect stage
 *   - send_meeting_link: send a Calendly/meeting link to an interested prospect
 *
 * Import this module in src/index.ts to activate the handlers.
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

import {
  applyReplyClassification,
  readProspectMemory,
  registerActionHandler,
  writeProspectMemory,
} from './bdr-brain.js';
import {
  getAccountById,
  getProspectById,
  incrementAccountSends,
  recordTouch,
  updateProspectNextAction,
  updateProspectStage,
} from './bdr-db.js';
import type { BDRProspect, ReplyClassification } from './bdr-types.js';
import { getGmailChannel } from './channels/gmail.js';
import { getNextEmail } from './gmail-sequences.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';

// Thread tracking: prospect_id → { threadId, lastMessageId }
const THREADS_FILE = path.join(STORE_DIR, 'gmail-threads.json');

function loadThreads(): Record<string, { threadId: string; messageId: string }> {
  try {
    return JSON.parse(fs.readFileSync(THREADS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveThread(prospectId: string, threadId: string, messageId: string): void {
  const threads = loadThreads();
  threads[prospectId] = { threadId, messageId };
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2), 'utf-8');
}

function getThread(
  prospectId: string,
): { threadId: string; messageId: string } | null {
  return loadThreads()[prospectId] ?? null;
}

// ── send_email ────────────────────────────────────────────────────────────────

registerActionHandler('send_email', async (prospect: BDRProspect) => {
  const channel = getGmailChannel();
  if (!channel) {
    logger.warn('send_email: Gmail channel not available — install /add-gmail');
    return;
  }

  if (!prospect.email) {
    logger.warn(
      { prospectId: prospect.id },
      'send_email: prospect has no email address, skipping',
    );
    return;
  }

  // Determine which account to send from
  const account = prospect.assigned_account_id
    ? getAccountById(prospect.assigned_account_id)
    : null;
  const accountIndex = channel.accountIndexFromKey(account?.credentials_key);

  // Check daily send limit
  if (account && account.sends_today >= account.daily_send_limit) {
    logger.warn(
      { prospectId: prospect.id, accountId: account.id },
      'send_email: daily send limit reached, deferring to tomorrow',
    );
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(6, 0, 0, 0);
    updateProspectNextAction(
      prospect.id,
      tomorrow.toISOString(),
      'send_email',
    );
    return;
  }

  // Get next sequence step
  const email = getNextEmail(prospect);
  if (!email) {
    logger.info(
      { prospectId: prospect.id },
      'send_email: sequence exhausted, marking not_interested',
    );
    updateProspectStage(prospect.id, 'not_interested');
    return;
  }

  // Thread tracking for reply threading
  const existingThread = getThread(prospect.id);

  try {
    const result = await channel.sendBDREmail({
      to: prospect.email,
      subject: email.subject,
      body: email.body,
      accountIndex,
      threadId: existingThread?.threadId,
      inReplyTo: existingThread?.messageId,
    });

    // Save thread for future follow-ups
    saveThread(prospect.id, result.threadId, result.messageId);

    // Record the touch
    recordTouch({
      id: crypto.randomUUID(),
      prospect_id: prospect.id,
      account_id: account?.id,
      channel: 'email',
      direction: 'outbound',
      subject: email.subject,
      content: email.body,
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    // Increment account send counter
    if (account) incrementAccountSends(account.id);

    // Update prospect stage
    const nextStage =
      prospect.stage === 'identified' ? 'outreach_sent' : 'follow_up';
    updateProspectStage(prospect.id, nextStage);

    // Schedule next follow-up (3 days out)
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + 3);
    updateProspectNextAction(
      prospect.id,
      nextDate.toISOString(),
      'send_email',
    );

    // Update prospect memory
    appendSequenceEntry(
      prospect.id,
      email.stepNumber,
      email.subject,
      email.isBreakup ? '(breakup email)' : undefined,
    );

    logger.info(
      {
        prospectId: prospect.id,
        step: email.stepNumber,
        isBreakup: email.isBreakup,
        threadId: result.threadId,
      },
      'Email sent',
    );
  } catch (err) {
    logger.error({ prospectId: prospect.id, err }, 'Failed to send email');
    throw err;
  }
});

// ── classify_reply ────────────────────────────────────────────────────────────

registerActionHandler('classify_reply', async (prospect: BDRProspect) => {
  const memory = readProspectMemory(prospect.id);
  if (!memory) {
    logger.warn({ prospectId: prospect.id }, 'classify_reply: no memory found');
    return;
  }

  // Extract the most recent reply from prospect memory
  const replyMatch = memory.match(/\*\*Reply:\*\*\s*([\s\S]*?)(?=\n##|\n\*\*|$)/);
  const replyText = replyMatch?.[1]?.trim() ?? '';

  const classification = classifyReply(replyText);
  applyReplyClassification(prospect.id, classification);

  // Log classification to prospect memory
  const now = new Date().toISOString().slice(0, 10);
  const tag = `[${now}] Reply classified: ${classification}`;
  const updatedMemory = memory + `\n${tag}\n`;
  writeProspectMemory(prospect.id, updatedMemory);

  logger.info(
    { prospectId: prospect.id, classification },
    'Reply classified',
  );
});

// ── send_meeting_link ─────────────────────────────────────────────────────────

registerActionHandler('send_meeting_link', async (prospect: BDRProspect) => {
  const channel = getGmailChannel();
  if (!channel || !prospect.email) return;

  const meetingUrl = process.env.CALENDLY_URL || process.env.MEETING_URL;
  if (!meetingUrl) {
    logger.warn(
      'send_meeting_link: no CALENDLY_URL or MEETING_URL in .env, skipping',
    );
    return;
  }

  const account = prospect.assigned_account_id
    ? getAccountById(prospect.assigned_account_id)
    : null;
  const accountIndex = channel.accountIndexFromKey(account?.credentials_key);
  const existingThread = getThread(prospect.id);
  const senderName =
    process.env.GMAIL_SENDER_NAME ||
    process.env[`GMAIL_ACCOUNT_${accountIndex}`]?.split('@')[0] ||
    'the team';

  const subject = `Next step for ${prospect.company}`;
  const body =
    `Hi ${prospect.name.split(' ')[0]},\n\n` +
    `Great to hear from you! Here's a link to book a time that works for you:\n\n` +
    `${meetingUrl}\n\n` +
    `Looking forward to connecting.\n\n` +
    `Best,\n${senderName}`;

  try {
    const result = await channel.sendBDREmail({
      to: prospect.email,
      subject,
      body,
      accountIndex,
      threadId: existingThread?.threadId,
      inReplyTo: existingThread?.messageId,
    });

    saveThread(prospect.id, result.threadId, result.messageId);
    recordTouch({
      id: crypto.randomUUID(),
      prospect_id: prospect.id,
      account_id: account?.id,
      channel: 'email',
      direction: 'outbound',
      subject,
      content: body,
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    updateProspectStage(prospect.id, 'meeting_booked');
    logger.info({ prospectId: prospect.id }, 'Meeting link sent');
  } catch (err) {
    logger.error({ prospectId: prospect.id, err }, 'Failed to send meeting link');
  }
});

// ── Reply classification ──────────────────────────────────────────────────────

const POSITIVE_SIGNALS = [
  'yes',
  'interested',
  'sure',
  'sounds good',
  'let\'s chat',
  "let's connect",
  'tell me more',
  'more info',
  'schedule',
  'book',
  'call',
  'meeting',
  'demo',
  'when are you',
  'available',
  'open to',
  'happy to',
  'would love',
  'absolutely',
];

const NEGATIVE_SIGNALS = [
  'not interested',
  'no thanks',
  'no thank you',
  'please remove',
  'unsubscribe',
  'stop emailing',
  'take me off',
  'don\'t contact',
  "don't email",
  'not the right time',
  'not a fit',
  'already have',
  'not relevant',
];

const OOO_SIGNALS = [
  'out of office',
  'on vacation',
  'annual leave',
  'be back',
  'returning',
  'away until',
  'away from',
  'automatic reply',
  'auto-reply',
];

const REFERRAL_SIGNALS = [
  'talk to',
  'reach out to',
  'contact',
  'better person',
  'right person',
  'in charge of',
  'handles this',
  'cc\'d',
  'forwarded',
];

function classifyReply(text: string): ReplyClassification {
  const lower = text.toLowerCase();

  if (OOO_SIGNALS.some((s) => lower.includes(s))) return 'out_of_office';
  if (NEGATIVE_SIGNALS.some((s) => lower.includes(s))) {
    if (lower.includes('unsubscribe') || lower.includes('remove')) {
      return 'unsubscribe';
    }
    return 'not_interested';
  }
  if (REFERRAL_SIGNALS.some((s) => lower.includes(s))) return 'referral';
  if (POSITIVE_SIGNALS.some((s) => lower.includes(s))) return 'interested';

  // Has a question mark → probably a question
  if (text.includes('?')) return 'question';

  // Short replies with no clear signal — treat as potential interest
  return 'not_now';
}

// ── Prospect memory helpers ───────────────────────────────────────────────────

function appendSequenceEntry(
  prospectId: string,
  stepNumber: number,
  subject: string,
  note?: string,
): void {
  const memory = readProspectMemory(prospectId);
  if (!memory) return;

  const date = new Date().toISOString().slice(0, 10);
  const line = `- [${date}] Email #${stepNumber} sent — Subject: "${subject}"${note ? ` — ${note}` : ''}`;

  // Insert into the ## Sequence section
  const updated = memory.replace(
    /## Sequence\n_(no touches yet)_/,
    `## Sequence\n${line}`,
  );
  const final = updated.includes(line) ? updated : `${memory}\n${line}`;
  writeProspectMemory(prospectId, final);
}
