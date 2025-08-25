/**
 * Deterministic fact composer for trader-focused content
 * Ultra-fast, rule-based transforms for headlines and summaries
 */

import { extractKeyFact } from '../pipeline/keyFacts.js';

interface RawContent {
  title?: string;
  description?: string;
  body?: string;
  source?: string;
  tickers?: string[];
}

interface ExtractedFacts {
  numbers: string[];
  money: string[];
  percents: string[];
  dates: string[];
  places: string[];
}

// Action verbs whitelist (present tense)
const ACTION_VERBS = [
  "cuts", "raises", "launches", "opens", "closes", "halts", "resumes", 
  "sues", "settles", "acquires", "merges", "invests", "builds", "partners", 
  "licenses", "wins", "loses", "files", "recalls", "appoints", "resigns", 
  "guides", "forecasts", "announces", "expands", "reduces", "increases", 
  "decreases", "plans", "considers", "approves", "rejects", "regulates"
];

// Common places for financial news
const PLACES = [
  "US", "EU", "China", "UK", "Germany", "Japan", "Iceland", "Canada", 
  "Australia", "India", "Brazil", "France", "Italy", "Spain", "Netherlands",
  "Switzerland", "Sweden", "Norway", "Denmark", "Finland", "Poland", 
  "Singapore", "Hong Kong", "South Korea", "Taiwan", "Mexico", "Argentina"
];

// Clickbait prefixes to remove
const CLICKBAIT_PREFIXES = [
  "report:", "opinion:", "analyst says", "sources say", "amid", "breaking:",
  "exclusive:", "urgent:", "alert:", "rumor:", "speculation:"
];

// Soft/speculative words to replace
const SOFT_WORDS = {
  "looks to": "plans",
  "seeks to": "plans", 
  "could": "may",
  "might": "may",
  "reportedly": "according to sources",
  "rumored": "according to sources"
};

/**
 * Normalize text: strip HTML, decode entities, collapse whitespace
 */
export function normalize(text: string): string {
  if (!text) return '';
  
  let result = text;
  
  // Strip HTML tags
  result = result.replace(/<[^>]*>/g, '');
  
  // Decode common HTML entities
  const entities: { [key: string]: string } = {
    '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&apos;': "'",
    '&lt;': '<', '&gt;': '>', '&#39;': "'", '&#x27;': "'",
    '&#x2F;': '/', '&#x60;': '`', '&#x3D;': '=', '&#x2D;': '-',
    '&#x5F;': '_', '&#x2E;': '.', '&#x21;': '!', '&#x28;': '(',
    '&#x29;': ')', '&#x5B;': '[', '&#x5D;': ']', '&#x7B;': '{',
    '&#x7D;': '}', '&#x3A;': ':', '&#x3B;': ';', '&#x2C;': ',',
    '&#x3F;': '?', '&#x40;': '@', '&#23;': '#', '&#24;': '$',
    '&#x25;': '%', '&#5E;': '^', '&#2A;': '*', '&#2B;': '+',
    '&#x7C;': '|', '&#x5C;': '\\', '&#x7E;': '~'
  };
  
  for (const [entity, replacement] of Object.entries(entities)) {
    result = result.replace(new RegExp(entity, 'gi'), replacement);
  }
  
  // Collapse whitespace
  result = result.replace(/\s+/g, ' ').trim();
  
  return result;
}

/**
 * Extract factual elements from text
 */
export function extractFacts(rawText: string): ExtractedFacts {
  const text = rawText.toLowerCase();
  
  // Extract percentages
  const percents = (rawText.match(/(?:\+|-)?\d+(?:\.\d+)?\s?%/g) || [])
    .map(p => p.trim());
  
  // Extract money amounts
  const money = (rawText.match(/\$[\d,.]+[mbk]?/gi) || [])
    .map(m => m.trim());
  
  // Extract numbers (excluding percentages and money)
  const numbers = (rawText.match(/\b\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?\b/g) || [])
    .filter(n => !n.includes('%') && !n.includes('$'))
    .map(n => n.trim());
  
  // Extract dates
  const dates = (rawText.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?\b/gi) || [])
    .map(d => d.trim());
  
  // Extract places
  const places: string[] = [];
  for (const place of PLACES) {
    if (text.includes(place.toLowerCase())) {
      places.push(place);
    }
  }
  
  return {
    numbers: [...new Set(numbers)],
    money: [...new Set(money)],
    percents: [...new Set(percents)],
    dates: [...new Set(dates)],
    places: [...new Set(places)]
  };
}

