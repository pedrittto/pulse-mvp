import { formatHHMMLocal, pickArrival } from './time';

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
  });
});
