import { NewsItem } from '@/types'
import ImpactBadge from './ImpactBadge'
import ConfidenceBadge from './ConfidenceBadge'
import HelpIcon from './HelpIcon'

interface FeedItemProps {
  item: NewsItem
}

export default function FeedItem({ item }: FeedItemProps) {
  // Format time as HH:MM
  const formatTime = (isoString: string) => {
    const date = new Date(isoString)
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    })
  }

  // Get first source domain
  const getFirstSourceDomain = (sources: string[]) => {
    if (sources.length === 0) return 'Unknown'
    try {
      const url = new URL(sources[0])
      return url.hostname.replace('www.', '')
    } catch {
      return sources[0]
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center flex-wrap gap-2 min-w-0">
          <span className="text-sm text-gray-500 font-mono flex-shrink-0">
            [{formatTime(item.published_at)}]
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <ConfidenceBadge confidence={item.confidence} />
            <ImpactBadge impact={item.impact} />
            <HelpIcon />
          </div>
        </div>
      </div>
      
      <h3 className="text-lg font-semibold text-gray-900 mb-2">
        {item.headline}
      </h3>
      
      <p className="text-gray-700 mb-3">
        {item.why}
      </p>
      
      <div className="flex items-center justify-between text-sm text-gray-500">
        <div className="flex items-center flex-wrap gap-4 min-w-0">
          <span className="flex-shrink-0">Source: {getFirstSourceDomain(item.sources)}</span>
          {item.tickers.length > 0 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <span>Tickers:</span>
              <div className="flex gap-1">
                {item.tickers.slice(0, 3).map((ticker) => (
                  <span key={ticker} className="px-1.5 py-0.5 bg-gray-100 rounded text-xs">
                    {ticker}
                  </span>
                ))}
                {item.tickers.length > 3 && (
                  <span className="text-xs">+{item.tickers.length - 3} more</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
