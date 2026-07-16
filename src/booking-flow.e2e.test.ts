/**
 * Full-chain booking flow e2e test (ISC-80/81/82).
 *
 * Exercises the product's core promise as ONE system, through the real
 * functions at every step:
 *
 *   identified
 *     → (real processReply, inbound "interested" reply)   interested
 *     → (real send_meeting_link action handler)           meeting_link_sent   ← NOT meeting_booked (ISC-80)
 *     → (real Calendly invitee.created webhook over HTTP) meeting_booked      ← the ONLY writer (ISC-81/82)
 *
 * This is the integration test that would have caught the "booking counted
 * at link-send" bug: it asserts explicitly that sending the meeting link
 * leaves the prospect at 'meeting_link_sent', and that only the Calendly
 * webhook advances to 'meeting_booked' with an inbound booking touch.
 *
 * calendly-webhook.test.ts covers the webhook unit-level contract; this file
 * covers the whole chain end to end. Same harness: real `route` handler over
 * real HTTP with a real in-memory SQLite database.
 *
 * Only two seams are faked, both external I/O that cannot run in a test:
 *   - @anthropic-ai/sdk: reply classification (Claude API) returns
 *     'interested' so processReply takes its real 'interested' branch.
 *   - channels/gmail.js: getGmailChannel() returns a stub whose
 *     sendBDREmail resolves — without it the send_meeting_link handler
 *     warn-and-returns before reaching updateProspectStage, so the very
 *     transition under test would never execute. Everything downstream of
 *     the send (touch recording, stage update, thread persistence) is the
 *     real handler code.
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Reply classification + web-ui's transitive agent layer both construct an
// Anthropic client at import time. Classification must return 'interested'
// so processReply exercises its real interested → calendar-link branch.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi
        .fn()
        .mockResolvedValue({ content: [{ type: 'text', text: 'interested' }] }),
    };
  },
}));

// Gmail channel stub: send_meeting_link requires a registered channel or it
// warn-and-returns without touching the DB (see gmail-bdr-actions.ts line
// ~234). Faking ONLY the wire send lets the real handler run its touch
// recording and the stage transition under test. src/channels/gmail.js is
// imported by no other module in this test's graph, so the mock is safe.
vi.mock('./channels/gmail.js', () => ({
  getGmailChannel: () => ({
    accountIndexFromKey: () => 1,
    sendBDREmail: async () => ({
      threadId: 'e2e-thread-1',
      messageId: 'e2e-msg-1',
    }),
  }),
}));

import {
  _initBDRTestDatabase,
  addProspect,
  getAllProspects,
  getProspectById,
  getTouchesForProspect,
} from './bdr-db.js';
import { getActionHandler } from './bdr-brain.js';
import { processReply } from './agents/reply-handler.js';
import { stopAgenticLoop } from './agents/loop.js';
import { route } from './web-ui.js';
// Side-effect import: registers the send_email / classify_reply /
// send_meeting_link action handlers with the BDR Brain.
import './gmail-bdr-actions.js';

// ── HTTP harness (same shape as calendly-webhook.test.ts) ────────────────────

let server: http.Server;
let base: string;

async function post(urlPath: string, body: unknown): Promise<Response> {
  return fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function inviteeCreated(email: string): unknown {
  return {
    event: 'invitee.created',
    payload: {
      uri: `https://api.calendly.com/scheduled_events/x/invitees/${crypto.randomUUID()}`,
      email,
      name: 'Ada Chainprover',
      scheduled_event: {
        uri: 'https://api.calendly.com/scheduled_events/x',
        start_time: '2026-07-24T16:00:00Z',
      },
    },
  };
}

// ── Filesystem hygiene ────────────────────────────────────────────────────────
// processReply writes prospects/<id>/CLAUDE.md and the gmail handler persists
// store/gmail-threads.json — both under process.cwd(). Snapshot and restore so
// the test leaves no residue in the working tree.

const PROSPECTS_DIR = path.resolve(process.cwd(), 'prospects');
const STORE_DIR = path.resolve(process.cwd(), 'store');
const THREADS_FILE = path.join(STORE_DIR, 'gmail-threads.json');

const createdProspectIds: string[] = [];
let prospectsDirExisted = false;
let storeDirExisted = false;
let threadsFileBefore: string | null = null;

beforeAll(async () => {
  prospectsDirExisted = fs.existsSync(PROSPECTS_DIR);
  storeDirExisted = fs.existsSync(STORE_DIR);
  threadsFileBefore = fs.existsSync(THREADS_FILE)
    ? fs.readFileSync(THREADS_FILE, 'utf-8')
    : null;

  server = http.createServer(route);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  stopAgenticLoop();
  server.close();

  for (const id of createdProspectIds) {
    fs.rmSync(path.join(PROSPECTS_DIR, id), { recursive: true, force: true });
  }
  if (!prospectsDirExisted && fs.existsSync(PROSPECTS_DIR)) {
    try {
      fs.rmdirSync(PROSPECTS_DIR); // only removes if empty
    } catch {
      /* someone else's files — leave them */
    }
  }
  if (threadsFileBefore !== null) {
    fs.writeFileSync(THREADS_FILE, threadsFileBefore, 'utf-8');
  } else {
    fs.rmSync(THREADS_FILE, { force: true });
    if (!storeDirExisted && fs.existsSync(STORE_DIR)) {
      try {
        fs.rmdirSync(STORE_DIR);
      } catch {
        /* someone else's files — leave them */
      }
    }
  }
});

