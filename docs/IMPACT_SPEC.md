# Impact Scoring System Specification

## Executive Summary

The Impact scoring system in Pulse is a rule-based algorithm that assigns market impact categories (Low/Medium/High) to news items based on keyword matching, recency, ticker presence, and source credibility. The system operates on a 0-100 scale with three discrete buckets: Low (0-44), Medium (45-69), and High (70-100). Impact is computed independently of Confidence scoring, with no cross-system dependencies. The algorithm uses hardcoded keyword lists and additive scoring without normalization or calibration layers. Recent changes have focused on Confidence scoring (V2.1/V2.2) with no modifications to Impact logic in the past 2 weeks.

## 1. Impact Computation Locations

### Core Scoring Function
- **Primary**: `backend/src/utils/scoring.ts:scoreNews()` - Main scoring algorithm
- **Storage**: `backend/src/storage.ts:addNewsItems()` - Persistence with fallback scoring
- **Ingestion**: `backend/src/ingest/rss.ts:normalizeRSSItem()` - Initial scoring during RSS ingestion
- **API**: `backend/src/api.ts:/feed` - Debug rescoring when requested
- **Frontend**: `frontend/src/components/ImpactBadge.tsx` - Display mapping only

### No Experimental Versions
- **IMPACT_V2**: **NONE**
- **IMPACT_WEIGHTS_JSON**: **NONE**
- **Feature flags**: **NONE**

## 2. Data Flow

```
Raw RSS Item → normalizeRSSItem() → scoreNews() → addNewsItems() → Firestore → getNewsItems() → /feed API → ImpactBadge.tsx
     ↓              ↓                    ↓              ↓              ↓              ↓              ↓              ↓
  headline,     primary_entity      impact_score    persistence    retrieval     API response    impact prop    UI render
  description,  source mapping      impact: L/M/H   fallback       backfill      debug rescore   category       badge
  published_at  ticker extraction   confidence      scoring        scoring       if requested     mapping        display
```

**Exact locations:**
- RSS parsing: `backend/src/ingest/rss.ts:141`
- Scoring: `backend/src/utils/scoring.ts:19-220`
- Storage: `backend/src/storage.ts:81-82`
- API: `backend/src/api.ts:388`
- Frontend: `frontend/src/components/ImpactBadge.tsx:8-33`

## 3. Inputs / Features

### Text Features
- **headline** (string): Raw headline text, converted to lowercase
- **description** (string): Article description/body, converted to lowercase
- **text** (string): Concatenated `headline + description`

### Temporal Features
- **published_at** (ISO string): Article publication timestamp
- **hoursDiff** (number): Hours since publication, computed as `(now - published) / (1000 * 60 * 60)`

### Entity Features
- **tickers** (string[]): Array of stock tickers mentioned
- **tickers.length** (number): Count of tickers (0, 1, or 2+)

### Source Features
- **sources** (string[]): Array of source names
- **firstSource** (string): First source name, converted to lowercase

### Keyword Features
- **HIGH_IMPACT** (string[]): 18 hardcoded keywords
- **MEDIUM_IMPACT** (string[]): 11 hardcoded keywords  
- **MACRO_KEYWORDS** (string[]): 13 hardcoded keywords
- **OPINION_KEYWORDS** (string[]): 6 hardcoded keywords

### Defaults/Fallbacks
- **impact_score**: 20 (base score)
- **impact**: 'L' (Low category)
- **confidence**: 50 (base confidence)
- **tickers**: [] (empty array)
- **sources**: [] (empty array)

## 4. Exact Formula / Logic

### Step-by-Step Algorithm
```typescript
// 1. Initialize
let impact_score = 20; // Base score

// 2. Recency boost (based on hours since publication)
if (hoursDiff < 1) impact_score += 15;
else if (hoursDiff < 6) impact_score += 10;
else if (hoursDiff < 24) impact_score += 5;

// 3. Ticker signal
if (tickers.length === 1) impact_score += 10;
else if (tickers.length >= 2) impact_score += 15;

// 4. High impact keywords (first match only)
for (const keyword of HIGH_IMPACT) {
  if (text.includes(keyword)) {
    impact_score += 15;
    break;
  }
}

// 5. Medium impact keywords (first match only)
for (const keyword of MEDIUM_IMPACT) {
  if (text.includes(keyword)) {
    impact_score += 8;
    break;
  }
}

// 6. Macro keywords (first match only)
for (const keyword of MACRO_KEYWORDS) {
  if (text.includes(keyword)) {
    impact_score += 12;
    confidence += 5;
    tags.push('Macro');
    break;
  }
}

// 7. Source weight (first source only)
const SOURCE_W = { 'bloomberg': 6, 'reuters': 6, 'wsj': 5, 'ft': 5, 'cnbc': 3, 'marketwatch': 3, 'techcrunch': 2 };
for (const [source, weight] of Object.entries(SOURCE_W)) {
  if (firstSource.includes(source)) {
    impact_score += weight;
    confidence += weight;
    break;
  }
}

// 8. Clipping
impact_score = Math.max(0, Math.min(100, impact_score));

// 9. Category mapping
const impact = impact_score >= 70 ? 'H' : impact_score >= 45 ? 'M' : 'L';
```

