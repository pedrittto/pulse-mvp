import type { WebhookAdapter } from './webhookAdapters/types.js';
import { prnewswireAdapter } from './webhookAdapters/prnewswireAdapter.js';
import { globenewswireAdapter } from './webhookAdapters/globenewswireAdapter.js';
import { businesswireAdapter } from './webhookAdapters/businesswireAdapter.js';

const adapters: Record<string, WebhookAdapter> = {
	prnewswire: prnewswireAdapter,
	globenewswire: globenewswireAdapter,
	businesswire: businesswireAdapter,
};

export function getAdapter(provider: string): WebhookAdapter | null {
	const key = String(provider || '').toLowerCase();
	return adapters[key] || null;
}

export function listProviders(): string[] { return Object.keys(adapters); }


