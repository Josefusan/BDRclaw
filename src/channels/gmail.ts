/**
 * Gmail channel — handles inbound reply polling and outbound email sending.
 *
 * Self-registers via registerChannel() if GMAIL_ACCOUNT_* env vars are present.
 * For BDR sequences, use sendBDREmail() directly (not sendMessage).
 * For inbound replies, the channel polls every 5 minutes and surfaces
 * new prospect replies via the standard onMessage callback.
 */

import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';

import {
  credentialsKeyToIndex,
  getActiveAccountIndices,
  getAuthenticatedClient,
} from '../gmail-auth.js';
import { logger } from '../logger.js';
import type {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';

const REPLY_POLL_MS = 5 * 60 * 1000; // 5 minutes

export interface GmailSendOptions {
  to: string;
  subject: string;
  body: string;
  /** Which GMAIL_ACCOUNT_* to send from (defaults to first active) */
  accountIndex?: number;
  /** Thread ID for reply threading */
  threadId?: string;
  /** Message-ID header of the email to reply to */
  inReplyTo?: string;
}

export interface GmailSendResult {
  messageId: string;
  threadId: string;
}

export class GmailChannel implements Channel {
  name = 'gmail';
  private connected = false;
  private activeIndices: number[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastCheckAt: Record<number, number> = {};

  constructor(
    private onMessage: OnInboundMessage,
    private onChatMetadata: OnChatMetadata,
  ) {}

  async connect(): Promise<void> {
    this.activeIndices = getActiveAccountIndices();
    if (this.activeIndices.length === 0) {
      logger.warn(
        'Gmail: GMAIL_ACCOUNT_* is set but no OAuth tokens found. ' +
          'Run: npm run gmail-auth',
      );
      // Still mark connected so BDR can queue emails (they'll fail with a clear message)
      this.connected = true;
      return;
    }

    this.connected = true;
    // Start 24h ago so we don't miss recent replies on first boot
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const idx of this.activeIndices) this.lastCheckAt[idx] = dayAgo;

    logger.info({ accounts: this.activeIndices }, 'Gmail channel connected');

    // Poll once immediately, then on interval
    this.pollReplies().catch(() => {});
    this.pollTimer = setInterval(() => {
      this.pollReplies().catch((err) =>
        logger.error({ err }, 'Gmail reply poll failed'),
      );
    }, REPLY_POLL_MS);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Gmail owns all "email:*" JIDs */
  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  /** Generic Channel interface — sends a plain text email with no threading */
  async sendMessage(jid: string, text: string): Promise<void> {
    const to = jid.replace(/^email:/, '');
    await this.sendBDREmail({ to, subject: 'Re:', body: text });
  }

  // ── BDR-specific send ─────────────────────────────────────────────────────

  async sendBDREmail(opts: GmailSendOptions): Promise<GmailSendResult> {
    const idx =
      opts.accountIndex ?? this.activeIndices[0] ?? this.getFallbackIndex();
    if (!idx) throw new Error('No Gmail account configured');

    const fromEmail = process.env[`GMAIL_ACCOUNT_${idx}`];
    if (!fromEmail) throw new Error(`GMAIL_ACCOUNT_${idx} not set in .env`);

    const auth = getAuthenticatedClient(idx);
    const gmail = google.gmail({ version: 'v1', auth });

    const mime = buildMime({
      from: fromEmail,
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      inReplyTo: opts.inReplyTo,
    });

    const params: gmail_v1.Params$Resource$Users$Messages$Send = {
      userId: 'me',
      requestBody: {
        raw: Buffer.from(mime).toString('base64url'),
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
      },
    };

    const res = await gmail.users.messages.send(params);
    const messageId = res.data.id!;
    const threadId = res.data.threadId!;

    logger.info({ to: opts.to, messageId, accountIndex: idx }, 'Email sent');
    return { messageId, threadId };
  }

  /**
   * Build a sendBDREmail options object from a BDR account's credentials_key.
   * Convenience helper for action handlers.
   */
  accountIndexFromKey(credentialsKey: string | undefined): number {
    if (!credentialsKey) return this.activeIndices[0] ?? 1;
    return credentialsKeyToIndex(credentialsKey);
  }

  // ── Reply polling ─────────────────────────────────────────────────────────

  private async pollReplies(): Promise<void> {
    for (const idx of this.activeIndices) {
      await this.pollAccountReplies(idx).catch((err) =>
        logger.warn({ accountIndex: idx, err }, 'Gmail poll error for account'),
      );
    }
  }

  private async pollAccountReplies(accountIndex: number): Promise<void> {
    const auth = getAuthenticatedClient(accountIndex);
    const gmail = google.gmail({ version: 'v1', auth });

    const sinceEpoch = Math.floor((this.lastCheckAt[accountIndex] ?? 0) / 1000);
    const query = `is:unread category:primary after:${sinceEpoch}`;

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 20,
    });

    const messages = listRes.data.messages ?? [];
    if (messages.length === 0) return;

    this.lastCheckAt[accountIndex] = Date.now();

    for (const stub of messages) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: stub.id!,
        format: 'full',
      });

      const parsed = parseMail(detail.data);
      if (!parsed) continue;

      // Mark as read so we don't surface it again
      gmail.users.messages
        .modify({
          userId: 'me',
          id: stub.id!,
          requestBody: { removeLabelIds: ['UNREAD'] },
        })
        .catch(() => {});

      const jid = `email:${parsed.from}`;
      this.onChatMetadata(jid, parsed.date, parsed.fromName, 'gmail', false);
      this.onMessage(jid, {
        id: stub.id!,
        chat_jid: jid,
        sender: parsed.from,
        sender_name: parsed.fromName,
        content:
          `[Email reply from ${parsed.fromName || parsed.from}]\n` +
          `Subject: ${parsed.subject}\n\n${parsed.body}`,
        timestamp: parsed.date,
        is_from_me: false,
      } satisfies NewMessage);
    }
  }

  private getFallbackIndex(): number {
    for (let i = 1; i <= 3; i++) {
      if (process.env[`GMAIL_ACCOUNT_${i}`]) return i;
    }
    return 1;
  }
}

