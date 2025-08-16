import * as fs from 'fs';
import * as path from 'path';

// Types for Impact V3
export interface ImpactV3Config {
  weights: {
    surprise: number;
    credibility: number;
    pnlProximity: number;
    timingLiquidity: number;
    scale: number;
  };
  thresholds: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  calibration: {
    enabled: boolean;
    points: Array<{input: number, output: number}>;
  };
}

export interface ImpactV3Driver {
  name: string;
  value: number;
  fallback?: boolean;
  details?: any;
}

export interface ImpactV3Result {
  raw: number;
  category: 'L' | 'M' | 'H' | 'C';
  drivers: ImpactV3Driver[];
  meta: {
    version: 'v3';
    weights: ImpactV3Config['weights'];
    thresholds: ImpactV3Config['thresholds'];
    calibration: ImpactV3Config['calibration'];
  };
}

export interface ImpactV3Input {
  headline: string;
  description: string;
  sources: string[];
  tickers: string[];
  published_at: string;
  tags?: string[];
}

// Default configuration
const DEFAULT_CONFIG: ImpactV3Config = {
  weights: {
    surprise: 0.35,
    credibility: 0.20,
    pnlProximity: 0.25,
    timingLiquidity: 0.10,
    scale: 0.10
  },
  thresholds: {
    low: 0.35,
    medium: 0.60,
    high: 0.80,
    critical: 1.00
  },
  calibration: {
    enabled: true,
    points: [
      {input: 0.0, output: 0.0},
      {input: 0.3, output: 0.25},
      {input: 0.5, output: 0.45},
      {input: 0.7, output: 0.65},
      {input: 0.9, output: 0.85},
      {input: 1.0, output: 1.0}
    ]
  }
};

// Environment getter functions
const getImpactV3Config = () => process.env.IMPACT_V3_CONFIG;
const getImpactV3Compare = () => process.env.IMPACT_V3_COMPARE;

// Load configuration from file if specified
export function loadConfig(): ImpactV3Config {
  const configPath = getImpactV3Config();
  if (!configPath) {
    return DEFAULT_CONFIG;
  }

  try {
    const fullPath = path.resolve(configPath);
    if (fs.existsSync(fullPath)) {
      const configData = fs.readFileSync(fullPath, 'utf8');
      const loadedConfig = JSON.parse(configData);
      return { ...DEFAULT_CONFIG, ...loadedConfig };
    }
  } catch (error) {
    console.warn('Failed to load Impact V3 config from', configPath, error);
  }
  
  return DEFAULT_CONFIG;
}

// Surprise driver: how far news deviates from expectations
function computeSurpriseDriver(input: ImpactV3Input): ImpactV3Driver {
  const text = `${input.headline} ${input.description}`.toLowerCase();
  
  // Earnings vs consensus patterns
  const earningsPatterns = [
    { pattern: /earnings.*beat.*consensus/i, score: 0.9 },
    { pattern: /earnings.*miss.*consensus/i, score: 0.9 },
    { pattern: /earnings.*surprise/i, score: 0.8 },
    { pattern: /earnings.*unexpected/i, score: 0.8 },
    { pattern: /guidance.*raise/i, score: 0.7 },
    { pattern: /guidance.*cut/i, score: 0.7 },
    { pattern: /guidance.*surprise/i, score: 0.7 }
  ];

  for (const { pattern, score } of earningsPatterns) {
    if (pattern.test(text)) {
      return {
        name: 'surprise',
        value: score,
        details: { type: 'earnings_consensus', pattern: pattern.source }
      };
    }
  }

  // Unexpected/emergency patterns
  const unexpectedPatterns = [
    { pattern: /emergency|urgent|immediate|halt|suspend/i, score: 0.8 },
    { pattern: /unexpected|surprise|shock/i, score: 0.7 },
    { pattern: /sudden|abrupt|unforeseen/i, score: 0.6 },
    { pattern: /plans|considers|may|could/i, score: 0.3 },
    { pattern: /expected|anticipated|forecast/i, score: 0.2 }
  ];

  for (const { pattern, score } of unexpectedPatterns) {
    if (pattern.test(text)) {
      return {
        name: 'surprise',
        value: score,
        details: { type: 'unexpected_event', pattern: pattern.source }
      };
    }
  }

  // Regulatory unexpectedness
  const regulatoryPatterns = [
    { pattern: /regulator.*ban|ban.*regulator/i, score: 0.9 },
    { pattern: /investigation.*launch|launch.*investigation/i, score: 0.7 },
    { pattern: /fine.*million|penalty.*million/i, score: 0.6 },
    { pattern: /regulatory.*approval|approval.*regulator/i, score: 0.4 }
  ];

  for (const { pattern, score } of regulatoryPatterns) {
    if (pattern.test(text)) {
      return {
        name: 'surprise',
        value: score,
        details: { type: 'regulatory_action', pattern: pattern.source }
      };
    }
  }

  // Default neutral score
  return {
    name: 'surprise',
    value: 0.5,
    fallback: true,
    details: { type: 'neutral', reason: 'no_surprise_indicators' }
  };
}

