import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import type {
  BDRAccount,
  BDRBrainRun,
  BDRProspect,
  BDRTouch,
  BuilderSession,
  Campaign,
  CampaignEnrollment,
  CampaignStep,
  ImportJob,
  PipelineStats,
  TouchChannel,
} from './bdr-types.js';

let db: Database.Database;

export function getBdrDb(): Database.Database {
  return db;
}

export function initBDRDatabase(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  db = new Database(path.join(STORE_DIR, 'bdr.db'));
  createSchema(db);
}

/** @internal - for tests only */
export function _initBDRTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS bdr_accounts (
      id                TEXT PRIMARY KEY,
      type              TEXT NOT NULL,
      name              TEXT NOT NULL,
      email             TEXT,
      credentials_key   TEXT,
      status            TEXT NOT NULL DEFAULT 'unconfigured',
      daily_send_limit  INTEGER NOT NULL DEFAULT 50,
      sends_today       INTEGER NOT NULL DEFAULT 0,
      last_reset_date   TEXT,
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bdr_prospects (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      email                TEXT,
      linkedin_url         TEXT,
      phone                TEXT,
      company              TEXT NOT NULL,
      title                TEXT NOT NULL,
      stage                TEXT NOT NULL DEFAULT 'identified',
      assigned_account_id  TEXT,
      source               TEXT NOT NULL DEFAULT 'manual',
      enrichment           TEXT,
      tags                 TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      last_touch_at        TEXT,
      next_action_at       TEXT,
      next_action_type     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prospect_stage      ON bdr_prospects(stage);
    CREATE INDEX IF NOT EXISTS idx_prospect_next_action ON bdr_prospects(next_action_at);
    CREATE INDEX IF NOT EXISTS idx_prospect_company    ON bdr_prospects(company);
    CREATE INDEX IF NOT EXISTS idx_prospect_updated    ON bdr_prospects(updated_at);

    CREATE TABLE IF NOT EXISTS bdr_touches (
      id                   TEXT PRIMARY KEY,
      prospect_id          TEXT NOT NULL,
      account_id           TEXT,
      channel              TEXT NOT NULL,
      direction            TEXT NOT NULL,
      subject              TEXT,
      content              TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'sent',
      sent_at              TEXT NOT NULL,
      reply_classification TEXT,
      FOREIGN KEY (prospect_id) REFERENCES bdr_prospects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_touch_prospect ON bdr_touches(prospect_id);
    CREATE INDEX IF NOT EXISTS idx_touch_sent_at  ON bdr_touches(sent_at);
    CREATE INDEX IF NOT EXISTS idx_touch_channel  ON bdr_touches(channel, direction, sent_at);

    CREATE TABLE IF NOT EXISTS bdr_brain_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at              TEXT NOT NULL,
      duration_ms         INTEGER,
      prospects_reviewed  INTEGER NOT NULL DEFAULT 0,
      actions_queued      INTEGER NOT NULL DEFAULT 0,
      hot_leads_found     INTEGER NOT NULL DEFAULT 0,
      meetings_booked     INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL,
      summary             TEXT,
      error               TEXT
    );

    CREATE TABLE IF NOT EXISTS bdr_import_jobs (
      id             TEXT PRIMARY KEY,
      filename       TEXT NOT NULL,
      source         TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      total_rows     INTEGER NOT NULL DEFAULT 0,
      imported_rows  INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      created_at     TEXT NOT NULL,
      completed_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS bdr_campaigns (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      description        TEXT,
      icp_description    TEXT,
      value_proposition  TEXT,
      tone               TEXT NOT NULL DEFAULT 'friendly',
      jitter_minutes     INTEGER NOT NULL DEFAULT 30,
      status             TEXT NOT NULL DEFAULT 'draft',
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bdr_campaign_steps (
      id           TEXT PRIMARY KEY,
      campaign_id  TEXT NOT NULL,
      step_number  INTEGER NOT NULL,
      action_type  TEXT NOT NULL,
      delay_days   INTEGER NOT NULL DEFAULT 0,
      subject      TEXT,
      template     TEXT NOT NULL,
      condition    TEXT NOT NULL DEFAULT 'always',
      FOREIGN KEY (campaign_id) REFERENCES bdr_campaigns(id) ON DELETE CASCADE,
      UNIQUE (campaign_id, step_number)
    );
    CREATE INDEX IF NOT EXISTS idx_step_campaign ON bdr_campaign_steps(campaign_id);

    CREATE TABLE IF NOT EXISTS bdr_campaign_enrollments (
      id            TEXT PRIMARY KEY,
      campaign_id   TEXT NOT NULL,
      prospect_id   TEXT NOT NULL,
      current_step  INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'active',
      enrolled_at   TEXT NOT NULL,
      last_step_at  TEXT,
      completed_at  TEXT,
      FOREIGN KEY (campaign_id)  REFERENCES bdr_campaigns(id),
      FOREIGN KEY (prospect_id)  REFERENCES bdr_prospects(id),
      UNIQUE (campaign_id, prospect_id)
    );
    CREATE INDEX IF NOT EXISTS idx_enrollment_prospect  ON bdr_campaign_enrollments(prospect_id);
    CREATE INDEX IF NOT EXISTS idx_enrollment_campaign  ON bdr_campaign_enrollments(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_enrollment_status    ON bdr_campaign_enrollments(status);

    CREATE TABLE IF NOT EXISTS bdr_builder_sessions (
      id          TEXT PRIMARY KEY,
      messages    TEXT NOT NULL DEFAULT '[]',
      draft       TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bdr_second_brain (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL DEFAULT '',
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bdr_closed_deals (
      id             TEXT PRIMARY KEY,
      prospect_id    TEXT,
      prospect_name  TEXT NOT NULL,
      company        TEXT NOT NULL,
      amount         REAL NOT NULL DEFAULT 0,
      closed_at      TEXT NOT NULL,
      notes          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deal_closed_at ON bdr_closed_deals(closed_at);

    CREATE TABLE IF NOT EXISTS bdr_documents (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      stage        TEXT NOT NULL DEFAULT 'general',
      mime_type    TEXT NOT NULL,
      size         INTEGER NOT NULL DEFAULT 0,
      content      TEXT NOT NULL DEFAULT '',
      uploaded_at  TEXT NOT NULL,
      notes        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_doc_stage ON bdr_documents(stage);

    CREATE TABLE IF NOT EXISTS bdr_agent_runs (
      id          TEXT PRIMARY KEY,
      agent       TEXT NOT NULL,
      run_at      TEXT NOT NULL,
      duration_ms INTEGER,
      status      TEXT NOT NULL DEFAULT 'ok',
      result      TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_run_agent ON bdr_agent_runs(agent, run_at);

    -- Inbound idempotency: exactly-once reply processing per message id.
    -- Prevents boot re-scan / webhook retry / long-poll redelivery from
    -- replaying historical inbound messages through the reply handler.
    CREATE TABLE IF NOT EXISTS bdr_processed_inbound (
      message_id   TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );

    -- Global outbound suppression list. One row per contact identifier so a
    -- contact suppressed via one prospect record is honored across all records.
    CREATE TABLE IF NOT EXISTS bdr_suppression (
      contact     TEXT PRIMARY KEY,
      channel     TEXT,
      reason      TEXT,
      created_at  TEXT NOT NULL
    );
  `);
}

// ── Accounts ──────────────────────────────────────────────────────────────────

export function upsertAccount(account: BDRAccount): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO bdr_accounts
      (id, type, name, email, credentials_key, status, daily_send_limit,
       sends_today, last_reset_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    account.id,
    account.type,
    account.name,
    account.email ?? null,
    account.credentials_key ?? null,
    account.status,
    account.daily_send_limit,
    account.sends_today,
    account.last_reset_date ?? null,
    account.created_at,
  );
}

export function getAllAccounts(): BDRAccount[] {
  return db
    .prepare('SELECT * FROM bdr_accounts ORDER BY type, name')
    .all() as BDRAccount[];
}

export function getAccountById(id: string): BDRAccount | undefined {
  return db.prepare('SELECT * FROM bdr_accounts WHERE id = ?').get(id) as
    | BDRAccount
    | undefined;
}

export function updateAccountStatus(
  id: string,
  status: BDRAccount['status'],
): void {
  db.prepare('UPDATE bdr_accounts SET status = ? WHERE id = ?').run(status, id);
}

export function incrementAccountSends(id: string): void {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `
    UPDATE bdr_accounts SET
      sends_today     = CASE WHEN last_reset_date = ? THEN sends_today + 1 ELSE 1 END,
      last_reset_date = ?
    WHERE id = ?
  `,
  ).run(today, today, id);
}

export function resetDailySendCounts(): void {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `
    UPDATE bdr_accounts SET sends_today = 0, last_reset_date = ?
    WHERE last_reset_date < ? OR last_reset_date IS NULL
  `,
  ).run(today, today);
}

// ── Prospects ─────────────────────────────────────────────────────────────────

export function upsertProspect(prospect: BDRProspect): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO bdr_prospects
      (id, name, email, linkedin_url, phone, company, title, stage,
       assigned_account_id, source, enrichment, tags,
       created_at, updated_at, last_touch_at, next_action_at, next_action_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    prospect.id,
    prospect.name,
    prospect.email ?? null,
    prospect.linkedin_url ?? null,
    prospect.phone ?? null,
    prospect.company,
    prospect.title,
    prospect.stage,
    prospect.assigned_account_id ?? null,
    prospect.source,
    prospect.enrichment ?? null,
    prospect.tags ?? null,
    prospect.created_at,
    prospect.updated_at,
    prospect.last_touch_at ?? null,
    prospect.next_action_at ?? null,
    prospect.next_action_type ?? null,
  );
}

/** Convenience wrapper that generates an id/timestamps and calls upsertProspect. */
export function addProspect(fields: {
  name: string;
  company: string;
  title: string;
  email?: string | null;
  linkedin_url?: string | null;
  phone?: string | null;
  source?: BDRProspect['source'];
  tags?: string | null;
}): BDRProspect {
  const now = new Date().toISOString();
  const slug = `${fields.name}-${fields.company}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const id = `${slug}-${Date.now().toString(36)}`;
  const prospect: BDRProspect = {
    id,
    name: fields.name,
    company: fields.company,
    title: fields.title,
    email: fields.email ?? undefined,
    linkedin_url: fields.linkedin_url ?? undefined,
    phone: fields.phone ?? undefined,
    stage: 'identified',
    assigned_account_id: undefined,
    source: fields.source ?? 'manual',
    enrichment: undefined,
    tags: fields.tags ?? undefined,
    created_at: now,
    updated_at: now,
    last_touch_at: undefined,
    next_action_at: undefined,
    next_action_type: undefined,
  };
  upsertProspect(prospect);
  return prospect;
}

export function getProspectById(id: string): BDRProspect | undefined {
  return db.prepare('SELECT * FROM bdr_prospects WHERE id = ?').get(id) as
    | BDRProspect
    | undefined;
}

/**
 * Resolve a prospect from an inbound message's channel + contact identifier.
 * Break A depends on this: without it, an inbound reply can't be mapped back
 * to the prospect it came from. Column-backed channels use an indexed lookup;
 * enrichment-JSON channels (twitter/telegram/instagram) do a candidate scan
 * then verify the parsed value in JS to avoid LIKE false positives.
 */
export function getProspectByContact(
  channel: TouchChannel,
  contactId: string,
): BDRProspect | undefined {
  const raw = contactId.trim();
  if (!raw) return undefined;

  switch (channel) {
    case 'sms':
    case 'whatsapp': {
      // Compare E.164 tolerant of a leading '+'.
      const digits = raw.replace(/^\+/, '');
      return db
        .prepare(
          `SELECT * FROM bdr_prospects
           WHERE phone IS NOT NULL
             AND REPLACE(phone, '+', '') = ?
           LIMIT 1`,
        )
        .get(digits) as BDRProspect | undefined;
    }

    case 'email':
      return db
        .prepare(
          'SELECT * FROM bdr_prospects WHERE LOWER(email) = LOWER(?) LIMIT 1',
        )
        .get(raw) as BDRProspect | undefined;

    case 'linkedin': {
      // Normalize like profileUrlToJid (strip query string + trailing slash)
      // on both sides. linkedin_url has no dedicated index and stored values
      // may carry query strings, so normalize in JS for a correct compare.
      const clean = raw.split('?')[0].replace(/\/$/, '');
      const rows = db
        .prepare('SELECT * FROM bdr_prospects WHERE linkedin_url IS NOT NULL')
        .all() as BDRProspect[];
      return rows.find(
        (p) => p.linkedin_url!.split('?')[0].replace(/\/$/, '') === clean,
      );
    }

    case 'twitter':
      return scanEnrichmentProspects((_p, e) => {
        const uname = raw.replace(/^@/, '').toLowerCase();
        if (e.twitter_user_id != null && String(e.twitter_user_id) === raw)
          return true;
        const handle = (e.twitter_handle ?? e.twitter_username) as
          | string
          | undefined;
        return (
          handle != null &&
          String(handle).replace(/^@/, '').toLowerCase() === uname
        );
      });

    case 'telegram':
      return scanEnrichmentProspects(
        (_p, e) =>
          e.telegram_chat_id != null && String(e.telegram_chat_id) === raw,
      );

    case 'instagram':
      return scanEnrichmentProspects(
        (_p, e) =>
          (e.instagram_id != null && String(e.instagram_id) === raw) ||
          (e.instagram_user_id != null && String(e.instagram_user_id) === raw),
      );

    default:
      return undefined;
  }
}

/**
 * Scan prospects that have enrichment data, parse the JSON once per row, and
 * return the first row matching the predicate. Used for channels whose contact
 * id lives inside the enrichment JSON TEXT column (no dedicated index).
 */
function scanEnrichmentProspects(
  match: (
    prospect: BDRProspect,
    enrichment: Record<string, unknown>,
  ) => boolean,
): BDRProspect | undefined {
  const rows = db
    .prepare(
      "SELECT * FROM bdr_prospects WHERE enrichment IS NOT NULL AND enrichment != ''",
    )
    .all() as BDRProspect[];
  for (const row of rows) {
    let enrichment: Record<string, unknown> = {};
    try {
      enrichment = row.enrichment ? JSON.parse(row.enrichment) : {};
    } catch {
      continue;
    }
    if (match(row, enrichment)) return row;
  }
  return undefined;
}

/**
 * Mark an inbound message id as processed. Returns true if newly inserted
 * (caller should process it), false if it was already seen (skip — idempotent).
 */
export function markInboundProcessed(messageId: string): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO bdr_processed_inbound (message_id, processed_at)
       VALUES (?, ?)`,
    )
    .run(messageId, new Date().toISOString());
  return result.changes > 0;
}

// ── Suppression (global opt-out enforcement) ────────────────────────────────────

/** All normalized contact identifiers for a prospect, for suppression keying. */
function prospectContactKeys(prospect: BDRProspect): string[] {
  const keys: string[] = [`id:${prospect.id}`];
  if (prospect.email) keys.push(`email:${prospect.email.toLowerCase()}`);
  if (prospect.phone) keys.push(`phone:${prospect.phone.replace(/^\+/, '')}`);
  if (prospect.linkedin_url)
    keys.push(
      `linkedin:${prospect.linkedin_url.split('?')[0].replace(/\/$/, '')}`,
    );
  if (prospect.enrichment) {
    try {
      const e = JSON.parse(prospect.enrichment) as Record<string, unknown>;
      if (e.twitter_user_id != null) keys.push(`twitter:${e.twitter_user_id}`);
      if (e.telegram_chat_id != null)
        keys.push(`telegram:${e.telegram_chat_id}`);
      if (e.instagram_id != null) keys.push(`instagram:${e.instagram_id}`);
      if (e.instagram_user_id != null)
        keys.push(`instagram:${e.instagram_user_id}`);
    } catch {
      /* enrichment not JSON */
    }
  }
  return keys;
}

/** Add every contact identifier of a prospect to the global suppression list. */
export function addProspectToSuppression(
  prospect: BDRProspect,
  reason: string,
): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO bdr_suppression (contact, channel, reason, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const insertAll = db.transaction((keys: string[]) => {
    for (const key of keys) stmt.run(key, null, reason, now);
  });
  insertAll(prospectContactKeys(prospect));
}

/** True if the prospect's id or ANY of its contact identifiers is suppressed. */
export function isProspectSuppressed(prospect: BDRProspect): boolean {
  const keys = prospectContactKeys(prospect);
  const placeholders = keys.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT 1 FROM bdr_suppression WHERE contact IN (${placeholders}) LIMIT 1`,
    )
    .get(...keys);
  return row !== undefined;
}

export function getAllProspects(limit = 100, offset = 0): BDRProspect[] {
  return db
    .prepare(
      'SELECT * FROM bdr_prospects ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    )
    .all(limit, offset) as BDRProspect[];
}

export function getProspectsByStage(stage: string): BDRProspect[] {
  return db
    .prepare(
      'SELECT * FROM bdr_prospects WHERE stage = ? ORDER BY next_action_at ASC',
    )
    .all(stage) as BDRProspect[];
}

export function getActiveProspects(): BDRProspect[] {
  return db
    .prepare(
      `
    SELECT * FROM bdr_prospects
    WHERE stage NOT IN ('handed_off', 'not_interested', 'unsubscribed')
    ORDER BY next_action_at ASC
  `,
    )
    .all() as BDRProspect[];
}

export function getDueProspects(): BDRProspect[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM bdr_prospects
    WHERE next_action_at IS NOT NULL
      AND next_action_at <= ?
      AND stage NOT IN ('handed_off', 'not_interested', 'unsubscribed')
    ORDER BY next_action_at ASC
    LIMIT 50
  `,
    )
    .all(now) as BDRProspect[];
}

export function getHotProspects(): BDRProspect[] {
  return db
    .prepare(
      `
    SELECT * FROM bdr_prospects
    WHERE stage IN ('replied', 'interested', 'meeting_booked')
    ORDER BY updated_at DESC
  `,
    )
    .all() as BDRProspect[];
}

export function updateProspectStage(id: string, stage: string): void {
  db.prepare(
    `
    UPDATE bdr_prospects SET stage = ?, updated_at = ? WHERE id = ?
  `,
  ).run(stage, new Date().toISOString(), id);

  // ISC-25: sync to all active CRM adapters on every stage change.
  // Import lazily to avoid circular dependency at module load time.
  // Failure does NOT block the stage change (ISC-27).
  const prospect = db
    .prepare('SELECT * FROM bdr_prospects WHERE id = ?')
    .get(id) as import('./bdr-types.js').BDRProspect | undefined;
  if (prospect) {
    import('./crm/registry.js')
      .then(({ pushToCRMs }) => {
        pushToCRMs({
          type: 'stage_change',
          prospect,
          timestamp: new Date().toISOString(),
          details: { newStage: stage },
        }).catch(() => {
          /* logged inside pushToCRMs */
        });
      })
      .catch(() => {
        /* CRM registry not loaded yet */
      });
  }
}

export function updateProspectNextAction(
  id: string,
  nextActionAt: string,
  nextActionType: string,
): void {
  db.prepare(
    `
    UPDATE bdr_prospects
    SET next_action_at = ?, next_action_type = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(nextActionAt, nextActionType, new Date().toISOString(), id);
}

export function getProspectStageCounts(): Record<string, number> {
  const rows = db
    .prepare(
      'SELECT stage, COUNT(*) as count FROM bdr_prospects GROUP BY stage',
    )
    .all() as Array<{ stage: string; count: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) result[row.stage] = row.count;
  return result;
}

export function searchProspects(query: string, limit = 20): BDRProspect[] {
  const like = `%${query}%`;
  return db
    .prepare(
      `
    SELECT * FROM bdr_prospects
    WHERE name LIKE ? OR company LIKE ? OR email LIKE ? OR title LIKE ?
    ORDER BY updated_at DESC LIMIT ?
  `,
    )
    .all(like, like, like, like, limit) as BDRProspect[];
}

// ── Touches ───────────────────────────────────────────────────────────────────

export function recordTouch(touch: BDRTouch): void {
  db.prepare(
    `
    INSERT INTO bdr_touches
      (id, prospect_id, account_id, channel, direction, subject, content,
       status, sent_at, reply_classification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    touch.id,
    touch.prospect_id,
    touch.account_id ?? null,
    touch.channel,
    touch.direction,
    touch.subject ?? null,
    touch.content,
    touch.status,
    touch.sent_at,
    touch.reply_classification ?? null,
  );
  db.prepare(
    `
    UPDATE bdr_prospects SET last_touch_at = ?, updated_at = ? WHERE id = ?
  `,
  ).run(touch.sent_at, new Date().toISOString(), touch.prospect_id);
}

export function getTouchesForProspect(prospectId: string): BDRTouch[] {
  return db
    .prepare(
      'SELECT * FROM bdr_touches WHERE prospect_id = ? ORDER BY sent_at ASC',
    )
    .all(prospectId) as BDRTouch[];
}

export function getTodayTouches(): {
  emails: number;
  linkedin: number;
  sms: number;
  replies: number;
} {
  const today = new Date().toISOString().slice(0, 10);
  const since = `${today}T00:00:00.000Z`;
  const rows = db
    .prepare(
      `
    SELECT channel, direction, COUNT(*) as count FROM bdr_touches
    WHERE sent_at >= ?
    GROUP BY channel, direction
  `,
    )
    .all(since) as Array<{ channel: string; direction: string; count: number }>;

  const counts = { emails: 0, linkedin: 0, sms: 0, replies: 0 };
  for (const r of rows) {
    if (r.channel === 'email' && r.direction === 'outbound')
      counts.emails = r.count;
    if (r.channel === 'linkedin' && r.direction === 'outbound')
      counts.linkedin = r.count;
    if (r.channel === 'sms' && r.direction === 'outbound') counts.sms = r.count;
    if (r.direction === 'inbound') counts.replies += r.count;
  }
  return counts;
}

// ── Brain Runs ────────────────────────────────────────────────────────────────

export function startBrainRun(): number {
  const result = db
    .prepare(
      `
    INSERT INTO bdr_brain_runs
      (run_at, status, prospects_reviewed, actions_queued, hot_leads_found, meetings_booked)
    VALUES (?, 'running', 0, 0, 0, 0)
  `,
    )
    .run(new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function completeBrainRun(id: number, data: Partial<BDRBrainRun>): void {
  db.prepare(
    `
    UPDATE bdr_brain_runs SET
      status = ?, duration_ms = ?, prospects_reviewed = ?, actions_queued = ?,
      hot_leads_found = ?, meetings_booked = ?, summary = ?, error = ?
    WHERE id = ?
  `,
  ).run(
    data.status ?? 'completed',
    data.duration_ms ?? null,
    data.prospects_reviewed ?? 0,
    data.actions_queued ?? 0,
    data.hot_leads_found ?? 0,
    data.meetings_booked ?? 0,
    data.summary ?? null,
    data.error ?? null,
    id,
  );
}

export function getLastBrainRun(): BDRBrainRun | undefined {
  return db
    .prepare('SELECT * FROM bdr_brain_runs ORDER BY run_at DESC LIMIT 1')
    .get() as BDRBrainRun | undefined;
}

export function getRecentBrainRuns(limit = 10): BDRBrainRun[] {
  return db
    .prepare('SELECT * FROM bdr_brain_runs ORDER BY run_at DESC LIMIT ?')
    .all(limit) as BDRBrainRun[];
}

// ── Import Jobs ───────────────────────────────────────────────────────────────

export function createImportJob(job: ImportJob): void {
  db.prepare(
    `
    INSERT INTO bdr_import_jobs
      (id, filename, source, status, total_rows, imported_rows, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    job.id,
    job.filename,
    job.source,
    job.status,
    job.total_rows,
    job.imported_rows,
    job.created_at,
  );
}

export function updateImportJob(id: string, updates: Partial<ImportJob>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.total_rows !== undefined) {
    fields.push('total_rows = ?');
    values.push(updates.total_rows);
  }
  if (updates.imported_rows !== undefined) {
    fields.push('imported_rows = ?');
    values.push(updates.imported_rows);
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }
  if (updates.completed_at !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completed_at);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE bdr_import_jobs SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function getRecentImportJobs(limit = 10): ImportJob[] {
  return db
    .prepare('SELECT * FROM bdr_import_jobs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as ImportJob[];
}

// ── Campaigns ─────────────────────────────────────────────────────────────────

export function upsertCampaign(campaign: Campaign): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO bdr_campaigns
      (id, name, description, icp_description, value_proposition,
       tone, jitter_minutes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    campaign.id,
    campaign.name,
    campaign.description ?? null,
    campaign.icp_description ?? null,
    campaign.value_proposition ?? null,
    campaign.tone,
    campaign.jitter_minutes,
    campaign.status,
    campaign.created_at,
    campaign.updated_at,
  );
}

export function getCampaignById(id: string): Campaign | undefined {
  return db.prepare('SELECT * FROM bdr_campaigns WHERE id = ?').get(id) as
    | Campaign
    | undefined;
}

export function listCampaigns(): Campaign[] {
  return db
    .prepare('SELECT * FROM bdr_campaigns ORDER BY updated_at DESC')
    .all() as Campaign[];
}

export function upsertCampaignStep(step: CampaignStep): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO bdr_campaign_steps
      (id, campaign_id, step_number, action_type, delay_days, subject, template, condition)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    step.id,
    step.campaign_id,
    step.step_number,
    step.action_type,
    step.delay_days,
    step.subject ?? null,
    step.template,
    step.condition,
  );
}

export function getCampaignSteps(campaignId: string): CampaignStep[] {
  return db
    .prepare(
      'SELECT * FROM bdr_campaign_steps WHERE campaign_id = ? ORDER BY step_number ASC',
    )
    .all(campaignId) as CampaignStep[];
}

export function deleteCampaignSteps(campaignId: string): void {
  db.prepare('DELETE FROM bdr_campaign_steps WHERE campaign_id = ?').run(
    campaignId,
  );
}

export function enrollProspect(enrollment: CampaignEnrollment): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO bdr_campaign_enrollments
      (id, campaign_id, prospect_id, current_step, status, enrolled_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    enrollment.id,
    enrollment.campaign_id,
    enrollment.prospect_id,
    enrollment.current_step,
    enrollment.status,
    enrollment.enrolled_at,
  );
}

export function getEnrollment(
  campaignId: string,
  prospectId: string,
): CampaignEnrollment | undefined {
  return db
    .prepare(
      'SELECT * FROM bdr_campaign_enrollments WHERE campaign_id = ? AND prospect_id = ?',
    )
    .get(campaignId, prospectId) as CampaignEnrollment | undefined;
}

export function getActiveEnrollments(
  campaignId?: string,
): CampaignEnrollment[] {
  if (campaignId) {
    return db
      .prepare(
        "SELECT * FROM bdr_campaign_enrollments WHERE campaign_id = ? AND status = 'active'",
      )
      .all(campaignId) as CampaignEnrollment[];
  }
  return db
    .prepare("SELECT * FROM bdr_campaign_enrollments WHERE status = 'active'")
    .all() as CampaignEnrollment[];
}

export function updateEnrollment(
  id: string,
  updates: Partial<CampaignEnrollment>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.current_step !== undefined) {
    fields.push('current_step = ?');
    values.push(updates.current_step);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.last_step_at !== undefined) {
    fields.push('last_step_at = ?');
    values.push(updates.last_step_at);
  }
  if (updates.completed_at !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completed_at);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE bdr_campaign_enrollments SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

// ── Builder Sessions ──────────────────────────────────────────────────────────

export function upsertBuilderSession(session: BuilderSession): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO bdr_builder_sessions
      (id, messages, draft, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    session.id,
    JSON.stringify(session.messages),
    session.draft ? JSON.stringify(session.draft) : null,
    session.created_at,
    session.updated_at,
  );
}

export function getBuilderSession(id: string): BuilderSession | undefined {
  const row = db
    .prepare('SELECT * FROM bdr_builder_sessions WHERE id = ?')
    .get(id) as
    | {
        id: string;
        messages: string;
        draft: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    messages: JSON.parse(row.messages),
    draft: row.draft ? JSON.parse(row.draft) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Aggregated Stats ──────────────────────────────────────────────────────────

export function getPipelineStats(): PipelineStats {
  const stageCounts = getProspectStageCounts();
  const today = getTodayTouches();
  const brain = getLastBrainRun();

  const activeStages = [
    'identified',
    'outreach_sent',
    'follow_up',
    'replied',
    'interested',
  ];
  const totalActive = activeStages.reduce(
    (sum, s) => sum + (stageCounts[s] ?? 0),
    0,
  );

  return {
    total_active: totalActive,
    by_stage: stageCounts,
    hot_leads: (stageCounts['replied'] ?? 0) + (stageCounts['interested'] ?? 0),
    meetings_booked_total: stageCounts['meeting_booked'] ?? 0,
    today: {
      emails_sent: today.emails,
      linkedin_connects: today.linkedin,
      sms_sent: today.sms,
      replies_received: today.replies,
    },
    brain_last_run: brain
      ? {
          run_at: brain.run_at,
          status: brain.status,
          prospects_reviewed: brain.prospects_reviewed,
          actions_queued: brain.actions_queued,
          hot_leads_found: brain.hot_leads_found,
        }
      : undefined,
  };
}

export interface ActivityItem {
  id: string;
  type: 'sent' | 'replied' | 'blocked' | 'hot_lead';
  prospect_name: string;
  prospect_company: string;
  channel: string;
  direction: string;
  content_preview: string;
  classification: string | null;
  sent_at: string;
}

export function getRecentActivity(limit = 20): ActivityItem[] {
  const rows = db
    .prepare(
      `
    SELECT
      t.id, t.channel, t.direction, t.status, t.reply_classification,
      t.sent_at, SUBSTR(t.content, 1, 80) as content_preview,
      p.name as prospect_name, p.company as prospect_company
    FROM bdr_touches t
    JOIN bdr_prospects p ON t.prospect_id = p.id
    ORDER BY t.sent_at DESC
    LIMIT ?
  `,
    )
    .all(limit) as Array<{
    id: string;
    channel: string;
    direction: string;
    status: string;
    reply_classification: string | null;
    sent_at: string;
    content_preview: string;
    prospect_name: string;
    prospect_company: string;
  }>;

  return rows.map((r) => {
    let type: ActivityItem['type'] = 'sent';
    if (r.direction === 'inbound') type = 'replied';
    if (r.status === 'blocked' || r.status === 'bounced') type = 'blocked';
    if (r.reply_classification === 'interested') type = 'hot_lead';
    return {
      id: r.id,
      type,
      prospect_name: r.prospect_name,
      prospect_company: r.prospect_company,
      channel: r.channel,
      direction: r.direction,
      content_preview: r.content_preview,
      classification: r.reply_classification,
      sent_at: r.sent_at,
    };
  });
}
