// SuiteScript Version Guard - background service worker.
// Tracks NetSuite script files, saves versions locally, and checks for edits on a schedule.
importScripts('vendor/diff.js', 'db.js', 'core.js');

const DEFAULTS = { autoCapture: true, intervalMin: 60, templates: null, learned: null };
const keyOf = (origin, fileId) => `${origin}|${fileId}`;

// ---------- settings ----------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

async function applyAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear('ssvg-check');
  chrome.alarms.create('ssvg-check', { periodInMinutes: Math.max(15, Number(s.intervalMin) || 60) });
}

// ---------- serialise all writes (version numbers must never collide) ----------
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ---------- core operations ----------
const metaOf = (v) => ({ id: v.id, no: v.no, hash: v.hash, note: v.note, source: v.source, createdAt: v.createdAt, size: v.size });

// Adds a version unless the content is identical to the latest one.
async function addVersion(script, content, note, source) {
  const hash = await contentHash(content);
  if (script.latestHash === hash) return { created: false, script };
  const no = (script.latestNo || 0) + 1;
  const id = await DB.addVersion({
    scriptKey: script.key, no, content, hash, note: note || null, source,
    createdAt: Date.now(), size: content.length,
  });
  script.latestHash = hash;
  script.latestNo = no;
  script.versionCount = no;
  await DB.putScript(script);
  return { created: true, script, version: { id, no } };
}

// URL templates to try, in order: ones learned from this account's own "download" links, then the user's own, then defaults.
function templateList(s) {
  return [...(s.learned || []), ...(s.templates && s.templates.length ? s.templates : DEFAULT_TEMPLATES)];
}

async function fetchLive(script) {
  return fetchFileContent(script.origin, script.fileId, templateList(await getSettings()));
}

async function checkScript(key) {
  const script = await DB.getScript(key);
  if (!script) throw new Error('Script not found');
  let live;
  try {
    live = await fetchLive(script);
  } catch (e) {
    return locked(async () => {
      const cur = await DB.getScript(key);
      if (cur) { cur.error = e.message; cur.lastChecked = Date.now(); await DB.putScript(cur); }
      return { status: 'error', error: e.message };
    });
  }
  return locked(async () => {
    const cur = await DB.getScript(key);
    if (!cur) return { status: 'error', error: 'Script was removed' };
    const hash = await contentHash(live.text);
    cur.lastChecked = Date.now();
    cur.error = null;
    if (hash === cur.latestHash) {
      // Matches the latest saved version. An "updated" flag stays until the user has looked at it.
      cur.liveHash = null;
      if (cur.status === 'changed') cur.status = 'ok';
      await DB.putScript(cur);
      return { status: cur.status };
    }
    if ((await getSettings()).autoCapture) {
      const r = await addVersion(cur, live.text, 'Auto-captured: changed in NetSuite', 'auto');
      r.script.unseen = (r.script.unseen || 0) + 1;
      r.script.status = 'updated';
      await DB.putScript(r.script);
      return { status: 'updated' };
    }
    cur.status = 'changed';
    cur.liveHash = hash;
    await DB.putScript(cur);
    return { status: 'changed' };
  });
}

async function checkAll() {
  const scripts = await DB.allScripts();
  const results = [];
  for (const s of scripts) {
    try { results.push({ key: s.key, name: s.name, ...(await checkScript(s.key)) }); }
    catch (e) { results.push({ key: s.key, name: s.name, status: 'error', error: e.message }); }
    await new Promise((r) => setTimeout(r, 250)); // be gentle with NetSuite
  }
  await updateBadge();
  return results;
}

async function updateBadge() {
  const scripts = await DB.allScripts();
  const n = scripts.filter((s) => s.status === 'updated' || s.status === 'changed').length;
  await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  await chrome.action.setTitle({ title: n ? `SuiteScript Version Guard: ${n} script(s) changed` : 'SuiteScript Version Guard' });
}

