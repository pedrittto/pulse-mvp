import { setGlobalDispatcher, Agent } from 'undici';
import dns from 'node:dns';

try {
	// Prefer IPv4 first to avoid slow AAAA fallbacks
	dns.setDefaultResultOrder?.('ipv4first');
} catch {}

// Flag: HTTP/2 enablement (ALPN). Default OFF. Safe fallback to HTTP/1.1.
const HTTP2_ENABLED = String(process.env.HTTP2_ENABLED || '0') === '1';

// DNS cache removed for compatibility; rely on Node resolver

// Global Undici agent with keep-alive enabled and conservative per-origin connections
// Note: Undici Agent provides HTTP/1.1. If HTTP2_ENABLED is set, ALPN is attempted by
// the underlying TLS stack when using Client/Pools; current global Agent path safely
// continues using HTTP/1.1 unless an HTTP/2-aware dispatcher is installed.
// This wiring ensures flag presence and safe fallback; future phases can install
// an h2-capable dispatcher when HTTP2_ENABLED=true without changing call sites.
const agent = new Agent({
	keepAliveTimeout: 10_000,
	keepAliveMaxTimeout: 60_000,
	pipelining: 1,
	connections: 8,
	// no custom lookup
});

setGlobalDispatcher(agent);

export { agent };


