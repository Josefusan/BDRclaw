/**
 * Closed deals and documents — DB helpers for revenue tracking and file storage.
 *
 * Tables are created by initBDRDatabase() via the extended schema in bdr-db.ts.
 */

import { getBdrDb } from './bdr-db.js';
import { logger } from './logger.js';

// ── Closed Deals ──────────────────────────────────────────────────────────────

export interface ClosedDeal {
  id: string;
  prospect_id?: string;
  prospect_name: string;
  company: string;
  amount: number;
  closed_at: string;
  notes?: string;
}

export function addClosedDeal(deal: ClosedDeal): void {
  getBdrDb()
    .prepare(
      `
    INSERT OR REPLACE INTO bdr_closed_deals
      (id, prospect_id, prospect_name, company, amount, closed_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      deal.id,
      deal.prospect_id ?? null,
      deal.prospect_name,
      deal.company,
      deal.amount,
      deal.closed_at,
      deal.notes ?? null,
    );
  logger.info(
    { amount: deal.amount, company: deal.company },
    'Closed deal recorded',
  );
}

export function listClosedDeals(limit = 100): ClosedDeal[] {
  return getBdrDb()
    .prepare(
      `
    SELECT * FROM bdr_closed_deals ORDER BY closed_at DESC LIMIT ?
  `,
    )
    .all(limit) as ClosedDeal[];
}

export function deleteClosedDeal(id: string): void {
  getBdrDb().prepare('DELETE FROM bdr_closed_deals WHERE id = ?').run(id);
}

export interface RevenueResult {
  total: number;
  count: number;
  byDay: Array<{ date: string; amount: number; count: number }>;
  byMonth: Array<{ month: string; amount: number; count: number }>;
}

export function getClosedDealsRevenue(daysBack = 30): RevenueResult {
  const db = getBdrDb();
  const since = new Date(Date.now() - daysBack * 86400000)
    .toISOString()
    .slice(0, 10);

  const totals = db
    .prepare(
      `
    SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
    FROM bdr_closed_deals WHERE date(closed_at) >= ?
  `,
    )
    .get(since) as { total: number; count: number };

  const byDay = db
    .prepare(
      `
    SELECT date(closed_at) as date, SUM(amount) as amount, COUNT(*) as count
    FROM bdr_closed_deals
    WHERE date(closed_at) >= ?
    GROUP BY date(closed_at)
    ORDER BY date ASC
  `,
    )
    .all(since) as Array<{ date: string; amount: number; count: number }>;

  const byMonth = db
    .prepare(
      `
    SELECT strftime('%Y-%m', closed_at) as month, SUM(amount) as amount, COUNT(*) as count
    FROM bdr_closed_deals
    GROUP BY month
    ORDER BY month ASC
  `,
    )
    .all() as Array<{ month: string; amount: number; count: number }>;

  return { total: totals.total, count: totals.count, byDay, byMonth };
}

// ── Documents ─────────────────────────────────────────────────────────────────

export type DocumentStage =
  | 'general'
  | 'discovery'
  | 'proposal'
  | 'contract'
  | 'onboarding'
  | 'nda';

export interface BDRDocument {
  id: string;
  name: string;
  stage: DocumentStage;
  mime_type: string;
  size: number;
  content: string; // base64-encoded
  uploaded_at: string;
  notes?: string;
}

export interface BDRDocumentMeta {
  id: string;
  name: string;
  stage: DocumentStage;
  mime_type: string;
  size: number;
  uploaded_at: string;
  notes?: string;
}

export function saveDocument(doc: BDRDocument): void {
  getBdrDb()
    .prepare(
      `
    INSERT OR REPLACE INTO bdr_documents
      (id, name, stage, mime_type, size, content, uploaded_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      doc.id,
      doc.name,
      doc.stage,
      doc.mime_type,
      doc.size,
      doc.content,
      doc.uploaded_at,
      doc.notes ?? null,
    );
  logger.info(
    { name: doc.name, stage: doc.stage, size: doc.size },
    'Document saved',
  );
}

export function listDocuments(): BDRDocumentMeta[] {
  return getBdrDb()
    .prepare(
      `
    SELECT id, name, stage, mime_type, size, uploaded_at, notes
    FROM bdr_documents ORDER BY uploaded_at DESC
  `,
    )
    .all() as BDRDocumentMeta[];
}

export function getDocument(id: string): BDRDocument | undefined {
  return getBdrDb()
    .prepare('SELECT * FROM bdr_documents WHERE id = ?')
    .get(id) as BDRDocument | undefined;
}

export function deleteDocument(id: string): void {
  getBdrDb().prepare('DELETE FROM bdr_documents WHERE id = ?').run(id);
  logger.info({ id }, 'Document deleted');
}
