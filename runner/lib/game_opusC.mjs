// PROTOTYPE (opusC, 2026-10-03) — hot-path version of lib/game.mjs + lib/game_v3.mjs (one module).
// Same wire behaviour (same URL, same headers, same JSON body bytes, same hedge/dual/retry/budget logic). Changes:
//   1. rpc via undici Agent.request() (fableB's game_fast.mjs idea): no Request/Headers/Response/WebStream objects,
//      and the request is written to the socket SYNCHRONOUSLY inside the call (fetch dispatches several microtasks later).
//   2. Headers object built once per user-agent and reused.
//   3. submitHedged accepts a pre-serialised body string → serialised ONCE per question, not once per copy.
//   4. On a win, resolve first, budget/attempt bookkeeping after (off the critical path).
// Return shapes are unchanged: rpc → {ok,status,body,err,vid,stiming,ms}; submitHedged → {...rpc, ms, attempt, attempts, refused, retries}.
import { Agent } from 'undici';
import { makeRawClient } from './rawhttp.mjs';

const dispatcher = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 8 });
export const GAME_BASE = process.env.GAME_BASE ?? 'https://superchallenge.io';
const ORIGIN = new URL(GAME_BASE).origin;
const PATHS = new Map(); const pathOf = (proc) => { let p = PATHS.get(proc); if (!p) PATHS.set(proc, (p = `/api/rpc/superchallenge/${proc}`)); return p; };
const HDRS = new Map();
const headersFor = (ua) => {
  let h = HDRS.get(ua ?? '');
  if (!h) {
    h = { 'content-type': 'application/json', 'x-product-id': 'superchallenge', origin: GAME_BASE, referer: `${GAME_BASE}/play/SUPERCHALLENGE-JAWVUX` };
    if (ua) h['user-agent'] = ua;
    HDRS.set(ua ?? '', h);
  }
  return h;
};
// HTTP engine for the hot path: 'undici' (Agent.request) or 'raw' (rawhttp.mjs). setHttpMode() is called by race7.
let RAW = null; let MODE = process.env.AW_HTTP === 'raw' ? 'raw' : 'undici';
// 'ab' = both engines ready; the caller picks one per question via submitHedged(..., { http }) (within-run A/B).
export function setHttpMode(m) { MODE = m === 'raw' || m === 'ab' || m === 'dispatch' ? m : 'undici'; if (MODE !== 'undici' && !RAW) RAW = makeRawClient(GAME_BASE, { max: 8 }); return MODE; }
if (MODE === 'raw') setHttpMode('raw');
const HSTR = new Map(); const headerStrFor = (ua) => { let s = HSTR.get(ua ?? ''); if (s === undefined) HSTR.set(ua ?? '', (s = Object.entries(headersFor(ua)).map(([k, v]) => `${k}: ${v}\r\n`).join(''))); return s; };
const first = (v) => (Array.isArray(v) ? v[0] : v ?? null);

