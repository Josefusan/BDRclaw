/**
 * BDRclaw Web UI — dashboard server.
 *
 * Serves the pipeline dashboard at http://localhost:<port>
 * and a REST API at /api/*.
 *
 * Runs in-process with the main BDRclaw daemon.
 * Uses Node's built-in http module — no external web framework needed.
 */

import http from 'http';
import { URL } from 'url';

import {
  getAllAccounts,
  getAllProspects,
  getHotProspects,
  getPipelineStats,
  getRecentBrainRuns,
  getRecentImportJobs,
  searchProspects,
} from './bdr-db.js';
import { logger } from './logger.js';

const WEB_PORT = parseInt(process.env.BDR_WEB_PORT ?? '3000', 10);
const WEB_HOST = process.env.BDR_WEB_HOST ?? '127.0.0.1';

// ── Router ────────────────────────────────────────────────────────────────────

function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Dashboard HTML
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    handleApi(method, pathname, url, req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function handleApi(
  method: string,
  pathname: string,
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (method === 'GET' && pathname === '/api/stats') {
      const stats = getPipelineStats();
      json(res, stats);
      return;
    }

    if (method === 'GET' && pathname === '/api/accounts') {
      json(res, getAllAccounts());
      return;
    }

    if (method === 'GET' && pathname === '/api/prospects') {
      const q = url.searchParams.get('q');
      const stage = url.searchParams.get('stage');
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

      if (q) {
        json(res, searchProspects(q, limit));
      } else if (stage) {
        const all = getAllProspects(1000, 0).filter((p) => p.stage === stage);
        json(res, all.slice(offset, offset + limit));
      } else {
        json(res, getAllProspects(limit, offset));
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/prospects/hot') {
      json(res, getHotProspects());
      return;
    }

    if (method === 'GET' && pathname === '/api/brain/runs') {
      const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
      json(res, getRecentBrainRuns(limit));
      return;
    }

    if (method === 'GET' && pathname === '/api/imports') {
      json(res, getRecentImportJobs());
      return;
    }

    if (method === 'GET' && pathname === '/api/health') {
      json(res, { status: 'ok', uptime: process.uptime(), ts: new Date().toISOString() });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Unknown API route' }));
  } catch (err) {
    logger.error({ err, pathname }, 'Web UI API error');
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
}

function json(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200);
  res.end(JSON.stringify(data));
}

// ── Server Startup ────────────────────────────────────────────────────────────

export function startWebUI(): http.Server {
  const server = http.createServer(route);
  server.listen(WEB_PORT, WEB_HOST, () => {
    logger.info({ url: `http://${WEB_HOST}:${WEB_PORT}` }, 'BDRclaw Web UI running');
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port: WEB_PORT }, 'Web UI port in use — dashboard unavailable');
    } else {
      logger.error({ err }, 'Web UI server error');
    }
  });
  return server;
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────
// Single-file dashboard — no external CDN deps. Polls /api/stats every 30s.

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BDRclaw</title>
<style>
:root {
  --bg:         #06091a;
  --card:       #0d1530;
  --card2:      #111d3d;
  --border:     #1a3060;
  --blue:       #2563eb;
  --blue-light: #3b82f6;
  --blue-glow:  #60a5fa;
  --text:       #e2e8f0;
  --muted:      #4a6080;
  --success:    #10b981;
  --warning:    #f59e0b;
  --danger:     #ef4444;
  --hot:        #a855f7;
  --font:       'SF Mono', 'Fira Code', 'Fira Mono', monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
  min-height: 100vh;
}

/* ── Layout ── */
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--card);
  position: sticky;
  top: 0;
  z-index: 100;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 700;
  color: var(--blue-glow);
  letter-spacing: 1px;
}
.logo span { color: var(--muted); font-weight: 400; font-size: 12px; }
.topbar-right {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--muted);
  font-size: 12px;
}
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.dot.green { background: var(--success); box-shadow: 0 0 6px var(--success); }
.dot.red   { background: var(--danger); }
.dot.yellow { background: var(--warning); }

