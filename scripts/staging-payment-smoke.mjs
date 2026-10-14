#!/usr/bin/env node
/**
 * Staging payment smoke test, run by a person against a deployed API (never in CI).
 *
 * 1. Logs in as a test customer with the staging test OTP (ALLOW_TEST_OTP / TEST_OTP_NUMBERS / TEST_OTP_CODE on the server).
 * 2. Uses that customer's PENDING_PAYMENT booking, or makes one with customer APIs only
 *    (search -> book -> schedule -> interview-complete -> confirm-worker).
 * 3. POST /payments and checks the server answered a real Razorpay checkout (gateway razorpay, rzp_test_ key, order_ id).
 * 4. POST /payments/{id}/verify with a wrong signature must answer 400 PAYMENT_VERIFICATION_FAILED and change nothing.
 * 5. With --checkout, serves a one-page Razorpay Checkout on http://localhost:<port>. Pay with a Razorpay TEST card or
 *    test UPI; the page sends the SDK result here, the script verifies it with the API and prints the payment and receipt.
 *
 * Usage:
 *   SMOKE_BASE_URL=https://sevanest-backend.onrender.com SMOKE_MOBILE=+91XXXXXXXXXX SMOKE_OTP=XXXXXX \
 *     node scripts/staging-payment-smoke.mjs [--checkout] [--port 5173]
 *
 * It creates a booking and a payment on the target server. It never prints the OTP or the tokens.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const base = (process.env.SMOKE_BASE_URL ?? '').replace(/\/+$/, '');
const mobile = process.env.SMOKE_MOBILE ?? '';
const otp = process.env.SMOKE_OTP ?? '';
const withCheckout = args.includes('--checkout');
const port = Number(args[args.indexOf('--port') + 1]) || 5173;

if (!base || !/^\+[1-9]\d{9,14}$/.test(mobile) || !/^\d{4,10}$/.test(otp)) {
  console.error('Set SMOKE_BASE_URL, SMOKE_MOBILE (E.164, one of TEST_OTP_NUMBERS) and SMOKE_OTP (TEST_OTP_CODE).');
  process.exit(2);
}

let token = '';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`);
  return ok;
};

async function call(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000), // a sleeping free-tier instance can take a minute to wake
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: json };
}

const list = (body) => (Array.isArray(body) ? body : (body?.data ?? []));
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const fail = (msg, res) => {
  console.error(`STOP  ${msg}${res ? `: HTTP ${res.status} ${JSON.stringify(res.body)}` : ''}`);
  process.exit(1);
};

async function login() {
  const requested = await call('POST', '/auth/otp/request', { mobile, appType: 'CUSTOMER' });
  if (requested.status !== 200) fail('OTP request', requested);
  const verified = await call('POST', '/auth/otp/verify', { mobile, appType: 'CUSTOMER', otp });
  if (verified.status !== 200) fail('OTP verify (is the number in TEST_OTP_NUMBERS and the code TEST_OTP_CODE?)', verified);
  token = verified.body.accessToken;
  check('test customer logs in with the staging test OTP', Boolean(token));
}

async function payableBooking() {
  const mine = await call('GET', '/bookings?status=PENDING_PAYMENT&limit=1');
  if (mine.status !== 200) fail('list my bookings', mine);
  const existing = list(mine.body)[0];
  if (existing) {
    console.log(`info  using existing PENDING_PAYMENT booking ${existing.id}`);
    return existing.id;
  }

  console.log('info  no booking waiting for payment; creating one with customer APIs');
  const categories = list((await call('GET', '/service-categories')).body);
  const areas = list((await call('GET', '/service-areas')).body);
  for (const category of categories) {
    for (const area of areas) {
      const search = await call(
        'GET',
        `/search/workers?category=${encodeURIComponent(category.code)}&areaId=${area.id}&limit=5`,
      );
      for (const worker of list(search.body)) {
        const window = worker.availability?.[0] ?? { start: '09:00', end: '12:00' };
        const created = await call('POST', '/bookings', {
          category: category.code,
          areaId: area.id,
          engagement: worker.engagementPreference ?? 'PART_TIME',
          availableFrom: window.start,
          availableTo: window.end,
          workerId: worker.workerId,
        });
        if (created.status !== 201) {
          console.log(`info  booking with worker ${worker.workerId} refused: ${created.body?.code ?? created.status}`);
          continue;
        }
        const id = created.body.id;
        const steps = [
          ['schedule', { scheduleType: 'INTERVIEW', scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }],
          ['interview-complete', { outcomeNote: 'Staging payment smoke test' }],
          ['confirm-worker', { startDate: inDays(1) }],
        ];
        for (const [step, body] of steps) {
          const res = await call('POST', `/bookings/${id}/${step}`, body);
          if (res.status !== 200) fail(`booking ${id} ${step}`, res);
        }
        const after = await call('GET', `/bookings/${id}`);
        check('booking reaches PENDING_PAYMENT', after.body?.status === 'PENDING_PAYMENT', `booking ${id}`);
        return id;
      }
    }
  }
  return fail('no verified worker found in any category and area for this customer');
}

async function startPayment(bookingId) {
  const res = await call('POST', '/payments', { bookingId }, { 'idempotency-key': randomUUID() });
  if (res.status === 503) fail('payment provider unavailable: PAYMENT_PROVIDER / RAZORPAY_* not set on this service', res);
  if (res.status === 422) fail('no active booking fee: an admin must PUT /admin/fees/booking-fee', res);
  if (res.status !== 201) fail('POST /payments', res);
  const { checkout } = res.body;
  check('POST /payments answers 201 with a checkout', Boolean(checkout), `payment ${res.body.id}, status ${res.body.status}`);
  check('checkout.gateway is razorpay', checkout?.gateway === 'razorpay', `got ${checkout?.gateway}`);
  check('checkout.keyId is a Razorpay test key', /^rzp_test_/.test(checkout?.keyId ?? ''), checkout?.keyId?.startsWith('rzp_live_') ? 'LIVE key on staging!' : '');
  check('checkout.orderId is a Razorpay order', /^order_/.test(checkout?.orderId ?? ''));
  check('checkout.amount is a positive integer in paise', Number.isInteger(checkout?.amount) && checkout.amount > 0, `${checkout?.amount} ${checkout?.currency}`);
  return res.body;
}

async function wrongSignatureIsRefused(payment) {
  const res = await call(
    'POST',
    `/payments/${payment.id}/verify`,
    { providerPaymentId: 'pay_smokeNotReal000', signature: '0'.repeat(64) },
    { 'idempotency-key': randomUUID() },
  );
  check('verify with a wrong signature answers 400 PAYMENT_VERIFICATION_FAILED', res.status === 400 && res.body?.code === 'PAYMENT_VERIFICATION_FAILED', `HTTP ${res.status} ${res.body?.code ?? ''}`);
  const again = await call('GET', `/payments/${payment.id}`);
  check('the payment is unchanged after a wrong signature', again.body?.status === payment.status, `status ${again.body?.status}`);
}

function checkoutPage(payment) {
  const c = payment.checkout;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Staging test checkout</title><style>body{font:16px system-ui;margin:40px auto;max-width:520px;padding:0 16px}button{font:inherit;padding:10px 18px}pre{white-space:pre-wrap}</style>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script></head><body>
<h1>Staging test checkout</h1><p>Order ${c.orderId}: ${(c.amount / 100).toFixed(2)} ${c.currency}. Use a Razorpay <b>test</b> card or test UPI only.</p>
<button id="pay">Open Razorpay Checkout</button><pre id="out"></pre>
<script>
const out = document.getElementById('out');
const send = (body) => fetch('/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then((r) => r.text()).then((t) => { out.textContent = t; });
document.getElementById('pay').onclick = () => {
  const rzp = new Razorpay({
    key: ${JSON.stringify(c.keyId)}, order_id: ${JSON.stringify(c.orderId)}, amount: ${c.amount}, currency: ${JSON.stringify(c.currency)},
    name: 'SevaNest staging', description: 'Booking fee (test mode)',
    handler: (r) => send({ providerPaymentId: r.razorpay_payment_id, signature: r.razorpay_signature }),
  });
  rzp.on('payment.failed', (r) => send({ failed: r.error && { code: r.error.code, reason: r.error.reason, description: r.error.description } }));
  rzp.open();
};
</script></body></html>`;
}

function runCheckout(payment) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(checkoutPage(payment));
      }
      if (req.method === 'POST' && req.url === '/result') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || '{}');
        let report;
        if (body.failed) {
          console.log(`info  checkout reported a failure: ${JSON.stringify(body.failed)}`);
          const after = await call('GET', `/payments/${payment.id}`);
          report = { checkoutFailed: body.failed, payment: after.body };
        } else {
          const verified = await call('POST', `/payments/${payment.id}/verify`, body, { 'idempotency-key': randomUUID() });
          check('verify with the SDK result answers 200', verified.status === 200, `HTTP ${verified.status} ${verified.body?.code ?? ''}`);
          check('payment is SUCCEEDED', verified.body?.status === 'SUCCEEDED', `status ${verified.body?.status}`);
          check('payment carries method and gateway reference', Boolean(verified.body?.paymentMethod && verified.body?.gatewayReference), `${verified.body?.paymentMethod} ${verified.body?.paymentMethodDetail ?? ''} ${verified.body?.gatewayReference ?? ''}`);
          const receipt = await call('GET', `/payments/${payment.id}/receipt`);
          check('receipt is available', receipt.status === 200, `receipt ${receipt.body?.receiptNumber ?? receipt.status}`);
          const booking = await call('GET', `/bookings/${payment.bookingId}`);
          check('booking is CONFIRMED after payment', booking.body?.status === 'CONFIRMED', `status ${booking.body?.status}`);
          report = { payment: verified.body, receipt: receipt.body };
        }
        console.log(JSON.stringify(report, null, 2));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(report, null, 2));
        server.close();
        return resolve();
      }
      res.writeHead(404).end();
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`\nOpen http://localhost:${port} and pay with a Razorpay TEST card or test UPI. Waiting...`);
    });
  });
}

await login();
const bookingId = await payableBooking();
const payment = await startPayment(bookingId);
await wrongSignatureIsRefused(payment);
if (withCheckout && payment.checkout?.gateway === 'razorpay') await runCheckout(payment);
else if (!withCheckout) console.log('\ninfo  run again with --checkout to finish a real test-mode payment in a browser');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
