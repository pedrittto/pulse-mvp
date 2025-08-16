export { API_BASE, isUsingProxy } from './apiBase';

// Frontend configuration
export const config = {
  verificationMode: process.env.NEXT_PUBLIC_VERIFICATION_MODE || 'v1',
  apiBase: process.env.NEXT_PUBLIC_API_BASE_URL || '/api'
};
