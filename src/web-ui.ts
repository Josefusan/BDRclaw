/**
 * BDRclaw Web UI — dashboard server.
 *
 * Serves the pipeline dashboard at http://localhost:<port>
 * and a REST API at /api/*.
 *
 * Runs in-process with the main BDRclaw daemon.
 * Uses Node's built-in http module — no external web framework needed.
 */

// Env hydration MUST precede every other import — modules read process.env
// at import time. See load-env.ts.
import './load-env.js';

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

import {
  addContactToSuppression,
  addProspect,
  addProspectToSuppression,
  enrollProspect,
  getActiveEnrollments,
  getAllAccounts,
  getAllProspects,
  getCampaignById,
  getCampaignSteps,
  getBuilderSession,
  getHotProspects,
  getPipelineStats,
  getProspectById,
  getRecentActivity,
  getRecentBrainRuns,
  getRecentImportJobs,
  getSuppressionList,
  getTodayOutboundByChannel,
  getTouchesForProspect,
  isProspectSuppressed,
  listCampaigns,
  searchProspects,
  SUPPRESSION_CHANNELS,
  updateProspectStage,
  upsertCampaign,
} from './bdr-db.js';
import type { SuppressionChannel } from './bdr-db.js';
import { STORE_DIR } from './config.js';
import { verifyUnsubscribeToken } from './email-compliance.js';
import { renderPrivacyContent, renderTermsContent } from './legal-pages.js';
import {
  builderChat,
  editCampaign,
  enrollAllActiveProspects,
  startBuilderSession,
} from './campaign-builder.js';
import {
  getLoopStatus,
  startAgenticLoop,
  stopAgenticLoop,
} from './agents/loop.js';
import { getCRMAdapters, pullFromCRMs } from './crm/registry.js';
import { logger } from './logger.js';
import { getWebhookHandler } from './webhook-registry.js';
import { PROSPECT_STAGES } from './bdr-types.js';
import type { CampaignStatus, ProspectStage } from './bdr-types.js';

/** Valid campaign statuses for the PATCH allowlist (mirrors CampaignStatus). */
const CAMPAIGN_STATUSES: CampaignStatus[] = [
  'draft',
  'active',
  'paused',
  'completed',
  'archived',
];

/**
 * Outbound send action types. If NONE of these has a registered handler, the
 * channel skill modules were never imported in this process — starting the
 * loop would make every send silently no-op ("No action handler registered").
 * Both real entry points (daemon and standalone web UI) register them via
 * bootstrap.ts; this guard is the honest error for anything else.
 */
const SEND_ACTION_TYPES = [
  'send_email',
  'linkedin_connect',
  'linkedin_dm',
  'twitter_dm',
  'instagram_dm',
  'telegram_dm',
  'whatsapp_dm',
  'send_sms',
] as const;
import { analyzeMeeting } from './agents/meeting-intelligence.js';
import { processOration } from './agents/oration.js';
import {
  isInstantlyConfigured,
  syncProspects as syncInstantly,
  getInstantlyCampaigns,
} from './integrations/instantly.js';
import {
  isSalesforgeConfigured,
  syncProspects as syncSalesforge,
  getSalesforgeSequences,
} from './integrations/salesforge.js';
import {
  verifyZoomWebhook,
  handleZoomWebhookEvent,
} from './integrations/zoom.js';
import {
  isOtterConfigured,
  getOtterTranscripts,
} from './integrations/otter.js';

const WEB_PORT = parseInt(process.env.BDR_WEB_PORT ?? '3000', 10);
const WEB_HOST = process.env.BDR_WEB_HOST ?? '127.0.0.1';

// ── Channel configuration status ──────────────────────────────────────────────
// Required env vars per channel (NAMES only — values are never returned by any
// endpoint). Mirrors what each src/channels/* factory reads at startup.

const CHANNELS = [
  'email',
  'linkedin',
  'twitter',
  'instagram',
  'telegram',
  'whatsapp',
  'sms',
] as const;
type ChannelName = (typeof CHANNELS)[number];

const CHANNEL_ENV_REQUIREMENTS: Record<ChannelName, string[]> = {
  email: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_ACCOUNT_1'],
  linkedin: [
    'LINKEDIN_ENABLED',
    'LINKEDIN_ACCOUNT_1_EMAIL',
    'LINKEDIN_ACCOUNT_1_PASSWORD',
  ],
  twitter: [
    'TWITTER_ENABLED',
    'TWITTER_API_KEY',
    'TWITTER_API_SECRET',
    'TWITTER_ACCESS_TOKEN',
    'TWITTER_ACCESS_TOKEN_SECRET',
  ],
  instagram: [
    'INSTAGRAM_ENABLED',
    'INSTAGRAM_ACCESS_TOKEN',
    'INSTAGRAM_ACCOUNT_ID',
  ],
  telegram: ['TELEGRAM_BOT_TOKEN'],
  whatsapp: [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WHATSAPP_NUMBER',
  ],
  sms: [
    'SMS_ENABLED',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
  ],
};

/** Required env vars that are missing (or, for *_ENABLED flags, not 'true'). */
function missingEnvVars(channel: ChannelName): string[] {
  return CHANNEL_ENV_REQUIREMENTS[channel].filter((name) => {
    const value = process.env[name];
    if (name.endsWith('_ENABLED')) return value !== 'true';
    return !value;
  });
}

/**
 * Documented daily send caps per channel. LinkedIn is 20 connection requests /
 * 50 DMs — the DM cap is reported. SMS is TCPA-limited. Email defaults to the
 * bdr_accounts config (sum of per-account daily_send_limit, default 50).
 */
function channelDailyLimit(channel: ChannelName): number {
  switch (channel) {
    case 'email': {
      const emailAccounts = getAllAccounts().filter(
        (a) => a.type === 'gmail' || a.type === 'outlook',
      );
      if (emailAccounts.length === 0) return 50;
      return emailAccounts.reduce((sum, a) => sum + a.daily_send_limit, 0);
    }
    case 'linkedin':
      return parseInt(process.env.LINKEDIN_DAILY_DM_LIMIT ?? '50', 10);
    case 'twitter':
      return parseInt(process.env.TWITTER_DAILY_DM_LIMIT ?? '100', 10);
    case 'instagram':
      return parseInt(process.env.INSTAGRAM_DAILY_DM_LIMIT ?? '50', 10);
    case 'telegram':
      return parseInt(process.env.TELEGRAM_DAILY_MSG_LIMIT ?? '200', 10);
    case 'whatsapp':
      return parseInt(process.env.WHATSAPP_DAILY_MSG_LIMIT ?? '100', 10);
    case 'sms':
      return parseInt(process.env.SMS_DAILY_MSG_LIMIT ?? '100', 10);
  }
}

