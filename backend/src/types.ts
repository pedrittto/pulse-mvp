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
  sources: string[];
  tickers: string[];
  published_at: string; // ISO string
  ingested_at: string; // ISO string
  arrival_at?: string; // ISO string - alias of ingested_at for API compatibility
  
  // Breaking Mode: true for fresh stubs
  breaking?: boolean;
  
  // Impact V3 structure
  impact?: ImpactV3;
  
  // Verification V1 structure
  verification?: VerificationV1;
  
  // New confidence state (categorical)
  confidence_state?: 'unconfirmed' | 'reported' | 'corroborated' | 'verified' | 'confirmed';
  
  // Legacy fields (kept for backward compatibility - to be removed)
  impact_score?: number; // 0-100
  verification_legacy?: VerificationStatus; // Old verification field
  
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
