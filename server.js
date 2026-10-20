// SuiteScript Version Tracker
// Node 22.13+ (built-in node:sqlite, no native deps)
const express = require('express');
const path = require('path');
const Diff = require('diff');

const config = require('./config');
const db = require('./db');
const sec = require('./security');
const netsuite = require('./netsuite');
const billing = require('./billing');

const app = express();
if (config.isProd) app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------- prepared statements ----------
const q = {
  insertWs: db.prepare('INSERT INTO workspaces (name, api_key_hash, trial_ends_at) VALUES (?, ?, ?)'),
  wsById: db.prepare('SELECT * FROM workspaces WHERE id = ?'),
  wsByApiKey: db.prepare('SELECT * FROM workspaces WHERE api_key_hash = ?'),
  wsByCustomer: db.prepare('SELECT * FROM workspaces WHERE stripe_customer_id = ?'),
  setApiKey: db.prepare('UPDATE workspaces SET api_key_hash = ? WHERE id = ?'),
  setNs: db.prepare('UPDATE workspaces SET ns_account = ?, ns_restlet_url = ?, ns_creds_enc = ? WHERE id = ?'),
  clearNs: db.prepare('UPDATE workspaces SET ns_account = NULL, ns_restlet_url = NULL, ns_creds_enc = NULL WHERE id = ?'),
  setBilling: db.prepare('UPDATE workspaces SET plan_status = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?'),

  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare('INSERT INTO users (workspace_id, email, password_hash) VALUES (?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionByHash: db.prepare(
    'SELECT s.expires_at, u.id AS user_id, u.email, u.workspace_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),

  scriptByName: db.prepare('SELECT * FROM scripts WHERE workspace_id = ? AND name = ?'),
  scriptOwned: db.prepare('SELECT * FROM scripts WHERE id = ? AND workspace_id = ?'),
  insertScript: db.prepare('INSERT INTO scripts (workspace_id, name, ns_file_id) VALUES (?, ?, ?)'),
  setFileId: db.prepare("UPDATE scripts SET ns_file_id = ?, drift_status = 'unknown', drift_error = NULL WHERE id = ?"),
  setDrift: db.prepare('UPDATE scripts SET drift_status = ?, drift_error = ?, last_checked_at = ? WHERE id = ?'),
  listScripts: db.prepare(`
    SELECT s.id, s.name, s.ns_file_id, s.drift_status, s.drift_error, s.last_checked_at, s.created_at,
           COUNT(v.id) AS version_count, MAX(v.created_at) AS last_change
    FROM scripts s LEFT JOIN versions v ON v.script_id = s.id
    WHERE s.workspace_id = ? GROUP BY s.id ORDER BY last_change DESC, s.id DESC`),
  scriptsWithFile: db.prepare('SELECT * FROM scripts WHERE workspace_id = ? AND ns_file_id IS NOT NULL ORDER BY id LIMIT 50'),

  latestVersion: db.prepare('SELECT * FROM versions WHERE script_id = ? ORDER BY version_no DESC LIMIT 1'),
  insertVersion: db.prepare(
    'INSERT INTO versions (script_id, version_no, content, hash, note, author) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  versionsOf: db.prepare(
    'SELECT id, version_no, hash, note, author, created_at, length(content) AS size FROM versions WHERE script_id = ? ORDER BY version_no DESC'
  ),
  versionById: db.prepare('SELECT * FROM versions WHERE id = ?'),
  // ownership-checked: version must belong to a script in this workspace
  versionOwned: db.prepare(
    'SELECT v.* FROM versions v JOIN scripts s ON s.id = v.script_id WHERE v.id = ? AND s.workspace_id = ?'
  ),
};

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const nowIso = () => new Date().toISOString();
const emailOk = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function startSession(res, userId) {
  const token = sec.randomToken();
  const expires = new Date(Date.now() + config.SESSION_DAYS * 864e5);
  q.insertSession.run(sec.sha(token), userId, expires.toISOString());
  res.setHeader(
    'Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.SESSION_DAYS * 86400}${config.isProd ? '; Secure' : ''}`
  );
}

function newApiKey() {
  const key = 'sstk_' + sec.randomToken(24);
  return { key, hash: sec.sha(key) };
}

function isActive(ws) {
  if (ws.plan_status === 'active') return true;
  return ws.plan_status === 'trial' && new Date(ws.trial_ends_at) > new Date();
}

function trialDaysLeft(ws) {
  if (ws.plan_status !== 'trial') return null;
  return Math.max(0, Math.ceil((new Date(ws.trial_ends_at) - new Date()) / 864e5));
}

function nsCreds(ws) {
  if (!ws.ns_creds_enc || !ws.ns_restlet_url || !ws.ns_account) return null;
  return { account: ws.ns_account, restletUrl: ws.ns_restlet_url, ...JSON.parse(sec.decrypt(ws.ns_creds_enc)) };
}

// Hash is over normalised content; identical content is never saved twice.
function addVersion(scriptId, content, note, author) {
  const hash = sec.contentHash(content);
  db.exec('BEGIN IMMEDIATE');
  try {
    const latest = q.latestVersion.get(scriptId);
    if (latest && latest.hash === hash) {
      db.exec('COMMIT');
      return { created: false, version: latest };
    }
    const no = latest ? latest.version_no + 1 : 1;
    const r = q.insertVersion.run(scriptId, no, content, hash, note || null, author || null);
    db.exec('COMMIT');
    return { created: true, version: q.versionById.get(Number(r.lastInsertRowid)) };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function validateSave(body) {
  const { name, content } = body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 200) return 'name is required (max 200 chars)';
  if (typeof content !== 'string' || !content.length) return 'content is required';
  if (content.length > 2 * 1024 * 1024) return 'content is larger than 2 MB';
  return null;
}

function clip(v, n) { return typeof v === 'string' ? v.slice(0, n) : null; }

// ---------- middleware ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
  );
  next();
});

