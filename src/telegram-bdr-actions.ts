/**
 * Telegram BDR action handler.
 *
 * Registers with the BDR Brain at import time:
 *   - telegram_dm: send a Telegram message to a prospect
 *
 * Requires prospect.enrichment to contain { telegram_chat_id: "123456789" }
 * or { telegram_username: "@handle" } (username lookup requires the prospect to
 * have already messaged the bot first — Telegram does not allow cold-messaging by username).
 *
 * The most reliable flow:
 *   1. Prospect sees your Telegram bot linked in email/LinkedIn/website
 *   2. They start a conversation → bot captures their chat_id
 *   3. BDR brain sends follow-up messages via telegram_dm
 *
 * Import in src/index.ts to activate.
 */

import crypto from 'crypto';

import {
  readProspectMemory,
  registerActionHandler,
  writeProspectMemory,
} from './bdr-brain.js';
import { recordTouch, updateProspectNextAction, updateProspectStage } from './bdr-db.js';
import { chatIdToJid } from './channels/telegram.js';
import { getChannelFactory } from './channels/registry.js';
import type { BDRProspect } from './bdr-types.js';
import { TelegramChannel } from './channels/telegram.js';
import { logger } from './logger.js';

function getTelegramChannel(): TelegramChannel | null {
  const ch = (globalThis as Record<string, unknown>).__bdrclaw_telegram_channel;
  if (ch instanceof TelegramChannel && ch.isConnected()) return ch;
  return null;
}

registerActionHandler('telegram_dm', async (prospect: BDRProspect) => {
  let chatId: number | null = null;
  if (prospect.enrichment) {
    try {
      const e = JSON.parse(prospect.enrichment);
      chatId = e.telegram_chat_id ? parseInt(String(e.telegram_chat_id), 10) : null;
    } catch {
      // not JSON
    }
  }

  if (!chatId) {
    logger.warn(
      { prospectId: prospect.id },
      'telegram_dm: no telegram_chat_id in enrichment — prospect must message the bot first',
    );
    return;
  }

  const channel = getTelegramChannel();
  if (!channel) {
    logger.warn('telegram_dm: Telegram channel not connected');
    return;
  }

  const memory = readProspectMemory(prospect.id);
  const touchCount = (memory.match(/telegram_dm/g) ?? []).length;
  const message = buildTelegramMessage(prospect, touchCount);
  const jid = chatIdToJid(chatId);

  try {
    await channel.sendMessage(jid, message);

    recordTouch({
      id: crypto.randomUUID(),
      prospect_id: prospect.id,
      channel: 'telegram',
      direction: 'outbound',
      content: message,
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    const ts = new Date().toISOString().slice(0, 10);
    writeProspectMemory(
      prospect.id,
      memory + `\n[${ts}] telegram_dm (touch ${touchCount + 1}):\n${message}\n`,
    );

    if (touchCount >= 2) {
      updateProspectStage(prospect.id, 'not_interested');
    } else {
      const next = new Date();
      next.setDate(next.getDate() + 3);
      updateProspectNextAction(prospect.id, next.toISOString(), 'telegram_dm');
      updateProspectStage(prospect.id, 'follow_up');
    }

    logger.info({ prospectId: prospect.id, chatId, touchCount }, 'Telegram DM sent');
  } catch (err) {
    logger.error({ err, prospectId: prospect.id }, 'telegram_dm failed');
  }
});

function buildTelegramMessage(prospect: BDRProspect, touchCount: number): string {
  const firstName = prospect.name.split(' ')[0];
  const senderName = process.env.GMAIL_SENDER_NAME ?? 'the team';

  if (touchCount === 0) {
    return (
      `Hey ${firstName}! 👋 Thanks for connecting.\n\n` +
      `We help ${prospect.title}s at companies like ${prospect.company} book 5–10 qualified ` +
      `sales conversations per week — without a full BDR team.\n\n` +
      `Worth a quick 15-min chat? — ${senderName}`
    );
  }

  if (touchCount === 1) {
    return (
      `Hey ${firstName}, just following up! ` +
      `I know things get busy — happy to share a short case study specific to ${prospect.company} if helpful. ` +
      `— ${senderName}`
    );
  }

  return (
    `Hi ${firstName}, last message from me — I don't want to be a bother. ` +
    `If the timing ever feels right, feel free to reach back out. Cheers! 🙌 — ${senderName}`
  );
}
