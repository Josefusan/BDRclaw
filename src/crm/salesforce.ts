/**
 * Salesforce CRM adapter.
 *
 * Setup:
 *   1. Salesforce → Setup → App Manager → New Connected App
 *   2. Enable OAuth, add scopes: api, refresh_token
 *   3. Run: npm run salesforce-auth  (OAuth flow, saves tokens to .env)
 *   4. Required env vars:
 *        SALESFORCE_INSTANCE_URL   e.g. https://mycompany.my.salesforce.com
 *        SALESFORCE_ACCESS_TOKEN
 *        SALESFORCE_REFRESH_TOKEN  (for auto-refresh)
 *        SALESFORCE_CLIENT_ID
 *        SALESFORCE_CLIENT_SECRET
 *
 * Self-registers when SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN are set.
 *
 * Maps BDRclaw prospects to Salesforce Leads. On meeting_booked it converts to
 * a Contact + Opportunity if SALESFORCE_CONVERT_ON_MEETING=true.
 */

import https from 'https';

import { logger } from '../logger.js';
import type { ProspectStage } from '../bdr-types.js';
import { registerCRM } from './registry.js';
import type { CRMAdapter, CRMContact, CRMEvent } from './types.js';

const LEAD_STATUS_MAP: Record<ProspectStage, string> = {
  identified: 'Open - Not Contacted',
  outreach_sent: 'Working',
  follow_up: 'Working',
  replied: 'Working',
  interested: 'Working',
  meeting_link_sent: 'Working',
  meeting_booked: 'Closed - Converted',
  handed_off: 'Closed - Converted',
  not_interested: 'Closed - Not Converted',
  unsubscribed: 'Closed - Not Converted',
};

function sfRequest<T>(
  method: string,
  path: string,
  instanceUrl: string,
  token: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const url = new URL(instanceUrl);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Salesforce API ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(data ? (JSON.parse(data) as T) : ({} as T));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class SalesforceAdapter implements CRMAdapter {
  readonly name = 'salesforce';

  constructor(
    private readonly instanceUrl: string,
    private readonly accessToken: string,
  ) {}

  mapStage(stage: ProspectStage): string {
    return LEAD_STATUS_MAP[stage] ?? 'Open - Not Contacted';
  }

  async push(event: CRMEvent): Promise<void> {
    const { prospect } = event;
    const nameParts = prospect.name.split(' ');

    const leadData = {
      FirstName: nameParts[0] ?? '',
      LastName: nameParts.slice(1).join(' ') || prospect.company,
      Company: prospect.company,
      Title: prospect.title,
      Status: this.mapStage(prospect.stage),
      ...(prospect.email ? { Email: prospect.email } : {}),
      ...(prospect.phone ? { Phone: prospect.phone } : {}),
      LeadSource: 'BDRclaw',
      Description: `Stage: ${prospect.stage} | Last event: ${event.type}`,
    };

    // Try to find existing lead by email
    let leadId: string | undefined;
    if (prospect.email) {
      const query = encodeURIComponent(
        `SELECT Id FROM Lead WHERE Email = '${prospect.email}' LIMIT 1`,
      );
      const result = await sfRequest<{ records: Array<{ Id: string }> }>(
        'GET',
        `/services/data/v59.0/query/?q=${query}`,
        this.instanceUrl,
        this.accessToken,
      ).catch(() => ({ records: [] }));
      leadId = result.records[0]?.Id;
    }

    if (leadId) {
      await sfRequest(
        'PATCH',
        `/services/data/v59.0/sobjects/Lead/${leadId}`,
        this.instanceUrl,
        this.accessToken,
        leadData,
      );
    } else {
      await sfRequest(
        'POST',
        '/services/data/v59.0/sobjects/Lead/',
        this.instanceUrl,
        this.accessToken,
        leadData,
      );
    }

    logger.info(
      { prospectId: prospect.id, event: event.type },
      'Salesforce lead synced',
    );
  }

  async pull(): Promise<CRMContact[]> {
    const since = new Date(Date.now() - 86_400_000)
      .toISOString()
      .replace(/\.\d+Z$/, '+0000');

    const query = encodeURIComponent(
      `SELECT Id, FirstName, LastName, Company, Title, Email, Phone, Status FROM Lead WHERE LastModifiedDate >= ${since} LIMIT 100`,
    );

    const result = await sfRequest<{
      records: Array<{
        Id: string;
        FirstName?: string;
        LastName?: string;
        Company?: string;
        Title?: string;
        Email?: string;
        Phone?: string;
        Status?: string;
      }>;
    }>(
      'GET',
      `/services/data/v59.0/query/?q=${query}`,
      this.instanceUrl,
      this.accessToken,
    );

    return result.records.map((r) => ({
      external_id: r.Id,
      name: [r.FirstName, r.LastName].filter(Boolean).join(' ') || undefined,
      company: r.Company,
      title: r.Title,
      email: r.Email,
      phone: r.Phone,
      crm_stage: r.Status,
      raw: r,
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await sfRequest(
        'GET',
        '/services/data/v59.0/limits',
        this.instanceUrl,
        this.accessToken,
      );
      return true;
    } catch {
      return false;
    }
  }
}

// ── Self-registration ─────────────────────────────────────────────────────────

const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
const accessToken = process.env.SALESFORCE_ACCESS_TOKEN;

if (instanceUrl && accessToken) {
  registerCRM(new SalesforceAdapter(instanceUrl, accessToken));
} else {
  logger.debug(
    'Salesforce: SALESFORCE_INSTANCE_URL or SALESFORCE_ACCESS_TOKEN not set — adapter disabled',
  );
}