// Stripe webhook needs the raw body, so it is registered before express.json()
app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  let event;
  try {
    event = billing.verifyWebhook(req.body, req.headers['stripe-signature'], config.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const obj = event.data && event.data.object ? event.data.object : {};
  if (event.type === 'checkout.session.completed') {
    const wsId = Number(obj.client_reference_id);
    if (wsId && q.wsById.get(wsId)) q.setBilling.run('active', obj.customer || null, obj.subscription || null, wsId);
  } else if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const ws = q.wsByCustomer.get(obj.customer);
    if (ws) q.setBilling.run(billing.mapStatus(event.type.endsWith('deleted') ? 'canceled' : obj.status), null, obj.id || null, ws.id);
  } else if (event.type === 'invoice.payment_failed') {
    const ws = q.wsByCustomer.get(obj.customer);
    if (ws) q.setBilling.run('past_due', null, null, ws.id);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '5mb' }));

// Browser-session endpoints must be JSON (blocks plain cross-site form posts); ingest uses an API key instead.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.path !== '/ingest' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
});

// very small in-memory rate limiter for auth endpoints
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return res.status(429).json({ error: 'Too many attempts, try again later' });
    next();
  };
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, 60000).unref();

function auth(req, res, next) {
  const token = parseCookies(req.headers.cookie).sid;
  const s = token && q.sessionByHash.get(sec.sha(token));
  if (!s || new Date(s.expires_at) < new Date()) return res.status(401).json({ error: 'login required' });
  req.user = { id: s.user_id, email: s.email };
  req.ws = q.wsById.get(s.workspace_id);
  next();
}

function requireActive(req, res, next) {
  if (isActive(req.ws)) return next();
  const msg = req.ws.plan_status === 'past_due'
    ? 'Payment failed. Update your payment method to continue saving versions.'
    : 'Your trial has ended. Subscribe to continue saving versions.';
  res.status(402).json({ error: msg, plan_status: req.ws.plan_status });
}

// ---------- auth ----------
app.post('/api/auth/signup', rateLimit(20, 15 * 60 * 1000), (req, res) => {
  const { email, password, workspaceName } = req.body || {};
  if (!emailOk(email)) return res.status(400).json({ error: 'Valid email required' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be 8 to 200 characters' });
  }
  const e = email.trim().toLowerCase();
  if (q.userByEmail.get(e)) return res.status(409).json({ error: 'An account with this email already exists' });

  const name = clip(workspaceName, 100) || e.split('@')[1] || 'My workspace';
  const trialEnds = new Date(Date.now() + config.TRIAL_DAYS * 864e5).toISOString();
  const { key, hash } = newApiKey();
  const w = q.insertWs.run(name.trim(), hash, trialEnds);
  const u = q.insertUser.run(Number(w.lastInsertRowid), e, sec.hashPassword(password));
  startSession(res, Number(u.lastInsertRowid));
  // The API key is shown once, only here and on rotate
  res.json({ ok: true, apiKey: key });
});

app.post('/api/auth/login', rateLimit(30, 15 * 60 * 1000), (req, res) => {
  const { email, password } = req.body || {};
  const u = typeof email === 'string' ? q.userByEmail.get(email.trim().toLowerCase()) : null;
  // verify against a dummy hash when the user is missing so timing does not reveal accounts
  const ok = sec.verifyPassword(String(password || ''), u ? u.password_hash : 'scrypt$00$00');
  if (!u || !ok) return res.status(401).json({ error: 'Wrong email or password' });
  q.purgeSessions.run(nowIso());
  startSession(res, u.id);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) q.deleteSession.run(sec.sha(token));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const ws = req.ws;
  res.json({
    user: req.user,
    workspace: {
      id: ws.id,
      name: ws.name,
      plan_status: ws.plan_status,
      can_write: isActive(ws),
      trial_days_left: trialDaysLeft(ws),
      has_subscription: !!ws.stripe_customer_id,
      netsuite: { connected: !!ws.ns_creds_enc, account: ws.ns_account, restletUrl: ws.ns_restlet_url },
    },
    billing_enabled: billing.configured(),
  });
});

