import http from 'http';

let server: http.Server | null = null;
let timer: NodeJS.Timeout | null = null;
let counter = 0;
let lastItem: { id: string; title: string; pub: string; link: string } | null = null;

function buildRss(nowIso: string) {
  const item = lastItem;
  const itemXml = item ? `
    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <pubDate>${new Date(item.pub).toUTCString()}</pubDate>
      <guid isPermaLink="false">${escapeXml(item.id)}</guid>
    </item>
  ` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>SyntheticControl</title>
    <link>http://localhost/</link>
    <description>Control feed for E2E</description>
    <lastBuildDate>${new Date(nowIso).toUTCString()}</lastBuildDate>
    ${itemXml}
  </channel>
</rss>`;
}

function escapeXml(s: string) { return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c] as string)); }

export function startControlFeed(): void {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.CONTROL_FEED_ENABLED !== '1') return;
  const port = parseInt(process.env.CONTROL_FEED_PORT || '4099', 10);
  if (server) return;
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/rss')) {
      const now = new Date().toISOString();
      res.setHeader('Content-Type', 'application/rss+xml');
      res.end(buildRss(now));
    } else {
      res.statusCode = 404; res.end('not found');
    }
  });
  server.listen(port, '0.0.0.0', () => {
    console.log('[controlFeed] listening', { port });
  });
  timer = setInterval(() => {
    const pub = new Date().toISOString();
    counter++;
    lastItem = {
      id: `synthetic-${counter.toString(36)}`,
      title: `Synthetic item ${counter}`,
      pub,
      link: `http://localhost:${port}/item/${counter}`
    };
  }, 10000);
}

export function stopControlFeed(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (server) { try { server.close(); } catch {} server = null; }
}


