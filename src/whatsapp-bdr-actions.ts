/**
 * WhatsApp BDR action handler.
 *
 * Registers with the BDR Brain at import time:
 *   - whatsapp_dm: send a WhatsApp message to a prospect's phone number
 *
 * WhatsApp is WARM/REPLY-ONLY (decided 2026-07-08): the channel's
 * sendMessage() refuses any send to a prospect with zero inbound WhatsApp
 * touches, so this handler can only continue conversations the prospect
 * started. Meta paused US marketing templates; cold WhatsApp outreach is
 * not a thing BDRclaw does.
 *
 * Requires prospect.phone to be set (E.164 format: +15551234567).
 *
 * Import in src/index.ts to activate.
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
  updateProspectStage,
} from './bdr-db.js';
import { e164WhatsAppToJid, WhatsAppChannel } from './channels/whatsapp.js';
import type { BDRProspect } from './bdr-types.js';
import { logger } from './logger.js';

function getWhatsAppChannel(): WhatsAppChannel | null {
  const ch = (globalThis as Record<string, unknown>).__bdrclaw_whatsapp_channel;
  if (ch instanceof WhatsAppChannel && ch.isConnected()) return ch;
  return null;
}

registerActionHandler(
  'whatsapp_dm',
  async (prospect: BDRProspect, composed?: ComposedOutbound) => {
    if (!prospect.phone) {
      logger.warn(
        { prospectId: prospect.id },
        'whatsapp_dm: no phone number on prospect',
      );
      return;
    }

    const channel = getWhatsAppChannel();
    if (!channel) {
      logger.warn(
        'whatsapp_dm: WhatsApp channel not connected — check WHATSAPP_ENABLED and Twilio credentials',
      );
      return;
    }

    // Global suppression — defense in depth. Both entry points check this
    // before dispatch and the channel throws on it; this keeps the handler
    // correct on its own too.
    if (isProspectSuppressed(prospect)) {
      logger.info(
        { prospectId: prospect.id },
        'whatsapp_dm: prospect suppressed — outbound skipped',
      );
      return;
    }

    const memory = readProspectMemory(prospect.id);

    // Prefer the composed + quality-gated message; fall back to the template.
    const message = resolveOutboundBody(composed, () => buildReply(prospect));
    const jid = e164WhatsAppToJid(prospect.phone);

    try {
      // channel.sendMessage enforces warm-only (refuses when the prospect has
      // zero inbound WhatsApp touches), suppression, and the daily cap.
      await channel.sendMessage(jid, message);

      recordTouch({
        id: crypto.randomUUID(),
        prospect_id: prospect.id,
        channel: 'whatsapp',
        direction: 'outbound',
        content: message,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });

      const ts = new Date().toISOString().slice(0, 10);
      writeProspectMemory(
        prospect.id,
        memory + `\n[${ts}] whatsapp_dm:\n${message}\n`,
      );

      const next = new Date();
      next.setDate(next.getDate() + 3);
      updateProspectNextAction(prospect.id, next.toISOString(), 'whatsapp_dm');
      updateProspectStage(prospect.id, 'follow_up');

      logger.info(
        { prospectId: prospect.id, phone: prospect.phone },
        'WhatsApp message sent',
      );
    } catch (err) {
      // Warm-only refusals land here by design — logged, never fatal.
      logger.error({ err, prospectId: prospect.id }, 'whatsapp_dm failed');
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
