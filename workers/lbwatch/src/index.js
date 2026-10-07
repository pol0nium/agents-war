// aw-lbwatch: watches the public Agents War leaderboard (top 100) and pushes ONE ntfy message per poll that found
// changes. Cadence: a 1-minute cron; each invocation polls every 10 s for ~75 s; an atomic slot claim in D1 keeps
// overlapping invocations to one poll per >= 8 s. ONE getPublicLeaderboard request per poll, nothing else to the game.
// Change logic mirrors leaderboard-extension: entry key = createdAt (survives renames); a change = new entry, new
// time / score / nickname, or a rank move. Everyone in the top 100 is reported; our own (pol0nium) lines are short
// because the runner already pushes our race results.
// GET /status → last polls (timestamps), last change summary, counters. No secrets. State: D1 table kv(k, v).
const URL_LB = 'https://superchallenge.io/api/rpc/superchallenge/getPublicLeaderboard';
const BODY = JSON.stringify({ json: { productId: 'superchallenge', code: 'JAWVUX', limit: 100 } });
const HEADERS = {
  'content-type': 'application/json',
  'x-product-id': 'superchallenge',
  origin: 'https://superchallenge.io',
  referer: 'https://superchallenge.io/play/SUPERCHALLENGE-JAWVUX',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
};
const TEAM = 'pol0nium';
const MAX_LINES = 10;
const STEP_MS = 10_000, RUN_MS = 75_000; // each 1-min cron invocation polls every 10 s for ~75 s (overlap covers late starts)
const MIN_GAP_MS = 8_000;                  // never two polls within 8 s
const ERR_PUSH_GAP_MS = 3600_000;          // at most one "watch error" push per hour

const keyOf = (e) => e.createdAt || 'nick:' + e.nickname;
const t = (ms) => (ms == null ? '?' : (ms / 1000).toFixed(3) + 's');
const t0 = (ms) => (ms == null ? '?' : (ms / 1000).toFixed(3)); // without unit, for "was …"
const isTeam = (e) => e?.nickname === TEAM;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function kvGet(env, k) {
  const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return r ? JSON.parse(r.v) : null;
}
const kvSet = (env, k, v) => env.DB.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').bind(k, JSON.stringify(v)).run();
const ensure = (env) => env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)').run();

function headline(entries) {
  const top = entries.find((e) => e.rank === 1);
  const cut = entries.find((e) => e.rank === 10);
  const ours = entries.filter(isTeam).sort((a, b) => a.rank - b.rank)[0];
  return `#1 ${top ? `${top.nickname} ${t(top.elapsedMs)}` : '?'} | cutoff #10 ${cut ? t(cut.elapsedMs) : '?'} | ${TEAM} best ${ours ? `#${ours.rank} ${t(ours.elapsedMs)}` : 'not in top 100'}`;
}

// Returns { lines, urgent } describing what changed between two top-100 snapshots.
function diff(prev, entries) {
  const before = new Map(prev.map((e) => [keyOf(e), e]));
  const now = new Set(entries.map(keyOf));
  const lines = [], ourMoves = [];
  let moves = [];
  let urgent = false;
  const oTop = prev.find((e) => e.rank === 1), nTop = entries.find((e) => e.rank === 1);
  const topChanged = nTop && (!oTop || keyOf(oTop) !== keyOf(nTop) || oTop.elapsedMs !== nTop.elapsedMs || oTop.score !== nTop.score);
  if (topChanged) {
    lines.push(`#1 changed: ${nTop.nickname} ${t(nTop.elapsedMs)} (was ${oTop ? `${oTop.nickname === nTop.nickname ? '' : oTop.nickname + ' '}${t0(oTop.elapsedMs)}` : '?'})`);
    urgent = true;
  }
  const ourBest = (() => { const b = entries.filter(isTeam).sort((a, c) => a.rank - c.rank)[0]; return b ? keyOf(b) : null; })();
  for (const e of [...entries].sort((a, b) => a.rank - b.rank)) {
    const o = before.get(keyOf(e));
    const team = isTeam(e) || isTeam(o);
    if (!o) {
      if (topChanged && e.rank === 1) continue; // already covered by the "#1 changed" line
      lines.push(team ? `${TEAM} new #${e.rank} ${t(e.elapsedMs)}` : `new entry #${e.rank} ${e.nickname} ${t(e.elapsedMs)}${e.score !== 1000000 ? ` (${e.score.toLocaleString('en-US')} pts)` : ''}`);
      if (team) urgent = true;
      continue;
    }
    const rank = o.rank !== e.rank ? `#${o.rank}→#${e.rank}` : `#${e.rank}`;
    const parts = [];
    if (o.nickname !== e.nickname) parts.push(`renamed from "${o.nickname}"`);
    if (o.elapsedMs !== e.elapsedMs) parts.push(team ? t(e.elapsedMs) : `${t0(o.elapsedMs)} → ${t(e.elapsedMs)}`);
    if (o.score !== e.score) parts.push(`${e.score.toLocaleString('en-US')} pts`);
    if (parts.length) {
      if (!(topChanged && e.rank === 1 && o.nickname === e.nickname)) lines.push(`${e.nickname} ${rank} ${parts.join(', ')}`);
      if (team) urgent = true;
    } else if (o.rank !== e.rank) {
      (team ? ourMoves : moves).push(`${team ? TEAM : e.nickname} ${rank}`); // rank-only move; ours listed first
      if (keyOf(e) === ourBest) urgent = true;
    }
  }
  for (const e of prev.filter((e) => !now.has(keyOf(e)))) {
    lines.push(isTeam(e) ? `${TEAM} ${t(e.elapsedMs)} (was #${e.rank}) left the top 100` : `${e.nickname} ${t(e.elapsedMs)} (was #${e.rank}) left the top 100`);
  }
  const oCut = prev.find((e) => e.rank === 10), nCut = entries.find((e) => e.rank === 10);
  if (nCut && oCut && oCut.elapsedMs !== nCut.elapsedMs) lines.push(`#10 cutoff now ${t(nCut.elapsedMs)} (was ${t0(oCut.elapsedMs)})`);
  moves = [...ourMoves, ...moves];
  if (moves.length) {
    let s = `rank moves (${moves.length}): `;
    for (const [i, m] of moves.entries()) { if ((s + m).length > 220) { s += `… +${moves.length - i}`; break; } s += (i ? ', ' : '') + m; }
    lines.push(s);
  }
  return { lines, urgent };
}