/**
 * Cheap credential-artifact verification. Only claims `verified` where an
 * artifact can actually be checked (token files parse, ID formats match);
 * channels with no cheaply checkable artifact mirror `configured` — never
 * faked beyond that.
 */
function isChannelVerified(channel: ChannelName, configured: boolean): boolean {
  if (!configured) return false;
  switch (channel) {
    case 'email': {
      // At least one configured Gmail account has a stored, parseable OAuth token.
      const tokensDir = path.join(STORE_DIR, 'gmail-tokens');
      for (let i = 1; i <= 3; i++) {
        if (!process.env[`GMAIL_ACCOUNT_${i}`]) continue;
        try {
          JSON.parse(
            fs.readFileSync(path.join(tokensDir, `account-${i}.json`), 'utf-8'),
          );
          return true;
        } catch {
          /* no token for this account — try the next */
        }
      }
      return false;
    }
    case 'linkedin': {
      // Saved Playwright session cookies from `npm run linkedin-auth`.
      try {
        JSON.parse(
          fs.readFileSync(
            path.join(STORE_DIR, 'linkedin-session.json'),
            'utf-8',
          ),
        );
        return true;
      } catch {
        return false;
      }
    }
    case 'sms':
    case 'whatsapp':
      // Twilio account SIDs are always "AC" + 32 hex chars.
      return /^AC[0-9a-fA-F]{32}$/.test(process.env.TWILIO_ACCOUNT_SID ?? '');
    case 'telegram':
      // BotFather tokens are "<numeric bot id>:<35-char secret>".
      return /^\d+:[\w-]{30,}$/.test(process.env.TELEGRAM_BOT_TOKEN ?? '');
    case 'twitter':
    case 'instagram':
      // No cheaply checkable artifact — mirror configured.
      return configured;
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Public compliance pages (CAN-SPAM opt-out). Handled before static files so
  // /unsubscribe is a real endpoint, not a 404 or SPA fallback.
  if (pathname === '/unsubscribe') {
    handleUnsubscribe(method, url, req, res);
    return;
  }

  // Legal pages (required for the Twilio 10DLC campaign filing). Handled before
  // the SPA fallback so /privacy and /terms serve real content, not index.html.
  if (method === 'GET' && pathname === '/privacy') {
    sendHtml(
      res,
      200,
      legalPageShell('Privacy Policy', renderPrivacyContent()),
    );
    return;
  }
  if (method === 'GET' && pathname === '/terms') {
    sendHtml(
      res,
      200,
      legalPageShell('Terms of Service', renderTermsContent()),
    );
    return;
  }

  // Static files from public/
  if (
    method === 'GET' &&
    !pathname.startsWith('/api/') &&
    !pathname.startsWith('/webhooks/')
  ) {
    const filePath =
      pathname === '/' || pathname === '/index.html'
        ? path.join(PUBLIC_DIR, 'index.html')
        : path.join(PUBLIC_DIR, pathname);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      res.writeHead(200, {
        'Content-Type': (mime[ext] ?? 'text/plain') + '; charset=utf-8',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback: unknown paths serve index.html (client-side routing)
    if (pathname !== '/' && !pathname.includes('.')) {
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(indexPath).pipe(res);
        return;
      }
    }
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    handleApi(method, pathname, url, req, res);
    return;
  }

  // Twilio / channel webhooks — body must be read before dispatching
  if (pathname.startsWith('/webhooks/')) {
    const handler = getWebhookHandler(pathname);
    if (handler) {
      readBody(req, (body) => {
        Promise.resolve(handler(req, res, body)).catch((err) => {
          logger.error({ err, pathname }, 'Webhook handler error');
          res.writeHead(500);
          res.end('Internal error');
        });
      });
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function handleApi(
  method: string,
  pathname: string,
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (method === 'GET' && pathname === '/api/stats') {
      const stats = getPipelineStats();
      json(res, stats);
      return;
    }

    if (method === 'GET' && pathname === '/api/accounts') {
      json(res, getAllAccounts());
      return;
    }

    if (method === 'GET' && pathname === '/api/prospects') {
      const q = url.searchParams.get('q');
      const stage = url.searchParams.get('stage');
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

      if (q) {
        json(res, searchProspects(q, limit));
      } else if (stage) {
        const all = getAllProspects(1000, 0).filter((p) => p.stage === stage);
        json(res, all.slice(offset, offset + limit));
      } else {
        json(res, getAllProspects(limit, offset));
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/prospects/hot') {
      json(res, getHotProspects());
      return;
    }

    // Prospect detail: full record + touch timeline + suppression flag
    // (ISC-69). Must stay AFTER the /api/prospects/hot exact match.
    if (method === 'GET' && pathname.startsWith('/api/prospects/')) {
      const parts = pathname.split('/');
      if (parts.length === 4 && parts[3]) {
        const prospect = getProspectById(parts[3]);
        if (!prospect) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Prospect not found' }));
          return;
        }
        json(res, {
          ...prospect,
          touches: getTouchesForProspect(prospect.id),
          suppressed: isProspectSuppressed(prospect),
        });
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/brain/runs') {
      const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
      json(res, getRecentBrainRuns(limit));
      return;
    }

    if (method === 'GET' && pathname === '/api/imports') {
      json(res, getRecentImportJobs());
      return;
    }

    if (method === 'GET' && pathname === '/api/health') {
      json(res, {
        status: 'ok',
        uptime: process.uptime(),
        ts: new Date().toISOString(),
        loop: getLoopStatus(),
      });
      return;
    }

    // ── Loop control (ISC-68, ISC-79) ─────────────────────────────────────────

    if (method === 'POST' && pathname === '/api/loop/start') {
      (async () => {
        try {
          // Probe the action-handler registry: if no channel skill registered
          // a send handler, this process cannot actually send — refuse
          // honestly instead of starting a loop whose sends all no-op.
          const { getActionHandler } = await import('./bdr-brain.js');
          const channelsLoaded = SEND_ACTION_TYPES.some(
            (t) => getActionHandler(t) !== undefined,
          );
          if (!channelsLoaded) {
            res.writeHead(409);
            res.end(
              JSON.stringify({
                error:
                  'channels not loaded in this process — run the daemon (npm run dev) or the standalone web UI (npm run web)',
                loop: getLoopStatus(),
              }),
            );
            return;
          }
          startAgenticLoop();
          logger.info('Agentic loop started via dashboard');
          json(res, { ok: true, loop: getLoopStatus() });
        } catch (err) {
          internalError(res, err, 'Loop start error');
        }
      })();
      return;
    }

    if (method === 'POST' && pathname === '/api/loop/stop') {
      stopAgenticLoop();
      logger.info('Agentic loop stopped via dashboard');
      json(res, { ok: true, loop: getLoopStatus() });
      return;
    }

    if (method === 'GET' && pathname === '/api/activity') {
      const limit = parseInt(url.searchParams.get('limit') ?? '25', 10);
      json(res, getRecentActivity(limit));
      return;
    }

    if (method === 'GET' && pathname === '/api/channels/status') {
      const usedToday = getTodayOutboundByChannel();
      json(res, {
        channels: CHANNELS.map((channel) => {
          const configured = missingEnvVars(channel).length === 0;
          return {
            channel,
            configured,
            verified: isChannelVerified(channel, configured),
            dailyLimit: channelDailyLimit(channel),
            usedToday: usedToday[channel] ?? 0,
          };
        }),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/settings/env') {
      // Missing env var NAMES per channel — never values (ISC-36).
      json(res, {
        channels: CHANNELS.map((channel) => ({
          channel,
          missing: missingEnvVars(channel),
        })),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/suppression') {
      const entries = getSuppressionList();
      json(res, { count: entries.length, entries });
      return;
    }

    // Manually suppress a contact identifier (ISC-78). Channel is required so
    // the key lands in the namespace isProspectSuppressed() actually checks.
    if (method === 'POST' && pathname === '/api/suppression') {
      readBody(req, (body) => {
        try {
          const data = JSON.parse(body) as {
            channel?: string;
            contact?: string;
          };
          if (typeof data.contact !== 'string' || !data.contact.trim()) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'contact is required' }));
            return;
          }
          if (
            !SUPPRESSION_CHANNELS.includes(data.channel as SuppressionChannel)
          ) {
            res.writeHead(400);
            res.end(
              JSON.stringify({
                error: `channel is required — one of: ${SUPPRESSION_CHANNELS.join(', ')}`,
              }),
            );
            return;
          }
          const entry = addContactToSuppression(
            data.channel as SuppressionChannel,
            data.contact,
            'manual:dashboard',
          );
          logger.info(
            { contact: entry.contact },
            'Contact suppressed via dashboard',
          );
          res.writeHead(201);
          res.end(JSON.stringify({ ok: true, entry }));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    // ── Prospect write endpoints ──────────────────────────────────────────────

    if (method === 'POST' && pathname === '/api/prospects') {
      readBody(req, (body) => {
        try {
          const data = JSON.parse(body);
          if (!data.name || !data.company || !data.title) {
            res.writeHead(400);
            res.end(
              JSON.stringify({
                error: 'name, company, and title are required',
              }),
            );
            return;
          }
          const prospect = addProspect({
            name: data.name,
            company: data.company,
            title: data.title,
            email: data.email ?? null,
            linkedin_url: data.linkedin_url ?? null,
            phone: data.phone ?? null,
            source: data.source ?? 'manual',
            tags: Array.isArray(data.tags)
              ? data.tags.join(',')
              : (data.tags ?? null),
          });
          res.writeHead(201);
          res.end(JSON.stringify(prospect));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/prospects/import') {
      readBody(req, (body) => {
        try {
          const rows: Array<Record<string, string>> = JSON.parse(body);
          if (!Array.isArray(rows)) {
            res.writeHead(400);
            res.end(
              JSON.stringify({
                error: 'Body must be an array of prospect objects',
              }),
            );
            return;
          }
          const imported: number[] = [];
          const errors: Array<{ row: number; error: string }> = [];
          rows.forEach((row, i) => {
            if (!row.name || !row.company || !row.title) {
              errors.push({ row: i, error: 'name, company, title required' });
              return;
            }
            try {
              addProspect({
                name: row.name,
                company: row.company,
                title: row.title,
                email: row.email ?? null,
                linkedin_url: row.linkedin_url ?? row.linkedin ?? null,
                phone: row.phone ?? null,
                source: 'csv_import',
                tags: row.tags ?? null,
              });
              imported.push(i);
            } catch (e) {
              logger.warn({ err: e, row: i }, 'CSV import row failed');
              errors.push({ row: i, error: 'row import failed' });
            }
          });
          json(res, { imported: imported.length, errors });
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    // Suppress a prospect from the dashboard drawer (ISC-77/ISC-78). Same
    // single authoritative path the unsubscribe link and STOP replies use.
    if (
      method === 'POST' &&
      pathname.startsWith('/api/prospects/') &&
      pathname.endsWith('/suppress')
    ) {
      const id = pathname.split('/')[3];
      const prospect = getProspectById(id);
      if (!prospect) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Prospect not found' }));
        return;
      }
      addProspectToSuppression(prospect, 'manual:dashboard');
      updateProspectStage(prospect.id, 'unsubscribed');
      logger.info({ prospectId: id }, 'Prospect suppressed via dashboard');
      json(res, { ok: true, prospect: getProspectById(id) });
      return;
    }

    if (method === 'PATCH' && pathname.startsWith('/api/prospects/')) {
      const id = pathname.split('/')[3];
      readBody(req, (body) => {
        try {
          const data = JSON.parse(body);
          const prospect = getProspectById(id);
          if (!prospect) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Prospect not found' }));
            return;
          }
          if (data.stage !== undefined) {
            if (!PROSPECT_STAGES.includes(data.stage as ProspectStage)) {
              res.writeHead(400);
              res.end(
                JSON.stringify({
                  error: `Invalid stage — must be one of: ${PROSPECT_STAGES.join(', ')}`,
                }),
              );
              return;
            }
            // Single authoritative CRM-push path (ISC-77).
            updateProspectStage(id, data.stage as ProspectStage);
          }
          json(res, { ok: true, prospect: getProspectById(id) });
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid request' }));
        }
      });
      return;
    }

    // ── Campaign endpoints ────────────────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/campaigns') {
      json(res, listCampaigns());
      return;
    }

    if (
      method === 'GET' &&
      pathname.startsWith('/api/campaigns/') &&
      !pathname.includes('/builder')
    ) {
      const id = pathname.split('/')[3];
      const campaign = getCampaignById(id);
      if (!campaign) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Campaign not found' }));
        return;
      }
      json(res, { ...campaign, steps: getCampaignSteps(id) });
      return;
    }

    if (method === 'PATCH' && pathname.startsWith('/api/campaigns/')) {
      const id = pathname.split('/')[3];
      const campaign = getCampaignById(id);
      if (!campaign) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Campaign not found' }));
        return;
      }
      readBody(req, (body) => {
        try {
          const data = JSON.parse(body) as Partial<{
            status: CampaignStatus;
            name: string;
          }>;
          if (
            data.status !== undefined &&
            !CAMPAIGN_STATUSES.includes(data.status)
          ) {
            res.writeHead(400);
            res.end(
              JSON.stringify({
                error: `Invalid status — must be one of: ${CAMPAIGN_STATUSES.join(', ')}`,
              }),
            );
            return;
          }
          upsertCampaign({
            ...campaign,
            ...data,
            updated_at: new Date().toISOString(),
          });
          // Auto-enroll active prospects when activating a campaign
          if (data.status === 'active') {
            const enrolled = enrollAllActiveProspects(id);
            json(res, { ok: true, enrolled });
          } else {
            json(res, { ok: true });
          }
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid body' }));
        }
      });
      return;
    }

    // Campaign enrollments
    if (
      method === 'GET' &&
      pathname.startsWith('/api/campaigns/') &&
      pathname.endsWith('/enrollments')
    ) {
      const id = pathname.split('/')[3];
      json(res, getActiveEnrollments(id));
      return;
    }

    if (
      method === 'POST' &&
      pathname.startsWith('/api/campaigns/') &&
      pathname.endsWith('/enroll')
    ) {
      const id = pathname.split('/')[3];
      readBody(req, (body) => {
        try {
          const { prospect_id } = JSON.parse(body);
          if (!prospect_id) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'prospect_id required' }));
            return;
          }
          enrollProspect({
            id: crypto.randomUUID(),
            campaign_id: id,
            prospect_id,
            current_step: 0,
            status: 'active',
            enrolled_at: new Date().toISOString(),
          });
          json(res, { ok: true });
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid body' }));
        }
      });
      return;
    }

    // ── Agentic campaign builder ──────────────────────────────────────────────

    if (method === 'POST' && pathname === '/api/campaigns/builder/start') {
      const session = startBuilderSession();
      json(res, {
        sessionId: session.id,
        message:
          "Hi! I'm BDR Claude. I'll build your entire outreach campaign in a few questions.\n\nFirst — what product or service are you selling, and in one sentence, who is it for?",
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/campaigns/builder/chat') {
      readBody(req, (body) => {
        (async () => {
          try {
            const { sessionId, message } = JSON.parse(body);
            if (!sessionId || !message) {
              res.writeHead(400);
              res.end(
                JSON.stringify({ error: 'sessionId and message required' }),
              );
              return;
            }
            const result = await builderChat(sessionId, message);
            json(res, result);
          } catch (err) {
            internalError(res, err, 'Campaign builder chat error');
          }
        })();
      });
      return;
    }

    if (
      method === 'POST' &&
      pathname.startsWith('/api/campaigns/') &&
      pathname.endsWith('/edit')
    ) {
      const id = pathname.split('/')[3];
      readBody(req, (body) => {
        (async () => {
          try {
            const { instruction } = JSON.parse(body);
            if (!instruction) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'instruction required' }));
              return;
            }
            const result = await editCampaign(id, instruction);
            json(res, result);
          } catch (err) {
            internalError(res, err, 'Web UI API error');
          }
        })();
      });
      return;
    }

    // ── CRM endpoints ─────────────────────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/crm/adapters') {
      json(
        res,
        getCRMAdapters().map((a) => ({ name: a.name })),
      );
      return;
    }

    if (method === 'POST' && pathname === '/api/crm/pull') {
      (async () => {
        try {
          const contacts = await pullFromCRMs();
          json(res, { contacts, count: contacts.length });
        } catch (err) {
          internalError(res, err, 'Web UI API error');
        }
      })();
      return;
    }

    // ── Meeting Intelligence ──────────────────────────────────────────────────

    if (method === 'POST' && pathname === '/api/meetings/analyze') {
      readBody(req, (body) => {
        (async () => {
          try {
            const { transcript, topic, attendees, myRole } = JSON.parse(body);
            if (!transcript) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'transcript required' }));
              return;
            }
            const analysis = await analyzeMeeting(
              transcript,
              topic ?? '',
              attendees ?? '',
              myRole ?? '',
            );
            json(res, analysis);
          } catch (err) {
            internalError(res, err, 'Meeting analysis error');
          }
        })();
      });
      return;
    }

    // ── Oration ───────────────────────────────────────────────────────────────

    if (method === 'POST' && pathname === '/api/oration') {
      readBody(req, (body) => {
        (async () => {
          try {
            const { text } = JSON.parse(body);
            if (!text) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'text required' }));
              return;
            }
            const result = await processOration(text);
            json(res, result);
          } catch (err) {
            internalError(res, err, 'Oration error');
          }
        })();
      });
      return;
    }

    // ── AI Email platforms ────────────────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/integrations/aiemail/status') {
      (async () => {
        try {
          const instantlyActive = isInstantlyConfigured();
          const salesforgeActive = isSalesforgeConfigured();
          const [instantlyCampaigns, salesforgeSequences] = await Promise.all([
            instantlyActive ? getInstantlyCampaigns() : Promise.resolve([]),
            salesforgeActive ? getSalesforgeSequences() : Promise.resolve([]),
          ]);
          json(res, {
            instantly: {
              active: instantlyActive,
              campaigns: instantlyCampaigns,
            },
            salesforge: {
              active: salesforgeActive,
              sequences: salesforgeSequences,
            },
          });
        } catch (err) {
          internalError(res, err, 'Web UI API error');
        }
      })();
      return;
    }

    if (method === 'POST' && pathname === '/api/integrations/instantly/sync') {
      readBody(req, (body) => {
        (async () => {
          try {
            const { prospects, campaignId } = JSON.parse(body);
            if (!Array.isArray(prospects)) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'prospects array required' }));
              return;
            }
            const result = await syncInstantly(prospects, campaignId);
            json(res, result);
          } catch (err) {
            internalError(res, err, 'Web UI API error');
          }
        })();
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/integrations/salesforge/sync') {
      readBody(req, (body) => {
        (async () => {
          try {
            const { contacts, sequenceId } = JSON.parse(body);
            if (!Array.isArray(contacts)) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'contacts array required' }));
              return;
            }
            const result = await syncSalesforge(contacts, sequenceId);
            json(res, result);
          } catch (err) {
            internalError(res, err, 'Web UI API error');
          }
        })();
      });
      return;
    }

    // ── Zoom webhook ──────────────────────────────────────────────────────────

    if (method === 'POST' && pathname === '/api/zoom/webhook') {
      readBody(req, (body) => {
        try {
          const timestamp =
            (req.headers['x-zm-request-timestamp'] as string) ?? '';
          const signature = (req.headers['x-zm-signature'] as string) ?? '';
          if (!verifyZoomWebhook(body, timestamp, signature)) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Invalid signature' }));
            return;
          }
          const payload = JSON.parse(body);
          // Handle URL validation challenge
          if (payload.event === 'endpoint.url_validation') {
            const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN ?? '';
            const hashForValidate = crypto
              .createHmac('sha256', secret)
              .update(payload.payload.plainToken)
              .digest('hex');
            json(res, {
              plainToken: payload.payload.plainToken,
              encryptedToken: hashForValidate,
            });
            return;
          }
          const result = handleZoomWebhookEvent(payload);
          json(res, { ok: true, result });
        } catch (err) {
          logger.warn({ err }, 'Zoom webhook rejected');
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid request' }));
        }
      });
      return;
    }

    // ── Otter transcripts ─────────────────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/otter/transcripts') {
      (async () => {
        try {
          if (!isOtterConfigured()) {
            json(res, { configured: false, transcripts: [] });
            return;
          }
          const transcripts = await getOtterTranscripts(20);
          json(res, { configured: true, transcripts });
        } catch (err) {
          internalError(res, err, 'Web UI API error');
        }
      })();
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Unknown API route' }));
  } catch (err) {
    logger.error({ err, pathname }, 'Web UI API error');
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
}

