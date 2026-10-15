// Minimal HTTP toolkit: router, body reading, JSON responses. No framework needed.
import { createServer } from 'node:http';

export class Router {
  constructor() { this.routes = []; }
  /** pattern like '/api/keys/:id' or '/v1/*' (trailing wildcard) */
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern
      .replace(/\/\*$/, '(?<wildcard>/.*)?')
      .replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return `(?<${k}>[^/]+)`; }) + '$');
    this.routes.push({ method, re, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }
  any(p, h) { return this.add('*', p, h); }
  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== '*' && r.method !== method) continue;
      const m = r.re.exec(path);
      if (m) return { handler: r.handler, params: m.groups ?? {} };
    }
    return null;
  }
}

export function readBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

export function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

/** Build a node http server from a router with uniform error handling. */
export function createApp(router, { onError } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const match = router.match(req.method, url.pathname);
    if (!match) return sendJson(res, 404, { error: 'not found' });
    try {
      await match.handler(req, res, { params: match.params, url });
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) onError?.(err);
      if (!res.headersSent) sendJson(res, status, { error: err.message, ...(err.extra ?? {}) });
      else res.end();
    }
  });
}

/** Admin auth: `Authorization: Bearer <token>` or `?token=` (for dashboard links/forms). Disabled when no token is configured. */
export function requireToken(req, expected, url) {
  if (!expected) return;
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (bearer === expected || url?.searchParams.get('token') === expected) return;
  throw new HttpError(401, 'unauthorized');
}
/** Query-string suffix that carries the dashboard token through links and form actions. */
export const tokenQs = (url, expected) => (expected ? `?token=${encodeURIComponent(url.searchParams.get('token') ?? '')}` : '');
export const redirect = (res, to) => { res.writeHead(303, { location: to }); res.end(); };
export async function readForm(req) { return Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8'))); }