// ---------- workspace settings ----------
app.put('/api/workspace/netsuite', auth, (req, res) => {
  const b = req.body || {};
  const fields = ['account', 'restletUrl', 'consumerKey', 'consumerSecret', 'tokenId', 'tokenSecret'];
  for (const f of fields) {
    if (typeof b[f] !== 'string' || !b[f].trim() || b[f].length > 500) return res.status(400).json({ error: `${f} is required` });
  }
  try { netsuite.assertRestletUrl(b.restletUrl.trim()); } catch (e) { return res.status(400).json({ error: e.message }); }
  const creds = sec.encrypt(JSON.stringify({
    consumerKey: b.consumerKey.trim(), consumerSecret: b.consumerSecret.trim(),
    tokenId: b.tokenId.trim(), tokenSecret: b.tokenSecret.trim(),
  }));
  q.setNs.run(b.account.trim(), b.restletUrl.trim(), creds, req.ws.id);
  res.json({ ok: true });
});

app.delete('/api/workspace/netsuite', auth, (req, res) => {
  q.clearNs.run(req.ws.id);
  res.json({ ok: true });
});

app.post('/api/workspace/rotate-key', auth, (req, res) => {
  const { key, hash } = newApiKey();
  q.setApiKey.run(hash, req.ws.id);
  res.json({ apiKey: key });
});

// ---------- scripts & versions (all scoped to the caller's workspace) ----------
app.get('/api/scripts', auth, (req, res) => res.json(q.listScripts.all(req.ws.id)));

function saveInto(ws, body) {
  const name = body.name.trim();
  let script = q.scriptByName.get(ws.id, name);
  if (!script) {
    const fid = body.nsFileId && /^\d+$/.test(String(body.nsFileId)) ? String(body.nsFileId) : null;
    const r = q.insertScript.run(ws.id, name, fid);
    script = q.scriptOwned.get(Number(r.lastInsertRowid), ws.id);
  }
  const result = addVersion(script.id, body.content, clip(body.note, 500), clip(body.author, 100));
  return { script, ...result };
}

app.post('/api/scripts', auth, requireActive, (req, res) => {
  const err = validateSave(req.body);
  if (err) return res.status(400).json({ error: err });
  res.json(saveInto(req.ws, req.body));
});

// Push from outside (e.g. a NetSuite scheduled script or CI): header X-Api-Key: <workspace key>
app.post('/api/ingest', (req, res) => {
  const key = req.headers['x-api-key'];
  const ws = typeof key === 'string' ? q.wsByApiKey.get(sec.sha(key)) : null;
  if (!ws) return res.status(401).json({ error: 'invalid API key' });
  if (!isActive(ws)) return res.status(402).json({ error: 'workspace plan is not active' });
  const err = validateSave(req.body);
  if (err) return res.status(400).json({ error: err });
  const r = saveInto(ws, req.body);
  res.json({ created: r.created, version_no: r.version.version_no });
});

app.put('/api/scripts/:id', auth, (req, res) => {
  const script = q.scriptOwned.get(req.params.id, req.ws.id);
  if (!script) return res.status(404).json({ error: 'script not found' });
  const fid = req.body && req.body.nsFileId;
  if (fid && !/^\d+$/.test(String(fid))) return res.status(400).json({ error: 'NetSuite file ID must be a number' });
  q.setFileId.run(fid ? String(fid) : null, script.id);
  res.json({ ok: true });
});

app.get('/api/scripts/:id/versions', auth, (req, res) => {
  const script = q.scriptOwned.get(req.params.id, req.ws.id);
  if (!script) return res.status(404).json({ error: 'script not found' });
  res.json({ script, versions: q.versionsOf.all(script.id) });
});

app.get('/api/versions/:id', auth, (req, res) => {
  const v = q.versionOwned.get(req.params.id, req.ws.id);
  if (!v) return res.status(404).json({ error: 'version not found' });
  res.json(v);
});

app.get('/api/versions/:id/download', auth, (req, res) => {
  const v = q.versionOwned.get(req.params.id, req.ws.id);
  if (!v) return res.status(404).json({ error: 'version not found' });
  const script = q.scriptOwned.get(v.script_id, req.ws.id);
  const base = script.name.replace(/[^\w.\-]+/g, '_').replace(/\.js$/i, '');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${base}_v${v.version_no}.js"`);
  res.send(v.content);
});