// ── MIME builder ──────────────────────────────────────────────────────────────

function buildMime(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}): string {
  const boundary = `bdrclaw_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const lines: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (opts.inReplyTo) {
    lines.push(`In-Reply-To: ${opts.inReplyTo}`);
    lines.push(`References: ${opts.inReplyTo}`);
  }
  lines.push(
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    opts.body,
    '',
    `--${boundary}--`,
  );
  return lines.join('\r\n');
}

// ── MIME parser ───────────────────────────────────────────────────────────────

function parseMail(msg: gmail_v1.Schema$Message): {
  from: string;
  fromName: string;
  subject: string;
  body: string;
  date: string;
  threadId: string;
} | null {
  const hdrs = msg.payload?.headers ?? [];
  const hdr = (name: string) =>
    hdrs.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const rawFrom = hdr('From');
  const fromMatch = rawFrom.match(/^(?:"?([^"<]*)"?\s*)?<?([^>@]+@[^>]+)>?$/);
  const from = fromMatch?.[2]?.trim() ?? rawFrom;
  if (!from.includes('@')) return null;
  const fromName = fromMatch?.[1]?.trim() || from;

  const subject = hdr('Subject') || '(no subject)';
  const rawDate = hdr('Date');
  const date = rawDate ? new Date(rawDate).toISOString() : new Date().toISOString();
  const body = extractPlainText(msg.payload);

  return { from, fromName, subject, body, date, threadId: msg.threadId ?? '' };
}

function extractPlainText(
  part: gmail_v1.Schema$MessagePart | undefined,
): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64').toString('utf-8');
  }
  if (part.parts) {
    const plain = part.parts.find((p) => p.mimeType === 'text/plain');
    if (plain?.body?.data)
      return Buffer.from(plain.body.data, 'base64').toString('utf-8');
    for (const sub of part.parts) {
      const text = extractPlainText(sub);
      if (text) return text;
    }
  }
  return '';
}

// ── Self-registration ─────────────────────────────────────────────────────────

let _instance: GmailChannel | null = null;

export function getGmailChannel(): GmailChannel | null {
  return _instance;
}

registerChannel('gmail', (opts: ChannelOpts) => {
  const hasConfig = !!(
    process.env.GMAIL_ACCOUNT_1 ||
    process.env.GMAIL_ACCOUNT_2 ||
    process.env.GMAIL_ACCOUNT_3
  );
  if (!hasConfig) return null;

  _instance = new GmailChannel(opts.onMessage, opts.onChatMetadata);
  return _instance;
});
