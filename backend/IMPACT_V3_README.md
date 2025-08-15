# Impact V3 Implementation

## Overview

Impact V3 is a production-ready MVP that redefines market impact scoring based on five principled drivers rather than keyword counting. It provides a more sophisticated and deterministic approach to assessing the expected market significance of news items.

## Key Features

- **Five-Driver Model**: Surprise, Credibility, P&L Proximity, Timing & Liquidity, and Scale
- **Backward Compatibility**: Maintains existing API contract with optional debug information
- **Configurable**: Supports runtime configuration via JSON file
- **A/B Testing**: Built-in comparison logging between V2 and V3
- **Deterministic**: Consistent results for identical inputs
- **Modular**: Clean separation from Confidence scoring

## Architecture

### Core Components

1. **`impactV3.ts`**: Main implementation with five driver functions
2. **`scoring.ts`**: Integration point with feature flag support
3. **`api.ts`**: Enhanced endpoints with debug support
4. **`types.ts`**: Updated type definitions including Critical category

### Driver Functions

#### 1. Surprise (Weight: 35%)
- **Purpose**: Measures deviation from expectations
- **Signals**: Earnings vs consensus, unexpected events, regulatory actions
- **Patterns**: "earnings beat consensus", "emergency", "unexpected", "ban"
- **Fallback**: Neutral 0.5 when no surprise indicators present

#### 2. Credibility (Weight: 20%)
- **Purpose**: Source authority and verifiability
- **Tiers**: Official sources > Tier-1 media > Tier-2 media > Tech media > Unknown
- **Bonuses**: On-record attribution (+0.1)
- **Penalties**: Unverified rumors (-0.2)

#### 3. P&L Proximity (Weight: 25%)
- **Purpose**: Directness of path to cash flows
- **Levels**: Direct actions > Sectoral > Macro-diffuse
- **Signals**: Bans, guidance changes, contracts, acquisitions
- **Fallback**: Based on ticker presence

#### 4. Timing & Liquidity (Weight: 10%)
- **Purpose**: Market session state and liquidity context
- **Sessions**: Regular > Pre-market > After-hours > Weekend
- **Events**: FOMC, CPI, earnings calls, Fed speeches
- **Fallback**: Neutral 0.5 when no timestamp available

#### 5. Scale (Weight: 10%)
- **Purpose**: Magnitude and breadth of fundamental change
- **Factors**: EPS magnitude, regulatory severity, geographic breadth, company size
- **Fallback**: Based on ticker count

## Configuration

### Environment Variables

- `IMPACT_MODE=v3`: Enables Impact V3 (default: V2)
- `IMPACT_V3_CONFIG=/path/to/config.json`: Configuration file path
- `IMPACT_V3_COMPARE=1`: Enables A/B comparison logging

### Configuration File Format

```json
{
  "weights": {
    "surprise": 0.35,
    "credibility": 0.20,
    "pnlProximity": 0.25,
    "timingLiquidity": 0.10,
    "scale": 0.10
  },
  "thresholds": {
    "low": 0.35,
    "medium": 0.60,
    "high": 0.80,
    "critical": 1.00
  },
  "calibration": {
    "enabled": true,
    "points": [
      {"input": 0.0, "output": 0.0},
      {"input": 0.3, "output": 0.25},
      {"input": 0.5, "output": 0.45},
      {"input": 0.7, "output": 0.65},
      {"input": 0.9, "output": 0.85},
      {"input": 1.0, "output": 1.0}
    ]
  }
}
```

## API Changes

### Backward Compatibility

- `/feed` endpoint unchanged
- Impact category still returned as `L`/`M`/`H`/`C`
- `impact_score` converted from 0-1 to 0-100 for compatibility

### New Debug Features

#### Feed Debug
```bash
GET /feed?debug=impact
```

Returns additional `impact_debug` object per item:
```json
{
  "impact_debug": {
    "raw": 0.75,
    "category": "H",
    "drivers": [
      {"name": "surprise", "value": 0.9, "fallback": false},
      {"name": "credibility", "value": 0.9, "fallback": false},
      // ... other drivers
    ],
    "meta": {
      "version": "v3",
      "weights": {...},
      "thresholds": {...},
      "calibration": {...}
    }
  }
}
```

#### Admin Debug
```bash
GET /admin/impact-explain?id=<docId>
```

Returns detailed breakdown:
```json
{
  "ok": true,
  "id": "abc123",
  "features": {...},
  "raw": 75,
  "category": "H",
  "drivers": [...],
  "meta": {...},
  "flags": {
    "has_macro_tag": false,
    "version": "v3"
  }
}
```

## Testing

### Test Coverage

- **Core Functionality**: Result structure, driver presence, meta information
- **Monotonicity**: Increasing inputs should not decrease impact
- **Independence**: Impact independent of Confidence scoring
- **Timing Sanity**: Regular session > off-hours
- **Regression**: Relative impact ordering (earnings > routine, ban > partnership)
- **Fallback Behavior**: Graceful handling of missing data

### Running Tests

```bash
# Impact V3 tests
npm test -- test/impactV3.test.ts

# Legacy Impact tests
npm test -- test/impact.test.ts

# All tests
npm test
```

## Deployment

### Rollout Strategy

1. **Development**: Set `IMPACT_MODE=v3` for testing
2. **Staging**: Enable with `IMPACT_V3_COMPARE=1` for A/B logging
3. **Production**: Monitor logs for 24h, then flip `IMPACT_MODE=v3`

### Monitoring

#### A/B Comparison Logs
```json
{
  "type": "impact_compare",
  "headline": "AAPL earnings beat consensus...",
  "v2_score": 75,
  "v2_category": "H",
  "v3_raw": 0.75,
  "v3_category": "H",
  "v3_drivers": [
    {"name": "surprise", "value": 0.9},
    {"name": "credibility", "value": 0.9}
  ],
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

#### Metrics to Track
- Category distribution (L/M/H/C counts)
- Raw score statistics (mean, median, p10/p50/p90)
- Driver contribution analysis
- Fallback usage rates

## Tuning

### Weight Adjustment

Modify `weights` in configuration to emphasize different drivers:
- Increase `surprise` for more sensitivity to unexpected events
- Increase `credibility` for source quality emphasis
- Increase `pnlProximity` for direct business impact focus

### Threshold Tuning

Adjust `thresholds` to change category boundaries:
- Lower `medium` threshold for more Medium classifications
- Raise `high` threshold for more selective High classifications
- Adjust `critical` threshold for Critical category sensitivity

### Calibration

Modify `calibration.points` to address score distribution:
- Add more points for finer control
- Adjust output values to spread scores across categories
- Disable calibration with `"enabled": false`

## Migration Guide

### From V2 to V3

1. **Enable V3**: Set `IMPACT_MODE=v3`
2. **Monitor**: Enable comparison logging with `IMPACT_V3_COMPARE=1`
3. **Analyze**: Review A/B logs for distribution changes
4. **Tune**: Adjust configuration based on observed behavior
5. **Deploy**: Remove comparison logging after validation

### Rollback

To revert to V2:
```bash
unset IMPACT_MODE  # or set to any value other than 'v3'
```

## Future Enhancements

- **Market Data Integration**: Real-time consensus data for Surprise driver
- **Exchange Calendar**: Precise market hours for Timing driver
- **Entity Recognition**: Better ticker and company identification
- **Machine Learning**: Driver weight optimization based on market outcomes
- **Geographic Tuning**: Region-specific source credibility tiers
