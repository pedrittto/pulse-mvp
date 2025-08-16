# Breaking Mode Deployment Guide

This guide provides step-by-step instructions for deploying the Breaking Mode feature to achieve sub-60 second latency for high-priority news sources.

## Prerequisites

- Node.js 18+ installed
- Firebase project configured
- Environment variables set up
- Access to RSS feeds

## Environment Setup

### Required Environment Variables

Add these to your `.env` file or deployment environment:

```bash
# Enable breaking mode
BREAKING_MODE=1

# Admin token for manual posting and monitoring
ADMIN_QUICKPOST_TOKEN=your-secure-random-token-here

# Firebase configuration (existing)
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY=your-private-key
FIREBASE_CLIENT_EMAIL=your-client-email

# Optional: Custom config paths
BREAKING_SOURCES_PATH=./src/config/breaking-sources.json
```

### Generate Admin Token

Generate a secure random token for admin access:

```bash
# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Or using OpenSSL
openssl rand -hex 32
```

## Configuration Files

### 1. Breaking Sources Configuration

Ensure `src/config/breaking-sources.json` is configured:

```json
{
  "sources": [
    {
      "name": "Reuters Business",
      "url": "https://feeds.reuters.com/reuters/businessNews",
      "interval_ms": 10000,
      "mode": "breaking",
      "event_window": true
    },
    {
      "name": "Bloomberg Markets",
      "url": "https://feeds.bloomberg.com/markets/news.rss",
      "interval_ms": 15000,
      "mode": "breaking",
      "event_window": true
    }
  ],
  "default_interval_ms": 120000,
  "watchlist_interval_ms": 10000,
  "event_window_interval_ms": 5000
}
```

### 2. Event Windows Configuration

Ensure `src/config/event-windows.json` is configured:

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

## Deployment Steps

### 1. Build the Application

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Verify build
ls dist/
```

### 2. Test the Build

```bash
# Run unit tests
npm test -- breakingIngest.test.ts

# Run integration tests
npm test -- breakingScheduler.test.ts

# Run all tests
npm test
```

### 3. Staging Deployment

1. **Deploy to staging environment**
   ```bash
   # Set environment variables
   export BREAKING_MODE=1
   export ADMIN_QUICKPOST_TOKEN=your-staging-token
   
   # Start the application
   npm start
   ```

2. **Verify breaking mode is enabled**
   ```bash
   curl -H "Authorization: Bearer your-staging-token" \
     http://localhost:4000/admin/breaking-status
   ```

3. **Test manual posting**
   ```bash
   curl -X POST http://localhost:4000/admin/quick-post \
     -H "Authorization: Bearer your-staging-token" \
     -H "Content-Type: application/json" \
     -d '{
       "title": "Test Breaking News",
       "source": "Manual Test",
       "url": "https://example.com/test"
     }'
   ```

4. **Monitor latency for 24 hours**
   ```bash
   curl -H "Authorization: Bearer your-staging-token" \
     http://localhost:4000/admin/latency?hours=24
   ```

### 4. Production Deployment

1. **Deploy to production**
   ```bash
   # Set production environment variables
   export BREAKING_MODE=1
   export ADMIN_QUICKPOST_TOKEN=your-production-token
   export NODE_ENV=production
   
   # Start the application
   npm start
   ```

2. **Verify deployment**
   ```bash
   # Check health endpoint
   curl http://your-production-domain/health
   
   # Check breaking status
   curl -H "Authorization: Bearer your-production-token" \
     http://your-production-domain/admin/breaking-status
   ```

3. **Monitor performance**
   - Check `/admin/latency` every hour for first 24 hours
   - Verify average publish time < 5 seconds
   - Monitor for any errors in logs

## Monitoring and Maintenance

### Key Metrics to Monitor

1. **Latency Metrics** (`/admin/latency`)
   - P50 latency should be < 20 seconds
   - P90 latency should be < 60 seconds
   - Average publish time should be < 5 seconds

2. **Error Rates**
   - Monitor for HTTP 429/5xx errors
   - Check for enrichment failures
   - Watch for duplicate article issues

3. **System Health**
   - RSS feed connectivity
   - Database performance
   - Memory usage

### Log Analysis

Key log patterns to monitor:

```bash
# Successful stub publishing
grep "\[breaking\]\[publish\]" logs/app.log

# Enrichment process
grep "\[breaking\]\[enrich\]" logs/app.log

# Error conditions
grep "\[breaking\]\[error\]" logs/app.log

# Rate limiting
grep "\[breaking\]\[rate-limit\]" logs/app.log
```

### Performance Tuning

If latency targets are not met:

1. **Reduce polling intervals**
   ```json
   {
     "interval_ms": 5000,  // Reduce from 10000
     "event_window_interval_ms": 2000  // Reduce from 5000
   }
   ```

2. **Add more event windows**
   ```json
   {
     "events": [
       {
         "name": "Market Open",
         "start_time": "09:30",
         "end_time": "10:30",
         "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
       }
     ]
   }
   ```

3. **Optimize sources**
   - Remove slow/unreliable sources
   - Add more high-priority sources
   - Adjust source-specific intervals

## Rollback Plan

If issues arise, quickly disable breaking mode:

1. **Set environment variable**
   ```bash
   export BREAKING_MODE=0
   ```

2. **Restart application**
   ```bash
   npm start
   ```

3. **Verify rollback**
   ```bash
   curl -H "Authorization: Bearer your-token" \
     http://localhost:4000/admin/breaking-status
   ```

The system will continue with normal RSS ingestion only.

## Troubleshooting

### Common Issues

**High Latency**
- Check network connectivity to RSS feeds
- Verify source URLs are accessible
- Review rate limiting settings
- Check database performance

**Duplicate Articles**
- Verify deduplication logic
- Check URL normalization
- Review title hashing

**Missing Enrichment**
- Check enrichment job logs
- Verify database connectivity
- Review scoring pipeline

**Configuration Issues**
- Verify JSON syntax in config files
- Check file permissions
- Ensure paths are correct

### Support Commands

```bash
# Check breaking mode status
curl -H "Authorization: Bearer $ADMIN_QUICKPOST_TOKEN" \
  http://localhost:4000/admin/breaking-status

# Get latency metrics
curl -H "Authorization: Bearer $ADMIN_QUICKPOST_TOKEN" \
  http://localhost:4000/admin/latency?hours=24

# Control scheduler
curl -X POST http://localhost:4000/admin/breaking-control \
  -H "Authorization: Bearer $ADMIN_QUICKPOST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "stop"}'
```

## Success Criteria

Breaking Mode is successfully deployed when:

1. ✅ Average publish latency < 5 seconds
2. ✅ P50 end-to-end latency < 20 seconds  
3. ✅ P90 end-to-end latency < 60 seconds
4. ✅ No duplicate articles in feed
5. ✅ Enrichment completes successfully
6. ✅ No interference with existing RSS pipeline
7. ✅ Admin endpoints accessible and secure
8. ✅ Event windows trigger correctly
9. ✅ Rate limiting prevents host hammering
10. ✅ Graceful error handling and recovery
