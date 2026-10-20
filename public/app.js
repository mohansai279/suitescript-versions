const $ = (id) => document.getElementById(id);
let me = null, currentScript = null, lastDiff = null;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.style.display = 'none'), 3500);
}

async function api(url, opts = {}) {
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  if (opts.method && opts.method !== 'GET') opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('login required'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; throw e; }
  return j;
}
const post = (url, body = {}) => api(url, { method: 'POST', body });

// ---------- session / plan ----------
async function loadMe() {
  me = await api('/api/me');
  const ws = me.workspace;
  $('wsName').textContent = ws.name;
  const info = { trial: `Trial: ${ws.trial_days_left} day(s) left`, active: 'Plan: active', past_due: 'Payment failed', canceled: 'Subscription canceled' }[ws.plan_status];
  $('planInfo').textContent = info || '';
  show('subscribe', me.billing_enabled && ws.plan_status !== 'active');
  show('manageBilling', me.billing_enabled && ws.has_subscription);

  const banner = $('planBanner');
  if (!ws.can_write) {
    banner.textContent = ws.plan_status === 'past_due'
      ? 'Payment failed. You can still view and download your history, but saving is paused until payment is fixed.'
      : 'Your trial has ended. You can still view and download your history. Subscribe to keep saving versions.';
    show('planBanner');
  } else show('planBanner', false);

  $('save').disabled = !ws.can_write;
  $('nsAccount').value = ws.netsuite.account || '';
  $('nsUrl').value = ws.netsuite.restletUrl || '';
  show('nsRemove', ws.netsuite.connected);
  $('nsState').textContent = ws.netsuite.connected ? 'Connected (secrets stored encrypted)' : 'Not connected';
}

// ---------- scripts ----------
async function loadScripts() {
  const list = await api('/api/scripts');
  const box = $('scripts');
  box.innerHTML = list.length ? '' : '<span class="mute">No scripts yet.</span>';
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'script' + (currentScript && currentScript.id === s.id ? ' active' : '');
    const badge = s.ns_file_id && s.drift_status !== 'unknown'
      ? `<span class="badge ${s.drift_status}">${{ in_sync: 'in sync', drifted: 'changed in NetSuite', error: 'check failed' }[s.drift_status]}</span>` : '';
    d.innerHTML = `<div>${esc(s.name)}${badge}</div><small>${s.version_count} version(s)</small>`;
    d.onclick = () => openScript(s.id);
    box.appendChild(d);
  }
}

