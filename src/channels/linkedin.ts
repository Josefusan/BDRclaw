/**
 * LinkedIn DM channel — browser-automation-based outreach and reply polling.
 *
 * Uses Playwright (headless Chromium) with saved session cookies so you only
 * log in once via: npm run linkedin-auth
 *
 * JID format:  linkedin:<profileUrl>   e.g. linkedin:https://linkedin.com/in/jane-smith
 * Owns JIDs that start with "linkedin:"
 *
 * Daily limits (configurable via env):
 *   LINKEDIN_DAILY_CONNECTION_LIMIT  (default 20)
 *   LINKEDIN_DAILY_DM_LIMIT          (default 50)
 *
 * Self-registers when LINKEDIN_ENABLED=true.
 */

import fs from 'fs';
import path from 'path';

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import type {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { registerChannel } from './registry.js';

const SESSION_FILE = path.join(STORE_DIR, 'linkedin-session.json');
const REPLY_POLL_MS = 10 * 60 * 1000; // 10 minutes

const DAILY_DM_LIMIT = parseInt(
  process.env.LINKEDIN_DAILY_DM_LIMIT ?? '50',
  10,
);
const DAILY_CONN_LIMIT = parseInt(
  process.env.LINKEDIN_DAILY_CONNECTION_LIMIT ?? '20',
  10,
);

// ── LinkedIn Channel ──────────────────────────────────────────────────────────

export class LinkedInChannel implements Channel {
  name = 'linkedin';
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private connected = false;
  private dmsSentToday = 0;
  private connectionsSentToday = 0;
  private lastResetDate = '';
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    private onMessage: OnInboundMessage,
    private onChatMetadata: OnChatMetadata,
  ) {}

  async connect(): Promise<void> {
    if (!fs.existsSync(SESSION_FILE)) {
      logger.warn(
        'LinkedIn session file not found. Run: npm run linkedin-auth',
      );
      return;
    }

    try {
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({
        storageState: SESSION_FILE,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      const valid = await this.validateSession();
      if (!valid) {
        logger.warn('LinkedIn session expired. Run: npm run linkedin-auth');
        await this.cleanup();
        return;
      }

      this.connected = true;
      logger.info('LinkedIn channel connected');
      this.startReplyPolling();
    } catch (err) {
      logger.error({ err }, 'LinkedIn channel connect failed');
      await this.cleanup();
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected || !this.context) {
      throw new Error('LinkedIn channel not connected');
    }
    this.resetDailyCountsIfNeeded();

    if (this.dmsSentToday >= DAILY_DM_LIMIT) {
      throw new Error(`LinkedIn daily DM limit reached (${DAILY_DM_LIMIT})`);
    }

    const profileUrl = jidToProfileUrl(jid);
    const page = await this.context.newPage();
    try {
      await sendLinkedInDM(page, profileUrl, text);
      this.dmsSentToday++;
      logger.info({ jid, dmsSentToday: this.dmsSentToday }, 'LinkedIn DM sent');
    } finally {
      await page.close();
    }
  }

  async sendConnectionRequest(
    profileUrl: string,
    note?: string,
  ): Promise<void> {
    if (!this.connected || !this.context) {
      throw new Error('LinkedIn channel not connected');
    }
    this.resetDailyCountsIfNeeded();

    if (this.connectionsSentToday >= DAILY_CONN_LIMIT) {
      throw new Error(
        `LinkedIn daily connection limit reached (${DAILY_CONN_LIMIT})`,
      );
    }

    const page = await this.context.newPage();
    try {
      await sendConnectionRequest(page, profileUrl, note);
      this.connectionsSentToday++;
      logger.info(
        { profileUrl, connectionsSentToday: this.connectionsSentToday },
        'LinkedIn connection request sent',
      );
    } finally {
      await page.close();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('linkedin:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.cleanup();
    this.connected = false;
    logger.info('LinkedIn channel disconnected');
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async validateSession(): Promise<boolean> {
    if (!this.context) return false;
    const page = await this.context.newPage();
    try {
      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      const url = page.url();
      return !url.includes('/login') && !url.includes('/uas/login');
    } catch {
      return false;
    } finally {
      await page.close();
    }
  }

  private startReplyPolling(): void {
    this.pollTimer = setInterval(() => {
      this.pollReplies().catch((err) =>
        logger.error({ err }, 'LinkedIn reply poll failed'),
      );
    }, REPLY_POLL_MS);
  }

  private async pollReplies(): Promise<void> {
    if (!this.connected || !this.context) return;
    const page = await this.context.newPage();
    try {
      await page.goto('https://www.linkedin.com/messaging/', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await page.waitForTimeout(2000);

      // Find unread conversation threads
      const threads = await page
        .locator('.msg-conversation-listitem__link')
        .all();
      for (const thread of threads.slice(0, 10)) {
        const hasUnread = await thread
          .locator('.msg-conversation-listitem__unread-count')
          .count();
        if (!hasUnread) continue;

        await thread.click();
        await page.waitForTimeout(1000);

        // Get the profile link and latest message
        const profileLink = await page
          .locator('.msg-thread__link-to-profile')
          .getAttribute('href')
          .catch(() => null);
        const lastMessage = await page
          .locator('.msg-s-message-list__event')
          .last()
          .locator('.msg-s-event-listitem__body')
          .textContent()
          .catch(() => null);

        if (!profileLink || !lastMessage) continue;

        const jid = profileUrlToJid(profileLink);
        const msg: NewMessage = {
          id: `linkedin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          chat_jid: jid,
          sender: jid,
          sender_name: '',
          content: lastMessage.trim(),
          timestamp: new Date().toISOString(),
          is_from_me: false,
        };
        this.onMessage(jid, msg);
      }
    } catch (err) {
      logger.warn({ err }, 'LinkedIn reply poll error');
    } finally {
      await page.close();
    }
  }

  private resetDailyCountsIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dmsSentToday = 0;
      this.connectionsSentToday = 0;
      this.lastResetDate = today;
    }
  }

  private async cleanup(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

// ── Automation helpers ────────────────────────────────────────────────────────

async function sendLinkedInDM(
  page: Page,
  profileUrl: string,
  text: string,
): Promise<void> {
  await page.goto(profileUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await page.waitForTimeout(1500);

  // Click "Message" button on the profile page
  const messageBtn = page
    .locator('button:has-text("Message"), a:has-text("Message")')
    .first();
  await messageBtn.waitFor({ timeout: 8000 });
  await messageBtn.click();
  await page.waitForTimeout(1000);

  // Type the message in the compose box
  const composeBox = page
    .locator(
      '.msg-form__contenteditable, [data-placeholder="Write a message…"]',
    )
    .first();
  await composeBox.waitFor({ timeout: 8000 });
  await composeBox.click();
  await composeBox.type(text, { delay: 30 });
  await page.waitForTimeout(500);

  // Send
  const sendBtn = page
    .locator('button.msg-form__send-button, button[aria-label="Send"]')
    .first();
  await sendBtn.click();
  await page.waitForTimeout(1000);
}

async function sendConnectionRequest(
  page: Page,
  profileUrl: string,
  note?: string,
): Promise<void> {
  await page.goto(profileUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await page.waitForTimeout(1500);

  const connectBtn = page.locator('button:has-text("Connect")').first();
  await connectBtn.waitFor({ timeout: 8000 });
  await connectBtn.click();
  await page.waitForTimeout(800);

  if (note) {
    const addNoteBtn = page.locator('button:has-text("Add a note")');
    const noteVisible = await addNoteBtn.isVisible().catch(() => false);
    if (noteVisible) {
      await addNoteBtn.click();
      await page.waitForTimeout(500);
      const noteBox = page.locator('textarea#custom-message');
      await noteBox.fill(note);
      await page.waitForTimeout(300);
    }
  }

  const sendBtn = page
    .locator('button:has-text("Send"), button:has-text("Send without a note")')
    .first();
  await sendBtn.click();
  await page.waitForTimeout(800);
}

// ── JID helpers ───────────────────────────────────────────────────────────────

export function profileUrlToJid(url: string): string {
  // Normalize to linkedin:<canonical-url>
  const clean = url.split('?')[0].replace(/\/$/, '');
  return `linkedin:${clean}`;
}

export function jidToProfileUrl(jid: string): string {
  return jid.replace(/^linkedin:/, '');
}

// ── Self-registration ─────────────────────────────────────────────────────────

registerChannel('linkedin', (opts) => {
  if (process.env.LINKEDIN_ENABLED !== 'true') return null;
  return new LinkedInChannel(opts.onMessage, opts.onChatMetadata);
});
