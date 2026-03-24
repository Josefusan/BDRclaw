/**
 * Gmail OAuth2 token management.
 * Handles token storage, refresh, and authenticated client creation
 * for up to 3 Gmail sending accounts (GMAIL_ACCOUNT_1/2/3).
 */

import fs from 'fs';
import path from 'path';

import { google } from 'googleapis';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

const TOKENS_DIR = path.join(STORE_DIR, 'gmail-tokens');

// Offline access required for refresh tokens (long-lived auth)
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

// Desktop app redirect URI (no HTTP server required)
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

// ── OAuth2 Client ─────────────────────────────────────────────────────────────

export function createOAuth2Client() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are required. ' +
        'Set them in .env — see .env.example for instructions.',
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

export function getAuthUrl(accountIndex: number): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: OAUTH_SCOPES,
    prompt: 'consent',
    state: String(accountIndex),
  });
}

export async function exchangeCodeForTokens(
  code: string,
  accountIndex: number,
): Promise<void> {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  saveTokens(accountIndex, tokens);
  logger.info({ accountIndex }, 'Gmail tokens saved');
}

// ── Token Storage ─────────────────────────────────────────────────────────────

export function saveTokens(accountIndex: number, tokens: object): void {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
  const file = tokenPath(accountIndex);
  fs.writeFileSync(file, JSON.stringify(tokens, null, 2), 'utf-8');
}

export function loadTokens(
  accountIndex: number,
): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(tokenPath(accountIndex), 'utf-8'));
  } catch {
    return null;
  }
}

function tokenPath(accountIndex: number): string {
  return path.join(TOKENS_DIR, `account-${accountIndex}.json`);
}

// ── Authenticated Client ──────────────────────────────────────────────────────

export function getAuthenticatedClient(accountIndex: number) {
  const tokens = loadTokens(accountIndex);
  if (!tokens) {
    throw new Error(
      `No Gmail tokens for account ${accountIndex}. ` +
        `Run: npm run gmail-auth`,
    );
  }

  const client = createOAuth2Client();
  client.setCredentials(tokens);

  // Persist refreshed tokens automatically
  client.on('tokens', (newTokens) => {
    const existing = loadTokens(accountIndex) ?? {};
    saveTokens(accountIndex, { ...existing, ...newTokens });
    logger.debug({ accountIndex }, 'Gmail tokens refreshed and saved');
  });

  return client;
}

// ── Account Discovery ─────────────────────────────────────────────────────────

/**
 * Returns account indices (1–3) that have both an env var AND stored tokens.
 */
export function getActiveAccountIndices(): number[] {
  const indices: number[] = [];
  for (let i = 1; i <= 3; i++) {
    if (process.env[`GMAIL_ACCOUNT_${i}`] && loadTokens(i)) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Returns account indices that have an env var (with or without tokens).
 */
export function getConfiguredAccountIndices(): number[] {
  const indices: number[] = [];
  for (let i = 1; i <= 3; i++) {
    if (process.env[`GMAIL_ACCOUNT_${i}`]) indices.push(i);
  }
  return indices;
}

/**
 * Extract the numeric index from a credentials_key like "GMAIL_ACCOUNT_2".
 * Returns 1 as fallback.
 */
export function credentialsKeyToIndex(credentialsKey: string): number {
  const match = credentialsKey.match(/GMAIL_ACCOUNT_(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}
