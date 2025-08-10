import { NewsItem } from '@/types'

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

  // Format impact display
  const getImpactDisplay = (impact: string) => {
    switch (impact) {
      case 'L': return 'Low'
      case 'M': return 'Medium'
      case 'H': return 'High'
      default: return impact
    }
  }

  // Get impact color
  const getImpactColor = (impact: string) => {
    switch (impact) {
      case 'L': return 'text-green-600 bg-green-50'
      case 'M': return 'text-yellow-600 bg-yellow-50'
      case 'H': return 'text-red-600 bg-red-50'
      default: return 'text-gray-600 bg-gray-50'
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center space-x-3">
          <span className="text-sm text-gray-500 font-mono">
            [{formatTime(item.published_at)}]
          </span>
          <span className="text-sm text-gray-600">
            {item.confidence}% confidence
          </span>
          <span className={`px-2 py-1 rounded text-xs font-medium ${getImpactColor(item.impact)}`}>
            {getImpactDisplay(item.impact)} Impact
          </span>
        </div>
      </div>
      
      <h3 className="text-lg font-semibold text-gray-900 mb-2">
        {item.headline}
      </h3>
      
      <p className="text-gray-700 mb-3">
        {item.why}
      </p>
      
      <div className="flex items-center justify-between text-sm text-gray-500">
        <div className="flex items-center space-x-4">
          <span>Source: {getFirstSourceDomain(item.sources)}</span>
          {item.tickers.length > 0 && (
            <div className="flex items-center space-x-1">
              <span>Tickers:</span>
              <div className="flex space-x-1">
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
