import { setGlobalDispatcher, Agent } from 'undici';
import CacheableLookup from 'cacheable-lookup';
import dns from 'node:dns';

try {
	// Prefer IPv4 first to avoid slow AAAA fallbacks
	dns.setDefaultResultOrder?.('ipv4first');
} catch {}

const cacheable = new CacheableLookup({
	maxTtl: 60,
	errorTtl: 5,
	fallbackDuration: 3600
});

// Global Undici agent with keep-alive enabled and conservative per-origin connections
const agent = new Agent({
	keepAliveTimeout: 10_000,
	keepAliveMaxTimeout: 60_000,
	pipelining: 1,
	connections: 8,
	connect: { lookup: cacheable.lookup as any }
});

setGlobalDispatcher(agent);

export { agent };