// ── Unsubscribe (CAN-SPAM opt-out) ──────────────────────────────────────────────
//
// GET  /unsubscribe?p=<id>&t=<token>  → minimal confirm page (browser click).
// POST /unsubscribe                   → adds the prospect to bdr_suppression via
//   the single authoritative path (addProspectToSuppression). Params may arrive
//   in the query string (RFC 8058 one-click POST from a mail client) or in the
//   form body (the confirm page's button). Fully deterministic — no Claude call.

function handleUnsubscribe(
  method: string,
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (method === 'GET') {
    const p = url.searchParams.get('p') ?? '';
    const t = url.searchParams.get('t') ?? '';
    // A bare visit (e.g. a footer "Unsubscribe" link with no prospect context)
    // shows how to opt out rather than an error — the per-recipient link in each
    // email carries the token that removes that specific contact.
    if (!p && !t) {
      sendHtml(res, 200, unsubscribeInfoPage());
      return;
    }
    if (!verifyUnsubscribeToken(p, t)) {
      sendHtml(res, 400, unsubscribePage('This unsubscribe link is invalid.'));
      return;
    }
    const prospect = getProspectById(p);
    if (prospect && isProspectSuppressed(prospect)) {
      sendHtml(
        res,
        200,
        unsubscribePage('You are already unsubscribed. No further emails.'),
      );
      return;
    }
    sendHtml(res, 200, unsubscribeConfirmPage(p, t));
    return;
  }

  if (method === 'POST') {
    readBody(req, (body) => {
      const form = new URLSearchParams(body);
      // One-click (RFC 8058) keeps p/t in the query; the confirm form posts them
      // in the body. Accept either.
      const p = url.searchParams.get('p') ?? form.get('p') ?? '';
      const t = url.searchParams.get('t') ?? form.get('t') ?? '';

      if (!verifyUnsubscribeToken(p, t)) {
        sendHtml(
          res,
          400,
          unsubscribePage('This unsubscribe link is invalid.'),
        );
        return;
      }

      const prospect = getProspectById(p);
      if (prospect) {
        // Single authoritative suppression path — same one STOP/opt-out uses.
        addProspectToSuppression(prospect, 'unsubscribe:email-link');
        updateProspectStage(prospect.id, 'unsubscribed');
      }
      logger.info({ prospectId: p }, 'Prospect unsubscribed via email link');
      sendHtml(
        res,
        200,
        unsubscribePage(
          'You have been unsubscribed. You will not be emailed again.',
        ),
      );
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function unsubscribeConfirmPage(p: string, t: string): string {
  const params = new URLSearchParams({ p, t }).toString();
  return legalPageShell(
    'Unsubscribe',
    `
    <h1>Unsubscribe</h1>
    <p>Click the button below to stop receiving outreach emails from us.
       This takes effect immediately.</p>
    <form method="POST" action="/unsubscribe?${escapeHtml(params)}">
      <input type="hidden" name="p" value="${escapeHtml(p)}">
      <input type="hidden" name="t" value="${escapeHtml(t)}">
      <button type="submit">Unsubscribe me</button>
    </form>
  `,
  );
}

function unsubscribePage(message: string): string {
  return legalPageShell(
    'Unsubscribe',
    `<h1>Unsubscribe</h1><p>${escapeHtml(message)}</p>`,
  );
}

function unsubscribeInfoPage(): string {
  return legalPageShell(
    'Unsubscribe',
    `
    <h1>Unsubscribe</h1>
    <p>To stop receiving messages from us:</p>
    <ul>
      <li><strong>Email:</strong> use the unsubscribe link at the bottom of any
          email you received from us — it removes your specific address
          immediately.</li>
      <li><strong>SMS:</strong> reply <strong>STOP</strong> to any text message.</li>
    </ul>
    <p>See our <a href="/privacy">Privacy Policy</a> for how we handle opt-outs.</p>
  `,
  );
}

function json(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200);
  res.end(JSON.stringify(data));
}

/**
 * Log the real error server-side, return a sanitized body to the client.
 * All 500s go through here — raw error/SQL/stack text never leaves the
 * process (ISC-36).
 */
function internalError(
  res: http.ServerResponse,
  err: unknown,
  context: string,
): void {
  logger.error({ err }, context);
  res.writeHead(500);
  res.end(JSON.stringify({ error: 'Internal error' }));
}

function sendHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Minimal, dependency-free HTML shell for the public compliance pages
 * (unsubscribe, privacy, terms). `inner` is trusted HTML — callers escape any
 * user/env-derived values before passing them in.
 */
function legalPageShell(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — BDRclaw</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 720px; margin: 0 auto; padding: 40px 24px; line-height: 1.6;
    color: #1a1a2e; background: #f7f8fb; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin-top: 28px; }
  a { color: #2563eb; }
  button { background: #2563eb; color: #fff; border: 0; border-radius: 6px;
    padding: 10px 18px; font-size: 15px; cursor: pointer; margin-top: 12px; }
  button:hover { background: #1d4ed8; }
  .muted { color: #6b7280; font-size: 13px; }
  footer { margin-top: 40px; border-top: 1px solid #e5e7eb; padding-top: 16px;
    font-size: 13px; }
</style>
</head>
<body>
${inner}
<footer class="muted">
  <a href="/privacy">Privacy Policy</a> ·
  <a href="/terms">Terms of Service</a> ·
  <a href="/">Home</a>
</footer>
</body>
</html>`;
}

function readBody(req: http.IncomingMessage, cb: (body: string) => void): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf-8')));
}

// ── Server Startup ────────────────────────────────────────────────────────────

export function startWebUI(): http.Server {
  const server = http.createServer(route);
  server.listen(WEB_PORT, WEB_HOST, () => {
    logger.info(
      { url: `http://${WEB_HOST}:${WEB_PORT}` },
      'BDRclaw Web UI running',
    );
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(
        { port: WEB_PORT },
        'Web UI port in use — dashboard unavailable',
      );
    } else {
      logger.error({ err }, 'Web UI server error');
    }
  });
  return server;
}

// Standalone mode: `npm run web` (tsx src/web-ui.ts) boots the dashboard on
// its own. Boots through the composition root (initCore) so the DB is
// initialized. Dynamic import keeps the heavy channel modules out of the test
// import graph — web-ui.test.ts imports `route` directly.
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  import('./bootstrap.js')
    .then(({ initCore }) => {
      initCore();
      startWebUI();
    })
    .catch((err) => {
      logger.error({ err }, 'Failed to start standalone Web UI');
      process.exit(1);
    });
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────
// Single-file dashboard — no external CDN deps. Polls /api/stats every 30s.

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BDRclaw</title>
<style>
:root {
  --bg:         #06091a;
  --card:       #0d1530;
  --card2:      #111d3d;
  --border:     #1a3060;
  --blue:       #2563eb;
  --blue-light: #3b82f6;
  --blue-glow:  #60a5fa;
  --text:       #e2e8f0;
  --muted:      #4a6080;
  --success:    #10b981;
  --warning:    #f59e0b;
  --danger:     #ef4444;
  --hot:        #a855f7;
  --font:       'SF Mono', 'Fira Code', 'Fira Mono', monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
  min-height: 100vh;
}

/* ── Layout ── */
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--card);
  position: sticky;
  top: 0;
  z-index: 100;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 700;
  color: var(--blue-glow);
  letter-spacing: 1px;
}
.logo span { color: var(--muted); font-weight: 400; font-size: 12px; }
.topbar-right {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--muted);
  font-size: 12px;
}
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.dot.green { background: var(--success); box-shadow: 0 0 6px var(--success); }
.dot.red   { background: var(--danger); }
.dot.yellow { background: var(--warning); }

