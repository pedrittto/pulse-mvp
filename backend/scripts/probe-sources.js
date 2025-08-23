const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function loadFeeds() {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'src', 'config', 'rssFeeds.js'),
    path.join(__dirname, '..', 'dist', 'config', 'rssFeeds.js'),
    path.join(__dirname, '..', 'src',  'config', 'rssFeeds.js'),
    path.join(__dirname, '..', 'src',  'config', 'rssFeeds.ts'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const mod = require(p);
      return mod.default || mod;
    }
  }
  console.error('FATAL: Cannot load rssFeeds from dist/src. Run `npm --prefix backend run build` first.');
  process.exit(1);
}

const mod = loadFeeds();
const rssFeeds = mod.rssFeeds || mod.default?.rssFeeds || mod;
const PORT = process.env.PORT || 4000;
const artifactsDir = path.join(__dirname, '..', 'artifacts');
if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

function request(method, url, timeoutMs = 3000, maxBytes = 32768) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const opts = { method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + (u.search || ''), headers: { 'User-Agent': 'PulseProbe/1.0' } };
      const req = lib.request(opts, (res) => {
        let data = Buffer.alloc(0);
        res.on('data', (chunk) => {
          if (method === 'HEAD') return; // ignore body
          if (data.length < maxBytes) data = Buffer.concat([data, chunk].slice(0, 2));
        });
        res.on('end', () => {
          const ct = res.headers['content-type'] || '';
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      });
      req.on('error', (e) => resolve({ error: e.message }));
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); resolve({ error: 'timeout' }); });
      req.end();
    } catch (e) { resolve({ error: e.message }); }
  });
}

function isXml(buffer) {
  try {
    const s = buffer.toString('utf8', 0, Math.min(1024, buffer.length)).toLowerCase();
    return s.includes('<?xml') || s.includes('<rss');
  } catch { return false; }
}

(async () => {
  const enabled = (rssFeeds || []).filter(s => s.enabled !== false);
  const results = [];
  let fastlaneOk = 0;
  for (const s of enabled) {
    let status = null, contentType = null, xml = false, redirectedTo = null, server = null;
    let url = s.url;
    // HEAD first
    let r = await request('HEAD', url, 3000);
    if (r && r.status && (r.status === 301 || r.status === 302) && r.headers && r.headers.location) {
      try {
        const loc = r.headers.location;
        const nu = new URL(loc, url);
        if (nu.protocol === 'https:' || nu.origin === new URL(url).origin) {
          redirectedTo = nu.toString();
          url = redirectedTo;
          r = await request('HEAD', url, 3000);
        }
      } catch {}
    }
    if (!r || r.error || (r.status && r.status >= 400) || (r.status && r.status === 405)) {
      // Retry with GET
      r = await request('GET', url, 3000, 32768);
    }
    if (r) {
      status = r.status || (r.error ? -1 : null);
      contentType = r.headers ? (r.headers['content-type'] || '') : null;
      server = r.headers ? (r.headers['server'] || '') : null;
      const ctLower = String(contentType || '').toLowerCase();
      const isXmlByCT = /^(application|text)\/(rss\+xml|atom\+xml|xml)/i.test(ctLower);
      if (status === 200 && isXmlByCT) {
        xml = true;
      } else {
        // Fallback short GET sniff (cap body, quick timeout)
        const rg = await request('GET', url, 3000, 32768);
        if (rg && rg.body && rg.body.length) {
          const head = rg.body.slice(0, 4096).toString('utf8');
          const headTrim = head.trim();
          xml = headTrim.startsWith('<') && (head.includes('<rss') || head.includes('<feed'));
          // Preserve original status/contentType from HEAD, do not overwrite
        }
      }
    }
    const rec = { name: s.name, url: s.url, status, contentType, isXml: xml, server, redirectedTo };
    results.push(rec);
    const isFast = s.fastlane !== false;
    if (isFast && status === 200 && xml) fastlaneOk++;
    console.log(`${s.name.padEnd(22)} ${String(status).padStart(3)}  ${String(xml).padEnd(5)}  ${String(contentType||'').slice(0,40)}`);
  }
  const out = path.join(artifactsDir, `probe_sources_${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (enabled.filter(s => s.fastlane !== false).length > 0 && fastlaneOk === 0) {
    console.error('No fastlane sources returned 200+XML');
    process.exit(1);
  }
})();


