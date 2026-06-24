/**
 * Reply Handler — ISC-16 through ISC-20.
 *
 * Processes every inbound message through Claude classification, then acts:
 *   interested    → hot-lead notification + send calendar link
 *   question      → Claude-generated answer grounded in value proposition
 *   unsubscribe   → stage = 'unsubscribed', halt all further outbound
 *   not_now       → stage = 'follow_up', reschedule in 14 days
 *   not_interested→ stage = 'not_interested', stop sequence
 *   referral      → add note, keep in pipeline
 *   out_of_office → stage = 'follow_up', reschedule in 7 days
 *
 * Called by the agentic loop for all inbound messages across all channels.
 */

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

import { readProspectMemory, writeProspectMemory } from '../bdr-brain.js';
import {
  getProspectById,
  recordTouch,
  updateProspectNextAction,
  updateProspectStage,
} from '../bdr-db.js';
import { pushToCRMs } from '../crm/registry.js';
import { logger } from '../logger.js';
import type {
  BDRProspect,
  ReplyClassification,
  TouchChannel,
} from '../bdr-types.js';
import type { NewMessage } from '../types.js';

const ai = new Anthropic();

// ── Classification ────────────────────────────────────────────────────────────

async function classifyReply(
  prospect: BDRProspect,
  message: string,
  memory: string,
): Promise<ReplyClassification> {
  try {
    const response = await ai.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16,
      system: `Classify the inbound sales reply into exactly one category. Output only the category name, nothing else.

Categories:
- interested      (positive, wants to learn more or book a call)
- not_now         (timing issue, try again later)
- referral        (refers to someone else)
- not_interested  (clear no, won't reconsider)
- unsubscribe     (wants to be removed from outreach — any variant: "stop", "remove me", "unsubscribe", "don't contact me")
- question        (asks a factual question about the product/offer)
- out_of_office   (automated OOO reply or vacation notice)`,
      messages: [
        {
          role: 'user',
          content: `Prospect: ${prospect.name} at ${prospect.company} (${prospect.title})
Previous outreach context:
${memory.slice(-1000) || '(none)'}

Reply received:
${message}

Classify:`,
        },
      ],
    });

    const raw =
      response.content[0].type === 'text'
        ? response.content[0].text.trim().toLowerCase()
        : 'not_interested';

    const valid: ReplyClassification[] = [
      'interested',
      'not_now',
      'referral',
      'not_interested',
      'unsubscribe',
      'question',
      'out_of_office',
    ];
    return valid.includes(raw as ReplyClassification)
      ? (raw as ReplyClassification)
      : 'not_interested';
  } catch (err) {
    logger.warn(
      { err, prospectId: prospect.id },
      'Reply classification failed — defaulting to not_now',
    );
    return 'not_now';
  }
}

// ── Answer generation ─────────────────────────────────────────────────────────

async function generateAnswer(
  prospect: BDRProspect,
  question: string,
  valueProp: string,
): Promise<string> {
  const response = await ai.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: `You are a helpful B2B sales rep answering a prospect's question.
Be concise, honest, and helpful. End with a soft CTA to book a call.
Value proposition context: ${valueProp}`,
    messages: [
      {
        role: 'user',
        content: `Prospect ${prospect.name} at ${prospect.company} asked: "${question}"\n\nWrite a brief reply:`,
      },
    ],
  });
  return response.content[0].type === 'text'
    ? response.content[0].text.trim()
    : '';
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface ReplyResult {
  classification: ReplyClassification;
  responded: boolean;
  responseText?: string;
}

