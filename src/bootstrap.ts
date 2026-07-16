/**
 * Composition root for BDRclaw core services.
 *
 * Every entry point (the main daemon, the standalone brain CLI, the standalone
 * web UI) boots through initCore() so there is exactly ONE boot contract:
 *
 *   1. The BDR database is initialized (schema created, connection opened).
 *   2. All channel action handlers are registered with the BDR Brain.
 *
 * The action-handler modules below register themselves via
 * registerActionHandler() at import time. Without these imports, runCycle()
 * finds an empty handler map and every due action falls into the "No handler
 * for action type" branch in bdr-brain.ts — silently rescheduling forever.
 * That is exactly the bug this file exists to prevent: do NOT boot the brain
 * with initBDRDatabase() alone.
 */

// Env hydration MUST precede every other import — modules read process.env
// at import time. See load-env.ts.
import './load-env.js';

import fs from 'fs';
import path from 'path';

import { initBDRDatabase } from './bdr-db.js';
import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

// Side-effect imports: register BDR action handlers with the brain.
// gmail    → send_email, classify_reply, send_meeting_link
// linkedin → linkedin_connect, linkedin_dm
// sms      → send_sms
// telegram → telegram_dm
// twitter  → twitter_dm
import './gmail-bdr-actions.js';
import './linkedin-bdr-actions.js';
import './sms-bdr-actions.js';
import './telegram-bdr-actions.js';
import './whatsapp-bdr-actions.js';
import './instagram-bdr-actions.js';
import './twitter-bdr-actions.js';

// Side-effect imports: CRM adapters self-register when their env is present.
// They live here (not only in index.ts) so stage changes made from the
// standalone web-ui also sync to CRMs.
import './crm/hubspot.js';
import './crm/salesforce.js';
import './crm/monday.js';
import './crm/gohighlevel.js';

let initialized = false;

/**
 * Initialize core BDRclaw services. Idempotent — safe to call from multiple
 * entry points or repeatedly within one process.
 */
export function initCore(): void {
  if (initialized) return;
  seedGmailTokensFromEnv();
  initBDRDatabase();
  initialized = true;
}

/**
 * Deployment token seeding (ISC-91 companion): a fresh Railway volume has no
 * Gmail OAuth tokens. GMAIL_TOKEN_<N>_B64 env vars (base64 of the local
 * store/gmail-tokens/account-<N>.json) hydrate the volume on first boot.
 * Existing files always win — a redeploy never clobbers refreshed tokens.
 */
function seedGmailTokensFromEnv(): void {
  const tokensDir = path.join(STORE_DIR, 'gmail-tokens');
  for (const [key, value] of Object.entries(process.env)) {
    const m = /^GMAIL_TOKEN_(\d+)_B64$/.exec(key);
    if (!m || !value) continue;
    const target = path.join(tokensDir, `account-${m[1]}.json`);
    if (fs.existsSync(target)) continue;
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      JSON.parse(decoded); // must be valid JSON before it lands on disk
      fs.mkdirSync(tokensDir, { recursive: true });
      fs.writeFileSync(target, decoded, { mode: 0o600 });
      logger.info({ account: m[1] }, 'Gmail token seeded from env');
    } catch (err) {
      logger.warn(
        { account: m[1], err },
        'GMAIL_TOKEN_*_B64 present but invalid — skipped',
      );
    }
  }
}
