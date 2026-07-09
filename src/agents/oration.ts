/**
 * Oration Agent — processes voice commands from the Oration floating UI.
 *
 * Accepts transcribed speech text, detects intent (especially /goal commands),
 * and returns a structured response with an optional action to perform.
 *
 * The frontend Web Speech API transcribes audio; this agent understands it.
 */

import Anthropic from '@anthropic-ai/sdk';

import { logger } from '../logger.js';

const ai = new Anthropic();

export interface OrationResult {
  response: string;
  speak: boolean;
  action?: {
    type:
      | 'navigate'
      | 'addLead'
      | 'createCampaign'
      | 'readStats'
      | 'updateGoal'
      | 'searchLeads';
    payload: Record<string, unknown>;
  };
}

const SYSTEM_PROMPT = `You are the voice interface for BDRclaw, an AI-native BDR platform.
You assist sales professionals by voice, helping them manage campaigns, leads, and outreach.

When the user's message starts with /goal, update or report on their current sales goals.
When they ask to add a lead, extract name/company/email/role from the text.
When they ask about stats or pipeline, trigger a stats read.
When they ask to create or modify a campaign, trigger campaign creation flow.
When they want to navigate somewhere in the app, trigger navigation.

Always respond with a JSON object with these exact fields:
{
  "response": "What to say back to the user (conversational, 1-3 sentences)",
  "speak": true,
  "action": null or {"type": "navigate|addLead|createCampaign|readStats|updateGoal|searchLeads", "payload": {...}}
}

Keep responses concise and actionable. Speak like a sharp, helpful colleague.
Respond with ONLY the JSON object, no markdown fences.`;

export async function processOration(text: string): Promise<OrationResult> {
  logger.info(
    { textLen: text.length, isGoalCmd: text.startsWith('/goal') },
    'Processing oration',
  );

  const msg = await ai.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  const raw = msg.content[0];
  if (raw.type !== 'text') throw new Error('Unexpected response type');

  try {
    const parsed = JSON.parse(raw.text) as OrationResult;
    logger.info({ action: parsed.action?.type ?? 'none' }, 'Oration processed');
    return parsed;
  } catch (err) {
    logger.error({ err, raw: raw.text }, 'Failed to parse oration JSON');
    return {
      response:
        "I heard you, but I'm having trouble processing that. Could you try again?",
      speak: true,
    };
  }
}
