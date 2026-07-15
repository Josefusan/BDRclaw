/**
 * Boot-contract hardening: using bdr-db before initBDRDatabase() must fail
 * with a clear, actionable error — not a deep `db.prepare` TypeError.
 *
 * Runs in its own test file so the module-level singleton is untouched by
 * other test files (vitest isolates module registries per file).
 */

import { describe, expect, it } from 'vitest';

import { getAllProspects, getBdrDb } from './bdr-db.js';

describe('bdr-db before initialization', () => {
  it('throws a clear "call initBDRDatabase() first" error', () => {
    expect(() => getAllProspects()).toThrow(/initBDRDatabase/);
    expect(() => getAllProspects()).toThrow(/initCore/);
  });

  it('getBdrDb() handle also fails clearly on first use', () => {
    const db = getBdrDb();
    expect(() => db.prepare('SELECT 1')).toThrow(/initBDRDatabase/);
  });
});
