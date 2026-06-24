/**
 * CRM registry — same self-registration pattern as the channel registry.
 *
 * CRM adapters call registerCRM() at module load time. The BDR brain calls
 * getCRMAdapters() to get all active adapters and syncs prospect events to them.
 *
 * Usage:
 *   import './crm/hubspot.js';   // in src/index.ts — activates if HUBSPOT_* vars set
 *   import './crm/salesforce.js';
 */

import { logger } from '../logger.js';
import type { CRMAdapter, CRMEvent } from './types.js';

const adapters = new Map<string, CRMAdapter>();

export function registerCRM(adapter: CRMAdapter): void {
  adapters.set(adapter.name, adapter);
  logger.info({ crm: adapter.name }, 'CRM adapter registered');
}

export function getCRMAdapters(): CRMAdapter[] {
  return [...adapters.values()];
}

export function getCRMAdapter(name: string): CRMAdapter | undefined {
  return adapters.get(name);
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────
// Called by the BDR brain on every stage change or key event.

export async function pushToCRMs(event: CRMEvent): Promise<void> {
  const all = getCRMAdapters();
  if (all.length === 0) return;

  await Promise.allSettled(
    all.map((adapter) =>
      adapter
        .push(event)
        .catch((err) =>
          logger.warn({ err, crm: adapter.name }, 'CRM push failed'),
        ),
    ),
  );
}

export async function pullFromCRMs(): Promise<
  import('./types.js').CRMContact[]
> {
  const all = getCRMAdapters();
  const results = await Promise.allSettled(all.map((a) => a.pull()));
  return results
    .filter(
      (r): r is PromiseFulfilledResult<import('./types.js').CRMContact[]> =>
        r.status === 'fulfilled',
    )
    .flatMap((r) => r.value);
}
