/**
 * Twitter / X DM channel — sends and polls direct messages via Twitter API v2.
 *
 * Prerequisites:
 *   1. Twitter Developer account (Basic tier, $100/mo, required for DM API)
 *   2. App with OAuth 1.0a User Auth enabled (read + write + DM permissions)
 *   3. Run: npm run twitter-auth  to generate access token / secret for an account
 *
 * JID format:  twitter:<userId>   e.g. twitter:123456789
 * Owns JIDs that start with "twitter:"
 *
 * Self-registers when TWITTER_ENABLED=true and all 4 API keys are set.
 */

import { TwitterApi, type TwitterApiReadWrite } from 'twitter-api-v2';

import { logger } from '../logger.js';
import type {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { registerChannel } from './registry.js';

const REPLY_POLL_MS = 5 * 60 * 1000; // 5 minutes
const DAILY_DM_LIMIT = parseInt(
  process.env.TWITTER_DAILY_DM_LIMIT ?? '100',
  10,
);

// ── Twitter Channel ───────────────────────────────────────────────────────────

export class TwitterChannel implements Channel {
  name = 'twitter';
  private client: TwitterApiReadWrite;
  private connected = false;
  private dmsSentToday = 0;
  private lastResetDate = '';
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastEventId: string | null = null;

  constructor(
    private onMessage: OnInboundMessage,
    private onChatMetadata: OnChatMetadata,
  ) {
    this.client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY!,
      appSecret: process.env.TWITTER_API_SECRET!,
      accessToken: process.env.TWITTER_ACCESS_TOKEN!,
      accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET!,
    }).readWrite;
  }

  async connect(): Promise<void> {
    try {
      const me = await this.client.v2.me();
      this.connected = true;
      logger.info(
        { userId: me.data.id, username: me.data.username },
        'Twitter channel connected',
      );
      this.startReplyPolling();
    } catch (err) {
      logger.error(
        { err },
        'Twitter channel connect failed — check API keys and permissions',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) throw new Error('Twitter channel not connected');
    this.resetDailyCountsIfNeeded();

    if (this.dmsSentToday >= DAILY_DM_LIMIT) {
      throw new Error(`Twitter daily DM limit reached (${DAILY_DM_LIMIT})`);
    }

    const recipientId = jidToUserId(jid);

    // Create a new DM conversation (or continue existing one)
    await this.client.v2.sendDmToParticipant(recipientId, { text });

    this.dmsSentToday++;
    logger.info(
      { jid, recipientId, dmsSentToday: this.dmsSentToday },
      'Twitter DM sent',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('twitter:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.connected = false;
    logger.info('Twitter channel disconnected');
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private startReplyPolling(): void {
    this.pollTimer = setInterval(() => {
      this.pollInbox().catch((err) =>
        logger.error({ err }, 'Twitter DM poll failed'),
      );
    }, REPLY_POLL_MS);
  }

  private async pollInbox(): Promise<void> {
    if (!this.connected) return;
    try {
      const me = await this.client.v2.me();
      const myId = me.data.id;

      // listDmEvents returns a paginator — fetch first page only
      const paginator = await this.client.v2.listDmEvents({
        'dm_event.fields': [
          'id',
          'text',
          'created_at',
          'sender_id',
          'dm_conversation_id',
        ],
        event_types: 'MessageCreate',
        max_results: 50,
      } as Parameters<typeof this.client.v2.listDmEvents>[0]);

      const page = paginator.data;
      if (!page || !Array.isArray(page.data) || page.data.length === 0) return;

      // Track latest event ID for next poll to avoid reprocessing
      if (this.lastEventId === page.data[0].id) return;
      this.lastEventId = page.data[0].id;

      for (const event of page.data) {
        // Only process message events (discriminated union — text only exists on MessageCreate)
        if (event.event_type !== 'MessageCreate') continue;
        if (!event.sender_id || event.sender_id === myId) continue;

        const jid = userIdToJid(event.sender_id);
        const msg: NewMessage = {
          id: event.id,
          chat_jid: jid,
          sender: jid,
          sender_name: event.sender_id,
          content: event.text,
          timestamp: event.created_at ?? new Date().toISOString(),
          is_from_me: false,
        };
        this.onMessage(jid, msg);
      }
    } catch (err) {
      logger.warn({ err }, 'Twitter inbox poll error');
    }
  }

  private resetDailyCountsIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dmsSentToday = 0;
      this.lastResetDate = today;
    }
  }
}

// ── JID helpers ───────────────────────────────────────────────────────────────

export function userIdToJid(userId: string): string {
  return `twitter:${userId}`;
}

export function jidToUserId(jid: string): string {
  return jid.replace(/^twitter:/, '');
}

// ── Self-registration ─────────────────────────────────────────────────────────

registerChannel('twitter', (opts) => {
  if (process.env.TWITTER_ENABLED !== 'true') return null;

  const required = [
    'TWITTER_API_KEY',
    'TWITTER_API_SECRET',
    'TWITTER_ACCESS_TOKEN',
    'TWITTER_ACCESS_TOKEN_SECRET',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    logger.warn({ missing }, 'Twitter channel disabled — missing env vars');
    return null;
  }

  return new TwitterChannel(opts.onMessage, opts.onChatMetadata);
});
