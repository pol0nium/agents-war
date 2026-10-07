// POST /api/race5 — EXPERIMENT (2026-10-01): race3 loop + two options, everything else identical.
//   * body.start = { turnstileToken, email, locale }: the RUNNER calls startRunV2 itself (fra1, same region as the game)
//     and starts answering at once → removes the page(Paris)→runner hand-off from the server clock. Emits
//     {type:'started', runToken, startMs} so the page still knows the runToken.
//   * body.hot = { rps }: a light background stream of read-only getCompetition calls during the race (keep-hot test).
// /api/race and /api/race3 are untouched.
// POST /api/race3 — v3 answer loop (2026-10-01). Same protocol as /api/race (NDJSON ready/q/handoff/error/end/saved),
// so the page driver only needs `apiPath: '/api/race3'`. Differences:
//   * refusal-proof hedging: a 429 never wins against an in-flight copy; retries happen inside submitHedged
//   * budgeted DUAL copy: body.dual = { delay: 12, rate: 28, burst: 6, maxRate: 33 } → a 2nd copy of each answer
//     `delay` ms after the first, only while our token-bucket estimate of the server's budget has a token (AIMD)
//   * per-question log: attempts [{at,kind,status,ms}], refused, retries, vid (x-vercel-id), rate (budget estimate)
//   * GET ?warm=1&prewarm=60&conc=3: read-only server-instance pre-warm (sequential ≤ 20 req/s) + opens `conc`
//     keep-alive sockets so parallel copies never pay a TLS handshake during the race. No life is consumed.
// PROTOTYPE (opusC, 2026-10-03) — race5.js with the critical path (reply received → next answer on the wire) trimmed.
// Same NDJSON protocol/events. Changes (each switchable via body.opusC = { deferEmit, prebuilt, warm }, default all on):
//   * deferEmit: every event is captured synchronously (same `t`) but serialised/encoded/enqueued in ONE setImmediate
//     after the next request has been written; the q event object is also BUILT there (closure) → no stringify,
//     TextEncoder, object spreads or vids bookkeeping between a reply and the next send.
//   * prebuilt: answer body = constant per-run prefix + drillId + submission (byte-identical to JSON.stringify), serialised
//     once per question (game_v3 re-stringified it for every copy).
//   * warm: before startRunV2 (clock not running) run every solver template + the event/body code paths, and route the
//     existing prewarm calls through submitHedged so the submit path is compiled.
//   * lib/solvers_opusC.mjs: template fast paths + exact fast rule induction (identical answers on all known prompts).
//   * lib/game_opusC.mjs: undici request() (fableB), cached headers, string bodies, resolve-before-bookkeeping.
import * as SOLV_NEW from '../lib/solvers_opusC.mjs';
import * as SOLV_OLD from '../lib/solvers.mjs'; // ablation only (body.opusC.solvers = 'orig')
import { rpc, rpcRaw, submitHedged, deadlineMs, makeBudget, answerBodyBuilder, setHttpMode, preopenSockets } from '../lib/game_opusC.mjs';
import { saveJson } from '../lib/store.mjs';
import { waitUntil } from '@vercel/functions';
import { CORS, authorized, safeId } from '../lib/http.mjs';

