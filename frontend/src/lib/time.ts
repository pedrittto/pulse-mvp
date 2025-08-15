export function pickArrival(item: any): string {
  return item.arrival_at ?? item.ingested_at ?? item.published_at;
}

export function formatHHMMLocal(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function freshnessLabel(publishedISO: string): {label: string, level: 'flash'|'new'|'old'|'veryold', tooltip: string} {
  const now = Date.now();
  const t = new Date(publishedISO).getTime();
  const diffMin = Math.max(0, Math.round((now - t) / 60000));
  const tooltip = `${diffMin} min temu`;
  
  if (diffMin < 15) return { label: 'Błyskawica', level: 'flash', tooltip };
  if (diffMin < 60) return { label: 'Nowe', level: 'new', tooltip };
  if (diffMin < 360) return { label: 'Stare', level: 'old', tooltip };
  return { label: 'Bardzo stare', level: 'veryold', tooltip };
}