export async function processReply(
  prospectId: string,
  inboundMsg: NewMessage,
  channel: TouchChannel,
  valueProp?: string,
): Promise<ReplyResult> {
  const prospect = getProspectById(prospectId);
  if (!prospect) {
    logger.warn({ prospectId }, 'Reply handler: prospect not found');
    return { classification: 'not_interested', responded: false };
  }

  const memory = readProspectMemory(prospectId);
  const classification = await classifyReply(
    prospect,
    inboundMsg.content,
    memory,
  );

  logger.info({ prospectId, classification, channel }, 'Reply classified');

  // Record inbound touch
  recordTouch({
    id: crypto.randomUUID(),
    prospect_id: prospectId,
    channel,
    direction: 'inbound',
    content: inboundMsg.content,
    status: 'replied',
    sent_at: inboundMsg.timestamp,
    reply_classification: classification,
  });

  // Append to prospect memory
  const ts = new Date().toISOString().slice(0, 10);
  writeProspectMemory(
    prospectId,
    memory +
      `\n[${ts}] INBOUND (${channel}) — classified: ${classification}\n${inboundMsg.content}\n`,
  );

  let responded = false;
  let responseText: string | undefined;

  // Act on classification
  switch (classification) {
    case 'unsubscribe':
      updateProspectStage(prospectId, 'unsubscribed');
      // Pause all campaign enrollments for this prospect
      logger.info(
        { prospectId },
        'Prospect unsubscribed — all outbound halted',
      );
      break;

    case 'interested': {
      updateProspectStage(prospectId, 'interested');
      // Fire hot-lead notification
      fireHotLeadNotification(prospect);
      // Send calendar link if configured
      const calendlyUrl = process.env.CALENDLY_URL;
      if (calendlyUrl) {
        responseText = `Hi ${prospect.name.split(' ')[0]}, great to hear! Here's a link to book a time: ${calendlyUrl}`;
        responded = true;
      }
      break;
    }

    case 'question': {
      updateProspectStage(prospectId, 'replied');
      const vp =
        valueProp ?? process.env.DEFAULT_VALUE_PROPOSITION ?? 'our solution';
      responseText = await generateAnswer(
        prospect,
        inboundMsg.content,
        vp,
      ).catch((err) => {
        logger.warn({ err }, 'Answer generation failed');
        return '';
      });
      responded = !!responseText;
      break;
    }

    case 'not_now': {
      const next = new Date();
      next.setDate(next.getDate() + 14);
      updateProspectNextAction(prospectId, next.toISOString(), 'send_email');
      updateProspectStage(prospectId, 'follow_up');
      break;
    }

    case 'out_of_office': {
      const next = new Date();
      next.setDate(next.getDate() + 7);
      updateProspectNextAction(prospectId, next.toISOString(), 'send_email');
      updateProspectStage(prospectId, 'follow_up');
      break;
    }

    case 'not_interested':
      updateProspectStage(prospectId, 'not_interested');
      break;

    case 'referral':
      updateProspectStage(prospectId, 'replied');
      logger.info(
        { prospectId, content: inboundMsg.content },
        'Referral received — add new prospect manually',
      );
      break;
  }

  // Sync stage change to all CRMs
  const updatedProspect = getProspectById(prospectId);
  if (updatedProspect) {
    await pushToCRMs({
      type: 'reply_received',
      prospect: updatedProspect,
      timestamp: new Date().toISOString(),
      details: { classification, channel },
    }).catch((err) => logger.warn({ err }, 'CRM push failed after reply'));
  }

  return { classification, responded, responseText };
}

// ── Hot-lead notification ─────────────────────────────────────────────────────

function fireHotLeadNotification(prospect: BDRProspect): void {
  logger.info(
    { prospectId: prospect.id, name: prospect.name, company: prospect.company },
    '🔥 HOT LEAD — prospect replied as interested',
  );

  // Pulse notification if running
  const webhookUrl = process.env.HOT_LEAD_WEBHOOK_URL;
  if (webhookUrl) {
    import('https').then(({ default: https }) => {
      const payload = JSON.stringify({
        event: 'hot_lead',
        prospect: {
          name: prospect.name,
          company: prospect.company,
          title: prospect.title,
        },
        ts: new Date().toISOString(),
      });
      const url = new URL(webhookUrl);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      });
      req.on('error', (err) =>
        logger.warn({ err }, 'Hot-lead webhook delivery failed'),
      );
      req.write(payload);
      req.end();
    });
  }
}