// 'dispatch' engine: undici dispatch() with a bare handler — no Readable body stream, no request() promise layers;
// the reply bytes are collected in onResponseData and the promise resolves once, in onResponseEnd.
function dispatchPost(path, headers, body) {
  return new Promise((resolve, reject) => {
    let status = 0, h = null, c0 = null, cs = null;
    dispatcher.dispatch({ origin: ORIGIN, path, method: 'POST', headers, body }, {
      onRequestStart() {},
      onResponseStart(_c, s, hd) { status = s; h = hd; },
      onResponseData(_c, ch) { if (c0 === null) c0 = ch; else (cs ??= [c0]).push(ch); },
      onResponseEnd() { resolve({ status, headers: h, text: cs ? Buffer.concat(cs).toString('utf8') : c0 ? c0.toString('utf8') : '' }); },
      onResponseError(_c, e) { reject(e); },
    });
  });
}
// bodyStr: the exact JSON text `{"json":<input>}`.
export async function rpcRaw(proc, bodyStr, ua, eng = MODE) {
  const t0 = performance.now();
  const headers = headersFor(ua);
  let status = 0, body = null, err = null, vid = null, stiming = null;
  try {
    let text;
    if (globalThis.__AW_MOCK_FETCH__) { // tests replace globalThis.fetch with a mock
      const r = await globalThis.fetch(`${GAME_BASE}${pathOf(proc)}`, { method: 'POST', headers, body: bodyStr });
      status = r.status; vid = r.headers.get('x-vercel-id'); stiming = r.headers.get('server-timing'); text = await r.text();
    } else if (eng === 'raw') {
      const r = await RAW.request(pathOf(proc), headerStrFor(ua), bodyStr);
      status = r.status; vid = r.headers['x-vercel-id'] ?? null; stiming = r.headers['server-timing'] ?? null; text = r.text;
    } else if (eng === 'dispatch') {
      const r = await dispatchPost(pathOf(proc), headers, bodyStr);
      status = r.status; vid = first(r.headers['x-vercel-id']); const hs = r.headers['server-timing']; stiming = Array.isArray(hs) ? hs.join(', ') : hs ?? null; text = r.text;
    } else {
      const r = await dispatcher.request({ origin: ORIGIN, path: pathOf(proc), method: 'POST', headers, body: bodyStr });
      status = r.statusCode; vid = first(r.headers['x-vercel-id']); const hs = r.headers['server-timing']; stiming = Array.isArray(hs) ? hs.join(', ') : hs ?? null;
      text = await r.body.text();
    }
    try { body = JSON.parse(text)?.json ?? null; } catch { body = text.slice(0, 500); }
  } catch (e) { err = String(e); }
  return { ok: status >= 200 && status < 300, status, body, err, vid, stiming, ms: Math.round(performance.now() - t0) };
}
export const rpc = (proc, input, { ua, http } = {}) => rpcRaw(proc, JSON.stringify({ json: input }), ua, http ?? (MODE === 'ab' ? 'undici' : MODE));

// Byte-identical to JSON.stringify({ json: { productId, code, runToken, drillId, submission } }) — prefix built once per run.
export function answerBodyBuilder(code, runToken) {
  const pre = `{"json":{"productId":"superchallenge","code":${JSON.stringify(code)},"runToken":${JSON.stringify(runToken)},"drillId":`;
  return (drillId, submission) => `${pre}${JSON.stringify(drillId)},"submission":${JSON.stringify(submission)}}}`;
}

// Open `n` keep-alive connections before the clock starts (fableB #2, unchanged).
export async function preopenSockets(n = 4, input = { productId: 'superchallenge', code: 'JAWVUX' }) {
  const bodyStr = JSON.stringify({ json: input }); const rounds = [];
  const engs = MODE === 'ab' ? ['undici', 'raw'] : [MODE];
  for (const eng of engs) for (let round = 0; round < 2; round++) rounds.push((await Promise.all(Array.from({ length: n }, () => rpcRaw('getCompetition', bodyStr, undefined, eng)))).map((r) => r.ms));
  return rounds;
}

export const deadlineMs = (n) => 5000 - 3000 * Math.min(n - 1, 40) / 40;