// Credibility driver: source authority and verifiability
function computeCredibilityDriver(input: ImpactV3Input): ImpactV3Driver {
  const sources = input.sources || [];
  if (sources.length === 0) {
    return {
      name: 'credibility',
      value: 0.3,
      fallback: true,
      details: { type: 'no_sources' }
    };
  }

  const firstSource = sources[0].toLowerCase();
  
  // Official/regulatory sources (highest credibility)
  const officialPatterns = [
    /sec\.gov|sec\.com/i,
    /federal.*reserve|fed\.gov/i,
    /treasury\.gov/i,
    /whitehouse\.gov/i,
    /congress\.gov/i,
    /filing|form.*10-|form.*8-|form.*4/i
  ];

  for (const pattern of officialPatterns) {
    if (pattern.test(firstSource)) {
      return {
        name: 'credibility',
        value: 1.0,
        details: { type: 'official_source', source: firstSource }
      };
    }
  }

  // Tier-1 financial media
  const tier1Sources = [
    'bloomberg', 'reuters', 'wsj', 'wall street journal', 'financial times', 'ft'
  ];

  for (const tier1 of tier1Sources) {
    if (firstSource.includes(tier1)) {
      return {
        name: 'credibility',
        value: 0.9,
        details: { type: 'tier1_media', source: firstSource }
      };
    }
  }

  // Tier-2 financial media
  const tier2Sources = [
    'cnbc', 'marketwatch', 'yahoo finance', 'barrons', 'forbes'
  ];

  for (const tier2 of tier2Sources) {
    if (firstSource.includes(tier2)) {
      return {
        name: 'credibility',
        value: 0.7,
        details: { type: 'tier2_media', source: firstSource }
      };
    }
  }

  // Tech/industry media
  const techSources = [
    'techcrunch', 'the verge', 'ars technica', 'wired', 'recode'
  ];

  for (const tech of techSources) {
    if (firstSource.includes(tech)) {
      return {
        name: 'credibility',
        value: 0.6,
        details: { type: 'tech_media', source: firstSource }
      };
    }
  }

  // On-record attribution patterns
  const text = `${input.headline} ${input.description}`.toLowerCase();
  const onRecordPatterns = [
    /ceo.*said|said.*ceo/i,
    /executive.*said|said.*executive/i,
    /spokesperson.*said|said.*spokesperson/i,
    /official.*said|said.*official/i,
    /according.*to.*company|company.*said/i
  ];

  let onRecordBonus = 0;
  for (const pattern of onRecordPatterns) {
    if (pattern.test(text)) {
      onRecordBonus = 0.1;
      break;
    }
  }

  // Unverified/rumor patterns (penalty)
  const rumorPatterns = [
    /rumor|rumored/i,
    /sources.*say|people.*familiar/i,
    /reportedly|allegedly/i,
    /anonymous.*source/i
  ];

  let rumorPenalty = 0;
  for (const pattern of rumorPatterns) {
    if (pattern.test(text)) {
      rumorPenalty = -0.2;
      break;
    }
  }

  // Base score for unknown sources
  const baseScore = 0.4;
  const finalScore = Math.max(0, Math.min(1, baseScore + onRecordBonus + rumorPenalty));

  return {
    name: 'credibility',
    value: finalScore,
    details: {
      type: 'unknown_source',
      source: firstSource,
      onRecordBonus,
      rumorPenalty
    }
  };
}

