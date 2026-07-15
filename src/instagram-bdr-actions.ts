/**
 * Instagram BDR action handler.
 *
 * Registers with the BDR Brain at import time:
 *   - instagram_dm: send an Instagram DM to a prospect
 *
 * Instagram is WARM/REPLY-ONLY by policy: the channel's sendMessage()
 * refuses any send to a prospect who has never messaged us first (Meta's
 * 24-hour messaging window + account-safety policy). This handler can only
 * continue conversations the prospect started.
 *
 * Requires prospect.enrichment to contain { instagram_user_id: "..." } —
 * captured automatically when the prospect DMs the connected IG account.
 *
 * Import via src/bootstrap.ts to activate.
 */

import crypto from 'crypto';

import {
  readProspectMemory,
  registerActionHandler,
  resolveOutboundBody,
  writeProspectMemory,
} from './bdr-brain.js';
import type { ComposedOutbound } from './bdr-brain.js';
import {
  isProspectSuppressed,
  recordTouch,
  updateProspectNextAction,
} from './bdr-db.js';
import { igUserIdToJid, InstagramChannel } from './channels/instagram.js';
import type { BDRProspect } from './bdr-types.js';
import { logger } from './logger.js';

function getInstagramChannel(): InstagramChannel | null {
  const ch = (globalThis as Record<string, unknown>)
    .__bdrclaw_instagram_channel;
  if (ch instanceof InstagramChannel && ch.isConnected()) return ch;
  return null;
}

registerActionHandler(
  'instagram_dm',
  async (prospect: BDRProspect, composed?: ComposedOutbound) => {
    let igUserId: string | null = null;
    if (prospect.enrichment) {
      try {
        const e = JSON.parse(prospect.enrichment) as Record<string, unknown>;
        igUserId = e.instagram_user_id ? String(e.instagram_user_id) : null;
      } catch {
        // not JSON
      }
    }

    if (!igUserId) {
      logger.warn(
        { prospectId: prospect.id },
        'instagram_dm: no instagram_user_id in prospect enrichment — the prospect must DM us first',
      );
      return;
    }

    const channel = getInstagramChannel();
    if (!channel) {
      logger.warn(
        'instagram_dm: Instagram channel not connected — check INSTAGRAM_ENABLED and Meta credentials',
      );
      return;
    }

    // Global suppression — defense in depth alongside the channel's own check.
    if (isProspectSuppressed(prospect)) {
      logger.info(
        { prospectId: prospect.id },
        'instagram_dm: prospect suppressed — outbound skipped',
      );
      return;
    }

    const memory = readProspectMemory(prospect.id);

    // Prefer the composed + quality-gated message; fall back to the template.
    const message = resolveOutboundBody(composed, () => buildReply(prospect));
    const jid = igUserIdToJid(igUserId);

    try {
      // channel.sendMessage enforces warm-only, suppression, and the daily cap.
      await channel.sendMessage(jid, message);

      recordTouch({
        id: crypto.randomUUID(),
        prospect_id: prospect.id,
        channel: 'instagram',
        direction: 'outbound',
        content: message,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });

      const ts = new Date().toISOString().slice(0, 10);
      writeProspectMemory(
        prospect.id,
        memory + `\n[${ts}] instagram_dm:\n${message}\n`,
      );

      const next = new Date();
      next.setDate(next.getDate() + 3);
      updateProspectNextAction(prospect.id, next.toISOString(), 'instagram_dm');

      logger.info({ prospectId: prospect.id }, 'Instagram DM sent');
    } catch (err) {
      // Warm-only refusals land here by design — logged, never fatal.
      logger.error({ err, prospectId: prospect.id }, 'instagram_dm failed');
    }
  },
);

function buildReply(prospect: BDRProspect): string {
  const firstName = prospect.name.split(' ')[0];
  const senderName = process.env.GMAIL_SENDER_NAME ?? 'the team';
  const meetingUrl = process.env.CALENDLY_URL ?? '';
  const base = `Hi ${firstName}, ${senderName} here — following up on our conversation. Happy to answer any questions.`;
  return meetingUrl ? `${base} Book a time here: ${meetingUrl}` : base;
}