beforeEach(() => {
  _initBDRTestDatabase();
  delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  delete process.env.HOT_LEAD_WEBHOOK_URL;
  // Required by both processReply's interested-branch and send_meeting_link.
  process.env.CALENDLY_URL = 'https://calendly.com/e2e/intro-call';
});

// ── The chain ────────────────────────────────────────────────────────────────

describe('booking flow end to end: reply → interested → link sent → Calendly webhook → booked', () => {
  it('advances a prospect through the full chain, booking ONLY at the webhook', async () => {
    const email = 'ada@chainprover.dev';
    const stages: string[] = [];

    // 1. Prospect enters the pipeline at 'identified'.
    const prospect = addProspect({
      name: 'Ada Chainprover',
      email,
      company: 'Chainprover Dev',
      title: 'CTO',
      source: 'manual',
    });
    createdProspectIds.push(prospect.id);
    stages.push(getProspectById(prospect.id)!.stage);
    expect(stages[0]).toBe('identified');

    // 2. An inbound positive reply, through the REAL reply handler, advances
    //    the prospect to 'interested' and records an inbound touch.
    const reply = await processReply(
      prospect.id,
      {
        id: 'e2e-inbound-1',
        chat_jid: `${email}@gmail-bdr`,
        sender: email,
        sender_name: 'Ada Chainprover',
        content: "Yes — this looks great. I'd be interested in a demo.",
        timestamp: new Date().toISOString(),
      },
      'email',
    );
    expect(reply.classification).toBe('interested');
    stages.push(getProspectById(prospect.id)!.stage);
    expect(stages[1]).toBe('interested');

    // 3. The send_meeting_link action handler (the REAL registered handler,
    //    with only the Gmail wire send stubbed) sends the Calendly link.
    const sendMeetingLink = getActionHandler('send_meeting_link');
    expect(sendMeetingLink).toBeDefined();
    await sendMeetingLink!(getProspectById(prospect.id)!);

    // ── ISC-80 regression guard ─────────────────────────────────────────────
    // THE bug this test exists to catch: sending the link must advance the
    // prospect to 'meeting_link_sent' and must NOT count as a booking.
    const afterLinkSend = getProspectById(prospect.id)!;
    expect(afterLinkSend.stage).toBe('meeting_link_sent');
    expect(afterLinkSend.stage).not.toBe('meeting_booked');
    stages.push(afterLinkSend.stage);

    // The link actually went out as an outbound email touch.
    const outboundAfterLink = getTouchesForProspect(prospect.id).filter(
      (t) => t.direction === 'outbound',
    );
    expect(outboundAfterLink).toHaveLength(1);
    expect(outboundAfterLink[0].content).toContain(process.env.CALENDLY_URL!);

    // No booking touch exists yet — nothing before the webhook books.
    expect(
      getTouchesForProspect(prospect.id).filter((t) =>
        t.content.includes('Calendly booking confirmed'),
      ),
    ).toHaveLength(0);

    // 4. Calendly's invitee.created webhook — real HTTP against the real
    //    route() handler — is what books the meeting (ISC-81/82).
    const res = await post('/api/webhooks/calendly', inviteeCreated(email));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      matched: boolean;
      prospectId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.matched).toBe(true);
    expect(body.prospectId).toBe(prospect.id);

    const finalProspect = getProspectById(prospect.id)!;
    expect(finalProspect.stage).toBe('meeting_booked');
    stages.push(finalProspect.stage);

    // The booking is recorded as an INBOUND touch (prospect acted, not us).
    const inbound = getTouchesForProspect(prospect.id).filter(
      (t) => t.direction === 'inbound',
    );
    // Exactly two inbound touches: the interested reply + the booking.
    expect(inbound).toHaveLength(2);
    const bookingTouches = inbound.filter((t) =>
      t.content.includes('Calendly booking confirmed'),
    );
    expect(bookingTouches).toHaveLength(1);
    expect(bookingTouches[0].content).toContain('2026-07-24T16:00:00Z');

    // ── Monotonic stage progression ─────────────────────────────────────────
    // The prospect moved strictly forward through the funnel, one stage per
    // step, and 'meeting_booked' appears exactly once — at the very end,
    // written by the webhook and nothing else.
    expect(stages).toEqual([
      'identified',
      'interested',
      'meeting_link_sent',
      'meeting_booked',
    ]);
    expect(stages.indexOf('meeting_booked')).toBe(stages.length - 1);
  });

  it('negative arm: a booking webhook for an unknown email is 200 matched:false and creates no phantom prospect', async () => {
    // Seed one unrelated prospect so we prove non-interference too.
    const bystander = addProspect({
      name: 'Bo Bystander',
      email: 'bo@bystander.io',
      company: 'Bystander Inc',
      title: 'VP Eng',
      source: 'manual',
    });
    createdProspectIds.push(bystander.id);
    const countBefore = getAllProspects(1000, 0).length;

    const res = await post(
      '/api/webhooks/calendly',
      inviteeCreated('ghost@no-such-prospect.example'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; matched: boolean };
    expect(body.ok).toBe(true);
    expect(body.matched).toBe(false);

    // No phantom prospect was created, and the bystander was untouched.
    const after = getAllProspects(1000, 0);
    expect(after).toHaveLength(countBefore);
    expect(
      after.some((p) => p.email === 'ghost@no-such-prospect.example'),
    ).toBe(false);
    expect(getProspectById(bystander.id)!.stage).toBe('identified');
    expect(getTouchesForProspect(bystander.id)).toHaveLength(0);
  });
});
