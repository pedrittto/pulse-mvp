// apiBase.ts
const raw = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
const isDev = process.env.NODE_ENV !== 'production';

// In dev always use the proxy base; in prod use the env value.
export const API_BASE = isDev ? '/api' : (raw ? raw.replace(/\/+$/, '') : '');
export const isUsingProxy = API_BASE === '/api';
