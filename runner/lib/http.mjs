export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
};
export const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
export const authorized = (secret) => !!process.env.RUNNER_SECRET && secret === process.env.RUNNER_SECRET;
export const safeId = (s) => String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
