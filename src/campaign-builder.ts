/**
 * Agentic Campaign Builder.
 *
 * Users talk to BDR Claude; BDR Claude builds the entire campaign for them.
 * The conversation is stateless from Claude's perspective — each call passes
 * the full message history. Session state is persisted in SQLite between API calls.
 *
 * Flow:
 *   1. POST /api/campaigns/builder/start  → returns { sessionId, message }
 *   2. POST /api/campaigns/builder/chat   → { sessionId, message }  → { reply, done, campaign? }
 *   3. When done=true, the campaign is saved and ready to use.
 *
 * The builder also handles editing: "make the LinkedIn message shorter",
 * "add a WhatsApp follow-up on day 7", "change tone to more formal".
 */

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

import {
  deleteCampaignSteps,
  enrollProspect,
  getBuilderSession,
  getCampaignById,
  getCampaignSteps,
  getActiveProspects,
  upsertBuilderSession,
  upsertCampaign,
  upsertCampaignStep,
} from './bdr-db.js';
import { logger } from './logger.js';
import type {
  BuilderSession,
  Campaign,
  CampaignEnrollment,
  CampaignStep,
  CampaignTone,
} from './bdr-types.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are BDR Claude, an expert B2B sales development AI that helps users build outreach campaigns.

Your job: have a short, focused conversation to understand what the user wants, then generate a complete campaign.

You need to collect:
1. Product/service being sold (1-2 sentences)
2. Ideal Customer Profile (ICP): role, company size, industry
3. Core pain point the product solves
4. Channels to use (email, LinkedIn, SMS, WhatsApp, Telegram, Twitter)
5. Desired tone: formal | casual | friendly | direct
6. Sequence aggressiveness: how many touches, days between

Rules:
- Ask 1-2 questions per message, not a laundry list
- After 3-4 exchanges you should have enough to generate the campaign
- When ready, output a JSON block wrapped in \`\`\`campaign\`\`\` fences — this is how the system knows you're done
- Write real messages, not placeholders. Use {{firstName}}, {{company}}, {{title}} for personalization

Campaign JSON format:
\`\`\`campaign
{
  "name": "Campaign name",
  "description": "What this campaign does",
  "icp_description": "VP Sales at B2B SaaS companies, 50-200 employees, US market",
  "value_proposition": "We help sales teams book 5-10 more meetings/week without adding headcount",
  "tone": "friendly",
  "jitter_minutes": 30,
  "steps": [
    {
      "step_number": 1,
      "action_type": "send_email",
      "delay_days": 0,
      "subject": "Quick question about {{company}}'s pipeline",
      "template": "Hi {{firstName}},\\n\\nI noticed {{company}} is scaling the sales team...",
      "condition": "always"
    },
    {
      "step_number": 2,
      "action_type": "linkedin_connect",
      "delay_days": 2,
      "template": "Hi {{firstName}}, I sent you an email about pipeline generation — would love to connect here too.",
      "condition": "no_reply"
    }
  ]
}
\`\`\`

Valid action_type values: send_email, linkedin_connect, linkedin_dm, twitter_dm, instagram_dm, telegram_dm, whatsapp_dm, send_sms
Valid condition values: always, no_reply, opened, clicked
Valid tone values: formal, casual, friendly, direct

After the campaign JSON, add a brief plain-text summary of what you built (2-3 sentences).
If the user wants to edit an existing campaign, output the full updated JSON — not just the changed parts.`;

// ── Session management ────────────────────────────────────────────────────────

export function startBuilderSession(): BuilderSession {
  const now = new Date().toISOString();
  const session: BuilderSession = {
    id: crypto.randomUUID(),
    messages: [],
    created_at: now,
    updated_at: now,
  };
  upsertBuilderSession(session);
  return session;
}

// ── Core conversation step ────────────────────────────────────────────────────

export interface BuilderResponse {
  reply: string;
  done: boolean;
  campaign?: Campaign & { steps: CampaignStep[] };
  sessionId: string;
}

