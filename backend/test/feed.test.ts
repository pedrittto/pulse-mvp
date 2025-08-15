import request from 'supertest';
import { app } from '../src/index';

describe('/feed endpoint', () => {
  it('should return items with arrival_at field', async () => {
    const response = await request(app)
      .get('/feed?limit=1')
      .expect(200);

    expect(response.body).toHaveProperty('items');
    expect(Array.isArray(response.body.items)).toBe(true);
    
    if (response.body.items.length > 0) {
      const item = response.body.items[0];
      expect(item).toHaveProperty('arrival_at');
      expect(typeof item.arrival_at).toBe('string');
      
      // Verify it's a valid ISO string
      const date = new Date(item.arrival_at);
      expect(date.toISOString()).toBe(item.arrival_at);
    }
  });

  it('should return items with both published_at and arrival_at', async () => {
    const response = await request(app)
      .get('/feed?limit=1')
      .expect(200);

    if (response.body.items.length > 0) {
      const item = response.body.items[0];
      expect(item).toHaveProperty('published_at');
      expect(item).toHaveProperty('arrival_at');
      expect(item).toHaveProperty('ingested_at');
      
      // arrival_at should be the same as ingested_at
      expect(item.arrival_at).toBe(item.ingested_at);
    }
  });
});