.content { flex: 1; padding: 20px 24px; max-width: 1400px; margin: 0 auto; width: 100%; }

/* ── Stat Cards ── */
.stat-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}
.stat-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.stat-card:hover { border-color: var(--blue-light); }
.stat-card.hot { border-color: rgba(168,85,247,0.4); }
.stat-card.success { border-color: rgba(16,185,129,0.3); }
.stat-label {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 6px;
}
.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--text);
  line-height: 1;
}
.stat-value.blue  { color: var(--blue-glow); }
.stat-value.hot   { color: var(--hot); }
.stat-value.green { color: var(--success); }
.stat-sub { color: var(--muted); font-size: 11px; margin-top: 4px; }

/* ── Two-col layout ── */
.main-grid {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 16px;
  margin-bottom: 20px;
}

/* ── Panel ── */
.panel {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--card2);
}
.panel-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--blue-glow);
  font-weight: 600;
}
.panel-body { padding: 14px 16px; }

/* ── Pipeline bar ── */
.pipeline-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
  margin-bottom: 10px;
  height: 28px;
}
.pipeline-seg {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  min-width: 28px;
  padding: 0 8px;
  cursor: pointer;
  transition: filter 0.15s;
  overflow: hidden;
  white-space: nowrap;
}
.pipeline-seg:hover { filter: brightness(1.2); }
.pipeline-seg.identified   { background: #1e3a5f; }
.pipeline-seg.outreach_sent { background: #1d4ed8; }
.pipeline-seg.follow_up    { background: #2563eb; }
.pipeline-seg.replied      { background: #7c3aed; }
.pipeline-seg.interested   { background: #a855f7; }
.pipeline-seg.meeting_booked { background: var(--success); }
.pipeline-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--muted);
}
.legend-dot { width: 8px; height: 8px; border-radius: 2px; }

/* ── Prospect list ── */
.prospect-list { display: flex; flex-direction: column; gap: 6px; }
.prospect-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
.prospect-row:hover { background: var(--card2); border-color: var(--border); }
.prospect-name { font-weight: 600; color: var(--text); flex: 1; min-width: 0; }
.prospect-co {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}
.stage-pill {
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
}
.stage-pill.identified    { background: #1e3a5f; color: #7aa0d4; }
.stage-pill.outreach_sent { background: #1e3a8a; color: #93c5fd; }
.stage-pill.follow_up     { background: #1e40af; color: #bfdbfe; }
.stage-pill.replied       { background: #5b21b6; color: #ddd6fe; }
.stage-pill.interested    { background: #7c3aed; color: #ede9fe; }
.stage-pill.meeting_booked { background: #065f46; color: #6ee7b7; }
.stage-pill.handed_off    { background: #1c3a2a; color: #4ade80; }
.stage-pill.not_interested { background: #1c1c2a; color: var(--muted); }
.stage-pill.unsubscribed  { background: #1c1c2a; color: var(--muted); }

/* ── Accounts sidebar ── */
.account-list { display: flex; flex-direction: column; gap: 8px; }
.account-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--card2);
  border-radius: 6px;
  border: 1px solid var(--border);
}
.account-icon {
  width: 28px; height: 28px;
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}
.account-icon.gmail    { background: rgba(37,99,235,0.2); }
.account-icon.outlook  { background: rgba(16,185,129,0.2); }
.account-icon.linkedin { background: rgba(59,130,246,0.2); }
.account-name { flex: 1; font-size: 12px; color: var(--text); }
.account-meta { font-size: 10px; color: var(--muted); }
.account-sends { font-size: 11px; color: var(--muted); text-align: right; }
.account-sends .num { color: var(--blue-glow); font-weight: 600; }

/* ── Brain status ── */
.brain-row {
  display: flex;
  gap: 12px;
  align-items: stretch;
  margin-bottom: 20px;
}
.brain-card {
  flex: 1;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 18px;
}
.brain-title { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px; }
.brain-summary { color: var(--text); font-size: 12px; line-height: 1.6; }
.brain-stats { display: flex; gap: 20px; margin-top: 8px; }
.brain-stat { text-align: center; }
.brain-stat .num { font-size: 20px; font-weight: 700; color: var(--blue-glow); }
.brain-stat .lbl { font-size: 10px; color: var(--muted); text-transform: uppercase; }

/* ── Bottom status bar ── */
.statusbar {
  border-top: 1px solid var(--border);
  background: var(--card);
  padding: 6px 24px;
  display: flex;
  align-items: center;
  gap: 20px;
  font-size: 11px;
  color: var(--muted);
}
.statusbar-item { display: flex; align-items: center; gap: 5px; }
.statusbar-item .val { color: var(--text); }
.ml-auto { margin-left: auto; }

/* ── Empty / Loading ── */
.empty { padding: 24px; text-align: center; color: var(--muted); font-size: 12px; }
.loading { color: var(--muted); font-style: italic; }

/* ── Hot leads section ── */
.hot-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  background: rgba(168,85,247,0.15);
  border: 1px solid rgba(168,85,247,0.3);
  border-radius: 4px;
  color: var(--hot);
  font-size: 10px;
}

/* ── Today activity ── */
.today-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}
.today-item {
  background: var(--card2);
  border-radius: 6px;
  padding: 8px 10px;
  text-align: center;
}
.today-num { font-size: 22px; font-weight: 700; color: var(--blue-glow); }
.today-lbl { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }

/* ── Scrollable lists ── */
.scroll-list { max-height: 320px; overflow-y: auto; }
.scroll-list::-webkit-scrollbar { width: 4px; }
.scroll-list::-webkit-scrollbar-track { background: transparent; }
.scroll-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
</style>
</head>
<body>
<div class="shell">

  <!-- Top bar -->
  <div class="topbar">
    <div class="logo">
      🦞 BDRclaw
      <span>v0.1</span>
    </div>
    <div class="topbar-right">
      <span id="clock"></span>
      <span class="statusbar-item">
        <span class="dot" id="daemon-dot"></span>
        <span id="daemon-status">connecting...</span>
      </span>
    </div>
  </div>

  <!-- Main content -->
  <div class="content">

    <!-- Stat cards -->
    <div class="stat-row">
      <div class="stat-card" onclick="filterProspects(null)">
        <div class="stat-label">Active Prospects</div>
        <div class="stat-value blue" id="stat-active">—</div>
        <div class="stat-sub" id="stat-sub-active">across all stages</div>
      </div>
      <div class="stat-card hot" onclick="filterProspects('interested')">
        <div class="stat-label">Hot Leads</div>
        <div class="stat-value hot" id="stat-hot">—</div>
        <div class="stat-sub">replied + interested</div>
      </div>
      <div class="stat-card success" onclick="filterProspects('meeting_booked')">
        <div class="stat-label">Meetings Booked</div>
        <div class="stat-value green" id="stat-meetings">—</div>
        <div class="stat-sub">total</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Emails Sent Today</div>
        <div class="stat-value" id="stat-emails">—</div>
        <div class="stat-sub" id="stat-li">— linkedin</div>
      </div>
    </div>

    <!-- Pipeline bar -->
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-header">
        <div class="panel-title">Pipeline</div>
        <div style="font-size:11px;color:var(--muted)" id="pipeline-total"></div>
      </div>
      <div class="panel-body">
        <div class="pipeline-row" id="pipeline-bar">
          <div class="empty loading">loading pipeline...</div>
        </div>
        <div class="pipeline-legend">
          <div class="legend-item"><div class="legend-dot" style="background:#1e3a5f"></div>Identified</div>
          <div class="legend-item"><div class="legend-dot" style="background:#1d4ed8"></div>Outreach Sent</div>
          <div class="legend-item"><div class="legend-dot" style="background:#2563eb"></div>Follow Up</div>
          <div class="legend-item"><div class="legend-dot" style="background:#7c3aed"></div>Replied</div>
          <div class="legend-item"><div class="legend-dot" style="background:#a855f7"></div>Interested</div>
          <div class="legend-item"><div class="legend-dot" style="background:#10b981"></div>Meeting Booked</div>
        </div>
      </div>
    </div>

    <!-- Main two-col grid -->
    <div class="main-grid">

      <!-- Left: prospects -->
      <div style="display:flex;flex-direction:column;gap:16px;">

        <!-- Hot leads -->
        <div class="panel" id="hot-panel">
          <div class="panel-header">
            <div class="panel-title">🔥 Hot Leads</div>
            <div id="hot-count" style="font-size:11px;color:var(--hot)"></div>
          </div>
          <div class="panel-body">
            <div class="prospect-list scroll-list" id="hot-list">
              <div class="empty">No hot leads right now</div>
            </div>
          </div>
        </div>

        <!-- All prospects -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title" id="prospects-title">All Prospects</div>
            <input
              id="search-input"
              type="text"
              placeholder="search..."
              style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:3px 8px;color:var(--text);font-size:11px;font-family:var(--font);width:160px;"
              oninput="handleSearch(this.value)"
            >
          </div>
          <div class="panel-body">
            <div class="prospect-list scroll-list" id="prospect-list">
              <div class="empty loading">loading prospects...</div>
            </div>
          </div>
        </div>

      </div>

      <!-- Right sidebar -->
      <div style="display:flex;flex-direction:column;gap:16px;">

        <!-- Accounts -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">Accounts</div>
            <div style="font-size:11px;color:var(--muted)" id="accounts-count"></div>
          </div>
          <div class="panel-body">
            <div class="account-list" id="account-list">
              <div class="empty">No accounts configured<br><span style="color:var(--blue-light)">run npm run wizard</span></div>
            </div>
          </div>
        </div>

        <!-- Today activity -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">Today</div>
          </div>
          <div class="panel-body">
            <div class="today-grid">
              <div class="today-item">
                <div class="today-num" id="today-emails">—</div>
                <div class="today-lbl">Emails</div>
              </div>
              <div class="today-item">
                <div class="today-num" id="today-li">—</div>
                <div class="today-lbl">LinkedIn</div>
              </div>
              <div class="today-item">
                <div class="today-num" id="today-sms">—</div>
                <div class="today-lbl">SMS</div>
              </div>
              <div class="today-item">
                <div class="today-num" id="today-replies">—</div>
                <div class="today-lbl">Replies</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Brain status -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">BDR Brain</div>
            <div id="brain-status-dot" style="font-size:11px;color:var(--muted)"></div>
          </div>
          <div class="panel-body">
            <div id="brain-info" class="brain-summary">
              <div class="empty loading">no brain runs yet</div>
            </div>
          </div>
        </div>

      </div>
    </div>

  </div>

  <!-- Status bar -->
  <div class="statusbar">
    <div class="statusbar-item">
      <span class="dot green"></span>
      <span class="val">BDRclaw</span>
    </div>
    <div class="statusbar-item">Security: <span class="val">moderate</span></div>
    <div class="statusbar-item">DB: <span class="val" id="sb-prospects">—</span> prospects</div>
    <div class="statusbar-item ml-auto" id="sb-updated" style="color:var(--muted)"></div>
  </div>

</div>

<script>
let currentFilter = null;
let searchDebounce = null;

// ── Clock ──────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
    ' — ' + now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
setInterval(updateClock, 1000);
updateClock();

// ── API helpers ────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error('API error: ' + res.status);
  return res.json();
}

// ── Stage display helpers ──────────────────────────────────────────────────
const STAGE_LABELS = {
  identified: 'Identified',
  outreach_sent: 'Outreach Sent',
  follow_up: 'Follow Up',
  replied: 'Replied',
  interested: 'Interested',
  meeting_booked: 'Meeting Booked',
  handed_off: 'Handed Off',
  not_interested: 'Not Interested',
  unsubscribed: 'Unsubscribed',
};
const STAGE_ORDER = ['identified','outreach_sent','follow_up','replied','interested','meeting_booked'];

// ── Render pipeline bar ────────────────────────────────────────────────────
function renderPipeline(byStage) {
  const bar = document.getElementById('pipeline-bar');
  const total = STAGE_ORDER.reduce((s, k) => s + (byStage[k] || 0), 0);
  document.getElementById('pipeline-total').textContent = total + ' active';
  if (total === 0) {
    bar.innerHTML = '<div class="empty" style="padding:0;margin:auto;color:var(--muted)">no prospects yet</div>';
    return;
  }
  bar.innerHTML = STAGE_ORDER.map(stage => {
    const count = byStage[stage] || 0;
    if (count === 0) return '';
    const pct = Math.max(4, (count / total) * 100);
    return \`<div class="pipeline-seg \${stage}" style="flex:\${pct}" title="\${STAGE_LABELS[stage]}: \${count}" onclick="filterProspects('\${stage}')">
      \${count > 0 ? count : ''}
    </div>\`;
  }).join('');
}

// ── Render prospect list ───────────────────────────────────────────────────
function renderProspects(prospects, containerId) {
  const el = document.getElementById(containerId);
  if (prospects.length === 0) {
    el.innerHTML = '<div class="empty">No prospects</div>';
    return;
  }
  el.innerHTML = prospects.map(p => \`
    <div class="prospect-row">
      <div style="min-width:0;flex:1">
        <div class="prospect-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${esc(p.name)}</div>
        <div class="prospect-co">\${esc(p.company)} — \${esc(p.title)}</div>
      </div>
      <span class="stage-pill \${p.stage}">\${STAGE_LABELS[p.stage] || p.stage}</span>
      \${p.next_action_type ? \`<div style="font-size:10px;color:var(--muted);white-space:nowrap">\${esc(p.next_action_type)}</div>\` : ''}
    </div>
  \`).join('');
}

// ── Render accounts ────────────────────────────────────────────────────────
const ACCOUNT_ICONS = { gmail: '📧', outlook: '📮', linkedin: '💼' };
const STATUS_COLORS = { active: 'green', paused: 'yellow', error: 'red', unconfigured: 'red' };

function renderAccounts(accounts) {
  const el = document.getElementById('account-list');
  document.getElementById('accounts-count').textContent =
    accounts.filter(a => a.status === 'active').length + ' active';

  if (accounts.length === 0) {
    el.innerHTML = '<div class="empty">No accounts configured<br><span style="color:var(--blue-light)">run npm run wizard</span></div>';
    return;
  }
  el.innerHTML = accounts.map(a => \`
    <div class="account-card">
      <div class="account-icon \${a.type}">\${ACCOUNT_ICONS[a.type] || '📱'}</div>
      <div style="flex:1;min-width:0">
        <div class="account-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${esc(a.name)}</div>
        <div class="account-meta">\${esc(a.email || a.type)}</div>
      </div>
      <div style="text-align:right">
        <div><span class="dot \${STATUS_COLORS[a.status] || 'yellow'}"></span></div>
        <div class="account-sends"><span class="num">\${a.sends_today}</span>/\${a.daily_send_limit}</div>
      </div>
    </div>
  \`).join('');
}

// ── Render brain status ────────────────────────────────────────────────────
function renderBrain(run) {
  const el = document.getElementById('brain-info');
  if (!run) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px">No brain runs yet. First run scheduled for 6am.</div>';
    return;
  }
  const d = new Date(run.run_at);
  const ago = timeSince(d);
  document.getElementById('brain-status-dot').textContent = 'last: ' + ago;
  el.innerHTML = \`
    <div style="color:var(--muted);font-size:11px;margin-bottom:10px">
      \${d.toLocaleString()} — \${run.status === 'completed' ? '<span style="color:var(--success)">✓ completed</span>' : '<span style="color:var(--danger)">✗ error</span>'}
      \${run.duration_ms ? ' in ' + (run.duration_ms/1000).toFixed(1) + 's' : ''}
    </div>
    <div class="brain-stats">
      <div class="brain-stat"><div class="num">\${run.prospects_reviewed}</div><div class="lbl">Reviewed</div></div>
      <div class="brain-stat"><div class="num">\${run.actions_queued}</div><div class="lbl">Actions</div></div>
      <div class="brain-stat"><div class="num" style="color:var(--hot)">\${run.hot_leads_found}</div><div class="lbl">Hot Leads</div></div>
    </div>
  \`;
}

// ── Main data load ─────────────────────────────────────────────────────────
async function loadAll() {
  try {
    const [stats, accounts] = await Promise.all([
      api('/api/stats'),
      api('/api/accounts'),
    ]);

    // Stat cards
    document.getElementById('stat-active').textContent = stats.total_active;
    document.getElementById('stat-hot').textContent = stats.hot_leads;
    document.getElementById('stat-meetings').textContent = stats.meetings_booked_total;
    document.getElementById('stat-emails').textContent = stats.today.emails_sent;
    document.getElementById('stat-li').textContent = stats.today.linkedin_connects + ' linkedin';
    document.getElementById('sb-prospects').textContent = stats.total_active;

    // Today
    document.getElementById('today-emails').textContent = stats.today.emails_sent;
    document.getElementById('today-li').textContent = stats.today.linkedin_connects;
    document.getElementById('today-sms').textContent = stats.today.sms_sent;
    document.getElementById('today-replies').textContent = stats.today.replies_received;

    // Pipeline
    renderPipeline(stats.by_stage || {});

    // Accounts
    renderAccounts(accounts);

    // Brain
    if (stats.brain_last_run) renderBrain(stats.brain_last_run);

    // Daemon status
    document.getElementById('daemon-dot').className = 'dot green';
    document.getElementById('daemon-status').textContent = 'running';

    // Update timestamp
    document.getElementById('sb-updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('daemon-dot').className = 'dot red';
    document.getElementById('daemon-status').textContent = 'unreachable';
  }
}

async function loadProspects(filter) {
  try {
    const url = filter ? '/api/prospects?stage=' + filter + '&limit=50' : '/api/prospects?limit=50';
    const prospects = await api(url);
    document.getElementById('prospects-title').textContent =
      filter ? (STAGE_LABELS[filter] || filter) : 'All Prospects';
    renderProspects(prospects, 'prospect-list');
  } catch (e) {
    document.getElementById('prospect-list').innerHTML = '<div class="empty">Error loading prospects</div>';
  }
}

async function loadHotLeads() {
  try {
    const hot = await api('/api/prospects/hot');
    document.getElementById('hot-count').textContent = hot.length + ' leads';
    renderProspects(hot, 'hot-list');
    document.getElementById('hot-panel').style.display = hot.length === 0 ? 'none' : '';
  } catch (e) {}
}

function filterProspects(stage) {
  currentFilter = stage;
  loadProspects(stage);
}

function handleSearch(val) {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    if (val.length < 2) {
      loadProspects(currentFilter);
      return;
    }
    try {
      const results = await api('/api/prospects?q=' + encodeURIComponent(val) + '&limit=20');
      document.getElementById('prospects-title').textContent = 'Search: ' + val;
      renderProspects(results, 'prospect-list');
    } catch (e) {}
  }, 300);
}

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function timeSince(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

// ── Init + polling ─────────────────────────────────────────────────────────
loadAll();
loadHotLeads();
loadProspects(null);
setInterval(loadAll, 30000);
setInterval(loadHotLeads, 60000);
</script>
</body>
</html>`;
