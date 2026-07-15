/**
 * Dashboard API contract tests — the endpoints Fable-B's UI is built against.
 *
 * Covers /api/channels/status (new shape), /api/settings/env, /api/suppression,
 * plus sanity checks on /api/stats, /api/prospects, /api/activity, /api/health
 * and the prospect write endpoints. Real `route` handler over real HTTP with a
 * real in-memory SQLite database (Article IX — integration-first).
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

// Deterministic channel env: telegram fully configured (valid token format),
// everything else unconfigured.
const CHANNEL_ENV_VARS = [
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_ACCOUNT_1',
  'GMAIL_ACCOUNT_2',
  'GMAIL_ACCOUNT_3',
  'LINKEDIN_ENABLED',
  'LINKEDIN_ACCOUNT_1_EMAIL',
  'LINKEDIN_ACCOUNT_1_PASSWORD',
  'TWITTER_ENABLED',
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_TOKEN_SECRET',
  'INSTAGRAM_ENABLED',
  'INSTAGRAM_ACCESS_TOKEN',
  'INSTAGRAM_ACCOUNT_ID',
  'TELEGRAM_BOT_TOKEN',
  'SMS_ENABLED',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'TWILIO_WHATSAPP_NUMBER',
];
for (const name of CHANNEL_ENV_VARS) delete process.env[name];
process.env.TELEGRAM_BOT_TOKEN =
  '123456789:AAF0abcdefghijklmnopqrstuvwxyz012345';

import {
  _initBDRTestDatabase,
  addProspect,
  addProspectToSuppression,
  getProspectById,
  recordTouch,
} from './bdr-db.js';
import { route } from './web-ui.js';

let server: http.Server;
let base: string;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Parse a fetch Response body as JSON (loosely typed for assertions). */
async function asJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

/** GET a path and parse the JSON body. */
async function fetchJson(url: string): Promise<any> {
  return asJson(await fetch(url));
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
});

const ALL_CHANNELS = [
  'email',
  'linkedin',
  'twitter',
  'instagram',
  'telegram',
  'whatsapp',
  'sms',
];