// Unchanged from game_v3.mjs.
export function makeBudget(opts = {}) {
  const o = { rate: 28, burst: 6, minRate: 10, maxRate: 33, incr: 0.03, decr: 0.7, penalty: 2, holdMs: 400, inflate: 1.6, ...opts };
  return {
    ...o, tokens: o.burst, t: performance.now(), refusals: 0, extras: 0, skipped: 0, inflated: 0, holdUntil: 0, ewma: 0, base: 0, nOk: 0,
    refill() { const now = performance.now(); this.tokens = Math.min(this.burst, this.tokens + (now - this.t) / 1000 * this.rate); this.t = now; },
    spend() { if (o.slideWin) this.swRec(); if (o.fixedWin) { this.fwRoll(); this.fwN++; } this.refill(); this.tokens -= 1; },
    // Fixed-window mode (2026-10-03): the game allows 250 requests per run per CLOCK-ALIGNED 10 s window (:00-:10, :10-:20 …;
    // fits all 97 logged runs). o.fixedWin = { w: 10000, cap: 240, qMs: 38 }: every send is counted in its window; an extra
    // copy is allowed only if the window can still absorb it plus the mandatory first copies expected before the reset
    // (one per qMs). The token bucket is bypassed in this mode.
    // Sliding-window mode (2026-10-03, reviewers A+B, verified on 316 runs): the game's limiter is Upstash-style
    // slidingWindow(250, 10 s) per run: estimate = count(current clock window) + count(previous) * (1 - elapsed fraction).
    // o.slideWin = { L: 244, rate: 38, burst: 8, noCopyBelow: 11 }: an EXTRA copy is allowed only if the estimate stays
    // ≤ L AND total sends ≤ rate * elapsed_s + burst (paces copies evenly over the run) AND question ≥ noCopyBelow.
    strict: !!o.slideWin, swCnt: new Map(), swN: 0, swT0: 0, qn: 0,
    swRec() { const now = Date.now(); if (!this.swT0) this.swT0 = now; const k = Math.floor(now / 10000); this.swCnt.set(k, (this.swCnt.get(k) ?? 0) + 1); this.swN++; },
    swPeak(extra) {
      const now = Date.now(), k0 = Math.floor(now / 10000), c = new Map(); for (const d of [-1, 0]) c.set(k0 + d, this.swCnt.get(k0 + d) ?? 0);
      c.set(k0, c.get(k0) + extra); let max = c.get(k0) + c.get(k0 - 1) * (1 - (now % 10000) / 10000);
      const qMs = Math.max(25, 0.9 * (this.ewma || o.slideWin.qMs || 42)), n = Math.min(this.qLeft ?? 0, 200);
      for (let i = 1; i <= n; i++) { const t = now + i * qMs, k = Math.floor(t / 10000); c.set(k, (c.get(k) ?? 0) + 1); const e = c.get(k) + (c.get(k - 1) ?? 0) * (1 - (t % 10000) / 10000); if (e > max) max = e; }
      return max;
    },
    swEst() { const now = Date.now(), k = Math.floor(now / 10000), f = (now % 10000) / 10000; return (this.swCnt.get(k) ?? 0) + (this.swCnt.get(k - 1) ?? 0) * (1 - f); },
    fw: null, fwK: -1, fwN: 0,
    fwRoll() { const now = Date.now(), k = Math.floor(now / o.fixedWin.w); if (k !== this.fwK) { this.fwK = k; this.fwN = 0; } return now; },
    take() {
      if (o.slideWin && o.slideWin.project) {
        // Phase-aware: admit an extra copy only if, with it, the projected sliding estimate stays ≤ L at every future
        // mandatory first copy (one per qMs ≈ 0.9 × recent reply EWMA, for the qLeft questions still to come).
        if (performance.now() < this.holdUntil || this.qn < (o.slideWin.noCopyBelow ?? 0) || this.swPeak(1) > o.slideWin.L) { this.skipped++; return false; }
        this.swRec(); this.extras++; return true;
      }
      if (o.slideWin) {
        const sw = o.slideWin, el = this.swT0 ? (Date.now() - this.swT0) / 1000 : 0;
        if (performance.now() < this.holdUntil || this.qn < (sw.noCopyBelow ?? 0) || this.swEst() + 1 > sw.L || this.swN + 1 > sw.rate * el + (sw.burst ?? 8)) { this.skipped++; return false; }
        this.swRec(); this.extras++; return true;
      }
      if (o.fixedWin) {
        const now = this.fwRoll(); const reserve = Math.min(Math.ceil((o.fixedWin.w - (now % o.fixedWin.w)) / o.fixedWin.qMs), this.qLeft ?? Infinity); // qLeft: first copies still to come in this run (set by the race loop)
        if (performance.now() < this.holdUntil || this.fwN + 1 + reserve > o.fixedWin.cap) { this.skipped++; return false; }
        this.fwN++; this.extras++; return true;
      }
      this.refill();
      if (performance.now() < this.holdUntil || this.tokens < 1) { this.skipped++; return false; }
      if (this.base && this.ewma > this.inflate * this.base) { this.inflated++; return false; }
      this.tokens -= 1; this.extras++; return true;
    },
    on429() { this.refusals++; this.rate = Math.max(this.minRate, this.rate * this.decr); this.tokens = Math.min(this.tokens, -this.penalty); this.holdUntil = performance.now() + this.holdMs; },
    onOk(ms) {
      if (ms > 0) { this.ewma = this.ewma ? 0.7 * this.ewma + 0.3 * ms : ms; if (++this.nOk === 8) this.base = this.ewma; }
      if (performance.now() >= this.holdUntil) this.rate = Math.min(this.maxRate, this.rate + this.incr);
    },
    snapshot() { return { ...(o.slideWin ? { swN: this.swN, swEst: Math.round(this.swEst()) } : {}), ...(o.fixedWin ? { fwN: this.fwN } : {}), rate: +this.rate.toFixed(1), tokens: +this.tokens.toFixed(1), refusals: this.refusals, extras: this.extras, skipped: this.skipped, inflated: this.inflated }; },
  };
}

