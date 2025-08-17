import { NewsItem } from '@/types'
import ImpactBadge from './ImpactBadge'
import ConfidenceBadge from './ConfidenceBadge'
import VerificationBadge from './VerificationBadge'
import HelpIcon from './HelpIcon'
import { pickArrival, formatRelativeTime } from '@/lib/time'
import { sentenceCase, shouldShowDescription } from '@/lib/text'
import { config } from '@/lib/config'
import { memo, useMemo } from 'react'
import { useTime } from '@/lib/timeContext'

interface FeedItemProps {
  item: NewsItem
}

function FeedItem({ item }: FeedItemProps) {
  // Use global time context for relative time updates
  const { tick } = useTime();
  
  // Get arrival time and format it as relative time - recalculates on global tick
  const timeText = useMemo(() => {
    const arrivalISO = pickArrival(item);
    return formatRelativeTime(arrivalISO);
  }, [item.arrival_at, item.ingested_at, item.published_at, tick]); // Include tick dependency
  
  // Process headline and description
  const processedHeadline = sentenceCase(item.headline);
  const shouldShowDesc = shouldShowDescription(processedHeadline, item.why);

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

  // Check if verification mode is enabled
  const isVerificationMode = config.verificationMode === 'v1' || item.verification;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center flex-wrap gap-2 min-w-0">
          <span className="text-sm text-gray-500 font-mono flex-shrink-0">
            {timeText}
          </span>
          {item.breaking && (
            <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-red-100 border border-red-200 text-red-700">
              BREAKING
            </span>
          )}
          <div className="flex items-center gap-2 flex-shrink-0">
            {isVerificationMode && item.verification ? (
              <VerificationBadge verification={item.verification} />
            ) : (
              <ConfidenceBadge confidence={item.confidence || 0} />
            )}
            {item.impact ? (
              <ImpactBadge impact={item.impact} />
            ) : (
              <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border border-gray-200 bg-gray-50 text-gray-700">
                Impact {item.impact_score || 0}
              </span>
            )}
            <HelpIcon />
          </div>
        </div>
      </div>
      
      <h3 className="text-lg font-semibold text-gray-900 mb-2">
        {processedHeadline}
      </h3>
      
      {shouldShowDesc && (
        <p className="text-gray-700 mb-3">
          {item.why}
        </p>
      )}
      
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

// Memoize the component to prevent unnecessary re-renders
export default memo(FeedItem);
