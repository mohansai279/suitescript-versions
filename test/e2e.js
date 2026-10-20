// End-to-end test with mock NetSuite and mock Stripe servers. Run: npm test
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssv-'));
Object.assign(process.env, {
  DATA_DIR: tmp,
  APP_SECRET: 'test-secret-test-secret-test-secret',
  NS_URL_PATTERN: '^http://127\\.0\\.0\\.1:\\d+/',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_PRICE_ID: 'price_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
});

const NS = { consumerKey: 'ck-key-1', consumerSecret: 'consumer-secret-xyz', tokenId: 'token-id-1', tokenSecret: 'token-secret-xyz', account: '1234567_SB1' };
let liveContent = 'function a() {}\n';
const stripeCalls = [];

const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
}

// Mock NetSuite RESTlet: independently recomputes the OAuth1 HMAC-SHA256 signature.
function nsHandler(req, res) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const u = new URL(req.url, `http://${req.headers.host}`);
  const auth = req.headers.authorization || '';
  const p = {};
  for (const m of auth.matchAll(/(\w+)="([^"]*)"/g)) p[m[1]] = decodeURIComponent(m[2]);
  if (p.realm !== NS.account.toUpperCase() || p.oauth_signature_method !== 'HMAC-SHA256') return send(401, { error: 'bad realm/method' });
  const all = [];
  for (const [k, v] of Object.entries(p)) if (k.startsWith('oauth_') && k !== 'oauth_signature') all.push([pct(k), pct(v)]);
  for (const [k, v] of u.searchParams) all.push([pct(k), pct(v)]);
  all.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = ['GET', pct(`http://${req.headers.host}${u.pathname}`), pct(all.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const key = `${pct(NS.consumerSecret)}&${pct(NS.tokenSecret)}`;
  const expected = crypto.createHmac('sha256', key).update(base).digest('base64');
  if (p.oauth_consumer_key !== NS.consumerKey || p.oauth_token !== NS.tokenId || p.oauth_signature !== expected) {
    return send(401, { error: 'INVALID_LOGIN_ATTEMPT' });
  }
  if (u.searchParams.get('fileId') !== '555') return send(200, { error: 'RCRD_DSNT_EXIST' });
  send(200, { id: '555', name: 'x.js', content: liveContent, lastModified: '2026-10-20' });
}

function stripeHandler(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    stripeCalls.push({ path: req.url, auth: req.headers.authorization, body: Object.fromEntries(new URLSearchParams(body)) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: 'https://stripe.test' + req.url }));
  });
}

