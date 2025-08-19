import { publishStub } from './breakingIngest';

export async function pollTwitterStub(): Promise<void> {
	if (process.env.TWITTER_INGEST !== '1') return;
	try {
		await publishStub({
			title: 'Twitter stub placeholder',
			source: 'Twitter',
			url: 'https://twitter.com/placeholder',
			transport: 'adaptive'
		});
	} catch {}
}
