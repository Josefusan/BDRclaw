/**
 * Web UI route tests — CAN-SPAM unsubscribe endpoint (Feature 1) and the
 * public privacy/terms compliance pages (Feature 3).
 *
 * Spins up the real `route` handler on an ephemeral port and drives it over
 * HTTP (Article IX — integration-first: real server, real SQLite).
 */

import http from 'http';
import type { AddressInfo } from 'net';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Web UI transitively imports the agent layer (quality gate → Anthropic SDK).
// Mock it so importing the server never constructs a real API client.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi
        .fn()
        .mockResolvedValue({ content: [{ type: 'text', text: 'PASS' }] }),
    };
  },
}));

process.env.BDR_UNSUBSCRIBE_SECRET = 'test-secret-fixed';
process.env.BDR_PUBLIC_URL = 'https://bdrclaw.dev';
process.env.BDR_LEGAL_NAME = 'Acme Sales LLC';
process.env.BDR_MAILING_ADDRESS = '500 Market St, San Francisco, CA 94105';

import {
  _initBDRTestDatabase,
  getProspectById,
  isProspectSuppressed,
  upsertProspect,
} from './bdr-db.js';
import { unsubscribeToken } from './email-compliance.js';
import { route } from './web-ui.js';

const PROSPECT_ID = 'sarah-acme-test';
let server: http.Server;
let base: string;

function seedProspect(): void {
  const now = new Date().toISOString();
  upsertProspect({
    id: PROSPECT_ID,
    name: 'Sarah Johnson',
    email: 'sarah@acme.test',
    company: 'Acme',
    title: 'VP Sales',
    stage: 'outreach_sent',
    source: 'manual',
    created_at: now,
    updated_at: now,
  });
}

beforeAll(async () => {
  server = http.createServer(route);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  _initBDRTestDatabase();
  seedProspect();
});

describe('GET /unsubscribe', () => {
  it('rejects an invalid token with 400', async () => {
    const res = await fetch(`${base}/unsubscribe?p=${PROSPECT_ID}&t=bogus`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body.toLowerCase()).toContain('invalid');
  });

  it('shows a confirm page for a valid token', async () => {
    const t = unsubscribeToken(PROSPECT_ID);
    const res = await fetch(`${base}/unsubscribe?p=${PROSPECT_ID}&t=${t}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<form');
    expect(body.toLowerCase()).toContain('unsubscribe');
  });
});

describe('POST /unsubscribe', () => {
  it('adds the prospect to the suppression list (one-click, query params)', async () => {
    const t = unsubscribeToken(PROSPECT_ID);
    expect(isProspectSuppressed(getProspectById(PROSPECT_ID)!)).toBe(false);

    const res = await fetch(`${base}/unsubscribe?p=${PROSPECT_ID}&t=${t}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);

    const prospect = getProspectById(PROSPECT_ID)!;
    expect(isProspectSuppressed(prospect)).toBe(true);
    expect(prospect.stage).toBe('unsubscribed');
  });

  it('suppresses via the confirm form (params in the body)', async () => {
    const t = unsubscribeToken(PROSPECT_ID);
    const res = await fetch(`${base}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ p: PROSPECT_ID, t }).toString(),
    });
    expect(res.status).toBe(200);
    expect(isProspectSuppressed(getProspectById(PROSPECT_ID)!)).toBe(true);
  });

  it('rejects a tampered token and does NOT suppress', async () => {
    const res = await fetch(`${base}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ p: PROSPECT_ID, t: 'tampered' }).toString(),
    });
    expect(res.status).toBe(400);
    expect(isProspectSuppressed(getProspectById(PROSPECT_ID)!)).toBe(false);
  });
});
