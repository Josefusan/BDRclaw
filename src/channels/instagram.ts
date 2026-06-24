/**
 * Instagram DM channel — warm-lead follow-up via Instagram Graph API.
 *
 * ─── IMPORTANT CONSTRAINT ────────────────────────────────────────────────────
 * Instagram's official Messaging API (via Meta for Developers) only allows you
 * to reply to users who message YOUR business account first. Cold outreach to
 * arbitrary Instagram users is against Meta's Platform Policies and will result
 * in your app being suspended.
 *
 * This channel is for WARM LEADS:
 *   • Prospect DMs your business Instagram account
 *   • BDRclaw receives the message, creates a prospect record, routes to BDR brain
 *   • Brain decides how to respond (qualify, book meeting, etc.)
 *
 * Setup:
 *   1. Meta Business Suite → Meta for Developers → Create App (Business type)
 *   2. Add Instagram Graph API product
 *   3. Generate a long-lived user access token with instagram_manage_messages scope
 *   4. Run: npm run instagram-auth  (guides you through the flow)
 *
 * JID format:  instagram:<igScopeUserId>
 * Owns JIDs that start with "instagram:"
 *
 * Self-registers when INSTAGRAM_ENABLED=true.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import https from 'https';

import { logger } from '../logger.js';
import type { Channel, NewMessage, OnChatMetadata, OnInboundMessage } from '../types.js';
import { registerChannel } from './registry.js';

const GRAPH_API = 'https://graph.instagram.com/v20.0';
const REPLY_POLL_MS = 5 * 60 * 1000; // 5 minutes
const DAILY_DM_LIMIT = parseInt(process.env.INSTAGRAM_DAILY_DM_LIMIT ?? '50', 10);

// ── Instagram Channel ─────────────────────────────────────────────────────────

export class InstagramChannel implements Channel {
  name = 'instagram';
  private connected = false;
  private dmsSentToday = 0;
  private lastResetDate = '';
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastCursor: string | null = null;

  constructor(
    private readonly accessToken: string,
    private readonly accountId: string,
    private onMessage: OnInboundMessage,
    private onChatMetadata: OnChatMetadata,
  ) {}

  async connect(): Promise<void> {
    try {
      // Verify token is valid by fetching own account info
      const me = await this.graphGet<{ id: string; name: string }>(
        `/${this.accountId}?fields=id,name`,
      );
      this.connected = true;
      logger.info({ accountId: me.id, name: me.name }, 'Instagram channel connected');
      this.startReplyPolling();
    } catch (err) {
      logger.error({ err }, 'Instagram channel connect failed — check access token');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) throw new Error('Instagram channel not connected');
    this.resetDailyCountsIfNeeded();

    if (this.dmsSentToday >= DAILY_DM_LIMIT) {
      throw new Error(`Instagram daily DM limit reached (${DAILY_DM_LIMIT})`);
    }

    const recipientId = jidToIgUserId(jid);

    await this.graphPost(`/${this.accountId}/messages`, {
      recipient: { id: recipientId },
      message: { text },
    });

    this.dmsSentToday++;
    logger.info({ jid, dmsSentToday: this.dmsSentToday }, 'Instagram DM sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('instagram:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.connected = false;
    logger.info('Instagram channel disconnected');
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private startReplyPolling(): void {
    this.pollTimer = setInterval(() => {
      this.pollInbox().catch((err) =>
        logger.error({ err }, 'Instagram inbox poll failed'),
      );
    }, REPLY_POLL_MS);
  }

  private async pollInbox(): Promise<void> {
    if (!this.connected) return;
    try {
      // Fetch conversations with new messages
      let url = `/${this.accountId}/conversations?fields=messages{id,from,to,message,created_time}&platform=instagram`;
      if (this.lastCursor) url += `&after=${this.lastCursor}`;

      const resp = await this.graphGet<{
        data: Array<{
          messages: {
            data: Array<{
              id: string;
              from: { id: string; username: string };
              to: { data: Array<{ id: string }> };
              message: string;
              created_time: string;
            }>;
          };
        }>;
        paging?: { cursors?: { after?: string } };
      }>(url);

      if (resp.paging?.cursors?.after) {
        this.lastCursor = resp.paging.cursors.after;
      }

      for (const conversation of resp.data ?? []) {
        for (const msg of conversation.messages?.data ?? []) {
          // Skip messages sent by the business account
          const sentByUs = msg.to.data.some((t) => t.id !== this.accountId);
          if (!sentByUs && msg.from.id === this.accountId) continue;

          const jid = igUserIdToJid(msg.from.id);
          const inbound: NewMessage = {
            id: msg.id,
            chat_jid: jid,
            sender: jid,
            sender_name: msg.from.username ?? msg.from.id,
            content: msg.message,
            timestamp: msg.created_time,
            is_from_me: false,
          };
          this.onMessage(jid, inbound);
          this.onChatMetadata(jid, msg.created_time, msg.from.username, 'instagram', false);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Instagram inbox poll error');
    }
  }

  private resetDailyCountsIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dmsSentToday = 0;
      this.lastResetDate = today;
    }
  }

  // ── Graph API helpers ──────────────────────────────────────────────────────

  private graphGet<T>(endpoint: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const sep = endpoint.includes('?') ? '&' : '?';
      const url = `${GRAPH_API}${endpoint}${sep}access_token=${this.accessToken}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed as T);
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  private graphPost<T>(endpoint: string, body: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const url = new URL(`${GRAPH_API}${endpoint}?access_token=${this.accessToken}`);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed as T);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

// ── JID helpers ───────────────────────────────────────────────────────────────

export function igUserIdToJid(igScopeUserId: string): string {
  return `instagram:${igScopeUserId}`;
}

export function jidToIgUserId(jid: string): string {
  return jid.replace(/^instagram:/, '');
}

// ── Self-registration ─────────────────────────────────────────────────────────

registerChannel('instagram', (opts) => {
  if (process.env.INSTAGRAM_ENABLED !== 'true') return null;

  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID;
  if (!token || !accountId) {
    logger.warn('Instagram channel disabled — INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID required');
    return null;
  }

  return new InstagramChannel(token, accountId, opts.onMessage, opts.onChatMetadata);
});