// P&L proximity driver: directness of path to cash flows
function computePnlProximityDriver(input: ImpactV3Input): ImpactV3Driver {
  const text = `${input.headline} ${input.description}`.toLowerCase();
  const tickers = input.tickers || [];

  // Direct named tickers with clear action
  const directActionPatterns = [
    { pattern: /ban|recall|suspend|halt/i, score: 0.9 },
    { pattern: /guidance.*raise|guidance.*cut/i, score: 0.8 },
    { pattern: /contract.*win|contract.*loss/i, score: 0.8 },
    { pattern: /acquisition|merger|buyout/i, score: 0.8 },
    { pattern: /layoff|restructure|bankruptcy/i, score: 0.8 },
    { pattern: /fine|penalty|settlement/i, score: 0.7 },
    { pattern: /price.*cut|price.*increase/i, score: 0.7 },
    { pattern: /partnership|deal|agreement/i, score: 0.6 }
  ];

  for (const { pattern, score } of directActionPatterns) {
    if (pattern.test(text)) {
      const tickerBonus = tickers.length > 0 ? 0.1 : 0;
      return {
        name: 'pnlProximity',
        value: Math.min(1, score + tickerBonus),
        details: {
          type: 'direct_action',
          pattern: pattern.source,
          tickers: tickers,
          tickerBonus
        }
      };
    }
  }

  // Sectoral impact
  const sectoralPatterns = [
    { pattern: /tech.*sector|technology.*sector/i, score: 0.6 },
    { pattern: /banking.*sector|financial.*sector/i, score: 0.6 },
    { pattern: /energy.*sector|oil.*sector/i, score: 0.6 },
    { pattern: /healthcare.*sector|pharma.*sector/i, score: 0.6 }
  ];

  for (const { pattern, score } of sectoralPatterns) {
    if (pattern.test(text)) {
      return {
        name: 'pnlProximity',
        value: score,
        details: { type: 'sectoral_impact', pattern: pattern.source }
      };
    }
  }

  // Macro-diffuse (lowest proximity)
  const macroPatterns = [
    /fed|federal.*reserve/i,
    /interest.*rate|monetary.*policy/i,
    /cpi|inflation|ppi/i,
    /jobs.*report|employment/i,
    /opec|oil.*cut/i,
    /war|geopolitics/i,
    /tariff|sanction/i
  ];

  for (const pattern of macroPatterns) {
    if (pattern.test(text)) {
      return {
        name: 'pnlProximity',
        value: 0.3,
        details: { type: 'macro_diffuse', pattern: pattern.source }
      };
    }
  }

  // Default based on ticker presence
  const baseScore = tickers.length > 0 ? 0.5 : 0.3;
  return {
    name: 'pnlProximity',
    value: baseScore,
    details: { type: 'default', tickers: tickers }
  };
}

