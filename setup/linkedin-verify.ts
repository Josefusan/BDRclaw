/**
 * LinkedIn selector smoke-test — NO-SEND dry run.
 *
 * Loads the saved session (store/linkedin-session.json) and checks, against the
 * CURRENT LinkedIn UI, that every DOM selector the LinkedIn channel
 * (src/channels/linkedin.ts) depends on still resolves — WITHOUT sending any
 * message or connection request. LinkedIn's DOM changes often; run this after
 * `npm run linkedin-auth` and whenever a live send starts failing.
 *
 * Run: npm run linkedin-verify -- <profileUrl>
 *   Point it at a FIRST-DEGREE CONNECTION so the "Message" button is available:
 *   npm run linkedin-verify -- https://www.linkedin.com/in/some-connection
 *
 * Exit 0 = session valid + the DM selector chain resolves (or Message n/a for
 * this profile). Exit 1 = session invalid or a required DM selector is missing.
 */
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const SESSION_FILE = path.resolve(
  process.cwd(),
  'store',
  'linkedin-session.json',
);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function main(): Promise<void> {
  const profileUrl = process.argv[2];
  if (!profileUrl) {
    console.error('Usage: npm run linkedin-verify -- <profileUrl>');
    process.exit(1);
  }
  if (!fs.existsSync(SESSION_FILE)) {
    console.error('No session file. Run: npm run linkedin-auth');
    process.exit(1);
  }

  const results: Array<{ label: string; ok: boolean; note?: string }> = [];
  const check = (label: string, ok: boolean, note?: string) => {
    results.push({ label, ok, note });
    console.log(`  ${ok ? '✓' : '✗'} ${label}${note ? ' — ' + note : ''}`);
  };

  // Headed so you can watch the smoke-test drive the real UI.
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    userAgent: UA,
  });
  const page = await context.newPage();

  let critical = false;
  try {
    console.log('\nLinkedIn selector smoke-test (NO message will be sent)\n');

    // 1. Session still valid?
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    const sessionValid =
      !page.url().includes('/login') && !page.url().includes('/uas/login');
    check('session valid (not redirected to login)', sessionValid, page.url());
    if (!sessionValid) {
      console.error('\nSession invalid — re-run: npm run linkedin-auth');
      critical = true;
      return;
    }

    // 2. Target profile loads.
    await page.goto(profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await page.waitForTimeout(2500);

    // 3. DM chain: Message button → compose box → send button (never clicked).
    const messageBtn = page
      .locator('button:has-text("Message"), a:has-text("Message")')
      .first();
    const hasMessage =
      (await messageBtn.count()) > 0 &&
      (await messageBtn.isVisible().catch(() => false));
    check('DM: "Message" button', hasMessage);

    if (hasMessage) {
      await messageBtn.click();
      await page.waitForTimeout(1500);
      const composeBox = page
        .locator(
          '.msg-form__contenteditable, [data-placeholder="Write a message…"]',
        )
        .first();
      const hasCompose = (await composeBox.count()) > 0;
      check('DM: compose box (.msg-form__contenteditable)', hasCompose);
      const sendBtn = page
        .locator('button.msg-form__send-button, button[aria-label="Send"]')
        .first();
      const hasSend = (await sendBtn.count()) > 0;
      check('DM: send button (NOT clicked)', hasSend);
      if (!hasCompose || !hasSend) critical = true;
    } else {
      console.log(
        '  › "Message" not available on this profile — point the smoke-test at a\n' +
          '    1st-degree connection to validate the DM chain.',
      );
    }

    // 4. Connect chain (info only — often behind the "More" menu).
    const connectBtn = page.locator('button:has-text("Connect")').first();
    const hasConnect =
      (await connectBtn.count()) > 0 &&
      (await connectBtn.isVisible().catch(() => false));
    check(
      'Connect: "Connect" button (info only)',
      hasConnect,
      hasConnect ? undefined : 'not visible — may be behind the "More" menu',
    );

    const passed = results.filter((r) => r.ok).length;
    console.log(
      `\n${passed}/${results.length} checks passed. NO message or request was sent.`,
    );
  } catch (err) {
    console.error('\nSmoke-test error:', (err as Error).message);
    critical = true;
  } finally {
    await page.waitForTimeout(1500);
    await browser.close();
  }

  process.exit(critical ? 1 : 0);
}

main();
