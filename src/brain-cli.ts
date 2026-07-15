/**
 * Standalone BDR Brain runner — `npm run brain`.
 *
 * Boots the same composition root as the main daemon (database + action
 * handlers via initCore), runs a single brain cycle, and exits. Running
 * runCycle() without initCore() would leave the action-handler map empty and
 * the brain would silently no-op (see bootstrap.ts).
 */

import { initCore } from './bootstrap.js';
import { runCycle } from './bdr-brain.js';
import { logger } from './logger.js';

initCore();

runCycle()
  .then(() => {
    logger.info('BDR Brain standalone cycle complete');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'BDR Brain standalone cycle failed');
    process.exit(1);
  });