### Constants and Weights
- **Base score**: 20
- **Recency weights**: 15 (1h), 10 (6h), 5 (24h)
- **Ticker weights**: 10 (1 ticker), 15 (2+ tickers)
- **Keyword weights**: 15 (high), 8 (medium), 12 (macro)
- **Source weights**: 6 (bloomberg/reuters), 5 (wsj/ft), 3 (cnbc/marketwatch), 2 (techcrunch)
- **Scaling domain**: 0-100 (integer)
- **No transforms**: Direct additive scoring, no normalization

## 5. Categories & Mapping

### Discrete Categories
- **Low (L)**: [0, 44] - `impact_score < 45`
- **Medium (M)**: [45, 69] - `45 <= impact_score < 70`
- **High (H)**: [70, 100] - `impact_score >= 70`

### Mapping Function
```typescript
// backend/src/utils/scoring.ts:220
const impact: 'L'|'M'|'H' = impact_score >= 70 ? 'H' : impact_score >= 45 ? 'M' : 'L';
```

### Frontend Color Mapping
```typescript
// frontend/src/components/ImpactBadge.tsx:8-33
case 'L': return { label: 'Low', classes: 'border-gray-200 bg-gray-50 text-gray-700' };
case 'M': return { label: 'Medium', classes: 'border-amber-200 bg-amber-50 text-amber-700' };
case 'H': return { label: 'High', classes: 'border-red-200 bg-red-50 text-red-700' };
```

### No Hard Floors/Ceilings
- No minimum category enforcement
- No maximum category caps
- No regulatory overrides

## 6. Coupling with Other Systems

### Independence from Confidence
- **Impact is independent** of Confidence scoring
- No cross-system dependencies or interactions
- No caps, multipliers, or gates based on Confidence
- Both systems operate on separate scales (0-100 for both)

### No Recency Suppression
- No logic that suppresses Impact based on Confidence
- No time-based gates that affect Impact scoring
- Recency only boosts Impact, never suppresses it

## 7. Gates & Thresholds

### No Override Gates
- **Central bank override**: **NONE**
- **Multi-sector boost**: **NONE**
- **Regulatory tag boost**: **NONE** (tags only affect confidence)
- **Macro tag boost**: **NONE** (tags only affect confidence)

### Blacklist/Whitelist
- **Domain blacklist**: **NONE**
- **Ticker whitelist**: **NONE**
- **Topic blacklist**: **NONE**

### Regulatory/Macro Tags
- Tags only affect Confidence scoring (+5 confidence)
- No direct Impact modification
- Tags are stored but not used in Impact computation

## 8. Environment/Config

### Environment Variables
- **IMPACT_* variables**: **NONE**
- **IMPACT_WEIGHTS**: **NONE**
- **IMPACT_THRESHOLDS**: **NONE**

### Configuration Files
- **JSON/YAML configs**: **NONE**
- **Feature flags**: **NONE**
- **Runtime weights**: **NONE**

### Load Order
- No configuration loading
- All weights and thresholds are hardcoded in `scoring.ts`

## 9. Versioning & Recent Changes

### Timeline (Last 2 Weeks)
- **No Impact-related commits** in the past 2 weeks
- Recent commits focused on Confidence V2.1/V2.2 implementation
- No changes to Impact scoring algorithm or thresholds

### Distribution Shifts
- **No recent changes** that could shift distributions
- **No boundary modifications** in recent commits

### Tests
- **Impact-specific tests**: **NONE**
- **Scoring tests**: Only Confidence V2.1/V2.2 tests exist
- **Integration tests**: **NONE**

## 10. Worked Examples

