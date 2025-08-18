'use client'

import FeedItem from '@/components/FeedItem'
import { NewsItem } from '@/types'

export default function E2eDemoPage() {
	const items: Array<NewsItem & { sourceUrl?: string | null }> = [
		{
			id: 'id-has-url',
			headline: 'Card With URL',
			why: 'desc',
			sources: ['https://example.com/source'],
			tickers: [],
			impact: { category: 'L', level: 'L', score: 40 } as any,
			impact_score: 40,
			confidence_state: 'reported' as any,
			published_at: new Date().toISOString(),
			arrival_at: new Date().toISOString(),
			sourceUrl: 'https://example.com/article'
		} as any,
		{
			id: 'id-no-url',
			headline: 'Card Without URL',
			why: 'desc',
			sources: ['bloomberg.com'],
			tickers: [],
			impact: { category: 'L', level: 'L', score: 40 } as any,
			impact_score: 40,
			confidence_state: 'reported' as any,
			published_at: new Date().toISOString(),
			arrival_at: new Date().toISOString(),
			sourceUrl: null
		} as any
	]

	return (
		<div className="max-w-3xl mx-auto p-4 space-y-4">
			{items.map(it => (
				<FeedItem key={it.id} item={it as any} />
			))}
		</div>
	)
}


