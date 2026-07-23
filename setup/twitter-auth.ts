/**
 * Twitter / X auth setup — generates and displays the access token and secret
 * for the account whose credentials are in .env.
 *
 * Run: npm run twitter-auth
 *
 * Prerequisites:
 *   1. Twitter Developer Portal: developer.twitter.com
 *   2. Create a project and app with "Read and Write and Direct Messages" permissions
 *   3. Set App Type to "Web App, Automated App or Bot"
 *   4. Add a Callback URL: http://localhost:3456/callback
 *        (must match the port this script listens on — see callbackPort below)
 *   5. Copy Consumer Key + Secret to .env as TWITTER_API_KEY / TWITTER_API_SECRET
 *
 * Note: Basic tier ($100/mo) or higher is required for DM API access.
 */

import http from 'http';
import { TwitterApi } from 'twitter-api-v2';
import readline from 'readline';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    }),
  );
}

async function main(): Promise<void> {
  console.log('\n─────────────────────────────────────────────────────');
  console.log('  BDRclaw — Twitter / X Auth Setup');
  console.log('─────────────────────────────────────────────────────\n');

  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error('Missing TWITTER_API_KEY or TWITTER_API_SECRET in .env\n');
    console.error(
      '  1. Go to developer.twitter.com → your app → Keys and Tokens',
    );
    console.error('  2. Copy Consumer Key and Consumer Secret to .env');
    process.exit(1);
  }

  const client = new TwitterApi({ appKey: apiKey, appSecret: apiSecret });

  // Step 1: Get auth link and start a local callback server
  let oauthVerifier = '';
  let oauthToken = '';

  const callbackPort = 3456;
  const callbackUrl = `http://localhost:${callbackPort}/callback`;

  const { url, oauth_token, oauth_token_secret } =
    await client.generateAuthLink(callbackUrl, {
      authAccessType: 'write',
    });

  console.log('Open this URL in your browser and authorize the app:\n');
  console.log(url);
  console.log('\nWaiting for OAuth callback...\n');

  // Start a one-shot HTTP server to capture the callback
  await new Promise<void>((resolve) => {
    const server = http.createServer((req, res) => {
      const params = new URL(req.url ?? '/', `http://localhost:${callbackPort}`)
        .searchParams;
      oauthVerifier = params.get('oauth_verifier') ?? '';
      oauthToken = params.get('oauth_token') ?? '';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authorization successful! You can close this tab.</h1>');
      server.close();
      resolve();
    });
    server.listen(callbackPort);
  });

  if (!oauthVerifier) {
    console.error('OAuth flow cancelled or failed.');
    process.exit(1);
  }

  // Step 2: Exchange for access token
  const loginClient = new TwitterApi({
    appKey: apiKey,
    appSecret: apiSecret,
    accessToken: oauthToken,
    accessSecret: oauth_token_secret,
  });

  const { accessToken, accessSecret, screenName, userId } =
    await loginClient.login(oauthVerifier);

  console.log(
    '\n✓ Authorized as @' + screenName + ' (user ID: ' + userId + ')\n',
  );
  console.log('Add these to your .env to activate the Twitter channel:\n');
  console.log(`  TWITTER_ENABLED=true`);
  console.log(`  TWITTER_ACCESS_TOKEN=${accessToken}`);
  console.log(`  TWITTER_ACCESS_TOKEN_SECRET=${accessSecret}`);
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
