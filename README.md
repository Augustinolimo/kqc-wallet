# KQC Wallet v2

Mobile-first wallet: buy crypto with M-Pesa, swap, send, stake, bridge, pay merchants.

- The app files in the main folder (installable PWA). Works alone in **Demo mode** (everything simulated).
- `api/mpesa.js`: the backend that sends **real M-Pesa STK pushes** (Safaricom Daraja). The app switches to Live mode automatically when these are deployed and configured.

## Turn on real M-Pesa (sandbox first)

1. Create a free account at https://developer.safaricom.co.ke, make an app, enable **Lipa Na M-Pesa Sandbox**. Copy the Consumer Key, Consumer Secret, Shortcode and Passkey from the app's test credentials page.
2. Put this folder in a GitHub repo (the repo root must contain `netlify.toml`). In Netlify: Add new site, Import from Git, pick the repo. (Drag-and-drop uploads do not reliably build functions, so use Git.)
3. Netlify, Site configuration, Environment variables. Add:
   - `MPESA_CONSUMER_KEY`
   - `MPESA_CONSUMER_SECRET`
   - `MPESA_SHORTCODE` (sandbox: 174379)
   - `MPESA_PASSKEY`
   - `MPESA_ENV` = `sandbox` (use `production` only after Safaricom Go-Live approval)
   - Till numbers only: `MPESA_TXN_TYPE` = `CustomerBuyGoodsOnline`
4. Redeploy. The badge at the top changes from "Demo mode" to "M-Pesa sandbox". In sandbox, use Safaricom's test phone number from the Daraja simulator.

Never put these keys in `index.html` or in GitHub. They live only in Netlify.

## What is real and what is not

| Part | Status |
|---|---|
| STK push, payment status | Real once configured (server-side, Daraja) |
| Prices | Real (CoinGecko, KES). KQC uses a fixed reference price |
| Balances, swaps, sends, stake, bridge | **Ledger kept on the device**; nothing reaches any blockchain |

Before real money: the server must hold the ledger and credit users from a callback endpoint (not yet included) (once per receipt), and the crypto itself must come from a licensed liquidity partner or exchange API. Kenya's VASP Act and CMA/CBK rules apply to selling crypto for M-Pesa, so get legal advice first. Cash-out to M-Pesa (B2C) needs a separate Safaricom approval.

I removed the 100x futures tab: it needs a real matching and liquidation engine and is high-risk for retail users.