// Timing & liquidity driver: session state and liquidity context
function computeTimingLiquidityDriver(input: ImpactV3Input): ImpactV3Driver {
  if (!input.published_at) {
    return {
      name: 'timingLiquidity',
      value: 0.5,
      fallback: true,
      details: { type: 'no_timestamp' }
    };
  }

  const published = new Date(input.published_at);
  const hour = published.getUTCHours();
  const dayOfWeek = published.getUTCDay(); // 0 = Sunday, 6 = Saturday

  // Market hours (simplified - could be enhanced with actual exchange calendars)
  // Assume US market hours: 9:30 AM - 4:00 PM ET (14:30 - 21:00 UTC)
  const isMarketHours = hour >= 14 && hour < 21;
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  let sessionScore = 0.5; // Default neutral

  if (isWeekday && isMarketHours) {
    sessionScore = 0.9; // Regular session
  } else if (isWeekday && (hour >= 4 && hour < 14)) {
    sessionScore = 0.7; // Pre-market
  } else if (isWeekday && (hour >= 21 || hour < 4)) {
    sessionScore = 0.3; // After-hours
  } else {
    sessionScore = 0.2; // Weekend
  }

  // Event windows
  const text = `${input.headline} ${input.description}`.toLowerCase();
  const eventPatterns = [
    { pattern: /fomc|federal.*reserve.*meeting/i, score: 0.9 },
    { pattern: /cpi.*report|inflation.*data/i, score: 0.8 },
    { pattern: /jobs.*report|employment.*data/i, score: 0.8 },
    { pattern: /earnings.*call|earnings.*report/i, score: 0.7 },
    { pattern: /fed.*speech|central.*bank.*speech/i, score: 0.6 }
  ];

  let eventBonus = 0;
  for (const { pattern, score } of eventPatterns) {
    if (pattern.test(text)) {
      eventBonus = score * 0.3; // Event bonus is 30% of the event score
      break;
    }
  }

  const finalScore = Math.min(1, sessionScore + eventBonus);

  return {
    name: 'timingLiquidity',
    value: finalScore,
    details: {
      type: 'session_timing',
      hour,
      dayOfWeek,
      isMarketHours,
      isWeekday,
      sessionScore,
      eventBonus
    }
  };
}

// Scale driver: magnitude and breadth of fundamental change
function computeScaleDriver(input: ImpactV3Input): ImpactV3Driver {
  const text = `${input.headline} ${input.description}`.toLowerCase();

  // EPS magnitude buckets
  const epsPatterns = [
    { pattern: /eps.*beat.*\d+%|eps.*miss.*\d+%/i, score: 0.8 },
    { pattern: /revenue.*beat.*\d+%|revenue.*miss.*\d+%/i, score: 0.7 },
    { pattern: /guidance.*\d+%|forecast.*\d+%/i, score: 0.6 }
  ];

  for (const { pattern, score } of epsPatterns) {
    if (pattern.test(text)) {
      return {
        name: 'scale',
        value: score,
        details: { type: 'eps_magnitude', pattern: pattern.source }
      };
    }
  }

  // Regulatory severity tiers
  const regulatoryPatterns = [
    { pattern: /ban.*permanent|permanent.*ban/i, score: 0.9 },
    { pattern: /recall.*all|all.*recall/i, score: 0.9 },
    { pattern: /sanction.*country|country.*sanction/i, score: 0.9 },
    { pattern: /investigation.*criminal|criminal.*investigation/i, score: 0.8 },
    { pattern: /fine.*billion|penalty.*billion/i, score: 0.8 },
    { pattern: /investigation.*launch|launch.*investigation/i, score: 0.6 },
    { pattern: /notice.*violation|violation.*notice/i, score: 0.4 }
  ];

  for (const { pattern, score } of regulatoryPatterns) {
    if (pattern.test(text)) {
      return {
        name: 'scale',
        value: score,
        details: { type: 'regulatory_severity', pattern: pattern.source }
      };
    }
  }

  // Geographic/sector breadth
  const breadthPatterns = [
    { pattern: /global|worldwide|international/i, score: 0.8 },
    { pattern: /nationwide|countrywide/i, score: 0.7 },
    { pattern: /multiple.*states|several.*states/i, score: 0.6 },
    { pattern: /entire.*industry|whole.*sector/i, score: 0.7 },
    { pattern: /all.*companies|every.*company/i, score: 0.6 }
  ];

  for (const { pattern, score } of breadthPatterns) {
    if (pattern.test(text)) {
      return {
        name: 'scale',
        value: score,
        details: { type: 'geographic_breadth', pattern: pattern.source }
      };
    }
  }

  // Company size indicators
  const sizePatterns = [
    { pattern: /fortune.*500|s&p.*500/i, score: 0.7 },
    { pattern: /mega.*cap|large.*cap/i, score: 0.6 },
    { pattern: /small.*cap|micro.*cap/i, score: 0.4 }
  ];

  for (const { pattern, score } of sizePatterns) {
    if (pattern.test(text)) {
      return {
        name: 'scale',
        value: score,
        details: { type: 'company_size', pattern: pattern.source }
      };
    }
  }

  // Default based on ticker count (proxy for scale)
  const tickerCount = input.tickers?.length || 0;
  const baseScore = tickerCount === 0 ? 0.3 : 
                   tickerCount === 1 ? 0.4 : 
                   tickerCount === 2 ? 0.5 : 0.6;

  return {
    name: 'scale',
    value: baseScore,
    details: { type: 'default', tickerCount }
  };
}