/**
 * Extract main entity from text
 */
function extractMainEntity(text: string, tickers?: string[]): string {
  // First try tickers if available
  if (tickers && tickers.length > 0) {
    return tickers[0];
  }
  
  // Look for common company/country patterns
  const entityPatterns = [
    /\b(apple|google|microsoft|amazon|tesla|nvidia|amd|intel|meta|netflix|facebook|alphabet)\b/gi,
    /\b(usa|china|japan|uk|germany|france|canada|australia|india|brazil)\b/gi,
    /\b(fed|ecb|boe|boj|treasury|sec|ftc|doj)\b/gi
  ];
  
  for (const pattern of entityPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      return matches[0].charAt(0).toUpperCase() + matches[0].slice(1).toLowerCase();
    }
  }
  
  return '';
}

/**
 * Extract action verb from text
 */
function extractAction(text: string): string {
  const lowerText = text.toLowerCase();
  
  for (const verb of ACTION_VERBS) {
    if (lowerText.includes(verb)) {
      return verb;
    }
  }
  
  // Check for soft words and replace
  for (const [soft, replacement] of Object.entries(SOFT_WORDS)) {
    if (lowerText.includes(soft)) {
      return replacement;
    }
  }
  
  return '';
}

/**
 * Clean text for headline generation
 */
function cleanForHeadline(text: string): string {
  let cleaned = text;
  
  // Remove clickbait prefixes
  for (const prefix of CLICKBAIT_PREFIXES) {
    cleaned = cleaned.replace(new RegExp(`^${prefix}\\s*`, 'gi'), '');
  }
  
  // Remove leading articles/prepositions
  cleaned = cleaned.replace(/^(the|a|an|in|to|at|on|for|with|by|from|of)\s+/i, '');
  
  // Remove unnecessary adjectives and phrases
  cleaned = cleaned.replace(/\b(major|huge|massive|significant|important|key|critical|crucial|here are|these are|what to)\b/gi, '');
  
  // Remove "says" and similar attribution phrases
  cleaned = cleaned.replace(/\b(says|said|reacts to|according to)\b/gi, '');
  
  return cleaned.trim();
}

/**
 * Compose factual headline (≤ 12 words)
 */
