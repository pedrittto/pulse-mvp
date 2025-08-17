import { NewsItem } from '@/types'
import ImpactBadge from './ImpactBadge'
import ConfidenceBadge from './ConfidenceBadge'
import HelpIcon from './HelpIcon'
import { pickArrival, formatRelativeTime } from '@/lib/time'
import { sentenceCase, shouldShowDescription } from '@/lib/text'
import { config } from '@/lib/config'
import { memo, useMemo } from 'react'
import { useTime } from '@/lib/timeContext'

interface FeedItemProps {
  item: NewsItem & {
    // Normalized fields from API route
    impactCategory?: string | null;
    impactScore?: number | null;
    verificationState?: string | null;
    confidenceState?: 'unconfirmed' | 'reported' | 'corroborated' | 'verified' | 'confirmed' | null;
  }
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

  // Verification badge not used for confidence display anymore

  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 hover:bg-neutral-900 transition-colors p-4 shadow-lg shadow-black/20">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center flex-wrap gap-2 min-w-0">
          <span className="text-sm text-neutral-400 font-mono flex-shrink-0">
            {timeText}
          </span>
          {item.breaking && (
            <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border border-neutral-700 bg-neutral-800/80 text-neutral-200">
              BREAKING
            </span>
          )}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Show confidence_state badge */}
            {item.confidenceState ? (
              <ConfidenceBadge confidence={item.confidenceState as any} className="inline-flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-800/80 px-2 py-0.5 text-xs text-neutral-200" />
            ) : (
              <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border border-neutral-700 bg-neutral-800/80 text-neutral-200">
                Confidence Unknown
              </span>
            )}
            
            {/* Show impact badge if category is available */}
            {item.impactCategory ? (
              <ImpactBadge 
                impact={{ 
                  category: item.impactCategory as any, 
                  score: item.impactScore || 0 
                }} 
                className="inline-flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-800/80 px-2 py-0.5 text-xs text-neutral-200"
              />
            ) : (
              <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border border-neutral-700 bg-neutral-800/80 text-neutral-200">
                Impact Unknown
              </span>
            )}
            <HelpIcon />
          </div>
        </div>
      </div>
      
      <h3 className="text-lg font-semibold text-neutral-50 mb-2">
        {processedHeadline}
      </h3>
      
      {shouldShowDesc && (
        <p className="text-neutral-300 mb-3">
          {item.why}
        </p>
      )}
      
      <div className="flex items-center justify-between text-sm text-neutral-400">
        <div className="flex items-center flex-wrap gap-4 min-w-0">
          <span className="flex-shrink-0">Source: {getFirstSourceDomain(item.sources)}</span>
          {item.tickers.length > 0 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <span>Tickers:</span>
              <div className="flex gap-1">
                {item.tickers.slice(0, 3).map((ticker) => (
                  <span key={ticker} className="px-1.5 py-0.5 bg-neutral-800 rounded text-xs">
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
