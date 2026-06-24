/**
 * Quality Gate unit tests — ISC-10, ISC-11, ISC-12
 * Covers rule-layer checks (synchronous, no AI call needed).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock the Anthropic SDK so tests don't make real API calls
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'PASS' }],
      }),
    };
  },
}));

// Disable AI review for pure rule-layer tests
process.env.QUALITY_GATE_AI = 'false';

import { reviewMessage } from './quality-gate.js';

describe('QualityGate — placeholder check (ISC-10)', () => {
  it('fails when message contains {{placeholder}} token', async () => {
    const result = await reviewMessage(
      'Hi {{firstName}}, I wanted to reach out...',
      'email',
      'Test User',
      'friendly',
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/placeholder/i);
    expect(result.checks.placeholder).toBe(false);
  });

  it('passes when all tokens are filled', async () => {
    const result = await reviewMessage(
      'Hi Sarah, I wanted to reach out about Acme Corp.',
      'email',
      'Sarah Johnson',
      'friendly',
    );
    expect(result.pass).toBe(true);
    expect(result.checks.placeholder).toBe(true);
  });

  it('fails for any {{...}} pattern regardless of content', async () => {
    const result = await reviewMessage(
      'Subject: {{subject_line}}',
      'email',
      'Test',
      'casual',
    );
    expect(result.pass).toBe(false);
  });
});

describe('QualityGate — spam word check (ISC-11)', () => {
  it('fails when message contains a spam trigger phrase', async () => {
    const result = await reviewMessage(
      'Act now — guaranteed results for your team!',
      'email',
      'Test User',
      'direct',
    );
    expect(result.pass).toBe(false);
    expect(result.checks.spamWord).toBe(false);
  });

  it('fails for "click here" trigger', async () => {
    const result = await reviewMessage(
      'Click here to learn more.',
      'email',
      'Test',
      'casual',
    );
    expect(result.pass).toBe(false);
  });

  it('passes for normal professional language', async () => {
    const result = await reviewMessage(
      'Would you be open to a 15-minute call this week?',
      'linkedin',
      'Test User',
      'friendly',
    );
    expect(result.pass).toBe(true);
  });
});

describe('QualityGate — channel length check (ISC-12)', () => {
  it('fails when SMS message exceeds 320 chars', async () => {
    const longMsg = 'A'.repeat(321);
    const result = await reviewMessage(longMsg, 'sms', 'Test User', 'casual');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/character limit/i);
    expect(result.checks.length).toBe(false);
  });

  it('passes when SMS message is exactly 320 chars', async () => {
    const msg = 'A'.repeat(320);
    const result = await reviewMessage(msg, 'sms', 'Test User', 'casual');
    // Only length check matters here — other checks pass for plain text
    expect(result.checks.length).toBe(true);
  });

  it('fails when LinkedIn message exceeds 300 chars', async () => {
    const longMsg = 'B'.repeat(301);
    const result = await reviewMessage(
      longMsg,
      'linkedin',
      'Test User',
      'casual',
    );
    expect(result.pass).toBe(false);
    expect(result.checks.length).toBe(false);
  });

  it('does not enforce length limit for email channel', async () => {
    const longEmail = 'This is a very long email. '.repeat(100);
    const result = await reviewMessage(
      longEmail,
      'email',
      'Test User',
      'formal',
    );
    expect(result.checks.length).toBe(true);
  });
});

describe('QualityGate — fast-fail ordering', () => {
  it('fails on placeholder before checking spam words', async () => {
    const result = await reviewMessage(
      '{{firstName}} — guaranteed results!',
      'email',
      'Test',
      'direct',
    );
    // Should fail on placeholder first
    expect(result.pass).toBe(false);
    expect(result.checks.placeholder).toBe(false);
  });
});
