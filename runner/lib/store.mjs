// Run-data storage. Since 2026-10-03: Cloudflare Worker "aw-runlogs" (D1, gzip) when CF_LOG_URL is set — the Vercel Blob
// store was suspended (free-tier usage). Fallback: Vercel Blob. Never store PII: no email, no runToken, no Turnstile token.
import { put } from '@vercel/blob';
import { gzipSync } from 'node:zlib';

const CF = process.env.CF_LOG_URL; // e.g. https://aw-runlogs.<your-subdomain>.workers.dev
export const cfHeaders = () => ({ 'x-secret': process.env.RUNNER_SECRET, 'content-type': 'application/json' });

export async function saveJson(pathname, data) {
  if (CF) {
    try {
      // compress HERE (Vercel has CPU to spare) and send raw gzip bytes: the Cloudflare Worker only stores them
      const raw = JSON.stringify(data), gz = gzipSync(raw);
      const r = await fetch(`${CF}/putgz`, { method: 'POST', headers: { 'x-secret': process.env.RUNNER_SECRET, 'content-type': 'application/octet-stream', 'x-pathname': pathname.replace(/\.json$/, `-${Math.random().toString(36).slice(2, 8)}.json`), 'x-raw-size': String(raw.length) }, body: gz });
      const j = await r.json().catch(() => null);
      return r.ok ? { pathname: j?.pathname, store: 'cf' } : { error: `cf HTTP ${r.status}` };
    } catch (e) { return { error: String(e) }; }
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { skipped: 'no store configured' };
  try {
    const r = await put(pathname, JSON.stringify(data), { access: 'private', contentType: 'application/json', addRandomSuffix: true });
    return { pathname: r.pathname };
  } catch (e) { return { error: String(e) }; }
}