(async () => {
  const nsSrv = await listen(nsHandler);
  const stSrv = await listen(stripeHandler);
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${stSrv.address().port}/v1`;
  const nsUrl = `http://127.0.0.1:${nsSrv.address().port}/restlet?script=1&deploy=1`;

  const app = require('../server');
  const db = require('../db');
  const appSrv = await listen(app);
  const base = `http://127.0.0.1:${appSrv.address().port}`;

  function client() {
    let cookie = '';
    return async (method, p, body, headers = {}) => {
      const r = await fetch(base + p, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const sc = r.headers.getSetCookie();
      if (sc.length) { const c = sc[0].split(';')[0]; cookie = c.endsWith('=') ? '' : c; }
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, json, headers: r.headers };
    };
  }

  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('  ok  ' + name); };

  const A = client(), B = client(), anon = client();
  let keyA, scriptA, v1, v2;

  await t('unauthenticated requests are rejected', async () => {
    assert.strictEqual((await anon('GET', '/api/scripts')).status, 401);
    assert.strictEqual((await anon('GET', '/api/me')).status, 401);
  });

  await t('signup creates workspace, session cookie and one-time API key', async () => {
    const a = await A('POST', '/api/auth/signup', { email: 'A@Example.com', password: 'password-A-1', workspaceName: 'Client A' });
    assert.strictEqual(a.status, 200); keyA = a.json.apiKey; assert.ok(keyA.startsWith('sstk_'));
    const b = await B('POST', '/api/auth/signup', { email: 'b@example.com', password: 'password-B-1', workspaceName: 'Client B' });
    assert.strictEqual(b.status, 200);
    const me = await A('GET', '/api/me');
    assert.strictEqual(me.json.workspace.name, 'Client A');
    assert.strictEqual(me.json.workspace.plan_status, 'trial');
    assert.ok(me.json.workspace.can_write);
    assert.strictEqual((await anon('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password-A-1' })).status, 409);
    assert.strictEqual((await anon('POST', '/api/auth/signup', { email: 'bad', password: 'password-A-1' })).status, 400);
    assert.strictEqual((await anon('POST', '/api/auth/signup', { email: 'c@example.com', password: 'short' })).status, 400);
  });

  await t('passwords are hashed; login works and wrong password fails', async () => {
    const row = db.prepare("SELECT password_hash FROM users WHERE email = 'a@example.com'").get();
    assert.ok(row.password_hash.startsWith('scrypt$') && !row.password_hash.includes('password-A-1'));
    assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'a@example.com', password: 'nope-nope' })).status, 401);
    const ok = await anon('POST', '/api/auth/login', { email: 'A@example.com', password: 'password-A-1' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await anon('GET', '/api/me')).status, 200);
  });

  await t('state-changing requests must be JSON (CSRF guard)', async () => {
    const r = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.strictEqual(r.status, 415);
  });

  await t('versions: save, dedupe (incl. CRLF), new version on change', async () => {
    let r = await A('POST', '/api/scripts', { name: 'SSCC_UE.js', content: 'line1\nline2\n', note: 'first' });
    assert.ok(r.json.created); assert.strictEqual(r.json.version.version_no, 1);
    scriptA = r.json.script.id; v1 = r.json.version.id;
    r = await A('POST', '/api/scripts', { name: 'SSCC_UE.js', content: 'line1\r\nline2\r\n' });
    assert.strictEqual(r.json.created, false, 'CRLF-only difference must not create a version');
    r = await A('POST', '/api/scripts', { name: 'SSCC_UE.js', content: 'line1\nline2 changed\nline3\n' });
    assert.ok(r.json.created); assert.strictEqual(r.json.version.version_no, 2); v2 = r.json.version.id;
    const d = await A('GET', `/api/diff?from=${v1}&to=${v2}`);
    assert.strictEqual(d.json.added, 2); assert.strictEqual(d.json.removed, 1);
    const rs = await A('POST', `/api/versions/${v1}/restore`, {});
    assert.strictEqual(rs.json.version.version_no, 3);
    assert.strictEqual(rs.json.version.note, 'Restored from v1');
    const dl = await fetch(base + `/api/versions/${v1}/download`, { headers: { Cookie: '' } });
    assert.strictEqual(dl.status, 401);
  });

  await t('validation: missing name/content and oversized content are rejected', async () => {
    assert.strictEqual((await A('POST', '/api/scripts', { content: 'x' })).status, 400);
    assert.strictEqual((await A('POST', '/api/scripts', { name: 'x.js', content: '' })).status, 400);
    assert.strictEqual((await A('POST', '/api/scripts', { name: 'x.js', content: 'a'.repeat(2 * 1024 * 1024 + 1) })).status, 400);
  });

  await t('tenant isolation: workspace B cannot see or touch A data', async () => {
    assert.deepStrictEqual((await B('GET', '/api/scripts')).json, []);
    assert.strictEqual((await B('GET', `/api/scripts/${scriptA}/versions`)).status, 404);
    assert.strictEqual((await B('GET', `/api/versions/${v1}`)).status, 404);
    assert.strictEqual((await B('GET', `/api/versions/${v1}/download`)).status, 404);
    assert.strictEqual((await B('GET', `/api/diff?from=${v1}&to=${v2}`)).status, 404);
    assert.strictEqual((await B('POST', `/api/versions/${v1}/restore`, {})).status, 404);
    assert.strictEqual((await B('PUT', `/api/scripts/${scriptA}`, { nsFileId: '1' })).status, 404);
    assert.strictEqual((await B('POST', `/api/scripts/${scriptA}/check`, {})).status, 404);
    const same = await B('POST', '/api/scripts', { name: 'SSCC_UE.js', content: 'B own content\n' });
    assert.strictEqual(same.json.version.version_no, 1, 'same script name in another workspace is independent');
  });

  await t('API key ingest works and bad keys are rejected', async () => {
    const r = await anon('POST', '/api/ingest', { name: 'FromCI.js', content: 'ci\n' }, { 'X-Api-Key': keyA });
    assert.strictEqual(r.status, 200); assert.ok(r.json.created);
    assert.strictEqual((await anon('POST', '/api/ingest', { name: 'x.js', content: 'x' }, { 'X-Api-Key': 'sstk_wrong' })).status, 401);
    assert.strictEqual((await anon('POST', '/api/ingest', { name: 'x.js', content: 'x' })).status, 401);
    const rot = await A('POST', '/api/workspace/rotate-key', {});
    assert.strictEqual((await anon('POST', '/api/ingest', { name: 'y.js', content: 'y' }, { 'X-Api-Key': keyA })).status, 401, 'old key dead');
    assert.strictEqual((await anon('POST', '/api/ingest', { name: 'y.js', content: 'y' }, { 'X-Api-Key': rot.json.apiKey })).status, 200);
  });

  await t('NetSuite: RESTlet URL allow-list blocks arbitrary hosts (SSRF)', async () => {
    const r = await A('PUT', '/api/workspace/netsuite', {
      account: NS.account, restletUrl: 'http://evil.example.com/x', consumerKey: 'a', consumerSecret: 'b', tokenId: 'c', tokenSecret: 'd',
    });
    assert.strictEqual(r.status, 400);
  });

  await t('NetSuite: credentials stored encrypted, never returned', async () => {
    const r = await A('PUT', '/api/workspace/netsuite', {
      account: NS.account, restletUrl: nsUrl, consumerKey: NS.consumerKey, consumerSecret: NS.consumerSecret, tokenId: NS.tokenId, tokenSecret: NS.tokenSecret,
    });
    assert.strictEqual(r.status, 200);
    const row = db.prepare("SELECT ns_creds_enc FROM workspaces WHERE name = 'Client A'").get();
    assert.ok(!row.ns_creds_enc.includes(NS.consumerSecret) && !row.ns_creds_enc.includes(NS.tokenSecret));
    const me = await A('GET', '/api/me');
    assert.ok(me.json.workspace.netsuite.connected);
    assert.ok(!JSON.stringify(me.json).includes(NS.tokenSecret));
  });

  await t('NetSuite drift: in sync, drifted (with diff), import live, in sync again', async () => {
    assert.strictEqual((await A('PUT', `/api/scripts/${scriptA}`, { nsFileId: 'abc' })).status, 400);
    assert.strictEqual((await A('PUT', `/api/scripts/${scriptA}`, { nsFileId: '555' })).status, 200);
    liveContent = 'line1\r\nline2\r\n'; // equals v1 content (CRLF) but latest saved is v3 (restored v1)
    let r = await A('POST', `/api/scripts/${scriptA}/check`, {});
    assert.strictEqual(r.json.status, 'in_sync', JSON.stringify(r.json));
    liveContent = 'line1\nline2\nHOTFIX edited directly in NetSuite\n';
    r = await A('POST', `/api/scripts/${scriptA}/check`, {});
    assert.strictEqual(r.json.status, 'drifted');
    assert.ok(r.json.diff.lines.some((l) => l.type === 'add' && l.text.includes('HOTFIX')));
    const list = await A('GET', '/api/scripts');
    assert.strictEqual(list.json.find((s) => s.id === scriptA).drift_status, 'drifted');
    const imp = await A('POST', `/api/scripts/${scriptA}/import-live`, {});
    assert.ok(imp.json.created); assert.strictEqual(imp.json.version.note, 'Imported from NetSuite');
    r = await A('POST', `/api/scripts/${scriptA}/check`, {});
    assert.strictEqual(r.json.status, 'in_sync');
    const all = await A('POST', '/api/check-all', {});
    assert.strictEqual(all.json.results.length, 1); assert.strictEqual(all.json.results[0].status, 'in_sync');
  });

  await t('NetSuite: wrong token secret fails signature check and is reported', async () => {
    await B('PUT', '/api/workspace/netsuite', {
      account: NS.account, restletUrl: nsUrl, consumerKey: NS.consumerKey, consumerSecret: NS.consumerSecret, tokenId: NS.tokenId, tokenSecret: 'WRONG',
    });
    const sB = (await B('GET', '/api/scripts')).json[0].id;
    await B('PUT', `/api/scripts/${sB}`, { nsFileId: '555' });
    const r = await B('POST', `/api/scripts/${sB}/check`, {});
    assert.strictEqual(r.status, 502); assert.ok(/401/.test(r.json.error));
    assert.strictEqual((await B('GET', '/api/scripts')).json[0].drift_status, 'error');
  });

  await t('billing: trial expiry blocks writes but keeps reads and downloads', async () => {
    db.prepare("UPDATE workspaces SET trial_ends_at = '2000-01-01T00:00:00.000Z' WHERE name = 'Client A'").run();
    const w = await A('POST', '/api/scripts', { name: 'late.js', content: 'x' });
    assert.strictEqual(w.status, 402);
    assert.strictEqual((await A('POST', `/api/versions/${v1}/restore`, {})).status, 402);
    assert.strictEqual((await A('POST', `/api/scripts/${scriptA}/import-live`, {})).status, 402);
    assert.strictEqual((await anon('POST', '/api/ingest', { name: 'z.js', content: 'z' }, { 'X-Api-Key': (await A('POST', '/api/workspace/rotate-key', {})).json.apiKey })).status, 402);
    assert.strictEqual((await A('GET', '/api/scripts')).status, 200);
    assert.strictEqual((await A('GET', `/api/versions/${v1}/download`)).status, 200);
    assert.strictEqual((await A('GET', '/api/me')).json.workspace.can_write, false);
  });

  await t('billing: checkout session request is built correctly', async () => {
    const r = await A('POST', '/api/billing/checkout', {});
    assert.strictEqual(r.status, 200); assert.ok(r.json.url.endsWith('/checkout/sessions'));
    const c = stripeCalls.at(-1);
    assert.strictEqual(c.auth, 'Bearer sk_test_x');
    assert.strictEqual(c.body.mode, 'subscription');
    assert.strictEqual(c.body['line_items[0][price]'], 'price_x');
    assert.strictEqual(c.body.customer_email, 'a@example.com');
    assert.strictEqual((await A('POST', '/api/billing/portal', {})).status, 400, 'no customer yet');
  });

  const wsId = () => db.prepare("SELECT id FROM workspaces WHERE name = 'Client A'").get().id;
  const sendHook = (event, { badSig = false, stale = false } = {}) => {
    const raw = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000) - (stale ? 3600 : 0);
    const sig = crypto.createHmac('sha256', badSig ? 'other' : 'whsec_test').update(`${ts}.${raw}`).digest('hex');
    return fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${ts},v1=${sig}` }, body: raw });
  };

  await t('billing: webhook rejects bad/missing/stale signatures', async () => {
    const ev = { type: 'checkout.session.completed', data: { object: { client_reference_id: String(wsId()), customer: 'cus_1', subscription: 'sub_1' } } };
    assert.strictEqual((await sendHook(ev, { badSig: true })).status, 400);
    assert.strictEqual((await sendHook(ev, { stale: true })).status, 400);
    const none = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
    assert.strictEqual(none.status, 400);
    assert.strictEqual((await A('GET', '/api/me')).json.workspace.plan_status, 'trial', 'forged events change nothing');
  });

  await t('billing: paid checkout activates plan and re-enables writes', async () => {
    const ev = { type: 'checkout.session.completed', data: { object: { client_reference_id: String(wsId()), customer: 'cus_1', subscription: 'sub_1' } } };
    assert.strictEqual((await sendHook(ev)).status, 200);
    const me = await A('GET', '/api/me');
    assert.strictEqual(me.json.workspace.plan_status, 'active'); assert.ok(me.json.workspace.has_subscription);
    assert.strictEqual((await A('POST', '/api/scripts', { name: 'late.js', content: 'x' })).status, 200);
    const p = await A('POST', '/api/billing/portal', {});
    assert.strictEqual(p.status, 200); assert.strictEqual(stripeCalls.at(-1).body.customer, 'cus_1');
  });

  await t('billing: payment failure pauses writes; recovery and cancellation handled', async () => {
    await sendHook({ type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } });
    assert.strictEqual((await A('GET', '/api/me')).json.workspace.plan_status, 'past_due');
    assert.strictEqual((await A('POST', '/api/scripts', { name: 'p.js', content: 'p' })).status, 402);
    await sendHook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active' } } });
    assert.strictEqual((await A('GET', '/api/me')).json.workspace.plan_status, 'active');
    await sendHook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
    assert.strictEqual((await A('GET', '/api/me')).json.workspace.plan_status, 'canceled');
    assert.strictEqual((await A('POST', '/api/scripts', { name: 'c.js', content: 'c' })).status, 402);
  });

  await t('logout invalidates the session; health check and static pages work', async () => {
    await A('POST', '/api/auth/logout', {});
    assert.strictEqual((await A('GET', '/api/me')).status, 401);
    assert.strictEqual((await fetch(base + '/healthz')).status, 200);
    for (const f of ['/', '/login.html', '/app.js', '/style.css']) assert.strictEqual((await fetch(base + f)).status, 200, f);
    const h = await fetch(base + '/');
    assert.ok(h.headers.get('content-security-policy').includes("script-src 'self'"));
  });

  console.log(`\n${passed} tests passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
