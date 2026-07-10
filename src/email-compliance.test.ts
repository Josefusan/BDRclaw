/**
 * CAN-SPAM email compliance unit tests (Feature 1 — Phase 3.5 slice).
 *
 * Covers the footer content (legal name + physical address + unsubscribe link),
 * the List-Unsubscribe / List-Unsubscribe-Post headers (RFC 8058), and the
 * unguessable, tamper-proof unsubscribe token.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendCanSpamFooter,
  buildCanSpamFooter,
  listUnsubscribeHeaders,
  unsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from './email-compliance.js';

const PROSPECT_ID = 'sarah-acme-abc123';

describe('CAN-SPAM footer', () => {
  beforeEach(() => {
    process.env.BDR_LEGAL_NAME = 'Acme Sales LLC';
    process.env.BDR_MAILING_ADDRESS = '500 Market St, San Francisco, CA 94105';
    process.env.BDR_PUBLIC_URL = 'https://bdrclaw.dev';
    process.env.BDR_UNSUBSCRIBE_SECRET = 'test-secret-fixed';
  });

  afterEach(() => {
    delete process.env.BDR_LEGAL_NAME;
    delete process.env.BDR_MAILING_ADDRESS;
    delete process.env.BDR_PUBLIC_URL;
    delete process.env.BDR_UNSUBSCRIBE_SECRET;
  });

  it('contains the legal name, physical address, and an unsubscribe URL', () => {
    const footer = buildCanSpamFooter(PROSPECT_ID);
    expect(footer).toContain('Acme Sales LLC');
    expect(footer).toContain('500 Market St, San Francisco, CA 94105');
    expect(footer).toContain(unsubscribeUrl(PROSPECT_ID));
    expect(footer.toLowerCase()).toContain('unsubscribe');
  });

  it('appends the footer to the body, preserving the original message', () => {
    const body = 'Hi Sarah, worth a quick 15 minutes?';
    const withFooter = appendCanSpamFooter(body, PROSPECT_ID);
    expect(withFooter).toContain(body);
    expect(withFooter).toContain('Acme Sales LLC');
    expect(withFooter.indexOf(body)).toBeLessThan(
      withFooter.indexOf('Acme Sales LLC'),
    );
  });

  it('uses clearly-marked placeholders when legal env vars are unset', () => {
    delete process.env.BDR_LEGAL_NAME;
    delete process.env.BDR_MAILING_ADDRESS;
    const footer = buildCanSpamFooter(PROSPECT_ID);
    expect(footer).toContain('BDR_LEGAL_NAME');
    expect(footer).toContain('BDR_MAILING_ADDRESS');
  });
});

describe('List-Unsubscribe headers (RFC 8058)', () => {
  beforeEach(() => {
    process.env.BDR_PUBLIC_URL = 'https://bdrclaw.dev';
    process.env.BDR_UNSUBSCRIBE_SECRET = 'test-secret-fixed';
  });
  afterEach(() => {
    delete process.env.BDR_PUBLIC_URL;
    delete process.env.BDR_UNSUBSCRIBE_SECRET;
    delete process.env.BDR_UNSUBSCRIBE_EMAIL;
  });

  it('provides both a mailto and an https one-click target', () => {
    const headers = listUnsubscribeHeaders(PROSPECT_ID);
    expect(headers['List-Unsubscribe']).toContain('mailto:');
    expect(headers['List-Unsubscribe']).toContain(
      'https://bdrclaw.dev/unsubscribe',
    );
    // RFC 8058 one-click POST marker.
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('honors a dedicated unsubscribe mailbox when configured', () => {
    process.env.BDR_UNSUBSCRIBE_EMAIL = 'optout@example.com';
    const headers = listUnsubscribeHeaders(PROSPECT_ID);
    expect(headers['List-Unsubscribe']).toContain('mailto:optout@example.com');
  });
});

describe('unsubscribe token', () => {
  beforeEach(() => {
    process.env.BDR_UNSUBSCRIBE_SECRET = 'test-secret-fixed';
  });
  afterEach(() => {
    delete process.env.BDR_UNSUBSCRIBE_SECRET;
  });

  it('verifies a token it produced', () => {
    const token = unsubscribeToken(PROSPECT_ID);
    expect(verifyUnsubscribeToken(PROSPECT_ID, token)).toBe(true);
  });

  it('rejects a tampered token or mismatched prospect', () => {
    const token = unsubscribeToken(PROSPECT_ID);
    expect(verifyUnsubscribeToken(PROSPECT_ID, token + 'x')).toBe(false);
    expect(verifyUnsubscribeToken('someone-else', token)).toBe(false);
    expect(verifyUnsubscribeToken(PROSPECT_ID, '')).toBe(false);
  });

  it('is unguessable — depends on the secret', () => {
    const a = unsubscribeToken(PROSPECT_ID);
    process.env.BDR_UNSUBSCRIBE_SECRET = 'a-different-secret';
    const b = unsubscribeToken(PROSPECT_ID);
    expect(a).not.toBe(b);
  });
});
