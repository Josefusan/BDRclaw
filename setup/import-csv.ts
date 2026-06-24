/**
 * CSV prospect importer.
 *
 * Usage:
 *   npm run import-csv prospects.csv
 *   npm run import-csv -- --dry-run prospects.csv
 *
 * Expected CSV columns (header row required):
 *   name, company, title
 *   email         (optional)
 *   linkedin_url  (optional — also accepts: linkedin, li_url)
 *   phone         (optional)
 *   tags          (optional — comma-separated within cell, quote the cell)
 *
 * Column names are case-insensitive and trimmed.
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { initBDRDatabase, addProspect } from '../src/bdr-db.js';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const filePath = args.find((a) => !a.startsWith('--'));

if (!filePath) {
  console.error('Usage: npm run import-csv [--dry-run] <prospects.csv>');
  process.exit(1);
}

const resolved = path.resolve(process.cwd(), filePath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

// ── Column normalization ──────────────────────────────────────────────────────

function normalize(row: Record<string, string>, ...keys: string[]): string | null {
  for (const k of keys) {
    for (const [col, val] of Object.entries(row)) {
      if (col.trim().toLowerCase() === k.toLowerCase() && val?.trim()) {
        return val.trim();
      }
    }
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = fs.readFileSync(resolved, 'utf-8');
  const rows: Record<string, string>[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
  });

  console.log(`\nBDRclaw CSV Import${dryRun ? ' (dry run)' : ''}`);
  console.log(`File: ${resolved}`);
  console.log(`Rows: ${rows.length}\n`);

  if (!dryRun) initBDRDatabase();

  let imported = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = normalize(row, 'name', 'full_name', 'fullname', 'contact');
    const company = normalize(row, 'company', 'company_name', 'org', 'organization');
    const title = normalize(row, 'title', 'job_title', 'role', 'position');

    if (!name || !company || !title) {
      console.warn(`  Row ${i + 1}: skipped — missing name/company/title`);
      skipped++;
      continue;
    }

    const email = normalize(row, 'email', 'email_address');
    const linkedin = normalize(row, 'linkedin_url', 'linkedin', 'li_url', 'linkedin_profile');
    const phone = normalize(row, 'phone', 'phone_number', 'mobile');
    const tags = normalize(row, 'tags', 'tag', 'labels');

    if (dryRun) {
      console.log(`  Row ${i + 1}: ${name} @ ${company} — ${title}${email ? ` <${email}>` : ''}`);
    } else {
      addProspect({ name, company, title, email, linkedin_url: linkedin, phone, source: 'csv_import', tags });
    }

    imported++;
  }

  console.log(`\n${dryRun ? 'Would import' : 'Imported'}: ${imported} prospects`);
  if (skipped > 0) console.log(`Skipped: ${skipped} rows (missing required fields)`);
  if (!dryRun && imported > 0) console.log('\nRun `npm run brain` to start the outreach cycle.');
}

main().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
