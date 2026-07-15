/**
 * Hydrate process.env from a local .env file — side-effect module.
 *
 * MUST be the first import of every entry point (index.ts, brain-cli.ts,
 * web-ui.ts) so that modules reading process.env at import time (config.ts,
 * channel factories) see the hydrated values. Existing environment variables
 * always win — deployment env vars (Railway, launchd) are authoritative.
 * A missing .env is fine; deployments don't ship one.
 */

import fs from 'fs';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
