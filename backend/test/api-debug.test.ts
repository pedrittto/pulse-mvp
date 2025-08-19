import request from 'supertest';
import express from 'express';
import apiRouter from '../src/api';

// Create a test app
const app = express();
app.use(express.json());
app.use('/', apiRouter);

describe('API Debug Endpoint', () => {
  // Mock environment variables for V2.2
  const originalEnv = process.env;
  
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CONFIDENCE_MODE;
    process.env.FIREBASE_PROJECT_ID = 'test-project';
  });
  
  afterEach(() => {
    process.env = originalEnv;
  });

  test('GET /feed includes timing headers when API_LATENCY_HEADERS=1', async () => {
    process.env.API_LATENCY_HEADERS = '1';
    const response = await request(app)
      .get('/feed')
      .query({ limit: '1' })
      .expect(200);

    // Should include new headers
    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.headers['x-backend-duration-ms']).toBeDefined();
  });

  test('GET /feed does not include timing headers by default', async () => {
    delete process.env.API_LATENCY_HEADERS;
    const response = await request(app)
      .get('/feed')
      .query({ limit: '1' })
      .expect(200);

    expect(response.headers['x-request-id']).toBeUndefined();
    expect(response.headers['x-backend-duration-ms']).toBeUndefined();
  });

  test('GET /feed?debug=conf should return debug information for V2.2', async () => {
    const response = await request(app)
      .get('/feed')
      .query({ debug: 'conf', limit: '1' })
      .expect(200);

    expect(response.body).toHaveProperty('items');
    expect(response.body.items).toBeInstanceOf(Array);
    
    if (response.body.items.length > 0) {
      const item = response.body.items[0];
      
      // Check that debug object exists
      expect(item).toHaveProperty('debug');
      expect(item.debug).toBeDefined();
      
      // Check for required debug fields
      expect(item.debug).toHaveProperty('mode', 'v2.2');
      expect(item.debug).toHaveProperty('P1');
      expect(item.debug).toHaveProperty('P2');
      expect(item.debug).toHaveProperty('P3');
      expect(item.debug).toHaveProperty('P4');
      expect(item.debug).toHaveProperty('P5');
      expect(item.debug).toHaveProperty('S');
      expect(item.debug).toHaveProperty('C');
      expect(item.debug).toHaveProperty('final');
      expect(item.debug).toHaveProperty('tier');
      expect(item.debug).toHaveProperty('k');
      expect(item.debug).toHaveProperty('diversity');
      expect(item.debug).toHaveProperty('fresh');
      expect(item.debug).toHaveProperty('rumor');
      expect(item.debug).toHaveProperty('contentClass');
      expect(item.debug).toHaveProperty('marketPct');
      expect(item.debug).toHaveProperty('flags');
      
      // Check flags object
      expect(item.debug.flags).toHaveProperty('soloSafety');
      expect(item.debug.flags).toHaveProperty('trendAligned');
      expect(item.debug.flags).toHaveProperty('fallbackUsed');
      
      // Verify data types
      expect(typeof item.debug.P1).toBe('number');
      expect(typeof item.debug.P2).toBe('number');
      expect(typeof item.debug.P3).toBe('number');
      expect(typeof item.debug.P4).toBe('number');
      expect(typeof item.debug.P5).toBe('number');
      expect(typeof item.debug.S).toBe('number');
      expect(typeof item.debug.C).toBe('number');
      expect(typeof item.debug.final).toBe('number');
      expect(typeof item.debug.tier).toBe('number');
      expect(typeof item.debug.k).toBe('number');
      expect(typeof item.debug.diversity).toBe('boolean');
      expect(typeof item.debug.fresh).toBe('number');
      expect(typeof item.debug.rumor).toBe('number');
      expect(typeof item.debug.contentClass).toBe('string');
      expect(['number', 'object'].includes(typeof item.debug.marketPct)).toBe(true);
    }
  });

  test('GET /feed without debug should not return debug information', async () => {
    const response = await request(app)
      .get('/feed')
      .query({ limit: '1' })
      .expect(200);

    expect(response.body).toHaveProperty('items');
    expect(response.body.items).toBeInstanceOf(Array);
    
    if (response.body.items.length > 0) {
      const item = response.body.items[0];
      
      // Check that debug object does NOT exist
      expect(item).not.toHaveProperty('debug');
    }
  });

  test('GET /feed?debug=conf should work with case-insensitive debug parameter', async () => {
    const response = await request(app)
      .get('/feed')
      .query({ debug: 'CONF', limit: '1' })
      .expect(200);

    expect(response.body).toHaveProperty('items');
    expect(response.body.items).toBeInstanceOf(Array);
    
    if (response.body.items.length > 0) {
      const item = response.body.items[0];
      
      // Check that debug object exists
      expect(item).toHaveProperty('debug');
      expect(item.debug).toBeDefined();
      expect(item.debug).toHaveProperty('mode', 'v2.2');
    }
  });
});
