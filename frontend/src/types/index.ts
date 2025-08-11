export type Impact = "L" | "M" | "H";

export interface NewsItem {
  id: string;
  thread_id: string;
  headline: string;
  why: string;
  description?: string;
  sources: string[];
  tickers: string[];
  published_at: string; // ISO string
  ingested_at: string; // ISO string
  impact: Impact;
  confidence: number; // 0-100
  primary_entity?: string;
  image_url?: string;
}

export interface FeedResponse {
  items: NewsItem[];
  total: number;
}

export interface Watchlist {
  user_id: string;
  tickers: string[];
  keywords: string[];
  min_confidence: number;
  min_impact: Impact;
  quiet_hours?: {
    start: string;
    end: string;
  };
}

export type FilterType = 'all' | 'market-moving' | 'macro' | 'my';
