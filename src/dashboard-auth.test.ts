/**
 * Dashboard auth contract tests (ISC-85..89).
 *
 * Same harness as dashboard-write-api.test.ts: real `route` over real HTTP,
 * in-memory SQLite. Auth toggles per-test via BDR_DASHBOARD_PASSWORD (all
 * dashboard-auth env reads are call-time by design).
 */

import http from 'http';
import type { AddressInfo } from 'net';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi
        .fn()
        .mockResolvedValue({ content: [{ type: 'text', text: 'PASS' }] }),
    };
  },
}));

import { _initBDRTestDatabase } from './bdr-db.js';
import {
  _resetRateLimiter,
  createSessionToken,
  verifySessionToken,
} from './dashboard-auth.js';
import { stopAgenticLoop } from './agents/loop.js';
import { route } from './web-ui.js';

let server: http.Server;
let base: string;

const PASSWORD = 'correct-horse-battery';

function withAuth(): void {
  process.env.BDR_DASHBOARD_PASSWORD = PASSWORD;
}

async function login(password: string, ip?: string): Promise<Response> {
  return fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: JSON.stringify({ password }),
  });
}

function cookieFrom(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  return header.split(';')[0];
}

beforeAll(async () => {
  server = http.createServer(route);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  stopAgenticLoop();
  server.close();
});

beforeEach(() => {
  _initBDRTestDatabase();
  _resetRateLimiter();
  delete process.env.BDR_DASHBOARD_PASSWORD;
  delete process.env.BDR_SESSION_SECRET;
});

afterEach(() => {
  delete process.env.BDR_DASHBOARD_PASSWORD;
  delete process.env.BDR_SESSION_SECRET;
});

describe('auth gate (ISC-85)', () => {
  it('redirects unauthenticated page requests to /login and 401s API requests', async () => {
    withAuth();
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/login');

    const api = await fetch(`${base}/api/stats`);
    expect(api.status).toBe(401);
  });

  it('grants access with a valid session cookie', async () => {
    withAuth();
    const ok = await login(PASSWORD);
    expect(ok.status).toBe(200);
    const cookie = cookieFrom(ok);
    expect(cookie).toContain('bdr_session=');

    const api = await fetch(`${base}/api/stats`, {
      headers: { Cookie: cookie },
    });
    expect(api.status).toBe(200);
  });
});

describe('login endpoint (ISC-86)', () => {
  it('rejects a wrong password with 401 and rate-limits after 5 failures', async () => {
    withAuth();
    for (let i = 0; i < 5; i++) {
      const res = await login('wrong', '203.0.113.9');
      expect(res.status).toBe(401);
    }
    const sixth = await login('wrong', '203.0.113.9');
    expect(sixth.status).toBe(429);
    // Even the CORRECT password is refused while locked out.
    const locked = await login(PASSWORD, '203.0.113.9');
    expect(locked.status).toBe(429);
    // A different IP is unaffected.
    const other = await login(PASSWORD, '198.51.100.7');
    expect(other.status).toBe(200);
  });

  it('returns 404 when auth is not enabled', async () => {
    const res = await login('anything');
    expect(res.status).toBe(404);
  });
});

describe('public exemptions (ISC-87)', () => {
  it('health, legal pages, unsubscribe, and webhooks stay reachable without auth', async () => {
    withAuth();
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/privacy`)).status).toBe(200);
    expect((await fetch(`${base}/terms`)).status).toBe(200);
    // The webhook is auth-exempt: it reaches its handler without a session (so
    // it is never 401/302 from the auth gate). With auth enabled and no signing
    // key it fails CLOSED with 503 (see the fail-closed security fix), proving
    // the request got past the gate to the handler.
    const webhook = await fetch(`${base}/api/webhooks/calendly`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'invitee.canceled', payload: {} }),
    });
    expect(webhook.status).toBe(503);
    expect([401, 302]).not.toContain(webhook.status);
    const login200 = await fetch(`${base}/login`);
    expect(login200.status).toBe(200);
    expect(await login200.text()).toContain('Sign in to BDRclaw');
  });
});

describe('auth disabled (ISC-88)', () => {
  it('without BDR_DASHBOARD_PASSWORD everything behaves as before', async () => {
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    expect(page.status).toBe(200);
    const api = await fetch(`${base}/api/stats`);
    expect(api.status).toBe(200);
    // /login redirects home instead of rendering a dead form.
    const loginPage = await fetch(`${base}/login`, { redirect: 'manual' });
    expect(loginPage.status).toBe(302);
    expect(loginPage.headers.get('location')).toBe('/');
  });
});

describe('session token (ISC-89)', () => {
  it('accepts a fresh token, rejects tampered and expired ones', () => {
    withAuth();
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);

    // Tampered MAC
    expect(verifySessionToken(`${token.slice(0, -2)}ff`)).toBe(false);
    // Tampered expiry
    const [, mac] = token.split('.');
    expect(verifySessionToken(`99999999999999.${mac}`)).toBe(false);
    // Expired
    const old = createSessionToken(Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(verifySessionToken(old)).toBe(false);
    // Garbage
    expect(verifySessionToken('')).toBe(false);
    expect(verifySessionToken('no-dot')).toBe(false);
  });

  it('logout clears the cookie', async () => {
    withAuth();
    const res = await fetch(`${base}/api/logout`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
