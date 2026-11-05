// Order + entitlement storage. Postgres in production (DATABASE_URL), in-memory only for local dev.
const DATABASE_URL = process.env.DATABASE_URL;
const PROD = process.env.NODE_ENV === 'production';

if (PROD && !DATABASE_URL) {
  console.error('DATABASE_URL is required in production so orders survive restarts.');
  process.exit(1);
}

const SCHEMA = `
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
  CREATE TABLE IF NOT EXISTS downloads (
    id             BIGSERIAL PRIMARY KEY,
    downloaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip             TEXT,
    user_agent     TEXT,
    path           TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS desktop_health (
    install_id        TEXT PRIMARY KEY,
    computer_name     TEXT NOT NULL,
    app_version       TEXT,
    platform          TEXT,
    ux                TEXT,
    engine            TEXT,
    quote_count       INTEGER NOT NULL DEFAULT 0,
    proposal_count    INTEGER NOT NULL DEFAULT 0,
    database_status   TEXT,
    last_sync         TEXT,
    status            TEXT,
    last_seen         TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

// Private Render addresses (dpg-… with no dots) often refuse connections while the
// instance is still booting, or from a service that cannot route that 10.x address.
// The external hostname is the same id plus ".<region>-postgres.render.com".
function connectionTargets(connectionString) {
  const { parse } = require('pg-connection-string');
  const parsed = parse(connectionString);
  const region = process.env.DATABASE_REGION || 'oregon';
  const port = parsed.port ? Number(parsed.port) : 5432;
  const host = parsed.host;
  const base = { user: parsed.user, password: parsed.password, database: parsed.database, port };
  const external = host && (host.includes('.') || host.endsWith('.render.com'));
  const targets = [];
  if (host && !external) {
    targets.push({ ...base, host, ssl: false });
    targets.push({ ...base, host, ssl: { rejectUnauthorized: false } });
    targets.push({
      ...base,
      host: `${host}.${region}-postgres.render.com`,
      ssl: { rejectUnauthorized: false },
    });
  } else {
    targets.push({ ...base, host, ssl: { rejectUnauthorized: false } });
  }
  return targets;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ---------------- Postgres ---------------- */
function postgresStore() {
  const { Pool } = require('pg');
  const state = { pool: null, ready: false };

  return {
    kind: 'postgres',
    get ready() { return state.ready; },
    async init() {
      const targets = connectionTargets(DATABASE_URL);
      for (let attempt = 1; ; attempt++) {
        for (const cfg of targets) {
          const pool = new Pool({ ...cfg, max: 5, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000 });
          try {
            await pool.query('SELECT 1');
            await pool.query(SCHEMA);
            state.pool = pool;
            state.ready = true;
            console.log(`Postgres connected via ${cfg.host}:${cfg.port}`);
            return;
          } catch (err) {
            const code = err.code ? `${err.code} ` : '';
            console.error(`Postgres ${cfg.host}:${cfg.port} attempt ${attempt}: ${code}${err.message}`);
            await pool.end().catch(() => {});
            if (err.code && !/^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/.test(err.code) && !/SSL|certificate|pg_hba|no encryption|timeout/i.test(err.message)) {
              throw err;
            }
          }
        }
        await sleep(attempt < 24 ? 5000 : 15000);
      }
    },
    async create(o) {
      await state.pool.query(
        `INSERT INTO orders (reference,email,name,billing,amount,currency) VALUES ($1,$2,$3,$4,$5,$6)`,
        [o.reference, o.email, o.name, o.billing, o.amount, o.currency]);
    },
    async get(reference) {
      const { rows } = await state.pool.query('SELECT * FROM orders WHERE reference=$1', [reference]);
      return rows[0] || null;
    },
    async setStatus(reference, status) {
      await state.pool.query(`UPDATE orders SET status=$2 WHERE reference=$1 AND status<>'paid'`, [reference, status]);
    },
    async markPaid(reference, paidAt) {
      const { rows } = await state.pool.query(
        `UPDATE orders SET status='paid', paid_at=$2 WHERE reference=$1 AND status<>'paid' RETURNING *`,
        [reference, paidAt || new Date()]);
      return rows[0] || null;
    },
    async grantAccess(order, plan) {
      await state.pool.query(
        `INSERT INTO entitlements (reference,email,plan) VALUES ($1,$2,$3) ON CONFLICT (reference) DO NOTHING`,
        [order.reference, order.email, plan]);
    },
    async recordDownload({ ip, userAgent, path }) {
      const { rows } = await state.pool.query(
        `INSERT INTO downloads (ip, user_agent, path) VALUES ($1,$2,$3)
         RETURNING id, downloaded_at, ip, user_agent, path`,
        [ip || '', String(userAgent || '').slice(0, 240), path || '/WEOTT-Quote-Builder-Setup.exe'],
      );
      return rows[0];
    },
    async listDownloads(limit = 30) {
      const { rows } = await state.pool.query(
        `SELECT id, downloaded_at, ip, user_agent, path
         FROM downloads ORDER BY downloaded_at DESC LIMIT $1`,
        [Math.max(1, Math.min(Number(limit) || 30, 100))],
      );
      return rows;
    },
    async recordHealth(pulse) {
      const { rows } = await state.pool.query(
        `INSERT INTO desktop_health (
           install_id, computer_name, app_version, platform, ux, engine,
           quote_count, proposal_count, database_status, last_sync, status, last_seen
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
         ON CONFLICT (install_id) DO UPDATE SET
           computer_name = EXCLUDED.computer_name,
           app_version = EXCLUDED.app_version,
           platform = EXCLUDED.platform,
           ux = EXCLUDED.ux,
           engine = EXCLUDED.engine,
           quote_count = EXCLUDED.quote_count,
           proposal_count = EXCLUDED.proposal_count,
           database_status = EXCLUDED.database_status,
           last_sync = EXCLUDED.last_sync,
           status = EXCLUDED.status,
           last_seen = now()
         RETURNING install_id, computer_name, app_version, platform, ux, engine,
                   quote_count, proposal_count, database_status, last_sync, status, last_seen`,
        [
          pulse.installId, pulse.computerName, pulse.appVersion, pulse.platform, pulse.ux, pulse.engine,
          pulse.quoteCount, pulse.proposalCount, pulse.databaseStatus, pulse.lastSync, pulse.status,
        ],
      );
      return rows[0];
    },
    async listHealth() {
      const { rows } = await state.pool.query(
        `SELECT install_id, computer_name, app_version, platform, ux, engine,
                quote_count, proposal_count, database_status, last_sync, status, last_seen
         FROM desktop_health ORDER BY last_seen DESC LIMIT 100`,
      );
      return rows;
    },
  };
}

/* ---------------- Memory (dev only) ---------------- */
function memoryStore() {
  const orders = new Map();
  const entitlements = new Map();
  const downloads = [];
  const health = new Map();
  return {
    kind: 'memory',
    ready: true,
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
    async recordDownload(entry) {
      const row = { id: downloads.length + 1, downloaded_at: new Date().toISOString(), ...entry };
      downloads.unshift(row);
      return row;
    },
    async listDownloads(limit = 30) { return downloads.slice(0, limit); },
    async recordHealth(pulse) {
      const row = { ...pulse, last_seen: new Date().toISOString() };
      health.set(pulse.installId, row);
      return row;
    },
    async listHealth() { return [...health.values()]; },
  };
}

module.exports = DATABASE_URL ? postgresStore() : memoryStore();
