// Password hashing, secret encryption, tokens.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Line endings are normalised before hashing so CRLF vs LF never shows up as a change.
const norm = (s) => s.replace(/\r\n/g, '\n');
const contentHash = (s) => sha(norm(s));

function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  if (config.isProd) throw new Error('APP_SECRET must be set in production');
  // Dev convenience: generate once and keep it next to the database.
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const f = path.join(config.DATA_DIR, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const KEY = crypto.createHash('sha256').update(loadSecret()).digest();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

// AES-256-GCM for NetSuite credentials stored in the database.
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { sha, norm, contentHash, hashPassword, verifyPassword, encrypt, decrypt, randomToken };
