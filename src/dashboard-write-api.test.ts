/**
 * Dashboard WRITE-path contract tests — loop control, prospect detail +
 * stage change + suppress, campaign pause, and suppression ops.
 *
 * Real `route` handler over real HTTP with a real in-memory SQLite database
 * (Article IX — integration-first). Same harness as dashboard-api.test.ts.
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

import {
  _initBDRTestDatabase,
  addProspect,
  getCampaignById,
  getCampaignSteps,
  getProspectById,
  getSuppressionList,
  isProspectSuppressed,
  recordTouch,
  upsertCampaign,
  upsertCampaignStep,
} from './bdr-db.js';
import { registerActionHandler } from './bdr-brain.js';
import { stopAgenticLoop } from './agents/loop.js';
import { route } from './web-ui.js';

let server: http.Server;
let base: string;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function asJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = http.createServer(route);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  stopAgenticLoop(); // safety: never leave a scheduler timer behind
  server.close();
});

beforeEach(() => {
  _initBDRTestDatabase();
});

// ── Loop control (ISC-68, ISC-79) ────────────────────────────────────────────
// Order matters inside this describe: the "no channels" test must run BEFORE
// any action handler is registered (the registry is module-global).

describe('POST /api/loop/start + /api/loop/stop', () => {
  it('refuses to start when no channel action handlers are loaded (honest 409)', async () => {
    const res = await post('/api/loop/start');
    expect(res.status).toBe(409);
    const body = await asJson(res);
    expect(String(body.error).toLowerCase()).toContain('channels not loaded');
    expect(String(body.error).toLowerCase()).toContain('daemon');

    // Health must still report the loop as stopped.
    const health = await asJson(await fetch(`${base}/api/health`));
    expect(health.loop.running).toBe(false);
  });

  it('starts and stops the loop; /api/health reflects the truth', async () => {
    // Simulate a loaded channel skill (what bootstrap.ts does at boot).
    registerActionHandler('send_email', async () => {});

    const started = await post('/api/loop/start');
    expect(started.status).toBe(200);
    const startedBody = await asJson(started);
    expect(startedBody.ok).toBe(true);
    expect(startedBody.loop.running).toBe(true);

    let health = await asJson(await fetch(`${base}/api/health`));
    expect(health.loop.running).toBe(true);

    // Idempotent start
    const again = await post('/api/loop/start');
    expect(again.status).toBe(200);
    expect((await asJson(again)).loop.running).toBe(true);

    const stopped = await post('/api/loop/stop');
    expect(stopped.status).toBe(200);
    const stoppedBody = await asJson(stopped);
    expect(stoppedBody.ok).toBe(true);
    expect(stoppedBody.loop.running).toBe(false);

    health = await asJson(await fetch(`${base}/api/health`));
    expect(health.loop.running).toBe(false);

    // Idempotent stop (safe when not running)
    const stopAgain = await post('/api/loop/stop');
    expect(stopAgain.status).toBe(200);
    expect((await asJson(stopAgain)).loop.running).toBe(false);
  });
});

// ── Prospect detail (ISC-69) ─────────────────────────────────────────────────

describe('GET /api/prospects/:id', () => {
  it('returns the prospect with its full touch timeline and suppression flag', async () => {
    const p = addProspect({
      name: 'Sarah Johnson',
      company: 'Acme',
      title: 'VP Sales',
      email: 'sarah@acme.test',
    });
    recordTouch({
      id: 'touch-1',
      prospect_id: p.id,
      channel: 'email',
      direction: 'outbound',
      content: 'Hi Sarah — quick question',
      subject: 'Quick question',
      status: 'sent',
      sent_at: '2026-07-01T10:00:00.000Z',
    });
    recordTouch({
      id: 'touch-2',
      prospect_id: p.id,
      channel: 'email',
      direction: 'inbound',
      content: 'Tell me more',
      status: 'sent',
      sent_at: '2026-07-02T09:00:00.000Z',
    });

    const res = await fetch(`${base}/api/prospects/${p.id}`);
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.id).toBe(p.id);
    expect(body.name).toBe('Sarah Johnson');
    expect(body.suppressed).toBe(false);
    expect(Array.isArray(body.touches)).toBe(true);
    expect(body.touches.length).toBe(2);
    // Chronological (ASC) — the DB contract from getTouchesForProspect.
    expect(body.touches[0].id).toBe('touch-1');
    expect(body.touches[0].direction).toBe('outbound');
    expect(body.touches[1].direction).toBe('inbound');
  });

  it('404s for an unknown id', async () => {
    const res = await fetch(`${base}/api/prospects/nope`);
    expect(res.status).toBe(404);
  });
});

// ── Stage change (ISC-77) — routes through updateProspectStage ───────────────

describe('PATCH /api/prospects/:id stage change', () => {
  it('persists a valid stage change and returns the updated prospect', async () => {
    const p = addProspect({ name: 'Amy Lee', company: 'Globex', title: 'CTO' });
    const res = await patch(`/api/prospects/${p.id}`, {
      stage: 'meeting_booked',
    });
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.ok).toBe(true);
    expect(body.prospect.stage).toBe('meeting_booked');
    expect(getProspectById(p.id)!.stage).toBe('meeting_booked');
  });

  it('rejects an invalid stage with 400 and does not modify the prospect', async () => {
    const p = addProspect({ name: 'Bob Ray', company: 'Initech', title: 'VP' });
    const res = await patch(`/api/prospects/${p.id}`, { stage: 'yolo' });
    expect(res.status).toBe(400);
    expect(getProspectById(p.id)!.stage).toBe('identified');
  });
});

// ── Suppress from the drawer ─────────────────────────────────────────────────

describe('POST /api/prospects/:id/suppress', () => {
  it('suppresses every contact key and moves the prospect to unsubscribed', async () => {
    const p = addProspect({
      name: 'Cal Poe',
      company: 'Hooli',
      title: 'CEO',
      email: 'cal@hooli.test',
    });
    expect(isProspectSuppressed(getProspectById(p.id)!)).toBe(false);

    const res = await post(`/api/prospects/${p.id}/suppress`);
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.ok).toBe(true);

    const after = getProspectById(p.id)!;
    expect(isProspectSuppressed(after)).toBe(true);
    expect(after.stage).toBe('unsubscribed');
  });

  it('404s for an unknown id', async () => {
    const res = await post('/api/prospects/nope/suppress');
    expect(res.status).toBe(404);
  });
});

// ── Suppression ops (ISC-78) ─────────────────────────────────────────────────

describe('POST /api/suppression', () => {
  it('adds a manual contact entry visible in GET /api/suppression', async () => {
    const res = await post('/api/suppression', {
      channel: 'email',
      contact: 'blocked@example.test',
    });
    expect(res.status).toBe(201);
    const body = await asJson(res);
    expect(body.ok).toBe(true);
    expect(body.entry.contact).toBe('email:blocked@example.test');

    const list = await asJson(await fetch(`${base}/api/suppression`));
    expect(list.count).toBe(1);
    expect(list.entries[0].contact).toBe('email:blocked@example.test');
    expect(list.entries[0].channel).toBe('email');

    // And the DB agrees.
    expect(getSuppressionList().length).toBe(1);
  });

  it('normalizes into the enforcement key namespace (sms → phone:, no leading +)', async () => {
    const res = await post('/api/suppression', {
      channel: 'sms',
      contact: '+15550001111',
    });
    expect(res.status).toBe(201);
    const body = await asJson(res);
    // Must match prospectContactKeys() format or it would never be enforced.
    expect(body.entry.contact).toBe('phone:15550001111');

    // A prospect with that phone number is now actually suppressed.
    const p = addProspect({
      name: 'Dana Fox',
      company: 'Vandelay',
      title: 'COO',
      phone: '+15550001111',
    });
    expect(isProspectSuppressed(getProspectById(p.id)!)).toBe(true);
  });

  it('rejects a missing contact (400), missing channel (400), unknown channel (400)', async () => {
    const noContact = await post('/api/suppression', { channel: 'email' });
    expect(noContact.status).toBe(400);

    const noChannel = await post('/api/suppression', { contact: 'x@y.test' });
    expect(noChannel.status).toBe(400);

    const badChannel = await post('/api/suppression', {
      channel: 'carrier-pigeon',
      contact: 'x@y.test',
    });
    expect(badChannel.status).toBe(400);

    expect(getSuppressionList().length).toBe(0);
  });
});

// ── Campaign pause (ISC-70) ──────────────────────────────────────────────────

describe('PATCH /api/campaigns/:id status', () => {
  function seedCampaign(status: 'draft' | 'active' = 'active'): string {
    const now = new Date().toISOString();
    upsertCampaign({
      id: 'camp-1',
      name: 'Test Campaign',
      status,
      tone: 'friendly',
      jitter_minutes: 0,
      created_at: now,
      updated_at: now,
    } as never);
    return 'camp-1';
  }

  it('pauses an active campaign', async () => {
    const id = seedCampaign('active');
    const res = await patch(`/api/campaigns/${id}`, { status: 'paused' });
    expect(res.status).toBe(200);
    expect((await asJson(res)).ok).toBe(true);
    expect(getCampaignById(id)!.status).toBe('paused');
  });

  it('rejects an unknown status with 400 and leaves the campaign untouched', async () => {
    const id = seedCampaign('active');
    const res = await patch(`/api/campaigns/${id}`, { status: 'nonsense' });
    expect(res.status).toBe(400);
    expect(getCampaignById(id)!.status).toBe('active');
  });

  it('activating a campaign preserves its steps (regression: upsertCampaign must not cascade-delete)', async () => {
    // Regression guard for the INSERT OR REPLACE → ON DELETE CASCADE bug that
    // wiped every step on any campaign update, leaving the loop nothing to send.
    const id = seedCampaign('draft');
    upsertCampaignStep({
      id: `${id}-s1`,
      campaign_id: id,
      step_number: 1,
      action_type: 'send_sms',
      delay_days: 0,
      template: 'Hi {{firstName}}',
      condition: 'always',
    } as never);
    expect(getCampaignSteps(id)).toHaveLength(1);

    const res = await patch(`/api/campaigns/${id}`, { status: 'active' });
    expect(res.status).toBe(200);
    expect(getCampaignById(id)!.status).toBe('active');
    // The step must survive the activation.
    expect(getCampaignSteps(id)).toHaveLength(1);
  });
});
