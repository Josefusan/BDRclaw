/**
 * HTTP contract tests for POST /api/crm/pull (ISC-26).
 *
 * Real `route` handler over real HTTP with a real in-memory SQLite database —
 * same harness as dashboard-write-api.test.ts.
 *
 * The CRM registry is module-global and has no unregister, so test order
 * inside this file matters: the "no adapters" case MUST run before any fake
 * adapter is registered.
 *
 * CSRF note: Node's fetch sends no Origin header, so the web-ui Origin guard
 * passes these requests through.
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

import { _initBDRTestDatabase } from './bdr-db.js';
import { stopAgenticLoop } from './agents/loop.js';
import { registerCRM } from './crm/registry.js';
import type { CRMAdapter, CRMContact } from './crm/types.js';
import { route } from './web-ui.js';

let server: http.Server;
let base: string;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function asJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

async function post(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'POST' });
}

const fakeContacts: CRMContact[] = [
  {
    external_id: 'fake-1',
    email: 'ada@lovelace.test',
    name: 'Ada Lovelace',
    company: 'Analytical Engines Ltd',
    title: 'CTO',
    crm_stage: 'lead',
  },
  {
    external_id: 'fake-2',
    phone: '+15550002222',
    linkedin_url: 'https://linkedin.com/in/gracehopper',
    name: 'Grace Hopper',
  },
];

function fakeAdapter(
  name: string,
  pull: () => Promise<CRMContact[]>,
): CRMAdapter {
  return {
    name,
    push: async () => {},
    pull,
    mapStage: (stage) => String(stage),
  };
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

describe('POST /api/crm/pull (ISC-26)', () => {
  // Order-dependent: runs first, before any adapter is registered.
  it('returns a well-formed empty payload when no CRM adapters are registered', async () => {
    const res = await post('/api/crm/pull');
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body).toEqual({ contacts: [], count: 0 });
  });

  it('returns { contacts, count } from a registered adapter', async () => {
    registerCRM(fakeAdapter('fake-crm', async () => fakeContacts));

    // The adapter is visible through the registry endpoint too.
    const adapters = await asJson(await fetch(`${base}/api/crm/adapters`));
    expect(adapters).toContainEqual({ name: 'fake-crm' });

    const res = await post('/api/crm/pull');
    expect(res.status).toBe(200);
    const body = await asJson(res);

    expect(body.count).toBe(2);
    expect(body.contacts).toEqual(fakeContacts);
    for (const contact of body.contacts) {
      expect(typeof contact.external_id).toBe('string');
      expect(contact.external_id.length).toBeGreaterThan(0);
      expect(typeof contact.name).toBe('string');
    }
  });

  it('a failing adapter does not break the endpoint — healthy results still returned', async () => {
    // fake-crm from the previous test is still registered (module-global).
    registerCRM(
      fakeAdapter('broken-crm', async () => {
        throw new Error('CRM exploded');
      }),
    );

    const res = await post('/api/crm/pull');
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.count).toBe(2);
    expect(body.contacts).toEqual(fakeContacts);
  });
});
