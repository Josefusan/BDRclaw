/**
 * Twitter / X BDR action handlers.
 *
 * Registers with the BDR Brain at import time:
 *   - twitter_dm: send a WARM DM reply to a prospect's Twitter account
 *
 * WARM/REPLY-ONLY CHANNEL: cold DMs are banned by X platform policy. A
 * twitter_dm action is refused (with a thrown error, never a silent drop)
 * unless the prospect has at least one inbound Twitter touch on record.
 *
 * All sends go through the live TwitterChannel instance so the daily DM cap
 * and channel-level warm enforcement apply — this handler never constructs
 * its own API client.
 *
 * Requires a prospect's twitter_user_id or twitter_handle in enrichment data.
 * Only active when TWITTER_ENABLED=true and the Twitter channel is connected.
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
import { touchCounts } from './channels/compliance.js';
import { getActiveTwitterChannel, userIdToJid } from './channels/twitter.js';
import type { BDRProspect } from './bdr-types.js';
import { logger } from './logger.js';

// ── twitter_dm ────────────────────────────────────────────────────────────────

registerActionHandler(
  'twitter_dm',
  async (prospect: BDRProspect, composed?: ComposedOutbound) => {
    if (process.env.TWITTER_ENABLED !== 'true') return;

    // Global suppression — defense in depth alongside the entry-point checks.
    if (isProspectSuppressed(prospect)) {
      logger.info(
        { prospectId: prospect.id },
        'twitter_dm: prospect suppressed — outbound skipped',
      );
      return;
    }

    // WARM/REPLY-ONLY gate — checked BEFORE any network call (including
    // username resolution) so a refused DM makes zero API requests.
    const { inbound, outbound: touchCount } = touchCounts(
      prospect.id,
      'twitter',
    );
    if (inbound === 0) {
      throw new Error(
        `twitter_dm refused: X cold DMs are policy-banned — twitter is a ` +
          `warm/reply-only channel and prospect ${prospect.id} has no inbound ` +
          `Twitter touch. Reach this prospect on a cold channel (email/sms/linkedin) instead.`,
      );
    }

    const channel = getActiveTwitterChannel();
    if (!channel) {
      logger.warn(
        'twitter_dm: Twitter channel not connected — check TWITTER_ENABLED and API keys',
      );
      return;
    }

    // Extract twitter identity from enrichment JSON
    let twitterUserId: string | null = null;
    let twitterUsername: string | null = null;
    if (prospect.enrichment) {
      try {
        const enrichment = JSON.parse(prospect.enrichment);
        twitterUserId = enrichment.twitter_user_id
          ? String(enrichment.twitter_user_id)
          : null;
        twitterUsername =
          enrichment.twitter_handle ?? enrichment.twitter_username ?? null;
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

    // Resolve username → userId if we only have a handle
    if (!twitterUserId && twitterUsername) {
      try {
        twitterUserId = await channel.resolveUserId(twitterUsername);
      } catch (err) {
        logger.warn(
          { err, twitterUsername },
          'twitter_dm: could not resolve user ID',
        );
        return;
      }
    }

    const memory = readProspectMemory(prospect.id);
    // Prefer the composed + quality-gated message; fall back to the template.
    const message = resolveOutboundBody(composed, () =>
      buildTwitterDM(prospect, touchCount),
    );

    try {
      // Channel send enforces the daily DM cap (throws at the cap) and the
      // warm-only + suppression backstops.
      await channel.sendMessage(userIdToJid(twitterUserId!), message);

      recordTouch({
        id: crypto.randomUUID(),
        prospect_id: prospect.id,
        channel: 'twitter',
        direction: 'outbound',
        content: message,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });

      const ts = new Date().toISOString().slice(0, 10);
      writeProspectMemory(
        prospect.id,
        memory +
          `\n[${ts}] twitter_dm (touch ${touchCount + 1}):\n${message}\n`,
      );

      if (touchCount >= 1) {
        updateProspectStage(prospect.id, 'not_interested');
      } else {
        const next = new Date();
        next.setDate(next.getDate() + 4);
        updateProspectNextAction(prospect.id, next.toISOString(), 'twitter_dm');
        updateProspectStage(prospect.id, 'follow_up');
      }

      logger.info(
        { prospectId: prospect.id, twitterUserId, touchCount },
        'Twitter DM sent',
      );
    } catch (err) {
      logger.error({ err, prospectId: prospect.id }, 'twitter_dm failed');
    }
  },
);

// ── Message builder ───────────────────────────────────────────────────────────

function buildTwitterDM(prospect: BDRProspect, touchCount: number): string {
  const firstName = prospect.name.split(' ')[0];
  const senderName = process.env.GMAIL_SENDER_NAME ?? 'the team';

  if (touchCount === 0) {
    return (
      `Hey ${firstName}! Thanks for reaching out — glad to connect. ` +
      `We help ${prospect.title}s at companies like ${prospect.company} book more ` +
      `qualified meetings on autopilot. Happy to share details here — ${senderName}`
    );
  }

  return (
    `Hey ${firstName}, circling back on our conversation — if you're open to it, ` +
    `I'd love to share a short breakdown of what we're doing that's been ` +
    `working well for companies like ${prospect.company}. No pressure! — ${senderName}`
  );
}
