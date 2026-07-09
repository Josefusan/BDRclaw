/**
 * Salesforge integration — push contacts and sync sequences.
 *
 * Self-registers when SALESFORGE_API_KEY is set in the environment.
 */

import { logger } from '../logger.js';

const BASE = 'https://api.salesforge.ai/public/api/v1';

let apiKey: string | null = null;

export function registerSalesforge(): void {
  const key = process.env.SALESFORGE_API_KEY;
  if (!key) {
    logger.debug('SALESFORGE_API_KEY not set — Salesforge integration disabled');
    return;
  }
  apiKey = key;
  logger.info('Salesforge integration registered');
}

export function isSalesforgeConfigured(): boolean {
  return apiKey !== null;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!apiKey) throw new Error('Salesforge not configured');
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforge ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SalesforgeSequence {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

export async function getSalesforgeSequences(): Promise<SalesforgeSequence[]> {
  const data = await request<{ data: SalesforgeSequence[] }>('GET', '/sequences');
  return data.data ?? [];
}

export interface SalesforgeContact {
  email: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  title?: string;
  personalization?: string;
  sequenceId?: string;
  [key: string]: unknown;
}

export interface SalesforgeContactResult {
  id: string;
  email: string;
}

export async function pushToSalesforge(
  contact: SalesforgeContact,
): Promise<SalesforgeContactResult> {
  return request<SalesforgeContactResult>('POST', '/contacts', contact);
}

export async function syncFromSalesforge(): Promise<SalesforgeContact[]> {
  const data = await request<{ data: SalesforgeContact[] }>('GET', '/contacts');
  return data.data ?? [];
}

export async function syncProspects(
  contacts: SalesforgeContact[],
  sequenceId?: string,
): Promise<{ pushed: number; errors: number }> {
  let pushed = 0;
  let errors = 0;
  for (const c of contacts) {
    try {
      await pushToSalesforge({ ...c, sequenceId });
      pushed++;
    } catch (err) {
      logger.warn({ err, email: c.email }, 'Salesforge contact push failed');
      errors++;
    }
  }
  logger.info({ pushed, errors }, 'Salesforge sync complete');
  return { pushed, errors };
}