async function openScript(id) {
  const { script, versions } = await api(`/api/scripts/${id}/versions`);
  currentScript = script;
  $('name').value = script.name;
  $('nsid').value = script.ns_file_id || '';
  show('historyCard');
  show('diffCard', false);
  show('driftCard', !!(me.workspace.netsuite.connected && script.ns_file_id));
  show('driftDiff', false);
  show('importLive', false);
  $('driftMsg').textContent = script.last_checked_at ? `Last checked ${script.last_checked_at}` : '';
  $('historyTitle').textContent = `History: ${script.name}`;

  const tb = $('versions');
  tb.innerHTML = '';
  versions.forEach((v, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="radio" name="from" value="${v.id}" ${i === 1 ? 'checked' : ''} style="width:auto;margin:0"></td>
      <td><input type="radio" name="to" value="${v.id}" ${i === 0 ? 'checked' : ''} style="width:auto;margin:0"></td>
      <td>v${v.version_no}</td>
      <td>${esc(v.note || '')}</td>
      <td>${esc(v.author || '')}</td>
      <td class="mute">${esc(v.created_at)}</td>
      <td class="row">
        <button data-act="load">Load</button>
        <button data-act="dl">Download</button>
        <button data-act="restore">Restore</button>
      </td>`;
    tr.querySelector('[data-act=load]').onclick = async () => {
      const x = await api(`/api/versions/${v.id}`);
      $('content').value = x.content;
      toast(`Loaded v${v.version_no} into editor`);
    };
    tr.querySelector('[data-act=dl]').onclick = () => { location.href = `/api/versions/${v.id}/download`; };
    tr.querySelector('[data-act=restore]').onclick = async () => {
      if (!confirm(`Restore v${v.version_no}? This saves it as a new latest version.`)) return;
      try {
        const r = await post(`/api/versions/${v.id}/restore`);
        toast(r.created ? `Restored as v${r.version.version_no}` : 'Already the latest version');
        await loadScripts();
        openScript(id);
      } catch (e) { toast(e.message); }
    };
    tb.appendChild(tr);
  });
}

$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $('content').value = await f.text();
  if (!$('name').value) $('name').value = f.name;
};

$('save').onclick = async () => {
  try {
    const r = await post('/api/scripts', {
      name: $('name').value, nsFileId: $('nsid').value, content: $('content').value, note: $('note').value,
    });
    toast(r.created ? `Saved as v${r.version.version_no}` : 'No change since last version');
    $('note').value = '';
    await loadScripts();
    openScript(r.script.id);
  } catch (e) { toast(e.message); if (e.status === 402) loadMe(); }
};

// ---------- compare ----------
$('compare').onclick = async () => {
  const from = document.querySelector('input[name=from]:checked');
  const to = document.querySelector('input[name=to]:checked');
  if (!from || !to) return toast('Select both versions');
  lastDiff = await api(`/api/diff?from=${from.value}&to=${to.value}`);
  renderDiff();
};
$('onlyChanges').onchange = () => lastDiff && renderDiff();

function diffHtml(lines, onlyChanges) {
  return lines.filter((l) => !onlyChanges || l.type !== 'same')
    .map((l) => `<div class="${l.type}">${esc(l.text) || ' '}</div>`).join('') || '<div class="same">No differences.</div>';
}
function renderDiff() {
  const d = lastDiff;
  show('diffCard');
  $('diffTitle').textContent = `v${d.from.version_no} to v${d.to.version_no}  (+${d.added} / -${d.removed})`;
  $('diff').innerHTML = diffHtml(d.lines, $('onlyChanges').checked);
}

// ---------- NetSuite drift ----------
$('checkOne').onclick = async () => {
  if (!currentScript) return;
  $('driftMsg').textContent = 'Checking...';
  show('importLive', false);
  show('driftDiff', false);
  try {
    // keep the file id in sync with the field before checking
    if ($('nsid').value !== (currentScript.ns_file_id || '')) {
      await api(`/api/scripts/${currentScript.id}`, { method: 'PUT', body: { nsFileId: $('nsid').value } });
    }
    const r = await post(`/api/scripts/${currentScript.id}/check`);
    if (r.status === 'in_sync') $('driftMsg').textContent = 'In sync: NetSuite matches the latest saved version.';
    else {
      $('driftMsg').textContent = r.diff
        ? `Changed in NetSuite (+${r.diff.added} / -${r.diff.removed} vs latest saved).`
        : 'No saved version yet. Import the NetSuite version to start history.';
      show('importLive');
      if (r.diff) { $('driftDiff').innerHTML = diffHtml(r.diff.lines, true); show('driftDiff'); }
    }
    loadScripts();
  } catch (e) { $('driftMsg').textContent = e.message; loadScripts(); }
};

$('importLive').onclick = async () => {
  try {
    const r = await post(`/api/scripts/${currentScript.id}/import-live`);
    toast(r.created ? `Saved NetSuite version as v${r.version.version_no}` : 'Already up to date');
    await loadScripts();
    openScript(currentScript.id);
  } catch (e) { toast(e.message); }
};

$('checkAll').onclick = async () => {
  try {
    const { results } = await post('/api/check-all');
    const drifted = results.filter((r) => r.status === 'drifted').length;
    const errors = results.filter((r) => r.status === 'error').length;
    toast(`Checked ${results.length}: ${drifted} changed in NetSuite, ${errors} errors`);
    loadScripts();
  } catch (e) { toast(e.message); }
};

// ---------- settings ----------
$('settingsBtn').onclick = () => $('settingsCard').classList.toggle('hidden');
$('nsSave').onclick = async () => {
  try {
    await api('/api/workspace/netsuite', {
      method: 'PUT',
      body: {
        account: $('nsAccount').value, restletUrl: $('nsUrl').value,
        consumerKey: $('nsCk').value, consumerSecret: $('nsCs').value,
        tokenId: $('nsTi').value, tokenSecret: $('nsTs').value,
      },
    });
    for (const id of ['nsCk', 'nsCs', 'nsTi', 'nsTs']) $(id).value = '';
    toast('NetSuite connection saved');
    await loadMe();
  } catch (e) { toast(e.message); }
};
$('nsRemove').onclick = async () => {
  if (!confirm('Disconnect NetSuite and delete the stored credentials?')) return;
  await api('/api/workspace/netsuite', { method: 'DELETE', body: {} });
  toast('Disconnected');
  loadMe();
};
$('rotateKey').onclick = async () => {
  if (!confirm('Create a new API key? The old key stops working.')) return;
  const r = await post('/api/workspace/rotate-key');
  $('newKey').textContent = r.apiKey;
  show('newKeyCard');
};

// ---------- billing ----------
$('subscribe').onclick = async () => {
  try { location.href = (await post('/api/billing/checkout')).url; } catch (e) { toast(e.message); }
};
$('manageBilling').onclick = async () => {
  try { location.href = (await post('/api/billing/portal')).url; } catch (e) { toast(e.message); }
};

$('logout').onclick = async () => { await post('/api/auth/logout'); location.href = '/login.html'; };

// ---------- start ----------
(async function init() {
  await loadMe();
  const k = sessionStorage.getItem('newApiKey');
  if (k) { $('newKey').textContent = k; show('newKeyCard'); sessionStorage.removeItem('newApiKey'); }
  const p = new URLSearchParams(location.search).get('billing');
  if (p === 'success') toast('Payment received. Your plan updates in a few seconds.');
  loadScripts();
})();
