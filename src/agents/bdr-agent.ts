/**
 * BDR Agent — ISC-5 through ISC-8.
 *
 * Claude-powered message composer. Reads full prospect context (memory, stage,
 * enrichment, campaign step, previous touches) and generates a personalized,
 * human-sounding outreach message for the given channel.
 *
 * Key invariants:
 *   - Never returns a message with {{placeholder}} tokens
 *   - Never repeats content already in prospect memory
 *   - Respects channel-specific conventions (LinkedIn brevity, email structure, SMS terseness)
 *   - Applies send-time jitter (handled by the caller / campaign-runner)
 */

import Anthropic from '@anthropic-ai/sdk';

import { readProspectMemory } from '../bdr-brain.js';
import { logger } from '../logger.js';
import type { BDRProspect, Campaign, CampaignStep, TouchChannel } from '../bdr-types.js';

const ai = new Anthropic();

// ── Channel guidance ──────────────────────────────────────────────────────────

const CHANNEL_GUIDANCE: Record<string, string> = {
  email:       'Professional email. Subject line + body. Can be 3-5 short paragraphs. Clear CTA at end.',
  linkedin:    'LinkedIn DM or connection note. Max 300 chars for connection requests. Warm, professional. No hard sell.',
  linkedin_connect: 'LinkedIn connection request note. MAX 300 characters. One sentence on why connecting. No pitch.',
  twitter:     'Twitter/X DM. Casual, conversational. Under 280 chars ideally. Don\'t sound like a bot.',
  sms:         'SMS text. VERY brief, under 160 chars ideally. First-name only. Conversational. Include name at end.',
  whatsapp:    'WhatsApp message. Conversational, not too long. Can use line breaks. Slightly more casual than email.',
  telegram:    'Telegram message. Conversational. Can include emojis sparingly. Under 500 chars.',
  instagram:   'Instagram DM. Casual, friendly. Under 500 chars. Reference their content or business if possible.',
};

// ── Main export ───────────────────────────────────────────────────────────────

export interface ComposedMessage {
  body: string;
  subject?: string;  // email only
  channel: TouchChannel;
}

export async function composeMessage(
  prospect: BDRProspect,
  step: CampaignStep,
  campaign: Campaign,
): Promise<ComposedMessage> {
  const memory = readProspectMemory(prospect.id);
  const channelKey = step.action_type.replace('_dm', '').replace('send_', '').replace('_connect', '_connect');
  const channelGuidance = CHANNEL_GUIDANCE[channelKey] ?? CHANNEL_GUIDANCE[step.action_type] ?? 'Professional, concise outreach message.';
  const touchChannel = actionTypeToChannel(step.action_type);

  let enrichmentContext = '';
  if (prospect.enrichment) {
    try {
      const e = JSON.parse(prospect.enrichment);
      // Filter internal keys before exposing to the agent
      const public_e = Object.fromEntries(
        Object.entries(e).filter(([k]) => !k.startsWith('__'))
      );
      if (Object.keys(public_e).length > 0) {
        enrichmentContext = `\n\nProspect enrichment data:\n${JSON.stringify(public_e, null, 2)}`;
      }
    } catch { /* ignore */ }
  }

  const system = `You are a world-class B2B sales development representative writing outreach for a high-ticket offer.

Your job: write a single ${touchChannel} message to ${prospect.name} at ${prospect.company}.

RULES (non-negotiable):
1. Never use {{placeholder}} tokens. Fill in all variables from the context provided.
2. Never repeat content already sent (check the prospect memory below).
3. Match tone: ${campaign.tone}.
4. Channel format: ${channelGuidance}
5. One clear call to action — usually a question or calendar link invite.
6. Sound like a human, not a sequence tool. Vary sentence structure.
7. If the prospect has replied before, reference it naturally.
8. Output ONLY the message body (and subject line if email, on a separate first line prefixed with "Subject: ").
9. Do not explain your reasoning. Just write the message.

Value proposition: ${campaign.value_proposition ?? 'Not specified — use general business value framing.'}
ICP: ${campaign.icp_description ?? 'B2B decision maker'}`;

  const userPrompt = `Prospect:
- Name: ${prospect.name}
- Title: ${prospect.title}
- Company: ${prospect.company}
- Email: ${prospect.email ?? 'unknown'}
- LinkedIn: ${prospect.linkedin_url ?? 'unknown'}
- Phone: ${prospect.phone ?? 'unknown'}
- Current stage: ${prospect.stage}${enrichmentContext}

Campaign step: ${step.step_number} of the sequence
Action type: ${step.action_type}
Step template hint (expand and personalize this, don't copy verbatim):
${step.template}

Previous outreach history (do NOT repeat any of these):
${memory || '(no previous touches)'}

Write the ${touchChannel} message now.`;

  try {
    const response = await ai.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    if (!raw) throw new Error('Empty response from BDR agent');

    // Extract subject line for email
    let body = raw;
    let subject: string | undefined;
    if (touchChannel === 'email') {
      const subjectMatch = raw.match(/^Subject:\s*(.+)\n([\s\S]*)/);
      if (subjectMatch) {
        subject = subjectMatch[1].trim();
        body = subjectMatch[2].trim();
      }
    }

    logger.debug({ prospectId: prospect.id, channel: touchChannel, step: step.step_number }, 'BDR agent composed message');

    return { body, subject, channel: touchChannel };
  } catch (err) {
    logger.error({ err, prospectId: prospect.id }, 'BDR agent composition failed');
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function actionTypeToChannel(actionType: string): TouchChannel {
  const map: Record<string, TouchChannel> = {
    send_email:       'email',
    linkedin_connect: 'linkedin',
    linkedin_dm:      'linkedin',
    twitter_dm:       'twitter',
    instagram_dm:     'instagram',
    telegram_dm:      'telegram',
    whatsapp_dm:      'whatsapp',
    send_sms:         'sms',
  };
  return map[actionType] ?? 'email';
}
