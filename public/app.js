/**
 * BDRclaw dashboard — Alpine.js application state.
 * Loaded (deferred) before the Alpine CDN script so `app()` exists when
 * Alpine boots. No build step; plain browser JS.
 */

/* ── Static channel metadata (labels, brand colors, safety copy, setup) ────── */

const CHANNEL_META = {
  email: {
    label: 'Email',
    color: '#EA4335',
    cap: 'Per-account daily send caps with warm-up pacing protect your sender reputation.',
    setup: [
      'Go to your Google account → Security → App Passwords',
      'Create an app password for "Mail"',
      'Set GMAIL_ACCOUNT_1=your@gmail.com and GMAIL_APP_PASSWORD=<password> in .env',
    ],
  },
  linkedin: {
    label: 'LinkedIn',
    color: '#0A66C2',
    cap: 'Capped at 20 invites/day to keep your account safe from restriction.',
    setup: [
      'Log in to linkedin.com in Chrome',
      'Open DevTools → Application → Cookies',
      'Copy the value of the "li_at" cookie',
      'Set LINKEDIN_ENABLED=true and LI_AT=<cookie_value> in .env',
    ],
  },
  twitter: {
    label: 'Twitter / X',
    color: '#e7e9ea',
    cap: 'Warm replies only — BDRclaw never cold-DMs on X.',
    setup: [
      'Go to developer.twitter.com and create a project + app',
      'Enable "Read and Write and Direct Messages" permissions',
      'Create access tokens under "Keys and Tokens"',
      'Set TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET in .env',
    ],
  },
  instagram: {
    label: 'Instagram',
    color: '#E1306C',
    cap: 'Warm replies only — DMs go only to prospects who messaged you first.',
    setup: [
      'Create a Meta Developer account at developers.facebook.com',
      'Create an app with Messenger/Instagram permissions',
      'Generate a long-lived access token for your Instagram Business account',
      'Set INSTAGRAM_ENABLED=true, INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID in .env',
    ],
  },
  telegram: {
    label: 'Telegram',
    color: '#24A1DE',
    cap: 'Reply-based outreach with per-day rate limits.',
    setup: [
      'Open Telegram and search for @BotFather',
      'Send /newbot and follow the prompts to create your bot',
      'Copy the API token that BotFather gives you',
      'Set TELEGRAM_BOT_TOKEN=<your_token> in .env',
    ],
  },
  whatsapp: {
    label: 'WhatsApp',
    color: '#25D366',
    cap: 'Warm replies only, via Twilio-approved templates.',
    setup: [
      'In Twilio console, enable WhatsApp Sandbox under Messaging',
      'Follow the sandbox setup instructions from Twilio',
      'Set TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886 in .env',
    ],
  },
  sms: {
    label: 'SMS',
    color: '#F22F46',
    cap: 'TCPA-compliant: 2-touch max per prospect, STOP honored instantly.',
    setup: [
      'Create a free Twilio account at twilio.com',
      'Buy a phone number in the Twilio console',
      'Copy your Account SID and Auth Token from the dashboard',
      'Set SMS_ENABLED=true, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in .env',
    ],
  },
};

const CHANNEL_ORDER = ['email', 'linkedin', 'twitter', 'instagram', 'telegram', 'whatsapp', 'sms'];

const STAGES = [
  ['identified', 'Identified'],
  ['outreach_sent', 'Outreach sent'],
  ['follow_up', 'Follow-up'],
  ['replied', 'Replied'],
  ['interested', 'Interested'],
  ['meeting_link_sent', 'Link sent'],
  ['meeting_booked', 'Meeting booked'],
];

/* Every stage a prospect can be moved to from the detail drawer. */
const ALL_STAGES = [
  ['identified', 'New'],
  ['outreach_sent', 'Contacted'],
  ['follow_up', 'Follow-up'],
  ['replied', 'Replied'],
  ['interested', 'Hot lead'],
  ['meeting_link_sent', 'Link sent'],
  ['meeting_booked', 'Meeting set'],
  ['handed_off', 'Handed off'],
  ['not_interested', 'Not interested'],
  ['unsubscribed', 'Unsubscribed'],
];

/* Channels the manual "suppress a contact" form can target (must mirror the
   backend SUPPRESSION_CHANNELS allowlist). */
const SUPPRESS_CHANNELS = [
  ['email', 'Email address'],
  ['phone', 'Phone (SMS + WhatsApp)'],
  ['linkedin', 'LinkedIn URL'],
  ['twitter', 'Twitter / X user ID'],
  ['telegram', 'Telegram chat ID'],
  ['instagram', 'Instagram ID'],
];

// Sequential orange ramp (single hue; stage order is ordinal — length carries magnitude)
const FUNNEL_RAMP = ['#7c2d12', '#9a3412', '#c2410c', '#ea580c', '#f97316', '#fb923c'];

const MEETING_PLATFORMS = {
  zoom: { label: 'Zoom', color: '#2D8CFF', setup: ['Create a Zoom webhook at marketplace.zoom.us', 'Set ZOOM_WEBHOOK_SECRET_TOKEN in .env', 'Point webhook URL to: your-domain/api/zoom/webhook', 'Subscribe to meeting.ended events'] },
  meet: { label: 'Google Meet', color: '#00897B', setup: ['Google Meet recordings go to Google Drive automatically', 'Use Granola or Otter.ai alongside Meet for live transcription', 'Paste the transcript into the Analyze section below'] },
  teams: { label: 'Microsoft Teams', color: '#6264A7', setup: ['Enable Teams meeting recordings in your org settings', 'Recordings are saved to OneDrive/SharePoint', 'Copy the transcript from the Teams recording and paste below'] },
  skype: { label: 'Skype', color: '#00AFF0', setup: ['Enable call recording in Skype settings', 'Skype saves recordings for 30 days', 'Copy transcript or summarize the call and paste below'] },
};

/* ── App factory ───────────────────────────────────────────────────────────── */

