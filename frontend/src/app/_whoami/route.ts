export async function GET() {
  const whoami = {
    who: 'frontend',
    port: process.env.PORT || 'unknown',
    sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || null
  };

  return new Response(JSON.stringify(whoami), {
    headers: { 'content-type': 'application/json' }
  });
}
