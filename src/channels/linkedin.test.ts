/**
 * LinkedIn channel unit tests — ISC-57: daily caps (≤20 connections, ≤50 DMs
 * by default; lowered via env here) enforced AND persisted so process
 * restarts never reset the counters. Browser layer fully mocked — live
 * LinkedIn automation is DEFERRED-VERIFY until an authenticated session
 * exists (setup/linkedin-auth.ts).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { BrowserContext } from 'playwright';
import type { BDRProspect } from '../bdr-types.js';
import type { ChannelOpts } from './registry.js';

const h = vi.hoisted(() => ({
  prospect: undefined as BDRProspect | undefined,
  suppressed: false,
}));

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));

vi.mock('../bdr-db.js', () => ({
  getBdrDb: () => ({}),
  getProspectByContact: vi.fn(() => h.prospect),
  getTouchesForProspect: vi.fn(() => []),
  isProspectSuppressed: vi.fn(() => h.suppressed),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Module-level cap consts read env at import time — set before import.
process.env.LINKEDIN_DAILY_DM_LIMIT = '2';
process.env.LINKEDIN_DAILY_CONNECTION_LIMIT = '1';
const { LinkedInChannel } = await import('./linkedin.js');
const { LinkedInDailyUsage } = await import('./linkedin-usage.js');
const { getChannelFactory } = await import('./registry.js');

const JID = 'linkedin:https://linkedin.com/in/jane-smith';
const PROFILE = 'https://linkedin.com/in/jane-smith';

const fakeContext = {
  newPage: async () => ({ close: async () => {} }),
} as unknown as BrowserContext;

let usageFile: string;

function testChannel(): InstanceType<typeof LinkedInChannel> & {
  dm: ReturnType<typeof vi.fn>;
  connect_: ReturnType<typeof vi.fn>;
} {
  const ch = new LinkedInChannel(vi.fn(), vi.fn(), { usageFile });
  ch._setTestState(fakeContext);
  const dm = vi.fn(async () => {});
  const connect_ = vi.fn(async () => {});
  ch._dmAutomation = dm;
  ch._connectAutomation = connect_;
  return Object.assign(ch, { dm, connect_ });
}

beforeEach(() => {
  usageFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bdrclaw-li-')),
    'usage.json',
  );
  h.prospect = undefined;
  h.suppressed = false;
});

describe('LinkedIn channel — daily caps enforced and persisted (ISC-57)', () => {
  it('throws when not connected', async () => {
    const ch = new LinkedInChannel(vi.fn(), vi.fn(), { usageFile });
    await expect(ch.sendMessage(JID, 'hi')).rejects.toThrow(/not connected/);
  });

  it('DM cap: sends up to the limit, then THROWS — never silently drops', async () => {
    const ch = testChannel();
    await ch.sendMessage(JID, 'dm one');
    await ch.sendMessage(JID, 'dm two');
    await expect(ch.sendMessage(JID, 'dm three')).rejects.toThrow(
      /daily DM limit reached \(2\)/,
    );
    expect(ch.dm).toHaveBeenCalledTimes(2);
  });

  it('DM cap SURVIVES a process restart (fresh instance, same store)', async () => {
    const first = testChannel();
    await first.sendMessage(JID, 'dm one');
    await first.sendMessage(JID, 'dm two');

    // "Restart": a brand-new channel instance reading the same usage file.
    const second = testChannel();
    await expect(second.sendMessage(JID, 'dm after restart')).rejects.toThrow(
      /daily DM limit reached \(2\)/,
    );
    expect(second.dm).not.toHaveBeenCalled();
  });

  it('connection cap: enforced, throws, and persists across restart', async () => {
    const first = testChannel();
    await first.sendConnectionRequest(PROFILE, 'note');
    await expect(first.sendConnectionRequest(PROFILE)).rejects.toThrow(
      /daily connection limit reached \(1\)/,
    );

    const second = testChannel();
    await expect(second.sendConnectionRequest(PROFILE)).rejects.toThrow(
      /daily connection limit reached \(1\)/,
    );
    expect(second.connect_).not.toHaveBeenCalled();
  });

  it('DM and connection counters are independent', async () => {
    const ch = testChannel();
    await ch.sendConnectionRequest(PROFILE, 'note');
    // Connection cap (1) is reached; DMs still available.
    await ch.sendMessage(JID, 'dm still fine');
    expect(ch.dm).toHaveBeenCalledTimes(1);
  });

  it('a FAILED automation attempt does not consume quota', async () => {
    const ch = testChannel();
    ch._dmAutomation = vi.fn(async () => {
      throw new Error('selector timeout');
    });
    await expect(ch.sendMessage(JID, 'boom')).rejects.toThrow(
      'selector timeout',
    );
    // Quota untouched — both slots still usable.
    ch._dmAutomation = vi.fn(async () => {});
    await ch.sendMessage(JID, 'dm one');
    await ch.sendMessage(JID, 'dm two');
    await expect(ch.sendMessage(JID, 'dm three')).rejects.toThrow(
      /daily DM limit/,
    );
  });

  it('refuses suppressed contacts for both DMs and connection requests', async () => {
    h.prospect = { id: 'p-1' } as BDRProspect;
    h.suppressed = true;
    const ch = testChannel();
    await expect(ch.sendMessage(JID, 'hi')).rejects.toThrow(/suppression list/);
    await expect(ch.sendConnectionRequest(PROFILE)).rejects.toThrow(
      /suppression list/,
    );
    expect(ch.dm).not.toHaveBeenCalled();
    expect(ch.connect_).not.toHaveBeenCalled();
  });
});

describe('LinkedInDailyUsage — persistence unit', () => {
  it('starts at zero, increments, and survives re-instantiation', () => {
    const a = new LinkedInDailyUsage(usageFile);
    expect(a.read()).toMatchObject({ dms: 0, connections: 0 });
    a.recordDm();
    a.recordDm();
    a.recordConnection();
    const b = new LinkedInDailyUsage(usageFile);
    expect(b.read()).toMatchObject({ dms: 2, connections: 1 });
  });

  it('resets when the stored date is stale (new day)', () => {
    fs.writeFileSync(
      usageFile,
      JSON.stringify({ date: '2000-01-01', dms: 49, connections: 19 }),
    );
    const usage = new LinkedInDailyUsage(usageFile);
    expect(usage.read()).toMatchObject({ dms: 0, connections: 0 });
  });

  it('tolerates a corrupt usage file by starting fresh', () => {
    fs.writeFileSync(usageFile, 'not-json{{{');
    const usage = new LinkedInDailyUsage(usageFile);
    expect(usage.read()).toMatchObject({ dms: 0, connections: 0 });
    usage.recordDm();
    expect(usage.read().dms).toBe(1);
  });
});

describe('LinkedIn channel — self-disable (ISC-60)', () => {
  it('factory returns null when LINKEDIN_ENABLED is not set', () => {
    delete process.env.LINKEDIN_ENABLED;
    const opts: ChannelOpts = {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    };
    expect(getChannelFactory('linkedin')!(opts)).toBeNull();
  });
});
