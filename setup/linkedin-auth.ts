/**
 * LinkedIn auth setup — opens a real browser so you can log in manually,
 * then saves the session cookies to store/linkedin-session.json.
 *
 * Run: npm run linkedin-auth
 *
 * The saved session is used by the LinkedIn channel to send DMs without
 * requiring re-login. Sessions typically last 30–90 days.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { chromium } from 'playwright';

const SESSION_FILE = path.resolve(process.cwd(), 'store', 'linkedin-session.json');

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function main(): Promise<void> {
  console.log('\n─────────────────────────────────────────────────────');
  console.log('  BDRclaw — LinkedIn Session Setup');
  console.log('─────────────────────────────────────────────────────\n');
  console.log('A browser window will open. Log in to LinkedIn normally.');
  console.log('When you see your feed, come back here and press Enter.\n');

  await prompt('Press Enter to open the browser...');

  // Launch headed browser (user has to see and interact with it)
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://www.linkedin.com/login');

  console.log('\nLog in to LinkedIn in the browser window.');
  console.log('Complete any 2FA prompts, then return here.\n');
  await prompt('Press Enter once you can see your LinkedIn feed...');

  // Verify we're logged in
  const url = page.url();
  if (url.includes('/login') || url.includes('/uas/login')) {
    console.error('\nStill on login page — please complete login first.');
    await browser.close();
    process.exit(1);
  }

  // Save session state (cookies + localStorage)
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  await context.storageState({ path: SESSION_FILE });

  console.log('\n✓ Session saved to:', SESSION_FILE);
  console.log('\nAdd this to your .env to activate the LinkedIn channel:');
  console.log('  LINKEDIN_ENABLED=true\n');

  await browser.close();
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
