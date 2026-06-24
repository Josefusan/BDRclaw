/**
 * Twitter / X BDR action handlers.
 *
 * Registers with the BDR Brain at import time:
 *   - twitter_dm: send a cold DM to a prospect's Twitter account
 *
 * Requires a prospect's twitter_handle to be set in enrichment data.
 * First-touch DMs are only sent if TWITTER_ENABLED=true.
 */

import crypto from 'crypto';
import { TwitterApi } from 'twitter-api-v2';

import {
  readProspectMemory,
  registerActionHandler,
  writeProspectMemory,
} from './bdr-brain.js';
import { recordTouch, updateProspectNextAction, updateProspectStage } from './bdr-db.js';
import type { BDRProspect } from './bdr-types.js';
import { logger } from './logger.js';

// ── twitter_dm ────────────────────────────────────────────────────────────────

registerActionHandler('twitter_dm', async (prospect: BDRProspect) => {
  if (process.env.TWITTER_ENABLED !== 'true') return;

  // Extract twitter handle from enrichment JSON
  let twitterUserId: string | null = null;
  let twitterUsername: string | null = null;
  if (prospect.enrichment) {
    try {
      const enrichment = JSON.parse(prospect.enrichment);
      twitterUserId = enrichment.twitter_user_id ?? null;
      twitterUsername = enrichment.twitter_handle ?? enrichment.twitter_username ?? null;
    } catch {
      // enrichment not JSON
    }
  }

  if (!twitterUserId && !twitterUsername) {
    logger.warn(
      { prospectId: prospect.id },
      'twitter_dm: no twitter_user_id or twitter_handle in enrichment, skipping',
    );
    return;
  }

  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY!,
    appSecret: process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET!,
  }).readWrite;

  // Resolve username → userId if we only have a handle
  if (!twitterUserId && twitterUsername) {
    try {
      const user = await client.v2.userByUsername(twitterUsername.replace(/^@/, ''));
      twitterUserId = user.data.id;
    } catch (err) {
      logger.warn({ err, twitterUsername }, 'twitter_dm: could not resolve user ID');
      return;
    }
  }

  const memory = readProspectMemory(prospect.id);
  const touchCount = (memory.match(/twitter_dm/g) ?? []).length;
  const message = buildTwitterDM(prospect, touchCount);

  try {
    await client.v2.sendDmToParticipant(twitterUserId!, { text: message });

    recordTouch({
      id: crypto.randomUUID(),
      prospect_id: prospect.id,
      channel: 'linkedin',
      direction: 'outbound',
      content: message,
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    const ts = new Date().toISOString().slice(0, 10);
    writeProspectMemory(
      prospect.id,
      memory + `\n[${ts}] twitter_dm (touch ${touchCount + 1}):\n${message}\n`,
    );

    if (touchCount >= 1) {
      updateProspectStage(prospect.id, 'not_interested');
    } else {
      const next = new Date();
      next.setDate(next.getDate() + 4);
      updateProspectNextAction(prospect.id, next.toISOString(), 'twitter_dm');
      updateProspectStage(prospect.id, 'follow_up');
    }

    logger.info({ prospectId: prospect.id, twitterUserId, touchCount }, 'Twitter DM sent');
  } catch (err) {
    logger.error({ err, prospectId: prospect.id }, 'twitter_dm failed');
  }
});

// ── Message builder ───────────────────────────────────────────────────────────

function buildTwitterDM(prospect: BDRProspect, touchCount: number): string {
  const firstName = prospect.name.split(' ')[0];
  const senderName = process.env.GMAIL_SENDER_NAME ?? 'the team';

  if (touchCount === 0) {
    return (
      `Hey ${firstName}! Saw what you're building at ${prospect.company} — impressive stuff. ` +
      `We help ${prospect.title}s book more qualified meetings on autopilot. ` +
      `Would a quick DM convo be ok? — ${senderName}`
    );
  }

  return (
    `Hey ${firstName}, just one quick follow-up — if you're open to it, ` +
    `I'd love to share a short breakdown of what we're doing that's been ` +
    `working well for companies like ${prospect.company}. No pressure! — ${senderName}`
  );
}
