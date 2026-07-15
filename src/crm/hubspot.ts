/**
 * HubSpot CRM adapter.
 *
 * Setup:
 *   1. HubSpot → Settings → Integrations → Private Apps → Create app
 *   2. Scopes: crm.objects.contacts.read, crm.objects.contacts.write,
 *              crm.objects.deals.read, crm.objects.deals.write,
 *              timeline (for activity events)
 *   3. Copy the access token → set HUBSPOT_ACCESS_TOKEN in .env
 *   4. Optional: set HUBSPOT_PIPELINE_ID and HUBSPOT_STAGE_MAP_* vars to
 *      control which deal pipeline/stage BDRclaw stages map to.
 *
 * Self-registers when HUBSPOT_ACCESS_TOKEN is set.
 *
 * Two-way sync:
 *   Outbound: stage changes create/update a HubSpot contact and add a timeline event
 *   Inbound:  pull() fetches contacts created/modified in the last 24h
 */

import https from 'https';

import { logger } from '../logger.js';
import type { ProspectStage } from '../bdr-types.js';
import { registerCRM } from './registry.js';
import type { CRMAdapter, CRMContact, CRMEvent } from './types.js';

// Default stage mapping — override via env vars HUBSPOT_STAGE_<STAGE>=<hubspot-stage-id>
const DEFAULT_STAGE_MAP: Record<ProspectStage, string> = {
  identified: 'appointmentscheduled',
  outreach_sent: 'appointmentscheduled',
  follow_up: 'qualifiedtobuy',
  replied: 'presentationscheduled',
  interested: 'decisionmakerboughtin',
  meeting_link_sent: 'decisionmakerboughtin',
  meeting_booked: 'contractsent',
  handed_off: 'closedwon',
  not_interested: 'closedlost',
  unsubscribed: 'closedlost',
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

function hubspotRequest<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: 'api.hubapi.com',
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
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HubSpot API ${res.statusCode}: ${data}`));
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

// ── HubSpot Adapter ───────────────────────────────────────────────────────────

class HubSpotAdapter implements CRMAdapter {
  readonly name = 'hubspot';

  constructor(private readonly token: string) {}

  mapStage(stage: ProspectStage): string {
    const envKey = `HUBSPOT_STAGE_${stage.toUpperCase()}`;
    return (
      process.env[envKey] ?? DEFAULT_STAGE_MAP[stage] ?? 'appointmentscheduled'
    );
  }

  async push(event: CRMEvent): Promise<void> {
    const { prospect } = event;

    // Upsert contact by email (or linkedin_url as fallback)
    const properties: Record<string, string> = {
      firstname: prospect.name.split(' ')[0] ?? '',
      lastname: prospect.name.split(' ').slice(1).join(' ') || '',
      company: prospect.company,
      jobtitle: prospect.title,
      ...(prospect.email ? { email: prospect.email } : {}),
      ...(prospect.phone ? { phone: prospect.phone } : {}),
      ...(prospect.linkedin_url
        ? { hs_linkedin_url: prospect.linkedin_url }
        : {}),
    };

    let contactId: string | undefined;
    try {
      if (prospect.email) {
        // Try to find existing contact by email
        const search = await hubspotRequest<{
          total: number;
          results: Array<{ id: string }>;
        }>('POST', '/crm/v3/objects/contacts/search', this.token, {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'email',
                  operator: 'EQ',
                  value: prospect.email,
                },
              ],
            },
          ],
          limit: 1,
        });
        contactId = search.results[0]?.id;
      }

      if (contactId) {
        await hubspotRequest(
          'PATCH',
          `/crm/v3/objects/contacts/${contactId}`,
          this.token,
          { properties },
        );
      } else {
        const created = await hubspotRequest<{ id: string }>(
          'POST',
          '/crm/v3/objects/contacts',
          this.token,
          { properties },
        );
        contactId = created.id;
      }

      // Add timeline event for visibility in the contact's activity feed
      await hubspotRequest('POST', '/crm/v3/timeline/events', this.token, {
        eventTemplateId: process.env.HUBSPOT_EVENT_TEMPLATE_ID ?? undefined,
        objectId: contactId,
        tokens: {
          bdrclaw_event: event.type,
          bdrclaw_stage: prospect.stage,
        },
        timestamp: event.timestamp,
      }).catch(() => {
        // Timeline events require a custom event template; skip if not configured
      });
    } catch (err) {
      logger.warn({ err, prospectId: prospect.id }, 'HubSpot push failed');
      throw err;
    }

    logger.info(
      { contactId, prospectId: prospect.id, event: event.type },
      'HubSpot contact synced',
    );
  }

  async pull(): Promise<CRMContact[]> {
    // Fetch contacts updated in the last 24h
    const since = new Date(Date.now() - 86_400_000).toISOString();

    const result = await hubspotRequest<{
      results: Array<{
        id: string;
        properties: {
          email?: string;
          firstname?: string;
          lastname?: string;
          company?: string;
          jobtitle?: string;
          phone?: string;
          hs_linkedin_url?: string;
          lifecyclestage?: string;
        };
      }>;
    }>('POST', '/crm/v3/objects/contacts/search', this.token, {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'lastmodifieddate',
              operator: 'GTE',
              value: since,
            },
          ],
        },
      ],
      properties: [
        'email',
        'firstname',
        'lastname',
        'company',
        'jobtitle',
        'phone',
        'hs_linkedin_url',
        'lifecyclestage',
      ],
      limit: 100,
    });

    return result.results.map((r) => ({
      external_id: r.id,
      email: r.properties.email,
      phone: r.properties.phone,
      linkedin_url: r.properties.hs_linkedin_url,
      name:
        [r.properties.firstname, r.properties.lastname]
          .filter(Boolean)
          .join(' ') || undefined,
      company: r.properties.company,
      title: r.properties.jobtitle,
      crm_stage: r.properties.lifecyclestage,
      raw: r,
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await hubspotRequest(
        'GET',
        '/crm/v3/objects/contacts?limit=1',
        this.token,
      );
      return true;
    } catch {
      return false;
    }
  }
}

// ── Self-registration ─────────────────────────────────────────────────────────

const token = process.env.HUBSPOT_ACCESS_TOKEN;
if (token) {
  registerCRM(new HubSpotAdapter(token));
} else {
  logger.debug('HubSpot: HUBSPOT_ACCESS_TOKEN not set — adapter disabled');
}