// ---------- message API (popup, viewer, content script) ----------
const handlers = {
  async getSettings() { return getSettings(); },

  async setSettings({ settings }) {
    const cur = await getSettings();
    const next = { ...cur };
    if (typeof settings.autoCapture === 'boolean') next.autoCapture = settings.autoCapture;
    if (settings.intervalMin !== undefined) next.intervalMin = Math.min(1440, Math.max(15, Number(settings.intervalMin) || 60));
    if (settings.templates !== undefined) {
      const t = Array.isArray(settings.templates) ? settings.templates.map(String).filter(Boolean) : [];
      for (const x of t) if (!x.startsWith('{origin}/') || !x.includes('{id}')) throw new Error('Each URL template must start with {origin}/ and contain {id}');
      next.templates = t.length ? t : null;
    }
    await chrome.storage.local.set({ settings: next });
    await applyAlarm();
    return next;
  },

  async list() {
    const all = await DB.allScripts();
    return all.sort((a, b) => (b.lastChecked || 0) - (a.lastChecked || 0));
  },

  async get({ key }) {
    const script = await DB.getScript(key);
    if (!script) throw new Error('Script not found');
    const versions = (await DB.versionsOf(key)).map(metaOf);
    return { script, versions };
  },

  async version({ id }) {
    const v = await DB.getVersion(id);
    if (!v) throw new Error('Version not found');
    return v;
  },

  async testFetch({ origin, fileId }) {
    const r = await fetchFileContent(origin, fileId, templateList(await getSettings()));
    return { name: r.name, url: r.url, bytes: r.text.length, lines: r.text.split('\n').length };
  },

  // The content script found a "download" link on a NetSuite page; remember its URL shape for this browser.
  async learnTemplate({ template }) {
    if (!templateOk(template)) throw new Error('Not a usable URL template');
    const s = await getSettings();
    const learned = [template, ...(s.learned || []).filter((x) => x !== template)].slice(0, 3);
    if (JSON.stringify(learned) !== JSON.stringify(s.learned)) await chrome.storage.local.set({ settings: { ...s, learned } });
    return learned;
  },

  // Start tracking a file: reads it now and saves v1. If the caller already has the text
  // (the code editor on the file page), no download is needed.
  async track({ origin, fileId, name, note, content }) {
    validateTarget(origin, fileId);
    const key = keyOf(origin, fileId);
    const existing = await DB.getScript(key);
    if (existing) return { already: true, script: existing };
    let live;
    if (typeof content === 'string' && content.trim()) {
      if (content.length > 5 * 1024 * 1024) throw new Error('Content must be under 5 MB');
      live = { text: content, name: null };
    } else {
      live = await fetchFileContent(origin, fileId, templateList(await getSettings()));
    }
    return locked(async () => {
      if (await DB.getScript(key)) return { already: true, script: await DB.getScript(key) };
      const script = {
        key, origin, fileId: String(fileId),
        name: (name || '').trim().slice(0, 200) || live.name || `file-${fileId}.js`,
        createdAt: Date.now(), lastChecked: Date.now(), status: 'ok', error: null,
        latestHash: null, latestNo: 0, versionCount: 0, unseen: 0,
      };
      const r = await addVersion(script, live.text, (note || '').slice(0, 500) || 'Started tracking', 'live');
      await updateBadge();
      return { already: false, script: r.script };
    });
  },

  // Save a new version: from NetSuite right now, or from pasted/uploaded content
  async saveVersion({ key, content, note, source }) {
    const script = await DB.getScript(key);
    if (!script) throw new Error('Script not found');
    let text = content, src = 'manual';
    if (typeof text !== 'string') { text = (await fetchLive(script)).text; src = 'live'; }
    else if (!text.length || text.length > 5 * 1024 * 1024) throw new Error('Content must be between 1 character and 5 MB');
    return locked(async () => {
      const cur = await DB.getScript(key);
      const label = { live: 'Saved from NetSuite', save: 'Saved in NetSuite', snapshot: 'Snapshot from the editor', opened: 'Seen when opened in NetSuite' }[source || src] || 'Added manually';
      const r = await addVersion(cur, text, (note || '').slice(0, 500) || label, source || src);
      if (r.created) { r.script.status = 'ok'; r.script.liveHash = null; r.script.error = null; await DB.putScript(r.script); }
      await updateBadge();
      return { created: r.created, version: r.version || null };
    });
  },

  async check({ key }) { const r = await checkScript(key); await updateBadge(); return r; },
  async checkAll() { return checkAll(); },

  async markSeen({ key }) {
    return locked(async () => {
      const s = await DB.getScript(key);
      if (s) { s.unseen = 0; if (s.status === 'updated') s.status = 'ok'; await DB.putScript(s); }
      await updateBadge();
      return true;
    });
  },

  async remove({ key }) {
    return locked(async () => { await DB.deleteScript(key); await updateBadge(); return true; });
  },

  async rename({ key, name }) {
    return locked(async () => {
      const s = await DB.getScript(key);
      if (!s) throw new Error('Script not found');
      s.name = String(name || '').trim().slice(0, 200) || s.name;
      await DB.putScript(s);
      return s;
    });
  },

  // Content scripts cannot open extension pages themselves, so they ask the worker to
  async openViewer({ key }) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html?key=' + encodeURIComponent(key)) });
    return true;
  },

  async exportAll() { return DB.exportAll(); },

  // Merge a backup file: existing data is kept, only versions with new content are added
  async importAll({ data }) {
    if (!data || data.app !== 'suitescript-version-guard' || !Array.isArray(data.scripts) || !Array.isArray(data.versions)) {
      throw new Error('Not a Version Guard backup file');
    }
    return locked(async () => {
      let addedScripts = 0, addedVersions = 0;
      for (const sc of data.scripts) {
        if (!sc || !ORIGIN_RE.test(sc.origin || '') || !/^\d+$/.test(String(sc.fileId))) continue;
        const key = keyOf(sc.origin, sc.fileId);
        let script = await DB.getScript(key);
        if (!script) {
          script = { ...sc, key, latestHash: null, latestNo: 0, versionCount: 0, unseen: 0, status: 'ok', error: null };
          addedScripts++;
        }
        const incoming = data.versions.filter((v) => v.scriptKey === sc.key).sort((a, b) => a.no - b.no);
        const existing = new Set((await DB.versionsOf(key)).map((v) => v.hash));
        for (const v of incoming) {
          if (typeof v.content !== 'string' || existing.has(v.hash)) continue;
          const hash = await contentHash(v.content);
          const no = script.latestNo + 1;
          await DB.addVersion({ scriptKey: key, no, content: v.content, hash, note: v.note || null, source: v.source || 'import', createdAt: v.createdAt || Date.now(), size: v.content.length });
          existing.add(hash);
          script.latestNo = no; script.versionCount = no; script.latestHash = hash;
          addedVersions++;
        }
        await DB.putScript(script);
      }
      await updateBadge();
      return { addedScripts, addedVersions };
    });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  h(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) })
  );
  return true; // async response
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ssvg-check') checkAll().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { applyAlarm(); updateBadge(); });
chrome.runtime.onStartup.addListener(() => { applyAlarm(); updateBadge(); });