function app() {
  return {
    /* Shell */
    page: 'overview',
    apiDown: false,
    toasts: [],
    _toastSeq: 0,

    /* Data + per-section load flags (drive skeletons) */
    stats: { total_active: 0, by_stage: {}, hot_leads: 0, meetings_booked_total: 0, today: {} },
    statsLoaded: false,
    health: null,
    loop: { running: false, tickCount: 0 },
    activity: [],
    activityLoaded: false,
    activityFilter: 'all',
    hotLeads: [],

    prospects: [],
    prospectsLoaded: false,
    prospectSearch: '',
    prospectStageFilter: '',
    imports: [],
    importsLoaded: false,

    campaigns: [],
    campaignsLoaded: false,
    campaignSteps: {},       // id → steps[] (fetched on expand)
    expandedCampaignId: null,
    campaignBusy: null,      // id currently activating/pausing

    channelList: [],         // normalized [{channel, configured, verified, dailyLimit, usedToday, account}]
    channelsLoaded: false,

    settingsEnv: null,       // normalized [{channel, missing:[]}] or null (endpoint unavailable)
    settingsEnvLoaded: false,
    suppressionCount: null,
    suppressionLoaded: false,
    suppressionEntries: [],
    suppForm: { channel: 'email', contact: '' },
    suppFormBusy: false,
    allStages: ALL_STAGES,
    suppressChannels: SUPPRESS_CHANNELS,

    /* Loop control (ISC-68, ISC-79) */
    loopModal: false,
    loopBusy: false,

    /* Prospect detail drawer (ISC-69, ISC-77) */
    drawerOpen: false,
    drawerLoading: false,
    drawerProspect: null,
    drawerTouches: [],       // newest first (reversed from the API's ASC order)
    drawerStage: '',
    stageBusy: false,
    suppressArmed: false,
    suppressBusy: false,

    crmAdapters: [],
    aiEmailStatus: { instantly: { active: false, campaigns: [] }, salesforge: { active: false, sequences: [] } },
    aiEmailLoading: false,
    crmPulling: false,
    crmPullResult: '',

    /* Builder (lives inside Campaigns page) */
    builderOpen: false,
    builderId: null,
    builderMessages: [],
    builderInput: '',
    builderLoading: false,
    builderRetryMsg: null,   // last user message that failed — drives the Retry button
    builtCampaign: null,

    /* Modals */
    showAddLead: false,
    newLead: { name: '', company: '', title: '', email: '', linkedin_url: '', phone: '' },
    addLeadBusy: false,
    showImport: false,
    importRows: [],
    importFileName: '',
    importResult: null,
    importBusy: false,
    setupKey: null,          // channel or meeting-platform key for setup modal

    /* Docs (localStorage) */
    docsTab: 'notes',
    notes: [],
    currentNoteId: null,
    currentNoteTitle: '',
    currentNoteContent: '',
    tasks: { todo: [], inProgress: [], done: [] },
    newTaskText: '',
    newTaskCol: 'todo',

    /* Meetings */
    meetingTranscript: '',
    meetingTopic: '',
    meetingAttendees: '',
    meetingMyRole: '',
    meetingAnalyzing: false,
    meetingAnalysis: null,
    meetingDraftTab: 'email',
    otterTranscripts: [],
    otterLoading: false,
    meetingPlatforms: MEETING_PLATFORMS,

    /* Oration */
    orationOpen: false,
    orationListening: false,
    orationTranscript: '',
    orationResponse: '',
    orationLoading: false,
    orationSpeechSupported: false,
    _recognition: null,

    /* ── Derived ── */

    get verifiedChannelCount() {
      return this.channelList.filter((c) => c.verified === true).length;
    },
    get configuredChannelCount() {
      return this.channelList.filter((c) => c.configured).length;
    },
    get sendsToday() {
      const t = this.stats.today || {};
      return (t.emails_sent || 0) + (t.linkedin_connects || 0) + (t.sms_sent || 0);
    },
    get filteredActivity() {
      if (this.activityFilter === 'all') return this.activity;
      if (this.activityFilter === 'inbound') return this.activity.filter((a) => a.direction === 'inbound');
      if (this.activityFilter === 'outbound') return this.activity.filter((a) => a.direction === 'outbound');
      if (this.activityFilter === 'blocked') return this.activity.filter((a) => a.type === 'blocked');
      if (this.activityFilter === 'hot') return this.activity.filter((a) => a.type === 'hot_lead');
      return this.activity;
    },
    get funnelTotal() {
      const by = this.stats.by_stage || {};
      return STAGES.reduce((s, [k]) => s + (by[k] || 0), 0);
    },

    /* ── Init + polling ── */

    async init() {
      this.orationSpeechSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
      this.loadDocs();
      this.loadTasks();
      await Promise.allSettled([
        this.loadStats(),
        this.loadHealth(),
        this.loadChannels(),
        this.loadCampaigns(),
        this.loadActivity(),
        this.loadHotLeads(),
        this.loadCRMAdapters(),
      ]);
      setInterval(() => this.poll(), 15000);
    },

    async poll() {
      const ok = await Promise.allSettled([
        this.loadStats(),
        this.loadActivity(),
        this.loadHealth(),
        this.loadHotLeads(),
      ]);
      // loadStats sets apiDown itself; nothing else to do here
      void ok;
    },

    /* fetch helper — throws on !ok so callers can degrade */
    async api(path, opts) {
      const res = await fetch(path, opts);
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const body = await res.json(); if (body && body.error) msg = body.error; } catch (e) { /* ignore */ }
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },

    toast(message, type) {
      const id = ++this._toastSeq;
      this.toasts.push({ id, message, type: type || 'info' });
      setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); }, 4200);
    },

    closeModals() {
      this.showAddLead = false;
      this.showImport = false;
      this.setupKey = null;
      this.loopModal = false;
      this.closeDrawer();
    },

    /* ── Loop control ── */

    openLoopModal() {
      this.loopModal = true;
    },

    async confirmLoopToggle() {
      if (this.loopBusy) return;
      this.loopBusy = true;
      const starting = !this.loop.running;
      try {
        await this.api(starting ? '/api/loop/start' : '/api/loop/stop', { method: 'POST' });
        // Re-poll /api/health so the indicator shows the server's truth,
        // not an optimistic client-side guess.
        await this.loadHealth();
        this.toast(
          this.loop.running
            ? 'Outreach loop started — due prospects will receive real messages'
            : 'Outreach loop stopped — no further sends until restarted',
          this.loop.running ? 'success' : 'info',
        );
        this.loopModal = false;
      } catch (e) {
        await this.loadHealth();
        this.toast('Loop ' + (starting ? 'start' : 'stop') + ' failed: ' + e.message, 'error');
      }
      this.loopBusy = false;
    },

    /* ── Prospect detail drawer ── */

    async openProspect(id) {
      this.drawerOpen = true;
      this.drawerLoading = true;
      this.suppressArmed = false;
      this.drawerProspect = null;
      this.drawerTouches = [];
      try {
        const d = await this.api('/api/prospects/' + encodeURIComponent(id));
        this.drawerProspect = d;
        this.drawerStage = d.stage;
        this.drawerTouches = (d.touches || []).slice().reverse(); // newest first
      } catch (e) {
        this.toast('Could not load prospect: ' + e.message, 'error');
        this.drawerOpen = false;
      }
      this.drawerLoading = false;
    },

    closeDrawer() {
      this.drawerOpen = false;
      this.suppressArmed = false;
    },

    async changeStage() {
      if (!this.drawerProspect || this.stageBusy) return;
      if (this.drawerStage === this.drawerProspect.stage) return;
      this.stageBusy = true;
      try {
        const result = await this.api('/api/prospects/' + encodeURIComponent(this.drawerProspect.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: this.drawerStage }),
        });
        if (result.prospect) {
          this.drawerProspect = { ...this.drawerProspect, ...result.prospect };
          this.drawerStage = result.prospect.stage;
        }
        this.toast('Stage updated to "' + this.stageLabel(this.drawerStage) + '" — CRM sync queued', 'success');
        await Promise.allSettled([this.loadProspects(), this.loadStats(), this.loadHotLeads()]);
      } catch (e) {
        this.drawerStage = this.drawerProspect.stage; // revert the select
        this.toast('Stage change failed: ' + e.message, 'error');
      }
      this.stageBusy = false;
    },

    async suppressProspect() {
      if (!this.drawerProspect || this.suppressBusy) return;
      if (!this.suppressArmed) { this.suppressArmed = true; return; } // two-click confirm
      this.suppressBusy = true;
      try {
        const result = await this.api('/api/prospects/' + encodeURIComponent(this.drawerProspect.id) + '/suppress', { method: 'POST' });
        if (result.prospect) {
          this.drawerProspect = { ...this.drawerProspect, ...result.prospect, suppressed: true };
          this.drawerStage = result.prospect.stage;
        }
        this.toast(this.drawerProspect.name + ' suppressed across all channels', 'success');
        await Promise.allSettled([this.loadProspects(), this.loadStats()]);
      } catch (e) {
        this.toast('Suppress failed: ' + e.message, 'error');
      }
      this.suppressArmed = false;
      this.suppressBusy = false;
    },

    touchStatusColor(status) {
      const m = {
        sent: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        delivered: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        blocked: 'bg-red-500/10 text-red-400 border-red-500/20',
        failed: 'bg-red-500/10 text-red-400 border-red-500/20',
        bounced: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      };
      return m[status] || 'bg-zinc-800 text-zinc-400 border-zinc-700';
    },

    /* ── Suppression ops (Settings) ── */

    async addSuppression() {
      if (!this.suppForm.contact.trim() || this.suppFormBusy) return;
      this.suppFormBusy = true;
      try {
        const result = await this.api('/api/suppression', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: this.suppForm.channel, contact: this.suppForm.contact.trim() }),
        });
        this.toast('Suppressed ' + (result.entry ? result.entry.contact : this.suppForm.contact), 'success');
        this.suppForm.contact = '';
        await this.loadSettings();
      } catch (e) {
        this.toast('Could not suppress contact: ' + e.message, 'error');
      }
      this.suppFormBusy = false;
    },

    /* ── Loaders ── */

    async loadStats() {
      try {
        this.stats = await this.api('/api/stats');
        this.statsLoaded = true;
        this.apiDown = false;
      } catch (e) {
        this.apiDown = true;
      }
    },

    async loadHealth() {
      try {
        this.health = await this.api('/api/health');
        this.loop = (this.health && this.health.loop) || { running: false, tickCount: 0 };
      } catch (e) { /* banner handled by stats */ }
    },

    async loadHotLeads() {
      try {
        const hot = await this.api('/api/prospects/hot');
        this.hotLeads = Array.isArray(hot) ? hot : [];
      } catch (e) { /* keep last */ }
    },

    async loadActivity() {
      try {
        const data = await this.api('/api/activity?limit=100');
        this.activity = Array.isArray(data) ? data : [];
        this.activityLoaded = true;
      } catch (e) { /* keep last */ }
    },

    async loadProspects() {
      try {
        let url = '/api/prospects?limit=200';
        if (this.prospectSearch.trim()) {
          url = '/api/prospects?q=' + encodeURIComponent(this.prospectSearch.trim()) + '&limit=200';
        } else if (this.prospectStageFilter) {
          url = '/api/prospects?stage=' + encodeURIComponent(this.prospectStageFilter) + '&limit=200';
        }
        const data = await this.api(url);
        this.prospects = Array.isArray(data) ? data : [];
        this.prospectsLoaded = true;
      } catch (e) {
        this.prospectsLoaded = true;
        this.toast('Could not load prospects: ' + e.message, 'error');
      }
    },

    async loadImports() {
      try {
        const data = await this.api('/api/imports');
        this.imports = Array.isArray(data) ? data : [];
      } catch (e) { this.imports = []; }
      this.importsLoaded = true;
    },

    async loadCampaigns() {
      try {
        const data = await this.api('/api/campaigns');
        this.campaigns = Array.isArray(data) ? data : [];
        this.campaignsLoaded = true;
      } catch (e) { /* keep last */ }
    },

    async loadChannels() {
      try {
        const data = await this.api('/api/channels/status');
        this.channelList = this.normalizeChannels(data);
      } catch (e) {
        this.channelList = CHANNEL_ORDER.map((k) => ({
          channel: k, configured: false, verified: null, dailyLimit: null, usedToday: 0, account: null,
        }));
      }
      this.channelsLoaded = true;
    },

    /* Accepts new shape { channels:[{channel,configured,verified,dailyLimit,usedToday}] }
       and legacy shape { email:{active,...}, ... }. Never claims "verified" unless
       the backend says so. */
    normalizeChannels(data) {
      let list = [];
      if (data && Array.isArray(data.channels)) {
        list = data.channels.map((c) => ({
          channel: c.channel,
          configured: !!c.configured,
          verified: typeof c.verified === 'boolean' ? c.verified : null,
          dailyLimit: typeof c.dailyLimit === 'number' ? c.dailyLimit : null,
          usedToday: typeof c.usedToday === 'number' ? c.usedToday : 0,
          account: c.account || null,
        }));
      } else if (data && typeof data === 'object') {
        list = Object.entries(data).map(([k, v]) => ({
          channel: k,
          configured: !!(v && v.active),
          verified: null, // legacy shape: env-present, never claim verified
          dailyLimit: null,
          usedToday: 0,
          account: (v && v.account) || null,
        }));
      }
      // Stable, complete ordering: every known channel gets a card
      const byKey = {};
      list.forEach((c) => { byKey[c.channel] = c; });
      return CHANNEL_ORDER.map((k) => byKey[k] || {
        channel: k, configured: false, verified: null, dailyLimit: null, usedToday: 0, account: null,
      });
    },

    async loadSettings() {
      // Env vars — endpoint may not exist yet; degrade honestly.
      try {
        const data = await this.api('/api/settings/env');
        this.settingsEnv = this.normalizeEnv(data);
      } catch (e) {
        this.settingsEnv = null;
      }
      this.settingsEnvLoaded = true;
      // Suppression count + entries
      try {
        const data = await this.api('/api/suppression');
        if (Array.isArray(data)) { this.suppressionCount = data.length; this.suppressionEntries = data; }
        else if (typeof data === 'number') { this.suppressionCount = data; this.suppressionEntries = []; }
        else if (data && Array.isArray(data.entries)) {
          this.suppressionEntries = data.entries;
          this.suppressionCount = typeof data.count === 'number' ? data.count : data.entries.length;
        } else if (data && typeof data.count === 'number') { this.suppressionCount = data.count; this.suppressionEntries = []; }
        else { this.suppressionCount = null; this.suppressionEntries = []; }
      } catch (e) {
        this.suppressionCount = null;
        this.suppressionEntries = [];
      }
      this.suppressionLoaded = true;
      this.loadHealth();
    },

    /* Accepts several plausible shapes for /api/settings/env, returns
       [{channel, missing: [varName]}] — variable NAMES only, never values. */
    normalizeEnv(data) {
      if (!data || typeof data !== 'object') return [];
      let entries = [];
      if (Array.isArray(data.channels)) {
        entries = data.channels.map((c) => ({
          channel: c.channel || c.name || '?',
          missing: Array.isArray(c.missing) ? c.missing : [],
        }));
      } else if (Array.isArray(data)) {
        entries = data.map((c) => ({
          channel: c.channel || c.name || '?',
          missing: Array.isArray(c.missing) ? c.missing : [],
        }));
      } else {
        const src = (data.missing && typeof data.missing === 'object') ? data.missing : data;
        entries = Object.entries(src)
          .filter(([, v]) => Array.isArray(v) || (v && Array.isArray(v.missing)))
          .map(([k, v]) => ({ channel: k, missing: Array.isArray(v) ? v : v.missing }));
      }
      return entries.filter((e) => typeof e.channel === 'string');
    },

    async loadCRMAdapters() {
      try { this.crmAdapters = await this.api('/api/crm/adapters'); } catch (e) { this.crmAdapters = []; }
    },

    async loadAIEmailStatus() {
      try { this.aiEmailStatus = await this.api('/api/integrations/aiemail/status'); } catch (e) { /* keep */ }
    },

    /* ── Navigation ── */

    navigate(p) {
      this.page = p;
      if (p === 'prospects') { this.loadProspects(); this.loadImports(); }
      if (p === 'campaigns') this.loadCampaigns();
      if (p === 'activity') this.loadActivity();
      if (p === 'channels') this.loadChannels();
      if (p === 'settings') this.loadSettings();
      if (p === 'aiemail') this.loadAIEmailStatus();
    },

    pageTitle() {
      const t = {
        overview: 'Overview', prospects: 'Prospects', campaigns: 'Campaigns',
        channels: 'Channels', activity: 'Activity', settings: 'Settings',
        crm: 'CRM Sync', docs: 'Docs & Tasks', meetings: 'Meeting Intelligence',
        aiemail: 'AI Email Platforms',
      };
      return t[this.page] || 'BDRclaw';
    },

    pageSubtitle() {
      if (this.page === 'overview') return this.stats.total_active + ' prospects in pipeline · ' + this.verifiedChannelCount + ' verified channel' + (this.verifiedChannelCount === 1 ? '' : 's');
      if (this.page === 'prospects') return 'Search, filter, add, and import your pipeline';
      if (this.page === 'campaigns') return this.builderOpen ? 'Describe your offer — BDR Claude builds the sequence.' : 'Multi-channel sequences, built conversationally';
      if (this.page === 'channels') return this.configuredChannelCount + ' of ' + this.channelList.length + ' channels configured';
      if (this.page === 'activity') return 'Every touch, reply, and quality-gate decision';
      if (this.page === 'settings') return 'Environment, compliance, and system health';
      if (this.page === 'meetings') return 'Paste a transcript and get AI-powered insights + follow-up drafts';
      if (this.page === 'docs') return 'Scratchpad notes and kanban task board — stored locally';
      if (this.page === 'aiemail') return 'Push prospects to Instantly, Salesforge, and more';
      return '';
    },

    /* ── Charts (inline SVG, generated here; numeric-only content, XSS-safe) ── */

    funnelSvg() {
      const by = this.stats.by_stage || {};
      const counts = STAGES.map(([k]) => by[k] || 0);
      const max = Math.max(1, ...counts);
      const W = 560, labelW = 138, valueW = 44, rowH = 34, barH = 18, r = 4;
      const barMax = W - labelW - valueW - 16;
      const H = STAGES.length * rowH;
      let rows = '';
      STAGES.forEach(([key, label], i) => {
        const y = i * rowH + (rowH - barH) / 2;
        const cy = i * rowH + rowH / 2;
        const n = counts[i];
        const w = n > 0 ? Math.max(6, (n / max) * barMax) : 0;
        const color = FUNNEL_RAMP[i];
        // hairline track so empty stages keep the funnel's shape
        rows += '<rect x="' + labelW + '" y="' + (cy - 0.5) + '" width="' + barMax + '" height="1" fill="#27272a"/>';
        if (w > 0) {
          // square at baseline (left), 4px rounded data-end (right)
          rows += '<path d="M' + labelW + ',' + y + ' h' + (w - r) + ' a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
            ' v' + (barH - 2 * r) + ' a' + r + ',' + r + ' 0 0 1 -' + r + ',' + r +
            ' h-' + (w - r) + ' z" fill="' + color + '"><title>' + label + ': ' + n + '</title></path>';
        }
        rows += '<text x="' + (labelW - 10) + '" y="' + cy + '" text-anchor="end" dominant-baseline="central" fill="#a1a1aa" font-size="12" font-family="Inter,system-ui,sans-serif">' + label + '</text>';
        rows += '<text x="' + (labelW + w + 8) + '" y="' + cy + '" dominant-baseline="central" fill="#e4e4e7" font-size="12" font-weight="600" font-family="Inter,system-ui,sans-serif">' + n + '</text>';
      });
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="w-full h-auto" role="img" aria-label="Pipeline funnel by stage">' + rows + '</svg>';
    },

    /* 24h outbound-volume sparkline from real activity timestamps (12 buckets × 2h) */
    sparklineSvg() {
      const now = Date.now();
      const buckets = new Array(12).fill(0);
      let any = false;
      this.activity.forEach((a) => {
        if (a.direction !== 'outbound') return;
        const t = new Date(a.sent_at).getTime();
        const age = now - t;
        if (age < 0 || age > 24 * 3600 * 1000) return;
        const idx = 11 - Math.min(11, Math.floor(age / (2 * 3600 * 1000)));
        buckets[idx]++;
        any = true;
      });
      if (!any) return '';
      const W = 120, H = 32, pad = 4;
      const max = Math.max(1, ...buckets);
      const pts = buckets.map((v, i) => {
        const x = pad + (i / 11) * (W - 2 * pad);
        const y = H - pad - (v / max) * (H - 2 * pad);
        return [x.toFixed(1), y.toFixed(1)];
      });
      const path = 'M' + pts.map((p) => p.join(',')).join(' L');
      const last = pts[pts.length - 1];
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="w-full h-8" role="img" aria-label="Outbound sends, last 24 hours">' +
        '<path d="' + path + '" fill="none" stroke="#fb923c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4" fill="#fb923c" stroke="#18181b" stroke-width="2"/>' +
        '</svg>';
    },

    /* Daily-limit meter: same-ramp track, fill severity accent → warning → danger */
    meterSvg(used, limit) {
      if (typeof limit !== 'number' || limit <= 0) return '';
      const pct = Math.min(1, (used || 0) / limit);
      const color = pct >= 1 ? '#ef4444' : pct >= 0.8 ? '#f59e0b' : '#f97316';
      const W = 100, H = 8;
      const w = Math.max(pct > 0 ? 4 : 0, pct * W);
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" class="w-full h-2" role="img" aria-label="' + (used || 0) + ' of ' + limit + ' daily sends used">' +
        '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="3" fill="rgba(249,115,22,0.15)"/>' +
        (w > 0 ? '<rect x="0" y="0" width="' + w + '" height="' + H + '" rx="3" fill="' + color + '"/>' : '') +
        '</svg>';
    },

    /* ── Prospects ── */

    async addLead() {
      if (!this.newLead.name || !this.newLead.company || !this.newLead.title) return;
      this.addLeadBusy = true;
      try {
        await this.api('/api/prospects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.newLead),
        });
        this.toast('Prospect "' + this.newLead.name + '" added', 'success');
        this.showAddLead = false;
        this.newLead = { name: '', company: '', title: '', email: '', linkedin_url: '', phone: '' };
        await Promise.allSettled([this.loadProspects(), this.loadStats()]);
      } catch (e) {
        this.toast('Could not add prospect: ' + e.message, 'error');
      }
      this.addLeadBusy = false;
    },

    onImportFile(ev) {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      this.importFileName = file.name;
      this.importResult = null;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          this.importRows = this.parseCsv(String(reader.result || ''));
          if (this.importRows.length === 0) this.toast('No rows found in that file', 'error');
        } catch (e) {
          this.importRows = [];
          this.toast('Could not parse CSV: ' + e.message, 'error');
        }
      };
      reader.readAsText(file);
      ev.target.value = '';
    },

    /* Minimal RFC-4180-ish CSV parser: quoted fields, commas, newlines. */
    parseCsv(text) {
      const grid = [];
      let row = [], field = '', inQ = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQ) {
          if (ch === '"') {
            if (text[i + 1] === '"') { field += '"'; i++; }
            else inQ = false;
          } else field += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          row.push(field); field = '';
          if (row.some((c) => c.trim() !== '')) grid.push(row);
          row = [];
        } else field += ch;
      }
      row.push(field);
      if (row.some((c) => c.trim() !== '')) grid.push(row);
      if (grid.length < 2) return [];

      const alias = {
        name: 'name', 'full name': 'name', fullname: 'name',
        company: 'company', organization: 'company', org: 'company',
        title: 'title', role: 'title', position: 'title', 'job title': 'title',
        email: 'email', 'email address': 'email',
        linkedin: 'linkedin_url', linkedin_url: 'linkedin_url', 'linkedin url': 'linkedin_url',
        phone: 'phone', 'phone number': 'phone', mobile: 'phone',
        tags: 'tags',
      };
      const header = grid[0].map((h) => alias[h.trim().toLowerCase()] || null);
      return grid.slice(1).map((cells) => {
        const obj = {};
        header.forEach((key, i) => {
          if (key && cells[i] !== undefined && cells[i].trim() !== '') obj[key] = cells[i].trim();
        });
        return obj;
      }).filter((o) => Object.keys(o).length > 0);
    },

    get importReadyCount() {
      return this.importRows.filter((r) => r.name && r.company && r.title).length;
    },

    async runImport() {
      if (this.importRows.length === 0) return;
      this.importBusy = true;
      try {
        const result = await this.api('/api/prospects/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.importRows),
        });
        this.importResult = result;
        this.toast('Imported ' + (result.imported || 0) + ' prospects' +
          (result.errors && result.errors.length ? ' (' + result.errors.length + ' rows skipped)' : ''),
          result.errors && result.errors.length ? 'info' : 'success');
        await Promise.allSettled([this.loadProspects(), this.loadStats(), this.loadImports()]);
      } catch (e) {
        this.toast('Import failed: ' + e.message, 'error');
      }
      this.importBusy = false;
    },

    resetImport() {
      this.importRows = [];
      this.importFileName = '';
      this.importResult = null;
    },

    /* ── Campaigns ── */

    async toggleCampaignDetail(id) {
      if (this.expandedCampaignId === id) { this.expandedCampaignId = null; return; }
      this.expandedCampaignId = id;
      if (!this.campaignSteps[id]) {
        try {
          const data = await this.api('/api/campaigns/' + id);
          this.campaignSteps[id] = Array.isArray(data.steps) ? data.steps : [];
        } catch (e) {
          this.campaignSteps[id] = [];
          this.toast('Could not load campaign steps: ' + e.message, 'error');
        }
      }
    },

    campaignChannels(id) {
      const steps = this.campaignSteps[id] || [];
      const map = {
        send_email: 'email', linkedin_connect: 'linkedin', linkedin_dm: 'linkedin',
        twitter_dm: 'twitter', instagram_dm: 'instagram', telegram_dm: 'telegram',
        whatsapp_dm: 'whatsapp', send_sms: 'sms',
      };
      const out = [];
      steps.forEach((s) => {
        const ch = map[s.action_type];
        if (ch && !out.includes(ch)) out.push(ch);
      });
      return out;
    },

    actionLabel(t) {
      const m = {
        send_email: 'Email', linkedin_connect: 'LinkedIn invite', linkedin_dm: 'LinkedIn DM',
        twitter_dm: 'X DM', instagram_dm: 'Instagram DM', telegram_dm: 'Telegram',
        whatsapp_dm: 'WhatsApp', send_sms: 'SMS', wait: 'Wait',
        enrich: 'Enrich', update_crm: 'Update CRM', notify_closer: 'Notify closer',
        classify_reply: 'Classify reply', send_meeting_link: 'Send meeting link',
      };
      return m[t] || t;
    },

    async setCampaignStatus(id, status) {
      this.campaignBusy = id;
      try {
        const result = await this.api('/api/campaigns/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (status === 'active') {
          const n = typeof result.enrolled === 'number' ? result.enrolled : 0;
          this.toast('Campaign activated — ' + n + ' prospect' + (n === 1 ? '' : 's') + ' enrolled', 'success');
        } else {
          this.toast('Campaign ' + status, 'info');
        }
        await this.loadCampaigns();
      } catch (e) {
        this.toast('Could not update campaign: ' + e.message, 'error');
      }
      this.campaignBusy = null;
    },

    /* ── Builder chat ── */

    async openBuilder() {
      this.builderOpen = true;
      if (this.builderMessages.length === 0) await this.startBuilder();
      this.$nextTick(() => { const el = document.getElementById('builder-input'); if (el) el.focus(); });
    },

    async startBuilder() {
      this.builderLoading = true;
      this.builtCampaign = null;
      this.builderRetryMsg = null;
      try {
        const data = await this.api('/api/campaigns/builder/start', { method: 'POST' });
        this.builderId = data.sessionId;
        this.builderMessages = [{ role: 'assistant', content: data.message }];
      } catch (e) {
        this.builderId = null;
        this.builderMessages = [{ role: 'assistant', error: true, content: 'I could not reach the builder service (' + e.message + '). Type your message anyway — I will reconnect and retry automatically.' }];
        this.toast('Builder unavailable: ' + e.message, 'error');
      }
      this.builderLoading = false;
    },

    async sendBuilderMessage() {
      if (!this.builderInput.trim() || this.builderLoading) return;
      const msg = this.builderInput.trim();
      this.builderInput = '';
      this.builderMessages.push({ role: 'user', content: msg });
      await this._builderSend(msg);
    },

    /* Retry the last failed message without re-adding the user bubble. */
    async retryBuilder() {
      if (!this.builderRetryMsg || this.builderLoading) return;
      const msg = this.builderRetryMsg;
      // Drop the error bubble so the retry reads as one clean exchange.
      this.builderMessages = this.builderMessages.filter((m) => !m.error);
      await this._builderSend(msg);
    },

    /* Shared send path with honest error recovery (feeds ISC-75): a failed
       /chat call shows a readable toast + an inline error bubble with Retry —
       never a silent failure. The typing indicator is builderLoading. */
    async _builderSend(msg) {
      this.builderLoading = true;
      this.builderRetryMsg = null;
      this.$nextTick(() => this.scrollChat());
      try {
        // Session may be missing if /builder/start failed earlier — recover.
        if (!this.builderId) {
          const start = await this.api('/api/campaigns/builder/start', { method: 'POST' });
          this.builderId = start.sessionId;
        }
        const data = await this.api('/api/campaigns/builder/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: this.builderId, message: msg }),
        });
        // Strip the raw ```campaign JSON fence from the display copy
        const clean = String(data.reply || '').replace(/```campaign[\s\S]*?```/g, '').trim();
        this.builderMessages.push({ role: 'assistant', content: clean || 'Campaign generated.' });
        if (data.campaign) this.builtCampaign = data.campaign;
        if (data.done) {
          await this.loadCampaigns();
          if (data.campaign) this.campaignSteps[data.campaign.id] = data.campaign.steps || [];
        }
      } catch (e) {
        this.builderRetryMsg = msg;
        this.builderMessages.push({
          role: 'assistant',
          error: true,
          content: 'I could not process that — ' + (e.status ? 'the server returned ' + e.status + ' (' + e.message + ')' : e.message) + '. Your message was not lost.',
        });
        this.toast('Builder error: ' + e.message, 'error');
      }
      this.builderLoading = false;
      this.$nextTick(() => this.scrollChat());
    },

    scrollChat() {
      const el = document.getElementById('chat-messages');
      if (el) el.scrollTop = el.scrollHeight;
    },

    resetBuilder() {
      this.builderId = null;
      this.builderMessages = [];
      this.builtCampaign = null;
      this.startBuilder();
    },

    closeBuilder() {
      this.builderOpen = false;
    },

    /* ── Channels helpers ── */

    channelLabel(k) { return (CHANNEL_META[k] && CHANNEL_META[k].label) || k; },
    channelColor(k) { return (CHANNEL_META[k] && CHANNEL_META[k].color) || '#71717a'; },
    channelCap(k) { return (CHANNEL_META[k] && CHANNEL_META[k].cap) || ''; },
    channelSetupSteps(k) {
      if (CHANNEL_META[k]) return CHANNEL_META[k].setup;
      if (MEETING_PLATFORMS[k]) return MEETING_PLATFORMS[k].setup;
      return [];
    },
    setupLabel(k) {
      if (CHANNEL_META[k]) return CHANNEL_META[k].label;
      if (MEETING_PLATFORMS[k]) return MEETING_PLATFORMS[k].label;
      return k;
    },
    channelStatusText(c) {
      if (c.verified === true) return 'Verified — messages sending';
      if (c.configured && c.verified === false) return 'Configured — verification pending';
      if (c.configured) return 'Configured — not yet verified';
      return 'Not configured';
    },

    /* ── CRM / AI Email (carried over) ── */

    async pullCRM() {
      this.crmPulling = true;
      this.crmPullResult = '';
      try {
        const data = await this.api('/api/crm/pull', { method: 'POST' });
        this.crmPullResult = 'Pulled ' + (data.count || 0) + ' contacts from CRM';
      } catch (e) { this.crmPullResult = 'Pull failed: ' + e.message; }
      this.crmPulling = false;
    },

    async syncInstantlyProspects() {
      this.aiEmailLoading = true;
      try {
        if (this.prospects.length === 0) await this.loadProspects();
        const ps = this.prospects.map((p) => ({
          email: p.email || '',
          first_name: p.name.split(' ')[0],
          last_name: p.name.split(' ').slice(1).join(' '),
          company_name: p.company,
        }));
        await this.api('/api/integrations/instantly/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prospects: ps }),
        });
        this.toast('Synced ' + ps.length + ' prospects to Instantly', 'success');
      } catch (e) { this.toast('Instantly sync failed: ' + e.message, 'error'); }
      this.aiEmailLoading = false;
    },

    async syncSalesforgeProspects() {
      this.aiEmailLoading = true;
      try {
        if (this.prospects.length === 0) await this.loadProspects();
        const cs = this.prospects.map((p) => ({
          email: p.email || '',
          firstName: p.name.split(' ')[0],
          lastName: p.name.split(' ').slice(1).join(' '),
          companyName: p.company,
          title: p.title,
        }));
        await this.api('/api/integrations/salesforge/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contacts: cs }),
        });
        this.toast('Synced ' + cs.length + ' contacts to Salesforge', 'success');
      } catch (e) { this.toast('Salesforge sync failed: ' + e.message, 'error'); }
      this.aiEmailLoading = false;
    },

    /* ── Docs — notes (localStorage) ── */

    loadDocs() {
      try { this.notes = JSON.parse(localStorage.getItem('bdrclaw_notes') || '[]'); } catch (e) { this.notes = []; }
    },
    saveDocs() { localStorage.setItem('bdrclaw_notes', JSON.stringify(this.notes)); },
    newNote() {
      const n = { id: Date.now().toString(), title: '', content: '', preview: '', updatedAt: new Date().toISOString() };
      this.notes.unshift(n);
      this.saveDocs();
      this.selectNote(n.id);
      this.docsTab = 'notes';
    },
    selectNote(id) {
      this.currentNoteId = id;
      const n = this.notes.find((x) => x.id === id);
      if (n) { this.currentNoteTitle = n.title; this.currentNoteContent = n.content; }
    },
    saveCurrentNote() {
      const n = this.notes.find((x) => x.id === this.currentNoteId);
      if (!n) return;
      n.title = this.currentNoteTitle;
      n.content = this.currentNoteContent;
      n.preview = this.currentNoteContent.slice(0, 60).replace(/\n/g, ' ');
      n.updatedAt = new Date().toISOString();
      this.saveDocs();
    },
    deleteCurrentNote() {
      this.notes = this.notes.filter((n) => n.id !== this.currentNoteId);
      this.saveDocs();
      this.currentNoteId = null; this.currentNoteTitle = ''; this.currentNoteContent = '';
    },

    /* ── Docs — tasks (kanban, localStorage) ── */

    loadTasks() {
      try { this.tasks = JSON.parse(localStorage.getItem('bdrclaw_tasks') || '{"todo":[],"inProgress":[],"done":[]}'); }
      catch (e) { this.tasks = { todo: [], inProgress: [], done: [] }; }
    },
    saveTasks() { localStorage.setItem('bdrclaw_tasks', JSON.stringify(this.tasks)); },
    addTask(col) {
      if (!this.newTaskText.trim()) return;
      this.tasks[col].push({ id: Date.now().toString(), text: this.newTaskText.trim() });
      this.newTaskText = '';
      this.saveTasks();
    },
    moveTask(id, from, to) {
      const idx = this.tasks[from].findIndex((t) => t.id === id);
      if (idx === -1) return;
      const task = this.tasks[from].splice(idx, 1)[0];
      this.tasks[to].push(task);
      this.saveTasks();
    },
    deleteTask(id, col) {
      this.tasks[col] = this.tasks[col].filter((t) => t.id !== id);
      this.saveTasks();
    },

    /* ── Meetings ── */

    async analyzeMeeting() {
      if (!this.meetingTranscript.trim()) return;
      this.meetingAnalyzing = true;
      this.meetingAnalysis = null;
      try {
        this.meetingAnalysis = await this.api('/api/meetings/analyze', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript: this.meetingTranscript, topic: this.meetingTopic,
            attendees: this.meetingAttendees, myRole: this.meetingMyRole,
          }),
        });
      } catch (e) {
        this.toast('Analysis failed: ' + e.message, 'error');
      }
      this.meetingAnalyzing = false;
    },

    async loadOtterTranscripts() {
      this.otterLoading = true;
      try {
        const data = await this.api('/api/otter/transcripts');
        this.otterTranscripts = data.transcripts || [];
      } catch (e) { this.otterTranscripts = []; }
      this.otterLoading = false;
    },

    copyDraft() {
      const t = this.meetingDraftTab;
      const a = this.meetingAnalysis || {};
      const text = t === 'email' ? a.emailDraft : t === 'sms' ? a.smsDraft : t === 'telegram' ? a.telegramDraft : a.linkedinMessage;
      if (text) { navigator.clipboard.writeText(text); this.toast('Copied to clipboard', 'success'); }
    },

    /* ── Oration ── */

    toggleOration() {
      if (this.orationListening) { this.stopListening(); return; }
      this.orationOpen = true;
      if (this.orationSpeechSupported) this.startListening();
    },
    startListening() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return;
      this._recognition = new SR();
      this._recognition.lang = 'en-US';
      this._recognition.interimResults = false;
      this._recognition.onresult = (e) => {
        this.orationTranscript = e.results[0][0].transcript;
        this.orationListening = false;
        this.sendOration();
      };
      this._recognition.onend = () => { this.orationListening = false; };
      this._recognition.start();
      this.orationListening = true;
    },
    stopListening() {
      if (this._recognition) { this._recognition.stop(); this._recognition = null; }
      this.orationListening = false;
    },
    async sendOration() {
      if (!this.orationTranscript.trim() || this.orationLoading) return;
      this.orationLoading = true;
      this.orationResponse = '';
      try {
        const data = await this.api('/api/oration', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: this.orationTranscript }),
        });
        this.orationResponse = data.response;
        if (data.speak && window.speechSynthesis) {
          window.speechSynthesis.speak(new SpeechSynthesisUtterance(data.response));
        }
        if (data.action && data.action.type === 'navigate') {
          const dest = data.action.payload && data.action.payload.page;
          if (dest) this.navigate(dest);
        }
      } catch (e) { this.orationResponse = 'Error processing your request.'; }
      this.orationLoading = false;
    },

    /* ── Presentation utilities ── */

    logo(key) {
      const logos = {
        email: '<svg viewBox="0 0 24 24" class="w-6 h-6"><path fill="#EA4335" d="M21.8 7.5l-9.8 6.5L2.2 7.5V18a1 1 0 001 1h17.6a1 1 0 001-1V7.5z"/><path fill="#EA4335" d="M21.8 6H2.2l9.8 6.5L21.8 6z" opacity=".7"/></svg>',
        linkedin: '<svg viewBox="0 0 24 24" class="w-6 h-6"><rect width="24" height="24" rx="4" fill="#0A66C2"/><path fill="white" d="M7 9h-2v8h2V9zm-1-3a1.17 1.17 0 110 2.34A1.17 1.17 0 016 6zm12 11h-2v-4c0-1-.4-1.7-1.3-1.7-.9 0-1.4.7-1.4 1.7v4h-2V9h2v1.1c.4-.7 1.2-1.1 2.1-1.1C16.8 9 18 10.2 18 12.4V17z"/></svg>',
        sms: '<svg viewBox="0 0 24 24" class="w-6 h-6" fill="none" stroke="#F22F46" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
        whatsapp: '<svg viewBox="0 0 24 24" class="w-6 h-6"><circle cx="12" cy="12" r="12" fill="#25D366"/><path fill="white" d="M17.5 14.4c-.3-.1-1.6-.8-1.9-.9-.3-.1-.5-.1-.7.1-.2.3-.8.9-.9 1.1-.2.2-.3.2-.6.1-.3-.2-1.2-.4-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.4-.5c.1-.2.2-.3.2-.5 0-.2-.1-.4-.2-.5l-1-2.3c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.2.2-.9.9-.9 2.1 0 1.2.9 2.4 1 2.6.2.2 1.7 2.6 4.1 3.6.6.2 1 .4 1.4.5.6.2 1.1.2 1.5.1.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2-.1-.1-.2-.1-.6-.2z"/></svg>',
        telegram: '<svg viewBox="0 0 24 24" class="w-6 h-6"><circle cx="12" cy="12" r="12" fill="#24A1DE"/><path fill="white" d="M5.5 11.5l12.7-4.9c.6-.2 1.1.1.9.7L17 17.3c-.1.5-.5.7-.9.4l-3-2.3-1.4 1.4c-.2.2-.4.2-.5 0l-.4-2.8L5.5 12c-.5-.2-.5-.5 0-.5z"/></svg>',
        twitter: '<svg viewBox="0 0 24 24" class="w-6 h-6"><rect width="24" height="24" rx="4" fill="#000"/><path fill="white" d="M17.5 4h2.5l-5.4 6.2L21 20h-5l-3.9-5.1L7.5 20H5l5.8-6.6L3 4h5.1l3.5 4.6L17.5 4zm-.9 14.4h1.4L7.5 5.4H6l10.6 13z"/></svg>',
        instagram: '<svg viewBox="0 0 24 24" class="w-6 h-6"><defs><linearGradient id="ig" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="#f09433"/><stop offset="25%" stop-color="#e6683c"/><stop offset="50%" stop-color="#dc2743"/><stop offset="75%" stop-color="#cc2366"/><stop offset="100%" stop-color="#bc1888"/></linearGradient></defs><rect width="24" height="24" rx="6" fill="url(#ig)"/><rect x="7" y="7" width="10" height="10" rx="3" stroke="white" stroke-width="1.5" fill="none"/><circle cx="12" cy="12" r="2.5" stroke="white" stroke-width="1.5" fill="none"/><circle cx="16.5" cy="7.5" r="1" fill="white"/></svg>',
        zoom: '<svg viewBox="0 0 24 24" class="w-6 h-6"><rect width="24" height="24" rx="4" fill="#2D8CFF"/><path fill="white" d="M4 9a2 2 0 012-2h8a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2V9zm12 1.5l4-2.5v8l-4-2.5V10.5z"/></svg>',
        meet: '<svg viewBox="0 0 24 24" class="w-6 h-6"><path fill="#00897B" d="M4 8a4 4 0 014-4h8a4 4 0 014 4v8a4 4 0 01-4 4H8a4 4 0 01-4-4V8z"/><path fill="white" d="M8 9l4 3 4-3v6l-4-3-4 3V9z"/></svg>',
        teams: '<svg viewBox="0 0 24 24" class="w-6 h-6"><rect width="24" height="24" rx="4" fill="#6264A7"/><path fill="white" d="M14 8a2 2 0 11-4 0 2 2 0 014 0zm-6 3h8v1.5a4 4 0 01-4 4 4 4 0 01-4-4V11zm9-2.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 1.5h2v1a3 3 0 01-2 2.8V10z"/></svg>',
        skype: '<svg viewBox="0 0 24 24" class="w-6 h-6"><circle cx="12" cy="12" r="12" fill="#00AFF0"/><path fill="white" d="M17.8 13.6c.1-.5.2-1 .2-1.6 0-3.3-2.7-6-6-6-.6 0-1.2.1-1.7.2C9.8 6 9.2 5.8 8.6 5.8 7 5.8 5.8 7 5.8 8.6c0 .6.2 1.2.4 1.7-.2.5-.2 1-.2 1.6 0 3.3 2.7 6 6 6 .6 0 1.2-.1 1.6-.2.5.3 1.1.4 1.7.4 1.6 0 2.8-1.2 2.8-2.8 0-.6-.1-1.2-.4-1.7zm-5.8 1.4c-1.9 0-2.8-.9-2.8-1.6 0-.4.3-.7.7-.7.9 0 .7 1.2 2.1 1.2.8 0 1.2-.4 1.2-.8 0-.3-.1-.5-.8-.7l-1.6-.4c-1.3-.3-1.5-1-1.5-1.7 0-1.4 1.3-1.9 2.6-1.9 1.2 0 2.6.6 2.6 1.5 0 .4-.3.7-.7.7-.8 0-.6-1-2-1-.7 0-1 .3-1 .7 0 .3.2.5.8.6l1.5.4c1.3.3 1.6 1 1.6 1.7 0 1.2-1 2-2.7 2z"/></svg>',
        granola: '<svg viewBox="0 0 24 24" class="w-6 h-6" fill="none"><circle cx="12" cy="12" r="10" fill="#7C3AED"/><path fill="white" d="M8 8h8v2H8zm0 3h8v2H8zm0 3h5v2H8z"/></svg>',
        otter: '<svg viewBox="0 0 24 24" class="w-6 h-6" fill="none"><circle cx="12" cy="12" r="10" fill="#0EA5E9"/><path fill="white" d="M8 10a4 4 0 018 0v2a4 4 0 01-8 0v-2zm2 0v2a2 2 0 004 0v-2a2 2 0 00-4 0zm-1 8c0-1.1 1.3-2 3-2s3 .9 3 2H9z"/></svg>',
        instantly: '<svg viewBox="0 0 24 24" class="w-6 h-6"><rect width="24" height="24" rx="5" fill="#FF6B35"/><path fill="white" d="M13 4l-8 10h7l-2 6 9-10h-7l1-6z"/></svg>',
        salesforge: '<svg viewBox="0 0 24 24" class="w-6 h-6"><rect width="24" height="24" rx="5" fill="#8B5CF6"/><path fill="white" d="M7 14c0-1.7 1.3-3 3-3h4a1 1 0 000-2H9V7h5a3 3 0 010 6h-4a1 1 0 000 2h6v2H10a3 3 0 01-3-3z"/></svg>',
        hubspot: '<svg viewBox="0 0 24 24" class="w-6 h-6"><circle cx="12" cy="12" r="12" fill="#FF7A59"/><path fill="white" d="M13.5 8.5V6.3a1.5 1.5 0 10-3 0V8.5A4 4 0 008 12a4 4 0 002.5 3.7V18h3v-2.3A4 4 0 0016 12a4 4 0 00-2.5-3.5z"/></svg>',
        salesforce: '<svg viewBox="0 0 24 24" class="w-6 h-6"><ellipse cx="12" cy="12" rx="11" ry="8" fill="#00A1E0"/><path fill="white" d="M8.5 10h2v4h-2zm2.5-2a1 1 0 110-2 1 1 0 010 2zm2.5 2h2v4h-2zm3-1h2v5h-2z"/></svg>',
        monday: '<svg viewBox="0 0 24 24" class="w-6 h-6"><rect width="24" height="24" rx="5" fill="#FF3D57"/><ellipse cx="7" cy="12" rx="2.5" ry="3.5" fill="#FF7F00"/><ellipse cx="12" cy="12" rx="2.5" ry="3.5" fill="#FFCB00"/><ellipse cx="17" cy="12" rx="2.5" ry="3.5" fill="#00CA72"/></svg>',
        gohighlevel: '<svg viewBox="0 0 24 24" class="w-6 h-6"><rect width="24" height="24" rx="5" fill="#16A34A"/><path fill="white" d="M6 16l4-8 3 5 2-3 3 6H6z"/></svg>',
      };
      return logos[key] || '<svg viewBox="0 0 24 24" class="w-6 h-6" fill="none" stroke="#71717a" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
    },

    timeAgo(ts) {
      if (!ts) return '';
      const d = Date.now() - new Date(ts).getTime();
      if (d < 60000) return 'just now';
      if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
      if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
      return Math.floor(d / 86400000) + 'd ago';
    },

    fmtUptime(seconds) {
      if (typeof seconds !== 'number') return '—';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
      if (h > 0) return h + 'h ' + m + 'm';
      return m + 'm';
    },

    activityLabel(item) {
      if (item.type === 'hot_lead') return 'Replied as interested';
      if (item.type === 'replied') return 'Replied' + (item.classification ? ': ' + String(item.classification).replace(/_/g, ' ') : '');
      if (item.type === 'blocked') return 'Blocked by quality gate' + (item.reason ? ': ' + item.reason : '');
      return 'Message sent';
    },

    classificationLabel(c) {
      return c ? String(c).replace(/_/g, ' ') : '';
    },

    stageColor(stage) {
      const m = {
        interested: 'bg-orange-500/15 text-orange-400 border-orange-500/20',
        replied: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
        follow_up: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
        outreach_sent: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/20',
        identified: 'bg-zinc-800 text-zinc-400 border-zinc-700',
        meeting_link_sent: 'bg-teal-500/15 text-teal-400 border-teal-500/20',
        meeting_booked: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
        handed_off: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/15',
        not_interested: 'bg-red-500/15 text-red-400 border-red-500/20',
        unsubscribed: 'bg-zinc-800 text-zinc-600 border-zinc-700',
      };
      return m[stage] || 'bg-zinc-800 text-zinc-500 border-zinc-700';
    },

    stageLabel(stage) {
      const m = {
        interested: 'Hot lead', replied: 'Replied', follow_up: 'Follow-up',
        outreach_sent: 'Contacted', identified: 'New', meeting_link_sent: 'Link sent',
        meeting_booked: 'Meeting set',
        handed_off: 'Handed off', not_interested: 'Not interested', unsubscribed: 'Unsubscribed',
      };
      return m[stage] || stage;
    },

    campaignStatusColor(status) {
      const m = {
        active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        paused: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
        draft: 'bg-zinc-800 text-zinc-400 border-zinc-700',
        completed: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        archived: 'bg-zinc-800 text-zinc-600 border-zinc-700',
      };
      return m[status] || 'bg-zinc-800 text-zinc-400 border-zinc-700';
    },
  };
}
