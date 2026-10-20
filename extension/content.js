// Runs on NetSuite pages (isolated world). Uses helpers from ui.js (send, h, renderDiff, fmtDate) and vendor/diff.js.
//  1) Answers fetch requests from the background worker using this page's signed-in session.
//  2) File page (edittextmediaitem / mediaitem): shows a "Version" bar with a dropdown of saved versions,
//     a diff for the selected version, restore-to-editor, snapshot, and captures a version when you click Save.
//  3) Script record page: finds the script's file links and offers one-click tracking.

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
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

(function main() {
  const FILE_PAGE = /\/(edittextmediaitem|mediaitem)\.nl$/;
  const SCRIPT_PAGE = /\/scripting\/script\.nl$/;
  const FILE_HREF = /(?:edittextmediaitem|mediaitem|downloadfile|media)\.nl\?(?:[^#]*&)?id=(\d+)/i;

  const STYLE = `
    :host{all:initial}
    *{box-sizing:border-box}
    .bar{font:13px/1.4 system-ui,sans-serif;background:#1c2230;color:#fff;padding:8px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .bar b{margin-right:4px}
    select{font:inherit;padding:3px 6px;border-radius:5px;border:1px solid #556;background:#fff;color:#111;max-width:340px}
    button{font:inherit;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;background:#2557d6;color:#fff}
    button.g{background:#39415a} button:disabled{opacity:.5;cursor:default}
    .st{opacity:.85;font-size:12px}
    .panel{font:12px/1.4 system-ui,sans-serif;background:#fff;color:#111;border:1px solid #c9ced8;border-top:0}
    .pt{padding:6px 12px;font-weight:600;background:#f0f2f6;display:flex;justify-content:space-between}
    .pt span{font-weight:400;color:#556;cursor:pointer}
    .diff{font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;max-height:260px;overflow:auto}
    .line{display:flex;white-space:pre;padding:0 8px}
    .ln{width:38px;flex:none;text-align:right;padding-right:8px;color:#889;user-select:none}
    .add{background:#e6f7ea}.del{background:#fdeaea}.skip{color:#889;background:#f6f7f9;padding:1px 8px}
    .hidden{display:none}
    .pill{position:fixed;right:16px;bottom:16px;font:13px/1.4 system-ui,sans-serif;background:#1c2230;color:#fff;border-radius:10px;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:320px}
    .pill .t{font-weight:600;margin-bottom:6px}.pill .it{margin-top:6px;padding-top:6px;border-top:1px solid #39415a}
    .pill .s{opacity:.8;font-size:12px;margin:2px 0 6px}
  `;

  function mount(position) {
    const host = document.createElement('div');
    host.setAttribute('data-ssvg', '1');
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = STYLE;
    root.append(st);
    if (position === 'top') document.body.prepend(host);
    else document.documentElement.append(host);
    return root;
  }

  // ---------- talking to the page's code editor (bridge.js runs in the page world) ----------
  let reqId = 0;
  function bridge(op, value) {
    return new Promise((resolve) => {
      const id = ++reqId;
      const done = (r) => { clearTimeout(timer); window.removeEventListener('message', on); resolve(r); };
      const on = (e) => { const d = e.data; if (d && d.tag === 'ssvg-res' && d.id === id) done(d); };
      const timer = setTimeout(() => done({ ok: false, error: 'No response from the page editor' }), 1500);
      window.addEventListener('message', on);
      window.postMessage({ tag: 'ssvg-req', id, op, value }, location.origin);
    });
  }

  // ---------- File page: version bar ----------
  function fileBar(fileId) {
    const key = `${location.origin}|${fileId}`;
    const root = mount('top');
    const sel = h('select', { title: 'Saved versions of this file' });
    const status = h('span', { class: 'st' });
    const diffBox = h('div', { class: 'diff' });
    const ptitle = h('div', { class: 'pt' });
    const panel = h('div', { class: 'panel hidden' }, ptitle, diffBox);
    const buttons = h('span', { class: 'row' });
    root.append(h('div', { class: 'bar' }, h('b', {}, 'Version Guard'), h('label', {}, 'Version: ', sel), buttons, status), panel);

    let info = null;
    const say = (t) => { status.textContent = t || ''; };
    const run = (fn) => async (e) => { const b = e.target; b.disabled = true; try { await fn(); } catch (err) { say(err.message); } b.disabled = false; };
    const btn = (label, fn, cls) => h('button', { class: cls || '', onclick: run(fn) }, label);

    async function showDiff() {
      const i = sel.selectedIndex;
      const vs = info.versions;
      if (i < 0 || !vs.length) return;
      let from, to, title;
      if (i === 0 && vs.length > 1) { from = vs[1]; to = vs[0]; title = `What changed in v${to.no} (compared with v${from.no})`; }
      else if (i === 0) { panel.classList.add('hidden'); return; }
      else { from = vs[i]; to = vs[0]; title = `If you restore v${from.no}: changes compared with the current v${to.no}`; }
      const [a, b] = await Promise.all([send('version', { id: from.id }), send('version', { id: to.id })]);
      const { added, removed } = renderDiff(diffBox, a.content, b.content);
      ptitle.replaceChildren(h('div', {}, `${title}  (+${added} / -${removed})`), h('span', { onclick: () => panel.classList.add('hidden') }, 'close'));
      panel.classList.remove('hidden');
    }

    async function restore() {
      const v = await send('version', { id: Number(sel.value) });
      if (!confirm(`Replace the editor content with v${v.no}? Nothing is saved in NetSuite until you click Save.`)) return;
      const r = await bridge('set', v.content);
      if (r.ok) { say(`Loaded v${v.no} into the editor. Click Save in NetSuite to apply it.`); return; }
      try { await navigator.clipboard.writeText(v.content); say(`Could not write to the editor (${r.error}). v${v.no} was copied: select all in the editor and paste.`); }
      catch { say(`Could not write to the editor (${r.error}). Use History to download v${v.no}.`); }
    }

    async function snapshot() {
      const r = await bridge('get');
      const res = r.ok
        ? await send('saveVersion', { key, content: r.value, source: 'snapshot', note: 'Snapshot from the editor' })
        : await send('saveVersion', { key });
      say(res.created ? `Saved v${res.version.no}.` : 'No change since the latest version.');
      await refresh();
    }

    async function refresh() {
      try { info = await send('get', { key }); } catch { info = null; }
      buttons.replaceChildren();
      sel.replaceChildren();
      if (!info) {
        sel.append(h('option', {}, 'Not tracked'));
        sel.disabled = true;
        buttons.append(btn('Track this script', async () => {
          // Use the text in the code editor (works even if the file URL cannot be downloaded);
          // when the editor is not readable, fall back to downloading the file.
          const ed = await bridge('get');
          const fromEditor = ed.ok && typeof ed.value === 'string' && ed.value.trim();
          const pageName = (document.title.match(/^\s*([^\s()]+\.[A-Za-z0-9]{1,5})\b/) || [])[1];
          const r = await send('track', {
            origin: location.origin, fileId,
            ...(fromEditor ? { content: ed.value, name: pageName, note: 'Started tracking (from the editor)' } : {}),
          });
          say(`Tracking ${r.script.name} (saved v${r.script.latestNo}).`);
          await refresh();
        }));
        panel.classList.add('hidden');
        return;
      }
      sel.disabled = false;
      info.versions.forEach((v, i) => {
        sel.append(h('option', { value: String(v.id) },
          `${v.no}${i === 0 ? ' (Current)' : ''} · ${fmtDate(v.createdAt)}${{ auto: ' · auto', save: ' · saved', opened: ' · seen on open' }[v.source] || ''}`));
      });
      sel.onchange = () => showDiff().catch((e) => say(e.message));
      buttons.append(
        btn('Restore to editor', restore),
        btn('Save snapshot', snapshot, 'g'),
        btn('History', async () => { await send('openViewer', { key }); }, 'g')
      );
      if (info.script.status === 'updated' || info.script.status === 'changed') say('This file was changed in NetSuite since you last looked.');
      await showDiff().catch(() => {});
    }

    // On the edit page the editor shows what is saved in NetSuite right now. If that differs from our
    // latest version, someone changed the file outside our sight, so keep it (duplicates are ignored).
    async function captureOnOpen() {
      if (!info || !/edittextmediaitem\.nl$/.test(location.pathname)) return;
      const ed = await bridge('get');
      if (!ed.ok || typeof ed.value !== 'string' || !ed.value.trim()) return;
      const r = await send('saveVersion', { key, content: ed.value, source: 'opened' });
      if (r.created) { say(`This file differed from the last saved version. Captured v${r.version.no}.`); await refresh(); }
    }

    // A Save click on this page: bridge.js sends the editor text, we store it as a new version.
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.tag !== 'ssvg-save' || typeof d.value !== 'string' || !d.value || !info) return;
      send('saveVersion', { key, content: d.value, source: 'save', note: 'Saved in NetSuite' })
        .then((r) => { if (r.created) say(`Version v${r.version.no} captured.`); })
        .catch(() => {});
    });

    refresh().then(() => setTimeout(() => captureOnOpen().catch(() => {}), 1200));
  }

  // The page's own "download" link shows how this account serves files. Remember its shape (no file-specific hash).
  function learnFromLinks() {
    for (const a of document.querySelectorAll('a[href]')) {
      if (!/^\s*download\s*$/i.test(a.textContent || '')) continue;
      let href;
      try { href = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      if (href.origin !== location.origin || !FILE_HREF.test(href.pathname + href.search) || href.searchParams.has('h')) continue;
      const tpl = href.href.replace(location.origin, '{origin}').replace(/([?&]id=)\d+/, '$1{id}');
      send('learnTemplate', { template: tpl }).catch(() => {});
      return;
    }
  }

  // ---------- Script record page: offer to track the script's file(s) ----------
  function scriptPill() {
    learnFromLinks();
    const found = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const m = FILE_HREF.exec(a.getAttribute('href') || '');
      if (m && !found.has(m[1])) found.set(m[1], (a.textContent || '').trim());
    }
    if (!found.size) return false;
    const root = mount('float');
    const box = h('div', { class: 'pill' }, h('div', { class: 't' }, 'Version Guard'));
    root.append(box);
    for (const fileId of found.keys()) {
      const key = `${location.origin}|${fileId}`;
      const stat = h('div', { class: 's' }, '...');
      const acts = h('div', {});
      box.append(h('div', { class: 'it' }, h('div', {}, `Script file ${fileId}`), stat, acts));
      const b = (label, fn, cls) => h('button', { class: cls || '', onclick: async (e) => { e.target.disabled = true; try { await fn(); } catch (err) { stat.textContent = err.message; } e.target.disabled = false; } }, label);
      const render = async () => {
        acts.replaceChildren();
        let info = null;
        try { info = await send('get', { key }); } catch { /* not tracked */ }
        if (!info) {
          stat.textContent = 'Not tracked yet.';
          acts.append(b('Track', async () => { const r = await send('track', { origin: location.origin, fileId }); stat.textContent = `Tracking ${r.script.name}.`; await render(); }));
          return;
        }
        const sc = info.script;
        stat.textContent = (sc.status === 'updated' ? `Changed. Now v${sc.latestNo}.` : sc.status === 'changed' ? 'Changed in NetSuite.' : `In sync with v${sc.latestNo}.`) + ` ${sc.name}`;
        acts.append(
          b('Check', async () => { const r = await send('check', { key }); stat.textContent = r.status === 'error' ? r.error : r.status === 'ok' ? 'No changes.' : 'Change detected.'; await render(); }),
          b('History', async () => { await send('openViewer', { key }); }, 'g')
        );
      };
      render();
    }
    return true;
  }

  const path = location.pathname;
  const id = new URLSearchParams(location.search).get('id');
  if (FILE_PAGE.test(path) && /^\d+$/.test(id || '')) { learnFromLinks(); fileBar(id); }
  else if (SCRIPT_PAGE.test(path)) {
    // NetSuite fills parts of the page late, so look again a couple of times
    if (!scriptPill()) setTimeout(() => { if (!document.querySelector('[data-ssvg]')) scriptPill(); }, 1500);
  }
})();
