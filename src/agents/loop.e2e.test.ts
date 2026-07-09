/**
 * End-to-end edge test — guards the two agentic-loop wiring breaks.
 *
 * Break B: the composed + quality-gated message must reach the channel handler
 *          (not a hardcoded template). On the pre-fix code the handler received
 *          no composed argument, so `captured` would be undefined and the
 *          first assertion below would fail.
 * Break A: an inbound reply must reach processReply → stage change + inbound
 *          touch; a deterministic STOP must unsubscribe WITHOUT any AI call and
 *          halt further outbound.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared, hoisted state the mocked SDK factory can safely reference.
const h = vi.hoisted(() => ({
  classifierCalls: 0,
  composerCalls: 0,
  GATED_BODY:
    "Hi Sarah, quick question about scaling Acme's pipeline — worth 15 minutes?",
}));

// Input-aware Anthropic mock: one global create() serves both the composer and
// the classifier — branch on the system prompt.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn(async (params: { system?: string }) => {
        const system = String(params.system ?? '');
        if (system.includes('Classify the inbound sales reply')) {
          h.classifierCalls++;
          return { content: [{ type: 'text', text: 'interested' }] };
        }
        h.composerCalls++;
        return { content: [{ type: 'text', text: h.GATED_BODY }] };
      }),
    };
  },
}));

// Rule-layer quality gate only (no AI review) — same trick as the gate test.
process.env.QUALITY_GATE_AI = 'false';

import {
  _initBDRTestDatabase,
  enrollProspect,
  getProspectById,
  getTouchesForProspect,
  updateEnrollment,
  upsertCampaign,
  upsertCampaignStep,
  upsertProspect,
} from '../bdr-db.js';
import { registerActionHandler } from '../bdr-brain.js';
import { runTickOnce } from './loop.js';
import { processReply } from './reply-handler.js';
import type { NewMessage } from '../types.js';

const PROSPECT_ID = 'sarah-acme-test';
const CAMPAIGN_ID = 'camp-test';
const ENROLLMENT_ID = 'enr-test';

function seed(): void {
  _initBDRTestDatabase();
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  upsertCampaign({
    id: CAMPAIGN_ID,
    name: 'Test Campaign',
    value_proposition: 'more pipeline',
    tone: 'friendly',
    jitter_minutes: 0,
    status: 'active',
    created_at: now,
    updated_at: now,
  });

  upsertCampaignStep({
    id: 'step-1',
    campaign_id: CAMPAIGN_ID,
    step_number: 1,
    action_type: 'send_sms',
    delay_days: 0,
    template: 'Hi {{firstName}}, template fallback that should NOT be sent.',
    condition: 'always',
  });

  upsertProspect({
    id: PROSPECT_ID,
    name: 'Sarah Johnson',
    phone: '+15551234567',
    company: 'Acme',
    title: 'VP Sales',
    stage: 'identified',
    source: 'manual',
    created_at: now,
    updated_at: now,
  });

  enrollProspect({
    id: ENROLLMENT_ID,
    campaign_id: CAMPAIGN_ID,
    prospect_id: PROSPECT_ID,
    current_step: 0,
    status: 'active',
    enrolled_at: past, // in the past so step 1 (delay 0) is due immediately
  });
}

function reactivateEnrollment(): void {
  // enrolled_at (in the past) is fixed at insert and last_step_at is unset,
  // so resetting status + step makes step 1 due again on the next tick.
  updateEnrollment(ENROLLMENT_ID, { status: 'active', current_step: 0 });
}

function inbound(content: string): NewMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    chat_jid: 'sms:+15551234567',
    sender: '+15551234567',
    sender_name: 'Sarah Johnson',
    content,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
  };
}

describe('agentic loop e2e — closes Break A + Break B', () => {
  beforeEach(() => {
    h.classifierCalls = 0;
    h.composerCalls = 0;
    seed();
  });

  it('Break B: the composed + gated message reaches the channel handler (not the template)', async () => {
    let captured: string | undefined;
    registerActionHandler('send_sms', async (_prospect, composed) => {
      captured = composed?.body;
    });

    await runTickOnce();

    // The message handed to the channel is the composed+gated body, proving the
    // BDR agent + quality gate output actually reaches the wire.
    expect(h.composerCalls).toBeGreaterThan(0);
    expect(captured).toBe(h.GATED_BODY);
    expect(captured).not.toMatch(/\{\{/); // never an unfilled template
  });

  it('Break A: an inbound reply is classified and moves the prospect stage', async () => {
    await processReply(
      PROSPECT_ID,
      inbound('Sounds interesting, tell me more'),
      'sms',
    );

    const prospect = getProspectById(PROSPECT_ID);
    expect(prospect?.stage).toBe('interested');

    const touches = getTouchesForProspect(PROSPECT_ID);
    const inboundTouch = touches.find((t) => t.direction === 'inbound');
    expect(inboundTouch).toBeDefined();
    expect(inboundTouch?.reply_classification).toBe('interested');
    expect(h.classifierCalls).toBe(1);
  });

  it('ISC-17: a deterministic STOP unsubscribes without any AI call and halts outbound', async () => {
    await processReply(PROSPECT_ID, inbound('STOP'), 'sms');

    const prospect = getProspectById(PROSPECT_ID);
    expect(prospect?.stage).toBe('unsubscribed');
    // Deterministic pre-gate ran BEFORE any Claude call — classifier untouched.
    expect(h.classifierCalls).toBe(0);

    // Now a tick must NOT send again (suppression + stage skip).
    let sentAfterStop = false;
    registerActionHandler('send_sms', async () => {
      sentAfterStop = true;
    });
    reactivateEnrollment();
    await runTickOnce();
    expect(sentAfterStop).toBe(false);
  });
});
