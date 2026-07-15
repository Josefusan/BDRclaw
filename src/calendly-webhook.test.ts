/**
 * Calendly booking webhook + CSRF guard contract tests (ISC-80/81/82).
 *
 * Real `route` handler over real HTTP with a real in-memory SQLite database —
 * same harness as dashboard-write-api.test.ts.
 *
 * Doctrine under test: a meeting is booked when Calendly says so
 * (invitee.created), never when a link is merely sent. The webhook is the
 * ONLY automated writer of stage 'meeting_booked'.
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Web UI transitively imports the agent layer (quality gate → Anthropic SDK).
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
  getProspectById,
  getTouchesForProspect,
} from './bdr-db.js';
import { stopAgenticLoop } from './agents/loop.js';
import { route } from './web-ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: http.Server;
let base: string;

async function post(
  urlPath: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function seedProspect(email: string): string {
  const prospect = addProspect({
    name: 'Pat Bookwell',
    email,
    company: 'Bookwell Co',
    title: 'CEO',
    source: 'manual',
  });
  return prospect.id;
}

function inviteeCreated(email: string, uri?: string): unknown {
  return {
    event: 'invitee.created',
    payload: {
      uri:
        uri ??
        `https://api.calendly.com/scheduled_events/x/invitees/${crypto.randomUUID()}`,
      email,
      name: 'Pat Bookwell',
      scheduled_event: {
        uri: 'https://api.calendly.com/scheduled_events/x',
        start_time: '2026-07-20T17:00:00Z',
      },
    },
  };
}

beforeAll(async () => {
  server = http.createServer(route);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  stopAgenticLoop();
  server.close();
});

beforeEach(() => {
  _initBDRTestDatabase();
  delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
});

afterEach(() => {
  delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
});

describe('POST /api/webhooks/calendly (ISC-82)', () => {
  it('books the meeting: matches invitee email, sets meeting_booked, records an inbound touch', async () => {
    const id = seedProspect('pat@bookwell.co');

    const res = await post(
      '/api/webhooks/calendly',
      inviteeCreated('pat@bookwell.co'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      matched: boolean;
      prospectId: string;
    };
    expect(body.matched).toBe(true);
    expect(body.prospectId).toBe(id);

    const prospect = getProspectById(id);
    expect(prospect?.stage).toBe('meeting_booked');

    const touches = getTouchesForProspect(id);
    const inbound = touches.filter((t) => t.direction === 'inbound');
    expect(inbound).toHaveLength(1);
    expect(inbound[0].content).toContain('Calendly booking confirmed');
  });

  it('is idempotent: a Calendly retry of the same invitee URI is a no-op duplicate', async () => {
    const id = seedProspect('pat@bookwell.co');
    const payload = inviteeCreated('pat@bookwell.co');

    await post('/api/webhooks/calendly', payload);
    const retry = await post('/api/webhooks/calendly', payload);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { duplicate?: boolean }).duplicate).toBe(
      true,
    );

    const inbound = getTouchesForProspect(id).filter(
      (t) => t.direction === 'inbound',
    );
    expect(inbound).toHaveLength(1);
  });

  it('answers 200 matched:false for an unknown invitee so Calendly never retries forever', async () => {
    const res = await post(
      '/api/webhooks/calendly',
      inviteeCreated('stranger@nowhere.io'),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { matched?: boolean }).matched).toBe(false);
  });

  it('ignores non-booking events', async () => {
    const res = await post('/api/webhooks/calendly', {
      event: 'invitee.canceled',
      payload: {},
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ignored?: string }).ignored).toBe(
      'invitee.canceled',
    );
  });

  it('rejects a bad signature when CALENDLY_WEBHOOK_SIGNING_KEY is set, accepts a valid one', async () => {
    process.env.CALENDLY_WEBHOOK_SIGNING_KEY = 'test-signing-key';
    seedProspect('pat@bookwell.co');
    const payload = inviteeCreated('pat@bookwell.co');
    const raw = JSON.stringify(payload);

    const bad = await fetch(`${base}/api/webhooks/calendly`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'calendly-webhook-signature': 't=123,v1=deadbeef',
      },
      body: raw,
    });
    expect(bad.status).toBe(401);

    const t = String(Date.now());
    const v1 = crypto
      .createHmac('sha256', 'test-signing-key')
      .update(`${t}.${raw}`)
      .digest('hex');
    const good = await fetch(`${base}/api/webhooks/calendly`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'calendly-webhook-signature': `t=${t},v1=${v1}`,
      },
      body: raw,
    });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { matched?: boolean }).matched).toBe(true);
  });
});

describe('CSRF origin guard on mutating routes', () => {
  it('rejects a cross-origin POST with 403', async () => {
    const res = await post(
      '/api/suppression',
      { channel: 'email', contact: 'x@y.z' },
      { Origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
  });

  it('allows a same-origin POST and an origin-less (server-to-server) POST', async () => {
    const sameOrigin = await post(
      '/api/suppression',
      { channel: 'email', contact: 'same@origin.ok' },
      { Origin: base },
    );
    expect(sameOrigin.status).toBe(201);

    // No Origin header — how Calendly/Twilio/mail providers call us.
    const serverToServer = await post('/api/webhooks/calendly', {
      event: 'invitee.canceled',
      payload: {},
    });
    expect(serverToServer.status).toBe(200);
  });
});

describe('single-writer invariant: only the Calendly webhook books a meeting (ISC-80/81)', () => {
  it("no automated code path other than web-ui's webhook writes stage 'meeting_booked'", () => {
    const srcDir = __dirname;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts')
        ) {
          const content = fs.readFileSync(full, 'utf8');
          if (/updateProspectStage\([^)]*'meeting_booked'/.test(content)) {
            offenders.push(path.relative(srcDir, full));
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual(['web-ui.ts']);
  });

  it("the meeting-link sender advances to 'meeting_link_sent', never to 'meeting_booked'", () => {
    const gmailActions = fs.readFileSync(
      path.join(srcDirFile('gmail-bdr-actions.ts')),
      'utf8',
    );
    expect(gmailActions).toContain(
      "updateProspectStage(prospect.id, 'meeting_link_sent')",
    );
    expect(gmailActions).not.toMatch(
      /updateProspectStage\([^)]*'meeting_booked'/,
    );
  });
});

function srcDirFile(name: string): string {
  return path.join(__dirname, name);
}
