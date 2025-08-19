import request from 'supertest';
import express from 'express';
import { metrics, computeGlobalLatencyAggregate } from '../src/routes/metrics';

// Build test app
const app = express();
app.use(express.json());
app.use('/', metrics);

// Mock Firestore
jest.mock('../src/lib/firestore', () => ({
  getDb: jest.fn()
}));

const { getDb } = require('../src/lib/firestore');

describe('/metrics-lite windowing and aggregates', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T12:00:00.000Z'));
    process.env = { ...originalEnv };
    process.env.METRICS_LATENCY_SUMMARY = '1';
    process.env.METRICS_LATENCY_WINDOW_MIN = '60';
    process.env.LAT_METRIC_MAX_AGE_MIN = '360';
    mockDbWithLatencyMetrics([]);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  function mockDbWithLatencyMetrics(latencyDocs: any[]) {
    const collections: Record<string, any> = {
      system: {
        doc: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve({ exists: true, data: () => ({ per_source: { Reuters: { timeout_count: 0, error_count: 0 } } }) }))
        }))
      },
      latency_metrics: {
        where: jest.fn(function () { return this; }),
        orderBy: jest.fn(function () { return this; }),
        limit: jest.fn(function () { return this; }),
        get: jest.fn(() => Promise.resolve({
          forEach: (cb: any) => latencyDocs.forEach(d => cb({ data: () => d })),
          docs: latencyDocs.map(d => ({ data: () => d }))
        }))
      },
      news: {
        count: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: () => ({ count: 0 }) })) })),
        orderBy: jest.fn(function () { return this; }),
        limit: jest.fn(function () { return this; }),
        get: jest.fn(() => Promise.resolve({ empty: true, docs: [] }))
      }
    };
    (getDb as jest.Mock).mockReturnValue({
      collection: (name: string) => collections[name]
    });
  }

  test('filters by source_published_at within METRICS_LATENCY_WINDOW_MIN', async () => {
    const now = Date.parse('2025-01-01T12:00:00.000Z');
    const within = new Date(now - 30 * 60 * 1000).toISOString();
    const outside = new Date(now - 120 * 60 * 1000).toISOString();

    mockDbWithLatencyMetrics([
      { source: 'Reuters', source_published_at: within, t_publish_ms: 1000, transport: 'rss_batch', timestamp: new Date(now).toISOString() },
      { source: 'Reuters', source_published_at: outside, t_publish_ms: 5000, transport: 'rss_batch', timestamp: new Date(now).toISOString() }
    ]);

    const res = await request(app).get('/metrics-lite').expect(200);
    expect(res.body).toHaveProperty('latency');
    const s = res.body.latency['Reuters'];
    expect(s.count).toBe(1);
    expect(s.p50).toBe(1000);
    expect(s.transport_mix).toHaveProperty('rss_batch', 1);
    // next_poll_in_ms should not be present
    expect(s).not.toHaveProperty('next_poll_in_ms');
  });

  test('excludes samples older than LAT_METRIC_MAX_AGE_MIN', async () => {
    const now = Date.parse('2025-01-01T12:00:00.000Z');
    process.env.LAT_METRIC_MAX_AGE_MIN = '30';
    const tooOld = new Date(now - 45 * 60 * 1000).toISOString();
    mockDbWithLatencyMetrics([
      { source: 'Reuters', source_published_at: tooOld, t_publish_ms: 9000, transport: 'rss_batch', timestamp: new Date(now).toISOString() }
    ]);

    const res = await request(app).get('/metrics-lite').expect(200);
    expect(res.body.latency).toEqual({});
  });

  test('global aggregates exclude sources with samples_insufficient=true', () => {
    const agg = computeGlobalLatencyAggregate({
      A: { p50: 1000, p90: 2000, count: 10, samples_insufficient: false },
      B: { p50: 500, p90: 1500, count: 2, samples_insufficient: true }
    } as any);
    expect(agg).toBeTruthy();
    // Only A should be included
    expect(agg?.sources_included).toBe(1);
    expect(agg?.p50).toBe(1000);
    expect(agg?.p90).toBe(2000);
  });
});


