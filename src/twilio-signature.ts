/**
 * Twilio webhook signature validation (X-Twilio-Signature).
 *
 * Twilio signs every webhook request with HMAC-SHA1 over the full request URL
 * plus the alphabetically-sorted POST params, keyed by your account auth token
 * (https://www.twilio.com/docs/usage/security#validating-requests). Validating
 * it proves the request actually came from Twilio and wasn't forged/replayed by
 * anyone who guessed the public /webhooks/* path.
 *
 * We delegate the HMAC to the twilio SDK's validateRequest. Enforcement is gated
 * on TWILIO_AUTH_TOKEN being set: with no token there is nothing to validate
 * against, so we allow the request (dev/unconfigured) rather than hard-fail.
 *
 * URL reconstruction: Twilio computes the signature over the exact URL it was
 * configured to call (e.g. https://bdrclaw.dev/webhooks/sms). Behind a TLS-
 * terminating proxy (Railway) the request host/proto differ from the public
 * URL, so WEBHOOK_PUBLIC_URL pins the canonical origin; we fall back to the
 * request's host + x-forwarded-proto when it isn't set.
 */

import type http from 'http';

import twilio from 'twilio';

import { logger } from './logger.js';

/** Reconstruct the public URL Twilio used to sign this webhook request. */
export function twilioWebhookUrl(
  req: http.IncomingMessage,
  webhookPath: string,
): string {
  const publicBase = process.env.WEBHOOK_PUBLIC_URL?.trim();
  if (publicBase) return `${publicBase.replace(/\/+$/, '')}${webhookPath}`;

  const host = req.headers.host ?? 'localhost';
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
      ?.split(',')[0]
      ?.trim() || 'https';
  return `${proto}://${host}${webhookPath}`;
}

/**
 * Validate the X-Twilio-Signature header for an inbound webhook.
 * Returns true when TWILIO_AUTH_TOKEN is unset (nothing to enforce), or when the
 * signature is present and verifies. Returns false when a token IS configured
 * but the signature is missing or invalid.
 */
export function validateTwilioRequest(
  req: http.IncomingMessage,
  webhookPath: string,
  params: Record<string, string>,
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return true; // enforce only when a token is configured

  const header = req.headers['x-twilio-signature'];
  const signature = Array.isArray(header) ? header[0] : header;
  if (!signature) {
    logger.warn({ webhookPath }, 'Twilio webhook missing X-Twilio-Signature');
    return false;
  }

  const url = twilioWebhookUrl(req, webhookPath);
  const valid = twilio.validateRequest(authToken, signature, url, params);
  if (!valid) {
    logger.warn(
      { webhookPath, url },
      'Twilio webhook signature validation failed — rejecting',
    );
  }
  return valid;
}
