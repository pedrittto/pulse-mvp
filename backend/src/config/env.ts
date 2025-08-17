// Cached configuration object
let cachedConfig: ReturnType<typeof loadConfig> | null = null;

// Load and validate configuration
const loadConfig = () => {
  const config = {
    // Server configuration
    port: Number(process.env.PORT) || 4000,
    nodeEnv: process.env.NODE_ENV || 'development',
    
    // CORS configuration
    allowedOrigins: process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
      : ['*'],
    
    // Rate limiting
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '60', 10),
    
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
    adminAllowPurge: process.env.ADMIN_ALLOW_PURGE === '1',
    
    // Firebase configuration
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
    
    // Cron configuration
    cronSchedule: process.env.CRON_SCHEDULE || '*/3 * * * *'
  };

  // Validate required configuration
  const requiredFields = ['firebaseProjectId'];
  const missingFields = requiredFields.filter(field => !config[field as keyof typeof config]);
  
  if (missingFields.length > 0) {
    throw new Error(`Missing required environment variables: ${missingFields.join(', ')}`);
  }

  return config;
};

// Get cached configuration
export const getConfig = () => {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
};

// Reload configuration (useful for testing)
export const reloadConfig = () => {
  cachedConfig = null;
  return getConfig();
};

// For backward compatibility
export const config = getConfig();
