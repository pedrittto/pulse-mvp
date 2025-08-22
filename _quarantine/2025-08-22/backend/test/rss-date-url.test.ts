import { parseRssDateToIso, sanitizePublisherUrl } from '../src/ingest/rss';

describe('RSS date parsing and URL sanitization', () => {
  test('parses ISO8601 with timezone', () => {
    expect(parseRssDateToIso('2024-08-19T12:34:56Z')).toBe('2024-08-19T12:34:56.000Z');
    expect(parseRssDateToIso('2024-08-19 12:34:56+0200')).toBe('2024-08-19T10:34:56.000Z');
    expect(parseRssDateToIso('2024-08-19T12:34+02:00')).toBe('2024-08-19T10:34:00.000Z');
  });

  test('parses RFC822 with GMT and offsets', () => {
    expect(parseRssDateToIso('Tue, 22 Aug 2023 15:34:00 GMT')).toBe('2023-08-22T15:34:00.000Z');
    expect(parseRssDateToIso('22 Aug 2023 15:34:00 +0200')).toBe('2023-08-22T13:34:00.000Z');
  });

  test('returns empty string on parse failure', () => {
    expect(parseRssDateToIso('Not a date')).toBe('');
    expect(parseRssDateToIso('32 Foo 2020 99:99:99 ABC')).toBe('');
  });

  test('sanitizes publisher URLs removing UTMs and trackers', () => {
    const cleaned = sanitizePublisherUrl('http://example.com/a?utm_source=x&x=1&fbclid=abc&ref=foo');
    expect(cleaned).toBe('https://example.com/a?x=1');
  });
});


