import { getSourceTier } from './sourceTiers';

export type TradingFilterReason =
  | 'allow_markets_macro'
  | 'allow_equities_catalyst'
  | 'allow_crypto'
  | 'allow_commod_fx'
  | 'allow_tier1_domain'
  | 'block_lifestyle'
  | 'block_generic'
  | 'block_politics_non_market'
  | 'unknown';

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(rx => rx.test(text));
}

const ALLOW_MARKETS_MACRO: RegExp[] = [
  /\b(cpi|ppi|nfp|payrolls|pmi|ism)\b/i,
  /\b(fed|fomc|ecb|boe|boj|rate hike|rate cut|q[e|t]\b|quantitative easing|quantitative tightening)\b/i,
  /\b(treasury auction|t-bill|t-bond|yield curve)\b/i,
  /\b(opec|opec\+|production cut|supply cut)\b/i
];

const ALLOW_EQUITIES: RegExp[] = [
  /\b(earnings|guidance|beat|miss|downgrade|upgrade|buyback|dividend)\b/i,
  /\b(8-?k|10-?q|10-?k|s-1|prospectus)\b/i,
  /\b(m&a|merger|acquisition|takeover|activist|layoffs|headcount|hiring)\b/i,
  /\b(insider (buy|sell|trade|trades))\b/i
];

const ALLOW_CRYPTO: RegExp[] = [
  /\b(etf (approval|flows))\b/i,
  /\b(exchange outage|downtime|halt)\b/i,
  /\b(hack|exploit|bridge exploit|depeg|stablecoin)\b/i,
  /\b(on-?chain transfer|whale transfer|large transfer)\b/i,
  /\b(sec|cftc|esma|regulator|regulatory action)\b/i,
  /\b(protocol upgrade|hard fork|soft fork)\b/i
];

const ALLOW_COMMOD_FX: RegExp[] = [
  /\b(supply shock|embargo|sanction|strike)\b/i,
  /\b(fx intervention|currency intervention)\b/i
];

const BLOCK_LIFESTYLE: RegExp[] = [
  /\b(lifestyle|travel|celebrity|gossip|relationship|psychology|self-?help)\b/i,
  /\b(health tips|diet|fitness|wellness)\b/i
];

const BLOCK_GENERIC: RegExp[] = [
  /\b(things to watch|best|worst|how to|guide|tips|review|ranking|list)\b/i,
  /\b(opinion|op-?ed|column)\b/i
];

const BLOCK_POLITICS_NON_MARKET: RegExp[] = [
  /\b(election|campaign|candidate|parliament|senate|congress)\b/i
];

export function isTradingRelevant(
  title: string,
  description: string,
  sourceUrlOrDomain?: string
): { relevant: boolean; reason: TradingFilterReason } {
  const text = `${title} ${description}`.toLowerCase();

  // Path-scoped tier-1 overrides for specific domains
  try {
    if (sourceUrlOrDomain) {
      const hasDot = sourceUrlOrDomain.includes('.') && sourceUrlOrDomain.includes('/');
      const url = hasDot ? new URL(sourceUrlOrDomain) : null;
      const domain = url ? url.hostname.replace(/^www\./, '') : sourceUrlOrDomain;
      const tier = getSourceTier(domain);
      if (tier >= 0.8 && url) {
        const p = url.pathname || '/';
        const allow: Record<string, RegExp> = {
          'cnbc.com': /^\/(markets|economy|finance|technology)/i,
          'ft.com': /^\/(companies|markets|world)/i,
          'wsj.com': /^\/(market|business|economy|finance|tech)/i,
          'reuters.com': /^\/(markets|business|world)/i,
          'bloomberg.com': /^\/news/i,
          'marketwatch.com': /^\/(markets|story)/i,
          'investing.com': /^\/news/i,
          'seekingalpha.com': /^\/news/i,
          'finance.yahoo.com': /^\/news/i,
          'apnews.com': /^\/business/i,
        };
        const deny: Record<string, RegExp> = {
          'cnbc.com': /^\/(make-it|select|opinion|health-and-science|lifestyle)/i,
          'ft.com': /^\/(opinion|life-arts|magazine)/i,
          'wsj.com': /^\/(opinion|style)/i,
          'reuters.com': /^\/lifestyle/i,
          'marketwatch.com': /^\/(personal-finance|opinion|lifestyle)/i,
          'investing.com': /^\/(crypto\/analysis|opinion|education)/i,
          'seekingalpha.com': /^\/(opinions|opinion|blogs)/i,
          'finance.yahoo.com': /^\/(lifestyle|health|entertainment|style)/i,
          'apnews.com': /^\/(lifestyle|entertainment)/i,
        };
        const a = allow[domain];
        const d = deny[domain];
        if (a && a.test(p)) {
          return { relevant: true, reason: 'allow_tier1_domain' };
        }
        if (d && d.test(p)) {
          return { relevant: false, reason: 'block_generic' };
        }
      }
    }
  } catch (_) {
    // ignore URL parse errors
  }

  if (includesAny(text, ALLOW_MARKETS_MACRO)) return { relevant: true, reason: 'allow_markets_macro' };
  if (includesAny(text, ALLOW_EQUITIES)) return { relevant: true, reason: 'allow_equities_catalyst' };
  if (includesAny(text, ALLOW_CRYPTO)) return { relevant: true, reason: 'allow_crypto' };
  if (includesAny(text, ALLOW_COMMOD_FX)) return { relevant: true, reason: 'allow_commod_fx' };

  if (includesAny(text, BLOCK_LIFESTYLE)) return { relevant: false, reason: 'block_lifestyle' };
  if (includesAny(text, BLOCK_POLITICS_NON_MARKET)) return { relevant: false, reason: 'block_politics_non_market' };
  if (includesAny(text, BLOCK_GENERIC)) return { relevant: false, reason: 'block_generic' };

  // Default: not clearly relevant
  return { relevant: false, reason: 'unknown' };
}