.content { flex: 1; padding: 20px 24px; max-width: 1400px; margin: 0 auto; width: 100%; }

/* ── Stat Cards ── */
.stat-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}
.stat-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.stat-card:hover { border-color: var(--blue-light); }
.stat-card.hot { border-color: rgba(168,85,247,0.4); }
.stat-card.success { border-color: rgba(16,185,129,0.3); }
.stat-label {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 6px;
}
.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--text);
  line-height: 1;
}
.stat-value.blue  { color: var(--blue-glow); }
.stat-value.hot   { color: var(--hot); }
.stat-value.green { color: var(--success); }
.stat-sub { color: var(--muted); font-size: 11px; margin-top: 4px; }

/* ── Two-col layout ── */
.main-grid {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 16px;
  margin-bottom: 20px;
}

/* ── Panel ── */
.panel {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--card2);
}
.panel-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--blue-glow);
  font-weight: 600;
}
.panel-body { padding: 14px 16px; }

/* ── Pipeline bar ── */
.pipeline-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
  margin-bottom: 10px;
  height: 28px;
}
.pipeline-seg {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  min-width: 28px;
  padding: 0 8px;
  cursor: pointer;
  transition: filter 0.15s;
  overflow: hidden;
  white-space: nowrap;
}
.pipeline-seg:hover { filter: brightness(1.2); }
.pipeline-seg.identified   { background: #1e3a5f; }
.pipeline-seg.outreach_sent { background: #1d4ed8; }
.pipeline-seg.follow_up    { background: #2563eb; }
.pipeline-seg.replied      { background: #7c3aed; }
.pipeline-seg.interested   { background: #a855f7; }
.pipeline-seg.meeting_booked { background: var(--success); }
.pipeline-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--muted);
}
.legend-dot { width: 8px; height: 8px; border-radius: 2px; }

/* ── Prospect list ── */
.prospect-list { display: flex; flex-direction: column; gap: 6px; }
.prospect-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
.prospect-row:hover { background: var(--card2); border-color: var(--border); }
.prospect-name { font-weight: 600; color: var(--text); flex: 1; min-width: 0; }
.prospect-co {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}
.stage-pill {
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
}
.stage-pill.identified    { background: #1e3a5f; color: #7aa0d4; }
.stage-pill.outreach_sent { background: #1e3a8a; color: #93c5fd; }
.stage-pill.follow_up     { background: #1e40af; color: #bfdbfe; }
.stage-pill.replied       { background: #5b21b6; color: #ddd6fe; }
.stage-pill.interested    { background: #7c3aed; color: #ede9fe; }
.stage-pill.meeting_booked { background: #065f46; color: #6ee7b7; }
.stage-pill.handed_off    { background: #1c3a2a; color: #4ade80; }
.stage-pill.not_interested { background: #1c1c2a; color: var(--muted); }
.stage-pill.unsubscribed  { background: #1c1c2a; color: var(--muted); }

/* ── Accounts sidebar ── */
.account-list { display: flex; flex-direction: column; gap: 8px; }
.account-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--card2);
  border-radius: 6px;
  border: 1px solid var(--border);
}
.account-icon {
  width: 28px; height: 28px;
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}
.account-icon.gmail    { background: rgba(37,99,235,0.2); }
.account-icon.outlook  { background: rgba(16,185,129,0.2); }
.account-icon.linkedin { background: rgba(59,130,246,0.2); }
.account-name { flex: 1; font-size: 12px; color: var(--text); }
.account-meta { font-size: 10px; color: var(--muted); }
.account-sends { font-size: 11px; color: var(--muted); text-align: right; }
.account-sends .num { color: var(--blue-glow); font-weight: 600; }

/* ── Brain status ── */
.brain-row {
  display: flex;
  gap: 12px;
  align-items: stretch;
  margin-bottom: 20px;
}
.brain-card {
  flex: 1;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 18px;
}
.brain-title { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px; }
.brain-summary { color: var(--text); font-size: 12px; line-height: 1.6; }
.brain-stats { display: flex; gap: 20px; margin-top: 8px; }
.brain-stat { text-align: center; }
.brain-stat .num { font-size: 20px; font-weight: 700; color: var(--blue-glow); }
.brain-stat .lbl { font-size: 10px; color: var(--muted); text-transform: uppercase; }

/* ── Bottom status bar ── */
.statusbar {
  border-top: 1px solid var(--border);
  background: var(--card);
  padding: 6px 24px;
  display: flex;
  align-items: center;
  gap: 20px;
  font-size: 11px;
  color: var(--muted);
}
.statusbar-item { display: flex; align-items: center; gap: 5px; }
.statusbar-item .val { color: var(--text); }
.ml-auto { margin-left: auto; }

/* ── Empty / Loading ── */
.empty { padding: 24px; text-align: center; color: var(--muted); font-size: 12px; }
.loading { color: var(--muted); font-style: italic; }

/* ── Hot leads section ── */
.hot-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  background: rgba(168,85,247,0.15);
  border: 1px solid rgba(168,85,247,0.3);
  border-radius: 4px;
  color: var(--hot);
  font-size: 10px;
}

/* ── Today activity ── */
.today-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}
.today-item {
  background: var(--card2);
  border-radius: 6px;
  padding: 8px 10px;
  text-align: center;
}
.today-num { font-size: 22px; font-weight: 700; color: var(--blue-glow); }
.today-lbl { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }

/* ── Scrollable lists ── */
.scroll-list { max-height: 320px; overflow-y: auto; }
.scroll-list::-webkit-scrollbar { width: 4px; }
.scroll-list::-webkit-scrollbar-track { background: transparent; }
.scroll-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
</style>
</head>
<body>
<div class="shell">

  <!-- Top bar -->
  <div class="topbar">
    <div class="logo">
      🦞 BDRclaw
      <span>v0.1</span>
    </div>
    <div class="topbar-right">
      <span id="clock"></span>
      <span class="statusbar-item">
        <span class="dot" id="daemon-dot"></span>
        <span id="daemon-status">connecting...</span>
      </span>
    </div>
  </div>

  <!-- Main content -->
  <div class="content">

    <!-- Stat cards -->
    <div class="stat-row">
      <div class="stat-card" onclick="filterProspects(null)">
        <div class="stat-label">Active Prospects</div>
        <div class="stat-value blue" id="stat-active">—</div>
        <div class="stat-sub" id="stat-sub-active">across all stages</div>
      </div>
      <div class="stat-card hot" onclick="filterProspects('interested')">
        <div class="stat-label">Hot Leads</div>
        <div class="stat-value hot" id="stat-hot">—</div>
        <div class="stat-sub">replied + interested</div>
      </div>
      <div class="stat-card success" onclick="filterProspects('meeting_booked')">
        <div class="stat-label">Meetings Booked</div>
        <div class="stat-value green" id="stat-meetings">—</div>
        <div class="stat-sub">total</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Emails Sent Today</div>
        <div class="stat-value" id="stat-emails">—</div>
        <div class="stat-sub" id="stat-li">— linkedin</div>
      </div>
    </div>

    <!-- Pipeline bar -->
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-header">
        <div class="panel-title">Pipeline</div>
        <div style="font-size:11px;color:var(--muted)" id="pipeline-total"></div>
      </div>
      <div class="panel-body">
        <div class="pipeline-row" id="pipeline-bar">
          <div class="empty loading">loading pipeline...</div>
        </div>
        <div class="pipeline-legend">
          <div class="legend-item"><div class="legend-dot" style="background:#1e3a5f"></div>Identified</div>
          <div class="legend-item"><div class="legend-dot" style="background:#1d4ed8"></div>Outreach Sent</div>
          <div class="legend-item"><div class="legend-dot" style="background:#2563eb"></div>Follow Up</div>
          <div class="legend-item"><div class="legend-dot" style="background:#7c3aed"></div>Replied</div>
          <div class="legend-item"><div class="legend-dot" style="background:#a855f7"></div>Interested</div>
          <div class="legend-item"><div class="legend-dot" style="background:#10b981"></div>Meeting Booked</div>
        </div>
      </div>
    </div>

    <!-- Main two-col grid -->
    <div class="main-grid">

      <!-- Left: prospects -->
      <div style="display:flex;flex-direction:column;gap:16px;">

        <!-- Hot leads -->
        <div class="panel" id="hot-panel">
          <div class="panel-header">
            <div class="panel-title">🔥 Hot Leads</div>
            <div id="hot-count" style="font-size:11px;color:var(--hot)"></div>
          </div>
          <div class="panel-body">
            <div class="prospect-list scroll-list" id="hot-list">
              <div class="empty">No hot leads right now</div>
            </div>
          </div>
        </div>

        <!-- All prospects -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title" id="prospects-title">All Prospects</div>
            <input
              id="search-input"
              type="text"
              placeholder="search..."
              style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:3px 8px;color:var(--text);font-size:11px;font-family:var(--font);width:160px;"
              oninput="handleSearch(this.value)"
            >
          </div>
          <div class="panel-body">
            <div class="prospect-list scroll-list" id="prospect-list">
              <div class="empty loading">loading prospects...</div>
            </div>
          </div>
        </div>

      </div>

      <!-- Right sidebar -->
      <div style="display:flex;flex-direction:column;gap:16px;">

        <!-- Accounts -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">Accounts</div>
            <div style="font-size:11px;color:var(--muted)" id="accounts-count"></div>
          </div>
          <div class="panel-body">
            <div class="account-list" id="account-list">
              <div class="empty">No accounts configured<br><span style="color:var(--blue-light)">run npm run wizard</span></div>
            </div>
          </div>
        </div>

        <!-- Today activity -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">Today</div>
          </div>
          <div class="panel-body">
            <div class="today-grid">
              <div class="today-item">
                <div class="today-num" id="today-emails">—</div>
                <div class="today-lbl">Emails</div>
              </div>
              <div class="today-item">
                <div class="today-num" id="today-li">—</div>
                <div class="today-lbl">LinkedIn</div>
              </div>
              <div class="today-item">
                <div class="today-num" id="today-sms">—</div>
                <div class="today-lbl">SMS</div>
              </div>
              <div class="today-item">
                <div class="today-num" id="today-replies">—</div>
                <div class="today-lbl">Replies</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Brain status -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">BDR Brain</div>
            <div id="brain-status-dot" style="font-size:11px;color:var(--muted)"></div>
          </div>
          <div class="panel-body">
            <div id="brain-info" class="brain-summary">
              <div class="empty loading">no brain runs yet</div>
            </div>
          </div>
        </div>

      </div>
    </div>

  </div>

  <!-- Status bar -->
  <div class="statusbar">
    <div class="statusbar-item">
      <span class="dot green"></span>
      <span class="val">BDRclaw</span>
    </div>
    <div class="statusbar-item">Security: <span class="val">moderate</span></div>
    <div class="statusbar-item">DB: <span class="val" id="sb-prospects">—</span> prospects</div>
    <div class="statusbar-item ml-auto" id="sb-updated" style="color:var(--muted)"></div>
  </div>

</div>

<script>
let currentFilter = null;
let searchDebounce = null;

// ── Clock ──────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
    ' — ' + now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
setInterval(updateClock, 1000);
updateClock();

// ── API helpers ────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error('API error: ' + res.status);
  return res.json();
}

// ── Stage display helpers ──────────────────────────────────────────────────
const STAGE_LABELS = {
  identified: 'Identified',
  outreach_sent: 'Outreach Sent',
  follow_up: 'Follow Up',
  replied: 'Replied',
  interested: 'Interested',
  meeting_booked: 'Meeting Booked',
  handed_off: 'Handed Off',
  not_interested: 'Not Interested',
  unsubscribed: 'Unsubscribed',
};
const STAGE_ORDER = ['identified','outreach_sent','follow_up','replied','interested','meeting_booked'];

// ── Render pipeline bar ────────────────────────────────────────────────────
function renderPipeline(byStage) {
  const bar = document.getElementById('pipeline-bar');
  const total = STAGE_ORDER.reduce((s, k) => s + (byStage[k] || 0), 0);
  document.getElementById('pipeline-total').textContent = total + ' active';
  if (total === 0) {
    bar.innerHTML = '<div class="empty" style="padding:0;margin:auto;color:var(--muted)">no prospects yet</div>';
    return;
  }
  bar.innerHTML = STAGE_ORDER.map(stage => {
    const count = byStage[stage] || 0;
    if (count === 0) return '';
    const pct = Math.max(4, (count / total) * 100);
    return \`<div class="pipeline-seg \${stage}" style="flex:\${pct}" title="\${STAGE_LABELS[stage]}: \${count}" onclick="filterProspects('\${stage}')">
      \${count > 0 ? count : ''}
    </div>\`;
  }).join('');
}

// ── Render prospect list ───────────────────────────────────────────────────
function renderProspects(prospects, containerId) {
  const el = document.getElementById(containerId);
  if (prospects.length === 0) {
    el.innerHTML = '<div class="empty">No prospects</div>';
    return;
  }
  el.innerHTML = prospects.map(p => \`
    <div class="prospect-row">
      <div style="min-width:0;flex:1">
        <div class="prospect-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${esc(p.name)}</div>
        <div class="prospect-co">\${esc(p.company)} — \${esc(p.title)}</div>
      </div>
      <span class="stage-pill \${p.stage}">\${STAGE_LABELS[p.stage] || p.stage}</span>
      \${p.next_action_type ? \`<div style="font-size:10px;color:var(--muted);white-space:nowrap">\${esc(p.next_action_type)}</div>\` : ''}
    </div>
  \`).join('');
}

// ── Render accounts ────────────────────────────────────────────────────────
const ACCOUNT_ICONS = { gmail: '📧', outlook: '📮', linkedin: '💼' };
const STATUS_COLORS = { active: 'green', paused: 'yellow', error: 'red', unconfigured: 'red' };

function renderAccounts(accounts) {
  const el = document.getElementById('account-list');
  document.getElementById('accounts-count').textContent =
    accounts.filter(a => a.status === 'active').length + ' active';

  if (accounts.length === 0) {
    el.innerHTML = '<div class="empty">No accounts configured<br><span style="color:var(--blue-light)">run npm run wizard</span></div>';
    return;
  }
  el.innerHTML = accounts.map(a => \`
    <div class="account-card">
      <div class="account-icon \${a.type}">\${ACCOUNT_ICONS[a.type] || '📱'}</div>
      <div style="flex:1;min-width:0">
        <div class="account-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${esc(a.name)}</div>
        <div class="account-meta">\${esc(a.email || a.type)}</div>
      </div>
      <div style="text-align:right">
        <div><span class="dot \${STATUS_COLORS[a.status] || 'yellow'}"></span></div>
        <div class="account-sends"><span class="num">\${a.sends_today}</span>/\${a.daily_send_limit}</div>
      </div>
    </div>
  \`).join('');
}

// ── Render brain status ────────────────────────────────────────────────────
function renderBrain(run) {
  const el = document.getElementById('brain-info');
  if (!run) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px">No brain runs yet. First run scheduled for 6am.</div>';
    return;
  }
  const d = new Date(run.run_at);
  const ago = timeSince(d);
  document.getElementById('brain-status-dot').textContent = 'last: ' + ago;
  el.innerHTML = \`
    <div style="color:var(--muted);font-size:11px;margin-bottom:10px">
      \${d.toLocaleString()} — \${run.status === 'completed' ? '<span style="color:var(--success)">✓ completed</span>' : '<span style="color:var(--danger)">✗ error</span>'}
      \${run.duration_ms ? ' in ' + (run.duration_ms/1000).toFixed(1) + 's' : ''}
    </div>
    <div class="brain-stats">
      <div class="brain-stat"><div class="num">\${run.prospects_reviewed}</div><div class="lbl">Reviewed</div></div>
      <div class="brain-stat"><div class="num">\${run.actions_queued}</div><div class="lbl">Actions</div></div>
      <div class="brain-stat"><div class="num" style="color:var(--hot)">\${run.hot_leads_found}</div><div class="lbl">Hot Leads</div></div>
    </div>
  \`;
}

// ── Main data load ─────────────────────────────────────────────────────────
async function loadAll() {
  try {
    const [stats, accounts] = await Promise.all([
      api('/api/stats'),
      api('/api/accounts'),
    ]);

    // Stat cards
    document.getElementById('stat-active').textContent = stats.total_active;
    document.getElementById('stat-hot').textContent = stats.hot_leads;
    document.getElementById('stat-meetings').textContent = stats.meetings_booked_total;
    document.getElementById('stat-emails').textContent = stats.today.emails_sent;
    document.getElementById('stat-li').textContent = stats.today.linkedin_connects + ' linkedin';
    document.getElementById('sb-prospects').textContent = stats.total_active;

    // Today
    document.getElementById('today-emails').textContent = stats.today.emails_sent;
    document.getElementById('today-li').textContent = stats.today.linkedin_connects;
    document.getElementById('today-sms').textContent = stats.today.sms_sent;
    document.getElementById('today-replies').textContent = stats.today.replies_received;

    // Pipeline
    renderPipeline(stats.by_stage || {});

    // Accounts
    renderAccounts(accounts);

    // Brain
    if (stats.brain_last_run) renderBrain(stats.brain_last_run);

    // Daemon status
    document.getElementById('daemon-dot').className = 'dot green';
    document.getElementById('daemon-status').textContent = 'running';

    // Update timestamp
    document.getElementById('sb-updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('daemon-dot').className = 'dot red';
    document.getElementById('daemon-status').textContent = 'unreachable';
  }
}

async function loadProspects(filter) {
  try {
    const url = filter ? '/api/prospects?stage=' + filter + '&limit=50' : '/api/prospects?limit=50';
    const prospects = await api(url);
    document.getElementById('prospects-title').textContent =
      filter ? (STAGE_LABELS[filter] || filter) : 'All Prospects';
    renderProspects(prospects, 'prospect-list');
  } catch (e) {
    document.getElementById('prospect-list').innerHTML = '<div class="empty">Error loading prospects</div>';
  }
}

async function loadHotLeads() {
  try {
    const hot = await api('/api/prospects/hot');
    document.getElementById('hot-count').textContent = hot.length + ' leads';
    renderProspects(hot, 'hot-list');
    document.getElementById('hot-panel').style.display = hot.length === 0 ? 'none' : '';
  } catch (e) {}
}

function filterProspects(stage) {
  currentFilter = stage;
  loadProspects(stage);
}

function handleSearch(val) {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    if (val.length < 2) {
      loadProspects(currentFilter);
      return;
    }
    try {
      const results = await api('/api/prospects?q=' + encodeURIComponent(val) + '&limit=20');
      document.getElementById('prospects-title').textContent = 'Search: ' + val;
      renderProspects(results, 'prospect-list');
    } catch (e) {}
  }, 300);
}

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function timeSince(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

// ── Init + polling ─────────────────────────────────────────────────────────
loadAll();
loadHotLeads();
loadProspects(null);
setInterval(loadAll, 30000);
setInterval(loadHotLeads, 60000);
</script>
</body>
</html>`;
