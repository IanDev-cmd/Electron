require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const store = require('./store');

const { PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY, PORT = 3000 } = process.env;
// Settlement currency. Defaults to KES so an older PAYSTACK_CURRENCY=USD value does not keep charging dollars.
const CURRENCY = (process.env.CHARGE_CURRENCY || 'KES').toUpperCase();
const PRICE_MINOR = parseInt(process.env.PRICE_MINOR || '5000', 10); // $50.00 in US cents. Converted into CURRENCY at checkout.
const PLAN = 'Kubertos';
const PAYSTACK = 'https://api.paystack.co';

if (!PAYSTACK_SECRET_KEY || !PAYSTACK_PUBLIC_KEY) {
  console.error('Missing PAYSTACK_SECRET_KEY / PAYSTACK_PUBLIC_KEY');
  process.exit(1);
}
if (PAYSTACK_SECRET_KEY.startsWith('sk_live_') !== PAYSTACK_PUBLIC_KEY.startsWith('pk_live_')) {
  console.error('Key mismatch: use either both live keys or both test keys.');
  process.exit(1);
}
console.log(`Paystack mode: ${PAYSTACK_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : 'TEST'} | $50 converted into ${CURRENCY}`);

let rateCache = { at: 0, rates: null };

async function priceInChargeCurrency() {
  if (CURRENCY === 'USD') return { amount: PRICE_MINOR, currency: 'USD', usdCents: PRICE_MINOR, rate: 1 };
  if (!rateCache.rates || Date.now() - rateCache.at > 10 * 60 * 1000) {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const json = await res.json();
    if (!res.ok || json.result !== 'success' || !json.rates) throw new Error('Could not load the exchange rate.');
    rateCache = { at: Date.now(), rates: json.rates };
  }
  const rate = Number(rateCache.rates[CURRENCY]);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Cannot price $50 in ${CURRENCY}.`);
  const amount = Math.round((PRICE_MINOR / 100) * rate * 100);
  if (!Number.isInteger(amount) || amount < 1) throw new Error('Converted amount is invalid.');
  return { amount, currency: CURRENCY, usdCents: PRICE_MINOR, rate };
}

const app = express();
app.set('trust proxy', 1); // behind Render's proxy: correct client IPs + HTTPS

async function paystack(method, endpoint, body) {
  const res = await fetch(PAYSTACK + endpoint, {
    method,
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || !json.status) throw new Error(json.message || 'Paystack request failed');
  return json.data;
}

/* Verify with Paystack, check amount/currency against OUR fixed price, then fulfil exactly once. */
async function verifyAndFulfil(reference) {
  const order = await store.get(reference);
  if (!order) throw new Error('Unknown reference');
  if (order.status === 'paid') return order;

  const tx = await paystack('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

  if (tx.status !== 'success') { await store.setStatus(reference, tx.status); return { ...order, status: tx.status }; }
  const paidMinor = Number(tx.amount);
  const paidCurrency = String(tx.currency || '').toUpperCase();
  if (!Number.isInteger(paidMinor) || paidMinor !== Number(order.amount) || paidCurrency !== String(order.currency || '').toUpperCase()) {
    await store.setStatus(reference, 'mismatch');
    throw new Error('Amount or currency mismatch');
  }

  const justPaid = await store.markPaid(reference, tx.paid_at);   // non-null for one caller only
  if (justPaid) {
    await store.grantAccess(justPaid, PLAN);                      // <- access granted here
    console.log(`Order ${reference} paid by ${justPaid.email}; access granted`);
    // Add receipt email / CRM call / plan activation webhook here if needed.
  }
  return { ...order, status: 'paid' };
}

app.get('/healthz', (_req, res) => res.send('ok'));

function rejectIfStarting(res) {
  if (store.kind === 'memory' || store.ready) return false;
  res.status(503).json({ error: 'Checkout is still connecting to its database. Try again shortly.' });
  return true;
}

function signaturesMatch(expected, given) {
  if (!Buffer.isBuffer(expected) || !Buffer.isBuffer(given) || expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

// Legacy header: HMAC-SHA512 of the raw body, keyed with the secret key.
function legacyWebhookValid(rawBody, header) {
  if (!Buffer.isBuffer(rawBody) || !/^[0-9a-f]{128}$/i.test(header || '')) return false;
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(rawBody).digest();
  return signaturesMatch(expected, Buffer.from(header, 'hex'));
}

// Current header: Paystack-Signature t=unix,v1=whk_...:hex, keyed with whsec_...
function modernWebhookValid(rawBody, header) {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  if (!secret || !Buffer.isBuffer(rawBody) || typeof header !== 'string') return false;
  let signedAt = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const splitAt = part.indexOf('=');
    if (splitAt === -1) continue;
    const key = part.slice(0, splitAt).trim();
    const value = part.slice(splitAt + 1).trim();
    if (key === 't') {
      if (signedAt !== null || !/^[0-9]+$/.test(value)) return false;
      signedAt = Number(value);
    } else if (key === 'v1') {
      const colon = value.indexOf(':');
      if (colon !== -1) signatures.push(value.slice(colon + 1));
    }
  }
  if (signedAt === null || !signatures.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - signedAt) > 300) return false;
  const expected = crypto.createHmac('sha512', secret).update(`${signedAt}.`).update(rawBody).digest();
  return signatures.some(hex => /^[0-9a-f]{128}$/.test(hex) && signaturesMatch(expected, Buffer.from(hex, 'hex')));
}

function publicOrigin(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto = forwarded || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

/* Webhook: raw body for the signature check, so it is registered before express.json() */
app.post('/api/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (rejectIfStarting(res)) return;
  const authentic = modernWebhookValid(req.body, req.get('paystack-signature'))
    || legacyWebhookValid(req.body, req.get('x-paystack-signature'));
  if (!authentic) return res.sendStatus(401);

  try {
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'charge.success') await verifyAndFulfil(event.data.reference);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(500); // non-200 makes Paystack retry
  }
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/config', (_req, res) => res.json({
  publicKey: PAYSTACK_PUBLIC_KEY,
  plan: PLAN,
  currency: CURRENCY,
  amount: PRICE_MINOR,
}));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

app.post('/api/paystack/initialize', limiter, async (req, res) => {
  if (rejectIfStarting(res)) return;
  try {
    const email = String(req.body.email || '').trim();
    const name = String(req.body.name || '').trim().slice(0, 100);
    const billing = String(req.body.billing || '').trim().slice(0, 120);
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!name) return res.status(400).json({ error: 'Enter the cardholder name.' });
    if (!billing) return res.status(400).json({ error: 'Select your billing country.' });

    const quote = await priceInChargeCurrency();
    console.log(`Charging ${quote.amount} ${quote.currency} cents for $50 at rate ${quote.rate}`);
    const reference = 'ORD-' + crypto.randomBytes(10).toString('hex');
    await store.create({ reference, email, name, billing, amount: quote.amount, currency: quote.currency });

    const data = await paystack('POST', '/transaction/initialize', {
      email, amount: quote.amount, currency: quote.currency, reference,
      callback_url: `${publicOrigin(req)}/`,
      // Debit, credit, and virtual cards are all charged on the card channel.
      // card_brands lists every brand Paystack documents: Visa and Mastercard everywhere,
      // Verve in Nigeria, Amex in Nigeria, Kenya, and South Africa. Apple Pay uses those cards.
      channels: ['card', 'apple_pay'],
      metadata: {
        plan: PLAN, cardholder_name: name, billing_address: billing,
        usd_cents: quote.usdCents, fx_rate: quote.rate,
        custom_fields: [
          { display_name: 'Cardholder Name', variable_name: 'cardholder_name', value: name },
          { display_name: 'Billing Address', variable_name: 'billing_address', value: billing },
        ],
        custom_filters: {
          card_brands: ['visa', 'mastercard', 'verve', 'amex'],
        },
      },
    });
    res.json({ access_code: data.access_code, reference: data.reference });
  } catch (err) {
    console.error(err.message);
    const leaked = /sk_live_|sk_test_|whsec_/i.test(err.message);
    res.status(500).json({ error: leaked ? 'Could not start payment. Try again.' : (err.message || 'Could not start payment. Try again.') });
  }
});

app.get('/api/paystack/verify/:reference', limiter, async (req, res) => {
  if (rejectIfStarting(res)) return;
  try {
    const order = await verifyAndFulfil(req.params.reference);
    res.json({ status: order.status, reference: req.params.reference });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

store.init().then(() => {
  console.log(`Store ready (${store.kind})`);
}).catch(err => { console.error('Store init failed:', err.message); process.exit(1); });

app.listen(PORT, '0.0.0.0', () => console.log(`Checkout listening on port ${PORT}`));
