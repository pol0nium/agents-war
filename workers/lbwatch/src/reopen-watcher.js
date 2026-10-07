// aw-lbwatch — REOPEN WATCHER (2026-10-07 16:35 UTC). The competition was closed by the organizers ("Competition
// unavailable", getCompetition → available:false). Every 5 min: ONE read-only getCompetition call; push ONE ntfy
// notification (via the Vercel runner relay) when availability changes. The full leaderboard watcher is saved in
// src/index.full-lbwatch.js.bak (restore it + set the cron back to */1 if the race resumes).
const URL_COMP = 'https://superchallenge.io/api/rpc/superchallenge/getCompetition';
const HEADERS = { 'content-type': 'application/json', 'x-product-id': 'superchallenge', origin: 'https://superchallenge.io', referer: 'https://superchallenge.io/play/SUPERCHALLENGE-JAWVUX', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' };
const BODY = JSON.stringify({ json: { productId: 'superchallenge', code: 'JAWVUX' } });
const RELAY = 'https://<your-runner>.vercel.app/api/log';

async function kv(env, k, v) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)').run();
  if (v === undefined) { const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first(); return r ? JSON.parse(r.v) : null; }
  await env.DB.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').bind(k, JSON.stringify(v)).run();
}
const push = (env, title, body, priority) => env.RELAY_SECRET ? fetch(RELAY, { method: 'POST', headers: { 'content-type': 'text/plain' },
  body: JSON.stringify({ secret: env.RELAY_SECRET, notify: { title, body, priority, tags: priority === 'urgent' ? 'rotating_light,trophy' : 'hourglass' } }) }).then((r) => r.ok).catch(() => false) : Promise.resolve(false);

// D1 is only touched when the competition is AVAILABLE (the account hit D1's free daily read limit on 2026-10-07 because
// of the old 10-s watcher): while closed, nothing is stored and nothing is pushed.
async function check(env) {
  let quick = null;
  try { const r = await fetch(URL_COMP, { method: 'POST', headers: HEADERS, body: BODY, signal: AbortSignal.timeout(8000) }); const j = await r.json().catch(() => null); quick = r.ok ? !!j?.json?.available : null; } catch {}
  if (quick !== true) return { available: quick, note: 'closed (or unreachable): nothing stored' };
  const st = (await kv(env, 'reopen').catch(() => null)) ?? { available: false, checks: 0, since: new Date().toISOString() };
  let available = null, detail = '';
  try {
    const r = await fetch(URL_COMP, { method: 'POST', headers: HEADERS, body: BODY, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null); available = r.ok ? !!j?.json?.available : null; detail = `HTTP ${r.status}`;
  } catch (e) { detail = String(e).slice(0, 80); }
  st.checks++; st.lastCheck = new Date().toISOString(); st.lastDetail = detail;
  if (available !== null && available !== st.available) {
    st.available = available; st.since = st.lastCheck;
    await push(env, available ? 'Agents War: competition REOPENED' : 'Agents War: competition closed',
      available ? 'getCompetition says available:true — restart the chase (README §9).' : 'getCompetition says available:false.', available ? 'urgent' : 'default');
  }
  await kv(env, 'reopen', st).catch(async () => { await push(env, 'Agents War: competition REOPENED', 'getCompetition says available:true (state store unavailable, may repeat).', 'urgent'); });
  return st;
}

export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname === '/status') { const st = await kv(env, 'reopen').catch((e) => ({ dbError: String(e).slice(0, 120) })); return Response.json({ mode: 'reopen watcher (every 5 min)', now: new Date().toISOString(), ...(st ?? { note: 'closed so far (nothing stored while closed)' }) }, { headers: { 'cache-control': 'no-store' } }); }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
  async scheduled(_ev, env, ctx) { ctx.waitUntil(check(env)); },
};
