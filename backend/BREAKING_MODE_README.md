# Breaking Mode Implementation

Breaking Mode is a fast-path news ingestion system designed to achieve sub-60 second latency for high-priority sources, with a target of 10-20 seconds through tuning.

## Overview

The system implements a two-phase approach:
1. **Fast-path publish**: Minimal stub cards are published immediately (within seconds)
2. **Asynchronous enrichment**: Full scoring and analysis is applied in the background

## Architecture

### Core Components

- **`breakingIngest.ts`**: Fast-path publishing and enrichment logic
- **`breakingScheduler.ts`**: Adaptive polling with per-source intervals
- **`admin.ts`**: Admin endpoints for manual posting and monitoring
- **Configuration files**: Source lists and event windows

### Data Flow

1. **RSS Polling**: Scheduler polls configured sources at adaptive intervals
2. **Stub Publishing**: New items are immediately published as minimal stubs
3. **Enrichment**: Background job adds scoring, analysis, and metadata
4. **Feed Display**: Cards appear immediately and update in place

## Configuration

### Environment Variables

```bash
# Enable breaking mode
BREAKING_MODE=1

# Admin token for manual posting
ADMIN_QUICKPOST_TOKEN=your-secure-token-here

# Optional: Custom config path
BREAKING_SOURCES_PATH=./src/config/breaking-sources.json
```

### Breaking Sources Configuration

Edit `src/config/breaking-sources.json`:

```json
{
  "sources": [
    {
      "name": "Reuters Business",
      "url": "https://feeds.reuters.com/reuters/businessNews",
      "interval_ms": 10000,
      "mode": "breaking",
      "event_window": true
    }
  ],
  "default_interval_ms": 120000,
  "watchlist_interval_ms": 10000,
  "event_window_interval_ms": 5000
}
```

**Parameters:**
- `interval_ms`: Base polling interval in milliseconds
- `event_window`: Whether to use faster intervals during event windows
- `mode`: Source mode (currently only "breaking" supported)

### Event Windows Configuration

Edit `src/config/event-windows.json`:

```json
{
  "events": [
    {
      "name": "FOMC Meeting",
      "description": "Federal Reserve FOMC meeting and press conference",
      "start_time": "14:00",
      "end_time": "15:30",
      "days": ["Tuesday", "Wednesday"],
      "frequency": "monthly",
      "relevant_sources": ["Reuters Business", "Bloomberg Markets", "CNBC"]
    }
  ]
}
```

**Parameters:**
- `start_time`/`end_time`: 24-hour format (HH:MM)
- `days`: Array of day names
- `relevant_sources`: Sources to accelerate during this window

## API Endpoints

### Admin Quick Post

**POST** `/admin/quick-post`

Manually create a breaking news stub:

```bash
curl -X POST http://localhost:4000/admin/quick-post \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Breaking: Fed Raises Interest Rates",
    "source": "Manual Post",
    "url": "https://example.com/news",
    "tags": ["fed", "rates"]
  }'
```

**Response:**
```json
{
  "success": true,
  "id": "generated-article-id",
  "message": "Article published successfully"
}
```

### Latency Metrics

**GET** `/admin/latency?hours=24`

Get latency statistics for all sources:

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  http://localhost:4000/admin/latency?hours=24
```

**Response:**
```json
{
  "success": true,
  "hours": 24,
  "overall": {
    "total_articles": 150,
    "avg_p50_ms": 2500,
    "avg_p90_ms": 4500
  },
  "sources": {
    "Reuters Business": {
      "p50_ms": 2000,
      "p90_ms": 4000,
      "count": 45,
      "avg_publish_ms": 2200
    }
  }
}
```

### Breaking Status

**GET** `/admin/breaking-status`

Get current scheduler status:

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  http://localhost:4000/admin/breaking-status
```

### Scheduler Control

**POST** `/admin/breaking-control`

Start or stop the breaking scheduler:

```bash
curl -X POST http://localhost:4000/admin/breaking-control \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "start"}'
```

