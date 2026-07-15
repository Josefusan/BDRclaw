/**
 * GoHighLevel CRM adapter tests (ISC-72/73).
 *
 * Registration is a module-load side effect gated on GHL_API_KEY and
 * GHL_LOCATION_ID, so each test resets the module registry and dynamically
 * imports the adapter with the env configured for that scenario.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BDRProspect } from '../bdr-types.js';
import type { CRMAdapter, CRMEvent } from './types.js';

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

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

const fetchMock = vi.fn();

async function loadAdapter(): Promise<CRMAdapter | undefined> {
  await import('./gohighlevel.js');
  const { getCRMAdapter } = await import('./registry.js');
  return getCRMAdapter('gohighlevel');
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('gohighlevel adapter with env set', () => {
  beforeEach(() => {
    vi.stubEnv('GHL_API_KEY', 'test-ghl-key');
    vi.stubEnv('GHL_LOCATION_ID', 'loc_123');
  });

  it('registers and pushes a stage change via the upsert endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ contact: { id: 'c_1', tags: [] } }),
    );

    const adapter = await loadAdapter();
    expect(adapter).toBeDefined();
    expect(adapter?.name).toBe('gohighlevel');

    await adapter?.push(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://services.leadconnectorhq.com/contacts/upsert');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-ghl-key',
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      locationId: 'loc_123',
      email: 'jane@acme.com',
      phone: '+15551234567',
      firstName: 'Jane',
      lastName: 'Doe',
      companyName: 'Acme Corp',
      tags: ['bdrclaw', 'bdrclaw-stage-interested'],
    });
  });

  it('removes stale bdrclaw-stage-* tags when the upsert response returns them', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          contact: {
            id: 'c_1',
            tags: [
              'bdrclaw',
              'bdrclaw-stage-outreach_sent',
              'bdrclaw-stage-interested',
              'customer-tag',
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ tags: [] }));

    const adapter = await loadAdapter();
    await adapter?.push(event);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://services.leadconnectorhq.com/contacts/c_1/tags');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({
      tags: ['bdrclaw-stage-outreach_sent'],
    });
  });

  it('pull maps GHL contacts to CRMContact', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        contacts: [
          {
            id: 'c_1',
            email: 'jane@acme.com',
            phone: '+15551234567',
            firstName: 'Jane',
            lastName: 'Doe',
            companyName: 'Acme Corp',
            tags: ['bdrclaw', 'bdrclaw-stage-meeting_booked'],
          },
          {
            id: 'c_2',
            contactName: 'Bob Solo',
            tags: [],
          },
        ],
      }),
    );

    const adapter = await loadAdapter();
    const contacts = await adapter!.pull();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://services.leadconnectorhq.com/contacts/?locationId=loc_123&limit=100',
    );
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({
      external_id: 'c_1',
      email: 'jane@acme.com',
      phone: '+15551234567',
      name: 'Jane Doe',
      company: 'Acme Corp',
      crm_stage: 'meeting_booked',
    });
    expect(contacts[1]).toMatchObject({
      external_id: 'c_2',
      name: 'Bob Solo',
    });
    expect(contacts[1]?.crm_stage).toBeUndefined();
  });

  it('push logs a warning and does not throw on API error (ISC-27)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Unauthorized' }, 401),
    );

    const adapter = await loadAdapter();
    const { logger } = await import('../logger.js');

    await expect(adapter!.push(event)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ prospectId: 'jane-doe-acme' }),
      'GoHighLevel push failed',
    );
  });

  it('pull logs a warning and returns [] on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const adapter = await loadAdapter();
    const { logger } = await import('../logger.js');

    await expect(adapter!.pull()).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'GoHighLevel pull failed',
    );
  });
});

describe('gohighlevel adapter with env absent (ISC-73)', () => {
  it('does not register and never calls fetch when both vars are missing', async () => {
    vi.stubEnv('GHL_API_KEY', '');
    vi.stubEnv('GHL_LOCATION_ID', '');

    const adapter = await loadAdapter();
    expect(adapter).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not register when only GHL_API_KEY is set', async () => {
    vi.stubEnv('GHL_API_KEY', 'test-ghl-key');
    vi.stubEnv('GHL_LOCATION_ID', '');

    const adapter = await loadAdapter();
    expect(adapter).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not register when only GHL_LOCATION_ID is set', async () => {
    vi.stubEnv('GHL_API_KEY', '');
    vi.stubEnv('GHL_LOCATION_ID', 'loc_123');

    const adapter = await loadAdapter();
    expect(adapter).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