// Apply calibration curve to avoid mid-bucket clumping
function applyCalibration(rawScore: number, config: ImpactV3Config): number {
  if (!config.calibration.enabled || !config.calibration.points) {
    return rawScore;
  }

  const points = config.calibration.points;
  
  // Find the two points to interpolate between
  let lowerPoint = points[0];
  let upperPoint = points[points.length - 1];

  for (let i = 0; i < points.length - 1; i++) {
    if (rawScore >= points[i].input && rawScore <= points[i + 1].input) {
      lowerPoint = points[i];
      upperPoint = points[i + 1];
      break;
    }
  }

  // Linear interpolation
  const ratio = (rawScore - lowerPoint.input) / (upperPoint.input - lowerPoint.input);
  return lowerPoint.output + ratio * (upperPoint.output - lowerPoint.output);
}

// Map raw score to category
function mapToCategory(rawScore: number, config: ImpactV3Config): 'L' | 'M' | 'H' | 'C' {
  const { thresholds } = config;
  
  if (rawScore >= thresholds.critical) return 'C';
  if (rawScore >= thresholds.high) return 'H';
  if (rawScore >= thresholds.medium) return 'M';
  return 'L';
}

// Main Impact V3 scoring function
export function scoreImpactV3(input: ImpactV3Input): ImpactV3Result {
  const config = loadConfig();

  // Compute all drivers
  const surprise = computeSurpriseDriver(input);
  const credibility = computeCredibilityDriver(input);
  const pnlProximity = computePnlProximityDriver(input);
  const timingLiquidity = computeTimingLiquidityDriver(input);
  const scale = computeScaleDriver(input);

  const drivers = [surprise, credibility, pnlProximity, timingLiquidity, scale];

  // Weighted sum
  let rawScore = 0;
  rawScore += surprise.value * config.weights.surprise;
  rawScore += credibility.value * config.weights.credibility;
  rawScore += pnlProximity.value * config.weights.pnlProximity;
  rawScore += timingLiquidity.value * config.weights.timingLiquidity;
  rawScore += scale.value * config.weights.scale;

  // Apply calibration
  const calibratedScore = applyCalibration(rawScore, config);

  // Map to category
  const category = mapToCategory(calibratedScore, config);

  return {
    raw: calibratedScore,
    category,
    drivers,
    meta: {
      version: 'v3',
      weights: config.weights,
      thresholds: config.thresholds,
      calibration: config.calibration
    }
  };
}

// Comparison logging for A/B testing
export function logImpactComparison(
  input: ImpactV3Input,
  v2Score: number,
  v2Category: string,
  v3Result: ImpactV3Result
): void {
  if (getImpactV3Compare() !== '1') {
    return;
  }

  console.log(JSON.stringify({
    type: 'impact_compare',
    headline: input.headline?.substring(0, 50),
    v2_score: v2Score,
    v2_category: v2Category,
    v3_raw: v3Result.raw,
    v3_category: v3Result.category,
    v3_drivers: v3Result.drivers.map(d => ({ name: d.name, value: d.value })),
    timestamp: new Date().toISOString()
  }));
}