const WARM_PROMPTS = [
  'TEXT: PDQGCURFICAKFPBJZXDZCC | TASK: how many times does the letter C appear | ANSWER: digits only',
  'WORDS: NIMIHRA JAGI JITIVA LEVXEWEP | TASK: take word number 3, counting from 1, write it backwards, drop every vowel (AEIOU) | ANSWER: letters only, no spaces',
  'LIST: CESUDER NIFRU SEXPOWRUD FASVIHBU | TASK: the word at position 3, counting from 1 | ANSWER: the word',
  'START at 0,0 | MOVES: RUURUULLLURRLR (U adds 1 to y, D subtracts 1 from y, L subtracts 1 from x, R adds 1 to x) | TASK: the final position | ANSWER: two numbers separated by a comma, x first, nothing else',
  'TEXT: NGNDADP | TASK: apply ROT13 (shift every letter forward by 13, wrapping Z to A) | ANSWER: letters only, no spaces',
  'TASK: compute (648 * 65 + 86) mod 7 | ANSWER: digits only',
  'LIST: QCR JGVMY TXP IVLES XJOWPL WUGMU TLT VBUIU | TASK: the word immediately before the longest word | ANSWER: the word',
  'START: you hold 4 red tokens and 3 blue tokens. You give away 3 red tokens. Everything happens except this: you give away 3 blue tokens. You take 2 red tokens. | TASK: how many red tokens do you hold at the end | ANSWER: digits only',
  'BRACKETS: ((())())()()()()((((()())))) | TASK: the maximum nesting depth (the outermost bracket counts as depth 1), then the position of the bracket where that depth is first reached, counting from 1 | ANSWER: two numbers separated by a comma, the depth first, nothing else',
  'EXAMPLES: dbada -> yhayba ; ddddb -> ybybybyh ; cdd -> cybyb ; bca -> bca | TASK: the same hidden rules transform aadb into what | ANSWER: letters only, no spaces',
  'GRID (three rows): DIB / AGE / KKT | TASK: rotate the grid 90 degrees clockwise, then read the three rows left to right | ANSWER: 9 letters, no separators',
  'TEXT: ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJ4KLMNOP | TASK: exactly one character is a digit, give its position, counting from 1 | ANSWER: digits only',
];
// opusC: one prompt per template not covered above (tokens with negation, brackets variant, rules 2-rule case).
const WARM_EXTRA = [
  'START: you hold 5 blue tokens and 2 red tokens. You take 3 blue tokens. You do NOT give away 1 blue tokens. You lose 2 red tokens. | TASK: how many blue tokens do you hold at the end | ANSWER: digits only',
  'EXAMPLES: cbacb -> cxecxa ; badda -> xedda ; bda -> xada ; dda -> dda | TASK: the same hidden rules transform bad into what | ANSWER: letters only, no spaces',
  'WORDS: NIMIHRA JAGI JITIVA LEVXEWEP | TASK: take word number 2, counting from 1, write it backwards, drop every vowel (AEIOU) | ANSWER: letters only, no spaces | Reply in lowercase.',
  'TEXT: KUQTYROKAJELNJSBZDHWNG | TASK: how many times does the letter G appear | ANSWER: digits only | Correct answer: NINE.',
];
const COMP = { productId: 'superchallenge', code: 'JAWVUX' };
// Instance tracking (2026-10-06): does Vercel run our parallel lanes on the SAME function instance (fluid compute)?
const INSTANCE = Math.random().toString(36).slice(2, 8); let INVOCATIONS = 0, CONCURRENT = 0;
const pop = (vid) => (vid ?? '?').split('::').slice(0, -1).join('::') || vid; // "cdg1::fra1::abcd" → "cdg1::fra1"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function OPTIONS() { return new Response(null, { status: 204, headers: CORS }); }