### Example 1: High Impact
- **Headline**: "Apple CEO Tim Cook resigns amid investigation"
- **Tickers**: ["AAPL"]
- **Published**: 2 hours ago
- **Source**: "Bloomberg"
- **Features**: 
  - Base: 20
  - Recency (2h): +10
  - Ticker (1): +10
  - High keyword ("ceo resigns"): +15
  - Source (bloomberg): +6
  - **Total**: 61 → **Medium** (should be High with "investigation" keyword)

### Example 2: Medium Impact
- **Headline**: "Microsoft announces partnership with OpenAI"
- **Tickers**: ["MSFT"]
- **Published**: 4 hours ago
- **Source**: "Reuters"
- **Features**:
  - Base: 20
  - Recency (4h): +10
  - Ticker (1): +10
  - Medium keyword ("partnership"): +8
  - Source (reuters): +6
  - **Total**: 54 → **Medium**

### Example 3: Low Impact
- **Headline**: "Tech company expands to new market"
- **Tickers**: []
- **Published**: 12 hours ago
- **Source**: "TechCrunch"
- **Features**:
  - Base: 20
  - Recency (12h): +5
  - Tickers (0): +0
  - Medium keyword ("expansion"): +8
  - Source (techcrunch): +2
  - **Total**: 35 → **Low**

## 11. Distribution Snapshot

### Current Distribution (Estimated)
Based on algorithm analysis:
- **Low**: ~40-50% (scores 0-44)
- **Medium**: ~35-45% (scores 45-69)
- **High**: ~10-20% (scores 70-100)

### Raw Score Statistics (Estimated)
- **Mean**: ~45-55
- **Median**: ~45-50
- **P10**: ~25-30
- **P50**: ~45-50
- **P90**: ~70-80
- **Min**: 20
- **Max**: 100
- **StdDev**: ~20-25

### ASCII Histogram (Estimated)
```
0-20:   ████ (5%)
21-40:  ████████████ (25%)
41-60:  ████████████████████ (40%)
61-80:  ████████████ (25%)
81-100: ████ (5%)
```

### Baseline Comparison
- **No baseline data available**
- **No historical tracking**
- **No distribution monitoring**

## 12. Invariants & Sanity Checks

### Monotonicity Verification

#### (a) Geography → Impact
- **Status**: **NOT IMPLEMENTED**
- No geography detection in current algorithm
- No local/national/regional/global classification
- **Violation possible**: Yes, no geography logic exists

#### (b) Regulatory Severity → Impact
- **Status**: **NOT IMPLEMENTED**
- No regulatory severity scoring
- Keywords like "investigation", "lawsuit" get +15 but no severity levels
- **Violation possible**: Yes, no severity classification

#### (c) Entity/Sector Count → Impact
- **Status**: **PARTIALLY IMPLEMENTED**
- Ticker count affects Impact: 1 ticker = +10, 2+ tickers = +15
- No sector classification or counting
- **Violation possible**: No, ticker count is monotonic

### Concrete Examples
- **Geography violation**: Local news about "Apple CEO resigns" vs global news about "Fed rate hike" - both get same scoring
- **Regulatory violation**: "Minor investigation" vs "Major lawsuit" - both get +15
- **Entity violation**: 1 ticker vs 10 tickers - both get same +15 boost

## 13. Bugs & Risks

### Identified Issues

#### Mixed Scales
- **Risk**: **LOW** - All scoring uses 0-100 scale consistently
- **Location**: `backend/src/utils/scoring.ts:125`

#### Double Clipping
- **Risk**: **NONE** - Single clipping operation at line 125
- **Location**: `backend/src/utils/scoring.ts:125`

#### Stale Weights
- **Risk**: **HIGH** - All weights are hardcoded with no versioning
- **Location**: `backend/src/utils/scoring.ts:53-105`

#### Missing Config Fallback
- **Risk**: **LOW** - No config system, all defaults hardcoded
- **Location**: `backend/src/utils/scoring.ts:19`

#### Time Zone Issues
- **Risk**: **MEDIUM** - Uses local time for recency calculation
- **Location**: `backend/src/utils/scoring.ts:25-35`

#### Feature Sparsity
- **Risk**: **MEDIUM** - Many items may cluster around base score (20)
- **Location**: `backend/src/utils/scoring.ts:19`

#### Confidence Coupling
- **Risk**: **NONE** - No coupling between Impact and Confidence
- **Location**: Verified across all scoring files

## 14. Deliverables

### A) Impact Specification Document
**COMPLETED** - This document contains sections 1-13 above.

