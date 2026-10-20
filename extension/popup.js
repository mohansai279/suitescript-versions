const $ = (id) => document.getElementById(id);
const ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.app\.netsuite\.com$/i;

function say(text, bad = false) {
  const m = $('msg');
  m.textContent = text || '';
  m.className = 'msg ' + (text ? (bad ? 'bad' : 'good') : 'hidden');
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

const openViewer = (key) => chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html?key=' + encodeURIComponent(key)) });

async function refresh() {
  const scripts = await send('list');
  const changed = scripts.filter((s) => s.status === 'updated' || s.status === 'changed').length;
  $('summary').textContent = scripts.length ? `${scripts.length} tracked${changed ? ' · ' + changed + ' changed' : ''}` : '';
  const list = $('list');
  list.replaceChildren();
  if (!scripts.length) list.append(h('div', { class: 'pad mute' }, 'Nothing tracked yet. Enter a File ID above (or open a file page in NetSuite).'));
  for (const s of scripts) {
    const badge = s.status === 'updated' ? 'new version' : s.status === 'changed' ? 'changed' : '';
    list.append(
      h('div', { class: 'item' },
        h('div', { class: 'main' },
          h('a', { class: 'name', href: '#', title: s.name, onclick: (e) => { e.preventDefault(); openViewer(s.key); } },
            s.name, badge ? h('span', { class: 'badge ' + s.status }, badge) : ''),
          h('div', { class: 'mute small' }, `File ${s.fileId} · v${s.latestNo} · checked ${ago(s.lastChecked)}`),
          s.error ? h('div', { class: 'err' }, s.error) : ''
        ),
        h('button', { onclick: (e) => busy(e.target, async () => {
          try { const r = await send('check', { key: s.key }); say(r.status === 'error' ? r.error : `${s.name}: ${r.status === 'ok' ? 'no changes' : r.status}`, r.status === 'error'); }
          catch (err) { say(err.message, true); }
          refresh();
        }) }, 'Check'),
        h('button', { onclick: () => openViewer(s.key) }, 'History')
      )
    );
  }
}

// Pre-fill from the NetSuite tab the user is looking at
async function prefill() {
  let origin = localStorage.getItem('acct') || '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const u = new URL(tab.url);
      if (ORIGIN_RE.test(u.origin)) {
        origin = u.origin;
        if (/\/(media|mediaitem|edittextmediaitem)\.nl$/.test(u.pathname) && /^\d+$/.test(u.searchParams.get('id') || '')) $('fileId').value = u.searchParams.get('id');
      }
    }
  } catch { /* no tab access, fine */ }
  $('acct').value = origin;
}

function target() {
  const origin = $('acct').value.trim().replace(/\/+$/, '');
  const fileId = $('fileId').value.trim();
  if (!ORIGIN_RE.test(origin)) throw new Error('Account URL must look like https://1234567.app.netsuite.com');
  if (!/^\d+$/.test(fileId)) throw new Error('File ID must be a number');
  localStorage.setItem('acct', origin);
  return { origin, fileId };
}

$('track').onclick = (e) => busy(e.target, async () => {
  say('');
  try {
    const t = target();
    const r = await send('track', { ...t, name: $('name').value });
    say(r.already ? 'Already tracked.' : `Tracking ${r.script.name} (saved v1).`);
    $('fileId').value = ''; $('name').value = '';
  } catch (err) { say(err.message, true); }
  refresh();
});

$('test').onclick = (e) => busy(e.target, async () => {
  try {
    const r = await send('testFetch', target());
    say(`Read OK: ${r.name || 'file'}, ${r.lines} lines, ${r.bytes} bytes.`);
  } catch (err) { say(err.message, true); }
});

$('checkAll').onclick = (e) => busy(e.target, async () => {
  say('Checking...');
  try {
    const res = await send('checkAll');
    const ch = res.filter((r) => r.status === 'updated' || r.status === 'changed').length;
    const er = res.filter((r) => r.status === 'error').length;
    say(`Checked ${res.length}: ${ch} changed, ${er} error(s).`, er > 0 && !ch);
  } catch (err) { say(err.message, true); }
  refresh();
});

// ---------- backup ----------
$('export').onclick = async () => {
  try {
    const data = await send('exportAll');
    downloadText(`version-guard-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  } catch (err) { say(err.message, true); }
};
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const r = await send('importAll', { data: JSON.parse(await f.text()) });
    say(`Imported ${r.addedScripts} script(s), ${r.addedVersions} version(s).`);
  } catch (err) { say(err.message, true); }
  e.target.value = '';
  refresh();
};

// ---------- settings ----------
$('settingsBtn').onclick = async () => {
  const box = $('settings');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) {
    const s = await send('getSettings');
    $('autoCapture').checked = s.autoCapture;
    $('interval').value = String(s.intervalMin);
    $('templates').value = (s.templates || []).join('\n');
  }
};
$('saveSettings').onclick = async () => {
  try {
    await send('setSettings', { settings: {
      autoCapture: $('autoCapture').checked,
      intervalMin: Number($('interval').value),
      templates: $('templates').value.split('\n').map((x) => x.trim()).filter(Boolean),
    } });
    say('Settings saved.');
    $('settings').classList.add('hidden');
  } catch (err) { say(err.message, true); }
};

prefill();
refresh();
