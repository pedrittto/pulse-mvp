import { formatHHMMLocal, pickArrival, formatRelativeTime } from './time';

describe('Time formatting functions', () => {
  describe('formatHHMMLocal', () => {
    test('should format exact minutes without rounding', () => {
      // Test with a specific time that should show exact minutes
      const testTime = '2025-01-15T20:17:33.123Z';
      const formatted = formatHHMMLocal(testTime);
      
      // Should show exact minutes (17), not rounded to 00 or 30
      expect(formatted).toMatch(/^\d{1,2}:\d{2}$/);
      
      // Parse the formatted time to check minutes
      const [hours, minutes] = formatted.split(':').map(Number);
      expect(minutes).toBe(17);
    });

    test('should handle different minute values correctly', () => {
      const testCases = [
        { iso: '2025-01-15T20:03:45Z', expectedMinutes: 3 },
        { iso: '2025-01-15T20:17:33Z', expectedMinutes: 17 },
        { iso: '2025-01-15T20:42:12Z', expectedMinutes: 42 },
        { iso: '2025-01-15T20:59:59Z', expectedMinutes: 59 }
      ];

      testCases.forEach(({ iso, expectedMinutes }) => {
        const formatted = formatHHMMLocal(iso);
        const [hours, minutes] = formatted.split(':').map(Number);
        expect(minutes).toBe(expectedMinutes);
      });
    });

    test('should be stable across multiple calls', () => {
      const testTime = '2025-01-15T20:17:33.123Z';
      const result1 = formatHHMMLocal(testTime);
      const result2 = formatHHMMLocal(testTime);
      const result3 = formatHHMMLocal(testTime);
      
      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
    });

    test('should handle timezone conversion correctly', () => {
      // Test with a time that would be in a different timezone
      const utcTime = '2025-01-15T20:17:33Z';
      const formatted = formatHHMMLocal(utcTime);
      
      // Should still show the correct minutes regardless of timezone
      const [hours, minutes] = formatted.split(':').map(Number);
      expect(minutes).toBe(17);
    });

    test('should not round to 30-minute intervals', () => {
      // Test times that should NOT be rounded to 00 or 30
      const testCases = [
        { iso: '2025-01-15T20:17:33Z', expectedMinutes: 17 },
        { iso: '2025-01-15T20:23:45Z', expectedMinutes: 23 },
        { iso: '2025-01-15T20:47:12Z', expectedMinutes: 47 },
        { iso: '2025-01-15T20:53:59Z', expectedMinutes: 53 }
      ];

      testCases.forEach(({ iso, expectedMinutes }) => {
        const formatted = formatHHMMLocal(iso);
        const [hours, minutes] = formatted.split(':').map(Number);
        expect(minutes).toBe(expectedMinutes);
        // Ensure it's not rounded to 00 or 30
        expect(minutes % 30).not.toBe(0);
      });
    });
  });

  describe('pickArrival', () => {
    test('should prefer arrival_at over other fields', () => {
      const item = {
        arrival_at: '2025-01-15T20:17:33Z',
        ingested_at: '2025-01-15T20:15:00Z',
        published_at: '2025-01-15T20:10:00Z'
      };
      
      expect(pickArrival(item)).toBe('2025-01-15T20:17:33Z');
    });

    test('should fall back to ingested_at if arrival_at is missing', () => {
      const item = {
        ingested_at: '2025-01-15T20:15:00Z',
        published_at: '2025-01-15T20:10:00Z'
      };
      
      expect(pickArrival(item)).toBe('2025-01-15T20:15:00Z');
    });

    test('should fall back to published_at if others are missing', () => {
      const item = {
        published_at: '2025-01-15T20:10:00Z'
      };
      
      expect(pickArrival(item)).toBe('2025-01-15T20:10:00Z');
    });

    test('should be stable across multiple calls', () => {
      const item = {
        arrival_at: '2025-01-15T20:17:33Z',
        ingested_at: '2025-01-15T20:15:00Z',
        published_at: '2025-01-15T20:10:00Z'
      };
      
      const result1 = pickArrival(item);
      const result2 = pickArrival(item);
      const result3 = pickArrival(item);
      
      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
    });
  });

  describe('formatRelativeTime', () => {
    beforeEach(() => {
      // Mock Date.now() to return a fixed timestamp
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-01-15T20:30:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('should show "just now" for times less than 5 seconds ago', () => {
      const testCases = [
        '2025-01-15T20:29:56.000Z', // 4 seconds ago
        '2025-01-15T20:29:58.000Z', // 2 seconds ago
        '2025-01-15T20:29:59.000Z', // 1 second ago
      ];

      testCases.forEach(iso => {
        expect(formatRelativeTime(iso)).toBe('just now');
      });
    });

    test('should show seconds for times between 5 and 60 seconds ago', () => {
      const testCases = [
        { iso: '2025-01-15T20:29:50.000Z', expected: '10 seconds ago' },
        { iso: '2025-01-15T20:29:30.000Z', expected: '30 seconds ago' },
        { iso: '2025-01-15T20:29:01.000Z', expected: '59 seconds ago' },
      ];

      testCases.forEach(({ iso, expected }) => {
        expect(formatRelativeTime(iso)).toBe(expected);
      });
    });

    test('should show minutes for times between 1 and 60 minutes ago', () => {
      const testCases = [
        { iso: '2025-01-15T20:29:00.000Z', expected: '1 minute ago' },
        { iso: '2025-01-15T20:15:00.000Z', expected: '15 minutes ago' },
        { iso: '2025-01-15T20:00:00.000Z', expected: '30 minutes ago' },
        { iso: '2025-01-15T19:31:00.000Z', expected: '59 minutes ago' },
      ];

      testCases.forEach(({ iso, expected }) => {
        expect(formatRelativeTime(iso)).toBe(expected);
      });
    });

    test('should show hours for times between 1 and 24 hours ago', () => {
      const testCases = [
        { iso: '2025-01-15T19:30:00.000Z', expected: '1 hour ago' },
        { iso: '2025-01-15T17:30:00.000Z', expected: '3 hours ago' },
        { iso: '2025-01-15T12:30:00.000Z', expected: '8 hours ago' },
        { iso: '2025-01-15T00:31:00.000Z', expected: '20 hours ago' },
      ];

      testCases.forEach(({ iso, expected }) => {
        expect(formatRelativeTime(iso)).toBe(expected);
      });
    });

    test('should show "yesterday" for times 1 day ago', () => {
      const yesterday = '2025-01-14T20:30:00.000Z';
      expect(formatRelativeTime(yesterday)).toBe('yesterday');
    });

    test('should show "2 days ago" for times 2 days ago', () => {
      const twoDaysAgo = '2025-01-13T20:30:00.000Z';
      expect(formatRelativeTime(twoDaysAgo)).toBe('2 days ago');
    });

    test('should show absolute date for times 3+ days ago', () => {
      const threeDaysAgo = '2025-01-12T20:30:00.000Z';
      const result = formatRelativeTime(threeDaysAgo);
      expect(result).toMatch(/^Jan \d+$/);
    });

    test('should handle edge cases correctly', () => {
      // Test the boundary between "just now" and "X seconds ago"
      expect(formatRelativeTime('2025-01-15T20:29:55.000Z')).toBe('just now'); // 5 seconds ago
      expect(formatRelativeTime('2025-01-15T20:29:54.000Z')).toBe('6 seconds ago'); // 6 seconds ago

      // Test the boundary between seconds and minutes
      expect(formatRelativeTime('2025-01-15T20:29:00.000Z')).toBe('1 minute ago'); // 60 seconds ago
      expect(formatRelativeTime('2025-01-15T20:28:01.000Z')).toBe('1 minute ago'); // 59 seconds ago

      // Test the boundary between minutes and hours
      expect(formatRelativeTime('2025-01-15T19:30:00.000Z')).toBe('1 hour ago'); // 60 minutes ago
      expect(formatRelativeTime('2025-01-15T19:31:00.000Z')).toBe('59 minutes ago'); // 59 minutes ago

      // Test the boundary between hours and days
      expect(formatRelativeTime('2025-01-14T20:30:00.000Z')).toBe('yesterday'); // 24 hours ago
      expect(formatRelativeTime('2025-01-14T20:31:00.000Z')).toBe('23 hours ago'); // 23 hours 59 minutes ago
    });

    test('should round down correctly', () => {
      // Test that we round down, not up
      expect(formatRelativeTime('2025-01-15T20:29:30.000Z')).toBe('30 seconds ago'); // 30.5 seconds ago
      expect(formatRelativeTime('2025-01-15T20:15:30.000Z')).toBe('14 minutes ago'); // 14.5 minutes ago
      expect(formatRelativeTime('2025-01-15T17:30:30.000Z')).toBe('2 hours ago'); // 2.5 hours ago
    });

    test('should handle pluralization correctly', () => {
      expect(formatRelativeTime('2025-01-15T20:29:00.000Z')).toBe('1 minute ago');
      expect(formatRelativeTime('2025-01-15T20:28:00.000Z')).toBe('2 minutes ago');
      expect(formatRelativeTime('2025-01-15T19:30:00.000Z')).toBe('1 hour ago');
      expect(formatRelativeTime('2025-01-15T18:30:00.000Z')).toBe('2 hours ago');
    });
  });
});
