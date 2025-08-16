import request from 'supertest';
import { app } from '../src/index';

// Mock Firestore to avoid credential issues in tests
jest.mock('../src/lib/firestore', () => ({
  getDb: jest.fn(() => ({
    collection: jest.fn(() => ({
      get: jest.fn(() => Promise.resolve({ docs: [] })),
      doc: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ exists: false }))
      })),
      where: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ docs: [] }))
      }))
    })),
    batch: jest.fn(() => ({
      delete: jest.fn(),
      commit: jest.fn(() => Promise.resolve())
    }))
  }))
}));

// Mock breakingIngest to avoid Firestore calls
jest.mock('../src/ingest/breakingIngest', () => ({
  getSourceLatencyStats: jest.fn(() => Promise.resolve({ p50: 0, p90: 0, count: 0, avg_publish_ms: 0 })),
  getCurrentSourceStats: jest.fn(() => ({})),
  resetSourceStats: jest.fn()
}));

// Mock breakingScheduler
jest.mock('../src/ingest/breakingScheduler', () => ({
  breakingScheduler: {
    getStatus: jest.fn(() => ({
      isRunning: true,
      sources: [
        { name: 'Test Source', interval_ms: 15000, lastFetchAt: null, lastOkAt: null, inEventWindow: false, backoffState: null }
      ]
    })),
    start: jest.fn(),
    stop: jest.fn(),
    forceFetch: jest.fn(() => Promise.resolve({ scheduled: ['Test Source'], skipped: [] })),
    resetState: jest.fn()
  }
}));

describe('Admin Authentication', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('GET /admin/breaking-status', () => {
    it('should return 401 when no token is provided', async () => {
      process.env.ADMIN_TOKEN = 'test-token';
      
      const response = await request(app)
        .get('/admin/breaking-status')
        .expect(401);

      expect(response.body).toEqual({
        error: 'Admin token required',
        code: 'TOKEN_REQUIRED'
      });
    });

    it('should return 401 when invalid token is provided', async () => {
      process.env.ADMIN_TOKEN = 'test-token';
      
      const response = await request(app)
        .get('/admin/breaking-status')
        .set('Authorization', 'Bearer wrong-token')
        .expect(401);

      expect(response.body).toEqual({
        error: 'Invalid admin token',
        code: 'INVALID_TOKEN'
      });
    });

    it('should return 200 with valid Bearer token', async () => {
      process.env.ADMIN_TOKEN = 'test-token';
      
      const response = await request(app)
        .get('/admin/breaking-status')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(response.body).toHaveProperty('breaking_mode_enabled');
      expect(response.body).toHaveProperty('scheduler_running');
      expect(response.body).toHaveProperty('sources');
    });

    it('should return 200 with valid X-Admin-Token header', async () => {
      process.env.ADMIN_TOKEN = 'test-token';
      
      const response = await request(app)
        .get('/admin/breaking-status')
        .set('X-Admin-Token', 'test-token')
        .expect(200);

      expect(response.body).toHaveProperty('breaking_mode_enabled');
      expect(response.body).toHaveProperty('scheduler_running');
      expect(response.body).toHaveProperty('sources');
    });

    it('should support multiple tokens via ADMIN_TOKENS', async () => {
      process.env.ADMIN_TOKENS = 'token1,token2,token3';
      
      const response = await request(app)
        .get('/admin/breaking-status')
        .set('Authorization', 'Bearer token2')
        .expect(200);

      expect(response.body).toHaveProperty('breaking_mode_enabled');
    });

    it('should return 500 when no admin tokens are configured', async () => {
      delete process.env.ADMIN_TOKEN;
      delete process.env.ADMIN_TOKENS;
      
      const response = await request(app)
        .get('/admin/breaking-status')
        .set('Authorization', 'Bearer any-token')
        .expect(500);

      expect(response.body).toEqual({
        error: 'Admin authentication not configured',
        code: 'ADMIN_NOT_CONFIGURED'
      });
    });
  });

  describe('POST /admin/purge-feed', () => {
    it('should return 403 when ADMIN_ALLOW_PURGE is not set', async () => {
      process.env.ADMIN_TOKEN = 'test-token';
      delete process.env.ADMIN_ALLOW_PURGE;
      
      const response = await request(app)
        .post('/admin/purge-feed')
        .set('Authorization', 'Bearer test-token')
        .send({ all: true, confirm: 'PURGE' })
        .expect(403);

      expect(response.body).toEqual({
        error: 'Purge operations not allowed',
        code: 'PURGE_NOT_ALLOWED'
      });
    });

    it('should return 403 when ADMIN_ALLOW_PURGE is false', async () => {
      process.env.ADMIN_TOKEN = 'test-token';
      process.env.ADMIN_ALLOW_PURGE = '0';
      
      const response = await request(app)
        .post('/admin/purge-feed')
        .set('Authorization', 'Bearer test-token')
        .send({ all: true, confirm: 'PURGE' })
        .expect(403);

      expect(response.body).toEqual({
        error: 'Purge operations not allowed',
        code: 'PURGE_NOT_ALLOWED'
      });
    });

    it('should return 200 when ADMIN_ALLOW_PURGE is enabled', async () => {
      process.env.ADMIN_TOKEN = 'test-token';
      process.env.ADMIN_ALLOW_PURGE = '1';
      
      const response = await request(app)
        .post('/admin/purge-feed')
        .set('Authorization', 'Bearer test-token')
        .send({ all: true, confirm: 'PURGE' })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('deleted');
    });

    it('should return 400 when confirm is not PURGE', async () => {
      process.env.ADMIN_TOKEN = 'test-token';
      process.env.ADMIN_ALLOW_PURGE = '1';
      
      const response = await request(app)
        .post('/admin/purge-feed')
        .set('Authorization', 'Bearer test-token')
        .send({ all: true, confirm: 'WRONG' })
        .expect(400);

      expect(response.body).toEqual({
        error: 'Must include confirm: "PURGE" to proceed',
        code: 'CONFIRMATION_REQUIRED'
      });
    });
  });

  describe('Other admin endpoints', () => {
    beforeEach(() => {
      process.env.ADMIN_TOKEN = 'test-token';
    });

    it('should protect /admin/quick-post', async () => {
      const response = await request(app)
        .post('/admin/quick-post')
        .expect(401);

      expect(response.body.code).toBe('TOKEN_REQUIRED');
    });

    it('should protect /admin/latency', async () => {
      const response = await request(app)
        .get('/admin/latency')
        .expect(401);

      expect(response.body.code).toBe('TOKEN_REQUIRED');
    });

    it('should protect /admin/breaking-control', async () => {
      const response = await request(app)
        .post('/admin/breaking-control')
        .send({ action: 'start' })
        .expect(401);

      expect(response.body.code).toBe('TOKEN_REQUIRED');
    });

    it('should protect /admin/reingest', async () => {
      const response = await request(app)
        .post('/admin/reingest')
        .send({ all: true, force: true })
        .expect(401);

      expect(response.body.code).toBe('TOKEN_REQUIRED');
    });

    it('should protect /admin/reset-breaking-state', async () => {
      const response = await request(app)
        .post('/admin/reset-breaking-state')
        .expect(401);

      expect(response.body.code).toBe('TOKEN_REQUIRED');
    });
  });
});
