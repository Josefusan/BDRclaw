/**
 * LinkedIn auth setup — opens a real browser so you can log in manually, then
 * AUTO-DETECTS the successful login and saves the session cookies to
 * store/linkedin-session.json.
 *
 * Run: npm run linkedin-auth
 *
 * No keyboard interaction with this script is required — just log in in the
 * browser window that opens (complete any 2FA). The script polls for your feed
 * and saves the session on its own, so it works from any shell (including the
 * Claude Code `!` prefix) without a TTY / stdin. The saved session is used by
 * the LinkedIn channel to send DMs without re-login. Sessions last ~30–90 days.
 */

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const SESSION_FILE = path.resolve(
  process.cwd(),
  'store',
  'linkedin-session.json',
);
const MAX_WAIT_MS = 5 * 60 * 1000; // up to 5 minutes to finish logging in
const POLL_MS = 2000;

/** True once the browser is on an authenticated LinkedIn surface (the feed). */
function isLoggedIn(url: string): boolean {
  if (!url.includes('linkedin.com')) return false;
  if (
    url.includes('/login') ||
    url.includes('/uas/login') ||
    url.includes('/checkpoint') || // 2FA / security challenge
    url.includes('/authwall')
  ) {
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  console.log('\n─────────────────────────────────────────────────────');
  console.log('  BDRclaw — LinkedIn Session Setup');
  console.log('─────────────────────────────────────────────────────\n');
  console.log(
    'A browser window is opening. Log in to LinkedIn normally (complete any 2FA).',
  );
  console.log(
    'This script auto-detects when you reach your feed and saves the session —',
  );
  console.log('you do NOT need to touch this terminal.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/login');

  const deadline = Date.now() + MAX_WAIT_MS;
  let loggedIn = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);
    let url: string;
    try {
      url = page.url();
    } catch {
      break; // browser was closed
    }
    if (isLoggedIn(url)) {
      loggedIn = true;
      break;
    }
  }

  if (!loggedIn) {
    console.error(
      '\n✗ Timed out (or the browser was closed) before login was detected.',
    );
    console.error(
      '  Re-run  npm run linkedin-auth  and finish logging in within 5 minutes.',
    );
    await browser.close().catch(() => {});
    process.exit(1);
  }

  // Give the feed a moment to fully settle so all auth cookies are set.
  await page.waitForTimeout(2000);
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  await context.storageState({ path: SESSION_FILE });

  console.log('\n✓ Session saved to:', SESSION_FILE);
  console.log('✓ LINKEDIN_ENABLED is already set to true in .env.');
  console.log(
    '\nNext:  npm run linkedin-verify -- <a 1st-degree connection profile URL>\n',
  );

  await browser.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
