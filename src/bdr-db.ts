import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import type {
  BDRAccount,
  BDRBrainRun,
  BDRProspect,
  BDRTouch,
  ImportJob,
  PipelineStats,
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
  `);
}

// ── Accounts ──────────────────────────────────────────────────────────────────

export function upsertAccount(account: BDRAccount): void {
  db.prepare(`
    INSERT OR REPLACE INTO bdr_accounts
      (id, type, name, email, credentials_key, status, daily_send_limit,
       sends_today, last_reset_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    account.id, account.type, account.name,
    account.email ?? null, account.credentials_key ?? null,
    account.status, account.daily_send_limit, account.sends_today,
    account.last_reset_date ?? null, account.created_at,
  );
}

export function getAllAccounts(): BDRAccount[] {
  return db.prepare(
    'SELECT * FROM bdr_accounts ORDER BY type, name',
  ).all() as BDRAccount[];
}

export function getAccountById(id: string): BDRAccount | undefined {
  return db.prepare('SELECT * FROM bdr_accounts WHERE id = ?').get(id) as BDRAccount | undefined;
}

export function updateAccountStatus(id: string, status: BDRAccount['status']): void {
  db.prepare('UPDATE bdr_accounts SET status = ? WHERE id = ?').run(status, id);
}

export function incrementAccountSends(id: string): void {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    UPDATE bdr_accounts SET
      sends_today     = CASE WHEN last_reset_date = ? THEN sends_today + 1 ELSE 1 END,
      last_reset_date = ?
    WHERE id = ?
  `).run(today, today, id);
}

export function resetDailySendCounts(): void {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    UPDATE bdr_accounts SET sends_today = 0, last_reset_date = ?
    WHERE last_reset_date < ? OR last_reset_date IS NULL
  `).run(today, today);
}

// ── Prospects ─────────────────────────────────────────────────────────────────

export function upsertProspect(prospect: BDRProspect): void {
  db.prepare(`
    INSERT OR REPLACE INTO bdr_prospects
      (id, name, email, linkedin_url, phone, company, title, stage,
       assigned_account_id, source, enrichment, tags,
       created_at, updated_at, last_touch_at, next_action_at, next_action_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    prospect.id, prospect.name, prospect.email ?? null,
    prospect.linkedin_url ?? null, prospect.phone ?? null,
    prospect.company, prospect.title, prospect.stage,
    prospect.assigned_account_id ?? null, prospect.source,
    prospect.enrichment ?? null, prospect.tags ?? null,
    prospect.created_at, prospect.updated_at,
    prospect.last_touch_at ?? null, prospect.next_action_at ?? null,
    prospect.next_action_type ?? null,
  );
}

export function getProspectById(id: string): BDRProspect | undefined {
  return db.prepare('SELECT * FROM bdr_prospects WHERE id = ?').get(id) as BDRProspect | undefined;
}

export function getAllProspects(limit = 100, offset = 0): BDRProspect[] {
  return db.prepare(
    'SELECT * FROM bdr_prospects ORDER BY updated_at DESC LIMIT ? OFFSET ?',
  ).all(limit, offset) as BDRProspect[];
}

export function getProspectsByStage(stage: string): BDRProspect[] {
  return db.prepare(
    'SELECT * FROM bdr_prospects WHERE stage = ? ORDER BY next_action_at ASC',
  ).all(stage) as BDRProspect[];
}

export function getActiveProspects(): BDRProspect[] {
  return db.prepare(`
    SELECT * FROM bdr_prospects
    WHERE stage NOT IN ('handed_off', 'not_interested', 'unsubscribed')
    ORDER BY next_action_at ASC
  `).all() as BDRProspect[];
}

export function getDueProspects(): BDRProspect[] {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM bdr_prospects
    WHERE next_action_at IS NOT NULL
      AND next_action_at <= ?
      AND stage NOT IN ('handed_off', 'not_interested', 'unsubscribed')
    ORDER BY next_action_at ASC
    LIMIT 50
  `).all(now) as BDRProspect[];
}

export function getHotProspects(): BDRProspect[] {
  return db.prepare(`
    SELECT * FROM bdr_prospects
    WHERE stage IN ('replied', 'interested', 'meeting_booked')
    ORDER BY updated_at DESC
  `).all() as BDRProspect[];
}

export function updateProspectStage(id: string, stage: string): void {
  db.prepare(`
    UPDATE bdr_prospects SET stage = ?, updated_at = ? WHERE id = ?
  `).run(stage, new Date().toISOString(), id);
}

export function updateProspectNextAction(
  id: string,
  nextActionAt: string,
  nextActionType: string,
): void {
  db.prepare(`
    UPDATE bdr_prospects
    SET next_action_at = ?, next_action_type = ?, updated_at = ?
    WHERE id = ?
  `).run(nextActionAt, nextActionType, new Date().toISOString(), id);
}

export function getProspectStageCounts(): Record<string, number> {
  const rows = db.prepare(
    'SELECT stage, COUNT(*) as count FROM bdr_prospects GROUP BY stage',
  ).all() as Array<{ stage: string; count: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) result[row.stage] = row.count;
  return result;
}

