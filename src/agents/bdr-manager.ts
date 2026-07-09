/**
 * BDR Manager Agent — the oversight layer.
 *
 * Reviews all agent outputs, pipeline metrics, and Second Brain goals
 * to produce a daily/weekly management summary: what's working, what's broken,
 * where to focus attention, and what to adjust in strategy or messaging.
 *
 * Think of this as a VP of Sales reading the morning report.
 */

import Anthropic from '@anthropic-ai/sdk';

import { getPipelineStats, getRecentActivity, listCampaigns } from '../bdr-db.js';
import { getSecondBrainConfig, getSecondBrainSummary } from './second-brain.js';
import { getClosedDealsRevenue } from '../deals-db.js';
import { logger } from '../logger.js';

const ai = new Anthropic();

export interface BDRManagerReport {
  runAt: string;
  durationMs: number;
  period: 'daily' | 'weekly';
  overallStatus: 'on_track' | 'behind' | 'ahead' | 'critical';
  executiveSummary: string;
  wins: string[];
  gaps: string[];
  focusAreas: Array<{ area: string; action: string; priority: 'high' | 'medium' | 'low' }>;
  messagingNotes: string[];
  forecastNotes: string;
}

export async function runBDRManager(period: 'daily' | 'weekly' = 'daily'): Promise<BDRManagerReport> {
  const start = Date.now();
  logger.info({ period }, 'BDR Manager starting');

  const [businessContext, config, stats, campaigns, activity, revenue] = await Promise.all([
    getSecondBrainSummary(),
    getSecondBrainConfig(),
    getPipelineStats(),
    listCampaigns(),
    getRecentActivity(50),
    getClosedDealsRevenue(period === 'weekly' ? 7 : 1),
  ]);

  const activeCampaigns = campaigns.filter(c => c.status === 'active');
  const recentReplies = activity.filter(a => a.type === 'replied');
  const hotLeads = activity.filter(a => a.type === 'hot_lead');

  const prompt = `You are an elite VP of Sales reviewing ${period} performance for this business:

${businessContext}

Goals:
- Monthly revenue goal: ${config.monthlyRevenueGoal ?? 'not set'}
- Monthly lead goal: ${config.monthlyLeadGoal ?? 'not set'}
- Quarterly goal: ${config.quarterlyGoal ?? 'not set'}

${period.charAt(0).toUpperCase() + period.slice(1)} Data:
- Revenue closed: $${revenue.total.toLocaleString()}
- Deals closed: ${revenue.count}
- Hot leads generated: ${hotLeads.length}
- Replies received: ${recentReplies.length}
- Active campaigns: ${activeCampaigns.length}
- Total pipeline: ${JSON.stringify(stats, null, 2)}

Return a JSON object with these exact fields:
{
  "overallStatus": "on_track|behind|ahead|critical",
  "executiveSummary": "3-4 sentence plain-English status report a business owner would understand",
  "wins": ["win 1", "win 2"],
  "gaps": ["gap 1", "gap 2"],
  "focusAreas": [
    { "area": "area name", "action": "specific thing to do", "priority": "high|medium|low" }
  ],
  "messagingNotes": ["observation about outreach effectiveness", "what to test next"],
  "forecastNotes": "1-2 sentence revenue/meeting forecast for next period"
}

Be direct and specific. No corporate fluff. Respond with ONLY the JSON object.`;

  const msg = await ai.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0];
  if (raw.type !== 'text') throw new Error('Unexpected AI response type');

  let parsed: Omit<BDRManagerReport, 'runAt' | 'durationMs' | 'period'>;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    logger.error({ raw: raw.text }, 'BDR Manager JSON parse failed');
    parsed = { overallStatus: 'behind', executiveSummary: raw.text.slice(0, 300), wins: [], gaps: [], focusAreas: [], messagingNotes: [], forecastNotes: '' };
  }

  const result: BDRManagerReport = {
    runAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    period,
    ...parsed,
  };

  logger.info({ status: result.overallStatus }, 'BDR Manager report complete');
  return result;
}