describe('GET /api/channels/status', () => {
  it('returns all seven channels in the contract shape', async () => {
    const res = await fetch(`${base}/api/channels/status`);
    expect(res.status).toBe(200);
    const body = await asJson(res);

    expect(Array.isArray(body.channels)).toBe(true);
    expect(body.channels.map((c: { channel: string }) => c.channel)).toEqual(
      ALL_CHANNELS,
    );
    for (const c of body.channels) {
      expect(typeof c.configured).toBe('boolean');
      expect(typeof c.verified).toBe('boolean');
      expect(typeof c.dailyLimit).toBe('number');
      expect(typeof c.usedToday).toBe('number');
    }
  });

  it('marks telegram configured+verified (valid token format), sms unconfigured', async () => {
    const res = await fetch(`${base}/api/channels/status`);
    const body = await asJson(res);
    const byName = Object.fromEntries(
      body.channels.map((c: { channel: string }) => [c.channel, c]),
    );

    expect(byName.telegram.configured).toBe(true);
    expect(byName.telegram.verified).toBe(true);
    expect(byName.telegram.dailyLimit).toBe(200);

    expect(byName.sms.configured).toBe(false);
    expect(byName.sms.verified).toBe(false);

    // never verified when unconfigured — never fake it
    expect(byName.email.configured).toBe(false);
    expect(byName.email.verified).toBe(false);
    expect(byName.linkedin.dailyLimit).toBe(50); // DM cap, not connreq cap
  });

  it('counts today outbound touches per channel in usedToday', async () => {
    const p = addProspect({ name: 'Amy Lee', company: 'Globex', title: 'CTO' });
    recordTouch({
      id: 't-1',
      prospect_id: p.id,
      channel: 'email',
      direction: 'outbound',
      content: 'hello',
      status: 'sent',
      sent_at: new Date().toISOString(),
    });
    recordTouch({
      id: 't-2',
      prospect_id: p.id,
      channel: 'email',
      direction: 'inbound', // inbound must NOT count
      content: 'reply',
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    const res = await fetch(`${base}/api/channels/status`);
    const body = await asJson(res);
    const email = body.channels.find(
      (c: { channel: string }) => c.channel === 'email',
    );
    expect(email.usedToday).toBe(1);
  });
});

describe('GET /api/settings/env', () => {
  it('returns missing env var NAMES per channel, never values', async () => {
    const res = await fetch(`${base}/api/settings/env`);
    expect(res.status).toBe(200);
    const body = await asJson(res);

    const byName = Object.fromEntries(
      body.channels.map((c: { channel: string }) => [c.channel, c]),
    );
    expect(byName.telegram.missing).toEqual([]);
    expect(byName.sms.missing).toContain('SMS_ENABLED');
    expect(byName.sms.missing).toContain('TWILIO_ACCOUNT_SID');
    expect(byName.email.missing).toContain('GMAIL_CLIENT_ID');

    // No env VALUES anywhere in the response.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(process.env.TELEGRAM_BOT_TOKEN!);
  });
});

describe('GET /api/suppression', () => {
  it('returns count and entries', async () => {
    const empty = await fetchJson(`${base}/api/suppression`);
    expect(empty).toEqual({ count: 0, entries: [] });

    const p = addProspect({
      name: 'Bob Ray',
      company: 'Initech',
      title: 'VP',
      email: 'bob@initech.test',
    });
    addProspectToSuppression(getProspectById(p.id)!, 'unsubscribe:test');

    const res = await fetch(`${base}/api/suppression`);
    const body = await asJson(res);
    expect(body.count).toBeGreaterThanOrEqual(2); // id: + email: keys
    expect(body.entries.length).toBe(body.count);
    expect(body.entries[0]).toHaveProperty('contact');
    expect(body.entries[0]).toHaveProperty('reason', 'unsubscribe:test');
    expect(body.entries[0]).toHaveProperty('created_at');
  });
});

describe('existing dashboard endpoints stay sane', () => {
  it('GET /api/stats returns by_stage counts', async () => {
    addProspect({ name: 'Cal Poe', company: 'Hooli', title: 'CEO' });
    const body = await fetchJson(`${base}/api/stats`);
    expect(body.by_stage).toMatchObject({ identified: 1 });
    expect(body).toHaveProperty('total_active');
    expect(body).toHaveProperty('today');
  });

  it('GET /api/health returns ok', async () => {
    const body = await fetchJson(`${base}/api/health`);
    expect(body.status).toBe('ok');
  });

  it('GET /api/prospects supports search and stage filter', async () => {
    addProspect({ name: 'Dana Fox', company: 'Vandelay', title: 'COO' });
    const all = await fetchJson(`${base}/api/prospects`);
    expect(all.length).toBe(1);

    const search = await fetchJson(`${base}/api/prospects?q=Vandelay`);
    expect(search.length).toBe(1);

    const staged = await fetchJson(`${base}/api/prospects?stage=identified`);
    expect(staged.length).toBe(1);

    const none = await fetchJson(`${base}/api/prospects?stage=meeting_booked`);
    expect(none.length).toBe(0);
  });

  it('GET /api/activity returns an array', async () => {
    const body = await fetchJson(`${base}/api/activity`);
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/campaigns returns an array', async () => {
    const body = await fetchJson(`${base}/api/campaigns`);
    expect(Array.isArray(body)).toBe(true);
  });

  it('POST /api/prospects creates a prospect (201) and validates input (400)', async () => {
    const created = await fetch(`${base}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Eve Kim',
        company: 'Umbrella',
        title: 'CISO',
      }),
    });
    expect(created.status).toBe(201);
    const prospect = await asJson(created);
    expect(prospect.id).toBeTruthy();

    const bad = await fetch(`${base}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Company' }),
    });
    expect(bad.status).toBe(400);
  });

  it('POST /api/prospects/import imports rows and reports row errors', async () => {
    const res = await fetch(`${base}/api/prospects/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { name: 'Gus Orr', company: 'Stark', title: 'VP Eng' },
        { name: 'missing fields' },
      ]),
    });
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.imported).toBe(1);
    expect(body.errors.length).toBe(1);
  });
});
