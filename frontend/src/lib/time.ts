export function pickArrival(item: any): string {
  // Canonical field: use arrival_at only, with fallbacks
  return item.arrival_at ?? item.ingested_at ?? item.published_at;
}

export function formatHHMMLocal(iso: string): string {
  const d = new Date(iso);
  
  // Dead simple formatting - no rounding, no bucketing
  const hours = d.getHours();
  const minutes = d.getMinutes();
  
  // Format as HH:MM with leading zeros
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

export function formatRelativeTime(dateISOString: string): string {
  const now = Date.now();
  const date = new Date(dateISOString).getTime();
  const diffMs = now - date;
  const diffSeconds = Math.floor(diffMs / 1000);
  
  // Rules for relative time display
  if (diffSeconds < 5) {
    return 'just now';
  }
  
  if (diffSeconds < 60) {
    return `${diffSeconds} seconds ago`;
  }
  
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  }
  
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  }
  
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) {
    return 'yesterday';
  }
  
  if (diffDays === 2) {
    return '2 days ago';
  }
  
  // For 3+ days, show absolute date in local format
  const dateObj = new Date(dateISOString);
  return dateObj.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric' 
  });
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
