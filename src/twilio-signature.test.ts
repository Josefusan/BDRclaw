/**
 * Twilio webhook signature validation tests (Feature 2 — Phase 2 hardening).
 *
 * The expected signature is computed here independently with node:crypto using
 * Twilio's documented HMAC-SHA1 scheme (URL + alphabetically-sorted params),
 * so the test does not merely re-run the SDK against itself.
 */

import crypto from 'crypto';
import type http from 'http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { twilioWebhookUrl, validateTwilioRequest } from './twilio-signature.js';

const TOKEN = 'test-auth-token-abc123';
const PATH = '/webhooks/sms';
const BASE = 'https://bdrclaw.dev';
const PARAMS: Record<string, string> = {
  From: '+15551234567',
  Body: 'hello world',
  MessageSid: 'SM0123456789',
  To: '+15559876543',
};

/** Twilio's scheme: base64(HMAC-SHA1(token, url + sorted(name+value)…)). */
function sign(
  token: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return crypto
    .createHmac('sha1', token)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');
}

function mockReq(headers: Record<string, string>): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

describe('twilioWebhookUrl', () => {
  afterEach(() => {
    delete process.env.WEBHOOK_PUBLIC_URL;
  });

  it('uses WEBHOOK_PUBLIC_URL when set (trailing slash trimmed)', () => {
    process.env.WEBHOOK_PUBLIC_URL = 'https://bdrclaw.dev/';
    expect(twilioWebhookUrl(mockReq({ host: 'ignored' }), PATH)).toBe(
      'https://bdrclaw.dev/webhooks/sms',
    );
  });

  it('falls back to request host + forwarded proto', () => {
    const url = twilioWebhookUrl(
      mockReq({ host: 'app.up.railway.app', 'x-forwarded-proto': 'https' }),
      PATH,
    );
    expect(url).toBe('https://app.up.railway.app/webhooks/sms');
  });
});

describe('validateTwilioRequest', () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    process.env.WEBHOOK_PUBLIC_URL = BASE;
  });
  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.WEBHOOK_PUBLIC_URL;
  });

  it('accepts a request with a valid signature', () => {
    const sig = sign(TOKEN, BASE + PATH, PARAMS);
    const req = mockReq({ host: BASE, 'x-twilio-signature': sig });
    expect(validateTwilioRequest(req, PATH, PARAMS)).toBe(true);
  });

  it('rejects a request with an invalid signature', () => {
    const req = mockReq({ host: BASE, 'x-twilio-signature': 'not-the-sig' });
    expect(validateTwilioRequest(req, PATH, PARAMS)).toBe(false);
  });

  it('rejects a request with no signature header when a token is set', () => {
    const req = mockReq({ host: BASE });
    expect(validateTwilioRequest(req, PATH, PARAMS)).toBe(false);
  });

  it('rejects when the signed params differ from the received params', () => {
    // Signature computed over the original body, but a param was tampered with.
    const sig = sign(TOKEN, BASE + PATH, PARAMS);
    const tampered = { ...PARAMS, Body: 'malicious' };
    const req = mockReq({ host: BASE, 'x-twilio-signature': sig });
    expect(validateTwilioRequest(req, PATH, tampered)).toBe(false);
  });

  it('allows the request when TWILIO_AUTH_TOKEN is not set (nothing to enforce)', () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const req = mockReq({ host: BASE }); // no signature at all
    expect(validateTwilioRequest(req, PATH, PARAMS)).toBe(true);
  });
});
