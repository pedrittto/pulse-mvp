import { NewsItem } from '@/types'
import ImpactBadge from './ImpactBadge'
import ConfidenceBadge from './ConfidenceBadge'
import HelpIcon from './HelpIcon'
import { pickArrival, formatHHMMLocal, freshnessLabel } from '@/lib/time'
import { cn } from '@/lib/utils'

interface FeedItemProps {
  item: NewsItem
}

export default function FeedItem({ item }: FeedItemProps) {
  // Get arrival time and format it
  const arrivalISO = pickArrival(item);
  const timeText = formatHHMMLocal(arrivalISO);
  const fr = freshnessLabel(item.published_at);

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
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{timeText}</span>
            <span title={fr.tooltip} className={cn(
              "px-2 py-0.5 rounded-md border",
              fr.level === 'flash' && "border-blue-200 bg-blue-50",
              fr.level === 'new' && "border-neutral-200 bg-neutral-50",
              fr.level === 'old' && "border-amber-200 bg-amber-50",
              fr.level === 'veryold' && "border-gray-200 bg-gray-50"
            )}>
              {fr.label}
            </span>
          </div>
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
