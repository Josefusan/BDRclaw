/**
 * Monday.com CRM adapter.
 *
 * Setup:
 *   1. Monday.com → Avatar → Admin → API → Generate API key
 *   2. Create a board for prospects (or use an existing Sales CRM board)
 *   3. Set env vars:
 *        MONDAY_API_KEY    — personal API token
 *        MONDAY_BOARD_ID   — numeric board ID from the URL
 *
 * Column mapping (configure via env):
 *   MONDAY_COL_EMAIL      default: "email"
 *   MONDAY_COL_COMPANY    default: "text"     (or "company" on Sales CRM)
 *   MONDAY_COL_TITLE      default: "job_title"
 *   MONDAY_COL_PHONE      default: "phone"
 *   MONDAY_COL_STATUS     default: "status"
 *
 * Self-registers when MONDAY_API_KEY and MONDAY_BOARD_ID are set.
 */

import https from 'https';

import { logger } from '../logger.js';
import type { ProspectStage } from '../bdr-types.js';
import { registerCRM } from './registry.js';
import type { CRMAdapter, CRMContact, CRMEvent } from './types.js';

const STAGE_LABEL_MAP: Record<ProspectStage, string> = {
  identified: 'Identified',
  outreach_sent: 'Outreach Sent',
  follow_up: 'Following Up',
  replied: 'Replied',
  interested: 'Interested',
  meeting_booked: 'Meeting Booked',
  handed_off: 'Handed Off',
  not_interested: 'Not Interested',
  unsubscribed: 'Unsubscribed',
};

function mondayQuery<T>(
  apiKey: string,
  query: string,
  variables?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query, variables });
    const options: https.RequestOptions = {
      hostname: 'api.monday.com',
      path: '/v2',
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'API-Version': '2024-01',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) reject(new Error(JSON.stringify(parsed.errors)));
          else resolve(parsed.data as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

class MondayAdapter implements CRMAdapter {
  readonly name = 'monday';

  private readonly colEmail = process.env.MONDAY_COL_EMAIL ?? 'email';
  private readonly colCompany = process.env.MONDAY_COL_COMPANY ?? 'text';
  private readonly colTitle = process.env.MONDAY_COL_TITLE ?? 'job_title';
  private readonly colPhone = process.env.MONDAY_COL_PHONE ?? 'phone';
  private readonly colStatus = process.env.MONDAY_COL_STATUS ?? 'status';

  constructor(
    private readonly apiKey: string,
    private readonly boardId: string,
  ) {}

  mapStage(stage: ProspectStage): string {
    const envKey = `MONDAY_STAGE_${stage.toUpperCase()}`;
    return process.env[envKey] ?? STAGE_LABEL_MAP[stage] ?? 'Identified';
  }

  async push(event: CRMEvent): Promise<void> {
    const { prospect } = event;

    const columnValues = JSON.stringify({
      [this.colEmail]: prospect.email
        ? { email: prospect.email, text: prospect.email }
        : undefined,
      [this.colCompany]: prospect.company,
      [this.colTitle]: prospect.title,
      [this.colPhone]: prospect.phone
        ? { phone: prospect.phone, countryShortName: 'US' }
        : undefined,
      [this.colStatus]: { label: this.mapStage(prospect.stage) },
    });

    // Try to find item by email
    const search = await mondayQuery<{
      items_page_by_column_values: { items: Array<{ id: string }> };
    }>(
      this.apiKey,
      `
      query($board: ID!, $col: String!, $val: String!) {
        items_page_by_column_values(board_id: $board, columns: [{ column_id: $col, column_values: [$val] }], limit: 1) {
          items { id }
        }
      }
    `,
      { board: this.boardId, col: this.colEmail, val: prospect.email ?? '' },
    ).catch(() => ({
      items_page_by_column_values: { items: [] },
    }));

    const existingId = search.items_page_by_column_values.items[0]?.id;

    if (existingId) {
      await mondayQuery(
        this.apiKey,
        `
        mutation($board: ID!, $item: ID!, $values: JSON!) {
          change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values) { id }
        }
      `,
        { board: this.boardId, item: existingId, values: columnValues },
      );
    } else {
      await mondayQuery(
        this.apiKey,
        `
        mutation($board: ID!, $name: String!, $values: JSON!) {
          create_item(board_id: $board, item_name: $name, column_values: $values) { id }
        }
      `,
        { board: this.boardId, name: prospect.name, values: columnValues },
      );
    }

    logger.info(
      { prospectId: prospect.id, event: event.type },
      'Monday.com item synced',
    );
  }

  async pull(): Promise<CRMContact[]> {
    const result = await mondayQuery<{
      boards: Array<{
        items_page: {
          items: Array<{
            id: string;
            name: string;
            column_values: Array<{ id: string; text?: string; value?: string }>;
          }>;
        };
      }>;
    }>(
      this.apiKey,
      `
      query($board: ID!) {
        boards(ids: [$board]) {
          items_page(limit: 100) {
            items {
              id name
              column_values { id text value }
            }
          }
        }
      }
    `,
      { board: this.boardId },
    );

    const items = result.boards[0]?.items_page.items ?? [];
    return items.map((item) => {
      const colMap = Object.fromEntries(
        item.column_values.map((c) => [c.id, c.text ?? '']),
      );
      return {
        external_id: item.id,
        name: item.name,
        email: colMap[this.colEmail],
        company: colMap[this.colCompany],
        title: colMap[this.colTitle],
        phone: colMap[this.colPhone],
        crm_stage: colMap[this.colStatus],
        raw: item,
      };
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await mondayQuery(this.apiKey, '{ me { name } }');
      return true;
    } catch {
      return false;
    }
  }
}

// ── Self-registration ─────────────────────────────────────────────────────────

const apiKey = process.env.MONDAY_API_KEY;
const boardId = process.env.MONDAY_BOARD_ID;

if (apiKey && boardId) {
  registerCRM(new MondayAdapter(apiKey, boardId));
} else {
  logger.debug(
    'Monday.com: MONDAY_API_KEY or MONDAY_BOARD_ID not set — adapter disabled',
  );
}
