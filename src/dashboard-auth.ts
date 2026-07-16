/**
 * Dashboard authentication (ISC-85..89).
 *
 * Enabled by setting BDR_DASHBOARD_PASSWORD. Session is a stateless
 * HMAC-signed expiry token in an HttpOnly cookie — no session table, no
 * dependency, survives restarts as long as the secret is stable.
 *
 * Secret: BDR_SESSION_SECRET if set, else derived from the password. Rotating
 * either invalidates all sessions (that is the desired behavior).
 *
 * All env reads are call-time, not module-load-time, so tests can toggle
 * auth on and off per case.
 */

import crypto from 'crypto';
import type http from 'http';

const SESSION_COOKIE = 'bdr_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_LOGIN_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export function isAuthEnabled(): boolean {
  return !!process.env.BDR_DASHBOARD_PASSWORD;
}

function secret(): Buffer {
  const explicit = process.env.BDR_SESSION_SECRET;
  const base = explicit ?? `${process.env.BDR_DASHBOARD_PASSWORD}`;
  return crypto
    .createHash('sha256')
    .update(`bdrclaw-session-v1:${base}`)
    .digest();
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

export function createSessionToken(now = Date.now()): string {
  const expiry = String(now + SESSION_TTL_MS);
  return `${expiry}.${sign(expiry)}`;
}

export function verifySessionToken(
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiry = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(expiry) || parseInt(expiry, 10) < now) return false;
  const expected = sign(expiry);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function checkPassword(candidate: unknown): boolean {
  const real = process.env.BDR_DASHBOARD_PASSWORD;
  if (!real || typeof candidate !== 'string') return false;
  // Hash both sides so timingSafeEqual gets equal-length inputs.
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── Login rate limiting (in-memory, per source IP) ────────────────────────────

const attempts = new Map<string, { count: number; resetAt: number }>();

export function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    // LAST entry: appended by the proxy we actually sit behind (Railway edge).
    // Earlier entries are client-supplied and spoofable — trusting the first
    // would let an attacker rotate fake IPs past the login rate limit.
    const parts = fwd.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Returns true when this IP is currently locked out. */
export function isRateLimited(ip: string, now = Date.now()): boolean {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) return false;
  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

export function recordFailedAttempt(ip: string, now = Date.now()): void {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

/** Test hook — reset the limiter between cases. */
export function _resetRateLimiter(): void {
  attempts.clear();
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

export function parseCookies(
  req: http.IncomingMessage,
): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function hasValidSession(req: http.IncomingMessage): boolean {
  return verifySessionToken(parseCookies(req)[SESSION_COOKIE]);
}

export function sessionCookieHeader(
  req: http.IncomingMessage,
  token: string | null,
): string {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  if (token === null) {
    return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
  }
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000,
  )}${secure}`;
}

// ── Route exemptions (ISC-87) ─────────────────────────────────────────────────
// Server-to-server callers and legally-required public pages can never log in.

const EXEMPT_EXACT = new Set([
  '/login',
  '/api/login',
  '/api/health',
  '/unsubscribe',
  '/privacy',
  '/terms',
  '/favicon.svg',
]);

export function isAuthExempt(pathname: string): boolean {
  return EXEMPT_EXACT.has(pathname) || pathname.startsWith('/api/webhooks/');
}

// ── Login page ────────────────────────────────────────────────────────────────
// Fully self-contained (inline CSS, no protected assets) so it renders even
// though every other static file sits behind the auth gate.

export function renderLoginPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>BDRclaw — Sign in</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #09090b; color: #e4e4e7; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .card { width: 100%; max-width: 360px; background: #18181b; border: 1px solid #27272a;
          border-radius: 16px; padding: 32px; }
  .logo { width: 40px; height: 40px; border-radius: 10px; background: #f97316; color: #fff;
          display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 20px; margin-bottom: 16px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  p  { font-size: 13px; color: #71717a; margin-bottom: 20px; }
  input { width: 100%; background: #09090b; border: 1px solid #3f3f46; border-radius: 8px;
          padding: 10px 12px; color: #e4e4e7; font-size: 14px; outline: none; }
  input:focus { border-color: #f97316; }
  button { width: 100%; margin-top: 12px; background: #f97316; border: 0; border-radius: 8px;
           padding: 10px; color: #fff; font-weight: 600; font-size: 14px; cursor: pointer; }
  button:hover { background: #fb923c; }
  .err { color: #f87171; font-size: 13px; margin-top: 10px; min-height: 18px; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">B</div>
    <h1>Sign in to BDRclaw</h1>
    <p>Enter the dashboard password to continue.</p>
    <form id="f">
      <input id="pw" type="password" autocomplete="current-password" placeholder="Password" autofocus />
      <button type="submit">Sign in</button>
      <div class="err" id="err"></div>
    </form>
  </div>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('err');
      err.textContent = '';
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('pw').value }),
      });
      if (res.ok) { location.href = '/'; return; }
      err.textContent = res.status === 429
        ? 'Too many attempts — try again in 15 minutes.'
        : 'Wrong password.';
    });
  </script>
</body>
</html>`;
}
