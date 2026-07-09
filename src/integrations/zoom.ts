/**
 * Zoom webhook integration — receive and verify meeting-end events.
 *
 * Zoom sends HMAC-SHA256 signed webhook events. We verify the signature
 * before processing. No outbound Zoom API calls needed for meeting intelligence.
 *
 * Set ZOOM_WEBHOOK_SECRET_TOKEN in the environment to activate.
 */

import crypto from 'crypto';

import { logger } from '../logger.js';

export interface ZoomWebhookPayload {
  event: string;
  event_ts: number;
  payload: {
    account_id?: string;
    object?: ZoomMeetingObject;
    plainToken?: string; // present on url_validation events only
  };
}

export interface ZoomMeetingObject {
  id: string;
  uuid: string;
  host_id: string;
  topic: string;
  type: number;
  start_time: string;
  duration: number; // minutes
  timezone: string;
  participant_count?: number;
}

export interface ZoomMeetingResult {
  meetingId: string;
  topic: string;
  startTime: string;
  durationMinutes: number;
  participantCount: number;
}

// ── Webhook verification ──────────────────────────────────────────────────────

export function verifyZoomWebhook(
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  if (!secret) {
    logger.warn('ZOOM_WEBHOOK_SECRET_TOKEN not set — skipping webhook signature check');
    return true;
  }
  const message = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac('sha256', secret).update(message).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ── Event handler ─────────────────────────────────────────────────────────────

export function handleZoomWebhookEvent(
  payload: ZoomWebhookPayload,
): ZoomMeetingResult | null {
  const { event } = payload;

  // Zoom sends a url_validation challenge on endpoint setup
  if (event === 'endpoint.url_validation') {
    logger.info('Zoom webhook URL validation received');
    return null;
  }

  if (event !== 'meeting.ended') {
    logger.debug({ event }, 'Ignoring non-meeting.ended Zoom event');
    return null;
  }

  const obj = payload.payload?.object;
  if (!obj) {
    logger.warn('meeting.ended event missing payload.object');
    return null;
  }

  const result: ZoomMeetingResult = {
    meetingId: obj.id,
    topic: obj.topic,
    startTime: obj.start_time,
    durationMinutes: obj.duration,
    participantCount: obj.participant_count ?? 0,
  };

  logger.info({ meetingId: result.meetingId, topic: result.topic }, 'Zoom meeting ended');
  return result;
}
