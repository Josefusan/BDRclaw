#!/usr/bin/env tsx
/**
 * Gmail OAuth setup CLI.
 * Run: npm run gmail-auth
 *
 * Guides through authorizing 1-3 Gmail accounts for BDR sequences.
 * Stores refresh tokens in store/gmail-tokens/account-{n}.json.
 */

import readline from 'readline';

import {
  exchangeCodeForTokens,
  getAuthUrl,
  getConfiguredAccountIndices,
  loadTokens,
} from '../src/gmail-auth.js';
import { readEnvFile } from '../src/env.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve));

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
};

function header(text: string) {
  console.log(`\n${C.blue}${C.bold}${text}${C.reset}`);
}

function ok(text: string) {
  console.log(`${C.green}✓${C.reset} ${text}`);
}

function warn(text: string) {
  console.log(`${C.yellow}⚠${C.reset}  ${text}`);
}

function err(text: string) {
  console.log(`${C.red}✗${C.reset} ${text}`);
}

async function main() {
  console.clear();
  console.log(
    `${C.blue}${C.bold}╔══════════════════════════════════════╗${C.reset}`,
  );
  console.log(
    `${C.blue}${C.bold}║   BDRclaw — Gmail Account Setup      ║${C.reset}`,
  );
  console.log(
    `${C.blue}${C.bold}╚══════════════════════════════════════╝${C.reset}`,
  );

  // ── Step 1: Check GMAIL_CLIENT_ID / SECRET ──────────────────────────────

  header('Step 1 — Google OAuth Credentials');

  // Try to load from .env file
  const envValues = readEnvFile([
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_ACCOUNT_1',
    'GMAIL_ACCOUNT_2',
    'GMAIL_ACCOUNT_3',
  ]);

  // Merge into process.env so gmail-auth.ts can read them
  for (const [k, v] of Object.entries(envValues)) {
    if (v && !process.env[k]) process.env[k] = v;
  }

  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    warn('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET not found in .env');
    console.log(
      `\n${C.dim}To create OAuth credentials:${C.reset}`,
    );
    console.log(
      '  1. Open https://console.cloud.google.com',
    );
    console.log(
      '  2. Create a project → Enable Gmail API',
    );
    console.log(
      '  3. APIs & Services → Credentials → + Create → OAuth Client ID',
    );
    console.log(
      '  4. Application type: Desktop app',
    );
    console.log(
      '  5. Copy the Client ID and Client Secret\n',
    );

    const clientId = await ask('Paste your Client ID: ');
    const clientSecret = await ask('Paste your Client Secret: ');

    if (!clientId.trim() || !clientSecret.trim()) {
      err('Client ID and secret are required. Exiting.');
      process.exit(1);
    }

    process.env.GMAIL_CLIENT_ID = clientId.trim();
    process.env.GMAIL_CLIENT_SECRET = clientSecret.trim();

    console.log(
      `\n${C.dim}Add these to your .env file:${C.reset}`,
    );
    console.log(`GMAIL_CLIENT_ID=${clientId.trim()}`);
    console.log(`GMAIL_CLIENT_SECRET=${clientSecret.trim()}\n`);
  } else {
    ok('Client ID and Secret found');
  }

  // ── Step 2: Account selection ───────────────────────────────────────────

  header('Step 2 — Select Account to Authorize');

  const configured = getConfiguredAccountIndices();
  const available = [1, 2, 3];

  console.log('\nConfigured accounts:');
  for (const i of available) {
    const email = process.env[`GMAIL_ACCOUNT_${i}`];
    const hasToken = !!loadTokens(i);
    if (email) {
      const status = hasToken
        ? `${C.green}✓ authorized${C.reset}`
        : `${C.yellow}⚠ needs auth${C.reset}`;
      console.log(`  ${i}. ${email} — ${status}`);
    } else {
      console.log(`  ${i}. ${C.dim}(not configured)${C.reset}`);
    }
  }

  const defaultIdx = configured.find((i) => !loadTokens(i)) ?? 1;
  const idxStr = await ask(
    `\nWhich account to authorize? [1-3, default: ${defaultIdx}]: `,
  );
  const accountIndex = parseInt(idxStr.trim() || String(defaultIdx), 10);

  if (![1, 2, 3].includes(accountIndex)) {
    err('Invalid account index. Must be 1, 2, or 3.');
    process.exit(1);
  }

  // Check if email is set for this account
  if (!process.env[`GMAIL_ACCOUNT_${accountIndex}`]) {
    const email = await ask(
      `Enter the Gmail address for account ${accountIndex}: `,
    );
    if (!email.includes('@')) {
      err('Invalid email address.');
      process.exit(1);
    }
    process.env[`GMAIL_ACCOUNT_${accountIndex}`] = email.trim();
    console.log(
      `\n${C.dim}Add to .env: GMAIL_ACCOUNT_${accountIndex}=${email.trim()}${C.reset}\n`,
    );
  }

  // ── Step 3: OAuth flow ──────────────────────────────────────────────────

  header('Step 3 — Authorize Gmail Access');

  let authUrl: string;
  try {
    authUrl = getAuthUrl(accountIndex);
  } catch (e) {
    err(
      `Failed to generate auth URL: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }

  console.log(
    `\nOpen this URL in your browser to authorize Gmail access:\n`,
  );
  console.log(`${C.cyan}${authUrl}${C.reset}\n`);
  console.log(
    `${C.dim}If you see "app isn't verified", click Advanced → Go to app (unsafe).\n` +
      `This is normal for personal OAuth apps.${C.reset}\n`,
  );

  const code = await ask('Paste the authorization code here: ');
  if (!code.trim()) {
    err('No code entered. Exiting.');
    process.exit(1);
  }

  // ── Step 4: Exchange code for tokens ────────────────────────────────────

  header('Step 4 — Saving Tokens');

  try {
    await exchangeCodeForTokens(code.trim(), accountIndex);
    ok(
      `Account ${accountIndex} (${process.env[`GMAIL_ACCOUNT_${accountIndex}`]}) authorized!`,
    );
  } catch (e) {
    err(
      `Token exchange failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    console.log(
      `\n${C.dim}This usually means the auth code expired (they're single-use).\n` +
        `Run npm run gmail-auth again and paste a fresh code.${C.reset}`,
    );
    process.exit(1);
  }

  // ── Done ──────────────────────────────────────────────────────────────────

  console.log(`
${C.green}${C.bold}Gmail account authorized!${C.reset}

Next steps:
  • Add your sequence templates to groups/main/sequences/*.md
  • Run ${C.cyan}npm run dev${C.reset} — the Gmail channel will activate automatically
  • Run ${C.cyan}npm run brain${C.reset} — prospects with emails will get their first touch

${C.dim}Tokens are stored in store/gmail-tokens/account-${accountIndex}.json${C.reset}
`);

  rl.close();
}

main().catch((e) => {
  console.error('Setup failed:', e);
  process.exit(1);
});
