## Confidence V2.2 — Deprecated

## Overview
This numeric system has been replaced by categorical `confidence_state` with values: unconfirmed, reported, corroborated, verified, confirmed. Do not use numeric confidence.

### (Deprecated) Environment Variables

### Core Configuration
- `CONFIDENCE_MODE=v2.2` - Enable V2.2 scoring (defaults to v2.1 if not set)
- `CONFIDENCE_GAMMA=2.0` - Contrast expansion factor
- `CONFIDENCE_RANGE_MIN=10` - Minimum confidence score
- `CONFIDENCE_RANGE_MAX=98` - Maximum confidence score

### Confirmation Settings
- `CONFIRMATION_ALPHA=0.9` - Exponential decay parameter for k counting
- `CONFIRMATION_SOLO_SAFETY=0.20` - Safety score for solo high-tier fresh content
- `CONFIRMATION_WINDOW_MIN=60` - Time window for confirmation deduplication (minutes)

### Content Fit Settings
- `CONTENT_TREND_BONUS=0.10` - Bonus for content aligned with active trends

### (Deprecated) Algorithm

### Pillar Weights (sum = 1.0)
- P1 (Source + Freshness): 0.32
- P2 (Cross-confirmation): 0.28
- P3 (Content fit): 0.22
- P4 (Accountability): 0.12
- P5 (Market reaction): 0.06

### P1 — Source + Freshness – Rumor (0..1)
```
tier = getSourceTier(domain)            // 0..1
fresh = exp(-minutesSince(published_at)/180)
rumor = getRumorPenalty(item)           // 0..0.3
P1 = clamp01(0.6*tier + 0.4*fresh - rumor)
```

### P2 — Cross-confirmation (0..1)
```
k = countUniqueConfirmations(item, window=CONFIRMATION_WINDOW_MIN, dedupeByTitleEmbedding=true)
f_k = 1 - exp(-CONFIRMATION_ALPHA * max(k-1,0))   // α=0.9 → k=2≈0.59, k=3≈0.80
if (k==1 && tier>=0.8 && fresh>=0.7) f_k = max(f_k, CONFIRMATION_SOLO_SAFETY)  // 0.20
diversity_bonus = hasCrossClassConfirmations(item) ? 0.10 : 0.0
P2 = clamp01(f_k + diversity_bonus)
```

### P3 — Content fit (0..1)
```
baseFit = classifyContent(item) // opinion=0.2, info=0.4, sectoral=0.6, macro=0.8
if (alignsWithActiveTrend(item, lookback=2h)) baseFit += CONTENT_TREND_BONUS
P3 = clamp01(baseFit)
```

### P4 — Accountability (0..1)
```
P4 = getAccountabilityScore(source)     // keep current method
if (source.class == 'social_verified') P4 = min(P4, 0.6)
```

### P5 — Market reaction (0..1)
```
pct = getMarketPercentile(item, window=[t-10m, t+10m]) // null if no data
if (pct != null) P5 = 0.2 + 0.8*pct
else P5 = sentimentVolatilityFallback(item) // deterministic 0.45..0.55 based on headline sentiment + asset class
```

### Final Computation
```
S = w1*P1 + w2*P2 + w3*P3 + w4*P4 + w5*P5
gamma = getenv(CONFIDENCE_GAMMA, 2.0)
C = clamp01(0.5 + gamma*(S - 0.5))
MIN = getenv(CONFIDENCE_RANGE_MIN, 10)
MAX = getenv(CONFIDENCE_RANGE_MAX, 98)
final = clamp(MIN + round((MAX-MIN)*C), MIN, MAX)
```

## Source Classes
- regulator (tier ≥ 1.0)
- corp_pr (tier ≥ 0.8)
- tier1 (tier ≥ 0.6)
- tier2 (tier ≥ 0.4)
- social_verified (tier ≥ 0.2)
- anonymous (tier < 0.2)

## Content Classes
- macro (0.8) - CPI, FOMC, OPEC, payrolls, etc.
- sectoral (0.6) - earnings, M&A, guidance, etc.
- info (0.4) - purely informational
- opinion (0.2) - opinion, analysis, commentary

## Debug Output
When `debug=conf` is requested, the API returns:
- P1..P5: Individual pillar scores
- S: Weighted sum
- C: Contrast expansion result
- final: Final confidence score
- tier: Source tier
- k: Number of unique confirmations
- diversity: Cross-class confirmation flag
- fresh: Freshness score
- rumor: Rumor penalty applied
- contentClass: Content classification
- marketPct: Market percentile (or null)
- flags: Various algorithm flags
- mode: 'v2.2'

## Invariants
1. All pillar scores are in [0, 1]
2. Weights sum to 1.0
3. Final score is in [MIN, MAX] range
4. Solo safety only applies to high-tier, fresh content
5. Diversity bonus requires multiple source classes
6. Market fallback is deterministic and asset-class aware