export function composeHeadline(raw: RawContent): string {
  const title = normalize(raw.title || '');
  const description = normalize(raw.description || '');
  const combinedText = `${title} ${description}`;
  
  // Extract components
  const entity = extractMainEntity(combinedText, raw.tickers);
  const action = extractAction(combinedText);
  const facts = extractFacts(combinedText);
  
  let headline = '';
  
  // Pattern 1: Entity + Action + Number/Percent
  if (entity && action && (facts.numbers.length > 0 || facts.percents.length > 0)) {
    const number = facts.percents[0] || facts.numbers[0];
    headline = `${entity} ${action} ${number}`;
  }
  // Pattern 2: Entity + Action + Place
  else if (entity && action && facts.places.length > 0) {
    headline = `${entity} ${action} in ${facts.places[0]}`;
  }
  // Pattern 3: Entity + Action
  else if (entity && action) {
    headline = `${entity} ${action}`;
  }
  // Pattern 4: Entity + Number
  else if (entity && (facts.numbers.length > 0 || facts.percents.length > 0)) {
    const number = facts.percents[0] || facts.numbers[0];
    headline = `${entity} ${number}`;
  }
  // Pattern 5: Just entity
  else if (entity) {
    headline = entity;
  }
  
  // Fallback to cleaned original title
  if (!headline.trim()) {
    headline = cleanForHeadline(title);
  }
  
  // GUARDRAILS: Prevent malformed headlines
  const headlineLower = headline.toLowerCase();
  const words = headline.split(' ').filter(word => word.length > 0);
  
  // Guardrail 1: If token count < 4 OR headline lacks alphabetic words, fallback to original
  const hasAlphabeticWord = /[a-zA-Z]/.test(headline);
  if (words.length < 4 || !hasAlphabeticWord) {
    headline = cleanForHeadline(title);
  }
  
  // Guardrail 2: Prevent "Country/Entity Number%" patterns
  const countryNumberPattern = /^[A-Z][a-z]+\s+\d+%?$/;
  if (countryNumberPattern.test(headline)) {
    headline = cleanForHeadline(title);
  }
  
  // Guardrail 3: Prevent headlines starting with numbers only
  const startsWithNumberOnly = /^\d+%?\s*$/.test(headline.trim());
  if (startsWithNumberOnly) {
    headline = cleanForHeadline(title);
  }
  
  // Ensure headline is concise (max 12 words)
  const finalWords = headline.split(' ').filter(word => word.length > 0);
  if (finalWords.length > 12) {
    headline = finalWords.slice(0, 12).join(' ');
  }
  
  // Capitalize properly
  headline = headline.split(' ').map(word => {
    if (word.length === 0) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
  
  return headline.trim();
}

/**
 * Compose factual summary (≤ 25 words)
 */
export function composeSummary(raw: RawContent): string {
  const title = normalize(raw.title || '');
  const description = normalize(raw.description || '');
  const body = normalize(raw.body || '');
  const combinedText = `${title} ${description} ${body}`;
  
  const entity = extractMainEntity(combinedText, raw.tickers);
  const action = extractAction(combinedText);
  const facts = extractFacts(combinedText);
  
  let summary = '';
  
  // Build summary with most material detail
  if (entity && action) {
    summary = `${entity} ${action}`;
    
    // Add key details in priority order
    const details: string[] = [];
    
    if (facts.percents.length > 0) {
      details.push(facts.percents[0]);
    } else if (facts.money.length > 0) {
      details.push(facts.money[0]);
    } else if (facts.numbers.length > 0) {
      details.push(facts.numbers[0]);
    } else if (facts.places.length > 0) {
      details.push(`in ${facts.places[0]}`);
    } else if (facts.dates.length > 0) {
      details.push(`on ${facts.dates[0]}`);
    }
    
    if (details.length > 0) {
      summary += ` ${details[0]}`;
    }
  } else if (entity) {
    summary = entity;
    
    // Add key detail
    if (facts.percents.length > 0) {
      summary += ` ${facts.percents[0]}`;
    } else if (facts.money.length > 0) {
      summary += ` ${facts.money[0]}`;
    } else if (facts.numbers.length > 0) {
      summary += ` ${facts.numbers[0]}`;
    }
  }
  
  // Fallback to cleaned description
  if (!summary.trim()) {
    summary = cleanForHeadline(description || title);
  }
  
  // Ensure summary is concise (max 25 words)
  const words = summary.split(' ').filter(word => word.length > 0);
  if (words.length > 25) {
    summary = words.slice(0, 25).join(' ');
  }
  
  // Capitalize properly
  summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  
  // Extract and append key fact if not already present
  const keyFact = extractKeyFact(combinedText);
  if (keyFact && !summary.toLowerCase().includes(keyFact.value.toLowerCase())) {
    let factSuffix = '';
    
    switch (keyFact.type) {
      case 'percent':
        factSuffix = `(${keyFact.value})`;
        break;
      case 'money':
        factSuffix = `(${keyFact.currency} ${keyFact.value})`;
        break;
      case 'count':
        factSuffix = keyFact.unit ? `(${keyFact.value} ${keyFact.unit})` : `(${keyFact.value})`;
        break;
      case 'date':
        factSuffix = `(${keyFact.value})`;
        break;
      case 'place':
        factSuffix = `(${keyFact.value})`;
        break;
    }
    
    if (factSuffix) {
      summary += ` ${factSuffix}`;
    }
  }
  
  return summary.trim();
}
