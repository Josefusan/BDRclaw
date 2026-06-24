/**
 * LinkedIn BDR action handlers.
 *
 * Registers with the BDR Brain at import time:
 *   - linkedin_connect: send a connection request with a personalized note
 *   - linkedin_dm:      send a DM to a 1st-degree connection
 *
 * Only active when LINKEDIN_ENABLED=true and the LinkedIn channel is connected.
 * Import this module in src/index.ts to activate.
 */

import crypto from 'crypto';

import {
  applyReplyClassification,
  readProspectMemory,
  registerActionHandler,
  writeProspectMemory,
} from './bdr-brain.js';
import { getProspectById, recordTouch, updateProspectNextAction, updateProspectStage } from './bdr-db.js';
import type { BDRProspect } from './bdr-types.js';
import { LinkedInChannel, profileUrlToJid } from './channels/linkedin.js';
import { getChannelFactory } from './channels/registry.js';
import { logger } from './logger.js';

// ── Helper ────────────────────────────────────────────────────────────────────

function getLinkedInChannel(): LinkedInChannel | null {
  const factory = getChannelFactory('linkedin');
  if (!factory) return null;
  // The channel factory requires opts — we re-use the already-started instance
  // stored on globalThis if available (set in src/index.ts after connect()).
  const ch = (globalThis as Record<string, unknown>).__bdrclaw_linkedin_channel;
  if (ch instanceof LinkedInChannel && ch.isConnected()) return ch;
  return null;
}

// ── linkedin_connect ──────────────────────────────────────────────────────────

registerActionHandler('linkedin_connect', async (prospect: BDRProspect) => {
  if (!prospect.linkedin_url) {
    logger.warn({ prospectId: prospect.id }, 'linkedin_connect: no linkedin_url on prospect');
    return;
  }

  const channel = getLinkedInChannel();
  if (!channel) {
    logger.warn('linkedin_connect: LinkedIn channel not connected');
    return;
  }

  // Build a short, personalized connection note
  const note = buildConnectionNote(prospect);

  try {
    await channel.sendConnectionRequest(prospect.linkedin_url, note);

    recordTouch({
      id: crypto.randomUUID(),
      prospect_id: prospect.id,
      channel: 'linkedin',
      direction: 'outbound',
      subject: 'Connection request',
      content: note ?? '(no note)',
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    // Schedule follow-up DM in 3 days if they accept
    const followUp = new Date();
    followUp.setDate(followUp.getDate() + 3);
    updateProspectNextAction(prospect.id, followUp.toISOString(), 'linkedin_dm');

    updateProspectStage(prospect.id, 'outreach_sent');
    logger.info({ prospectId: prospect.id }, 'LinkedIn connection request sent');
  } catch (err) {
    logger.error({ err, prospectId: prospect.id }, 'linkedin_connect failed');
  }
});

// ── linkedin_dm ───────────────────────────────────────────────────────────────

registerActionHandler('linkedin_dm', async (prospect: BDRProspect) => {
  if (!prospect.linkedin_url) {
    logger.warn({ prospectId: prospect.id }, 'linkedin_dm: no linkedin_url on prospect');
    return;
  }

  const channel = getLinkedInChannel();
  if (!channel) {
    logger.warn('linkedin_dm: LinkedIn channel not connected');
    return;
  }

  const memory = readProspectMemory(prospect.id);
  const touchCount = (memory.match(/linkedin_dm/g) ?? []).length;
  const message = buildDMMessage(prospect, touchCount);
  const jid = profileUrlToJid(prospect.linkedin_url);

  try {
    await channel.sendMessage(jid, message);

    recordTouch({
      id: crypto.randomUUID(),
      prospect_id: prospect.id,
      channel: 'linkedin',
      direction: 'outbound',
      content: message,
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    // Append to prospect memory
    const ts = new Date().toISOString().slice(0, 10);
    writeProspectMemory(
      prospect.id,
      memory + `\n[${ts}] linkedin_dm (touch ${touchCount + 1}):\n${message}\n`,
    );

    // Final DM — mark follow_up exhausted after 3 touches
    if (touchCount >= 2) {
      updateProspectStage(prospect.id, 'not_interested');
      logger.info({ prospectId: prospect.id }, 'LinkedIn sequence exhausted');
    } else {
      const next = new Date();
      next.setDate(next.getDate() + 5);
      updateProspectNextAction(prospect.id, next.toISOString(), 'linkedin_dm');
      updateProspectStage(prospect.id, 'follow_up');
    }

    logger.info({ prospectId: prospect.id, touchCount }, 'LinkedIn DM sent');
  } catch (err) {
    logger.error({ err, prospectId: prospect.id }, 'linkedin_dm failed');
  }
});

// ── Message builders ──────────────────────────────────────────────────────────

function buildConnectionNote(prospect: BDRProspect): string {
  const firstName = prospect.name.split(' ')[0];
  return (
    `Hi ${firstName}, I came across your profile and think there could be a great fit between ` +
    `what we do and ${prospect.company}'s goals. Would love to connect!`
  );
}

function buildDMMessage(prospect: BDRProspect, touchCount: number): string {
  const firstName = prospect.name.split(' ')[0];
  const senderName = process.env.GMAIL_SENDER_NAME ?? 'the team';

  if (touchCount === 0) {
    return (
      `Hi ${firstName}, thanks for connecting! I noticed ${prospect.company} is ` +
      `${touchCount === 0 ? 'growing fast' : 'scaling'} and wanted to share something ` +
      `that's helped companies like yours book more qualified meetings — ` +
      `without adding headcount. Worth a quick 15-min chat? — ${senderName}`
    );
  }

  if (touchCount === 1) {
    return (
      `Hey ${firstName}, just following up — I know things get busy. ` +
      `I'd love to share one quick idea specific to ${prospect.company} that's ` +
      `been working really well for other ${prospect.title}s. Would this week work? — ${senderName}`
    );
  }

  return (
    `Hi ${firstName}, last reach out — I don't want to clutter your inbox. ` +
    `If the timing is ever right to explore this, feel free to reach out. ` +
    `Wishing ${prospect.company} continued success! — ${senderName}`
  );
}
