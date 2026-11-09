'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated database for the test run.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sfh-test-'));
process.env.ADMIN_PHONE = '099000001';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.SERVICE_FEE_PERCENT = '5';

const { createApp, ensureAdmin } = require('../server/index');

let server;
let base;

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + '/api' + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

test.before(async () => {
  ensureAdmin();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('full order flow: list, order, confirm, pay, deliver', async () => {
  const farmer = client();
  const customer = client();
  const admin = client();

  let r = await farmer('POST', '/auth/register', {
    role: 'farmer', name: 'Test Farmer', farmName: 'Test Farm', phone: '076 555555', password: 'password1', district: 'Bo',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.phone, '+23276555555');

  r = await farmer('POST', '/farmer/products', {
    name: 'Cassava', category: 'Roots & tubers', unit: 'bag (50kg)', price: '450', quantity: 10, district: 'Bo',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const productId = r.body.product.id;
  assert.equal(r.body.product.price, 45000);

  r = await customer('GET', '/products?q=cass');
  assert.equal(r.body.products.length, 1);

  // Customers cannot list produce; farmers cannot place orders.
  r = await customer('POST', '/auth/register', { role: 'customer', name: 'Buyer', phone: '+23279666666', password: 'password1', district: 'Western Area Urban' });
  assert.equal(r.status, 201);
  assert.equal((await customer('POST', '/farmer/products', {})).status, 403);
  assert.equal((await farmer('POST', '/orders', { items: [] })).status, 403);

  // Over-ordering is rejected and stock is untouched.
  r = await customer('POST', '/orders', { items: [{ productId, quantity: 11 }], deliveryAddress: '1 Main Road', deliveryDistrict: 'Bo', deliveryPhone: '079666666' });
  assert.equal(r.status, 409);

  r = await customer('POST', '/orders', { items: [{ productId, quantity: 2 }], deliveryAddress: '1 Main Road', deliveryDistrict: 'Bo', deliveryPhone: '079666666' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const order = r.body.orders[0];
  assert.equal(order.status, 'placed');
  assert.equal(order.subtotal, 90000);
  assert.equal(order.serviceFee, 4500);
  assert.equal((await customer('GET', `/products/${productId}`)).body.product.quantity, 8);

  // Cannot pay before the farmer confirms.
  assert.equal((await customer('POST', `/orders/${order.id}/pay`, { method: 'orange_money', msisdn: '079666666' })).status, 409);

  r = await farmer('POST', `/orders/${order.id}/confirm`, { deliveryFee: '40' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.total, 90000 + 4500 + 4000);

  // Simulated declined payment leaves the order unpaid.
  r = await customer('POST', `/orders/${order.id}/pay`, { method: 'afrimoney', msisdn: '030000000' });
  assert.equal(r.status, 402);

  r = await customer('POST', `/orders/${order.id}/pay`, { method: 'orange_money', msisdn: '079666666' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'paid');
  assert.match(r.body.order.paymentRef, /^SIM-/);

  assert.equal((await customer('POST', `/orders/${order.id}/cancel`, {})).status, 409);
  assert.equal((await farmer('POST', `/orders/${order.id}/deliver`, {})).status, 409);
  assert.equal((await farmer('POST', `/orders/${order.id}/dispatch`, {})).body.order.status, 'out_for_delivery');
  assert.equal((await farmer('POST', `/orders/${order.id}/deliver`, {})).body.order.status, 'delivered');

  r = await admin('POST', '/auth/login', { phone: '099000001', password: 'admin-pass-123' });
  assert.equal(r.status, 200);
  r = await admin('GET', '/admin/summary');
  assert.equal(r.body.gmv, 98500);
  assert.equal(r.body.serviceFees, 4500);
});

test('cancel and decline restore stock; other users cannot see orders', async () => {
  const farmer = client();
  const customer = client();
  const stranger = client();
  await farmer('POST', '/auth/register', { role: 'farmer', name: 'F2', farmName: 'Farm 2', phone: '077111222', password: 'password1', district: 'Kenema' });
  const pid = (await farmer('POST', '/farmer/products', { name: 'Tomatoes', category: 'Vegetables', unit: 'basket', price: 150, quantity: 5, district: 'Kenema' })).body.product.id;
  await customer('POST', '/auth/register', { role: 'customer', name: 'C2', phone: '077333444', password: 'password1', district: 'Kenema' });
  await stranger('POST', '/auth/register', { role: 'customer', name: 'C3', phone: '077555666', password: 'password1', district: 'Kenema' });

  const place = async () => (await customer('POST', '/orders', { items: [{ productId: pid, quantity: 3 }], deliveryAddress: 'Hangha Road', deliveryDistrict: 'Kenema', deliveryPhone: '077333444' })).body.orders[0];

  const o1 = await place();
  assert.equal((await stranger('GET', `/orders/${o1.id}`)).status, 404);
  assert.equal((await customer('POST', `/orders/${o1.id}/cancel`, {})).body.order.status, 'cancelled');
  assert.equal((await customer('GET', `/products/${pid}`)).body.product.quantity, 5);

  const o2 = await place();
  assert.equal((await farmer('POST', `/orders/${o2.id}/decline`, { note: 'Sold at market' })).body.order.status, 'declined');
  assert.equal((await customer('GET', `/products/${pid}`)).body.product.quantity, 5);
});

test('rejects bad input', async () => {
  const c = client();
  assert.equal((await c('POST', '/auth/register', { role: 'customer', name: 'X', phone: '12345', password: 'password1', district: 'Bo' })).status, 400);
  assert.equal((await c('POST', '/auth/register', { role: 'admin', name: 'Xavier', phone: '076999999', password: 'password1', district: 'Bo' })).status, 400);
  assert.equal((await c('POST', '/auth/login', { phone: '076999999', password: 'nope' })).status, 401);
  assert.equal((await c('GET', '/orders')).status, 401);
  const res = await fetch(base + '/api/auth/login', { method: 'POST', body: 'phone=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 415);
});
