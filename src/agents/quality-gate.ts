/**
 * Quality Gate — ISC-9 through ISC-15.
 *
 * Every outbound message passes through here before reaching any channel.
 * Two layers of checks:
 *   1. Fast rules (synchronous): unfilled placeholders, channel length limits,
 *      hardcoded spam-trigger words. These run first and are free.
 *   2. Claude review (async, claude-haiku-4-5): semantic quality check —
 *      catches contextual failures rules miss (wrong company name hardcoded,
 *      contradictory claims, tone mismatch). Skipped when QUALITY_GATE_AI=false.
 *
 * Returns { pass, reason, score } — callers MUST check `pass` before sending.
 * Failures are logged with status:'blocked' in bdr_touches by the loop.
 */

import Anthropic from '@anthropic-ai/sdk';

import { logger } from '../logger.js';
import type { TouchChannel } from '../bdr-types.js';

const ai = new Anthropic();

// ── Channel length limits ─────────────────────────────────────────────────────

const CHANNEL_CHAR_LIMITS: Partial<Record<TouchChannel, number>> = {
  sms: 320, // 2 SMS segments max
  whatsapp: 4096,
  telegram: 4096,
  twitter: 10000, // DM limit
  instagram: 1000,
  linkedin: 300, // connection request note limit; DMs are higher but keep it concise
  // email: no hard limit enforced here
};

// ── Spam trigger words ────────────────────────────────────────────────────────

const SPAM_TRIGGERS = [
  'guaranteed results',
  'make money fast',
  'click here',
  'act now',
  'limited time offer',
  'risk-free',
  '100% free',
  'winner',
  'congratulations',
  'you have been selected',
  'unsubscribe immediately',
  'this is not spam',
  '!!!',
  '$$$',
  'FREE FREE FREE',
];

// ── Result type ───────────────────────────────────────────────────────────────

export interface GateResult {
  pass: boolean;
  reason: string | null;
  checks: {
    placeholder: boolean;
    spamWord: boolean;
    length: boolean;
    aiReview: boolean | null; // null = skipped
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function reviewMessage(
  message: string,
  channel: TouchChannel,
  prospectName: string,
  campaignTone: string,
): Promise<GateResult> {
  const checks = {
    placeholder: checkPlaceholders(message),
    spamWord: checkSpamWords(message),
    length: checkLength(message, channel),
    aiReview: null as boolean | null,
  };

  // Fast-fail on rule violations — no point burning an AI call
  if (!checks.placeholder) {
    logger.warn(
      { channel, prospectName },
      'Quality gate FAIL: unfilled placeholder',
    );
    return {
      pass: false,
      reason: 'Message contains unfilled {{placeholder}} tokens',
      checks,
    };
  }
  if (!checks.spamWord) {
    logger.warn(
      { channel, prospectName },
      'Quality gate FAIL: spam trigger word',
    );
    return {
      pass: false,
      reason: 'Message contains spam trigger phrase',
      checks,
    };
  }
  if (!checks.length) {
    const limit = CHANNEL_CHAR_LIMITS[channel] ?? Infinity;
    logger.warn(
      { channel, len: message.length, limit, prospectName },
      'Quality gate FAIL: too long',
    );
    return {
      pass: false,
      reason: `Message exceeds ${limit} character limit for ${channel}`,
      checks,
    };
  }

  // AI review (optional — disable with QUALITY_GATE_AI=false for speed/cost)
  if (process.env.QUALITY_GATE_AI !== 'false') {
    checks.aiReview = await aiReview(
      message,
      channel,
      prospectName,
      campaignTone,
    );
    if (!checks.aiReview) {
      logger.warn(
        { channel, prospectName },
        'Quality gate FAIL: AI review rejected',
      );
      return {
        pass: false,
        reason: 'AI review: message failed quality or personalization check',
        checks,
      };
    }
  }

  logger.debug({ channel, prospectName }, 'Quality gate PASS');
  return { pass: true, reason: null, checks };
}

// ── Rule checks ───────────────────────────────────────────────────────────────

function checkPlaceholders(message: string): boolean {
  return !/\{\{[^}]+\}\}/.test(message);
}

function checkSpamWords(message: string): boolean {
  const lower = message.toLowerCase();
  return !SPAM_TRIGGERS.some((t) => lower.includes(t.toLowerCase()));
}

function checkLength(message: string, channel: TouchChannel): boolean {
  const limit = CHANNEL_CHAR_LIMITS[channel];
  if (!limit) return true;
  return message.length <= limit;
}

// ── AI review ─────────────────────────────────────────────────────────────────

async function aiReview(
  message: string,
  channel: TouchChannel,
  prospectName: string,
  tone: string,
): Promise<boolean> {
  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      system: `You are a B2B outreach quality auditor. Review the message and respond with only "PASS" or "FAIL: <reason>".

FAIL if any of these are true:
- The message sounds like a mass blast, not a personalized note
- It makes claims that seem implausible or exaggerated
- The tone does not match the specified tone (${tone})
- It could be mistaken for a scam or phishing attempt
- It is incoherent or has obvious errors

PASS if the message is professional, personalized, and would not embarrass a thoughtful salesperson.`,
      messages: [
        {
          role: 'user',
          content: `Channel: ${channel}\nProspect: ${prospectName}\n\nMessage:\n${message}`,
        },
      ],
    });

    const verdict =
      response.content[0].type === 'text'
        ? response.content[0].text.trim()
        : 'FAIL: no response';
    return verdict.startsWith('PASS');
  } catch (err) {
    // AI review failure → default to PASS to avoid blocking sends on API outages
    logger.warn({ err }, 'Quality gate AI review failed — defaulting to PASS');
    return true;
  }
}
