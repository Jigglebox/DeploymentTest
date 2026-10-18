// Multi-tenant accounts shared by hosted products: orgs with password login, an API token, a plan and billing
// state. single mode = one implicit default org gated by the admin token; hosted mode = signup/login.
import { randomBytes, createHash, hkdfSync } from 'node:crypto';
import { readForm, sendHtml, sendJson, redirect, requireToken, HttpError } from './http.js';
import { layout, esc } from './html.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from './crypto.js';
import { nowIso } from './db.js';

export const DEFAULT_ORG = 'org_default';
const COOKIE = 'tenant_session';
const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');
const parseCookies = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

const DDL = `CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, password_hash TEXT, token_hash TEXT UNIQUE, token_prefix TEXT,
  plan TEXT, billing TEXT, created_at TEXT NOT NULL);`;

export function createTenancy({ db, product, mode = 'single', adminToken = '', sessionSecret = '', publicUrl = '', defaultPlan = 'free', tokenPrefix = 'org_', onSignup = () => {} }) {
  db.exec(DDL);
  const hosted = mode === 'hosted';
  if (hosted && !sessionSecret) throw new Error(`${product}: hosted mode needs a session secret`);
  if (hosted && !adminToken) throw new Error(`${product}: hosted mode requires an admin token for operator routes`);
  // Never sign cookies with the raw secret (it may double as an encryption key elsewhere): derive a purpose-bound key.
  const cookieKey = sessionSecret ? Buffer.from(hkdfSync('sha256', sessionSecret, `${product}-session`, 'tenant-session-v1', 32)).toString('hex') : '';
  const signupHits = new Map();
  const cleanName = (name, fallback) => { const n = String(name ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[^\p{L}\p{N} .,'&()_-]/gu, '').trim().slice(0, 80); return n || fallback; };
  const q = {
    insert: db.prepare('INSERT INTO orgs (id,name,email,password_hash,token_hash,token_prefix,plan,billing,created_at) VALUES (?,?,?,?,?,?,?,?,?)'),
    byId: db.prepare('SELECT * FROM orgs WHERE id=?'),
    byEmail: db.prepare('SELECT * FROM orgs WHERE email=?'),
    byToken: db.prepare('SELECT * FROM orgs WHERE token_hash=?'),
    bySub: db.prepare("SELECT * FROM orgs WHERE json_extract(billing,'$.subscriptionId')=?"),
    setPlan: db.prepare('UPDATE orgs SET plan=? WHERE id=?'),
    setBilling: db.prepare('UPDATE orgs SET billing=? WHERE id=?'),
    paying: db.prepare("SELECT plan, billing FROM orgs WHERE plan IS NOT NULL AND plan<>'free'"),
  };
  const view = (row) => row ? { ...row, billing: row.billing ? JSON.parse(row.billing) : null, password_hash: undefined, token_hash: undefined } : null;

  const t = {
    hosted, DEFAULT_ORG,
    ensureDefaultOrg() { if (!q.byId.get(DEFAULT_ORG)) q.insert.run(DEFAULT_ORG, 'default', null, null, null, null, null, null, nowIso()); return t.getOrg(DEFAULT_ORG); },
    createOrg({ name, email, password }) {
      const mail = String(email ?? '').toLowerCase().trim();
      if (!mail || !String(password ?? '').length) throw new HttpError(400, 'email and password are required');
      if (q.byEmail.get(mail)) throw new HttpError(409, 'an account with that email already exists');
      const id = 'org_' + randomBytes(8).toString('hex');
      const raw = tokenPrefix + randomBytes(24).toString('base64url');
      q.insert.run(id, cleanName(name, mail.split('@')[0]), mail, hashPassword(password), hashToken(raw), raw.slice(0, tokenPrefix.length + 4) + '…', null, null, nowIso());
      return { ...t.getOrg(id), raw_token: raw };
    },
    getOrg: (id) => view(q.byId.get(id)),
    orgByToken: (raw) => view(q.byToken.get(hashToken(raw))),
    orgBySubscription: (subId) => view(q.bySub.get(subId)),
    login(email, password) { const row = q.byEmail.get(String(email ?? '').toLowerCase().trim()); return row && verifyPassword(password ?? '', row.password_hash) ? view(row) : null; },
    setOrgPlan: (id, plan) => q.setPlan.run(plan, id),
    setOrgBilling: (id, billing) => q.setBilling.run(JSON.stringify(billing), id),
    plan: (id, fallback = defaultPlan) => t.getOrg(id)?.plan ?? fallback,
    /** Recurring revenue from plans on record; prices in cents per seat (billing.quantity, default 1). */
    mrr(prices, label = 'MRR') {
      let mrr = 0, paying = 0;
      for (const r of q.paying.all()) { const b = r.billing ? JSON.parse(r.billing) : {}; const p = prices[r.plan]; if (p == null) continue; mrr += p * (b.quantity ?? 1); paying++; }
      return { label, mrr_cents: mrr, paying };
    },

    /** Resolve the org for an admin/dashboard request or throw 401. */
    requireOrg(req, url) {
      if (!hosted) { requireToken(req, adminToken, url); return t.ensureDefaultOrg(); }
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (bearer.startsWith(tokenPrefix)) { const org = t.orgByToken(bearer); if (org) return org; }
      const session = verifyToken(parseCookies(req)[COOKIE], cookieKey);
      const org = session?.org ? t.getOrg(session.org) : null;
      if (!org) throw new HttpError(401, 'sign in required', { login: `${publicUrl}/login` });
      return org;
    },
    /** Operator-only check (growth metrics etc.): admin token in hosted mode, same as requireOrg in single mode. */
    requireOperator(req, url) { requireToken(req, adminToken, url); },

    register(router) {
      if (!hosted) return;
      const setSession = (res, orgId) => res.setHeader('set-cookie', `${COOKIE}=${signToken({ org: orgId }, cookieKey)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${publicUrl.startsWith('https') ? '; Secure' : ''}`);
      const page = (res, title, inner, status = 200) => sendHtml(res, layout({ title: `${product} · ${title}`, product, nav: [{ href: '/login', label: 'Sign in' }, { href: '/signup', label: 'Create account' }], body: inner }), status);
      const formPage = (kind, error = '') => `<div class="tile" style="max-width:420px;margin:40px auto"><h2 style="margin-top:0">${kind === 'signup' ? `Create your ${esc(product)} account` : 'Sign in'}</h2>
        ${error ? `<p class="pill bad">${esc(error)}</p>` : ''}
        <form method="post" action="/${kind}">
          ${kind === 'signup' ? '<p><input name="name" placeholder="Company or team name" required style="width:100%"></p>' : ''}
          <p><input name="email" type="email" placeholder="you@company.com" required style="width:100%"></p>
          <p><input name="password" type="password" placeholder="password (12+ chars)" minlength="12" required style="width:100%"></p>
          <p><button style="width:100%">${kind === 'signup' ? 'Create account' : 'Sign in'}</button></p>
        </form>
        <p class="muted">${kind === 'signup' ? 'Already have an account? <a href="/login">Sign in</a>' : 'New here? <a href="/signup">Create an account</a>'}</p></div>`;
      router.get('/signup', (req, res) => page(res, 'Sign up', formPage('signup')));
      router.get('/login', (req, res) => page(res, 'Sign in', formPage('login')));
      router.post('/signup', async (req, res) => {
        // Signups send email: cap them per source address so the sender domain cannot be used as a relay.
        const ip = req.socket?.remoteAddress ?? 'unknown', cutoff = Date.now() - 3600_000;
        const recent = (signupHits.get(ip) ?? []).filter((t) => t > cutoff); recent.push(Date.now()); signupHits.set(ip, recent);
        if (recent.length > 10) return page(res, 'Sign up', formPage('signup', 'too many signups from this address; try again later'), 429);
        const f = await readForm(req);
        if (!f.email || String(f.password ?? '').length < 12) return page(res, 'Sign up', formPage('signup', 'email and a password of 12+ characters are required'), 400);
        try {
          const org = t.createOrg({ name: f.name, email: f.email, password: f.password });
          onSignup(org);
          setSession(res, org.id);
          redirect(res, `/?welcome=1&org_token=${encodeURIComponent(org.raw_token)}`);
        } catch (err) { page(res, 'Sign up', formPage('signup', err.message), err.status ?? 400); }
      });
      router.post('/login', async (req, res) => {
        const f = await readForm(req);
        const org = t.login(f.email, f.password);
        if (!org) return page(res, 'Sign in', formPage('login', 'wrong email or password'), 401);
        setSession(res, org.id);
        redirect(res, '/');
      });
      router.post('/logout', (req, res) => { res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`); redirect(res, '/login'); });
      router.get('/api/me', (req, res, { url }) => { const org = t.requireOrg(req, url); sendJson(res, 200, { org: { id: org.id, name: org.name, email: org.email, plan: t.plan(org.id), token_prefix: org.token_prefix, billing: org.billing } }); });
    },
    /** Inline account bar for dashboards. */
    accountBar(org) { return hosted ? `<p class="muted" style="margin:0 0 16px">${esc(org.name)} · ${esc(org.email ?? '')} · plan <b>${esc(t.plan(org.id))}</b> · <form class="inline" method="post" action="/logout"><button class="secondary">Sign out</button></form></p>` : ''; },
  };
  return t;
}
