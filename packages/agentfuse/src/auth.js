// Who is asking? single mode: the admin token acts as the default org. hosted mode: org session cookie or org API token.
import { readForm, sendHtml, redirect, requireToken, HttpError } from '@jigglebox/shared/http';
import { layout, esc } from '@jigglebox/shared/html';
import { hashPassword, verifyPassword, signToken, verifyToken } from '@jigglebox/shared/crypto';
import { DEFAULT_ORG } from './store.js';

const COOKIE = 'af_session';
const parseCookies = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

export function createAuth({ store, config, onSignup = () => {} }) {
  const hosted = config.mode === 'hosted';
  const sessionSecret = config.masterKey || config.adminToken || 'dev-insecure';
  if (hosted && !config.masterKey) throw new Error('AGENTFUSE_MODE=hosted requires AGENTFUSE_MASTER_KEY (32 bytes hex)');

  /** Resolve the org for an admin/dashboard request or throw 401. */
  function requireOrg(req, url) {
    if (!hosted) { requireToken(req, config.adminToken, url); return store.ensureDefaultOrg(); }
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (bearer.startsWith('af_org_')) { const org = store.orgByToken(bearer); if (org) return org; }
    const session = verifyToken(parseCookies(req)[COOKIE], sessionSecret);
    const org = session?.org ? store.getOrg(session.org) : null;
    if (!org) throw new HttpError(401, 'sign in required', { login: `${config.publicUrl}/login` });
    return org;
  }
  const setSession = (res, orgId) => res.setHeader('set-cookie', `${COOKIE}=${signToken({ org: orgId }, sessionSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${config.publicUrl.startsWith('https') ? '; Secure' : ''}`);
  const clearSession = (res) => res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);

  const page = (res, title, inner, status = 200) => sendHtml(res, layout({ title: `AgentFuse · ${title}`, product: 'AgentFuse', nav: [{ href: '/login', label: 'Sign in' }, { href: '/signup', label: 'Create account' }], body: inner }), status);
  const formPage = (kind, error = '') => `<div class="tile" style="max-width:420px;margin:40px auto"><h2 style="margin-top:0">${kind === 'signup' ? 'Create your AgentFuse account' : 'Sign in'}</h2>
    ${error ? `<p class="pill bad">${esc(error)}</p>` : ''}
    <form method="post" action="/${kind}">
      ${kind === 'signup' ? '<p><input name="name" placeholder="Company or team name" required style="width:100%"></p>' : ''}
      <p><input name="email" type="email" placeholder="you@company.com" required style="width:100%"></p>
      <p><input name="password" type="password" placeholder="password (12+ chars)" minlength="12" required style="width:100%"></p>
      <p><button style="width:100%">${kind === 'signup' ? 'Create account' : 'Sign in'}</button></p>
    </form>
    <p class="muted">${kind === 'signup' ? 'Already have an account? <a href="/login">Sign in</a>' : 'New here? <a href="/signup">Create an account</a>'}</p></div>`;

  function register(router) {
    if (!hosted) return;
    router.get('/signup', (req, res) => page(res, 'Sign up', formPage('signup')));
    router.get('/login', (req, res) => page(res, 'Sign in', formPage('login')));
    router.post('/signup', async (req, res) => {
      const f = await readForm(req);
      if (!f.email || !f.password || String(f.password).length < 12) return page(res, 'Sign up', formPage('signup', 'email and a password of 12+ characters are required'), 400);
      try {
        const org = store.createOrg({ name: f.name || f.email, email: String(f.email).toLowerCase().trim(), passwordHash: hashPassword(f.password) });
        onSignup(org);
        setSession(res, org.id);
        redirect(res, `/?welcome=1&org_token=${encodeURIComponent(org.raw_token)}`);
      } catch (err) { page(res, 'Sign up', formPage('signup', err.message), err.status ?? 400); }
    });
    router.post('/login', async (req, res) => {
      const f = await readForm(req);
      const row = store.orgByEmail(String(f.email ?? '').toLowerCase().trim());
      if (!row || !verifyPassword(f.password ?? '', row.password_hash)) return page(res, 'Sign in', formPage('login', 'wrong email or password'), 401);
      setSession(res, row.id);
      redirect(res, '/');
    });
    router.post('/logout', (req, res) => { clearSession(res); redirect(res, '/login'); });
    router.get('/api/me', (req, res, { url }) => { const org = requireOrg(req, url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ org: { id: org.id, name: org.name, email: org.email, plan: store.plan(org.id, config.plan), token_prefix: org.token_prefix } })); });
  }

  return { hosted, requireOrg, register, DEFAULT_ORG };
}
