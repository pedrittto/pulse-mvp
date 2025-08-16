export const getConfig = () => ({
  port: process.env.PORT || 4000,
  allowedOrigins: process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
    : ['*'],
  // Breaking Mode configuration
  breakingMode: process.env.BREAKING_MODE === '1',
  breakingLogLevel: process.env.BREAKING_LOG_LEVEL || 'info',
  verificationMode: process.env.VERIFICATION_MODE || 'v1',
  impactMode: process.env.IMPACT_MODE || 'v3',
  // Breaking sources and event windows JSON
  breakingSourcesJson: process.env.BREAKING_SOURCES_JSON,
  eventWindowsJson: process.env.EVENT_WINDOWS_JSON,
  // Source request timeout
  sourceRequestTimeoutMs: parseInt(process.env.SOURCE_REQUEST_TIMEOUT_MS || '8000', 10),
  // Admin configuration
  adminToken: process.env.ADMIN_TOKEN,
  adminTokens: process.env.ADMIN_TOKENS,
  adminAllowPurge: process.env.ADMIN_ALLOW_PURGE === '1'
});

// For backward compatibility
export const config = getConfig();
