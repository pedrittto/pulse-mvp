import { composeHeadline } from '../src/utils/factComposer';

describe('Fact Composer Guardrails', () => {
  test('should fallback to original title for malformed headlines', () => {
    const testCases = [
      {
        title: 'Brazil 50%',
        description: 'Brazil 50%',
        expected: 'Brazil 50%' // Should fallback to original
      },
      {
        title: 'Some meaningful title about Brazil economy',
        description: 'Brazil 50%',
        expected: 'Some Meaningful Title About Brazil Economy' // Should use original with proper capitalization
      },
      {
        title: '123%',
        description: 'Just a number',
        expected: '123%' // Should fallback to original
      },
      {
        title: 'India',
        description: 'India',
        expected: 'India' // Should fallback to original
      }
    ];

    testCases.forEach(({ title, description, expected }) => {
      const result = composeHeadline({
        title,
        description,
        body: '',
        tickers: []
      });
      
      // The result should be the original title (cleaned) for malformed cases
      expect(result).toBe(expected);
    });
  });

  test('should allow valid headlines through', () => {
    const validHeadlines = [
      {
        title: 'Apple Reports Strong Earnings',
        description: 'Apple Inc. reported quarterly earnings that beat analyst expectations.',
        expected: 'Apple Reports Strong Earnings' // Should pass through
      },
      {
        title: 'Fed Raises Interest Rates by 25 Basis Points',
        description: 'The Federal Reserve has raised interest rates.',
        expected: 'Fed Raises Interest Rates By 25 Basis Points' // Should pass through with proper capitalization
      }
    ];

    validHeadlines.forEach(({ title, description, expected }) => {
      const result = composeHeadline({
        title,
        description,
        body: '',
        tickers: []
      });
      
      expect(result).toBe(expected);
    });
  });
});
