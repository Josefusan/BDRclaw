/**
 * GoHighLevel (LeadConnector) CRM adapter.
 *
 * Setup:
 *   1. GoHighLevel → Settings → Private Integrations (or Agency API) → create token
 *      with contacts read/write scope
 *   2. Set env vars:
 *        GHL_API_KEY      — Private Integration / API bearer token
 *        GHL_LOCATION_ID  — the sub-account (location) ID contacts live in
 *
 * Self-registers when GHL_API_KEY and GHL_LOCATION_ID are BOTH set.
 *
 * Stage model:
 *   GoHighLevel has no first-class pipeline stage on contacts, so BDRclaw
 *   stages are carried as tags: every synced contact gets the 'bdrclaw' tag
 *   plus one 'bdrclaw-stage-<stage>' tag.
 *
 *   Outbound: push() upserts the contact via POST /contacts/upsert with the
 *   current stage tag. GHL's upsert merges tags with existing ones, so stale
 *   'bdrclaw-stage-*' tags can accumulate; when the upsert response returns
 *   the contact's tags, we remove stale stage tags via
 *   DELETE /contacts/{id}/tags. If the response omits tags, stage tags
 *   accumulate in GHL and pull() dedupes on read by picking the first
 *   'bdrclaw-stage-*' tag found.
 *
 *   Inbound: pull() fetches contacts for the location and maps them to
 *   CRMContact, deriving crm_stage from any 'bdrclaw-stage-*' tag.
 *
 * ISC-27 invariant: push()/pull() failures log a warning and never throw
 * into the caller — a CRM outage must not block stage changes.
 */

import { logger } from '../logger.js';
import type { ProspectStage } from '../bdr-types.js';
import { registerCRM } from './registry.js';
import type { CRMAdapter, CRMContact, CRMEvent } from './types.js';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';
const BDRCLAW_TAG = 'bdrclaw';
const STAGE_TAG_PREFIX = 'bdrclaw-stage-';

// ── GHL response shapes (only the fields we read) ────────────────────────────

interface GHLContact {
  id: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  contactName?: string;
  companyName?: string;
  tags?: string[];
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function ghlRequest<T>(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${GHL_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: GHL_API_VERSION,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GoHighLevel API ${res.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

// ── GoHighLevel Adapter ───────────────────────────────────────────────────────

class GoHighLevelAdapter implements CRMAdapter {
  readonly name = 'gohighlevel';

  constructor(
    private readonly apiKey: string,
    private readonly locationId: string,
  ) {}

  mapStage(stage: ProspectStage): string {
    return `${STAGE_TAG_PREFIX}${stage}`;
  }

  async push(event: CRMEvent): Promise<void> {
    const { prospect } = event;
    const stageTag = this.mapStage(prospect.stage);

    try {
      const result = await ghlRequest<{ contact?: GHLContact }>(
        'POST',
        '/contacts/upsert',
        this.apiKey,
        {
          locationId: this.locationId,
          ...(prospect.email ? { email: prospect.email } : {}),
          ...(prospect.phone ? { phone: prospect.phone } : {}),
          firstName: prospect.name.split(' ')[0] ?? '',
          lastName: prospect.name.split(' ').slice(1).join(' '),
          companyName: prospect.company,
          tags: [BDRCLAW_TAG, stageTag],
        },
      );

      // Replace the stage tag: if the upsert response exposes the contact's
      // full tag list, strip any stale bdrclaw-stage-* tags. If tags are not
      // returned, they accumulate in GHL and pull() dedupes on read.
      const contact = result.contact;
      const staleTags = (contact?.tags ?? []).filter(
        (t) => t.startsWith(STAGE_TAG_PREFIX) && t !== stageTag,
      );
      if (contact?.id && staleTags.length > 0) {
        await ghlRequest(
          'DELETE',
          `/contacts/${contact.id}/tags`,
          this.apiKey,
          { tags: staleTags },
        );
      }

      logger.info(
        { contactId: contact?.id, prospectId: prospect.id, event: event.type },
        'GoHighLevel contact synced',
      );
    } catch (err) {
      // ISC-27: CRM push failure must never block a stage change.
      logger.warn({ err, prospectId: prospect.id }, 'GoHighLevel push failed');
    }
  }

  async pull(): Promise<CRMContact[]> {
    try {
      const result = await ghlRequest<{ contacts?: GHLContact[] }>(
        'GET',
        `/contacts/?locationId=${encodeURIComponent(this.locationId)}&limit=100`,
        this.apiKey,
      );

      return (result.contacts ?? []).map((c) => {
        const stageTag = (c.tags ?? []).find((t) =>
          t.startsWith(STAGE_TAG_PREFIX),
        );
        return {
          external_id: c.id,
          email: c.email,
          phone: c.phone,
          name:
            [c.firstName, c.lastName].filter(Boolean).join(' ') ||
            c.contactName ||
            undefined,
          company: c.companyName,
          crm_stage: stageTag
            ? stageTag.slice(STAGE_TAG_PREFIX.length)
            : undefined,
          raw: c,
        };
      });
    } catch (err) {
      logger.warn({ err }, 'GoHighLevel pull failed');
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await ghlRequest(
        'GET',
        `/contacts/?locationId=${encodeURIComponent(this.locationId)}&limit=1`,
        this.apiKey,
      );
      return true;
    } catch {
      return false;
    }
  }
}

// ── Self-registration ─────────────────────────────────────────────────────────

const apiKey = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
if (apiKey && locationId) {
  registerCRM(new GoHighLevelAdapter(apiKey, locationId));
} else {
  logger.debug(
    'GoHighLevel: GHL_API_KEY and/or GHL_LOCATION_ID not set — adapter disabled',
  );
}
