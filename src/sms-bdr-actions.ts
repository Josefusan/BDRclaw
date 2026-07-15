/**
 * SMS BDR action handler.
 *
 * Registers with the BDR Brain at import time:
 *   - send_sms: send an SMS to a prospect's phone number
 *
 * Requires prospect.phone to be set (E.164 format: +15551234567).
 * Keep messages under 160 chars for single-part delivery (saves cost).
 * Twilio handles concatenation automatically for longer messages.
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
import {
  SMS_UNSOLICITED_TOUCH_CAP,
  touchCounts,
} from './channels/compliance.js';
import { e164ToJid } from './channels/sms.js';
import { SMSChannel } from './channels/sms.js';
import type { BDRProspect } from './bdr-types.js';
import { logger } from './logger.js';

function getSMSChannel(): SMSChannel | null {
  const ch = (globalThis as Record<string, unknown>).__bdrclaw_sms_channel;
  if (ch instanceof SMSChannel && ch.isConnected()) return ch;
  return null;
}

registerActionHandler(
  'send_sms',
  async (prospect: BDRProspect, composed?: ComposedOutbound) => {
    if (!prospect.phone) {
      logger.warn(
        { prospectId: prospect.id },
        'send_sms: no phone number on prospect',
      );
      return;
    }

    const channel = getSMSChannel();
    if (!channel) {
      logger.warn(
        'send_sms: SMS channel not connected — check SMS_ENABLED and Twilio credentials',
      );
      return;
    }

    // Global suppression — defense in depth. Both entry points (loop
    // processEnrollment, brain dispatchAction) check this before dispatch and
    // the channel throws on it; this keeps the handler correct on its own too.
    if (isProspectSuppressed(prospect)) {
      logger.info(
        { prospectId: prospect.id },
        'send_sms: prospect suppressed — outbound skipped',
      );
      return;
    }

    // TCPA: never send more than 2 UNSOLICITED SMS. Counted from bdr_touches
    // (the durable record), not from prose in the memory file. A prospect who
    // has replied on SMS is solicited — the cap no longer applies.
    const { inbound, outbound: touchCount } = touchCounts(prospect.id, 'sms');
    if (inbound === 0 && touchCount >= SMS_UNSOLICITED_TOUCH_CAP) {
      logger.info(
        { prospectId: prospect.id, touchCount },
        'send_sms: TCPA unsolicited-touch cap reached, sequence exhausted',
      );
      updateProspectStage(prospect.id, 'not_interested');
      return;
    }

    const memory = readProspectMemory(prospect.id);

    // Prefer the composed + quality-gated message; fall back to the template.
    const message = resolveOutboundBody(composed, () =>
      buildSMS(prospect, touchCount),
    );
    const jid = e164ToJid(prospect.phone);

    try {
      await channel.sendMessage(jid, message);

      recordTouch({
        id: crypto.randomUUID(),
        prospect_id: prospect.id,
        channel: 'sms',
        direction: 'outbound',
        content: message,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });

      const ts = new Date().toISOString().slice(0, 10);
      writeProspectMemory(
        prospect.id,
        memory + `\n[${ts}] send_sms (touch ${touchCount + 1}):\n${message}\n`,
      );

      const next = new Date();
      next.setDate(next.getDate() + 3);
      updateProspectNextAction(prospect.id, next.toISOString(), 'send_sms');
      updateProspectStage(prospect.id, 'follow_up');

      logger.info(
        { prospectId: prospect.id, phone: prospect.phone, touchCount },
        'SMS sent',
      );
    } catch (err) {
      logger.error({ err, prospectId: prospect.id }, 'send_sms failed');
    }
  },
);

function buildSMS(prospect: BDRProspect, touchCount: number): string {
  const firstName = prospect.name.split(' ')[0];
  const senderName = process.env.GMAIL_SENDER_NAME ?? 'the team';
  const meetingUrl = process.env.CALENDLY_URL ?? '';

  if (touchCount === 0) {
    const base = `Hi ${firstName}, it's ${senderName}. We help ${prospect.title}s hit pipeline targets without a full BDR team. Worth a quick chat?`;
    return meetingUrl ? `${base} ${meetingUrl}` : base;
  }

  return `Hey ${firstName}, just following up on my last message. Let me know if you'd like to connect — no pressure! — ${senderName}`;
}
