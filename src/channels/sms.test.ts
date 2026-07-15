/**
 * SMS channel unit tests — ISC-55 (TCPA cap + suppression + happy path),
 * ISC-30 (daily limit throws), ISC-60 (self-disable without env creds).
 * Twilio client fully mocked — no live network sends.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { BDRProspect, BDRTouch } from '../bdr-types.js';
import type { ChannelOpts } from './registry.js';

const h = vi.hoisted(() => ({
  create: vi.fn(async () => ({ sid: 'SM_test' })),
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
  getBdrDb: () => ({}), // truthy → compliance checks are active
  getProspectByContact: vi.fn(() => h.prospect),
  getTouchesForProspect: vi.fn(() => h.touches),
  isProspectSuppressed: vi.fn(() => h.suppressed),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Module-level daily limit const reads env at import time — set before import.
process.env.SMS_DAILY_MSG_LIMIT = '2';
const { SMSChannel } = await import('./sms.js');
const { getChannelFactory } = await import('./registry.js');

const PROSPECT: BDRProspect = { id: 'p-1' } as BDRProspect;

function outboundSms(status = 'sent'): Partial<BDRTouch> {
  return { channel: 'sms', direction: 'outbound', status } as BDRTouch;
}

function inboundSms(): Partial<BDRTouch> {
  return {
    channel: 'sms',
    direction: 'inbound',
    status: 'replied',
  } as BDRTouch;
}

async function connectedChannel(): Promise<InstanceType<typeof SMSChannel>> {
  const ch = new SMSChannel(
    'AC_test',
    'token',
    '+15550001111',
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

describe('SMS channel — self-disable (ISC-60)', () => {
  it('factory returns null when SMS_ENABLED is not set (zero network calls)', () => {
    delete process.env.SMS_ENABLED;
    process.env.TWILIO_ACCOUNT_SID = 'AC_x';
    process.env.TWILIO_AUTH_TOKEN = 't';
    process.env.TWILIO_PHONE_NUMBER = '+15550001111';
    expect(getChannelFactory('sms')!(factoryOpts)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('factory returns null when Twilio creds are missing', () => {
    process.env.SMS_ENABLED = 'true';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
    expect(getChannelFactory('sms')!(factoryOpts)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('factory returns a channel when fully configured (still no network until connect)', () => {
    process.env.SMS_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC_x';
    process.env.TWILIO_AUTH_TOKEN = 't';
    process.env.TWILIO_PHONE_NUMBER = '+15550001111';
    const ch = getChannelFactory('sms')!(factoryOpts);
    expect(ch).toBeInstanceOf(SMSChannel);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe('SMS channel — sendMessage (ISC-55, ISC-30)', () => {
  it('happy path: sends via Twilio with from/to/body', async () => {
    const ch = await connectedChannel();
    await ch.sendMessage('sms:+15551234567', 'hello there');
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledWith({
      from: '+15550001111',
      to: '+15551234567',
      body: 'hello there',
    });
  });

  it('daily limit THROWS at the cap — never silently drops', async () => {
    const ch = await connectedChannel();
    await ch.sendMessage('sms:+15551234567', 'one');
    await ch.sendMessage('sms:+15551234567', 'two');
    await expect(ch.sendMessage('sms:+15551234567', 'three')).rejects.toThrow(
      /daily message limit reached \(2\)/,
    );
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it('refuses (throws) when the contact is on the global suppression list', async () => {
    h.prospect = PROSPECT;
    h.suppressed = true;
    const ch = await connectedChannel();
    await expect(ch.sendMessage('sms:+15551234567', 'hi')).rejects.toThrow(
      /suppression list/,
    );
    expect(h.create).not.toHaveBeenCalled();
  });

  it('refuses (throws) after 2 unsolicited outbound touches — TCPA cap', async () => {
    h.prospect = PROSPECT;
    h.touches = [outboundSms(), outboundSms()];
    const ch = await connectedChannel();
    await expect(ch.sendMessage('sms:+15551234567', 'hi')).rejects.toThrow(
      /TCPA cap/,
    );
    expect(h.create).not.toHaveBeenCalled();
  });

  it('allows further sends once the prospect has replied (solicited)', async () => {
    h.prospect = PROSPECT;
    h.touches = [outboundSms(), outboundSms(), inboundSms()];
    const ch = await connectedChannel();
    await ch.sendMessage('sms:+15551234567', 'reply follow-up');
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('quality-gate-blocked touches do not count toward the TCPA cap', async () => {
    h.prospect = PROSPECT;
    h.touches = [outboundSms('blocked'), outboundSms('blocked')];
    const ch = await connectedChannel();
    await ch.sendMessage('sms:+15551234567', 'first real touch');
    expect(h.create).toHaveBeenCalledTimes(1);
  });
});
