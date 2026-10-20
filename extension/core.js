// Shared helpers: hashing, NetSuite file fetching (uses the user's own signed-in session).
const ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.app\.netsuite\.com$/i;

// Tried in order until one returns the real file (not a login/HTML page).
const DEFAULT_TEMPLATES = [
  '{origin}/core/media/downloadfile.nl?id={id}&_xd=T',
  '{origin}/core/media/downloadfile.nl?id={id}',
  '{origin}/core/media/media.nl?id={id}&_xd=T',
  '{origin}/core/media/media.nl?id={id}',
  '{origin}/app/media/media.nl?id={id}',
];

// A learned/custom template must stay on the account's own origin and carry the file id.
const templateOk = (t) => typeof t === 'string' && t.length < 400 && t.startsWith('{origin}/') && t.includes('{id}') && !/[\s"'<>]/.test(t);

// Line endings are normalised before hashing so CRLF vs LF never counts as a change.
const norm = (s) => s.replace(/\r\n/g, '\n');

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const contentHash = (s) => sha256(norm(s));

const looksLikeHtml = (t) => /^\s*<(!doctype|html|head|body|script)/i.test(t);

function fileNameFromDisposition(d) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(d || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); }
}

function validateTarget(origin, fileId) {
  if (!ORIGIN_RE.test(origin || '')) throw new Error('Account URL must look like https://1234567.app.netsuite.com');
  if (!/^\d{1,12}$/.test(String(fileId || ''))) throw new Error('File ID must be a number');
}

// Accepts a raw response and decides whether it is a real file body.
function acceptResponse({ ok, status, type, disp, text, error }) {
  if (error) throw new Error(error);
  if (!ok) throw new Error(`HTTP ${status}`);
  if (!text || !text.trim()) throw new Error('Empty response');
  if (looksLikeHtml(text)) {
    const title = (/<title[^>]*>([^<]{1,80})/i.exec(text) || [])[1];
    throw new Error('Got a web page' + (title ? ` titled "${title.trim()}"` : '') + ' instead of the file');
  }
  return { text, name: fileNameFromDisposition(disp) };
}

async function directFetch(url) {
  try {
    const r = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
    const text = await r.text();
    return acceptResponse({
      ok: r.ok, status: r.status, type: r.headers.get('content-type'),
      disp: r.headers.get('content-disposition'), text,
    });
  } catch (e) {
    throw new Error(e.message || String(e));
  }
}

// Fallback: ask a content script in an open NetSuite tab to fetch (same-origin, always has the session cookies).
async function tabFetch(origin, url) {
  const tabs = await chrome.tabs.query({ url: origin + '/*' });
  let last = new Error('No open NetSuite tab for this account');
  for (const tab of tabs) {
    try {
      // frameId 0 = the top frame, which is always on the account origin (other frames could answer first with an error)
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'fetchFile', url }, { frameId: 0 });
      if (!resp) throw new Error('No response from tab');
      return acceptResponse(resp);
    } catch (e) { last = e; }
  }
  throw last;
}

// Returns { text, name, url }
async function fetchFileContent(origin, fileId, templates) {
  validateTarget(origin, fileId);
  const list = templates && templates.length ? templates : DEFAULT_TEMPLATES;
  const errors = [];
  for (const tpl of list) {
    const url = tpl.replace('{origin}', origin).replace('{id}', encodeURIComponent(fileId));
    if (!url.startsWith(origin + '/')) continue; // templates may never point at another host
    try { return { ...(await directFetch(url)), url }; } catch (e) { errors.push(e.message); }
    try { return { ...(await tabFetch(origin, url)), url }; } catch (e) { errors.push(e.message); }
  }
  const uniq = Array.from(new Set(errors)).slice(0, 3).join('; ');
  throw new Error(`Could not read file ${fileId}. Open NetSuite in a tab, sign in, and try again. (${uniq})`);
}

if (typeof self !== 'undefined') Object.assign(self, { norm, contentHash, fetchFileContent, validateTarget, DEFAULT_TEMPLATES, ORIGIN_RE, looksLikeHtml, templateOk });
