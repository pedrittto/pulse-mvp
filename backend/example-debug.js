// Example script to demonstrate Confidence V2.2 debug output
// Run with: node example-debug.js

// Set environment variables for V2.2
process.env.CONFIDENCE_MODE = 'v2.2';

// Import the scoring function
const { scoreConfidenceV22 } = require('./dist/utils/confidenceV2');

// Example 1: High-quality macro news
const example1 = {
  publishedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
  now: new Date(),
  sources: [
    { domain: 'bloomberg.com', isPrimary: false },
    { domain: 'reuters.com', isPrimary: false }
  ],
  headline: 'Fed Raises Interest Rates by 25 Basis Points',
  body: 'The Federal Reserve has announced a 25 basis point increase in the federal funds rate...',
  tags: ['Macro'],
  impact_score: 85,
  market: undefined
};

// Example 2: Solo Tier-1 fresh content
const example2 = {
  publishedAt: new Date(Date.now() - 2 * 60 * 1000), // 2 minutes ago
  now: new Date(),
  sources: [
    { domain: 'bloomberg.com', isPrimary: false }
  ],
  headline: 'Company Reports Strong Earnings',
  body: 'The company reported quarterly earnings that exceeded analyst expectations...',
  tags: undefined,
  impact_score: 70,
  market: undefined
};

// Example 3: Old news with low quality
const example3 = {
  publishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
  now: new Date(),
  sources: [
    { domain: 'unknown-site.com', isPrimary: false }
  ],
  headline: 'Opinion: Market Analysis',
  body: 'I think the market might do something interesting in the future...',
  tags: undefined,
  impact_score: 20,
  market: undefined
};

console.log('=== Confidence V2.2 Debug Examples ===\n');

console.log('Example 1: High-quality macro news (k=2, cross-class)');
const result1 = scoreConfidenceV22(example1);
console.log(JSON.stringify(result1.debug, null, 2));
console.log('\n');

console.log('Example 2: Solo Tier-1 fresh content (k=1, solo safety)');
const result2 = scoreConfidenceV22(example2);
console.log(JSON.stringify(result2.debug, null, 2));
console.log('\n');

console.log('Example 3: Old news with low quality (k=1, old, opinion)');
const result3 = scoreConfidenceV22(example3);
console.log(JSON.stringify(result3.debug, null, 2));
