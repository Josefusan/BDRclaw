/**
 * CRM adapter interface.
 *
 * Each CRM integration implements CRMAdapter and self-registers via registerCRM().
 * The BDR brain calls push() on every stage change and pull() on startup.
 */

import type { BDRProspect, ProspectStage } from '../bdr-types.js';

export interface CRMContact {
  external_id: string;
  email?: string;
  linkedin_url?: string;
  phone?: string;
  name?: string;
  company?: string;
  title?: string;
  crm_stage?: string; // the CRM's own stage label
  raw?: unknown; // full CRM response for debugging
}

export type CRMEventType =
  | 'stage_change'
  | 'touch_sent'
  | 'reply_received'
  | 'meeting_booked'
  | 'enrolled_in_campaign';

export interface CRMEvent {
  type: CRMEventType;
  prospect: BDRProspect;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface CRMAdapter {
  readonly name: string;

  /** Push a prospect event to the CRM (stage change, touch sent, etc.) */
  push(event: CRMEvent): Promise<void>;

  /** Pull new/updated contacts from the CRM for import into BDRclaw */
  pull(): Promise<CRMContact[]>;

  /** Map a BDRclaw ProspectStage to the CRM's own stage vocabulary */
  mapStage(stage: ProspectStage): string;

  /** Optional health check — returns true if credentials are valid */
  healthCheck?(): Promise<boolean>;
}
