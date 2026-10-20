// Runs on NetSuite pages.
// 1) Answers fetch requests from the background worker using this page's signed-in session.
// 2) On a File Cabinet file page, shows a small "Version Guard" button to track / save / open history.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'fetchFile') return false;
  let ok = false;
  try { ok = new URL(msg.url).origin === location.origin; } catch { /* bad url */ }
  if (!ok) { sendResponse({ ok: false, error: 'Wrong origin' }); return false; }
  fetch(msg.url, { credentials: 'include', cache: 'no-store' })
    .then(async (r) => sendResponse({
      ok: r.ok, status: r.status,
      type: r.headers.get('content-type') || '',
      disp: r.headers.get('content-disposition') || '',
      text: await r.text(),
    }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

(function widget() {
  if (window.top !== window) return;
  if (!/\/app\/media\/mediaitem\.nl$/.test(location.pathname)) return;
  const fileId = new URLSearchParams(location.search).get('id');
  if (!/^\d+$/.test(fileId || '')) return;

  const key = `${location.origin}|${fileId}`;
  const call = (type, payload) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!r || !r.ok) return reject(new Error((r && r.error) || 'Error'));
      resolve(r.data);
    });
  });

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box{font:13px/1.4 system-ui,sans-serif;background:#1c2230;color:#fff;border-radius:10px;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:280px}
      .t{font-weight:600;margin-bottom:4px}.s{opacity:.8;font-size:12px;margin-bottom:8px;min-height:16px}
      button{font:inherit;border:0;border-radius:6px;padding:5px 9px;margin-right:6px;cursor:pointer;background:#2557d6;color:#fff}
      button.g{background:#39415a}button:disabled{opacity:.5}
    </style>
    <div class="box"><div class="t">Version Guard</div><div class="s" id="s">...</div><div id="b"></div></div>`;
  document.documentElement.append(host);
  const s = root.getElementById('s'), b = root.getElementById('b');

  function btn(label, fn, cls) {
    const el = document.createElement('button');
    el.textContent = label;
    if (cls) el.className = cls;
    el.onclick = async () => { el.disabled = true; try { await fn(); } catch (e) { s.textContent = e.message; } el.disabled = false; };
    return el;
  }

  async function render() {
    b.replaceChildren();
    let info = null;
    try { info = await call('get', { key }); } catch { /* not tracked yet */ }
    if (!info) {
      s.textContent = 'This file is not tracked yet.';
      b.append(btn('Track this script', async () => {
        const r = await call('track', { origin: location.origin, fileId });
        s.textContent = `Tracking ${r.script.name} (saved v${r.script.latestNo}).`;
        await render();
      }));
      return;
    }
    const sc = info.script;
    s.textContent = sc.status === 'updated' ? `Changed since you last looked. Now v${sc.latestNo}.`
      : sc.status === 'changed' ? 'Changed in NetSuite. Not saved yet.'
      : `In sync with v${sc.latestNo}.`;
    b.append(
      btn('Check', async () => { const r = await call('check', { key }); s.textContent = r.status === 'error' ? r.error : r.status === 'ok' ? 'No changes.' : 'Change detected.'; await render(); }),
      btn('Save version', async () => { const r = await call('saveVersion', { key }); s.textContent = r.created ? `Saved v${r.version.no}.` : 'Already the latest.'; await render(); }),
      btn('History', async () => { await call('openViewer', { key }); }, 'g')
    );
  }
  render();
})();
