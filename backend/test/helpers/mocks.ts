// Mock functions for testing

// Mock Firebase Firestore
export const mockFirestore = {
  collection: jest.fn(() => ({
    doc: jest.fn(() => ({
      set: jest.fn(() => Promise.resolve()),
      get: jest.fn(() => Promise.resolve({ exists: false, data: () => null })),
      update: jest.fn(() => Promise.resolve()),
      delete: jest.fn(() => Promise.resolve())
    })),
    where: jest.fn(() => ({
      orderBy: jest.fn(() => ({
        limit: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve({ docs: [], empty: true }))
        }))
      }))
    }))
  }))
};

// Mock storage functions
export const mockStorage = {
  addNewsItems: jest.fn(() => Promise.resolve({ added: 0, skipped: 0 })),
  generateArticleHash: jest.fn(() => 'test-hash-123')
};

// Mock fetch for RSS tests
export const mockFetch = jest.fn();
