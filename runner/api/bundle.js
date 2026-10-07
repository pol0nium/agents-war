// GET /api/bundle?file=chase&acct=N (header x-secret) — serves the current chase launcher (lib/chase_script.mjs, generated
// from chase/launch_chase.js by scripts/sync_chase.cjs) with the secret and the first account number filled in.
import chase from '../lib/chase_script.mjs';
import { authorized, CORS } from '../lib/http.mjs';

export function OPTIONS() { return new Response(null, { status: 204, headers: CORS }); }

export function GET(request) {
  // secret via the x-secret header (preferred: secrets don't belong in URLs) or the legacy ?secret= parameter
  if (!authorized(request.headers.get('x-secret') ?? new URL(request.url).searchParams.get('secret'))) return new Response('unauthorized', { status: 401, headers: CORS });
  // ?file=chase&acct=N → the current chase launcher (chase/launch_chase.js) with the secret and NEXT_ACCT filled in.
  const u = new URL(request.url);
  if (u.searchParams.get('file') === 'chase') {
    const acct = Number(u.searchParams.get('acct'));
    if (!Number.isInteger(acct) || acct < 1) return new Response('acct (first never-used pz number) required', { status: 400, headers: CORS });
    const code = chase.replace("'<RUNNER_SECRET from vercel-runner/.env.local>'", JSON.stringify(process.env.RUNNER_SECRET)).replace(/const NEXT_ACCT = \d+;/, `const NEXT_ACCT = ${acct};`);
    return new Response(code, { headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return new Response('unknown file', { status: 404, headers: CORS });
}
