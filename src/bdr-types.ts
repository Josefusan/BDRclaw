// BDR-specific types for BDRclaw
// Core messaging/channel types live in types.ts — this file is BDR-domain only.

export type ProspectStage =
  | 'identified'
  | 'outreach_sent'
  | 'follow_up'
  | 'replied'
  | 'interested'
  | 'meeting_booked'
  | 'handed_off'
  | 'not_interested'
  | 'unsubscribed';

export const PROSPECT_STAGES: ProspectStage[] = [
  'identified',
  'outreach_sent',
  'follow_up',
  'replied',
  'interested',
  'meeting_booked',
  'handed_off',
  'not_interested',
  'unsubscribed',
];

export const ACTIVE_STAGES: ProspectStage[] = [
  'identified',
  'outreach_sent',
  'follow_up',
  'replied',
  'interested',
];

export type AccountType = 'gmail' | 'outlook' | 'linkedin';
export type AccountStatus = 'active' | 'paused' | 'error' | 'unconfigured';
export type TouchChannel = 'email' | 'linkedin' | 'sms' | 'slack';
export type TouchDirection = 'outbound' | 'inbound';
export type TouchStatus = 'sent' | 'delivered' | 'opened' | 'clicked' | 'replied' | 'bounced';

export type ProspectSource =
  | 'manual'
  | 'csv_import'
  | 'linkedin'
  | 'inbound_form'
  | 'inbound_email';

export type ReplyClassification =
  | 'interested'
  | 'not_now'
  | 'referral'
  | 'not_interested'
  | 'unsubscribe'
  | 'question'
  | 'out_of_office';

export type ActionType =
  | 'send_email'
  | 'linkedin_connect'
  | 'linkedin_dm'
  | 'send_sms'
  | 'enrich'
  | 'update_crm'
  | 'notify_closer'
  | 'classify_reply'
  | 'send_meeting_link'
  | 'wait';

// ── Account ──────────────────────────────────────────────────────────────────

export interface BDRAccount {
  id: string;
  type: AccountType;
  name: string;
  email?: string;
  credentials_key?: string; // key prefix in .env (e.g. GMAIL_ACCOUNT_1)
  status: AccountStatus;
  daily_send_limit: number;
  sends_today: number;
  last_reset_date?: string; // ISO date string YYYY-MM-DD
  created_at: string;
}

// ── Prospect ─────────────────────────────────────────────────────────────────

export interface BDRProspect {
  id: string; // slug: "john-smith-acme"
  name: string;
  email?: string;
  linkedin_url?: string;
  phone?: string;
  company: string;
  title: string;
  stage: ProspectStage;
  assigned_account_id?: string;
  source: ProspectSource;
  enrichment?: string; // JSON string
  tags?: string; // JSON array string
  created_at: string;
  updated_at: string;
  last_touch_at?: string;
  next_action_at?: string;
  next_action_type?: ActionType;
}

// ── Touch (outreach event) ────────────────────────────────────────────────────

export interface BDRTouch {
  id: string;
  prospect_id: string;
  account_id?: string;
  channel: TouchChannel;
  direction: TouchDirection;
  subject?: string;
  content: string;
  status: TouchStatus;
  sent_at: string;
  reply_classification?: ReplyClassification;
}

// ── BDR Brain Run ─────────────────────────────────────────────────────────────

export interface BDRBrainRun {
  id?: number;
  run_at: string;
  duration_ms?: number;
  prospects_reviewed: number;
  actions_queued: number;
  hot_leads_found: number;
  meetings_booked: number;
  status: 'running' | 'completed' | 'error';
  summary?: string;
  error?: string;
}

// ── Import Job ────────────────────────────────────────────────────────────────

export interface ImportJob {
  id: string;
  filename: string;
  source: 'csv' | 'excel';
  status: 'pending' | 'processing' | 'completed' | 'error';
  total_rows: number;
  imported_rows: number;
  error?: string;
  created_at: string;
  completed_at?: string;
}

// ── Pipeline Stats (for dashboard API) ───────────────────────────────────────

export interface PipelineStats {
  total_active: number;
  by_stage: Record<string, number>;
  hot_leads: number;
  meetings_booked_total: number;
  today: {
    emails_sent: number;
    linkedin_connects: number;
    sms_sent: number;
    replies_received: number;
  };
  brain_last_run?: {
    run_at: string;
    status: string;
    prospects_reviewed: number;
    actions_queued: number;
    hot_leads_found: number;
  };
}