export function searchProspects(query: string, limit = 20): BDRProspect[] {
  const like = `%${query}%`;
  return db.prepare(`
    SELECT * FROM bdr_prospects
    WHERE name LIKE ? OR company LIKE ? OR email LIKE ? OR title LIKE ?
    ORDER BY updated_at DESC LIMIT ?
  `).all(like, like, like, like, limit) as BDRProspect[];
}

// ── Touches ───────────────────────────────────────────────────────────────────

export function recordTouch(touch: BDRTouch): void {
  db.prepare(`
    INSERT INTO bdr_touches
      (id, prospect_id, account_id, channel, direction, subject, content,
       status, sent_at, reply_classification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    touch.id, touch.prospect_id, touch.account_id ?? null,
    touch.channel, touch.direction, touch.subject ?? null,
    touch.content, touch.status, touch.sent_at,
    touch.reply_classification ?? null,
  );
  db.prepare(`
    UPDATE bdr_prospects SET last_touch_at = ?, updated_at = ? WHERE id = ?
  `).run(touch.sent_at, new Date().toISOString(), touch.prospect_id);
}

export function getTouchesForProspect(prospectId: string): BDRTouch[] {
  return db.prepare(
    'SELECT * FROM bdr_touches WHERE prospect_id = ? ORDER BY sent_at ASC',
  ).all(prospectId) as BDRTouch[];
}

export function getTodayTouches(): { emails: number; linkedin: number; sms: number; replies: number } {
  const today = new Date().toISOString().slice(0, 10);
  const since = `${today}T00:00:00.000Z`;
  const rows = db.prepare(`
    SELECT channel, direction, COUNT(*) as count FROM bdr_touches
    WHERE sent_at >= ?
    GROUP BY channel, direction
  `).all(since) as Array<{ channel: string; direction: string; count: number }>;

  const counts = { emails: 0, linkedin: 0, sms: 0, replies: 0 };
  for (const r of rows) {
    if (r.channel === 'email' && r.direction === 'outbound') counts.emails = r.count;
    if (r.channel === 'linkedin' && r.direction === 'outbound') counts.linkedin = r.count;
    if (r.channel === 'sms' && r.direction === 'outbound') counts.sms = r.count;
    if (r.direction === 'inbound') counts.replies += r.count;
  }
  return counts;
}

// ── Brain Runs ────────────────────────────────────────────────────────────────

export function startBrainRun(): number {
  const result = db.prepare(`
    INSERT INTO bdr_brain_runs
      (run_at, status, prospects_reviewed, actions_queued, hot_leads_found, meetings_booked)
    VALUES (?, 'running', 0, 0, 0, 0)
  `).run(new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function completeBrainRun(id: number, data: Partial<BDRBrainRun>): void {
  db.prepare(`
    UPDATE bdr_brain_runs SET
      status = ?, duration_ms = ?, prospects_reviewed = ?, actions_queued = ?,
      hot_leads_found = ?, meetings_booked = ?, summary = ?, error = ?
    WHERE id = ?
  `).run(
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
  return db.prepare(
    'SELECT * FROM bdr_brain_runs ORDER BY run_at DESC LIMIT 1',
  ).get() as BDRBrainRun | undefined;
}

export function getRecentBrainRuns(limit = 10): BDRBrainRun[] {
  return db.prepare(
    'SELECT * FROM bdr_brain_runs ORDER BY run_at DESC LIMIT ?',
  ).all(limit) as BDRBrainRun[];
}

// ── Import Jobs ───────────────────────────────────────────────────────────────

export function createImportJob(job: ImportJob): void {
  db.prepare(`
    INSERT INTO bdr_import_jobs
      (id, filename, source, status, total_rows, imported_rows, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id, job.filename, job.source, job.status,
    job.total_rows, job.imported_rows, job.created_at,
  );
}

export function updateImportJob(id: string, updates: Partial<ImportJob>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.total_rows !== undefined) { fields.push('total_rows = ?'); values.push(updates.total_rows); }
  if (updates.imported_rows !== undefined) { fields.push('imported_rows = ?'); values.push(updates.imported_rows); }
  if (updates.error !== undefined) { fields.push('error = ?'); values.push(updates.error); }
  if (updates.completed_at !== undefined) { fields.push('completed_at = ?'); values.push(updates.completed_at); }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE bdr_import_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getRecentImportJobs(limit = 10): ImportJob[] {
  return db.prepare(
    'SELECT * FROM bdr_import_jobs ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as ImportJob[];
}

// ── Aggregated Stats ──────────────────────────────────────────────────────────

export function getPipelineStats(): PipelineStats {
  const stageCounts = getProspectStageCounts();
  const today = getTodayTouches();
  const brain = getLastBrainRun();

  const activeStages = ['identified', 'outreach_sent', 'follow_up', 'replied', 'interested'];
  const totalActive = activeStages.reduce((sum, s) => sum + (stageCounts[s] ?? 0), 0);

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
