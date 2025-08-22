export interface NewsItemStub {
	headline: string;
	source: string;
	transport: string;
	published_at?: string;
	url?: string;
	tickers?: string[];
	confidence?: 'low'|'medium'|'high';
}

export interface WebhookAdapter {
	name: 'prnewswire'|'globenewswire'|'businesswire';
	detect(headers: Record<string,string>, body: string): boolean;
	extractId(headers: Record<string,string>, body: string): string | null;
	parse(headers: Record<string,string>, body: string): Promise<NewsItemStub>;
}


