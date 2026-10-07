// PROTOTYPE (opusC, 2026-10-03) — minimal HTTP/1.1-over-TLS keep-alive client for the hot path (POST + small JSON reply).
// Why: at race cadence undici.request() costs ~0.9 ms/question more than a bare TLS socket on the Mac (llhttp-wasm
// parser, Readable body stream, promise layers). This client writes the request with ONE socket.write and parses the
// reply with indexOf on the raw bytes. Handles Content-Length and chunked replies, keep-alive, `connection: close`,
// 1xx, socket errors (→ status 0, which submitHedged already treats as a network error).
// Same request headers as undici.request() sends (host, connection: keep-alive, content-length + ours).
import tls from 'node:tls';

const CRLF2 = Buffer.from('\r\n\r\n');
export function makeRawClient(origin, { max = 8, servername } = {}) {
  const u = new URL(origin); const host = u.hostname; const port = Number(u.port || 443); const hostHdr = u.host;
  const idle = []; let open = 0; let session = null;
  const connect = () => new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: servername ?? host, ALPNProtocols: ['http/1.1'], ...(session ? { session } : {}) });
    open++; s.setNoDelay(true);
    s.once('session', (sess) => { session = sess; });
    const onErr = (e) => { reject(e); };
    s.once('error', onErr);
    s.once('secureConnect', () => { s.off('error', onErr); wire(s); resolve(s); });
  });
  const drop = (s) => { if (s.__dead) return; s.__dead = true; open--; const i = idle.indexOf(s); if (i >= 0) idle.splice(i, 1); s.destroy(); };
  function wire(s) {
    s.__cb = null; s.__buf = null;
    s.on('data', (chunk) => { s.__buf = s.__buf ? Buffer.concat([s.__buf, chunk]) : chunk; tryParse(s); });
    const fail = (e) => { const cb = s.__cb; s.__cb = null; drop(s); if (cb) cb(e || new Error('socket closed')); };
    s.on('error', fail); s.on('close', () => fail(null));
  }
  function tryParse(s) {
    const b = s.__buf; if (!s.__cb || !b) return;
    const he = b.indexOf(CRLF2); if (he < 0) return;
    const head = b.latin1Slice(0, he);
    const status = Number(head.slice(9, 12));
    if (status >= 100 && status < 200) { s.__buf = b.length > he + 4 ? b.subarray(he + 4) : null; return tryParse(s); }
    const lines = head.split('\r\n'); const h = {};
    for (let i = 1; i < lines.length; i++) { const c = lines[i].indexOf(':'); if (c > 0) h[lines[i].slice(0, c).toLowerCase()] = lines[i].slice(c + 1).trim(); }
    let body, rest;
    if (h['content-length'] !== undefined) {
      const cl = Number(h['content-length']); if (b.length - he - 4 < cl) return;
      body = b.subarray(he + 4, he + 4 + cl); rest = b.length > he + 4 + cl ? b.subarray(he + 4 + cl) : null;
    } else if (/chunked/i.test(h['transfer-encoding'] ?? '')) {
      const parts = []; let p = he + 4;
      for (;;) {
        const le = b.indexOf('\r\n', p); if (le < 0) return;
        const size = parseInt(b.latin1Slice(p, le), 16); if (Number.isNaN(size)) return fail(s, new Error('bad chunk'));
        if (size === 0) { const end = b.indexOf(CRLF2, le - 2); if (end < 0) return; p = end + 4; break; }
        if (b.length < le + 2 + size + 2) return;
        parts.push(b.subarray(le + 2, le + 2 + size)); p = le + 2 + size + 2;
      }
      body = parts.length === 1 ? parts[0] : Buffer.concat(parts); rest = b.length > p ? b.subarray(p) : null;
    } else return fail(s, new Error('no length')); // close-delimited bodies are not expected from this API
    s.__buf = rest; const cb = s.__cb; s.__cb = null;
    if (/close/i.test(h.connection ?? '')) drop(s); else idle.push(s);
    cb(null, status, h, body.toString('utf8'));
  }
  function fail(s, e) { const cb = s.__cb; s.__cb = null; drop(s); cb?.(e); }
  // headers: object of extra headers (lower-case names). Returns {status, headers, text} or throws.
  // Written synchronously when an idle keep-alive socket exists (the normal case during a race).
  const send = (s, path, headersStr, body) => new Promise((resolve, reject) => {
    s.__cb = (e, status, h, text) => (e ? reject(e) : resolve({ status, headers: h, text }));
    s.write(`POST ${path} HTTP/1.1\r\nhost: ${hostHdr}\r\nconnection: keep-alive\r\n${headersStr}content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  function request(path, headersStr, body) {
    const s = idle.pop(); if (s) return send(s, path, headersStr, body);
    if (open >= max) return Promise.reject(new Error('pool exhausted'));
    return connect().then((c) => send(c, path, headersStr, body));
  }
  const headerString = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return { request, headerString, stats: () => ({ open, idle: idle.length }) };
}
