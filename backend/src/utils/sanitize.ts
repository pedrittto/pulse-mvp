/**
 * Sanitize text content by removing HTML tags, decoding entities, and normalizing whitespace
 */
export function sanitizeText(input: string | undefined): string {
  if (!input) {
    return '';
  }

  let result = input;

  // Strip HTML tags
  result = result.replace(/<[^>]*>/g, '');

  // Decode common HTML entities
  const entities: { [key: string]: string } = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&quot;': '"',
    '&apos;': "'",
    '&lt;': '<',
    '&gt;': '>',
    '&#39;': "'",
    '&#x27;': "'",
    '&#x2F;': '/',
    '&#x60;': '`',
    '&#x3D;': '=',
    '&#x2D;': '-',
    '&#x5F;': '_',
    '&#x2E;': '.',
    '&#x21;': '!',
    '&#x28;': '(',
    '&#x29;': ')',
    '&#x5B;': '[',
    '&#x5D;': ']',
    '&#x7B;': '{',
    '&#x7D;': '}',
    '&#x3A;': ':',
    '&#x3B;': ';',
    '&#x2C;': ',',
    '&#x3F;': '?',
    '&#x40;': '@',
    '&#x23;': '#',
    '&#x24;': '$',
    '&#x25;': '%',
    '&#x5E;': '^',
    '&#x2A;': '*',
    '&#x2B;': '+',
    '&#x7C;': '|',
    '&#x5C;': '\\',
    '&#x7E;': '~'
  };

  for (const [entity, replacement] of Object.entries(entities)) {
    result = result.replace(new RegExp(entity, 'gi'), replacement);
  }

  // Collapse whitespace (multiple spaces/newlines -> single space)
  result = result.replace(/\s+/g, ' ');

  // Trim
  result = result.trim();

  // Cap length at ~400 chars without breaking multibyte characters
  if (result.length > 400) {
    // Find the last complete character within 400 chars
    const truncated = result.slice(0, 400);
    const lastCharIndex = truncated.lastIndexOf(' ');
    
    if (lastCharIndex > 350) { // If we can break at a word boundary
      result = truncated.slice(0, lastCharIndex) + '...';
    } else {
      result = truncated + '...';
    }
  }

  return result;
}
