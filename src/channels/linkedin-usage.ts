/**
 * Persisted daily-usage counters for the LinkedIn channel.
 *
 * LinkedIn caps are architectural (≤20 connection requests/day, ≤50 DMs/day)
 * and MUST survive process restarts — an in-memory counter that resets on
 * every deploy would let a crash-loop blow straight through the account-ban
 * threshold. Counters are stored as a small JSON file in STORE_DIR (same
 * durability home as the LinkedIn session cookies and the SQLite db).
 *
 * The file is read on every check rather than cached: worst case is ~70
 * reads/day, and it means two code paths (DM + connection request) can never
 * hold divergent in-memory copies.
 */

import fs from 'fs';
import path from 'path';

export interface LinkedInUsageSnapshot {
  date: string; // YYYY-MM-DD (UTC)
  dms: number;
  connections: number;
}

export class LinkedInDailyUsage {
  constructor(private readonly filePath: string) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Current counters; auto-resets when the UTC date rolls over. */
  read(): LinkedInUsageSnapshot {
    const today = this.today();
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8'),
      ) as Partial<LinkedInUsageSnapshot>;
      if (
        raw.date === today &&
        typeof raw.dms === 'number' &&
        typeof raw.connections === 'number'
      ) {
        return { date: today, dms: raw.dms, connections: raw.connections };
      }
    } catch {
      // Missing or corrupt file — start fresh for today.
    }
    return { date: today, dms: 0, connections: 0 };
  }

  recordDm(): LinkedInUsageSnapshot {
    const s = this.read();
    s.dms++;
    this.write(s);
    return s;
  }

  recordConnection(): LinkedInUsageSnapshot {
    const s = this.read();
    s.connections++;
    this.write(s);
    return s;
  }

  private write(s: LinkedInUsageSnapshot): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(s));
  }
}
