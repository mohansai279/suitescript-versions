// Stripe billing without the SDK (plain REST + manual webhook signature check).
const crypto = require('crypto');
const config = require('./config');

const configured = () => !!(config.STRIPE_SECRET_KEY && config.STRIPE_PRICE_ID);

async function stripe(path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.append(k, String(v));
  const res = await fetch(config.STRIPE_API_BASE + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json.error && json.error.message) || `Stripe error ${res.status}`);
  return json;
}

async function createCheckout(ws, email) {
  const p = {
    mode: 'subscription',
    'line_items[0][price]': config.STRIPE_PRICE_ID,
    'line_items[0][quantity]': 1,
    client_reference_id: ws.id,
    'subscription_data[metadata][workspace_id]': ws.id,
    success_url: `${config.APP_URL}/?billing=success`,
    cancel_url: `${config.APP_URL}/?billing=cancelled`,
    allow_promotion_codes: 'true',
  };
  if (ws.stripe_customer_id) p.customer = ws.stripe_customer_id;
  else p.customer_email = email;
  return stripe('/checkout/sessions', p);
}

async function createPortal(ws) {
  return stripe('/billing_portal/sessions', {
    customer: ws.stripe_customer_id,
    return_url: `${config.APP_URL}/`,
  });
}

// Stripe-Signature: t=timestamp,v1=hexsig[,v1=...]  signed payload = `${t}.${rawBody}`
function verifyWebhook(rawBody, header, secret, toleranceSec = 300) {
  if (!secret) throw new Error('Webhook secret not configured');
  if (!header) throw new Error('Missing signature');
  const parts = Object.fromEntries(
    header.split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; })
  );
  const t = parts.t;
  const sigs = header.split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
  if (!t || !sigs.length) throw new Error('Bad signature header');
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) throw new Error('Timestamp outside tolerance');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error('Signature mismatch');
  return JSON.parse(rawBody.toString('utf8'));
}

// Stripe subscription status -> our plan status
function mapStatus(s) {
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'past_due' || s === 'unpaid' || s === 'incomplete') return 'past_due';
  return 'canceled'; // canceled, incomplete_expired, paused
}

module.exports = { configured, createCheckout, createPortal, verifyWebhook, mapStatus };
