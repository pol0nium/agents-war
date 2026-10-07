// Superchallenge Full Leaderboard — adds a "🏆 Full leaderboard" button that shows every entry in a scrollable panel.
// Uses the same public, read-only endpoint the page itself calls (getPublicLeaderboard). No data leaves the page.
(() => {
  if (window.__scFullLb) return; window.__scFullLb = true;

  // /play/SUPERCHALLENGE-JAWVUX → code "JAWVUX" (the part after the last dash)
  const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const code = slug.includes('-') ? slug.slice(slug.lastIndexOf('-') + 1) : slug;
  if (!code) return;

  const fmtTime = (ms) => {
    if (ms == null) return '—';
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
    return (m ? `${m}:${String(s).padStart(2, '0')}` : `${s}`) + '.' + String(r).padStart(3, '0') + 's';
  };
  const avgMs = (e) => { const n = Math.round((e.score ?? 0) / ppc); return e.elapsedMs == null || n <= 0 ? null : e.elapsedMs / n; };
  const avgAnswer = (e) => { const v = avgMs(e); return v == null ? '—' : v.toFixed(1) + ' ms'; };
  const lastChange = (c) => [...(c?.log ?? [])].filter((l) => !/entry created/i.test(l.what) || /→/.test(l.what)).sort((a, b) => b.at - a.at)[0] ?? null;
  const rel = (t) => { const s = Math.round((Date.now() - t) / 1000); if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`; return new Date(t).toLocaleString(); };
  const fmtDate = (d) => { try { return new Date(d).toLocaleString(); } catch { return ''; } };
  const el = (tag, style = {}, text) => { const e = document.createElement(tag); Object.assign(e.style, style); if (text != null) e.textContent = text; return e; };

  const btn = el('button', {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483646, padding: '10px 14px',
    borderRadius: '999px', border: '1px solid #444', background: '#1f1f1f', color: '#fff',
    font: '600 14px system-ui, sans-serif', cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,.25)',
  }, '🏆 Full leaderboard');
  document.body.appendChild(btn);

  let overlay = null;
  let timer = null;
  const close = () => { clearInterval(timer); timer = null; overlay?.remove(); overlay = null; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // Highlights = the LAST SET OF CHANGES seen. It stays displayed (across refreshes, panel close and page reloads) and is
  // only replaced when a refresh detects something new (new entry, rank move, new time/score/nickname).
  // state = { at, entries, last: { at, old: { key: previousValues | null(new entry) } } }
  const SNAP_KEY = 'scFullLb:' + code;
  // Persisted in the EXTENSION's own storage (chrome.storage.local): survives reboots, browser restarts and clearing the
  // website's data. One-time migration from the older localStorage copy.
  let state = null;
  const ready = (async () => {
    try {
      state = (await chrome.storage.local.get(SNAP_KEY))[SNAP_KEY] ?? null;
      if (!state) { const ls = localStorage.getItem(SNAP_KEY); if (ls) { state = JSON.parse(ls); await chrome.storage.local.set({ [SNAP_KEY]: state }); } }
      try { localStorage.removeItem(SNAP_KEY); } catch {}
      // Merge the bundled seed history (reconstructed from our own leaderboard fetches + race logs), once per seed version.
      if (typeof SC_SEED !== 'undefined' && SC_SEED.code === code && state?.seedApplied !== SC_SEED.snapshotAt) {
        const snapAt = Date.parse(SC_SEED.snapshotAt);
        state = state ?? { at: snapAt, entries: SC_SEED.entries, last: null };
        const counts = { ...(state.counts ?? {}) };
        for (const [k, sd] of Object.entries(SC_SEED.counts)) {
          const c = counts[k];
          const extAfter = (c?.log ?? []).filter((l) => !l.seed && l.at > snapAt);        // changes the extension saw after the seed
          const seedLog = sd.log.map((l) => ({ at: Date.parse(l.at), what: l.what, seed: true }));
          counts[k] = {
            n: Math.max(sd.n + extAfter.length, c?.n ?? 0),
            since: Math.min(Date.parse(sd.log[0]?.at ?? SC_SEED.snapshotAt), c?.since ?? Infinity),
            log: [...seedLog, ...extAfter].sort((a, b) => a.at - b.at).slice(-30),
            exact: !!sd.exact && extAfter.length === 0, note: sd.note || '',
          };
        }
        state = { ...state, counts, seedApplied: SC_SEED.snapshotAt };
        await chrome.storage.local.set({ [SNAP_KEY]: state });
      }
    } catch {}
  })();
  const save = () => chrome.storage.local.set({ [SNAP_KEY]: state }).catch(() => {});
  const keyOf = (e) => e.createdAt || ('nick:' + e.nickname); // createdAt survives nickname changes
  let maxPlays = 10, ppc = 5000;
  fetch('/api/rpc/superchallenge/getCompetition', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-product-id': 'superchallenge' },
    body: JSON.stringify({ json: { productId: 'superchallenge', code } }) }).then((r) => r.json()).then((j) => { const m = j?.json?.maxPlaysPerPlayer ?? j?.json?.agentWars?.maxAttempts; if (m) maxPlays = m; const p = j?.json?.agentWars?.pointsPerCorrect; if (p) ppc = p; }).catch(() => {});
  // Per-player attempt counter (LOWER BOUND): entry seen = 1 race; each observed change (time/score/nickname) = +1 race.
  // Races that don't beat a player's best are invisible on the public leaderboard.
  const pick = (e) => ({ rank: e.rank, nickname: e.nickname, score: e.score, elapsedMs: e.elapsedMs });
  const differs = (a, b) => a.rank !== b.rank || a.nickname !== b.nickname || a.score !== b.score || a.elapsedMs !== b.elapsedMs;

  // ---- table columns (order = display order) and sorting
  const COUNT_TIP = 'Estimate from observed leaderboard changes: races are a minimum (≥), lives left a maximum (≤); "=" = exact (our own race logs). Races that do not beat a player\'s best are invisible.';
  const COLS = [
    { id: 'rank', label: '#', key: (r) => r.e.rank },
    { id: 'nick', label: 'Nickname', left: true, key: (r) => String(r.e.nickname ?? '').toLowerCase() },
    { id: 'score', label: 'Score', key: (r) => r.e.score ?? 0 },
    { id: 'time', label: 'Time', key: (r) => r.e.elapsedMs },
    { id: 'avg', label: 'Avg / answer', key: (r) => avgMs(r.e), tip: 'Time ÷ number of correct answers (score ÷ points per answer)' },
    { id: 'races', label: 'Races', key: (r) => r.c.n, tip: COUNT_TIP },
    { id: 'lives', label: 'Lives left', key: (r) => Math.max(0, maxPlays - r.c.n), tip: COUNT_TIP },
    { id: 'changed', label: 'Last change', left: true, key: (r) => lastChange(r.c)?.at ?? null, tip: 'When the extension (or our seed history) last SAW this entry change: time, score or nickname. The game itself does not expose an update time.' },
    { id: 'saved', label: 'First entry', left: true, key: (r) => Date.parse(r.e.createdAt), tip: 'When the entry was first created (server "createdAt"). Never changes, even when the player improves.' },
  ];
  let sort = { id: 'rank', dir: 1 };
  let rows = []; // current row models, re-sorted on header click without refetching
  const cmp = (a, b) => {
    const col = COLS.find((c) => c.id === sort.id) ?? COLS[0];
    const va = col.key(a), vb = col.key(b);
    if (va == null && vb == null) return a.e.rank - b.e.rank;
    if (va == null) return 1; if (vb == null) return -1;          // empty values always at the bottom
    const d = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return (d || a.e.rank - b.e.rank) * (d ? sort.dir : 1);
  };
  function cellsOf(r) {
    const { e, diff, old, isNew, c } = r;
    return {
      rank: [String(e.rank) + (diff.rank ? (e.rank < old.rank ? ' ▲' : ' ▼') : ''), diff.rank, old && `was #${old.rank}`, diff.rank ? { color: e.rank < old.rank ? '#137333' : '#b3261e' } : null],
      nick: [e.nickname, diff.nickname, old && diff.nickname && `was "${old.nickname}"`],
      score: [(e.score ?? 0).toLocaleString(), diff.score, old && `was ${(old.score ?? 0).toLocaleString()}`],
      time: [fmtTime(e.elapsedMs), diff.time, old && `was ${fmtTime(old.elapsedMs)}`],
      avg: [avgAnswer(e), diff.time || diff.score, old && `was ${avgAnswer(old)}`],
      races: [(c.exact ? '= ' : '≥ ') + c.n, false, null, { color: c.exact ? '#111' : '#555', fontWeight: c.exact ? '700' : '400' }],
      lives: [(c.exact ? '= ' : '≤ ') + Math.max(0, maxPlays - c.n), false, null, { color: c.exact ? '#111' : '#555', fontWeight: c.exact ? '700' : '400' }],
      changed: (() => { const l = lastChange(c); return [l ? rel(l.at) : '—', false, l ? `${new Date(l.at).toLocaleString()}: ${l.what}` : null, { color: l && Date.now() - l.at < 3600e3 ? '#111' : '#666' }]; })(),
      saved: [fmtDate(e.createdAt), false, null],
    };
  }
  function render(tbody, headRow) {
    [...headRow.children].forEach((th, i) => { const col = COLS[i]; th.textContent = col.label + (sort.id === col.id ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''); });
    tbody.replaceChildren();
    for (const r of [...rows].sort(cmp)) {
      const tr = el('tr', { borderBottom: '1px solid #eee', background: r.isNew ? '#e3f7e3' : r.changed ? '#fff4c2' : '' });
      const cells = cellsOf(r);
      for (const col of COLS) {
        const [txt, hot, tip, extra] = cells[col.id];
        const td = el('td', { padding: '6px 10px', textAlign: col.left ? 'left' : 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', fontWeight: hot ? '700' : '400', ...(extra ?? {}) }, txt);
        if (hot && tip) td.title = tip;
        if (col.id === 'changed' && tip) td.title = tip;
        if (col.id === 'nick' && r.isNew) { // separate badge, NOT part of the nickname text
          const b = el('span', { marginLeft: '8px', padding: '1px 6px', borderRadius: '999px', background: '#137333', color: '#fff', fontSize: '11px', fontWeight: '700', verticalAlign: 'middle' }, 'NEW');
          b.title = 'New entry since the previous set of changes (label added by this extension)'; td.appendChild(b);
        }
        if (col.id === 'races' || col.id === 'lives') { const c = r.c; td.title = (c.exact ? `exact (our own race logs)${c.note ? ' — ' + c.note : ''}` : `lower bound — counted since ${new Date(c.since).toLocaleString()}`) + (c.log.length ? '\n' + c.log.map((l) => `${new Date(l.at).toLocaleString()}: ${l.what}`).join('\n') : ''); }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  async function load(body, status, headRow) {
    status.textContent = 'Loading…';
    await ready;
    if (state?.sort && COLS.some((c) => c.id === state.sort.id)) sort = state.sort;
    try {
      const r = await fetch('/api/rpc/superchallenge/getPublicLeaderboard', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-product-id': 'superchallenge' },
        body: JSON.stringify({ json: { productId: 'superchallenge', code, limit: 100 } }),
      });
      const entries = (await r.json())?.json?.entries ?? [];
      const now = Date.now();
      // 1. what changed since the previous refresh?
      const before = state?.entries ? new Map(state.entries.map((e) => [keyOf(e), e])) : null;
      const fresh = {};
      if (before) for (const e of entries) { const o = before.get(keyOf(e)); if (!o) fresh[keyOf(e)] = null; else if (differs(o, e)) fresh[keyOf(e)] = pick(o); }
      const gone = before ? [...before.keys()].filter((k) => !entries.some((e) => keyOf(e) === k)).length : 0;
      const hasNews = Object.keys(fresh).length > 0 || gone > 0;
      const counts = { ...(state?.counts ?? {}) };
      for (const e of entries) {
        const k = keyOf(e); const o = before?.get(k);
        if (!counts[k]) counts[k] = { n: 1, since: now, log: [] };
        else if (o && (o.score !== e.score || o.elapsedMs !== e.elapsedMs || o.nickname !== e.nickname)) {
          counts[k] = { ...counts[k], exact: false, n: counts[k].n + 1, log: [...counts[k].log, { at: now, what: o.nickname !== e.nickname && o.elapsedMs === e.elapsedMs && o.score === e.score ? `renamed "${o.nickname}"→"${e.nickname}"` : `${fmtTime(o.elapsedMs)} → ${fmtTime(e.elapsedMs)}` }].slice(-20) };
        }
      }
      // 2. new changes replace the highlighted set; otherwise the previous set stays displayed
      const last = hasNews ? { at: now, old: fresh } : (state?.last ?? null);
      let nNew = 0, nChanged = 0;
      rows = entries.map((e) => {
        const k = keyOf(e); const inSet = last && k in last.old; const old = inSet ? last.old[k] : null;
        const isNew = !!inSet && old === null;
        const diff = old ? { rank: old.rank !== e.rank, nickname: old.nickname !== e.nickname, score: old.score !== e.score, time: old.elapsedMs !== e.elapsedMs } : {};
        const changed = Object.values(diff).some(Boolean);
        if (isNew) nNew++; else if (changed) nChanged++;
        return { e, old, isNew, changed, diff, c: counts[k] };
      });
      render(body, headRow);
      const when = last ? new Date(last.at).toLocaleTimeString() : '';
      const summary = !before ? 'first load — changes will be highlighted from the next refresh on'
        : hasNews ? `NEW CHANGES: ${nNew} new · ${nChanged} changed` + (gone ? ` · ${gone} removed` : '')
        : last ? `no new changes · still showing the last changes (${nNew} new · ${nChanged} changed, detected ${when})` : 'no changes yet';
      status.textContent = `${entries.length} entries · ${summary} · refreshed ${new Date(now).toLocaleTimeString()} (auto every 30s)` + (entries.length >= 100 ? ' · (first 100 shown)' : '');
      state = { at: now, entries, last, counts, sort };
      save();
    } catch (err) { status.textContent = 'Could not load the leaderboard: ' + err; }
  }

  btn.addEventListener('click', () => {
    if (overlay) return close();
    overlay = el('div', { position: 'fixed', inset: '0', zIndex: 2147483647, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px' });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const panel = el('div', { background: '#fff', color: '#111', borderRadius: '12px', width: 'min(1220px, 100%)', maxHeight: '94vh', display: 'flex', flexDirection: 'column', font: '14px system-ui, sans-serif', boxShadow: '0 10px 40px rgba(0,0,0,.35)' });
    const head = el('div', { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', borderBottom: '1px solid #ddd' });
    head.appendChild(el('strong', { flex: '1', fontSize: '16px' }, `Leaderboard — ${code}`));
    const refresh = el('button', { padding: '6px 10px', borderRadius: '6px', border: '1px solid #ccc', background: '#f6f6f6', cursor: 'pointer' }, '↻ Refresh');
    const x = el('button', { padding: '6px 10px', borderRadius: '6px', border: '1px solid #ccc', background: '#f6f6f6', cursor: 'pointer' }, '✕');
    head.append(refresh, x);
    const scroller = el('div', { overflowY: 'auto', flex: '1' }); // the scrollable part
    const table = el('table', { width: '100%', borderCollapse: 'collapse' });
    const thead = el('thead', { position: 'sticky', top: '0', background: '#fafafa' });
    const hr = el('tr'); const tbody = el('tbody');
    COLS.forEach((col) => {
      const th = el('th', { padding: '8px 10px', textAlign: col.left ? 'left' : 'right', borderBottom: '1px solid #ddd', fontWeight: '600', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }, col.label);
      th.title = (col.tip ? col.tip + '\n' : '') + 'Click to sort (click again to reverse)';
      th.addEventListener('click', () => {
        sort = sort.id === col.id ? { id: col.id, dir: -sort.dir } : { id: col.id, dir: 1 };
        render(tbody, hr);
        if (state) { state.sort = sort; save(); }
      });
      hr.appendChild(th);
    });
    thead.appendChild(hr); table.append(thead, tbody); scroller.appendChild(table);
    const status = el('div', { padding: '8px 16px', borderTop: '1px solid #ddd', color: '#666', fontSize: '12px' });
    panel.append(head, scroller, status); overlay.appendChild(panel); document.body.appendChild(overlay);
    refresh.addEventListener('click', () => load(tbody, status, hr)); x.addEventListener('click', close);
    load(tbody, status, hr);
    timer = setInterval(() => load(tbody, status, hr), 30000); // auto-refresh while the panel is open
  });
})();
