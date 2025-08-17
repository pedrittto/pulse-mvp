// Normalization helper to ensure items have consistent fields for UI consumption
function normalizeItem(item: any) {
  // Impact normalization: support string, object, or missing
  let impactCategory: string | null = null;
  let impactScore: number | null = null;
  if (typeof item.impact === 'string') {
    impactCategory = item.impact;
    impactScore = typeof item.impact_score === 'number' ? item.impact_score : null;
  } else if (item.impact && typeof item.impact === 'object') {
    impactCategory = item.impact.category ?? null;
    impactScore = item.impact.score ?? (typeof item.impact_score === 'number' ? item.impact_score : null);
  } else if (typeof item.impact_score === 'number') {
    // Legacy fallback from numeric score
    const s = item.impact_score;
    impactCategory = s >= 80 ? 'C' : s >= 60 ? 'H' : s >= 35 ? 'M' : 'L';
    impactScore = s;
  }

  // Verification normalization
  const verificationState = item.verification?.state ?? item.verification_legacy ?? null;

  // Confidence normalization: prefer categorical; fall back from numeric
  let confidenceState = item.confidence_state ?? null;
  if (!confidenceState && typeof item.confidence === 'number') {
    const n = item.confidence;
    confidenceState = n >= 90 ? 'confirmed' : n >= 75 ? 'verified' : n >= 50 ? 'corroborated' : n >= 25 ? 'reported' : 'unconfirmed';
  }

  return {
    ...item,
    impactCategory,
    impactScore,
    verificationState,
    confidenceState,
  };
}

export async function fetcher(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${text.slice(0,200)}`);
  }
  const data = await res.json();

  // Normalize the response to always return an array of items and shape
  let items: any[] = [];
  if (Array.isArray(data)) {
    items = data;
  } else if (data && typeof data === 'object' && Array.isArray(data.items)) {
    items = data.items;
  }
  return items.map(normalizeItem);
}
