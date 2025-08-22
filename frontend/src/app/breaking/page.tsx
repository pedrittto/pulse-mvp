import BreakingKPIBar from '@/components/BreakingKPIBar'
import BreakingKPIDebug from '@/components/BreakingKPIDebug'
import { useBreakingFeed } from '@/lib/useBreakingFeed'
import FeedItem from '@/components/FeedItem'
import { API_BASE } from '@/lib/config'

export default function BreakingPage() {
  const apiBaseUrl = API_BASE
  const { data, error, isLoading } = useBreakingFeed(apiBaseUrl, 100)

  return (
    <div className="min-h-screen bg-transparent text-neutral-100">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <BreakingKPIBar apiBaseUrl={apiBaseUrl} />
        <BreakingKPIDebug apiBaseUrl={apiBaseUrl} />
        {isLoading && (
          <div className="text-neutral-400">Loading…</div>
        )}
        {error && (
          <div className="text-red-300">Failed to load Breaking feed</div>
        )}
        <div className="space-y-4">
          {(data || []).map((item: any) => {
            const uiItem = {
              title: item.headline,
              summary: item.why ?? '',
              publishedAt: item.published_at ?? '',
              imageUrl: item.image_url,
              source: item.sources?.[0],
              ticker: item.primary_entity,
              ...item
            }
            return <FeedItem key={item.id} item={uiItem} />
          })}
        </div>
      </div>
    </div>
  )
}


