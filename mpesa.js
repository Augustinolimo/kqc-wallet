'use strict';
// Single Netlify function: /.netlify/functions/mpesa?a=health|push|status
// Secrets only from environment variables. Never put keys in the app.
// Thin Safaricom Daraja client. Secrets come ONLY from environment variables.

const REQUIRED = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY'];

const base = () =>
  process.env.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

const configured = () => REQUIRED.every((k) => process.env[k]);

// Daraja wants YYYYMMDDHHmmss. Use East Africa Time (UTC+3).
const timestamp = (now = Date.now()) =>
  new Date(now + 3 * 3600 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);

const password = (ts) =>
  Buffer.from(process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + ts).toString('base64');

// 0712…, 0112…, +254…, 254… -> 2547XXXXXXXX / 2541XXXXXXXX. Returns null if invalid.
function normalizePhone(input) {
  const d = String(input || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
  let n = null;
  if (/^0[17]\d{8}$/.test(d)) n = '254' + d.slice(1);
  else if (/^254[17]\d{8}$/.test(d)) n = d;
  else if (/^[17]\d{8}$/.test(d)) n = '254' + d;
  return n;
}

let tokenCache = { value: null, exp: 0 };
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const auth = Buffer.from(
    process.env.MPESA_CONSUMER_KEY + ':' + process.env.MPESA_CONSUMER_SECRET
  ).toString('base64');
  const r = await fetch(base() + '/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: 'Basic ' + auth },
  });
  if (!r.ok) throw new Error('Daraja auth failed (' + r.status + ')');
  const j = await r.json();
  tokenCache = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3599) * 1000 - 60000 };
  return tokenCache.value;
}

async function post(path, body) {
  const token = await getToken();
  const r = await fetch(base() + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j = {};
  try { j = await r.json(); } catch (_) { /* non-JSON body */ }
  return { http: r.status, body: j };
}

async function stkPush({ phone, amount, reference, description, callbackUrl }) {
  const ts = timestamp();
  return post('/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password: password(ts),
    Timestamp: ts,
    // Use CustomerBuyGoodsOnline if your shortcode is a Till number.
    TransactionType: process.env.MPESA_TXN_TYPE || 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: process.env.MPESA_PARTYB || process.env.MPESA_SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: reference,
    TransactionDesc: description,
  });
}

async function stkQuery(checkoutRequestId) {
  const ts = timestamp();
  return post('/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password: password(ts),
    Timestamp: ts,
    CheckoutRequestID: checkoutRequestId,
  });
}


const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});

const last = new Map();

async function doPush(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST' });
  if (!configured()) return json(503, { error: 'M-Pesa is not configured on the server' });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'Bad JSON' }); }

  const phone = normalizePhone(b.phone);
  if (!phone) return json(400, { error: 'Enter a valid Safaricom number, e.g. 0712 345 678' });

  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 150000)
    return json(400, { error: 'Amount must be a whole number of KES between 1 and 150,000' });

  const now = Date.now();
  if (now - (last.get(phone) || 0) < 20000)
    return json(429, { error: 'Please wait a few seconds before trying again' });
  last.set(phone, now);
  if (last.size > 500) last.clear();

  const reference = String(b.ref || 'KQC').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'KQC';
  const callbackUrl =
    process.env.MPESA_CALLBACK_URL ||
    (process.env.URL ? process.env.URL + '/.netlify/functions/mpesa?a=callback' : '');
  if (!/^https:\/\//.test(callbackUrl)) return json(500, { error: 'Server callback URL is not set' });

  try {
    const { body } = await stkPush({
      phone, amount, reference, description: 'KQC Wallet', callbackUrl,
    });
    if (String(body.ResponseCode) !== '0')
      return json(502, { error: body.errorMessage || body.ResponseDescription || 'M-Pesa rejected the request' });
    return json(200, {
      checkoutRequestId: body.CheckoutRequestID,
      merchantRequestId: body.MerchantRequestID,
      message: body.CustomerMessage || 'Check your phone',
    });
  } catch (e) {
    console.error('stk-push error', e.message);
    return json(502, { error: 'Could not reach M-Pesa. Try again.' });
  }
};

const REASONS = {
  1: 'Insufficient M-Pesa balance',
  1032: 'Request cancelled on the phone',
  1037: 'The phone did not respond in time',
  2001: 'Wrong M-Pesa PIN',
  1019: 'Transaction expired',
  1025: 'Could not send the prompt to this phone',
};

async function doStatus(event) {
  if (!configured()) return json(503, { error: 'M-Pesa is not configured on the server' });
  const id = (event.queryStringParameters || {}).id || '';
  if (!/^ws_CO_[A-Za-z0-9_]{6,60}$/.test(id)) return json(400, { error: 'Bad id' });

  try {
    const { body } = await stkQuery(id);
    // While the customer is still looking at the prompt Daraja answers with an error
    // (errorCode 500.001.1001, "being processed"). Treat that as pending.
    if (body.errorCode) return json(200, { status: 'pending' });
    const code = Number(body.ResultCode);
    if (code === 0) return json(200, { status: 'success' });
    if (Number.isNaN(code)) return json(200, { status: 'pending' });
    return json(200, { status: 'failed', reason: REASONS[code] || body.ResultDesc || 'Payment failed' });
  } catch (e) {
    console.error('stk-status error', e.message);
    return json(200, { status: 'pending' }); // transient; the app keeps polling
  }
};

exports.handler = async (event) => {
  const a = (event.queryStringParameters || {}).a;
  if (a === 'health') return json(200, { mpesa: configured(), env: process.env.MPESA_ENV === 'production' ? 'production' : 'sandbox' });
  if (a === 'callback') {
    // Safaricom posts the final result here. For production, credit users from this
    // callback into a database (once per receipt), never from the browser.
    try {
      const cb = JSON.parse(event.body || '{}').Body?.stkCallback;
      if (cb) console.log('mpesa-callback', cb.CheckoutRequestID, cb.ResultCode);
    } catch (_) { /* ignore */ }
    return json(200, { ResultCode: 0, ResultDesc: 'Accepted' });
  }
  if (a === 'push') return doPush(event);
  if (a === 'status') return doStatus(event);
  return json(404, { error: 'Unknown action' });
};
