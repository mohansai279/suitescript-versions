// Extension tests. Run from the repo root:  npm run test:ext
// Runs the REAL background worker code (in a vm with a stubbed chrome API + fake IndexedDB)
// against a mock NetSuite server, then loads popup.html / viewer.html in jsdom wired to that worker.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const { indexedDB } = require('fake-indexeddb');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..');
const ORIGIN = 'https://1234567.app.netsuite.com';

// ---------- mock NetSuite ----------
const ns = { files: {}, loggedIn: true, failFirstTemplate: false, hits: [] };
function nsHandler(req, res) {
  const u = new URL(req.url, 'http://x');
  ns.hits.push(u.pathname + u.search);
  const id = u.searchParams.get('id');
  if (!ns.loggedIn) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!DOCTYPE html><html><body>Login</body></html>'); }
  if (ns.failFirstTemplate && u.searchParams.get('_xd') === 'T') { res.writeHead(404); return res.end('nope'); }
  if (u.pathname !== '/core/media/media.nl' || !(id in ns.files)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Disposition': `attachment; filename="${ns.names && ns.names[id] || 'SSCC_UE_' + id + '.js'}"` });
  res.end(ns.files[id]);
}

// ---------- build the background worker ----------
function buildWorker(nsPort) {
  const log = { badge: [], alarms: [], tabsCreated: [] };
  const store = {};
  const listeners = {};
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => (listeners.message = fn) },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      getURL: (p) => 'chrome-extension://test/' + p, lastError: null,
    },
    alarms: { clear: async () => {}, create: (n, o) => log.alarms.push([n, o]), onAlarm: { addListener: (fn) => (listeners.alarm = fn) } },
    action: {
      setBadgeText: async ({ text }) => log.badge.push(text),
      setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
    },
    storage: { local: {
      get: async (k) => (k in store ? { [k]: store[k] } : {}),
      set: async (o) => Object.assign(store, o),
    } },
    tabs: { query: async () => [], sendMessage: async () => { throw new Error('no tab'); }, create: async (o) => log.tabsCreated.push(o.url) },
  };
  // Real code talks to https://*.app.netsuite.com; route that to the mock server.
  const realFetch = fetch;
  const fakeFetch = (url, opts) => realFetch(String(url).replace(ORIGIN, `http://127.0.0.1:${nsPort}`), opts);

  const sandbox = {
    indexedDB, chrome, crypto: webcrypto, TextEncoder, URL, console, setTimeout, clearTimeout,
    fetch: fakeFetch, Promise, Date, Array, Object, Set, Math, JSON, Error, Number, String, encodeURIComponent, decodeURIComponent,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), sandbox, { filename: f });
  };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });

  const call = (type, payload = {}) => new Promise((resolve, reject) => {
    listeners.message({ type, ...payload }, {}, (r) => (r.ok ? resolve(r.data) : reject(new Error(r.error))));
  });
  return { call, chrome, log, listeners, sandbox };
}

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n', e); process.exitCode = 1; throw e; }
}
const rejects = async (p, re) => { try { await p; } catch (e) { assert.ok(re.test(e.message), `got: ${e.message}`); return; } assert.fail('expected rejection'); };

