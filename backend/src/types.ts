export type Impact = "L" | "M" | "H" | "C";

export type VerificationStatus = "verified" | "confirmed" | "reported" | "unconfirmed";

export interface NewsItem {
  id: string;
  thread_id: string;
  headline: string;
  why: string;
  sources: string[];
  tickers: string[];
  published_at: string; // ISO string
  ingested_at: string; // ISO string
  arrival_at?: string; // ISO string - alias of ingested_at for API compatibility
  impact: Impact;
  impact_score: number; // 0-100
  confidence: number; // 0-100 (kept for backward compatibility)
  verification?: VerificationStatus; // New deterministic verification status
  primary_entity?: string;
  category?: string; // e.g., 'macro'
  version?: string; // Version for filtering (v2 = new pipeline)
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
