/**
 * Webhook registry — channels that need inbound HTTP webhooks register here.
 *
 * The web UI picks up all registered handlers and mounts them at /webhooks/<name>.
 * Channels call registerWebhook() at module load time (same self-registration
 * pattern as the channel registry).
 */

import type http from 'http';

export type WebhookHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
) => void | Promise<void>;

const registry = new Map<string, WebhookHandler>();

export function registerWebhook(path: string, handler: WebhookHandler): void {
  registry.set(path, handler);
}

export function getWebhookHandler(path: string): WebhookHandler | undefined {
  return registry.get(path);
}

export function getRegisteredWebhookPaths(): string[] {
  return [...registry.keys()];
}
