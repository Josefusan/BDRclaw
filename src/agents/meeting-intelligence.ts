/**
 * Meeting Intelligence Agent — analyzes meeting transcripts with Claude.
 *
 * Takes a raw transcript + context and returns structured insights,
 * action items, lessons, and draft follow-up messages for all channels.
 */

import Anthropic from '@anthropic-ai/sdk';

import { logger } from '../logger.js';

const ai = new Anthropic();

export interface MeetingAnalysis {
  summary: string;
  keyInsights: string[];
  actionItems: Array<{ task: string; owner?: string; deadline?: string }>;
  lessons: string[];
  prospectOpportunities: Array<{
    name: string;
    company: string;
    title?: string;
    email?: string;
    followUpContext: string;
  }>;
  emailDraft: string;
  smsDraft: string;
  telegramDraft: string;
  linkedinMessage: string;
  sentiment: 'very_positive' | 'positive' | 'neutral' | 'negative';
}

const SYSTEM_PROMPT = `You are a world-class BDR (Business Development Representative) analyst.
You analyze meeting transcripts and extract structured intelligence to help salespeople close deals.
Your analysis is precise, actionable, and focused on revenue outcomes.
Always respond with valid JSON matching the requested schema exactly.`;

function buildPrompt(
  transcript: string,
  topic: string,
  attendees: string,
  myRole: string,
): string {
  return `Analyze this meeting transcript and return a JSON object with these exact fields:

{
  "summary": "2-3 sentence executive summary of what was discussed and decided",
  "keyInsights": ["insight 1", "insight 2", ...],
  "actionItems": [{"task": "...", "owner": "name or null", "deadline": "date or null"}],
  "lessons": ["what to do differently next time", ...],
  "prospectOpportunities": [{"name": "...", "company": "...", "title": "or null", "email": "or null", "followUpContext": "..."}],
  "emailDraft": "Full follow-up email body (no subject line)",
  "smsDraft": "Short SMS follow-up under 160 chars",
  "telegramDraft": "Telegram message 1-3 sentences",
  "linkedinMessage": "LinkedIn DM under 300 chars",
  "sentiment": "very_positive|positive|neutral|negative"
}

Meeting topic: ${topic || 'Not specified'}
Attendees: ${attendees || 'Not specified'}
My role: ${myRole || 'BDR / Closer'}

Transcript:
${transcript}

Respond with ONLY the JSON object, no markdown fences.`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function analyzeMeeting(
  transcript: string,
  topic: string,
  attendees: string,
  myRole: string,
): Promise<MeetingAnalysis> {
  const prompt = buildPrompt(transcript, topic, attendees, myRole);

  const model = process.env.MEETING_AI_MODEL ?? 'claude-sonnet-4-6';
  logger.info(
    { model, transcriptLen: transcript.length },
    'Analyzing meeting transcript',
  );

  const msg = await ai.messages.create({
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0];
  if (raw.type !== 'text') throw new Error('Unexpected response type from AI');

  try {
    return JSON.parse(raw.text) as MeetingAnalysis;
  } catch (err) {
    logger.error(
      { err, raw: raw.text },
      'Failed to parse meeting analysis JSON',
    );
    throw new Error('Meeting analysis returned invalid JSON');
  }
}

export async function streamMeetingAnalysis(
  transcript: string,
  topic: string,
  attendees: string,
  myRole: string,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const prompt = buildPrompt(transcript, topic, attendees, myRole);
  const model = process.env.MEETING_AI_MODEL ?? 'claude-sonnet-4-6';

  const stream = ai.messages.stream({
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      onChunk(event.delta.text);
    }
  }
}
