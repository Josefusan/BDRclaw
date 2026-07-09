/**
 * Instantly.ai integration — push leads and sync campaigns.
 *
 * Self-registers when INSTANTLY_API_KEY is set in the environment.
 * API reference: https://developer.instantly.ai/
 */

import { logger } from '../logger.js';

const BASE = 'https://api.instantly.ai/api/v1';

let apiKey: string | null = null;

export function registerInstantly(): void {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) {
    logger.debug('INSTANTLY_API_KEY not set — Instantly integration disabled');
    return;
  }
  apiKey = key;
  logger.info('Instantly integration registered');
}

export function isInstantlyConfigured(): boolean {
  return apiKey !== null;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  if (!apiKey) throw new Error('Instantly not configured');
  const res = await fetch(`${BASE}${path}&api_key=${apiKey}`);
  if (!res.ok) throw new Error(`Instantly GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  if (!apiKey) throw new Error('Instantly not configured');
  const res = await fetch(`${BASE}${path}?api_key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Instantly POST ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface InstantlyCampaign {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

export async function getInstantlyCampaigns(): Promise<InstantlyCampaign[]> {
  const data = await get<{ campaigns: InstantlyCampaign[] }>('/campaign/list?');
  return data.campaigns ?? [];
}

export interface InstantlyLeadPayload {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  personalization?: string;
  campaign_id?: string;
  [key: string]: unknown;
}

export interface InstantlyLeadResult {
  id: string;
  email: string;
}

export async function pushLeadToInstantly(
  lead: InstantlyLeadPayload,
): Promise<InstantlyLeadResult> {
  return post<InstantlyLeadResult>('/lead/add', lead);
}

export async function syncProspects(
  prospects: InstantlyLeadPayload[],
  campaignId?: string,
): Promise<{ pushed: number; errors: number }> {
  let pushed = 0;
  let errors = 0;
  for (const p of prospects) {
    try {
      await pushLeadToInstantly({ ...p, campaign_id: campaignId });
      pushed++;
    } catch (err) {
      logger.warn({ err, email: p.email }, 'Instantly lead push failed');
      errors++;
    }
  }
  logger.info({ pushed, errors }, 'Instantly sync complete');
  return { pushed, errors };
}
