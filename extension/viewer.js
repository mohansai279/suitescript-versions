const $ = (id) => document.getElementById(id);
const key = new URLSearchParams(location.search).get('key');
let script = null, versions = [];
const cache = new Map(); // version id -> full record

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.style.display = 'none'), 3500);
}

async function full(id) {
  if (!cache.has(id)) cache.set(id, await send('version', { id }));
  return cache.get(id);
}

async function load() {
  ({ script, versions } = await send('get', { key }));
  document.title = `${script.name} - Version Guard`;
  $('title').textContent = script.name;
  $('meta').textContent = `${script.origin} · File ${script.fileId} · ${versions.length} version(s) · last checked ${ago(script.lastChecked)}`;
  $('err').textContent = script.error || '';

  const tb = $('versions');
  tb.replaceChildren();
  versions.forEach((v, i) => {
    tb.append(h('tr', {},
      h('td', {}, h('input', { type: 'radio', name: 'from', value: v.id, checked: i === 1 })),
      h('td', {}, h('input', { type: 'radio', name: 'to', value: v.id, checked: i === 0 })),
      h('td', {}, 'v' + v.no),
      h('td', {}, (v.source === 'auto' ? '[auto] ' : '') + (v.note || '')),
      h('td', { class: 'mute' }, fmtDate(v.createdAt)),
      h('td', { class: 'mute' }, Math.max(1, Math.round(v.size / 1024)) + ' KB'),
      h('td', { class: 'row' },
        h('button', { onclick: async () => { const x = await full(v.id); downloadText(fileName(v), x.content, 'application/javascript'); } }, 'Download'),
        h('button', { onclick: async () => { const x = await full(v.id); await navigator.clipboard.writeText(x.content); toast(`Copied v${v.no}`); } }, 'Copy')
      )
    ));
  });
  if (versions.length >= 2 && !$('diffCard').dataset.shown) { $('diffCard').dataset.shown = '1'; compare(); }
}

function fileName(v) {
  const base = script.name.replace(/[^\w.\-]+/g, '_').replace(/\.js$/i, '');
  return `${base}_v${v.no}.js`;
}

async function compare() {
  const from = document.querySelector('input[name=from]:checked');
  const to = document.querySelector('input[name=to]:checked');
  if (!from || !to) return toast('Select both versions');
  const [a, b] = await Promise.all([full(Number(from.value)), full(Number(to.value))]);
  $('diffCard').classList.remove('hidden');
  const { added, removed } = renderDiff($('diff'), a.content, b.content, { showAll: $('showAll').checked });
  $('diffTitle').textContent = `v${a.no} to v${b.no}   (+${added} / -${removed})`;
}

$('compare').onclick = () => compare().catch((e) => toast(e.message));
$('showAll').onchange = () => compare().catch((e) => toast(e.message));

$('check').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const r = await send('check', { key });
    toast(r.status === 'error' ? r.error : r.status === 'ok' ? 'No changes in NetSuite' : 'Change detected');
    cache.clear(); $('diffCard').dataset.shown = '';
    await load();
  } catch (err) { toast(err.message); }
  e.target.disabled = false;
};

$('saveLive').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const r = await send('saveVersion', { key, note: $('note').value });
    toast(r.created ? `Saved v${r.version.no}` : 'Already the latest version');
    $('diffCard').dataset.shown = '';
    await load();
  } catch (err) { toast(err.message); }
  e.target.disabled = false;
};

$('saveManual').onclick = async () => {
  try {
    const r = await send('saveVersion', { key, content: $('content').value, note: $('note').value, source: 'manual' });
    toast(r.created ? `Saved v${r.version.no}` : 'No change since the latest version');
    $('content').value = ''; $('note').value = '';
    $('diffCard').dataset.shown = '';
    await load();
  } catch (err) { toast(err.message); }
};

$('file').onchange = async (e) => { const f = e.target.files[0]; if (f) $('content').value = await f.text(); };

$('rename').onclick = async () => {
  const n = prompt('New name', script.name);
  if (n) { await send('rename', { key, name: n }); await load(); }
};

$('remove').onclick = async () => {
  if (!confirm('Stop tracking this script and delete all its saved versions from this browser?')) return;
  await send('remove', { key });
  document.body.replaceChildren(h('div', { class: 'page' }, 'Removed. You can close this tab.'));
  window.close();
};

(async function init() {
  if (!key) { $('title').textContent = 'No script selected'; return; }
  try {
    await load();
    if (script.unseen || script.status === 'updated') await send('markSeen', { key }); // opening it counts as reviewed
  } catch (e) { $('title').textContent = e.message; }
})();
