/**
 * Shared outbound-compliance checks for channels.
 *
 * These run inside each channel's sendMessage() so the rules hold no matter
 * which entry point triggered the send (agentic loop `processEnrollment`, BDR
 * Brain `dispatchAction`, or ad-hoc reply routing). Both entry points already
 * check the global suppression list; the checks here are the architectural
 * backstop — a send that reaches the wire has passed them by construction.
 *
 * All checks are no-ops when the BDR database has not been initialized:
 * channels are also used for plain conversational routing outside the BDR
 * pipeline, and a compliance rule that crashes non-BDR sends would be a
 * regression, not a safeguard.
 */

import {
  getBdrDb,
  getProspectByContact,
  getTouchesForProspect,
  isProspectSuppressed,
} from '../bdr-db.js';
import type { BDRProspect, TouchChannel } from '../bdr-types.js';

/** TCPA: max unsolicited outbound SMS touches per prospect. */
export const SMS_UNSOLICITED_TOUCH_CAP = 2;

function lookupProspect(
  channel: TouchChannel,
  contactId: string,
): BDRProspect | undefined {
  // BDR db not initialized (non-BDR deployment / unit test) — nothing to check.
  if (!getBdrDb()) return undefined;
  return getProspectByContact(channel, contactId);
}

/**
 * Count a prospect's touches on one channel. Outbound touches with
 * status 'blocked' never reached the wire, so they don't count.
 */
export function touchCounts(
  prospectId: string,
  channel: TouchChannel,
): { inbound: number; outbound: number } {
  let inbound = 0;
  let outbound = 0;
  for (const t of getTouchesForProspect(prospectId)) {
    if (t.channel !== channel) continue;
    if (t.direction === 'inbound') inbound++;
    else if (t.status !== 'blocked') outbound++;
  }
  return { inbound, outbound };
}

/** Throws if the contact resolves to a prospect on the global suppression list. */
export function assertNotSuppressed(
  channel: TouchChannel,
  contactId: string,
): void {
  const prospect = lookupProspect(channel, contactId);
  if (prospect && isProspectSuppressed(prospect)) {
    throw new Error(
      `${channel} send refused: contact is on the global suppression list (opted out)`,
    );
  }
}

/**
 * Warm-only channels (WhatsApp, Twitter/X): refuse outbound to a known
 * prospect who has never messaged us inbound on this channel.
 *
 * Unknown contacts (no prospect record) are allowed through: they only appear
 * as send targets via the conversational reply path, where the contact
 * messaged the bot first by definition. Cold outreach always goes through
 * prospect records, so it can never use this gap.
 */
export function assertWarmProspect(
  channel: TouchChannel,
  contactId: string,
  policyNote: string,
): void {
  const prospect = lookupProspect(channel, contactId);
  if (!prospect) return;
  const { inbound } = touchCounts(prospect.id, channel);
  if (inbound === 0) {
    throw new Error(
      `${channel} send refused: warm-only channel and prospect ${prospect.id} ` +
        `has no inbound ${channel} message. ${policyNote}`,
    );
  }
}

/**
 * TCPA: max ${SMS_UNSOLICITED_TOUCH_CAP} unsolicited outbound SMS per
 * prospect. Once the prospect has replied on SMS the conversation is
 * solicited and the cap no longer applies.
 */
export function assertSmsTcpaCap(contactId: string): void {
  const prospect = lookupProspect('sms', contactId);
  if (!prospect) return;
  const { inbound, outbound } = touchCounts(prospect.id, 'sms');
  if (inbound === 0 && outbound >= SMS_UNSOLICITED_TOUCH_CAP) {
    throw new Error(
      `sms send refused: TCPA cap — prospect ${prospect.id} already received ` +
        `${SMS_UNSOLICITED_TOUCH_CAP} unsolicited SMS touches and has not replied`,
    );
  }
}
