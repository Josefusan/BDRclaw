/**
 * Composition-root contract: importing bootstrap.ts must register every
 * channel action handler with the BDR Brain. This is the regression test for
 * the `npm run brain` no-op bug — runCycle() with an empty handler map hits
 * the "No handler for action type" branch and reschedules forever.
 */

import { describe, expect, it, vi } from 'vitest';

// Insurance: nothing in the bootstrap import graph should construct a real
// Anthropic client, but mock it so this can never hit the network.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: vi.fn() };
  },
}));

import './bootstrap.js';
import { getActionHandler } from './bdr-brain.js';

describe('bootstrap composition root', () => {
  it('registers all channel action handlers at import time', () => {
    const expectedActions = [
      'send_email', // gmail
      'classify_reply', // gmail
      'send_meeting_link', // gmail
      'linkedin_connect', // linkedin
      'linkedin_dm', // linkedin
      'send_sms', // sms
      'telegram_dm', // telegram
      'twitter_dm', // twitter
    ];
    for (const action of expectedActions) {
      expect(getActionHandler(action), `handler for ${action}`).toBeDefined();
    }
  });
});
