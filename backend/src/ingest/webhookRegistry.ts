import type { WebhookAdapter } from './webhookAdapters/types';
import { prnewswireAdapter } from './webhookAdapters/prnewswireAdapter';
import { globenewswireAdapter } from './webhookAdapters/globenewswireAdapter';
import { businesswireAdapter } from './webhookAdapters/businesswireAdapter';

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


