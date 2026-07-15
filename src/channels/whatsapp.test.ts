/**
 * WhatsApp channel unit tests — ISC-56 (warm-only enforcement),
 * ISC-60 (self-disable without env creds).
 * Twilio client fully mocked — no live network sends.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { BDRProspect, BDRTouch } from '../bdr-types.js';
import type { ChannelOpts } from './registry.js';

const h = vi.hoisted(() => ({
  create: vi.fn(async () => ({ sid: 'WA_test' })),
  fetch: vi.fn(async () => ({ friendlyName: 'Test Account' })),
  prospect: undefined as BDRProspect | undefined,
  touches: [] as Partial<BDRTouch>[],
  suppressed: false,
}));

vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    api: { accounts: () => ({ fetch: h.fetch }) },
    messages: { create: h.create },
  })),
}));

vi.mock('../bdr-db.js', () => ({
  getBdrDb: () => ({}),
  getProspectByContact: vi.fn(() => h.prospect),
  getTouchesForProspect: vi.fn(() => h.touches),
  isProspectSuppressed: vi.fn(() => h.suppressed),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { WhatsAppChannel } = await import('./whatsapp.js');
const { getChannelFactory } = await import('./registry.js');

const PROSPECT: BDRProspect = { id: 'p-1' } as BDRProspect;

async function connectedChannel(): Promise<
  InstanceType<typeof WhatsAppChannel>
> {
  const ch = new WhatsAppChannel(
    'AC_test',
    'token',
    'whatsapp:+15550001111',
    vi.fn(),
    vi.fn(),
  );
  await ch.connect();
  expect(ch.isConnected()).toBe(true);
  return ch;
}

const factoryOpts: ChannelOpts = {
  onMessage: vi.fn(),
  onChatMetadata: vi.fn(),
  registeredGroups: () => ({}),
};

beforeEach(() => {
  h.create.mockClear();
  h.fetch.mockClear();
  h.prospect = undefined;
  h.touches = [];
  h.suppressed = false;
});

describe('WhatsApp channel — self-disable (ISC-60)', () => {
  it('factory returns null without TWILIO_WHATSAPP_NUMBER (zero network calls)', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_x';
    process.env.TWILIO_AUTH_TOKEN = 't';
    delete process.env.TWILIO_WHATSAPP_NUMBER;
    expect(getChannelFactory('whatsapp')!(factoryOpts)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('factory returns a channel when fully configured', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_x';
    process.env.TWILIO_AUTH_TOKEN = 't';
    process.env.TWILIO_WHATSAPP_NUMBER = '+15550001111';
    expect(getChannelFactory('whatsapp')!(factoryOpts)).toBeInstanceOf(
      WhatsAppChannel,
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe('WhatsApp channel — warm-only enforcement (ISC-56)', () => {
  it('REFUSES outbound to a prospect with zero inbound WhatsApp touches', async () => {
    h.prospect = PROSPECT;
    h.touches = []; // no inbound history — cold
    const ch = await connectedChannel();
    await expect(
      ch.sendMessage('whatsapp:+15551234567', 'cold pitch'),
    ).rejects.toThrow(/warm-only channel/);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('outbound-only history is still cold — refused', async () => {
    h.prospect = PROSPECT;
    h.touches = [
      { channel: 'whatsapp', direction: 'outbound', status: 'sent' },
    ] as BDRTouch[];
    const ch = await connectedChannel();
    await expect(
      ch.sendMessage('whatsapp:+15551234567', 'still cold'),
    ).rejects.toThrow(/warm-only channel/);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('sends when the prospect has messaged us inbound on WhatsApp (warm)', async () => {
    h.prospect = PROSPECT;
    h.touches = [
      { channel: 'whatsapp', direction: 'inbound', status: 'replied' },
    ] as BDRTouch[];
    const ch = await connectedChannel();
    await ch.sendMessage('whatsapp:+15551234567', 'warm reply');
    expect(h.create).toHaveBeenCalledWith({
      from: 'whatsapp:+15550001111',
      to: 'whatsapp:+15551234567',
      body: 'warm reply',
    });
  });

  it('inbound touches on ANOTHER channel do not make WhatsApp warm', async () => {
    h.prospect = PROSPECT;
    h.touches = [
      { channel: 'email', direction: 'inbound', status: 'replied' },
    ] as BDRTouch[];
    const ch = await connectedChannel();
    await expect(
      ch.sendMessage('whatsapp:+15551234567', 'cross-channel cold'),
    ).rejects.toThrow(/warm-only channel/);
  });

  it('refuses suppressed contacts', async () => {
    h.prospect = PROSPECT;
    h.suppressed = true;
    h.touches = [
      { channel: 'whatsapp', direction: 'inbound', status: 'replied' },
    ] as BDRTouch[];
    const ch = await connectedChannel();
    await expect(ch.sendMessage('whatsapp:+15551234567', 'hi')).rejects.toThrow(
      /suppression list/,
    );
    expect(h.create).not.toHaveBeenCalled();
  });

  it('allows unknown contacts (conversational reply path, no prospect record)', async () => {
    h.prospect = undefined;
    const ch = await connectedChannel();
    await ch.sendMessage('whatsapp:+15559998888', 'chat reply');
    expect(h.create).toHaveBeenCalledTimes(1);
  });
});
