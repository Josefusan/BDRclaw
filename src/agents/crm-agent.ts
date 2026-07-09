/**
 * CRM Agent — analyzes pipeline health and drives CRM hygiene automatically.
 *
 * Reads all prospect stages, recent touch history, and hot leads. Uses the
 * Second Brain context to understand what "good" looks like, then surfaces
 * action recommendations and optionally auto-applies stage updates.
 */

import Anthropic from '@anthropic-ai/sdk';

import {
  getAllProspects,
  getRecentActivity,
  getPipelineStats,
} from '../bdr-db.js';
import { getSecondBrainSummary } from './second-brain.js';
import { logger } from '../logger.js';

const ai = new Anthropic();

export interface CRMAgentResult {
  runAt: string;
  durationMs: number;
  recommendations: CRMRecommendation[];
  pipelineHealth: 'healthy' | 'needs_attention' | 'critical';
  summary: string;
}

export interface CRMRecommendation {
  type: 'follow_up' | 'stage_change' | 're_engage' | 'close' | 'disqualify';
  prospectId?: string;
  prospectName?: string;
  company?: string;
  reason: string;
  urgency: 'high' | 'medium' | 'low';
  suggestedAction: string;
}

export async function runCRMAgent(): Promise<CRMAgentResult> {
  const start = Date.now();
  logger.info('CRM Agent starting');

  const [businessContext, prospects, stats] = await Promise.all([
    getSecondBrainSummary(),
    getAllProspects(200, 0),
    getPipelineStats(),
  ]);

  // Build a pipeline snapshot for the AI
  const stageBreakdown = prospects.reduce<Record<string, number>>((acc, p) => {
    acc[p.stage] = (acc[p.stage] ?? 0) + 1;
    return acc;
  }, {});

  const stalledProspects = prospects
    .filter((p) => {
      if (!p.last_touch_at) return true;
      const daysSince =
        (Date.now() - new Date(p.last_touch_at).getTime()) / 86400000;
      return (
        daysSince > 7 &&
        !['unsubscribed', 'not_interested', 'meeting_booked'].includes(p.stage)
      );
    })
    .slice(0, 20)
    .map((p) => ({
      id: p.id,
      name: p.name,
      company: p.company,
      stage: p.stage,
      lastTouch: p.last_touch_at,
    }));

  const hotLeads = prospects
    .filter((p) => p.stage === 'interested')
    .slice(0, 10);

  const prompt = `You are an elite CRM analyst reviewing the sales pipeline for this business:

${businessContext}

Pipeline Snapshot:
${JSON.stringify({ stageBreakdown, totalProspects: prospects.length, stats }, null, 2)}

Stalled prospects (>7 days no touch, not disqualified):
${JSON.stringify(stalledProspects, null, 2)}

Hot leads (interested stage):
${JSON.stringify(
  hotLeads.map((p) => ({ id: p.id, name: p.name, company: p.company })),
  null,
  2,
)}

Analyze the pipeline and return a JSON object with these exact fields:
{
  "pipelineHealth": "healthy|needs_attention|critical",
  "summary": "2-3 sentence executive summary of pipeline health and top priorities",
  "recommendations": [
    {
      "type": "follow_up|stage_change|re_engage|close|disqualify",
      "prospectId": "id or null",
      "prospectName": "name or null",
      "company": "company or null",
      "reason": "why this action is needed",
      "urgency": "high|medium|low",
      "suggestedAction": "specific next step to take"
    }
  ]
}

Return at most 10 recommendations. Prioritize hot leads and long-stalled prospects. Respond with ONLY the JSON object.`;

  const msg = await ai.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0];
  if (raw.type !== 'text') throw new Error('Unexpected AI response type');

  let parsed: {
    pipelineHealth: CRMAgentResult['pipelineHealth'];
    summary: string;
    recommendations: CRMRecommendation[];
  };
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    logger.error({ raw: raw.text }, 'CRM Agent JSON parse failed');
    parsed = {
      pipelineHealth: 'needs_attention',
      summary: raw.text.slice(0, 200),
      recommendations: [],
    };
  }

  const result: CRMAgentResult = {
    runAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    ...parsed,
  };

  logger.info(
    { health: result.pipelineHealth, recs: result.recommendations.length },
    'CRM Agent complete',
  );
  return result;
}
