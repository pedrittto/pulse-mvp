# Verification Mode V1 Deployment Guide

## Overview

The Verification Mode V1 replaces the percent-based Confidence badge with a deterministic 4-state Verification Status system. This provides clearer, more actionable information about news item reliability.

## Features

### 4-State Verification Status
- **Verified**: Regulatory/filing OR official livestream+transcript OR k≥3 within 30m
- **Confirmed**: Tier-1 OR k≥2 OR on_record quote
- **Reported**: Single Tier-1/2 without denial
- **Unconfirmed**: Only low-tier/anon/social OR rumor-lexicon triggers

### Live Event Override
- Dynamic, on-air events from Tier-1 sources are not downgraded
- Tier-1 source + live event → minimum status Confirmed even at k=1

### Deterministic Rules
- Pure, deterministic gates; no weighted sums
- Preserves existing APIs; adds new `verification` field
- Keeps `confidence` field for backward compatibility and internal metrics

## Environment Variables

### Required
```bash
# Enable verification mode
VERIFICATION_MODE=v1
```

### Optional
```bash
# Frontend environment variable (for UI toggle)
NEXT_PUBLIC_VERIFICATION_MODE=v1
```

## API Changes

### New Fields
- `verification`: "verified" | "confirmed" | "reported" | "unconfirmed"
- `_verification_debug`: Debug information when requested

### Debug Endpoints
- `/feed?debug=verif`: Shows verification decision reasons
- `/feed?debug=conf`: Still available for confidence internals

### Backward Compatibility
- `/feed` endpoint unchanged
- `confidence` field preserved for existing consumers
- UI ignores `confidence` when `VERIFICATION_MODE=v1`

## Frontend Integration

### New Component
- `VerificationBadge.tsx`: Replaces `ConfidenceBadge` when verification mode enabled
- Color coding: Verified (green), Confirmed (blue), Reported (gray), Unconfirmed (amber)

### Conditional Display
```typescript
const isVerificationMode = process.env.NEXT_PUBLIC_VERIFICATION_MODE === 'v1' || item.verification;

{isVerificationMode && item.verification ? (
  <VerificationBadge verification={item.verification} />
) : (
  <ConfidenceBadge confidence={item.confidence} />
)}
```

## Verification Rules

### Rule 1: Verified
- **Regulatory/Filing**: SEC announcements, Federal Reserve policy changes, official filings
- **Official Livestream + Transcript**: Fed press conferences with quoted content
- **k≥3 Sources**: 3+ independent sources within 30m window

### Rule 2: Confirmed
- **Tier-1 Source**: Bloomberg, Reuters, WSJ, FT, CNBC (tier ≥0.8)
- **k≥2 Sources**: 2+ independent sources
- **On-record Quote**: CEO/CFO statements, spokesperson quotes

### Rule 3: Live Event Override
- **Tier-1 + Live Event**: Breaking news during live events gets minimum Confirmed status
- **Override Logic**: Applied before regular Tier-1 check

### Rule 4: Reported
- **Single Reputable Source**: Tier-1/2 source without denial patterns
- **No Denial**: Content doesn't contain denial/refutation patterns

### Rule 5: Unconfirmed
- **Rumor Patterns**: "rumor", "sources say", "allegedly", etc.
- **Low-tier Source**: Anonymous social, unknown sources (tier <0.6)

## Source Tiers

### Tier 1.0: Regulators
- SEC, Federal Reserve, ECB, BOE, Treasury, etc.

### Tier 0.9: Corporate Communications
- IR pages, press releases, earnings calls

### Tier 0.8: Tier-1 Media
- Bloomberg, Reuters, WSJ, FT, CNBC, AP, etc.

### Tier 0.6: Tier-2 Media
- Forbes, TechCrunch, Business Insider, etc.

### Tier 0.3: Social Media
- Verified Twitter, LinkedIn, etc.

### Tier 0.0: Anonymous/Low-tier
- Anonymous sources, unknown blogs

## Deployment Steps

### 1. Backend Deployment
```bash
# Set environment variable
export VERIFICATION_MODE=v1

# Deploy backend
npm run build
npm start
```

### 2. Frontend Deployment
```bash
# Set environment variable
export NEXT_PUBLIC_VERIFICATION_MODE=v1

# Deploy frontend
npm run build
npm start
```

### 3. Verification
- Check `/feed` endpoint returns `verification` field
- Verify UI shows verification badges instead of confidence percentages
- Test debug endpoint: `/feed?debug=verif`

## Monitoring

### Metrics
- Verification distribution: `{ type: 'verification_computed', verification: 'confirmed' }`
- Confidence comparison: `{ type: 'confidence_compare', v1: 75, v2_final: 82 }`

### Log Analysis
```bash
# Monitor verification distribution
grep "verification_computed" logs | jq '.verification' | sort | uniq -c

# Compare confidence vs verification
grep "confidence_compare" logs | jq '{headline, v1, v2_final, verification}'
```

## Rollback Plan

### Quick Rollback
```bash
# Disable verification mode
unset VERIFICATION_MODE
unset NEXT_PUBLIC_VERIFICATION_MODE

# Restart services
```

### A/B Testing
- Log both old confidence and new verification for 14 days
- Compare distributions and disagreements
- Monitor for any unexpected behavior

## Testing

### Unit Tests
```bash
npm test -- verification.test.ts
```

### Integration Tests
- Test live event override with Tier-1 sources
- Verify rumor detection works correctly
- Check regulatory content gets Verified status

### Manual Testing
1. Create test items with different source tiers
2. Test rumor patterns ("Rumor: Company Merger")
3. Test live event patterns ("Breaking: Fed Announcement")
4. Verify UI shows correct badges

## Troubleshooting

### Common Issues

#### Verification not appearing
- Check `VERIFICATION_MODE=v1` is set
- Verify frontend environment variable is set
- Check browser console for errors

#### Wrong verification status
- Check source tier mapping in `sourceTiers.ts`
- Verify rumor/regulatory pattern detection
- Test with debug endpoint: `/feed?debug=verif`

#### UI not updating
- Clear browser cache
- Check `NEXT_PUBLIC_VERIFICATION_MODE` is set
- Verify `VerificationBadge` component is imported

### Debug Commands
```bash
# Check verification computation
curl "http://localhost:3000/feed?debug=verif&limit=1"

# Compare confidence vs verification
curl "http://localhost:3000/feed?debug=conf&limit=1"
```

## Future Enhancements

### Potential Improvements
- Dynamic source tier management
- Machine learning-based rumor detection
- Real-time verification updates
- User feedback integration

### Configuration
- JSON-based rule configuration
- Runtime rule updates
- Custom source tier definitions

## Support

For issues or questions:
1. Check logs for verification computation errors
2. Verify environment variables are set correctly
3. Test with debug endpoints
4. Review source tier mappings
5. Check pattern detection logic
