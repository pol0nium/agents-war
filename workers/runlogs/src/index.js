// aw-runlogs: run-log storage for the agents-war runner (replaces Vercel Blob). Secret-gated (x-secret header).
// POST /put {pathname, data}  → gzip JSON stored in D1 (table logs)
// GET  /list?prefix=runs/&cursor=<pathname> → {count, blobs:[{pathname,size,uploadedAt}], cursor}
// GET  /get?pathname=… → JSON
const gz = async (s) => new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
const gunz = async (b) => await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
const json = (o, status = 200) => Response.json(o, { status, headers: { 'cache-control': 'no-store' } });
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.headers.get('x-secret') !== env.SECRET) return json({ error: 'unauthorized' }, 401);
    // /putgz: body = gzip bytes already compressed by the caller (the Vercel runner); headers x-pathname, x-raw-size.
    // No compression here: the free plan's ~10 ms CPU per request was being exceeded by gzipping ~100 KB logs.
    if (u.pathname === '/putgz' && req.method === 'POST') {
      const pathname = req.headers.get('x-pathname') || '';
      if (!pathname.startsWith('runs/') || pathname.includes('..')) return json({ error: 'bad pathname' }, 400);
      const body = new Uint8Array(await req.arrayBuffer());
      await env.DB.prepare('INSERT OR REPLACE INTO logs (pathname, uploaded_at, size, body) VALUES (?, ?, ?, ?)').bind(pathname, new Date().toISOString(), Number(req.headers.get('x-raw-size')) || 0, body).run();
      return json({ pathname, stored: body.length });
    }
    if (u.pathname === '/put' && req.method === 'POST') {
      const { pathname, data } = await req.json();
      if (!pathname || typeof pathname !== 'string' || !pathname.startsWith('runs/') || pathname.includes('..')) return json({ error: 'bad pathname' }, 400);
      const raw = JSON.stringify(data), body = await gz(raw);
      await env.DB.prepare('INSERT OR REPLACE INTO logs (pathname, uploaded_at, size, body) VALUES (?, ?, ?, ?)').bind(pathname, new Date().toISOString(), raw.length, body).run();
      return json({ pathname, size: raw.length, stored: body.length });
    }
    if (u.pathname === '/list') {
      const prefix = u.searchParams.get('prefix') || 'runs/', after = u.searchParams.get('cursor') || '';
      const { results } = await env.DB.prepare('SELECT pathname, size, uploaded_at FROM logs WHERE pathname >= ? AND pathname > ? ORDER BY pathname LIMIT 1000').bind(prefix, after).all();
      const blobs = results.filter((r) => r.pathname.startsWith(prefix)).map((r) => ({ pathname: r.pathname, size: r.size, uploadedAt: r.uploaded_at }));
      return json({ count: blobs.length, blobs, cursor: results.length === 1000 ? results.at(-1).pathname : null });
    }
    if (u.pathname === '/get') {
      const row = await env.DB.prepare('SELECT body FROM logs WHERE pathname = ?').bind(u.searchParams.get('pathname') || '').first();
      if (!row) return json({ error: 'not found' }, 404);
      return new Response(await gunz(new Uint8Array(row.body)), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    return json({ error: 'not found' }, 404);
  },
  // No-logs alarm (2026-10-03): every 5 min, if the newest run log is > 15 min old, push ONE ntfy alert (and a
  // "resumed" message when logs come back). Active only until env.ALARM_UNTIL (ISO time). Reads our own D1 only.
  async scheduled(_ev, env) {
    if (!env.ALARM_UNTIL || Date.now() > Date.parse(env.ALARM_UNTIL)) return;
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS alarm (k TEXT PRIMARY KEY, v TEXT)').run();
    const last = (await env.DB.prepare('SELECT max(uploaded_at) AS m FROM logs').first())?.m;
    const ageMin = last ? (Date.now() - Date.parse(last)) / 60000 : 1e9;
    const st = (await env.DB.prepare("SELECT v FROM alarm WHERE k = 'state'").first())?.v ?? 'ok';
    // via the Vercel runner's relay: ntfy.sh refuses Cloudflare's shared IPs (daily per-IP quota)
    const push = (title, body, prio) => fetch('https://<your-runner>.vercel.app/api/log', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ secret: env.SECRET, notify: { title, body, priority: prio, tags: 'warning' } }) });
    if (ageMin > 15 && st !== 'alerted') {
      await push('Agents War: chase silent', `No run logged for ${Math.round(ageMin)} min (last ${last ?? 'never'}). Check the Chrome tab (visible? Turnstile?) and window.__watch.`, 'high');
      await env.DB.prepare("INSERT OR REPLACE INTO alarm (k, v) VALUES ('state', 'alerted')").run();
    } else if (ageMin <= 15 && st === 'alerted') {
      await push('Agents War: chase logging again', `Run logs resumed (last ${last}).`, 'default');
      await env.DB.prepare("INSERT OR REPLACE INTO alarm (k, v) VALUES ('state', 'ok')").run();
    }
  },
};
