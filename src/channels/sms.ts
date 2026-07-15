/**
 * SMS channel — Twilio Programmable Messaging.
 *
 * Outbound: Twilio Messages API (From: +1…, To: +1…)
 * Inbound:  Twilio webhook → POST /webhooks/sms on this server
 *
 * Setup:
 *   1. twilio.com → Buy a number with SMS capability
 *   2. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in .env
 *   3. In Twilio Console → Phone Numbers → your number → Messaging webhook:
 *        https://bdrclaw.dev/webhooks/sms
 *        (or your Railway URL while in dev)
 *   4. Set SMS_ENABLED=true
 *
 * JID format:  sms:+<e164>   e.g. sms:+15551234567
 * Owns JIDs that start with "sms:"
 *
 * Self-registers when SMS_ENABLED=true and TWILIO_PHONE_NUMBER is set.
 *
 * NOTE: Twilio account SID + auth token are shared with the WhatsApp channel.
 * Only one set of credentials is needed in .env.
 */

import twilio from 'twilio';

import { logger } from '../logger.js';
import { validateTwilioRequest } from '../twilio-signature.js';
import { registerWebhook } from '../webhook-registry.js';
import type {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { assertNotSuppressed, assertSmsTcpaCap } from './compliance.js';
import { registerChannel } from './registry.js';

const DAILY_MSG_LIMIT = parseInt(process.env.SMS_DAILY_MSG_LIMIT ?? '100', 10);

// ── SMS Channel ───────────────────────────────────────────────────────────────

export class SMSChannel implements Channel {
  name = 'sms';
  private connected = false;
  private msgsSentToday = 0;
  private lastResetDate = '';
  private client: twilio.Twilio;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string, // e.g. "+15017122661"
    private onMessage: OnInboundMessage,
    private onChatMetadata: OnChatMetadata,
  ) {
    this.client = twilio(accountSid, authToken);
  }

  async connect(): Promise<void> {
    try {
      const account = await this.client.api.accounts(this.accountSid).fetch();
      this.connected = true;
      logger.info(
        { accountName: account.friendlyName },
        'SMS (Twilio) channel connected',
      );
      this.registerInboundWebhook();
    } catch (err) {
      logger.error(
        { err },
        'SMS channel connect failed — check Twilio credentials',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) throw new Error('SMS channel not connected');
    this.resetDailyCountsIfNeeded();

    if (this.msgsSentToday >= DAILY_MSG_LIMIT) {
      throw new Error(`SMS daily message limit reached (${DAILY_MSG_LIMIT})`);
    }

    const to = jidToE164(jid);

    // Compliance backstop — enforced here so NO entry point can bypass it:
    //   1. Global suppression list (opted-out contacts never receive SMS).
    //   2. TCPA: max 2 unsolicited outbound SMS per prospect; a prospect who
    //      has replied on SMS is solicited and may be messaged further.
    // Both throw; the send is never silently dropped.
    assertNotSuppressed('sms', to);
    assertSmsTcpaCap(to);

    // Hard limit: SMS messages should be under 160 chars for single-part delivery.
    // Twilio handles concatenation for longer messages automatically.
    await this.client.messages.create({
      from: this.fromNumber,
      to,
      body: text,
    });

    this.msgsSentToday++;
    logger.info({ jid, msgsSentToday: this.msgsSentToday }, 'SMS sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sms:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('SMS channel disconnected');
  }

  // ── Inbound webhook ───────────────────────────────────────────────────────

  private registerInboundWebhook(): void {
    registerWebhook('/webhooks/sms', (req, res, body) => {
      // URLSearchParams decodes '+'→space and handles '=' inside values, so the
      // params match exactly what Twilio signed (correct signature validation).
      const params = Object.fromEntries(new URLSearchParams(body));

      // Reject forged/replayed requests before doing any work (403).
      if (!validateTwilioRequest(req, '/webhooks/sms', params)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      const from = params['From'] ?? ''; // "+15551234567"
      const msgBody = params['Body'] ?? '';
      const msgSid = params['MessageSid'] ?? `sms-${Date.now()}`;

      if (!from || !msgBody) {
        res.writeHead(204);
        res.end();
        return;
      }

      const jid = e164ToJid(from);
      const msg: NewMessage = {
        id: msgSid,
        chat_jid: jid,
        sender: jid,
        sender_name: from,
        content: msgBody,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      };

      this.onMessage(jid, msg);
      this.onChatMetadata(jid, msg.timestamp, from, 'sms', false);

      // Twilio expects 200 + TwiML to acknowledge (empty = no auto-reply)
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });

    logger.info('SMS inbound webhook registered at /webhooks/sms');
  }

  private resetDailyCountsIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.msgsSentToday = 0;
      this.lastResetDate = today;
    }
  }
}

// ── JID helpers ───────────────────────────────────────────────────────────────

export function e164ToJid(phone: string): string {
  const normalized = phone.startsWith('+') ? phone : `+${phone}`;
  return `sms:${normalized}`;
}

export function jidToE164(jid: string): string {
  return jid.replace(/^sms:/, '');
}

// ── Self-registration ─────────────────────────────────────────────────────────

registerChannel('sms', (opts) => {
  if (process.env.SMS_ENABLED !== 'true') return null;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !from) {
    logger.warn(
      'SMS channel: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER required',
    );
    return null;
  }

  return new SMSChannel(sid, token, from, opts.onMessage, opts.onChatMetadata);
});
