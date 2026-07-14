/**
 * CAN-SPAM email compliance helpers.
 *
 * US CAN-SPAM (15 U.S.C. §7704) requires every commercial email to carry:
 *   1. The sender's legal name and a valid physical postal address.
 *   2. A clear, working opt-out (unsubscribe) mechanism.
 *
 * RFC 8058 additionally requires a one-click List-Unsubscribe-Post header for
 * mailbox-provider "Unsubscribe" buttons to work without a round-trip.
 *
 * Every BDR outbound email is stamped with a footer (legal name + address +
 * unsubscribe link) and List-Unsubscribe / List-Unsubscribe-Post headers,
 * applied at the channel send layer — AFTER the quality gate has reviewed the
 * message body, so the gate never blocks on boilerplate it can't control.
 *
 * The unsubscribe link carries an unguessable HMAC token bound to the prospect
 * id, so the /unsubscribe endpoint can honor opt-outs statelessly (no per-send
 * token storage) while remaining tamper-proof.
 */

import crypto from 'crypto';

import { logger } from './logger.js';

const LEGAL_NAME_FALLBACK = '[Your Legal Entity Name — set BDR_LEGAL_NAME]';
const MAILING_ADDRESS_FALLBACK =
  '[Your Physical Mailing Address — set BDR_MAILING_ADDRESS]';
const PUBLIC_URL_FALLBACK = 'https://bdrclaw.dev';

let warnedMissingSecret = false;

/** HMAC secret for unsubscribe tokens. Falls back to a dev-only constant. */
function unsubscribeSecret(): string {
  const secret = process.env.BDR_UNSUBSCRIBE_SECRET;
  if (secret && secret.trim()) return secret.trim();
  if (!warnedMissingSecret) {
    warnedMissingSecret = true;
    logger.warn(
      'BDR_UNSUBSCRIBE_SECRET is not set — using an insecure development ' +
        'default. Set it in .env before sending real email.',
    );
  }
  return 'bdrclaw-dev-unsubscribe-secret-do-not-use-in-prod';
}

/** Public base URL (no trailing slash) used to build absolute links. */
export function publicBaseUrl(): string {
  const raw = process.env.BDR_PUBLIC_URL?.trim() || PUBLIC_URL_FALLBACK;
  return raw.replace(/\/+$/, '');
}

export function legalName(): string {
  return process.env.BDR_LEGAL_NAME?.trim() || LEGAL_NAME_FALLBACK;
}

export function mailingAddress(): string {
  return process.env.BDR_MAILING_ADDRESS?.trim() || MAILING_ADDRESS_FALLBACK;
}

/** Deterministic, unguessable opt-out token bound to a prospect id. */
export function unsubscribeToken(prospectId: string): string {
  return crypto
    .createHmac('sha256', unsubscribeSecret())
    .update(prospectId)
    .digest('hex')
    .slice(0, 32);
}

/** Timing-safe verification of an unsubscribe token for a prospect id. */
export function verifyUnsubscribeToken(
  prospectId: string,
  token: string,
): boolean {
  if (!prospectId || !token) return false;
  const expected = unsubscribeToken(prospectId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Absolute one-click unsubscribe URL carrying the prospect id + HMAC token. */
export function unsubscribeUrl(prospectId: string): string {
  const params = new URLSearchParams({
    p: prospectId,
    t: unsubscribeToken(prospectId),
  });
  return `${publicBaseUrl()}/unsubscribe?${params.toString()}`;
}

/** mailto: opt-out target (RFC 2369). Uses a dedicated or closer mailbox. */
function unsubscribeMailto(): string {
  const email =
    process.env.BDR_UNSUBSCRIBE_EMAIL?.trim() ||
    process.env.BDR_CLOSER_EMAIL?.trim() ||
    'unsubscribe@bdrclaw.dev';
  return `mailto:${email}?subject=unsubscribe`;
}

/**
 * The CAN-SPAM plain-text footer appended to every commercial email body.
 * Includes legal name, physical mailing address, and a working unsubscribe URL.
 */
export function buildCanSpamFooter(prospectId: string): string {
  return [
    '--',
    `${legalName()}`,
    `${mailingAddress()}`,
    '',
    `You are receiving this email as part of a business outreach sequence.`,
    `To stop receiving these emails, unsubscribe here: ${unsubscribeUrl(prospectId)}`,
  ].join('\n');
}

/** Append the CAN-SPAM footer to an email body (idempotent per call site). */
export function appendCanSpamFooter(body: string, prospectId: string): string {
  return `${body.trimEnd()}\n\n${buildCanSpamFooter(prospectId)}\n`;
}

/**
 * List-Unsubscribe (RFC 2369) + List-Unsubscribe-Post (RFC 8058) headers.
 * The https target must accept a one-click POST; the /unsubscribe endpoint does.
 */
export function listUnsubscribeHeaders(
  prospectId: string,
): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeMailto()}>, <${unsubscribeUrl(prospectId)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
