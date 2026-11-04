// Order + entitlement storage. Postgres in production (DATABASE_URL), in-memory only for local dev.
const DATABASE_URL = process.env.DATABASE_URL;
const PROD = process.env.NODE_ENV === 'production';

if (PROD && !DATABASE_URL) {
  console.error('DATABASE_URL is required in production so orders survive restarts.');
  process.exit(1);
}

/* ---------------- Postgres ---------------- */
function postgresStore() {
  const { Pool } = require('pg');
  // Render's external URLs (…render.com) need SSL; internal ones do not.
  const ssl = /render\.com/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: DATABASE_URL, ssl });

  return {
    kind: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
          reference   TEXT PRIMARY KEY,
          email       TEXT NOT NULL,
          name        TEXT,
          billing     TEXT,
          amount      INTEGER NOT NULL,
          currency    TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'pending',
          paid_at     TIMESTAMPTZ,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS entitlements (
          reference   TEXT PRIMARY KEY REFERENCES orders(reference),
          email       TEXT NOT NULL,
          plan        TEXT NOT NULL,
          granted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS entitlements_email_idx ON entitlements(email);
      `);
    },
    async create(o) {
      await pool.query(
        `INSERT INTO orders (reference,email,name,billing,amount,currency) VALUES ($1,$2,$3,$4,$5,$6)`,
        [o.reference, o.email, o.name, o.billing, o.amount, o.currency]);
    },
    async get(reference) {
      const { rows } = await pool.query('SELECT * FROM orders WHERE reference=$1', [reference]);
      return rows[0] || null;
    },
    async setStatus(reference, status) {
      await pool.query(`UPDATE orders SET status=$2 WHERE reference=$1 AND status<>'paid'`, [reference, status]);
    },
    // Atomic: returns the order only for the ONE caller that flips it to paid (webhook vs browser race-safe).
    async markPaid(reference, paidAt) {
      const { rows } = await pool.query(
        `UPDATE orders SET status='paid', paid_at=$2 WHERE reference=$1 AND status<>'paid' RETURNING *`,
        [reference, paidAt || new Date()]);
      return rows[0] || null;
    },
    async grantAccess(order, plan) {
      await pool.query(
        `INSERT INTO entitlements (reference,email,plan) VALUES ($1,$2,$3) ON CONFLICT (reference) DO NOTHING`,
        [order.reference, order.email, plan]);
    },
  };
}

/* ---------------- Memory (dev only) ---------------- */
function memoryStore() {
  const orders = new Map(), entitlements = new Map();
  return {
    kind: 'memory',
    async init() { console.warn('[store] Using in-memory storage (dev only). Set DATABASE_URL for persistence.'); },
    async create(o) { orders.set(o.reference, { ...o, status: 'pending' }); },
    async get(r) { return orders.get(r) || null; },
    async setStatus(r, s) { const o = orders.get(r); if (o && o.status !== 'paid') o.status = s; },
    async markPaid(r, paidAt) {
      const o = orders.get(r);
      if (!o || o.status === 'paid') return null;
      o.status = 'paid'; o.paid_at = paidAt; return o;
    },
    async grantAccess(o, plan) { if (!entitlements.has(o.reference)) entitlements.set(o.reference, { email: o.email, plan }); },
  };
}

module.exports = DATABASE_URL ? postgresStore() : memoryStore();
