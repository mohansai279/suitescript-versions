// Central config. Everything secret comes from environment variables.
const path = require('path');

const isProd = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

module.exports = {
  isProd,
  PORT: process.env.PORT || 3000,
  DATA_DIR,
  DB_FILE: process.env.DB_FILE || path.join(DATA_DIR, 'versions.db'),
  APP_URL: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  TRIAL_DAYS: Number(process.env.TRIAL_DAYS || 14),
  SESSION_DAYS: 14,
  // Stripe (all optional: billing UI is hidden until these are set)
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  STRIPE_API_BASE: process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1',
  // NetSuite RESTlet URLs must match this (override only in tests)
  NS_URL_PATTERN: process.env.NS_URL_PATTERN
    ? new RegExp(process.env.NS_URL_PATTERN)
    : /^https:\/\/[a-z0-9-]+\.restlets\.api\.netsuite\.com\//i,
};
