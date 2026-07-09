/**
 * Cold Outreach Agent — generates a complete outreach strategy for a target.
 *
 * Given a prospect or ICP description, builds a full multi-channel sequence:
 * timing, message content for each step, subject lines, personalization hooks.
 * Draws entirely from Second Brain context so every sequence is on-brand.
 */

import Anthropic from '@anthropic-ai/sdk';

import { getSecondBrainSummary } from './second-brain.js';
import { logger } from '../logger.js';

const ai = new Anthropic();

export interface OutreachStep {
  stepNumber: number;
  delayDays: number;
  channel:
    | 'email'
    | 'linkedin'
    | 'linkedin_connect'
    | 'sms'
    | 'twitter'
    | 'whatsapp';
  subject?: string;
  message: string;
  note: string; // rationale for this step
}

export interface OutreachStrategyResult {
  runAt: string;
  durationMs: number;
  targetDescription: string;
  sequenceName: string;
  objective: string;
  steps: OutreachStep[];
  expectedOutcome: string;
  keyHooks: string[]; // personalization angles to research per prospect
}

export interface OutreachAgentInput {
  targetDescription: string; // e.g. "VP of Sales at 50-200 person SaaS companies"
  goal?: string; // e.g. "book a discovery call"
  numberOfSteps?: number;
  channels?: string[];
  tone?: string;
}

export async function runColdOutreachAgent(
  input: OutreachAgentInput,
): Promise<OutreachStrategyResult> {
  const start = Date.now();
  logger.info(
    { target: input.targetDescription },
    'Cold Outreach Agent starting',
  );

  const businessContext = await getSecondBrainSummary();

  const prompt = `You are a world-class cold outreach strategist. Using this business context:

${businessContext}

Build a complete cold outreach sequence for this target:
- Target: ${input.targetDescription}
- Goal: ${input.goal ?? 'book a discovery call'}
- Steps: ${input.numberOfSteps ?? 5}
- Preferred channels: ${input.channels?.join(', ') ?? 'email, linkedin, sms'}
- Tone: ${input.tone ?? 'use the business context messaging style'}

Return a JSON object with these exact fields:
{
  "sequenceName": "name for this sequence",
  "objective": "1-sentence campaign objective",
  "steps": [
    {
      "stepNumber": 1,
      "delayDays": 0,
      "channel": "email|linkedin|linkedin_connect|sms|twitter|whatsapp",
      "subject": "email subject line (email only, null for others)",
      "message": "complete message body with {{firstName}}, {{company}} placeholders where appropriate",
      "note": "why this step at this timing"
    }
  ],
  "expectedOutcome": "what success looks like (reply rate, booking rate)",
  "keyHooks": ["personalization research point 1", "personalization research point 2"]
}

Messages must be human-sounding. No {{placeholder}} left unfilled at runtime. Vary length and approach per step to avoid pattern detection. Respond with ONLY the JSON object.`;

  const msg = await ai.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0];
  if (raw.type !== 'text') throw new Error('Unexpected AI response type');

  let parsed: Omit<
    OutreachStrategyResult,
    'runAt' | 'durationMs' | 'targetDescription'
  >;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    logger.error({ raw: raw.text }, 'Cold Outreach Agent JSON parse failed');
    throw new Error('Strategy generation returned invalid JSON');
  }

  const result: OutreachStrategyResult = {
    runAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    targetDescription: input.targetDescription,
    ...parsed,
  };

  logger.info(
    { steps: result.steps.length, sequence: result.sequenceName },
    'Cold Outreach Agent complete',
  );
  return result;
}
