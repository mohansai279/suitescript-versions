# SuiteScript Version Tracker

Version history for SuiteScript files, per client workspace. Save versions, diff them, restore or download old ones, and see when someone changed a script directly in NetSuite.

- Accounts and separate workspace per client (all data scoped by workspace)
- NetSuite drift check: pulls the live file through a RESTlet and compares it with the last saved version
- Stripe monthly subscription with a free trial (default 14 days)
- API-key push endpoint for scripts and CI

## Run locally

```bash
npm install
npm start          # http://localhost:3000, data in ./data
npm test           # 18 end-to-end tests with mock NetSuite and Stripe
```

Needs Node 22.13+ (built-in `node:sqlite`).

## Deploy (Render)

1. Push this folder to a GitHub repo.
2. Render: **New > Blueprint**, pick the repo (uses `render.yaml`, Docker, 1 GB persistent disk at `/data`). A disk needs a paid instance (Starter).
3. After the first deploy, set `APP_URL` to your `https://...onrender.com` URL (or your own domain). `APP_SECRET` is generated for you. **Do not change `APP_SECRET` later**, it encrypts the stored NetSuite credentials.

Any Docker host works the same way: mount a volume at `/data`, set the env vars from `.env.example`.

## Turn on billing (Stripe)

1. Stripe dashboard: create a Product with a **recurring monthly price**. Copy the price ID (`price_...`) to `STRIPE_PRICE_ID`.
2. Copy your secret key to `STRIPE_SECRET_KEY` (use test keys first).
3. Developers > Webhooks > add endpoint `https://YOUR-URL/api/stripe/webhook` with events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
4. Settings > Billing > enable the Customer portal (lets customers cancel or change card).
5. Test with card `4242 4242 4242 4242`, then switch to live keys.

When a trial ends or payment fails, saving is paused but customers can still view and download all their history.

## Connect NetSuite (per client)

1. In NetSuite upload `restlet/ns_file_reader.js` to the File Cabinet, create a Script record (type RESTlet, function `get`) and deploy it. Copy the **External URL**.
2. Enable Token-Based Authentication. Create an Integration record (note consumer key/secret), a role that can read the File Cabinet and run this RESTlet, and an Access Token for a user with that role (note token ID/secret).
3. In the app: Settings > NetSuite connection, fill the 6 fields. Credentials are stored AES-256-GCM encrypted and never shown again.
4. On a script, enter its File Cabinet internal ID, then **Check against NetSuite**. If it differs you see the diff and can save the live version as a new version.

The RESTlet is read-only and only returns JavaScript files.

## Push from scripts or CI

```bash
curl -X POST https://YOUR-URL/api/ingest \
  -H "X-Api-Key: sstk_..." -H "Content-Type: application/json" \
  -d '{"name":"SSCC_UE_SalesOrder.js","content":"...","note":"deployed by CI"}'
```

The key is shown once at signup (Settings > Rotate API key creates a new one).

## Security notes

- Passwords: scrypt. Sessions: random token, only its hash stored, HttpOnly + SameSite cookie, Secure in production.
- JSON-only for state changes (CSRF guard), strict CSP, login rate limit.
- RESTlet URL must be on `*.restlets.api.netsuite.com` (no arbitrary outbound requests).
- Stripe webhooks are signature-verified (HMAC, 5 min tolerance).
- SQLite on one disk is fine for the first customers. Back up `/data` (Render disk snapshots) and move to Postgres if you outgrow one server.
