require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const store = require('./store');

const { PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY, PORT = 3000 } = process.env;
const CURRENCY = process.env.PAYSTACK_CURRENCY || 'USD';
const PRICE_MINOR = parseInt(process.env.PRICE_MINOR || '5000', 10); // fixed price, server-side only
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
console.log(`Paystack mode: ${PAYSTACK_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : 'TEST'} | ${PRICE_MINOR / 100} ${CURRENCY}`);

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
  if (tx.amount !== PRICE_MINOR || tx.currency !== CURRENCY || tx.amount !== order.amount) {
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

/* Webhook: raw body for the signature check, so it is registered before express.json() */
app.post('/api/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.get('x-paystack-signature') || '';
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  const valid = signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return res.sendStatus(401);

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
app.get('/api/config', (_req, res) => res.json({ publicKey: PAYSTACK_PUBLIC_KEY }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

app.post('/api/paystack/initialize', limiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    const name = String(req.body.name || '').trim().slice(0, 100);
    const billing = String(req.body.billing || '').trim().slice(0, 120);
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!name) return res.status(400).json({ error: 'Enter the cardholder name.' });

    const reference = 'ORD_' + crypto.randomBytes(10).toString('hex');
    await store.create({ reference, email, name, billing, amount: PRICE_MINOR, currency: CURRENCY });

    const data = await paystack('POST', '/transaction/initialize', {
      email, amount: PRICE_MINOR, currency: CURRENCY, reference,
      channels: ['card'],
      metadata: {
        plan: PLAN, cardholder_name: name, billing_address: billing,
        custom_fields: [
          { display_name: 'Cardholder Name', variable_name: 'cardholder_name', value: name },
          { display_name: 'Billing Address', variable_name: 'billing_address', value: billing },
        ],
      },
    });
    res.json({ access_code: data.access_code, reference: data.reference });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not start payment. Try again.' });
  }
});

app.get('/api/paystack/verify/:reference', limiter, async (req, res) => {
  try {
    const order = await verifyAndFulfil(req.params.reference);
    res.json({ status: order.status, reference: req.params.reference });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

store.init().then(() => {
  app.listen(PORT, () => console.log(`Checkout running on port ${PORT} (${store.kind} store)`));
}).catch(err => { console.error('Store init failed:', err.message); process.exit(1); });
