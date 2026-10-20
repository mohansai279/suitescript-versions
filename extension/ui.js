// Helpers shared by the popup and the history viewer (extension pages only).
const send = (type, payload = {}) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!r || !r.ok) return reject(new Error((r && r.error) || 'Unknown error'));
      resolve(r.data);
    });
  });

// Small DOM builder. Text is always added as text nodes, never as HTML.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) el.append(kid instanceof Node ? kid : document.createTextNode(kid == null ? '' : String(kid)));
  return el;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
const fmtDate = (ts) => new Date(ts).toLocaleString();

function downloadText(name, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const normText = (s) => s.replace(/\r\n/g, '\n');

// Line diff with collapsed unchanged regions. Returns { added, removed }.
function renderDiff(container, oldText, newText, { showAll = false, context = 3 } = {}) {
  const parts = Diff.diffLines(normText(oldText), normText(newText));
  const lines = [];
  let o = 0, n = 0, added = 0, removed = 0;
  for (const p of parts) {
    const type = p.added ? 'add' : p.removed ? 'del' : 'same';
    const arr = p.value.replace(/\n$/, '').split('\n');
    for (const text of arr) {
      if (type === 'add') { n++; added++; lines.push({ type, text, o: '', n }); }
      else if (type === 'del') { o++; removed++; lines.push({ type, text, o, n: '' }); }
      else { o++; n++; lines.push({ type, text, o, n }); }
    }
  }
  const keep = new Array(lines.length).fill(showAll);
  if (!showAll) {
    lines.forEach((l, i) => {
      if (l.type !== 'same') for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
    });
  }
  container.replaceChildren();
  if (!added && !removed) container.append(h('div', { class: 'line same' }, 'No differences.'));
  let skipped = 0;
  const flush = () => { if (skipped) { container.append(h('div', { class: 'line skip' }, `... ${skipped} unchanged line(s) ...`)); skipped = 0; } };
  lines.forEach((l, i) => {
    if (!keep[i]) { skipped++; return; }
    flush();
    container.append(h('div', { class: 'line ' + l.type }, h('span', { class: 'ln' }, l.o), h('span', { class: 'ln' }, l.n), h('span', { class: 'tx' }, l.text || ' ')));
  });
  flush();
  return { added, removed };
}
