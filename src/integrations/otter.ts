/**
 * Otter.ai integration — fetch transcripts via basic auth.
 *
 * Self-activates when both OTTER_USERNAME and OTTER_PASSWORD are set.
 * Otter.ai uses basic authentication on their private API.
 */

import { logger } from '../logger.js';

const BASE = 'https://otter.ai/forward/api/v1';

export interface OtterTranscript {
  otid: string;
  title: string;
  created_at: number; // unix timestamp
  summary: string;
  text?: string;
}

function authHeader(): string {
  const user = process.env.OTTER_USERNAME;
  const pass = process.env.OTTER_PASSWORD;
  if (!user || !pass) throw new Error('OTTER_USERNAME / OTTER_PASSWORD not set');
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

export function isOtterConfigured(): boolean {
  return !!(process.env.OTTER_USERNAME && process.env.OTTER_PASSWORD);
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`Otter GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getOtterTranscripts(
  limit = 20,
): Promise<OtterTranscript[]> {
  try {
    const data = await get<{ speeches: OtterTranscript[] }>('/speeches', {
      page_size: String(limit),
    });
    return data.speeches ?? [];
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch Otter transcripts');
    return [];
  }
}

export async function getOtterTranscript(otid: string): Promise<OtterTranscript | null> {
  try {
    const data = await get<{ speech: OtterTranscript }>(`/speech/${otid}`);
    return data.speech ?? null;
  } catch (err) {
    logger.warn({ err, otid }, 'Failed to fetch Otter transcript');
    return null;
  }
}
