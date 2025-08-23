export function getSharedSecret(provider: string): string | null {
	const p = String(provider || '').toLowerCase();
	if (p === 'prnewswire') return process.env.WEBHOOK_SHARED_SECRET_PRNEWSWIRE || null;
	if (p === 'globenewswire') return process.env.WEBHOOK_SHARED_SECRET_GLOBENEWSWIRE || null;
	if (p === 'businesswire') return process.env.WEBHOOK_SHARED_SECRET_BUSINESSWIRE || null;
	return null;
}


