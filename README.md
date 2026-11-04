# Paystack card checkout (fixed price, card only)

## Run locally
1. `cp .env.example .env`, paste TEST keys (leave DATABASE_URL empty for in-memory dev storage).
2. `npm install && npm start`, open http://localhost:3000
3. Test card 4084 0840 8408 4081, any future expiry, CVV 408, OTP 123456.
4. To test the webhook locally: `ngrok http 3000`, then set the Test Webhook URL in
   Paystack Dashboard > Settings > API Keys & Webhooks to https://<ngrok-host>/api/paystack/webhook

## Deploy on Render
1. Push this folder to a GitHub repo (`.env` is git-ignored).
2. Render > New > Blueprint > pick the repo. `render.yaml` creates the `electron` web service (Oregon, `0.5c-512mb`, always on) and `electron-db` Postgres (`0.1c-256mb`, PostgreSQL 16) and wires `DATABASE_URL` to the private connection string. When prompted, paste the two Paystack keys.
3. When prompted, paste PAYSTACK_SECRET_KEY and PAYSTACK_PUBLIC_KEY (test first).
4. In Paystack, set the webhook URL to https://<your-service>.onrender.com/api/paystack/webhook
5. Run a test payment; confirm a row in `orders` (status paid) and `entitlements`.
6. Go live: activate your Paystack business, swap in sk_live_/pk_live_ in Render env vars,
   set the LIVE webhook URL (separate field), confirm USD is enabled, make one real small payment and refund it.

## Checking access
`SELECT * FROM entitlements WHERE email = 'customer@example.com';`
