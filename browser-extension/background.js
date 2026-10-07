// Background watcher: polls the public leaderboard every 30s (even when no game tab is open) and shows a Chrome
// notification on real updates: new entry, or changed time / score / nickname. Pure rank shuffles are not notified.
// Uses its own snapshot key, so it never interferes with the panel's highlights or race counters.
const CODE = 'JAWVUX';
const PAGE = 'https://superchallenge.io/play/SUPERCHALLENGE-JAWVUX';
const KEY = 'scFullLb:bg:' + CODE;

const fmtTime = (ms) => {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return (m ? `${m}:${String(s).padStart(2, '0')}` : `${s}`) + '.' + String(r).padStart(3, '0') + 's';
};
const keyOf = (e) => e.createdAt || ('nick:' + e.nickname);

async function poll() {
  let entries;
  try {
    const r = await fetch('https://superchallenge.io/api/rpc/superchallenge/getPublicLeaderboard', {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-product-id': 'superchallenge' },
      body: JSON.stringify({ json: { productId: 'superchallenge', code: CODE, limit: 100 } }),
    });
    entries = (await r.json())?.json?.entries;
  } catch { return; }
  if (!Array.isArray(entries)) return;
  const prev = (await chrome.storage.local.get(KEY))[KEY];
  await chrome.storage.local.set({ [KEY]: { at: Date.now(), entries } });
  if (!prev?.entries) return; // first run: just take a snapshot
  const before = new Map(prev.entries.map((e) => [keyOf(e), e]));
  const lines = [];
  for (const e of entries) {
    const o = before.get(keyOf(e));
    if (!o) { lines.push(`🆕 ${e.nickname} joined (#${e.rank}, ${e.score.toLocaleString()} pts)`); continue; }
    const parts = [];
    if (o.nickname !== e.nickname) parts.push(`renamed from "${o.nickname}"`);
    if (o.score !== e.score) parts.push(`${o.score.toLocaleString()} → ${e.score.toLocaleString()} pts`);
    if (o.elapsedMs !== e.elapsedMs) parts.push(`${fmtTime(o.elapsedMs)} → ${fmtTime(e.elapsedMs)}`);
    if (parts.length) lines.push(`${e.rank < o.rank ? '▲' : e.rank > o.rank ? '▼' : '•'} ${e.nickname} #${o.rank !== e.rank ? `${o.rank}→` : ''}${e.rank}: ${parts.join(', ')}`);
  }
  if (!lines.length) return 0;
  chrome.notifications.create('lb-' + Date.now(), {
    type: 'basic', iconUrl: 'icon128.png', priority: 2,
    title: `Superchallenge leaderboard: ${lines.length} update${lines.length > 1 ? 's' : ''}`,
    message: lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n… +${lines.length - 4} more` : ''),
  });
  return lines.length;
}

function schedule() { chrome.alarms.create('lb-poll', { periodInMinutes: 0.5 }); poll(); }
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'lb-poll') poll(); });
chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const [tab] = await chrome.tabs.query({ url: 'https://superchallenge.io/play/*' });
  if (tab) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
  else chrome.tabs.create({ url: PAGE });
});

