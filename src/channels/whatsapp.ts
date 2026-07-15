/**
 * WhatsApp channel — Twilio WhatsApp API.
 *
 * Outbound: Twilio Messages API (From: whatsapp:+1…, To: whatsapp:+1…)
 * Inbound:  Twilio webhook → POST /webhooks/whatsapp on this server
 *
 * Setup:
 *   1. twilio.com → Messaging → Try it out → Send a WhatsApp message
 *      (sandbox) OR buy a WhatsApp-enabled number for production
 *   2. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER in .env
 *   3. In Twilio Console → WhatsApp Sandbox → Webhook URL:
 *        https://bdrclaw.dev/webhooks/whatsapp
 *        (or your Railway URL while in dev: https://<your-app>.up.railway.app/webhooks/whatsapp)
 *
 * JID format:  whatsapp:+<e164>   e.g. whatsapp:+15551234567
 * Owns JIDs that start with "whatsapp:"
 *
 * Self-registers when TWILIO_WHATSAPP_NUMBER is set.
 */

import twilio from 'twilio';

import { logger } from '../logger.js';
import { registerWebhook } from '../webhook-registry.js';
import type {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { assertNotSuppressed, assertWarmProspect } from './compliance.js';
import { registerChannel } from './registry.js';

const DAILY_MSG_LIMIT = parseInt(
  process.env.WHATSAPP_DAILY_MSG_LIMIT ?? '100',
  10,
);

// ── WhatsApp Channel ──────────────────────────────────────────────────────────

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';
  private connected = false;
  private msgsSentToday = 0;
  private lastResetDate = '';
  private client: twilio.Twilio;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string, // e.g. "whatsapp:+14155238886"
    private onMessage: OnInboundMessage,
    private onChatMetadata: OnChatMetadata,
  ) {
    this.client = twilio(accountSid, authToken);
  }

  async connect(): Promise<void> {
    try {
      // Verify credentials by fetching account info
      const account = await this.client.api.accounts(this.accountSid).fetch();
      this.connected = true;
      logger.info(
        { accountName: account.friendlyName },
        'WhatsApp (Twilio) channel connected',
      );
      this.registerInboundWebhook();
    } catch (err) {
      logger.error(
        { err },
        'WhatsApp channel connect failed — check Twilio credentials',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) throw new Error('WhatsApp channel not connected');
    this.resetDailyCountsIfNeeded();

    if (this.msgsSentToday >= DAILY_MSG_LIMIT) {
      throw new Error(
        `WhatsApp daily message limit reached (${DAILY_MSG_LIMIT})`,
      );
    }

    const to = jidToE164WhatsApp(jid);

    // Compliance backstop — enforced here so NO entry point can bypass it:
    //   1. Global suppression list.
    //   2. WARM-ONLY: WhatsApp is never a cold channel (Meta paused US
    //      marketing templates; unsolicited business messaging risks the
    //      number). A known prospect must have messaged us inbound on
    //      WhatsApp at least once before any outbound is allowed.
    // Both throw; the send is never silently dropped.
    const bareNumber = to.replace(/^whatsapp:/, '');
    assertNotSuppressed('whatsapp', bareNumber);
    assertWarmProspect(
      'whatsapp',
      bareNumber,
      'WhatsApp is warm/reply-only — the prospect must message us first.',
    );

    await this.client.messages.create({
      from: this.fromNumber,
      to,
      body: text,
    });

    this.msgsSentToday++;
    logger.info(
      { jid, msgsSentToday: this.msgsSentToday },
      'WhatsApp message sent',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('whatsapp:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('WhatsApp channel disconnected');
  }

  // ── Inbound webhook ───────────────────────────────────────────────────────

  private registerInboundWebhook(): void {
    registerWebhook('/webhooks/whatsapp', (req, res, body) => {
      // Parse Twilio's URL-encoded form body
      const params = Object.fromEntries(
        body.split('&').map((pair) => {
          const [k, v] = pair
            .split('=')
            .map((s) => decodeURIComponent(s.replace(/\+/g, ' ')));
          return [k, v];
        }),
      );

      const from = params['From'] ?? ''; // "whatsapp:+15551234567"
      const msgBody = params['Body'] ?? '';
      const msgSid = params['MessageSid'] ?? `wa-${Date.now()}`;

      if (!from.startsWith('whatsapp:') || !msgBody) {
        res.writeHead(204);
        res.end();
        return;
      }

      const jid = e164WhatsAppToJid(from);
      const msg: NewMessage = {
        id: msgSid,
        chat_jid: jid,
        sender: jid,
        sender_name: from.replace('whatsapp:', ''),
        content: msgBody,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      };

      this.onMessage(jid, msg);
      this.onChatMetadata(
        jid,
        msg.timestamp,
        msg.sender_name,
        'whatsapp',
        false,
      );

      // Twilio expects a 200 + empty TwiML or body to acknowledge
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });

    logger.info('WhatsApp inbound webhook registered at /webhooks/whatsapp');
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

export function e164WhatsAppToJid(twilioFrom: string): string {
  // Twilio sends "whatsapp:+15551234567" — normalize to our JID
  const normalized = twilioFrom.startsWith('whatsapp:')
    ? twilioFrom
    : `whatsapp:${twilioFrom}`;
  return normalized;
}

export function jidToE164WhatsApp(jid: string): string {
  // Our JID is "whatsapp:+15551234567" — Twilio wants "whatsapp:+15551234567"
  return jid.startsWith('whatsapp:') ? jid : `whatsapp:${jid}`;
}

// ── Self-registration ─────────────────────────────────────────────────────────

registerChannel('whatsapp', (opts) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_NUMBER;

  if (!sid || !token || !from) return null;

  const fromFormatted = from.startsWith('whatsapp:')
    ? from
    : `whatsapp:${from}`;
  return new WhatsAppChannel(
    sid,
    token,
    fromFormatted,
    opts.onMessage,
    opts.onChatMetadata,
  );
});