// Same semantics as game_v3.submitHedged (+ fableB's dual.force). `input` may be an object or a pre-serialised body string.
export function submitHedged(proc, input, { ua, budget = null, hedgeAt = [70, 300, 800], dual = null, budgetMs = 4000, http, httpDual } = {}) {
  const eng = http ?? (MODE === 'ab' ? 'undici' : MODE); const engDual = httpDual ?? eng; // httpDual: paired engine A/B (dual copy on the other engine)
  const bodyStr = typeof input === 'string' ? input : JSON.stringify({ json: input });
  const t0 = performance.now(); const attempts = [];
  return new Promise((resolve) => {
    let done = false, pending = 0, refused = 0, retries = 0, k = 0; const timers = [];
    const finish = (r, won) => {
      done = true;
      resolve({ ok: r.ok, status: r.status, body: r.body, err: r.err, vid: r.vid, stiming: r.stiming, ms: Math.round(performance.now() - t0), attempt: won, attempts, refused, retries });
      for (let i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    };
    const fire = (who, kind) => {
      const e = kind === 'dual' ? engDual : eng; const a = { at: Math.round(performance.now() - t0), kind, ...(MODE === 'ab' ? { eng: e } : {}) }; attempts.push(a); pending++;
      rpcRaw(proc, bodyStr, ua, e).then((r) => {
        pending--;
        if (done) { a.status = r.status; a.ms = r.ms; if (r.status === 429) { refused++; budget?.on429(); } return; } // loser: same bookkeeping as game_v3
        if (r.ok) { finish(r, who); a.status = r.status; a.ms = r.ms; budget?.onOk(r.ms); return; } // resolve first, bookkeeping after
        a.status = r.status; a.ms = r.ms;
        if (r.status === 429) { refused++; budget?.on429(); }
        if (r.status === 409 && pending > 0) return; // stale-duplicate 409 must not beat a copy still in flight (reviewer 2026-10-03)
        if (!(r.status === 429 || r.status === 0 || r.status >= 500)) return finish(r, who);
        if (pending > 0) return;
        const back = r.status === 429 ? 35 + 15 * retries : [100, 250, 500][Math.min(retries, 2)];
        if (budgetMs - (performance.now() - t0) - back < 250 || retries >= (r.status === 429 ? 8 : 3)) return finish(r, who);
        retries++;
        timers.push(setTimeout(() => { if (!done) { budget?.spend(); fire(++k, 'retry'); } }, back));
      });
    };
    budget?.spend(); fire(0, 'first');
    let dualSent = false;
    if (dual && dual.delay >= 0 && (budget || dual.force)) {
      const go = () => { for (let c = 0; c < (dual.copies || 1); c++) if (!done && (dual.force ? (budget?.spend(), true) : budget.take())) { dualSent = true; fire(++k, 'dual'); } }; // copies: extra copies sent at once (2 = triple send)
      if (dual.delay === 0) go(); else timers.push(setTimeout(go, dual.delay));
    }
    for (const at of hedgeAt) {
      if (at < budgetMs - 150) timers.push(setTimeout(() => { if (!done && pending > 0 && !(dualSent && at < (dual?.skipHedgeBelow ?? 0))) { if (budget?.strict && at < 300) { if (!budget.take()) return; } else budget?.spend(); fire(++k, 'hedge'); } }, at));
    }
  });
}