// Pushes go through the Vercel runner's relay (POST /api/log {secret, notify}): ntfy.sh refuses Cloudflare's shared IPs
// (daily per-IP quota → 429). Direct ntfy (with optional NTFY_TOKEN) is the fallback if RELAY_SECRET isn't set.
const RELAY = 'https://<your-runner>.vercel.app/api/log';
async function push(env, title, body, priority, tags) {
  try {
    if (env.RELAY_SECRET) {
      const r = await fetch(RELAY, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ secret: env.RELAY_SECRET, notify: { title, body, priority, tags } }) });
      const j = await r.json().catch(() => null);
      return { ok: !!j?.ok, status: j?.status ?? r.status, detail: j?.ok ? undefined : (j?.detail ?? j?.error ?? '').slice(0, 200), via: 'relay' };
    }
    if (!env.NTFY_TOPIC) return { ok: false, status: 'no topic' };
    const r = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: 'POST', body,
      headers: { Title: title, Priority: priority, Tags: tags, ...(env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN}` } : {}) } });
    const detail = r.ok ? undefined : (await r.text().catch(() => '')).replaceAll(env.NTFY_TOPIC, '<topic>').slice(0, 200);
    return { ok: r.ok, status: r.status, detail };
  } catch (err) {
    return { ok: false, status: String(err).slice(0, 100) };
  }
}

// One poll: ONE leaderboard request, diff, at most one push. Returns false if skipped (too soon after the last poll).
// CPU budget (free plan ≈ 10 ms per invocation, shared by the 6 polls of a run): fetch the raw text first and compare a
// cheap FNV-1a fingerprint with the previous one; only parse + diff when the board actually changed (rare).
let lastHash = null;
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16) + ':' + s.length; };
async function pollOnce(env) {
  let text = null, hash = null;
  try {
    const r = await fetch(URL_LB, { method: 'POST', headers: HEADERS, body: BODY, signal: AbortSignal.timeout(8000) });
    if (r.ok) { text = await r.text(); hash = fnv(text); }
  } catch {}
  if (hash) {
    if (lastHash === null) lastHash = (await env.DB.prepare("SELECT v FROM kv WHERE k = 'hash'").first())?.v ?? '';
    if (hash === lastHash) { // unchanged board: tiny bookkeeping only
      await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('lastQuietPoll', ?)").bind(new Date().toISOString()).run();
      return true;
    }
  }
  const meta = (await kvGet(env, 'meta')) ?? { polls: 0, ok: 0, errors: 0, changes: 0, pushes: 0, pushFailures: 0 };
  const nowMs = Date.now();
  meta.lastPollAt = new Date(nowMs).toISOString();
  meta.polls++;
  meta.recentPolls = [meta.lastPollAt, ...(meta.recentPolls ?? [])].slice(0, 18);
  const notePush = (res) => { meta.pushes++; if (!res.ok) meta.pushFailures++; meta.lastPush = { at: new Date().toISOString(), ok: res.ok, status: res.status, detail: res.detail }; };
  // Send a message; if ntfy refuses (e.g. 429), keep it as pending and retry it (merged with newer news) on later polls.
  const send = async (title, body, priority, tags) => {
    const p = meta.pending;
    if (p && nowMs - Date.parse(p.since) < 15 * 60_000) {
      title = p.title === title ? title : 'Agents War leaderboard: updates';
      body = `${body}\n— earlier (${p.since.slice(11, 19)}Z, delayed) —\n${p.body}`.slice(0, 3500);
      priority = p.priority === 'urgent' ? 'urgent' : priority;
      tags = priority === 'urgent' ? 'rotating_light,trophy' : tags;
    }
    const res = await push(env, title, body, priority, tags);
    notePush(res);
    meta.pending = res.ok ? null : { since: p?.since ?? meta.lastPollAt, title, body, priority, tags };
  };

  let entries;
  try {
    if (text === null) { const r = await fetch(URL_LB, { method: 'POST', headers: HEADERS, body: BODY, signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); text = await r.text(); hash = fnv(text); }
    entries = JSON.parse(text)?.json?.entries;
    if (!Array.isArray(entries) || !entries.length) throw new Error('parse: no entries');
    entries = entries.map((e) => ({ rank: e.rank, nickname: e.nickname, score: e.score, elapsedMs: e.elapsedMs, createdAt: e.createdAt }));
  } catch (err) {
    meta.errors++;
    meta.consecutiveErrors = (meta.consecutiveErrors ?? 0) + 1;
    meta.lastError = { at: meta.lastPollAt, error: String(err?.message ?? err).slice(0, 200) };
    if (!meta.lastErrorPushAt || nowMs - Date.parse(meta.lastErrorPushAt) >= ERR_PUSH_GAP_MS) {
      meta.lastErrorPushAt = meta.lastPollAt;
      await send('Agents War: leaderboard watch error', `${meta.lastError.error} (${meta.consecutiveErrors} failed poll(s) in a row). Next error push in >= 1 h at most.`, 'default', 'warning');
    }
    await kvSet(env, 'meta', meta);
    return true;
  }
  meta.ok++;
  meta.consecutiveErrors = 0;
  meta.lastOkAt = meta.lastPollAt;
  meta.headline = headline(entries);

  const prev = await kvGet(env, 'snapshot');
  await kvSet(env, 'snapshot', entries);
  if (!prev) {
    meta.lastChange = { at: meta.lastPollAt, summary: 'watch started (first snapshot)' };
    await send('Agents War: leaderboard watch started', meta.headline, 'default', 'eyes');
  } else {
    const { lines, urgent } = diff(prev, entries);
    if (lines.length) {
      meta.changes++;
      const shown = lines.slice(0, MAX_LINES);
      if (lines.length > MAX_LINES) shown.push(`and ${lines.length - MAX_LINES} more`);
      const body = shown.join('\n') + '\n—\n' + meta.headline;
      meta.lastChange = { at: meta.lastPollAt, urgent, lines: lines.length, summary: shown.join(' | ') };
      await send(`Agents War leaderboard: ${lines.length} change${lines.length > 1 ? 's' : ''}`, body, urgent ? 'urgent' : 'default', urgent ? 'rotating_light,trophy' : 'trophy');
    } else if (meta.pending && nowMs - (Date.parse(meta.lastPush?.at) || 0) >= 30_000) {
      const p = meta.pending; meta.pending = null; // retry a refused push (no news this poll), at most every 30 s
      if (nowMs - Date.parse(p.since) < 15 * 60_000) { const res = await push(env, p.title, `(delayed from ${p.since.slice(11, 19)}Z)\n${p.body}`, p.priority, p.tags); notePush(res); if (!res.ok) meta.pending = p; }
    }
  }
  if (hash) { lastHash = hash; await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('hash', ?)").bind(hash).run(); }
  await kvSet(env, 'meta', meta);
  return true;
}

// Atomically claim the next poll slot (D1 is single-writer, so the conditional UPDATE is a compare-and-set).
async function claim(env, nowMs) {
  await env.DB.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('slot', '0')").run();
  const r = await env.DB.prepare("UPDATE kv SET v = ? WHERE k = 'slot' AND CAST(v AS INTEGER) <= ?").bind(String(nowMs), nowMs - MIN_GAP_MS).run();
  return r.meta.changes === 1;
}
const lastSlot = async (env) => Number((await env.DB.prepare("SELECT v FROM kv WHERE k = 'slot'").first())?.v ?? 0);

// Each cron invocation keeps polling every STEP_MS for ~RUN_MS after it starts. Invocations may start late or overlap
// by a few seconds; the slot claim guarantees at most one poll per MIN_GAP_MS across all of them.
async function run(env) {
  await ensure(env);
  const deadline = Date.now() + RUN_MS;
  while (true) {
    const next = Math.max(Date.now(), (await lastSlot(env)) + STEP_MS);
    if (next > deadline) break;
    await sleep(next - Date.now());
    if (!(await claim(env, Date.now()))) continue; // another invocation polled just now
    try { await pollOnce(env); } catch (err) { console.log('poll failed', String(err)); }
  }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/status') {
      await ensure(env);
      const meta = await kvGet(env, 'meta');
      const snap = await kvGet(env, 'snapshot');
      const quiet = (await env.DB.prepare("SELECT v FROM kv WHERE k = 'lastQuietPoll'").first())?.v ?? null;
      return Response.json({ now: new Date().toISOString(), cadence: `1-min cron, each run polls every ${STEP_MS / 1000}s for ~${RUN_MS / 1000}s`, entriesInSnapshot: snap?.length ?? 0, lastUnchangedPollAt: quiet, ...(meta ?? { note: 'no poll yet' }) },
        { headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(run(env));
  },
};