export async function builderChat(
  sessionId: string,
  userMessage: string,
): Promise<BuilderResponse> {
  const session = getBuilderSession(sessionId);
  if (!session) throw new Error(`Builder session not found: ${sessionId}`);

  // Append user message
  session.messages.push({ role: 'user', content: userMessage });

  // Call Claude
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  const assistantText =
    response.content[0].type === 'text' ? response.content[0].text : '';

  // Append assistant message to history
  session.messages.push({ role: 'assistant', content: assistantText });
  session.updated_at = new Date().toISOString();

  // Check if the assistant generated a campaign JSON block
  const campaignMatch = assistantText.match(
    /```campaign\s*([\s\S]*?)```/,
  );

  if (!campaignMatch) {
    // Still in conversation phase
    upsertBuilderSession(session);
    return { reply: assistantText, done: false, sessionId };
  }

  // Parse and save the campaign
  let parsed: ReturnType<typeof parseCampaignJson> | null = null;
  try {
    parsed = parseCampaignJson(campaignMatch[1].trim());
  } catch (err) {
    logger.warn({ err }, 'campaign-builder: failed to parse campaign JSON');
    upsertBuilderSession(session);
    // Return the reply without marking done so user can clarify
    return { reply: assistantText, done: false, sessionId };
  }

  const { campaign, steps } = saveCampaign(parsed);
  session.draft = { ...campaign, steps };
  upsertBuilderSession(session);

  logger.info(
    { campaignId: campaign.id, stepCount: steps.length },
    'Campaign built via conversation',
  );

  return {
    reply: assistantText,
    done: true,
    campaign: { ...campaign, steps },
    sessionId,
  };
}

// ── Campaign JSON parsing & saving ────────────────────────────────────────────

interface RawCampaignJson {
  name: string;
  description?: string;
  icp_description?: string;
  value_proposition?: string;
  tone?: CampaignTone;
  jitter_minutes?: number;
  steps: Array<{
    step_number: number;
    action_type: string;
    delay_days?: number;
    subject?: string;
    template: string;
    condition?: string;
  }>;
}

function parseCampaignJson(raw: string): RawCampaignJson {
  const data = JSON.parse(raw) as RawCampaignJson;
  if (!data.name) throw new Error('Campaign missing name');
  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    throw new Error('Campaign missing steps');
  }
  return data;
}

function saveCampaign(raw: RawCampaignJson): { campaign: Campaign; steps: CampaignStep[] } {
  const now = new Date().toISOString();
  const campaignId = crypto.randomUUID();

  const campaign: Campaign = {
    id: campaignId,
    name: raw.name,
    description: raw.description,
    icp_description: raw.icp_description,
    value_proposition: raw.value_proposition,
    tone: raw.tone ?? 'friendly',
    jitter_minutes: raw.jitter_minutes ?? 30,
    status: 'draft',
    created_at: now,
    updated_at: now,
  };
  upsertCampaign(campaign);

  const steps: CampaignStep[] = raw.steps.map((s) => ({
    id: crypto.randomUUID(),
    campaign_id: campaignId,
    step_number: s.step_number,
    action_type: s.action_type as CampaignStep['action_type'],
    delay_days: s.delay_days ?? 0,
    subject: s.subject,
    template: s.template,
    condition: (s.condition ?? 'always') as CampaignStep['condition'],
  }));

  for (const step of steps) upsertCampaignStep(step);
  return { campaign, steps };
}

// ── Campaign editing ──────────────────────────────────────────────────────────

export async function editCampaign(
  campaignId: string,
  instruction: string,
): Promise<BuilderResponse> {
  const campaign = getCampaignById(campaignId);
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
  const steps = getCampaignSteps(campaignId);

  // Seed a new builder session with the existing campaign as context
  const session = startBuilderSession();
  const contextMsg = `Here is the existing campaign:\n\`\`\`campaign\n${JSON.stringify({ ...campaign, steps }, null, 2)}\n\`\`\``;
  session.messages.push({ role: 'assistant', content: contextMsg });
  upsertBuilderSession(session);

  // Apply the user's edit instruction
  const result = await builderChat(session.id, instruction);

  if (result.done && result.campaign) {
    // Replace steps on the original campaign ID
    deleteCampaignSteps(campaignId);
    for (const step of result.campaign.steps) {
      upsertCampaignStep({ ...step, campaign_id: campaignId });
    }
    // Update campaign metadata
    upsertCampaign({
      ...result.campaign,
      id: campaignId,
      updated_at: new Date().toISOString(),
    });
  }

  return result;
}

// ── Prospect enrollment ───────────────────────────────────────────────────────

export function enrollAllActiveProspects(campaignId: string): number {
  const campaign = getCampaignById(campaignId);
  if (!campaign || campaign.status !== 'active') return 0;

  const prospects = getActiveProspects();
  let enrolled = 0;
  const now = new Date().toISOString();

  for (const prospect of prospects) {
    const enrollment: CampaignEnrollment = {
      id: crypto.randomUUID(),
      campaign_id: campaignId,
      prospect_id: prospect.id,
      current_step: 0,
      status: 'active',
      enrolled_at: now,
    };
    try {
      enrollProspect(enrollment);
      enrolled++;
    } catch {
      // prospect already enrolled — skip
    }
  }

  logger.info({ campaignId, enrolled }, 'Prospects enrolled in campaign');
  return enrolled;
}
