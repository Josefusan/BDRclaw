/**
 * Telegram channel — long-polling bot.
 *
 * Setup:
 *   1. Message @BotFather on Telegram → /newbot → copy the token
 *   2. Set TELEGRAM_BOT_TOKEN in .env
 *   3. Set TELEGRAM_ADMIN_CHAT_ID (your personal Telegram chat ID)
 *      — send any message to the bot, then call:
 *        curl https://api.telegram.org/bot<TOKEN>/getUpdates
 *        and find your chat id in the response
 *
 * JID format:  telegram:<chatId>   e.g. telegram:123456789
 * Owns JIDs that start with "telegram:"
 *
 * Self-registers when TELEGRAM_BOT_TOKEN is set.
 */

import https from 'https';

import { logger } from '../logger.js';
import type {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { registerChannel } from './registry.js';

const POLL_TIMEOUT_SECONDS = 30; // long-poll window per request
const DAILY_MSG_LIMIT = parseInt(
  process.env.TELEGRAM_DAILY_MSG_LIMIT ?? '200',
  10,
);

// ── Telegram Bot API helpers ──────────────────────────────────────────────────

function apiCall<T>(token: string, method: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: payload ? 'POST' : 'GET',
      headers: payload
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }
        : undefined,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok)
            reject(new Error(parsed.description ?? 'Telegram API error'));
          else resolve(parsed.result as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      type: string;
    };
    from?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    text?: string;
    date: number;
  };
}

// ── Telegram Channel ──────────────────────────────────────────────────────────

export class TelegramChannel implements Channel {
  name = 'telegram';
  private connected = false;
  private running = false;
  private offset = 0;
  private msgsSentToday = 0;
  private lastResetDate = '';

  constructor(
    private readonly token: string,
    private onMessage: OnInboundMessage,
    private onChatMetadata: OnChatMetadata,
  ) {}

  async connect(): Promise<void> {
    try {
      const me = await apiCall<{ id: number; username: string }>(
        this.token,
        'getMe',
      );
      this.connected = true;
      this.running = true;
      logger.info({ username: me.username }, 'Telegram channel connected');
      this.pollLoop();
    } catch (err) {
      logger.error(
        { err },
        'Telegram channel connect failed — check TELEGRAM_BOT_TOKEN',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) throw new Error('Telegram channel not connected');
    this.resetDailyCountsIfNeeded();

    if (this.msgsSentToday >= DAILY_MSG_LIMIT) {
      throw new Error(
        `Telegram daily message limit reached (${DAILY_MSG_LIMIT})`,
      );
    }

    const chatId = jidToChatId(jid);
    await apiCall(this.token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    });

    this.msgsSentToday++;
    logger.info(
      { jid, msgsSentToday: this.msgsSentToday },
      'Telegram message sent',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('telegram:');
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.connected = false;
    logger.info('Telegram channel disconnected');
  }

  // ── Long polling ──────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await apiCall<TgUpdate[]>(this.token, 'getUpdates', {
          offset: this.offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message'],
        });

        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (!update.message?.text) continue;

          const chat = update.message.chat;
          const from = update.message.from;
          const jid = chatIdToJid(chat.id);
          const senderName =
            [from?.first_name, from?.last_name].filter(Boolean).join(' ') ||
            from?.username ||
            String(from?.id ?? chat.id);

          const msg: NewMessage = {
            id: `tg-${update.update_id}`,
            chat_jid: jid,
            sender: jid,
            sender_name: senderName,
            content: update.message.text,
            timestamp: new Date(update.message.date * 1000).toISOString(),
            is_from_me: false,
          };

          this.onMessage(jid, msg);
          this.onChatMetadata(
            jid,
            msg.timestamp,
            senderName,
            'telegram',
            false,
          );
        }
      } catch (err) {
        if (this.running) {
          logger.warn({ err }, 'Telegram poll error — retrying in 5s');
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
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

export function chatIdToJid(chatId: number): string {
  return `telegram:${chatId}`;
}

export function jidToChatId(jid: string): number {
  return parseInt(jid.replace(/^telegram:/, ''), 10);
}

// ── Self-registration ─────────────────────────────────────────────────────────

registerChannel('telegram', (opts) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return new TelegramChannel(token, opts.onMessage, opts.onChatMetadata);
});