app.get('/api/diff', auth, (req, res) => {
  const a = q.versionOwned.get(req.query.from, req.ws.id);
  const b = q.versionOwned.get(req.query.to, req.ws.id);
  if (!a || !b) return res.status(404).json({ error: 'version not found' });
  res.json(diffResult(a, b));
});

function diffResult(a, b) {
  const parts = Diff.diffLines(sec.norm(a.content), sec.norm(b.content));
  let added = 0, removed = 0;
  const lines = [];
  for (const p of parts) {
    const type = p.added ? 'add' : p.removed ? 'del' : 'same';
    for (const line of p.value.replace(/\n$/, '').split('\n')) {
      lines.push({ type, text: line });
      if (type === 'add') added++;
      if (type === 'del') removed++;
    }
  }
  return { from: { id: a.id, version_no: a.version_no }, to: { id: b.id, version_no: b.version_no }, added, removed, lines };
}

// Restore saves the old content as a NEW version; history is never rewritten.
app.post('/api/versions/:id/restore', auth, requireActive, (req, res) => {
  const v = q.versionOwned.get(req.params.id, req.ws.id);
  if (!v) return res.status(404).json({ error: 'version not found' });
  res.json(addVersion(v.script_id, v.content, `Restored from v${v.version_no}`, req.user.email));
});

// ---------- NetSuite drift ----------
async function checkOne(ws, script) {
  const cfg = nsCreds(ws);
  if (!cfg) throw new Error('Connect NetSuite in Settings first');
  if (!script.ns_file_id) throw new Error('Set the NetSuite file ID for this script first');
  try {
    const live = await netsuite.fetchFile(cfg, script.ns_file_id);
    const latest = q.latestVersion.get(script.id);
    const status = latest && latest.hash === sec.contentHash(live.content) ? 'in_sync' : 'drifted';
    q.setDrift.run(status, null, nowIso(), script.id);
    return { status, live, latest };
  } catch (e) {
    q.setDrift.run('error', e.message.slice(0, 300), nowIso(), script.id);
    throw e;
  }
}

app.post('/api/scripts/:id/check', auth, wrap(async (req, res) => {
  const script = q.scriptOwned.get(req.params.id, req.ws.id);
  if (!script) return res.status(404).json({ error: 'script not found' });
  try {
    const { status, live, latest } = await checkOne(req.ws, script);
    const out = { status, liveLastModified: live.lastModified || null };
    if (status === 'drifted' && latest) {
      out.diff = diffResult(latest, { id: 0, version_no: 'NetSuite', content: live.content });
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// Save what is currently live in NetSuite as the next version
app.post('/api/scripts/:id/import-live', auth, requireActive, wrap(async (req, res) => {
  const script = q.scriptOwned.get(req.params.id, req.ws.id);
  if (!script) return res.status(404).json({ error: 'script not found' });
  const cfg = nsCreds(req.ws);
  if (!cfg || !script.ns_file_id) return res.status(400).json({ error: 'NetSuite connection and file ID are required' });
  try {
    const live = await netsuite.fetchFile(cfg, script.ns_file_id);
    const r = addVersion(script.id, live.content, 'Imported from NetSuite', req.user.email);
    q.setDrift.run('in_sync', null, nowIso(), script.id);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

app.post('/api/check-all', auth, wrap(async (req, res) => {
  if (!nsCreds(req.ws)) return res.status(400).json({ error: 'Connect NetSuite in Settings first' });
  const results = [];
  for (const s of q.scriptsWithFile.all(req.ws.id)) {
    try { results.push({ id: s.id, name: s.name, status: (await checkOne(req.ws, s)).status }); }
    catch (e) { results.push({ id: s.id, name: s.name, status: 'error', error: e.message }); }
  }
  res.json({ results });
}));

// ---------- billing ----------
app.post('/api/billing/checkout', auth, wrap(async (req, res) => {
  if (!billing.configured()) return res.status(503).json({ error: 'Billing is not configured' });
  try {
    const s = await billing.createCheckout(req.ws, req.user.email);
    res.json({ url: s.url });
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

app.post('/api/billing/portal', auth, wrap(async (req, res) => {
  if (!billing.configured()) return res.status(503).json({ error: 'Billing is not configured' });
  if (!req.ws.stripe_customer_id) return res.status(400).json({ error: 'No subscription yet' });
  try {
    const s = await billing.createPortal(req.ws);
    res.json({ url: s.url });
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

// ---------- static + errors ----------
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

if (require.main === module) {
  app.listen(config.PORT, () => console.log(`SuiteScript Version Tracker on ${config.APP_URL}`));
}
module.exports = app;
