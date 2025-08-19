import { snapshotEnv, restoreEnv, setTestEnv } from './env';

// Global test setup
beforeAll(() => {
  // Snapshot environment variables before each test suite
  snapshotEnv();
  
  // Set required test environment variables
  setTestEnv({
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_CLIENT_EMAIL: 'test@test.com',
    FIREBASE_PRIVATE_KEY: 'test-key',
    NODE_ENV: 'test',
    // Disable schedulers and adaptive for tests to avoid open handles
    BREAKING_MODE: '0',
    RSS_ADAPTIVE: '0',
    // Ensure conditional GETs default ON for transport v2
    RSS_TRANSPORT_V2: '1'
  });
});

afterEach(() => {
  // Restore environment variables after each test
  restoreEnv();
});

// Global test teardown
afterAll(() => {
  // Ensure cleanup
  restoreEnv();
});
