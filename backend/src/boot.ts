// Minimal bootstrap to surface pre-listen errors
(async () => {
  try {
    await import('./index.js'); // ESM path after build
  } catch (e) {
    // Ensure we always see the error in Cloud Run logs
    try { console.error('[fatal-before-listen]', e); } catch {}
    process.exit(1);
  }
})();


