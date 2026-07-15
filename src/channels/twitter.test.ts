/**
 * Twitter/X channel unit tests — ISC-58 (warm/reply-only: cold DMs refused,
 * warm replies send), ISC-60 (self-disable without env creds).
 * twitter-api-v2 fully mocked — no live network sends.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { BDRProspect, BDRTouch } from '../bdr-types.js';
import type { ChannelOpts } from './registry.js';

const h = vi.hoisted(() => ({
  me: vi.fn(async () => ({ data: { id: 'me-1', username: 'bdrbot' } })),
  sendDm: vi.fn(async () => ({})),
  userByUsername: vi.fn(async () => ({ data: { id: 'u-42' } })),
  prospect: undefined as BDRProspect | undefined,
  touches: [] as Partial<BDRTouch>[],
  suppressed: false,
}));

vi.mock('twitter-api-v2', () => ({
  TwitterApi: class {
    readWrite = {
      v2: {
        me: h.me,
        sendDmToParticipant: h.sendDm,
        userByUsername: h.userByUsername,
        listDmEvents: vi.fn(async () => ({ data: { data: [] } })),
      },
    };
  },
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

const { TwitterChannel, getActiveTwitterChannel } =
  await import('./twitter.js');
const { getChannelFactory } = await import('./registry.js');

const PROSPECT: BDRProspect = { id: 'p-1' } as BDRProspect;

const factoryOpts: ChannelOpts = {
  onMessage: vi.fn(),
  onChatMetadata: vi.fn(),
  registeredGroups: () => ({}),
};

function setCreds(): void {
  process.env.TWITTER_API_KEY = 'k';
  process.env.TWITTER_API_SECRET = 's';
  process.env.TWITTER_ACCESS_TOKEN = 'at';
  process.env.TWITTER_ACCESS_TOKEN_SECRET = 'ats';
}

const openChannels: InstanceType<typeof TwitterChannel>[] = [];

async function connectedChannel(): Promise<
  InstanceType<typeof TwitterChannel>
> {
  setCreds();
  const ch = new TwitterChannel(vi.fn(), vi.fn());
  await ch.connect();
  expect(ch.isConnected()).toBe(true);
  openChannels.push(ch);
  return ch;
}

beforeEach(() => {
  h.me.mockClear();
  h.sendDm.mockClear();
  h.userByUsername.mockClear();
  h.prospect = undefined;
  h.touches = [];
  h.suppressed = false;
});

afterEach(async () => {
  // Clear reply-poll intervals so vitest exits cleanly.
  while (openChannels.length > 0) await openChannels.pop()!.disconnect();
});

describe('Twitter channel — self-disable (ISC-60)', () => {
  it('factory returns null when TWITTER_ENABLED is not set', () => {
    delete process.env.TWITTER_ENABLED;
    setCreds();
    expect(getChannelFactory('twitter')!(factoryOpts)).toBeNull();
    expect(h.me).not.toHaveBeenCalled();
  });

  it('factory returns null when API keys are missing (zero network calls)', () => {
    process.env.TWITTER_ENABLED = 'true';
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_API_SECRET;
    delete process.env.TWITTER_ACCESS_TOKEN;
    delete process.env.TWITTER_ACCESS_TOKEN_SECRET;
    expect(getChannelFactory('twitter')!(factoryOpts)).toBeNull();
    expect(h.me).not.toHaveBeenCalled();
    expect(h.sendDm).not.toHaveBeenCalled();
  });

  it('factory returns a channel and getActiveTwitterChannel exposes it once connected', async () => {
    process.env.TWITTER_ENABLED = 'true';
    setCreds();
    const ch = getChannelFactory('twitter')!(factoryOpts);
    expect(ch).toBeInstanceOf(TwitterChannel);
    expect(getActiveTwitterChannel()).toBeNull(); // not yet connected
    await ch!.connect();
    openChannels.push(ch as InstanceType<typeof TwitterChannel>);
    expect(getActiveTwitterChannel()).toBe(ch);
  });
});

describe('Twitter channel — warm/reply-only (ISC-58)', () => {
  it('REFUSES a cold DM to a prospect with zero inbound Twitter touches', async () => {
    h.prospect = PROSPECT;
    h.touches = [];
    const ch = await connectedChannel();
    await expect(ch.sendMessage('twitter:12345', 'cold pitch')).rejects.toThrow(
      /warm-only channel/,
    );
    expect(h.sendDm).not.toHaveBeenCalled();
  });

  it('sends a warm reply when the prospect has DMed us first', async () => {
    h.prospect = PROSPECT;
    h.touches = [
      { channel: 'twitter', direction: 'inbound', status: 'replied' },
    ] as BDRTouch[];
    const ch = await connectedChannel();
    await ch.sendMessage('twitter:12345', 'warm reply');
    expect(h.sendDm).toHaveBeenCalledWith('12345', { text: 'warm reply' });
  });

  it('refuses suppressed contacts', async () => {
    h.prospect = PROSPECT;
    h.suppressed = true;
    h.touches = [
      { channel: 'twitter', direction: 'inbound', status: 'replied' },
    ] as BDRTouch[];
    const ch = await connectedChannel();
    await expect(ch.sendMessage('twitter:12345', 'hi')).rejects.toThrow(
      /suppression list/,
    );
    expect(h.sendDm).not.toHaveBeenCalled();
  });

  it('allows unknown contacts (inbound conversational reply path)', async () => {
    h.prospect = undefined;
    const ch = await connectedChannel();
    await ch.sendMessage('twitter:99999', 'chat reply');
    expect(h.sendDm).toHaveBeenCalledTimes(1);
  });

  it('resolveUserId resolves an @handle via the channel client', async () => {
    const ch = await connectedChannel();
    await expect(ch.resolveUserId('@someone')).resolves.toBe('u-42');
    expect(h.userByUsername).toHaveBeenCalledWith('someone');
  });
});
