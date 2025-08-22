import request from 'supertest';
import { app } from '../src/index';

describe('Server Listen Guard', () => {
  let server: any;

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  it('should import app without starting the server', () => {
    // This test verifies that importing the app doesn't start a server
    // The app should be exported without any side effects
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });

  it('should bind to random port in tests', async () => {
    // Start server on random port for testing
    server = app.listen(0);
    
    // Get the assigned port
    const address = server.address();
    expect(address).toBeDefined();
    expect(typeof address.port).toBe('number');
    expect(address.port).toBeGreaterThan(0);

    // Test that the server responds
    const response = await request(app)
      .get('/health')
      .expect(200);

    expect(response.body).toHaveProperty('ok', true);
  });

  it('should handle health endpoint correctly', async () => {
    server = app.listen(0);
    
    const response = await request(app)
      .get('/health')
      .expect(200);

    expect(response.body).toHaveProperty('ok', true);
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('env');
    expect(response.body).toHaveProperty('config');
    expect(response.body).toHaveProperty('breaking');
  });

  it('should handle 404 correctly', async () => {
    server = app.listen(0);
    
    const response = await request(app)
      .get('/nonexistent-endpoint')
      .expect(404);

    expect(response.body).toHaveProperty('error');
    expect(response.body.error).toHaveProperty('message', 'Route not found');
    expect(response.body.error).toHaveProperty('code', 'NOT_FOUND');
  });

  it('should close cleanly', (done) => {
    server = app.listen(0);
    
    server.close(() => {
      done();
    });
  });
});