// GET /api/race3?warm=1&secret=...&samples=3&prewarm=60&conc=3 — warm THIS function instance, the game's server
// instance (read-only getCompetition calls, sequential, ≤ 20 req/s) and `conc` parallel keep-alive sockets.
export async function GET(request) {
  const u = new URL(request.url); const q = (k, d, lo, hi) => Math.min(Math.max(Number(u.searchParams.get(k)) || d, lo), hi);
  if (!authorized(u.searchParams.get('secret'))) return new Response('unauthorized', { status: 401, headers: CORS });
  const samples = q('samples', 3, 1, 12), prewarm = q('prewarm', 0, 0, 100), conc = q('conc', 3, 1, 4);
  const httpMode = setHttpMode(u.searchParams.get('http') === 'raw' ? 'raw' : 'undici'); // opusC: read-only engine check
  const ms = [], vids = {}; const tAll = performance.now();
  for (let i = 0; i < Math.max(samples, prewarm); i++) {
    const t = performance.now(); const r = await rpc('getCompetition', COMP); ms.push(r.ms); vids[pop(r.vid)] = (vids[pop(r.vid)] ?? 0) + 1;
    const left = 50 - (performance.now() - t); if (left > 0 && i < Math.max(samples, prewarm) - 1) await sleep(left); // ≤ 20 req/s
  }
  // Open extra sockets: two rounds of `conc` parallel read-only calls (a parallel copy during the race must not handshake).
  const par = [];
  for (let round = 0; round < 2; round++) par.push((await Promise.all(Array.from({ length: conc }, () => rpc('getCompetition', COMP)))).map((r) => r.ms));
  const head = ms.slice(1, samples); const sorted = [...(head.length ? head : ms)].sort((a, b) => a - b); const medianMs = sorted[sorted.length >> 1];
  const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null);
  const t = performance.now(); const jit = WARM_PROMPTS.concat(WARM_EXTRA).map((p) => SOLV_NEW.solveDeterministic(p)?.how ?? null); const jitMs = Math.round(performance.now() - t);
  return new Response(JSON.stringify({ warm: true, v: 3, variant: 'opusC', http: httpMode, region: process.env.VERCEL_REGION ?? 'local', ms, medianMs, par, vids,
    prewarm: { n: ms.length, first30: mean(ms.slice(0, 30)), last30: mean(ms.slice(-30)), totalMs: Math.round(performance.now() - tAll) }, jit, jitMs }),
    { headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export async function POST(request) {
  let body; try { body = JSON.parse(await request.text()); } catch { return new Response('bad json', { status: 400, headers: CORS }); }
  if (!authorized(body.secret)) return new Response('unauthorized', { status: 401, headers: CORS });
  // Kill switch for orphaned chase tabs (2026-10-03): only chases launched with the current tag may start runs.
  if (process.env.CHASE_TAG !== undefined ? body.chase !== process.env.CHASE_TAG : body.chase !== 'g2') return new Response('stale chase', { status: 410, headers: CORS });
  let { runToken } = body; const { code = 'JAWVUX', ua } = body; const startIn = body.start && typeof body.start === 'object' ? body.start : null; const hotRps = Math.min(Number(body.hot?.rps) || 0, 15); const hasSolver = !!body.hasSolver;
  // Tail hedges (ms after the first send), mandatory: protect against the ~2 s server spikes.
  const hedgeAt = Array.isArray(body.hedgeAt) ? body.hedgeAt.map(Number).filter((x) => x > 0).slice(0, 4) : [70, 300, 800];
  // Budgeted dual copy. Absent/null → single send (+ the 429 fix), i.e. the previous runner's behaviour.
  const dualIn = body.dual && typeof body.dual === 'object' ? body.dual : null;
  const newBudget = () => dualIn ? makeBudget({ rate: Number(dualIn.rate) || 28, burst: Number(dualIn.burst) || 6, maxRate: Number(dualIn.maxRate) || 33,
    ...(dualIn.decr ? { decr: Number(dualIn.decr) } : {}), ...(dualIn.incr ? { incr: Number(dualIn.incr) } : {}), ...(dualIn.penalty != null ? { penalty: Number(dualIn.penalty) } : {}), ...(dualIn.inflate ? { inflate: Number(dualIn.inflate) } : {}), ...(dualIn.slideWin ? { slideWin: { L: Math.min(Math.max(Number(dualIn.slideWin.L) || 244, 100), 247), rate: Math.min(Math.max(Number(dualIn.slideWin.rate) || 38, 5), 45), burst: Number(dualIn.slideWin.burst ?? 8), noCopyBelow: Number(dualIn.slideWin.noCopyBelow ?? 11), project: !!dualIn.slideWin.project, qMs: Number(dualIn.slideWin.qMs) || 42 } } : {}), ...(dualIn.fixedWin ? { fixedWin: { w: 10000, cap: Math.min(Math.max(Number(dualIn.fixedWin.cap) || 235, 100), 246), qMs: Math.max(Number(dualIn.fixedWin.qMs) || 38, 20) } } : {}) }) : null;
  let budget = newBudget();
  const dual = dualIn ? { delay: Math.max(0, Number(dualIn.delay ?? 12)), skipHedgeBelow: Number(dualIn.skipHedgeBelow) || 0, copies: Math.min(Math.max(Number(dualIn.copies) || 1, 1), 3) } : null;
  // Adaptive copies (2026-10-03): slow replies cluster in time (not by question type) → send `hot.copies` extra copies on the
  // first `hot.early` questions and right after a reply that was > `hot.slow` ms above the running median-ish (EWMA) latency.
  const hotIn = dualIn && dualIn.hot && typeof dualIn.hot === 'object' ? dualIn.hot : null;
  const dualHot = hotIn ? { ...dual, copies: Math.min(Math.max(Number(hotIn.copies) || 2, 1), 3) } : null;
  const hotEarly = Number(hotIn?.early ?? 20), hotSlow = Number(hotIn?.slow ?? 20); let ewmaMs = 0, lastMs = 0, nHot = 0;
  // Practice mode: never submit the answer to question `stopBefore` (200 = the scoring answer that ends the game).
  const stopBefore = Number(body.stopBefore) || 0; const finishMaxMs = Number(body.finishMaxMs) || 0; const finishMinMs = Number(body.finishMinMs) || 0;
  const runId = safeId(body.runId), segment = Number(body.segment) || 0;
  let drill = body.drill, n = Number(body.n0) || 0;
  const targetMs = Number(body.targetMs) || 0, elapsedAtStart = Number(body.elapsedMs) || 0, tSeg = performance.now();
  // With runner-side start the score clock starts at the server's own stamp (run token iat) → pace against that.
  let raceStartEpoch = 0, tStartedPerf = 0;
  // Early abort (HFT-B, 2026-10-03): body.abort = { target, alpha, beta, every } — every `every` answers, stop the run if
  // elapsed since 'started' > (target − 69)·n/199·(1+alpha) + beta (it can no longer beat target). Practice/throwaway use only.
  const ab = body.abort && typeof body.abort === 'object' ? { target: Number(body.abort.target), alpha: Number(body.abort.alpha) || 0.05, beta: Number(body.abort.beta) || 150, every: Number(body.abort.every) || 10 } : null;
  const raceElapsed = () => (raceStartEpoch ? Date.now() - raceStartEpoch : elapsedAtStart + (performance.now() - tSeg));
  const oc = { deferEmit: true, prebuilt: true, warm: true, ...(body.opusC && typeof body.opusC === 'object' ? body.opusC : {}) };
  setHttpMode(oc.http ?? 'undici');
  const { solveDeterministic, solveLenient } = oc.solvers === 'orig' ? SOLV_OLD : SOLV_NEW;
  const enc = new TextEncoder(); const events = []; const t0 = Date.now(); const vids = {};

  const stream = new ReadableStream({
    async start(ctrl) {
      // Events are pushed in call order; with deferEmit the wire write happens in one setImmediate per tick (after the
      // next request has been written). flush() is also called before the stream closes.
      const outQ = []; let outSched = false;
      const flush = () => { outSched = false; if (!outQ.length) return; let s = ''; for (const e of outQ) s += JSON.stringify(typeof e === 'function' ? e() : e) + '\n'; outQ.length = 0; try { ctrl.enqueue(enc.encode(s)); } catch {} };
      const emit = (o) => { const e = { t: Date.now() - t0, ...o }; events.push(e); if (!oc.deferEmit) { try { ctrl.enqueue(enc.encode(JSON.stringify(e) + '\n')); } catch {} return; } outQ.push(e); if (!outSched) { outSched = true; setImmediate(flush); } };
      // emitLazy(build): `t` taken now, the event object built later (off the critical path). Keeps event order.
      const emitLazy = (build) => {
        const t = Date.now() - t0; if (!oc.deferEmit) return emit(build());
        const slot = { t }; events.push(slot); // replaced in place when built
        const idx = events.length - 1;
        outQ.push(() => { const e = { t, ...build() }; events[idx] = e; return e; }); if (!outSched) { outSched = true; setImmediate(flush); }
      };
      INVOCATIONS++; CONCURRENT++;
      emit({ type: 'ready', instance: INSTANCE, invocation: INVOCATIONS, concurrent: CONCURRENT, v: 5, variant: 'opusC', opusC: oc, start: !!startIn, hotRps, region: process.env.VERCEL_REGION ?? 'local', n0: n, dual: dualIn ? { ...dual, ...budget.snapshot() } : null, hedgeAt });
      if (oc.warm) { // JIT warm-up of the solver templates and the event path, before the clock starts
        const tw = performance.now(); const W = WARM_PROMPTS.concat(WARM_EXTRA);
        for (let i = 0; i < 40; i++) for (const p of W) { if (i >= 5 && p.startsWith('EXAMPLES')) continue; const s = solveDeterministic(p); if (s) JSON.stringify({ t: i, type: 'q', n: i, answer: s.answer, how: s.how }); }
        emit({ type: 'warm', ms: +(performance.now() - tw).toFixed(1) });
      }
      let hotOn = false; const hot = { n: 0, ms: [] };
      try {
        // startRun(tok, email): startRunV2 + run-state reset. Used for the first start and for in-slot restarts.
        let s0 = 0, restarts = 0; const spares = Array.isArray(startIn?.spares) ? startIn.spares.filter((x) => x && x.turnstileToken && x.email).slice(0, 3) : [];
        const startRun = async (tok, email) => {
          const ts = performance.now();
          const st = await rpc('startRunV2', { productId: 'superchallenge', code, locale: startIn.locale ?? 'en', uiLocale: startIn.locale ?? 'en', turnstileToken: tok, email }, { ua });
          const startMs = Math.round(performance.now() - ts);
          if (!st.ok) { emit({ type: 'error', n, status: st.status, body: st.body, err: st.err, phase: 'start', startMs }); return false; }
          runToken = st.body.runToken; drill = st.body.drills?.[0]; n = 0;
          try { raceStartEpoch = JSON.parse(Buffer.from(String(runToken).split('.')[0], 'base64url').toString()).iat || Date.now(); } catch { raceStartEpoch = Date.now(); }
          s0 = Date.now() - raceStartEpoch; tStartedPerf = performance.now(); budget = newBudget(); lastMs = 0; ewmaMs = 0;
          emit({ type: 'started', runToken, startMs, drill, iat: raceStartEpoch, s0, email, restart: restarts });
          return true;
        };
        if (startIn) {
          const pre = Math.min(Number(startIn.prewarm) || 0, 80); const preMs = [];
          for (let i = 0; i < pre; i++) preMs.push((oc.warm ? await submitHedged('getCompetition', COMP, { ua, hedgeAt: [] }) : await rpc('getCompetition', COMP)).ms); // back-to-back, right before the clock starts
          if (pre) emit({ type: 'prewarm', n: pre, ms: preMs });
          // Open `sockets` keep-alive connections before the clock starts (copies/hedges never handshake on the clock).
          // start.phase: wait until that ms within the clock-aligned 10 s window (e.g. 6000 → :x6) BEFORE startRunV2.
          // start.warmLate: do the socket warm-up right before the phase (finishing ~:x5.9) instead of before the wait.
          const sockets = Math.min(Math.max(Number(startIn.sockets ?? 4), 0), 6);
          const warmSockets = async () => { if (sockets > 1) { const tp = performance.now(); const rounds = await preopenSockets(sockets, COMP); emit({ type: 'sockets', n: sockets, rounds, ms: Math.round(performance.now() - tp) }); } };
          const ph = startIn.phase != null ? ((Number(startIn.phase) % 10000) + 10000) % 10000 : null;
          const untilPhase = () => (ph - (Date.now() % 10000) + 10000) % 10000;
          if (ph != null && startIn.warmLate) {
            let wait = untilPhase(); if (wait < 400) wait += 10000; // too close: take the next slot so the warm-up fits
            emit({ type: 'phase', phase: ph, wait, warmLate: true }); await sleep(Math.max(0, wait - 350)); await warmSockets(); const rest = untilPhase(); if (rest > 0 && rest < 1000) await sleep(rest);
          } else {
            await warmSockets();
            if (ph != null) { const wait = untilPhase(); emit({ type: 'phase', phase: ph, wait }); if (wait > 0) await sleep(wait); }
          }
          if (!(await startRun(startIn.turnstileToken, startIn.email))) drill = null;
        }
        // In-slot restart (reviewer A, 2026-10-03): with :x6 starts every attempt costs a 10 s slot, so instead of aborting a
        // bad run and idling, start a fresh run immediately with a spare Turnstile token while still early in the slot.
        // body.screen = { s0Max: 100, q10Frac: 0.062, untilMs: 7300 }: restart if s0 (start reply − iat) > s0Max (before the
        // first answer) or if elapsed since iat at Q10 > q10Frac × abort target; only while clock ms-in-window < untilMs.
        const sc = body.screen && typeof body.screen === 'object' && ab?.target ? { s0Max: Number(body.screen.s0Max ?? 100), q10Frac: Number(body.screen.q10Frac ?? 0.062), q10Ms: Number(body.screen.q10Ms) || 0, untilMs: Number(body.screen.untilMs ?? 7300) } : null;
        const inSlot = () => { const w = Date.now() % 10000; return w >= 5000 && w < sc.untilMs; };
        const tryRestart = async (reason, val) => {
          if (!sc || !spares.length || !inSlot()) return false;
          const sp = spares.shift(); restarts++; emit({ type: 'restart', reason, val, n, restarts });
          if (await startRun(sp.turnstileToken, sp.email)) return true;
          drill = null; return 'failed';
        };
        let mkBody = oc.prebuilt && runToken ? answerBodyBuilder(code, runToken) : null, mkTok = runToken;
        if (hotRps && drill) { hotOn = true; (async () => { while (hotOn) { const t = performance.now(); const r = await rpc('getCompetition', COMP); hot.n++; hot.ms.push(r.ms); const left = 1000 / hotRps - (performance.now() - t); if (left > 0) await sleep(left); } })(); }
        while (drill) {
          if (sc && n === 0 && s0 > sc.s0Max) { const rr = await tryRestart('s0', s0); if (rr === 'failed') break; }
          if (mkTok !== runToken) { mkBody = oc.prebuilt && runToken ? answerBodyBuilder(code, runToken) : null; mkTok = runToken; }
          const qn = n + 1; const tQ = performance.now();
          // finishMaxMs: only send the FINAL (200th) answer if the server-clock elapsed (from the run token's iat, i.e. the
          // server's own start stamp) plus one median answer stays under finishMaxMs; otherwise hold the run (no new score).
          // finishMinMs: never finish faster than this (server clock from the run token's iat). If the projected time of the
          // final answer is below it, wait the difference first. Projection uses a deliberately LOW last-answer latency (30 ms)
          // so the real finish is always ≥ finishMinMs.
          if (finishMinMs && qn === 200 && raceStartEpoch) {
            const projectedFast = Date.now() - raceStartEpoch + 30;
            const holdMs = Math.max(0, finishMinMs - projectedFast);
            if (holdMs > 0) await sleep(holdMs);
            emit({ type: 'floor', projectedFast, holdMs, finishMinMs });
          }
          if (finishMaxMs && qn === 200) {
            let iat = 0; try { iat = JSON.parse(Buffer.from(String(runToken).split('.')[0], 'base64url').toString()).iat || 0; } catch {}
            const projected = iat ? Date.now() - iat + (Number.isFinite(Number(body.holdOffset)) ? Number(body.holdOffset) : 10) : Infinity; // server stamps the finish ~3 ms after we send (measured 2026-10-02)
            if (!(projected <= finishMaxMs)) { emit({ type: 'end', n, ended: 'held', projected, finishMaxMs, vids, budget: budget?.snapshot() ?? null }); break; }
            emit({ type: 'finishing', projected, finishMaxMs });
          }
          if (stopBefore && qn >= stopBefore) { emit({ type: 'end', n, ended: 'practice-stop', stopBefore, elapsedMs: Date.now() - t0, vids, budget: budget?.snapshot() ?? null }); break; }
          const prompt = drill?.patternData?.prompt ?? '';
          const tS = performance.now(); let sol = solveDeterministic(prompt);
          if (!sol && !hasSolver) sol = solveLenient(prompt);
          const solveMs = +(performance.now() - tS).toFixed(2);
          if (!sol) { emit({ type: 'handoff', n, drill, reason: 'unknown-template', solveMs }); break; }
          if (targetMs) {
            const wait = Math.min(targetMs * (qn - 1) / 200 - raceElapsed(), deadlineMs(qn) - (performance.now() - tQ) - 600);
            if (wait > 0) await sleep(wait);
          }
          // within-run randomised experiment: pause a random number of ms (from body.gapRand) before sending
          const gapMs = Array.isArray(body.gapRand) && body.gapRand.length ? Number(body.gapRand[Math.floor(Math.random() * body.gapRand.length)]) || 0 : 0;
          if (gapMs) await sleep(gapMs);
          const input = mkBody ? mkBody(drill.id, String(sol.answer)) : { productId: 'superchallenge', code, runToken, drillId: drill.id, submission: String(sol.answer) };
          // oc.http === 'ab': within-run PAIRED A/B of the HTTP engine — the first copy uses a random engine, the dual copy
          // (sent at the same instant) the other one; compare attempts[].ms of the two copies of the same question.
          const eng = oc.http === 'ab' ? (Math.random() < 0.5 ? 'raw' : 'undici') : undefined;
          if (budget) { budget.qLeft = 200 - qn; budget.qn = qn; }
          const isHot = dualHot && (qn <= hotEarly || (ewmaMs && lastMs > ewmaMs + hotSlow)); if (isHot) nHot++;
          const r = await submitHedged('submitAnswerV2', input, { ua, budget, hedgeAt, dual: qn === 200 && body.lastSingle ? null : (isHot ? dualHot : dual), // lastSingle: Q200's reply time doesn't count; skip its copy (peak-budget relief)
            http: eng, httpDual: eng && (eng === 'raw' ? 'undici' : 'raw'), budgetMs: deadlineMs(qn) - (performance.now() - tQ) });
          if (!r.ok) { if (r.vid) vids[pop(r.vid)] = (vids[pop(r.vid)] ?? 0) + 1; emit({ type: 'error', n, drill, answer: sol.answer, status: r.status, body: r.body, err: r.err, attempts: r.attempts }); break; }
          lastMs = r.ms; ewmaMs = ewmaMs ? 0.9 * ewmaMs + 0.1 * r.ms : r.ms;
          const res = r.body; n = qn; const qd = drill, rate0 = budget ? budget.rate : 0;
          emitLazy(() => { if (r.vid) vids[pop(r.vid)] = (vids[pop(r.vid)] ?? 0) + 1;
            return { type: 'q', n: qn, drill: qd, answer: sol.answer, how: sol.how, ms: r.ms, solveMs, ...(gapMs ? { gapMs } : {}), ...(isHot ? { hot: 1 } : {}), ...(eng ? { eng } : {}),
            ...(r.attempt ? { hedgeWon: r.attempt } : {}), ...(r.attempts.length > 1 ? { attempts: r.attempts } : {}),
            ...(r.refused ? { refused: r.refused } : {}), ...(r.retries ? { retries: r.retries } : {}),
            ...(r.vid ? { vid: r.vid } : {}), ...(res.isReplay ? { isReplay: true } : {}), ...(budget ? { rate: +rate0.toFixed(1) } : {}),
            result: { isCorrect: res.isCorrect, runningScore: res.runningScore, ended: res.ended ?? null }, next: res.next ?? null }; });
          if (res.ended || !res.isCorrect) { emit({ type: 'end', n, ended: res.ended ?? 'wrong', elapsedMs: Date.now() - t0, vids, budget: budget?.snapshot() ?? null }); break; }
          drill = res.next;
          if (sc && n === 10) { const el10 = Date.now() - raceStartEpoch; if (el10 > (sc.q10Ms || sc.q10Frac * ab.target)) { const rr = await tryRestart('q10', el10); if (rr === true) continue; if (rr === 'failed') break; } }
          if (ab && ab.target && tStartedPerf && n < 199 && n % ab.every === 0) {
            // reviewer B: after Q100 the margin shrinks to min(5 % of pace, 120 ms) (never killed a winner in replay).
            const el = performance.now() - tStartedPerf, pace = (ab.target - 69) * n / 199;
            const thr = n > 100 && body.abortLate ? pace + Math.min(0.05 * pace, 120) : pace * (1 + ab.alpha) + ab.beta;
            if (el > thr) { emit({ type: 'end', n, ended: 'aborted', el: Math.round(el), thr: Math.round(thr), vids, budget: budget?.snapshot() ?? null }); break; }
          }
          if (!drill) { emit({ type: 'end', n, ended: 'no-next', elapsedMs: Date.now() - t0, vids, budget: budget?.snapshot() ?? null }); break; }
        }
      } catch (e) { emit({ type: 'error', n, drill, status: 0, err: String(e) }); }
      flush(); hotOn = false; if (hotRps) emit({ type: 'hot', n: hot.n, ms: hot.ms });
      // Real (non-practice) runs: push the outcome to the phone via ntfy AFTER the race is over (no effect on timing).
      if (process.env.NTFY_TOPIC && !stopBefore) {
        try {
          const endEv = events.findLast?.((e) => e.type === 'end') ?? [...events].reverse().find((e) => e.type === 'end');
          if (body.quiet && endEv?.ended !== 'goal') throw 0; // quiet (throwaway) runs only notify when they actually finish
          const errEv = events.find((e) => e.type === 'error');
          // official time ≈ when the final answer was SENT (server stamps on receipt, ~3 ms later), not when its reply arrived
          const lastQ = [...events].reverse().find((e) => e.type === 'q');
          const sentEpoch = lastQ ? t0 + lastQ.t - (lastQ.ms || 0) : Date.now();
          const sec = raceStartEpoch ? ((sentEpoch - raceStartEpoch + 3) / 1000).toFixed(3) : '?';
          const who = startIn?.email ? String(startIn.email).split('@')[0] : 'run';
          let title, msg, prio = 'default';
          if (endEv?.ended === 'goal') { title = `Agents War: ${who} finished`; msg = `200/200 in ~${sec}s (server clock). Check the leaderboard!`; prio = 'urgent'; }
          else if (endEv?.ended === 'held') { title = `Agents War: ${who} held at Q199`; msg = `Projected ${(endEv.projected / 1000).toFixed(3)}s > limit ${(endEv.finishMaxMs / 1000).toFixed(3)}s, not submitted.`; }
          else { title = `Agents War: ${who} ended early`; msg = `ended=${endEv?.ended ?? 'error'} at Q${endEv?.n ?? errEv?.n ?? '?'} (${errEv?.status ?? ''})`; prio = 'high'; }
          const push = (t, b, p, tags) => fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, { method: 'POST', headers: { Title: t, Priority: p, Tags: tags }, body: b });
          if (endEv?.ended === 'goal') {
            // The page submits the score after this stream closes → look the entry up in the background, then push with the rank.
            const officialMs = Math.round(Number(sec) * 1000);
            waitUntil((async () => {
              let hit = null, entries = [];
              for (let i = 0; i < 20 && !hit; i++) {
                await sleep(1000);
                try {
                  const r = await rpc('getPublicLeaderboard', { productId: 'superchallenge', code, limit: 50 });
                  entries = r.body?.entries || [];
                  hit = entries.find((e) => e.score === 1000000 && e.nickname === (body.nick || 'pol0nium') && Math.abs(e.elapsedMs - officialMs) <= 60); // match OUR entry only (a rival's close time was matched once)
                } catch {}
              }
              const next = hit ? entries.find((e) => e.rank === hit.rank + 1) : null;
              const t = hit ? `${hit.nickname} is #${hit.rank} (${(hit.elapsedMs / 1000).toFixed(3)}s)` : `Agents War: ${who} finished (rank unknown)`;
              const b = hit ? `${who}: 200/200 in ${(hit.elapsedMs / 1000).toFixed(3)}s → rank #${hit.rank}` + (next ? ` · next: #${next.rank} ${next.nickname} ${(next.elapsedMs / 1000).toFixed(3)}s` : '') + (hit.rank > 1 ? ` · #1: ${entries[0]?.nickname} ${(entries[0]?.elapsedMs / 1000).toFixed(3)}s` : '')
                : `200/200 in ~${sec}s (server clock) — not found on the leaderboard after 20 s (submission failed?)`;
              await push(t, b, hit?.rank === 1 ? 'urgent' : 'high', hit?.rank === 1 ? 'trophy' : 'medal_sports').catch(() => {});
            })());
          } else {
            await push(title, msg, prio, 'hourglass');
          }
        } catch {}
      }
      CONCURRENT--;
      flush();
      // close the stream first (the page can start its next run), then save the log in the background
      try { ctrl.enqueue(enc.encode(JSON.stringify({ type: 'saved', saved: 'async' }) + '\n')); } catch {}
      try { ctrl.close(); } catch {}
      waitUntil(saveJson(`runs/${runId}/runner-seg${String(segment).padStart(2, '0')}.json`,
        { runId, segment, v: 5, start: !!startIn, hotRps, region: process.env.VERCEL_REGION ?? 'local', startedAt: new Date(t0).toISOString(), dual: dualIn, hedgeAt, events }).catch(() => {}));
    },
  });
  return new Response(stream, { headers: { ...CORS, 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
