// POST /api/log — store a page-side log batch. Body (text/plain JSON): { secret, runId, kind, data }
import { saveJson } from '../lib/store.mjs';
import { json, authorized, safeId, CORS } from '../lib/http.mjs';

export function OPTIONS() { return new Response(null, { status: 204, headers: CORS }); }

export async function POST(request) {
  let b; try { b = JSON.parse(await request.text()); } catch { return json({ error: 'bad json' }, 400); }
  if (!authorized(b.secret)) return json({ error: 'unauthorized' }, 401);
  // Notification relay (2026-10-03): Cloudflare Workers can't reach ntfy.sh (shared-IP daily quota → 429), so they POST
  // { secret, notify: { title, body, priority, tags } } here and Vercel forwards it to the team topic.
  if (b.notify && typeof b.notify === 'object') {
    if (!process.env.NTFY_TOPIC) return json({ ok: false, error: 'no topic' }, 500);
    const n = b.notify;
    const r = await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, { method: 'POST', body: String(n.body ?? '').slice(0, 4000),
      headers: { Title: String(n.title ?? 'Agents War').slice(0, 250), Priority: String(n.priority ?? 'default'), Tags: String(n.tags ?? '') } });
    return json({ ok: r.ok, status: r.status, detail: r.ok ? undefined : (await r.text().catch(() => '')).replaceAll(process.env.NTFY_TOPIC, '<topic>').slice(0, 200) }, r.ok ? 200 : 502);
  }
  const saved = await saveJson(`runs/${safeId(b.runId)}/page-${safeId(b.kind)}.json`, { runId: b.runId, kind: b.kind, savedAt: new Date().toISOString(), data: b.data });
  return json({ ok: true, saved });
}
