export async function fetcher(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${text.slice(0,200)}`);
  }
  const data = await res.json();
  
  // Normalize the response to always return an array of items
  if (Array.isArray(data)) {
    return data;
  } else if (data && typeof data === 'object' && Array.isArray(data.items)) {
    return data.items;
  } else {
    return [];
  }
}
