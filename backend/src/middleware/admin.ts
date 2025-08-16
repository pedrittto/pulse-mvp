import { Request, Response, NextFunction } from 'express';

// Environment getter functions (lazy loading after dotenv is initialized)
const getAdminTokens = (): string[] => {
  const adminToken = process.env.ADMIN_TOKEN;
  const adminTokens = process.env.ADMIN_TOKENS;
  
  if (adminTokens) {
    // Support comma-separated list of tokens
    return adminTokens.split(',').map(token => token.trim()).filter(Boolean);
  }
  
  if (adminToken) {
    return [adminToken];
  }
  
  return [];
};

const getAdminAllowPurge = (): boolean => {
  return process.env.ADMIN_ALLOW_PURGE === '1';
};

// Extract token from request headers
const extractToken = (req: Request): string | null => {
  // Primary: Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  
  // Fallback: X-Admin-Token header
  const adminTokenHeader = req.headers['x-admin-token'];
  if (adminTokenHeader && typeof adminTokenHeader === 'string') {
    return adminTokenHeader;
  }
  
  return null;
};

// Main admin authentication middleware
export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  const tokens = getAdminTokens();
  
  if (tokens.length === 0) {
    console.error('[admin] No admin tokens configured');
    res.status(500).json({
      error: 'Admin authentication not configured',
      code: 'ADMIN_NOT_CONFIGURED'
    });
    return;
  }
  
  const providedToken = extractToken(req);
  
  if (!providedToken) {
    console.warn('[admin] No token provided');
    res.status(401).json({
      error: 'Admin token required',
      code: 'TOKEN_REQUIRED'
    });
    return;
  }
  
  const isValidToken = tokens.includes(providedToken);
  
  if (!isValidToken) {
    console.warn('[admin] Invalid token provided');
    res.status(401).json({
      error: 'Invalid admin token',
      code: 'INVALID_TOKEN'
    });
    return;
  }
  
  // Token is valid, proceed
  next();
};

// Middleware for destructive operations that require ADMIN_ALLOW_PURGE
export const requireAdminPurge = (req: Request, res: Response, next: NextFunction): void => {
  // First check admin authentication
  requireAdmin(req, res, (err?: any) => {
    if (err) return next(err);
    
    // Then check if purge is allowed
    if (!getAdminAllowPurge()) {
      console.warn('[admin] Purge operation blocked - ADMIN_ALLOW_PURGE not enabled');
      res.status(403).json({
        error: 'Purge operations not allowed',
        code: 'PURGE_NOT_ALLOWED'
      });
      return;
    }
    
    next();
  });
};

// Runtime diagnostics function
export const logAdminDiagnostics = (): void => {
  const tokens = getAdminTokens();
  const allowPurge = getAdminAllowPurge();
  
  console.log(`[admin] mode=${tokens.length > 0 ? 'enabled' : 'disabled'}, schemes=["bearer","x-admin-token"], tokens=${tokens.length} configured, allow_purge=${allowPurge}`);
};
