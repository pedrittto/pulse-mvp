export type Impact = "L" | "M" | "H" | "C";

export type VerificationStatus = "verified" | "confirmed" | "reported" | "unconfirmed";

// New structure for Breaking Mode, Verification V1, and Impact V3
export interface VerificationV1 {
  state: VerificationStatus;
  evidence?: {
    sources: string[];
    confirmations?: number;
    max_tier?: number;
    reason?: string;
  };
}

export type ConfidenceState = 'unconfirmed' | 'reported' | 'corroborated' | 'verified' | 'confirmed';

export interface ImpactV3 {
  score: number; // 0-100
  category: Impact;
  drivers?: Array<{
    name: string;
    value: number;
    details?: any;
  }>;
}

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
  arrival_at?: string; // ISO string - alias of ingested_at
  
  // Breaking Mode: true for fresh stubs
  breaking?: boolean;
  
  // Impact V3 structure
  impact?: ImpactV3;
  
  // Verification V1 structure
  verification?: VerificationV1;
  
  // New confidence state (categorical)
  confidence_state?: ConfidenceState;
  
  // Legacy fields (kept for backward compatibility)
  impact_score?: number; // 0-100
  verification_legacy?: VerificationStatus; // Old verification field
  
  // Normalized fields from API route (for consistent UI consumption)
  impactCategory?: string | null; // Normalized impact category (L/M/H/C)
  impactScore?: number | null;   // Normalized impact score (0-100)
  verificationState?: string | null; // Normalized verification state
  confidenceState?: ConfidenceState | null; // Normalized confidence state
  
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
  min_confidence: number; // Legacy; consider migrating to confidence_state filters
  min_impact: Impact;
  quiet_hours?: {
    start: string;
    end: string;
  };
}

export type FilterType = 'all' | 'market-moving' | 'macro' | 'my';
