/**
 * Second Brain — business knowledge store and context synthesizer.
 *
 * Stores everything about the user's business (who, what, why, how, ICP,
 * messaging style, goals). Every other agent reads from this before acting.
 * Context is persisted in SQLite via the bdr_second_brain table.
 */

import Anthropic from '@anthropic-ai/sdk';

import { getBdrDb } from '../bdr-db.js';
import { logger } from '../logger.js';

const ai = new Anthropic();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SecondBrainConfig {
  // Business identity
  businessName: string;
  industry: string;
  foundedYear?: string;
  teamSize?: string;
  website?: string;

  // What / Why / How
  whatYouDo: string;
  whyYouExist: string;
  howYouDeliver: string;

  // Offer
  coreOffer: string;
  pricingModel: string;
  avgDealSize?: string;
  salesCycleLength?: string;

  // ICP — who you reach out to
  icpDescription: string;
  icpIndustries: string;
  icpJobTitles: string;
  icpCompanySize: string;
  icpPainPoints: string;

  // Goals
  monthlyRevenueGoal?: string;
  monthlyLeadGoal?: string;
  quarterlyGoal?: string;

  // Messaging style
  messageTone: string; // 'professional' | 'casual' | 'bold' | 'empathetic'
  messageSentiment: string; // 'consultative' | 'challenger' | 'educational' | 'direct'
  keyDifferentiators: string;
  proofPoints: string; // case studies, numbers, logos
  callToAction: string;

  // Competitors
  mainCompetitors?: string;
  competitiveAdvantage?: string;

  updatedAt: string;
}

export interface SecondBrainContext {
  config: SecondBrainConfig;
  summary: string; // Claude-generated distillation for agent prompts
}

// ── DB helpers ────────────────────────────────────────────────────────────────

const KEYS = [
  'businessName',
  'industry',
  'foundedYear',
  'teamSize',
  'website',
  'whatYouDo',
  'whyYouExist',
  'howYouDeliver',
  'coreOffer',
  'pricingModel',
  'avgDealSize',
  'salesCycleLength',
  'icpDescription',
  'icpIndustries',
  'icpJobTitles',
  'icpCompanySize',
  'icpPainPoints',
  'monthlyRevenueGoal',
  'monthlyLeadGoal',
  'quarterlyGoal',
  'messageTone',
  'messageSentiment',
  'keyDifferentiators',
  'proofPoints',
  'callToAction',
  'mainCompetitors',
  'competitiveAdvantage',
  'updatedAt',
] as const;

export function getSecondBrainConfig(): Partial<SecondBrainConfig> {
  const db = getBdrDb();
  const rows = db.prepare('SELECT key, value FROM bdr_second_brain').all() as {
    key: string;
    value: string;
  }[];
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result as Partial<SecondBrainConfig>;
}

export function saveSecondBrainConfig(
  config: Partial<SecondBrainConfig>,
): void {
  const db = getBdrDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO bdr_second_brain (key, value, updated_at)
    VALUES (?, ?, ?)
  `);
  const now = new Date().toISOString();
  const upsertMany = db.transaction((entries: [string, string][]) => {
    for (const [k, v] of entries) stmt.run(k, v, now);
  });
  const entries = Object.entries(config)
    .filter(([k]) => KEYS.includes(k as (typeof KEYS)[number]))
    .map(([k, v]) => [k, String(v ?? '')] as [string, string]);
  upsertMany(entries);
  logger.info({ keys: entries.map(([k]) => k) }, 'Second Brain config saved');
}

// ── Context synthesis ─────────────────────────────────────────────────────────

let _cachedSummary: { text: string; generatedAt: string } | null = null;

export async function getSecondBrainSummary(
  forceRefresh = false,
): Promise<string> {
  if (!forceRefresh && _cachedSummary) {
    const ageMs = Date.now() - new Date(_cachedSummary.generatedAt).getTime();
    if (ageMs < 30 * 60 * 1000) return _cachedSummary.text; // 30 min cache
  }

  const config = getSecondBrainConfig();
  if (!config.whatYouDo && !config.businessName) {
    return 'No business context configured yet. Ask the user to fill in the Second Brain.';
  }

  const prompt = `You are a sales intelligence system. Based on this business profile, write a concise 2-paragraph briefing (max 200 words) that any AI sales agent can read to immediately understand: what this business does, who they sell to, what outcomes they deliver, and the exact tone and style to use in outreach.

Business Profile:
${JSON.stringify(config, null, 2)}

Write the briefing in third person, present tense. Be specific. Include their ICP and messaging style.`;

  const msg = await ai.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const text =
    msg.content[0].type === 'text'
      ? msg.content[0].text
      : 'Context unavailable.';
  _cachedSummary = { text, generatedAt: new Date().toISOString() };
  logger.info('Second Brain summary refreshed');
  return text;
}

export function invalidateSecondBrainCache(): void {
  _cachedSummary = null;
}