(async () => {
  const srv = await new Promise((r) => { const s = http.createServer(nsHandler).listen(0, '127.0.0.1', () => r(s)); });
  const W = buildWorker(srv.address().port);
  const { call, log } = W;
  const key = `${ORIGIN}|555`;

  console.log('background worker');
  ns.files['555'] = 'function a() {}\nfunction b() {}\n';

  await t('package: manifest is valid and every referenced file exists', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    assert.strictEqual(m.manifest_version, 3);
    const files = [m.background.service_worker, m.action.default_popup, ...Object.values(m.icons), ...m.content_scripts.flatMap((c) => c.js)];
    for (const f of files) assert.ok(fs.existsSync(path.join(EXT, f)), 'missing ' + f);
    assert.deepStrictEqual(m.host_permissions, ['https://*.app.netsuite.com/*'], 'only NetSuite hosts');
    for (const html of ['popup.html', 'viewer.html']) {
      const src = fs.readFileSync(path.join(EXT, html), 'utf8');
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(src), html + ' has an inline script (blocked by extension CSP)');
      for (const m2 of src.matchAll(/(?:src|href)="([^"#]+)"/g)) assert.ok(fs.existsSync(path.join(EXT, m2[1])), html + ' references missing ' + m2[1]);
    }
  });

  await t('track reads the file with the user session and saves v1 (name from NetSuite)', async () => {
    const r = await call('track', { origin: ORIGIN, fileId: '555' });
    assert.strictEqual(r.already, false);
    assert.strictEqual(r.script.name, 'SSCC_UE_555.js');
    assert.strictEqual(r.script.latestNo, 1);
    const again = await call('track', { origin: ORIGIN, fileId: '555' });
    assert.strictEqual(again.already, true);
    assert.strictEqual((await call('list')).length, 1);
  });

  await t('check: unchanged and CRLF-only changes are not changes', async () => {
    assert.strictEqual((await call('check', { key })).status, 'ok');
    ns.files['555'] = 'function a() {}\r\nfunction b() {}\r\n';
    assert.strictEqual((await call('check', { key })).status, 'ok');
    assert.strictEqual((await call('get', { key })).versions.length, 1);
  });

  await t('check: an edit in NetSuite is auto-captured as a new version and badged', async () => {
    ns.files['555'] = 'function a() {}\nfunction b() { return 2; }\n';
    const r = await call('check', { key });
    assert.strictEqual(r.status, 'updated');
    const g = await call('get', { key });
    assert.strictEqual(g.versions.length, 2);
    assert.strictEqual(g.versions[0].source, 'auto');
    assert.strictEqual(g.script.unseen, 1);
    assert.strictEqual(log.badge.at(-1), '1');
    const v = await call('version', { id: g.versions[0].id });
    assert.ok(v.content.includes('return 2'));
    // still flagged on the next check until the user has looked
    assert.strictEqual((await call('check', { key })).status, 'updated');
  });

  await t('markSeen clears the badge', async () => {
    await call('markSeen', { key });
    assert.strictEqual((await call('get', { key })).script.status, 'ok');
    assert.strictEqual(log.badge.at(-1), '');
  });

  await t('auto-capture off: change is flagged but not saved until the user saves', async () => {
    await call('setSettings', { settings: { autoCapture: false } });
    ns.files['555'] += '// hotfix\n';
    assert.strictEqual((await call('check', { key })).status, 'changed');
    assert.strictEqual((await call('get', { key })).versions.length, 2);
    assert.strictEqual(log.badge.at(-1), '1');
    const r = await call('saveVersion', { key, note: 'accepted' });
    assert.ok(r.created); assert.strictEqual(r.version.no, 3);
    assert.strictEqual((await call('get', { key })).script.status, 'ok');
    assert.strictEqual(log.badge.at(-1), '');
    await call('setSettings', { settings: { autoCapture: true } });
  });

  await t('not signed in: reports an error and never saves the login page as a version', async () => {
    ns.loggedIn = false;
    const r = await call('check', { key });
    assert.strictEqual(r.status, 'error');
    assert.ok(/web page|sign in/i.test(r.error), r.error);
    const g = await call('get', { key });
    assert.strictEqual(g.versions.length, 3);
    assert.ok(g.script.error);
    await rejects(call('track', { origin: ORIGIN, fileId: '777' }), /Could not read file 777/);
    ns.loggedIn = true;
    assert.strictEqual((await call('check', { key })).status, 'ok');
    assert.strictEqual((await call('get', { key })).script.error, null);
  });

  await t('falls back to the next URL template when the first is rejected', async () => {
    ns.files['600'] = 'x();\n'; ns.failFirstTemplate = true; ns.hits.length = 0;
    const r = await call('track', { origin: ORIGIN, fileId: '600' });
    assert.strictEqual(r.script.latestNo, 1);
    assert.ok(ns.hits.some((h) => h.includes('_xd=T')) && ns.hits.some((h) => !h.includes('_xd=T')));
    ns.failFirstTemplate = false;
  });

  await t('falls back to an open NetSuite tab when direct fetch is not authenticated', async () => {
    ns.files['700'] = 'ignored'; ns.loggedIn = false;
    W.chrome.tabs.query = async () => [{ id: 9 }];
    W.chrome.tabs.sendMessage = async (id, m) => {
      assert.strictEqual(m.type, 'fetchFile'); assert.ok(m.url.startsWith(ORIGIN + '/'));
      return { ok: true, status: 200, type: 'application/javascript', disp: '', text: 'from tab\n' };
    };
    const r = await call('track', { origin: ORIGIN, fileId: '700', name: 'Tab.js' });
    assert.strictEqual(r.script.name, 'Tab.js');
    assert.strictEqual((await call('version', { id: (await call('get', { key: `${ORIGIN}|700` })).versions[0].id })).content, 'from tab\n');
    W.chrome.tabs.query = async () => []; ns.loggedIn = true;
  });

  await t('input validation: account URL, file id, templates, content size', async () => {
    await rejects(call('track', { origin: 'https://evil.example.com', fileId: '1' }), /Account URL/);
    await rejects(call('track', { origin: 'http://1234567.app.netsuite.com', fileId: '1' }), /Account URL/);
    await rejects(call('track', { origin: ORIGIN, fileId: '12ab' }), /File ID/);
    await rejects(call('setSettings', { settings: { templates: ['https://evil.example.com/{id}'] } }), /template/i);
    await rejects(call('saveVersion', { key, content: 'a'.repeat(5 * 1024 * 1024 + 1) }), /5 MB/);
    await rejects(call('saveVersion', { key, content: '' }), /5 MB|1 character/);
    await rejects(call('check', { key: 'nope' }), /not found/);
  });

  await t('manual versions: saved, deduped; settings clamp the check interval', async () => {
    const a = await call('saveVersion', { key, content: 'manual one\n', note: 'pasted' });
    assert.ok(a.created);
    assert.ok(!(await call('saveVersion', { key, content: 'manual one\r\n' })).created);
    await call('setSettings', { settings: { intervalMin: 1 } });
    assert.strictEqual(log.alarms.at(-1)[1].periodInMinutes, 15);
  });

  await t('concurrent saves never collide on version numbers', async () => {
    const before = (await call('get', { key })).versions.length;
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => call('saveVersion', { key, content: 'parallel ' + i + '\n' })));
    const nos = (await call('get', { key })).versions.map((v) => v.no).sort((a, b) => a - b);
    assert.strictEqual(nos.length, before + 6);
    assert.deepStrictEqual(nos, nos.map((_, i) => i + 1));
  });

  await t('backup: export, remove, import restores everything; importing twice adds nothing', async () => {
    const data = JSON.parse(JSON.stringify(await call('exportAll')));
    const count = (await call('get', { key })).versions.length;
    await call('remove', { key });
    assert.strictEqual((await call('list')).some((s) => s.key === key), false);
    const r = await call('importAll', { data });
    assert.ok(r.addedScripts >= 1 && r.addedVersions >= count);
    assert.strictEqual((await call('get', { key })).versions.length, count);
    const r2 = await call('importAll', { data });
    assert.strictEqual(r2.addedVersions, 0);
    await rejects(call('importAll', { data: { hello: 1 } }), /backup/);
  });

  await t('checkAll covers every tracked script', async () => {
    const res = await call('checkAll');
    assert.strictEqual(res.length, (await call('list')).length);
    assert.ok(res.every((x) => x.status !== 'error'), JSON.stringify(res));
  });

  await t('openViewer asks the browser to open the history page', async () => {
    await call('openViewer', { key });
    assert.ok(log.tabsCreated.at(-1).startsWith('chrome-extension://test/viewer.html?key='));
  });

  // ---------- UI in jsdom, wired to the same worker ----------
  console.log('popup and history pages (jsdom)');
  async function openPage(file, query = '', tabUrl) {
    const dom = await JSDOM.fromFile(path.join(EXT, file), {
      url: `file://${EXT}/${file}${query}`, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      beforeParse(window) {
        window.chrome = {
          runtime: {
            lastError: null,
            sendMessage: (msg, cb) => {
              W.listeners.message(msg, {}, (r) => setTimeout(() => cb(r), 0));
            },
            getURL: (p) => 'chrome-extension://test/' + p,
          },
          tabs: {
            query: async () => (tabUrl ? [{ url: tabUrl }] : []),
            create: async (o) => log.tabsCreated.push(o.url),
          },
        };
        // jsdom pages loaded from file:// have an opaque origin (no localStorage); real extension pages do
        const mem = {};
        Object.defineProperty(window, 'localStorage', { value: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } });
        window.confirm = () => true;
        window.URL.createObjectURL = () => 'blob:x'; window.URL.revokeObjectURL = () => {};
      },
    });
    await new Promise((r) => dom.window.addEventListener('load', r));
    await new Promise((r) => setTimeout(r, 120));
    return dom;
  }
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  await t('popup: lists tracked scripts, pre-fills from the NetSuite tab, tracks a new file', async () => {
    ns.files['888'] = 'brand new\n';
    const dom = await openPage('popup.html', '', `${ORIGIN}/app/media/mediaitem.nl?id=888`);
    const d = dom.window.document;
    assert.ok(d.querySelectorAll('#list .item').length >= 2, 'tracked scripts listed');
    assert.strictEqual(d.getElementById('acct').value, ORIGIN);
    assert.strictEqual(d.getElementById('fileId').value, '888');
    d.getElementById('track').click();
    await wait(300);
    assert.ok(/Tracking SSCC_UE_888\.js/.test(d.getElementById('msg').textContent), d.getElementById('msg').textContent);
    assert.ok([...d.querySelectorAll('#list .name')].some((a) => a.textContent.includes('SSCC_UE_888.js')));
    dom.window.close();
  });

  await t('popup: shows a changed badge and a readable error, never raw HTML', async () => {
    ns.files['888'] = 'brand new v2\n';
    const dom = await openPage('popup.html');
    const d = dom.window.document;
    d.getElementById('checkAll').click();
    await wait(1500);
    assert.ok(/changed/.test(d.getElementById('msg').textContent), d.getElementById('msg').textContent);
    assert.ok(d.querySelector('#list .badge.updated'), 'new version badge shown');
    ns.loggedIn = false;
    d.getElementById('checkAll').click();
    await wait(1500);
    assert.ok(d.querySelector('#list .err'), 'error shown');
    assert.ok(!d.querySelector('#list').innerHTML.includes('<html'));
    ns.loggedIn = true;
    dom.window.close();
  });

  await t('history page: version table, diff with correct +/- counts, XSS-safe rendering', async () => {
    const k = `${ORIGIN}|999`;
    ns.files['999'] = 'line1\nline2\nline3\n'; ns.names = { 999: '<img src=x onerror=alert(1)>.js' };
    await call('track', { origin: ORIGIN, fileId: '999' });
    await call('saveVersion', { key: k, content: 'line1\nline2 CHANGED\nline3\nline4 <script>alert(1)</script>\n', note: '<b>bold</b> note' });
    const dom = await openPage('viewer.html', '?key=' + encodeURIComponent(k));
    const d = dom.window.document;
    assert.strictEqual(d.querySelectorAll('#versions tr').length, 2);
    assert.ok(/\+2 \/ -1/.test(d.getElementById('diffTitle').textContent), d.getElementById('diffTitle').textContent);
    const added = [...d.querySelectorAll('#diff .line.add .tx')].map((x) => x.textContent);
    assert.ok(added.includes('line2 CHANGED') && added.some((x) => x.includes('<script>alert(1)</script>')));
    assert.strictEqual(d.querySelectorAll('#diff script, #versions b, #title img').length, 0, 'nothing injected as HTML');
    assert.ok(d.getElementById('title').textContent.includes('<img'), 'name shown as text');
    dom.window.close();
    ns.names = null;
  });

  await t('history page: opening an auto-captured change marks it as seen', async () => {
    const k = `${ORIGIN}|888`;
    assert.strictEqual((await call('get', { key: k })).script.status, 'updated');
    const dom = await openPage('viewer.html', '?key=' + encodeURIComponent(k));
    await wait(200);
    assert.strictEqual((await call('get', { key: k })).script.status, 'ok');
    dom.window.close();
  });

  console.log(`\n${passed} extension tests passed`);
  srv.close();
  process.exit(0);
})().catch((e) => { console.error('\nFAILED', e && e.message); process.exit(1); });
