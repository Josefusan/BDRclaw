/**
 * HubSpot CRM adapter tests (ISC-27/28).
 *
 * Registration is a module-load side effect gated on HUBSPOT_ACCESS_TOKEN, so
 * each test resets the module registry and dynamically imports the adapter
 * with the env configured for that scenario (same approach as
 * gohighlevel.test.ts). HubSpot talks raw `https.request` rather than fetch,
 * so the mock seam is the `https` module itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BDRProspect } from '../bdr-types.js';
import type { CRMAdapter, CRMEvent } from './types.js';

const { httpsRequestMock } = vi.hoisted(() => ({
  httpsRequestMock: vi.fn(),
}));

vi.mock('https', () => ({
  default: { request: httpsRequestMock },
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const prospect: BDRProspect = {
  id: 'jane-doe-acme',
  name: 'Jane Doe',
  email: 'jane@acme.com',
  phone: '+15551234567',
  company: 'Acme Corp',
  title: 'VP Engineering',
  stage: 'interested',
  source: 'manual',
  created_at: '2026-07-15T00:00:00.000Z',
  updated_at: '2026-07-15T00:00:00.000Z',
};

const event: CRMEvent = {
  type: 'stage_change',
  prospect,
  timestamp: '2026-07-15T00:00:00.000Z',
};

// ── https.request mock plumbing ──────────────────────────────────────────────
// hubspotRequest() builds options, registers res 'data'/'end' listeners
// synchronously inside the response callback, and rejects via req.on('error').
// The mock replays queued replies in FIFO order and records every request.

interface RecordedRequest {
  hostname?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string | number>;
  body?: unknown;
}

type MockReply =
  | { status: number; body: unknown }
  | { networkError: Error };

const replies: MockReply[] = [];
const recorded: RecordedRequest[] = [];

function queueReply(reply: MockReply): void {
  replies.push(reply);
}

function installHttpsMock(): void {
  httpsRequestMock.mockImplementation(
    (
      options: {
        hostname?: string;
        method?: string;
        path?: string;
        headers?: Record<string, string | number>;
      },
      callback: (res: unknown) => void,
    ) => {
      let written = '';
      let errorHandler: ((err: Error) => void) | undefined;
      const req = {
        on(eventName: string, cb: (err: Error) => void) {
          if (eventName === 'error') errorHandler = cb;
          return req;
        },
        write(chunk: string) {
          written += chunk;
        },
        end() {
          recorded.push({
            hostname: options.hostname,
            method: options.method,
            path: options.path,
            headers: options.headers,
            body: written ? JSON.parse(written) : undefined,
          });
          const reply = replies.shift();
          if (!reply) {
            throw new Error('hubspot.test: no queued mock reply');
          }
          if ('networkError' in reply) {
            errorHandler?.(reply.networkError);
            return;
          }
          const listeners: Record<string, (chunk?: unknown) => void> = {};
          const res = {
            statusCode: reply.status,
            on(eventName: string, cb: (chunk?: unknown) => void) {
              listeners[eventName] = cb;
              return res;
            },
          };
          callback(res);
          listeners.data?.(JSON.stringify(reply.body));
          listeners.end?.();
        },
      };
      return req;
    },
  );
}

async function loadAdapter(): Promise<CRMAdapter | undefined> {
  await import('./hubspot.js');
  const { getCRMAdapter } = await import('./registry.js');
  return getCRMAdapter('hubspot');
}

beforeEach(() => {
  vi.resetModules();
  httpsRequestMock.mockReset();
  replies.length = 0;
  recorded.length = 0;
  installHttpsMock();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hubspot adapter with env set', () => {
  beforeEach(() => {
    vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'test-hubspot-token');
  });

  it('registers and pushes a stage change via search → update → timeline', async () => {
    queueReply({ status: 200, body: { total: 1, results: [{ id: 'hs_1' }] } });
    queueReply({ status: 200, body: {} }); // PATCH contact
    queueReply({ status: 200, body: {} }); // timeline event

    const adapter = await loadAdapter();
    expect(adapter).toBeDefined();
    expect(adapter?.name).toBe('hubspot');

    await adapter?.push(event);

    expect(recorded).toHaveLength(3);

    // 1. Search for the existing contact by email
    expect(recorded[0]).toMatchObject({
      hostname: 'api.hubapi.com',
      method: 'POST',
      path: '/crm/v3/objects/contacts/search',
    });
    expect(recorded[0]?.headers).toMatchObject({
      Authorization: 'Bearer test-hubspot-token',
      'Content-Type': 'application/json',
    });
    expect(recorded[0]?.body).toEqual({
      filterGroups: [
        {
          filters: [
            { propertyName: 'email', operator: 'EQ', value: 'jane@acme.com' },
          ],
        },
      ],
      limit: 1,
    });

    // 2. Update the found contact with mapped prospect properties
    expect(recorded[1]).toMatchObject({
      method: 'PATCH',
      path: '/crm/v3/objects/contacts/hs_1',
    });
    expect(recorded[1]?.body).toEqual({
      properties: {
        firstname: 'Jane',
        lastname: 'Doe',
        company: 'Acme Corp',
        jobtitle: 'VP Engineering',
        email: 'jane@acme.com',
        phone: '+15551234567',
      },
    });

    // 3. Timeline event carries the BDRclaw event + stage
    expect(recorded[2]).toMatchObject({
      method: 'POST',
      path: '/crm/v3/timeline/events',
    });
    expect(recorded[2]?.body).toMatchObject({
      objectId: 'hs_1',
      tokens: { bdrclaw_event: 'stage_change', bdrclaw_stage: 'interested' },
      timestamp: '2026-07-15T00:00:00.000Z',
    });
  });

  it('creates a new contact when the email search finds none', async () => {
    queueReply({ status: 200, body: { total: 0, results: [] } });
    queueReply({ status: 200, body: { id: 'hs_new' } }); // POST create
    queueReply({ status: 200, body: {} }); // timeline event

    const adapter = await loadAdapter();
    await adapter?.push(event);

    expect(recorded).toHaveLength(3);
    expect(recorded[1]).toMatchObject({
      method: 'POST',
      path: '/crm/v3/objects/contacts',
    });
    expect(recorded[1]?.body).toMatchObject({
      properties: { email: 'jane@acme.com', firstname: 'Jane' },
    });
    expect(recorded[2]?.body).toMatchObject({ objectId: 'hs_new' });
  });

  it('adapter.push logs a warning and rejects on API failure (registry absorbs it)', async () => {
    queueReply({ status: 401, body: { message: 'unauthorized' } });

    const adapter = await loadAdapter();
    const { logger } = await import('../logger.js');

    // NOTE: unlike gohighlevel, HubSpotAdapter.push rethrows after logging —
    // by design, the ISC-27 "never crash the pipeline" invariant is enforced
    // one level up in pushToCRMs (see next test).
    await expect(adapter!.push(event)).rejects.toThrow(/HubSpot API 401/);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ prospectId: 'jane-doe-acme' }),
      'HubSpot push failed',
    );
  });

  it('pushToCRMs absorbs a HubSpot push failure without throwing (ISC-27)', async () => {
    queueReply({ status: 500, body: { message: 'server error' } });

    await loadAdapter();
    const { pushToCRMs } = await import('./registry.js');
    const { logger } = await import('../logger.js');

    await expect(pushToCRMs(event)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ prospectId: 'jane-doe-acme' }),
      'HubSpot push failed',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ crm: 'hubspot' }),
      'CRM push failed',
    );
  });

  it('pull maps HubSpot contacts to CRMContact', async () => {
    queueReply({
      status: 200,
      body: {
        results: [
          {
            id: 'hs_1',
            properties: {
              email: 'jane@acme.com',
              firstname: 'Jane',
              lastname: 'Doe',
              company: 'Acme Corp',
              jobtitle: 'VP Engineering',
              phone: '+15551234567',
              hs_linkedin_url: 'https://linkedin.com/in/janedoe',
              lifecyclestage: 'salesqualifiedlead',
            },
          },
          { id: 'hs_2', properties: {} },
        ],
      },
    });

    const adapter = await loadAdapter();
    const contacts = await adapter!.pull();

    expect(recorded[0]).toMatchObject({
      method: 'POST',
      path: '/crm/v3/objects/contacts/search',
    });
    expect(recorded[0]?.body).toMatchObject({
      filterGroups: [
        {
          filters: [
            expect.objectContaining({
              propertyName: 'lastmodifieddate',
              operator: 'GTE',
            }),
          ],
        },
      ],
      limit: 100,
    });

    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({
      external_id: 'hs_1',
      email: 'jane@acme.com',
      phone: '+15551234567',
      linkedin_url: 'https://linkedin.com/in/janedoe',
      name: 'Jane Doe',
      company: 'Acme Corp',
      title: 'VP Engineering',
      crm_stage: 'salesqualifiedlead',
    });
    expect(contacts[1]?.external_id).toBe('hs_2');
    expect(contacts[1]?.name).toBeUndefined();
    expect(contacts[1]?.crm_stage).toBeUndefined();
  });

  it('pull rejects on network error; pullFromCRMs absorbs it into []', async () => {
    queueReply({ networkError: new Error('ECONNRESET') });

    const adapter = await loadAdapter();
    await expect(adapter!.pull()).rejects.toThrow('ECONNRESET');

    queueReply({ networkError: new Error('ECONNRESET') });
    const { pullFromCRMs } = await import('./registry.js');
    await expect(pullFromCRMs()).resolves.toEqual([]);
  });
});

describe('hubspot adapter with env absent (ISC-28)', () => {
  it('does not register and performs zero network calls', async () => {
    vi.stubEnv('HUBSPOT_ACCESS_TOKEN', '');

    const adapter = await loadAdapter();
    expect(adapter).toBeUndefined();

    const { getCRMAdapters } = await import('./registry.js');
    expect(
      getCRMAdapters().some((a) => a.name === 'hubspot'),
    ).toBe(false);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});