## Adding Sources to Breaking List

### Method 1: Edit Configuration File

1. Add source to `src/config/breaking-sources.json`
2. Restart the application or wait for hourly config reload

### Method 2: Runtime Management (Future Enhancement)

```bash
# Add source (not yet implemented)
curl -X POST http://localhost:4000/admin/breaking-sources \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "New Source",
    "url": "https://example.com/rss",
    "interval_ms": 15000,
    "event_window": true
  }'
```

## Event Window Behavior

Event windows automatically adjust polling intervals:

- **Normal mode**: Uses configured `interval_ms`
- **Event window**: Uses `event_window_interval_ms` (typically 5 seconds)
- **Watchlist mode**: Uses `watchlist_interval_ms` (typically 10 seconds)

### Example Timeline

```
09:00 - Normal polling (120s intervals)
14:00 - FOMC event starts → Accelerated polling (5s intervals)
15:30 - FOMC event ends → Return to normal polling
```

## Monitoring and Metrics

### Latency Tracking

Every article logs:
- `source_published_at`: When source published
- `ingested_at`: When we received it
- `arrival_at`: When it appeared in feed
- `t_ingest_ms`: Processing time
- `t_publish_ms`: Total publish time

### Key Metrics

- **P50 latency**: Median time from source to feed
- **P90 latency**: 90th percentile latency
- **Average publish time**: Mean processing time
- **Article count**: Total articles processed

### Performance Targets

- **Target**: 10-20 seconds end-to-end
- **Acceptable**: <60 seconds
- **Fast-path**: <5 seconds for stub publishing

## Safety Features

### Rate Limiting

- Exponential backoff on HTTP 429/5xx errors
- Per-source rate limiting to avoid hammering hosts
- Configurable timeouts and retry limits

### Deduplication

- URL-based deduplication
- Title hash deduplication
- Prevents duplicate cards from multiple sources

### Non-interference

- Existing RSS pipeline remains unchanged
- Breaking mode runs in parallel
- No blocking on NLP/scoring for fast-path

## Testing

### Unit Tests

```bash
npm test -- breakingIngest.test.ts
```

### Integration Tests

```bash
npm test -- breakingScheduler.test.ts
```

### Manual Testing

1. Enable breaking mode: `BREAKING_MODE=1`
2. Start the application
3. Monitor `/admin/latency` for performance
4. Use `/admin/quick-post` to test manual posting

## Deployment

### Staging Deployment

1. Deploy to staging environment
2. Enable breaking mode with limited sources
3. Monitor `/admin/latency` for 24 hours
4. Verify performance targets are met

### Production Deployment

1. Enable breaking mode: `BREAKING_MODE=1`
2. Set admin token: `ADMIN_QUICKPOST_TOKEN`
3. Configure breaking sources
4. Monitor latency metrics
5. Gradually add more sources

### Rollback Plan

1. Set `BREAKING_MODE=0` to disable
2. Restart application
3. System returns to normal RSS ingestion only

## Troubleshooting

### Common Issues

**High Latency**
- Check network connectivity to RSS feeds
- Verify source URLs are accessible
- Review rate limiting settings

**Duplicate Articles**
- Check deduplication logic
- Verify URL normalization
- Review title hashing

**Missing Enrichment**
- Check enrichment job logs
- Verify database connectivity
- Review scoring pipeline

### Log Analysis

Key log patterns:
- `[breaking][publish]`: Stub publishing
- `[breaking][enrich]`: Enrichment process
- `[breaking][error]`: Error conditions
- `[breaking][rate-limit]`: Rate limiting events

### Performance Tuning

1. **Reduce intervals**: Lower `interval_ms` values
2. **Add event windows**: Configure more event windows
3. **Optimize sources**: Remove slow/unreliable sources
4. **Database tuning**: Optimize Firestore queries

## Future Enhancements

- Runtime source management
- Advanced event detection
- Machine learning for interval optimization
- Real-time performance dashboards
- A/B testing for different configurations