### B) Debug Endpoint Design
**NOT IMPLEMENTED** - No existing `/admin/impact-explain` endpoint.

**Proposed Design**:
```typescript
// backend/src/api.ts - Add new endpoint
router.get('/admin/impact-explain', async (req, res) => {
  const { id } = req.query;
  // Fetch item from Firestore
  // Re-run scoring with debug info
  // Return detailed breakdown
});
```

**Example Response**:
```json
{
  "id": "abc123",
  "features": {
    "headline": "Apple CEO resigns",
    "tickers": ["AAPL"],
    "published_at": "2024-01-15T10:00:00Z",
    "source": "Bloomberg"
  },
  "intermediates": {
    "base_score": 20,
    "recency_boost": 10,
    "ticker_boost": 10,
    "keyword_boost": 15,
    "source_boost": 6
  },
  "raw": 61,
  "category": "Medium",
  "drivers": [
    {"feature": "high_impact_keyword", "contribution": 15},
    {"feature": "recency", "contribution": 10},
    {"feature": "ticker_count", "contribution": 10}
  ],
  "flags": {"has_macro_tag": false},
  "version": "v1.0"
}
```

### C) Unit Tests
**NOT IMPLEMENTED** - No existing Impact-specific tests.

**Required Tests**:
```typescript
// backend/test/impact.test.ts
describe('Impact Scoring', () => {
  test('threshold boundaries', () => {
    expect(scoreNews({...}).impact).toBe('L'); // score 44
    expect(scoreNews({...}).impact).toBe('M'); // score 45
    expect(scoreNews({...}).impact).toBe('M'); // score 69
    expect(scoreNews({...}).impact).toBe('H'); // score 70
  });
  
  test('monotonicity', () => {
    // More tickers should not decrease impact
    const score1 = scoreNews({tickers: ['AAPL']});
    const score2 = scoreNews({tickers: ['AAPL', 'MSFT']});
    expect(score2.impact_score).toBeGreaterThanOrEqual(score1.impact_score);
  });
  
  test('independence from confidence', () => {
    // Same inputs should produce same impact regardless of confidence
    const inputs = {headline: 'Test', tickers: ['AAPL']};
    const score1 = scoreNews({...inputs, debug: false});
    const score2 = scoreNews({...inputs, debug: true});
    expect(score1.impact).toBe(score2.impact);
  });
});
```

## 15. Executive Summary + Root Causes

### Executive Summary
The Impact scoring system is a simple rule-based algorithm that assigns market impact categories (Low/Medium/High) based on keyword matching, recency, ticker presence, and source credibility. Operating on a 0-100 scale with three discrete buckets, the system uses hardcoded keyword lists and additive scoring without normalization. Impact is computed independently of Confidence scoring with no cross-system dependencies. The algorithm lacks sophisticated features like geography detection, regulatory severity classification, or sector analysis. Recent development has focused on Confidence scoring improvements while Impact logic remains unchanged for over 2 weeks.

### Root Causes for Distribution Issues
**Likely cause for "too many Medium"**: The algorithm's additive nature and hardcoded thresholds create natural clustering around the Medium category (45-69). Many news items accumulate scores in the 45-65 range due to combinations of base score (20), recency (5-15), tickers (10-15), and keywords (8-15). The lack of normalization or calibration means scores don't distribute evenly across the 0-100 range, leading to over-representation in the Medium bucket.

**Evidence**: 
- Base score of 20 + common boosts (recency 5-15, tickers 10-15) naturally produces scores in 35-50 range
- Medium threshold at 45 captures many items that would otherwise be Low
- No sophisticated weighting or normalization to spread scores across the full range
- Hardcoded keyword lists may not reflect current market impact patterns

## cURL Example and Test Instructions

### Debug Endpoint (Not Yet Implemented)
```bash
# This endpoint does not exist yet
curl -X GET "http://localhost:4000/admin/impact-explain?id=abc123" \
  -H "Content-Type: application/json"
```

### Run Existing Tests
```bash
cd backend
npm test
```

### Run Impact Tests (Not Yet Implemented)
```bash
cd backend
npm test -- --testNamePattern="Impact"
```

## Unknown Areas Requiring Investigation

1. **Actual distribution data**: Need to query Firestore for last 200 items to get real statistics
2. **Performance impact**: No monitoring of scoring latency or resource usage
3. **User feedback**: No mechanism to collect user feedback on Impact accuracy
4. **A/B testing**: No framework for testing Impact algorithm variations
5. **Market validation**: No correlation between Impact scores and actual market movements
