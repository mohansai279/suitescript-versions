// NetSuite client: calls a RESTlet using Token-Based Authentication (OAuth 1.0a, HMAC-SHA256).
// The RESTlet itself is in restlet/ns_file_reader.js and must be deployed in the client's account.
const crypto = require('crypto');
const config = require('./config');

// RFC 3986 percent-encoding (stricter than encodeURIComponent)
const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function buildAuthHeader({ method, url, account, consumerKey, consumerSecret, tokenId, tokenSecret }) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_token: tokenId,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: crypto.randomBytes(12).toString('hex'),
    oauth_version: '1.0',
  };
  // Signature covers oauth params + every query param of the URL
  const all = [];
  for (const [k, v] of Object.entries(oauth)) all.push([enc(k), enc(v)]);
  for (const [k, v] of u.searchParams.entries()) all.push([enc(k), enc(v)]);
  all.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const paramString = all.map(([k, v]) => `${k}=${v}`).join('&');
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const base = [method.toUpperCase(), enc(baseUrl), enc(paramString)].join('&');
  const key = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha256', key).update(base).digest('base64');

  // realm = account id, upper-case, sandbox uses underscore (e.g. 1234567_SB1)
  const realm = String(account).toUpperCase().replace(/-/g, '_');
  const parts = [`realm="${realm}"`].concat(
    Object.entries(oauth).map(([k, v]) => `${k}="${enc(v)}"`)
  );
  return 'OAuth ' + parts.join(', ');
}

function assertRestletUrl(url) {
  if (!config.NS_URL_PATTERN.test(url)) {
    throw new Error('RESTlet URL must look like https://<account>.restlets.api.netsuite.com/...');
  }
}

// Returns { id, name, content, lastModified }
async function fetchFile(cfg, fileId) {
  assertRestletUrl(cfg.restletUrl);
  if (!/^\d+$/.test(String(fileId))) throw new Error('NetSuite file ID must be a number');
  const u = new URL(cfg.restletUrl);
  u.searchParams.set('fileId', String(fileId));
  const url = u.toString();
  const Authorization = buildAuthHeader({ method: 'GET', url, ...cfg });

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (text.length > 3 * 1024 * 1024) throw new Error('Response too large');
  if (!res.ok) {
    throw new Error(`NetSuite returned ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('NetSuite response was not JSON (check RESTlet URL)'); }
  if (json.error) throw new Error(`RESTlet error: ${String(json.error).slice(0, 200)}`);
  if (typeof json.content !== 'string') throw new Error('RESTlet response had no "content"');
  return json;
}

module.exports = { fetchFile, buildAuthHeader, assertRestletUrl, enc };
