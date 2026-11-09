'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');

const { db, tx, setSetting, serviceFeePercent, UPLOAD_DIR } = require('./db');
const auth = require('./auth');
const payments = require('./payments');
const { DISTRICTS, CATEGORIES, UNITS, ORDER_STATUSES } = require('./constants');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function str(value, label, { required = true, min = 1, max = 200 } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (!s) {
    if (required) throw bad(`${label} is required`);
    return '';
  }
  if (s.length < min) throw bad(`${label} must be at least ${min} characters`);
  if (s.length > max) throw bad(`${label} must be at most ${max} characters`);
  return s;
}

function oneOf(value, list, label) {
  if (!list.includes(value)) throw bad(`Choose a valid ${label}`);
  return value;
}

function intIn(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number between ${min} and ${max}`);
  return n;
}

// Leones (decimal, e.g. 25.5) -> minor units (2550)
function money(value, label, { min = 0, max = 10_000_000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be between ${min} and ${max} SLe`);
  return Math.round(n * 100);
}

// Sierra Leone numbers: 0XX XXXXXX locally, +232 XX XXXXXX internationally.
function normalizePhone(value) {
  const digits = String(value || '').replace(/[\s\-().]/g, '');
  let m;
  if ((m = digits.match(/^0(\d{8})$/))) return `+232${m[1]}`;
  if ((m = digits.match(/^\+?232(\d{8})$/))) return `+232${m[1]}`;
  throw bad('Enter a valid Sierra Leone phone number, e.g. 076 123456');
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    if (roles.length && !roles.includes(req.user.role)) return next(new HttpError(403, 'Not allowed'));
    next();
  };
}

function orderCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
  return `SFH-${s}`;
}

function productDto(p) {
  return {
    id: p.id, farmerId: p.farmer_id, name: p.name, category: p.category, unit: p.unit,
    price: p.price, quantity: p.quantity, district: p.district, description: p.description,
    image: p.image, harvestDate: p.harvest_date, active: !!p.active,
    farmerName: p.farmer_name, farmName: p.farm_name, createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

function loadOrder(id) {
  const o = db.prepare(`
    SELECT o.*, c.name AS customer_name, f.name AS farmer_name, f.farm_name, f.phone AS farmer_phone
    FROM orders o JOIN users c ON c.id = o.customer_id JOIN users f ON f.id = o.farmer_id
    WHERE o.id = ?`).get(id);
  if (!o) return null;
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  o.events = db.prepare('SELECT status, note, created_at FROM order_events WHERE order_id = ? ORDER BY id').all(id);
  return o;
}

function orderDto(o) {
  return {
    id: o.id, code: o.code, status: o.status, statusLabel: ORDER_STATUSES[o.status] || o.status,
    customerId: o.customer_id, customerName: o.customer_name,
    farmerId: o.farmer_id, farmerName: o.farmer_name, farmName: o.farm_name, farmerPhone: o.farmer_phone,
    subtotal: o.subtotal, deliveryFee: o.delivery_fee, serviceFeePercent: o.service_fee_percent,
    serviceFee: o.service_fee, total: o.total,
    deliveryAddress: o.delivery_address, deliveryDistrict: o.delivery_district, deliveryPhone: o.delivery_phone,
    notes: o.notes, farmerNote: o.farmer_note,
    paymentMethod: o.payment_method, paymentRef: o.payment_ref, paidAt: o.paid_at,
    createdAt: o.created_at, updatedAt: o.updated_at,
    items: (o.items || []).map((i) => ({
      productId: i.product_id, name: i.name, unit: i.unit, unitPrice: i.unit_price,
      quantity: i.quantity, lineTotal: i.line_total,
    })),
    events: (o.events || []).map((e) => ({ status: e.status, note: e.note, at: e.created_at })),
  };
}

function setStatus(orderId, status, note = '') {
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, orderId);
  db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)').run(orderId, status, note);
}

function restoreStock(orderId) {
  const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId);
  const upd = db.prepare("UPDATE products SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?");
  for (const i of items) upd.run(i.quantity, i.product_id);
}

// Loads an order the current user is party to (or any order for admins).
function orderForUser(req, roles) {
  const o = loadOrder(Number(req.params.id));
  if (!o) throw new HttpError(404, 'Order not found');
  const u = req.user;
  const isParty = (u.role === 'customer' && o.customer_id === u.id) || (u.role === 'farmer' && o.farmer_id === u.id);
  if (!isParty && u.role !== 'admin') throw new HttpError(404, 'Order not found');
  if (roles && !roles.includes(u.role)) throw new HttpError(403, 'Not allowed');
  return o;
}

function expectStatus(o, ...statuses) {
  if (!statuses.includes(o.status)) {
    throw new HttpError(409, `This order is "${ORDER_STATUSES[o.status]}" and cannot be changed that way`);
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.json({ limit: '6mb' }));
  app.use(auth.loadUser);

  // Mutating API calls must be JSON: browsers cannot send that cross-site
  // without a CORS preflight, which (with SameSite=Lax cookies) blocks CSRF.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'Requests must be sent as JSON'));
    }
    next();
  });

  const api = express.Router();

  // ---- Meta ---------------------------------------------------------------
  api.get('/meta', (_req, res) => {
    res.json({
      districts: DISTRICTS, categories: CATEGORIES, units: UNITS, statuses: ORDER_STATUSES,
      serviceFeePercent: serviceFeePercent(), paymentMethods: payments.listMethods(),
      paymentMode: payments.mode(),
    });
  });

  // ---- Auth ---------------------------------------------------------------
  api.post('/auth/register', (req, res) => {
    const b = req.body || {};
    const role = oneOf(b.role, ['farmer', 'customer'], 'account type');
    const name = str(b.name, 'Name', { min: 2, max: 80 });
    const phone = normalizePhone(b.phone);
    const password = str(b.password, 'Password', { min: 8, max: 128 });
    const email = str(b.email, 'Email', { required: false, max: 120 });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email address');
    const district = oneOf(b.district, DISTRICTS, 'district');
    const farmName = role === 'farmer' ? str(b.farmName, 'Farm name', { min: 2, max: 80 }) : null;
    const address = str(b.address, 'Address', { required: false, max: 200 });

    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) {
      throw new HttpError(409, 'An account with this phone number already exists');
    }
    const r = db.prepare(`INSERT INTO users (role, name, phone, email, password_hash, district, farm_name, address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(role, name, phone, email || null, auth.hashPassword(password), district, farmName, address || null);
    auth.createSession(res, Number(r.lastInsertRowid), req.secure);
    res.status(201).json({ user: auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
  });

  api.post('/auth/login', (req, res) => {
    const b = req.body || {};
    const phone = normalizePhone(b.phone);
    const key = `${phone}|${req.ip}`;
    if (!auth.loginAllowed(key)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!u || !auth.verifyPassword(String(b.password || ''), u.password_hash)) {
      auth.recordLoginFailure(key);
      throw new HttpError(401, 'Wrong phone number or password');
    }
    if (!u.active) throw new HttpError(403, 'This account has been suspended. Contact support.');
    auth.clearLoginFailures(key);
    auth.createSession(res, u.id, req.secure);
    res.json({ user: auth.publicUser(u) });
  });

  api.post('/auth/logout', (req, res) => {
    auth.destroySession(req, res);
    res.json({ ok: true });
  });

  api.get('/auth/me', (req, res) => res.json({ user: auth.publicUser(req.user) }));

  api.patch('/me', requireRole(), (req, res) => {
    const b = req.body || {};
    const u = req.user;
    const name = b.name !== undefined ? str(b.name, 'Name', { min: 2, max: 80 }) : u.name;
    const email = b.email !== undefined ? str(b.email, 'Email', { required: false, max: 120 }) || null : u.email;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email address');
    const district = b.district !== undefined ? oneOf(b.district, DISTRICTS, 'district') : u.district;
    const address = b.address !== undefined ? str(b.address, 'Address', { required: false, max: 200 }) || null : u.address;
    let farmName = u.farm_name;
    let deliveryFee = u.delivery_fee;
    if (u.role === 'farmer') {
      if (b.farmName !== undefined) farmName = str(b.farmName, 'Farm name', { min: 2, max: 80 });
      if (b.deliveryFee !== undefined) deliveryFee = money(b.deliveryFee, 'Delivery charge', { max: 100_000 });
    }
    if (b.newPassword) {
      if (!auth.verifyPassword(String(b.currentPassword || ''), u.password_hash)) throw bad('Current password is wrong');
      const pw = str(b.newPassword, 'New password', { min: 8, max: 128 });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(pw), u.id);
    }
    db.prepare('UPDATE users SET name = ?, email = ?, district = ?, address = ?, farm_name = ?, delivery_fee = ? WHERE id = ?')
      .run(name, email, district, address, farmName, deliveryFee, u.id);
    res.json({ user: auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  });

  // ---- Public catalogue ---------------------------------------------------
  api.get('/products', (req, res) => {
    const where = ['p.active = 1', 'p.deleted = 0', 'p.quantity > 0', 'f.active = 1'];
    const params = [];
    if (req.query.q) {
      where.push('(p.name LIKE ? OR p.description LIKE ? OR f.farm_name LIKE ?)');
      const like = `%${String(req.query.q).slice(0, 60)}%`;
      params.push(like, like, like);
    }
    if (req.query.category) { where.push('p.category = ?'); params.push(String(req.query.category)); }
    if (req.query.district) { where.push('p.district = ?'); params.push(String(req.query.district)); }
    if (req.query.farmer) { where.push('p.farmer_id = ?'); params.push(Number(req.query.farmer)); }
    const sort = { price_asc: 'p.price ASC', price_desc: 'p.price DESC' }[req.query.sort] || 'p.updated_at DESC';
    const rows = db.prepare(`
      SELECT p.*, f.name AS farmer_name, f.farm_name FROM products p JOIN users f ON f.id = p.farmer_id
      WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT 200`).all(...params);
    res.json({ products: rows.map(productDto) });
  });

  api.get('/products/:id', (req, res) => {
    const p = db.prepare(`
      SELECT p.*, f.name AS farmer_name, f.farm_name, f.district AS farmer_district
      FROM products p JOIN users f ON f.id = p.farmer_id
      WHERE p.id = ? AND p.deleted = 0 AND f.active = 1`).get(Number(req.params.id));
    if (!p || (!p.active && !(req.user && req.user.id === p.farmer_id))) throw new HttpError(404, 'Product not found');
    res.json({ product: productDto(p) });
  });

  // ---- Farmer: listings ---------------------------------------------------
  const farmer = requireRole('farmer');

  function readProductBody(b, existing) {
    const pick = (k, fn) => (b[k] !== undefined || !existing ? fn(b[k]) : undefined);
    return {
      name: pick('name', (v) => str(v, 'Product name', { min: 2, max: 80 })),
      category: pick('category', (v) => oneOf(v, CATEGORIES, 'category')),
      unit: pick('unit', (v) => str(v, 'Unit', { max: 30 })),
      price: pick('price', (v) => money(v, 'Price', { min: 0.01, max: 1_000_000 })),
      quantity: pick('quantity', (v) => intIn(v, 'Quantity', 0, 1_000_000)),
      district: pick('district', (v) => oneOf(v, DISTRICTS, 'district')),
      description: pick('description', (v) => str(v, 'Description', { required: false, max: 1000 })),
      image: pick('image', (v) => {
        if (!v) return null;
        if (!/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(v)) throw bad('Invalid image');
        return v;
      }),
      harvest_date: pick('harvestDate', (v) => {
        if (!v) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('Harvest date must be a date');
        return v;
      }),
      active: pick('active', (v) => (v === undefined ? 1 : v ? 1 : 0)),
    };
  }

  api.get('/farmer/products', farmer, (req, res) => {
    const rows = db.prepare('SELECT * FROM products WHERE farmer_id = ? AND deleted = 0 ORDER BY updated_at DESC').all(req.user.id);
    res.json({ products: rows.map(productDto) });
  });

  api.post('/farmer/products', farmer, (req, res) => {
    const p = readProductBody(req.body || {}, null);
    const r = db.prepare(`INSERT INTO products (farmer_id, name, category, unit, price, quantity, district, description, image, harvest_date, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, p.name, p.category, p.unit, p.price, p.quantity, p.district, p.description, p.image, p.harvest_date, p.active);
    res.status(201).json({ product: productDto(db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid)) });
  });

  api.patch('/farmer/products/:id', farmer, (req, res) => {
    const existing = db.prepare('SELECT * FROM products WHERE id = ? AND farmer_id = ? AND deleted = 0').get(Number(req.params.id), req.user.id);
    if (!existing) throw new HttpError(404, 'Product not found');
    const changes = readProductBody(req.body || {}, existing);
    const merged = { ...existing };
    for (const [k, v] of Object.entries(changes)) if (v !== undefined) merged[k] = v;
    db.prepare(`UPDATE products SET name = ?, category = ?, unit = ?, price = ?, quantity = ?, district = ?, description = ?,
      image = ?, harvest_date = ?, active = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(merged.name, merged.category, merged.unit, merged.price, merged.quantity, merged.district, merged.description,
        merged.image, merged.harvest_date, merged.active, existing.id);
    res.json({ product: productDto(db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id)) });
  });

  api.delete('/farmer/products/:id', farmer, (req, res) => {
    const r = db.prepare("UPDATE products SET deleted = 1, active = 0, updated_at = datetime('now') WHERE id = ? AND farmer_id = ? AND deleted = 0")
      .run(Number(req.params.id), req.user.id);
    if (!r.changes) throw new HttpError(404, 'Product not found');
    res.json({ ok: true });
  });

  api.get('/farmer/summary', farmer, (req, res) => {
    const id = req.user.id;
    const byStatus = Object.fromEntries(
      db.prepare('SELECT status, COUNT(*) AS n FROM orders WHERE farmer_id = ? GROUP BY status').all(id).map((r) => [r.status, r.n]));
    const earned = db.prepare(`SELECT COALESCE(SUM(subtotal + delivery_fee), 0) AS v FROM orders
      WHERE farmer_id = ? AND status IN ('paid','out_for_delivery','delivered')`).get(id).v;
    const listings = db.prepare('SELECT COUNT(*) AS n FROM products WHERE farmer_id = ? AND deleted = 0 AND active = 1').get(id).n;
    const lowStock = db.prepare('SELECT COUNT(*) AS n FROM products WHERE farmer_id = ? AND deleted = 0 AND active = 1 AND quantity <= 5').get(id).n;
    res.json({ byStatus, earned, listings, lowStock });
  });

  // ---- Image uploads (farmers) -------------------------------------------
  api.post('/uploads', farmer, (req, res) => {
    const m = String((req.body || {}).dataUrl || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw bad('Upload a JPEG, PNG or WebP image');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 4 * 1024 * 1024) throw bad('Image must be smaller than 4 MB');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    res.status(201).json({ url: `/uploads/${name}` });
  });

  // ---- Orders -------------------------------------------------------------
  // Customer places an order from a cart. Items from different farmers become
  // separate orders, because each farmer confirms and delivers their own.
  api.post('/orders', requireRole('customer'), (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.items) || b.items.length === 0) throw bad('Your basket is empty');
    if (b.items.length > 50) throw bad('Too many items in one order');
    const deliveryAddress = str(b.deliveryAddress, 'Delivery address', { min: 5, max: 200 });
    const deliveryDistrict = oneOf(b.deliveryDistrict, DISTRICTS, 'delivery district');
    const deliveryPhone = normalizePhone(b.deliveryPhone);
    const notes = str(b.notes, 'Notes', { required: false, max: 500 });

    const wanted = new Map();
    for (const it of b.items) {
      const pid = intIn(it.productId, 'Product', 1, Number.MAX_SAFE_INTEGER);
      wanted.set(pid, (wanted.get(pid) || 0) + intIn(it.quantity, 'Quantity', 1, 100_000));
    }
    const feePct = serviceFeePercent();

    const ids = tx(() => {
      const byFarmer = new Map();
      for (const [pid, qty] of wanted) {
        const p = db.prepare(`SELECT p.* FROM products p JOIN users f ON f.id = p.farmer_id
          WHERE p.id = ? AND p.active = 1 AND p.deleted = 0 AND f.active = 1`).get(pid);
        if (!p) throw bad('One of the products in your basket is no longer available');
        if (p.quantity < qty) throw new HttpError(409, `Only ${p.quantity} ${p.unit} of ${p.name} left`);
        db.prepare("UPDATE products SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ?").run(qty, pid);
        if (!byFarmer.has(p.farmer_id)) byFarmer.set(p.farmer_id, []);
        byFarmer.get(p.farmer_id).push({ p, qty });
      }
      const created = [];
      for (const [farmerId, lines] of byFarmer) {
        const subtotal = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
        const serviceFee = Math.round((subtotal * feePct) / 100);
        let code;
        do { code = orderCode(); } while (db.prepare('SELECT 1 FROM orders WHERE code = ?').get(code));
        const r = db.prepare(`INSERT INTO orders (code, customer_id, farmer_id, status, subtotal, service_fee_percent, service_fee,
          delivery_address, delivery_district, delivery_phone, notes) VALUES (?, ?, ?, 'placed', ?, ?, ?, ?, ?, ?, ?)`)
          .run(code, req.user.id, farmerId, subtotal, feePct, serviceFee, deliveryAddress, deliveryDistrict, deliveryPhone, notes);
        const oid = Number(r.lastInsertRowid);
        const ins = db.prepare(`INSERT INTO order_items (order_id, product_id, name, unit, unit_price, quantity, line_total)
          VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const l of lines) ins.run(oid, l.p.id, l.p.name, l.p.unit, l.p.price, l.qty, l.p.price * l.qty);
        db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)').run(oid, 'placed', 'Order placed');
        created.push(oid);
      }
      return created;
    });
    res.status(201).json({ orders: ids.map((id) => orderDto(loadOrder(id))) });
  });

  api.get('/orders', requireRole(), (req, res) => {
    const u = req.user;
    const where = [];
    const params = [];
    if (u.role === 'customer') { where.push('o.customer_id = ?'); params.push(u.id); }
    if (u.role === 'farmer') { where.push('o.farmer_id = ?'); params.push(u.id); }
    if (req.query.status) { where.push('o.status = ?'); params.push(String(req.query.status)); }
    const rows = db.prepare(`SELECT o.id FROM orders o ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.id DESC LIMIT 300`).all(...params);
    res.json({ orders: rows.map((r) => orderDto(loadOrder(r.id))) });
  });

  api.get('/orders/:id', requireRole(), (req, res) => {
    res.json({ order: orderDto(orderForUser(req)) });
  });

  // Farmer confirms they can fulfil the order and sets the delivery charge.
  api.post('/orders/:id/confirm', farmer, (req, res) => {
    const o = orderForUser(req, ['farmer']);
    expectStatus(o, 'placed');
    const deliveryFee = money((req.body || {}).deliveryFee, 'Delivery charge', { max: 100_000 });
    const note = str((req.body || {}).note, 'Note', { required: false, max: 300 });
    tx(() => {
      db.prepare('UPDATE orders SET delivery_fee = ?, total = subtotal + service_fee + ?, farmer_note = ? WHERE id = ?')
        .run(deliveryFee, deliveryFee, note, o.id);
      setStatus(o.id, 'awaiting_payment', note || 'Farmer confirmed the order and delivery charge');
    });
    res.json({ order: orderDto(loadOrder(o.id)) });
  });

  api.post('/orders/:id/decline', farmer, (req, res) => {
    const o = orderForUser(req, ['farmer']);
    expectStatus(o, 'placed', 'awaiting_payment');
    const note = str((req.body || {}).note, 'Reason', { required: false, max: 300 });
    tx(() => {
      restoreStock(o.id);
      db.prepare('UPDATE orders SET farmer_note = ? WHERE id = ?').run(note, o.id);
      setStatus(o.id, 'declined', note || 'Farmer declined the order');
    });
    res.json({ order: orderDto(loadOrder(o.id)) });
  });

  api.post('/orders/:id/cancel', requireRole('customer'), (req, res) => {
    const o = orderForUser(req, ['customer']);
    expectStatus(o, 'placed', 'awaiting_payment');
    tx(() => {
      restoreStock(o.id);
      setStatus(o.id, 'cancelled', 'Cancelled by customer');
    });
    res.json({ order: orderDto(loadOrder(o.id)) });
  });

  api.post('/orders/:id/pay', requireRole('customer'), async (req, res) => {
    const o = orderForUser(req, ['customer']);
    expectStatus(o, 'awaiting_payment');
    const b = req.body || {};
    const method = oneOf(b.method, Object.keys(payments.METHODS), 'payment method');
    const msisdn = payments.METHODS[method].mobile ? normalizePhone(b.msisdn) : null;

    const result = await payments.charge({ method, amount: o.total, msisdn, orderCode: o.code });

    // Re-check state after the (possibly slow) gateway call before recording.
    const outcome = tx(() => {
      db.prepare('INSERT INTO payments (order_id, method, msisdn, amount, reference, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(o.id, method, msisdn, o.total, result.reference, result.status, result.message || '');
      if (result.status !== 'success') return 'failed';
      const current = db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status;
      if (current !== 'awaiting_payment') return 'stale';
      db.prepare("UPDATE orders SET payment_method = ?, payment_ref = ?, paid_at = datetime('now') WHERE id = ?")
        .run(method, result.reference, o.id);
      setStatus(o.id, 'paid', `Paid with ${payments.METHODS[method].label} (ref ${result.reference})`);
      return 'ok';
    });
    if (outcome === 'failed') throw new HttpError(402, result.message || 'Payment failed');
    if (outcome === 'stale') throw new HttpError(409, 'This order changed while paying. The payment has been recorded; contact support for a refund.');
    res.json({ order: orderDto(loadOrder(o.id)) });
  });

  api.post('/orders/:id/dispatch', farmer, (req, res) => {
    const o = orderForUser(req, ['farmer']);
    expectStatus(o, 'paid');
    setStatus(o.id, 'out_for_delivery', str((req.body || {}).note, 'Note', { required: false, max: 300 }) || 'Farmer is on the way');
    res.json({ order: orderDto(loadOrder(o.id)) });
  });

  api.post('/orders/:id/deliver', farmer, (req, res) => {
    const o = orderForUser(req, ['farmer']);
    expectStatus(o, 'out_for_delivery');
    setStatus(o.id, 'delivered', 'Delivered to customer');
    res.json({ order: orderDto(loadOrder(o.id)) });
  });

  // ---- Admin --------------------------------------------------------------
  const admin = requireRole('admin');

  api.get('/admin/summary', admin, (_req, res) => {
    const users = Object.fromEntries(db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all().map((r) => [r.role, r.n]));
    const orders = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map((r) => [r.status, r.n]));
    const totals = db.prepare(`SELECT COALESCE(SUM(total), 0) AS gmv, COALESCE(SUM(service_fee), 0) AS fees
      FROM orders WHERE status IN ('paid','out_for_delivery','delivered')`).get();
    const listings = db.prepare('SELECT COUNT(*) AS n FROM products WHERE deleted = 0 AND active = 1').get().n;
    res.json({ users, orders, gmv: totals.gmv, serviceFees: totals.fees, listings, serviceFeePercent: serviceFeePercent() });
  });

  api.get('/admin/users', admin, (_req, res) => {
    res.json({ users: db.prepare('SELECT * FROM users ORDER BY id DESC').all().map(auth.publicUser) });
  });

  api.patch('/admin/users/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw bad('You cannot suspend your own account');
    const r = db.prepare('UPDATE users SET active = ? WHERE id = ?').run((req.body || {}).active ? 1 : 0, id);
    if (!r.changes) throw new HttpError(404, 'User not found');
    if (!(req.body || {}).active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    res.json({ user: auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  });

  api.patch('/admin/settings', admin, (req, res) => {
    const v = Number((req.body || {}).serviceFeePercent);
    if (!Number.isFinite(v) || v < 0 || v > 50) throw bad('Service fee must be between 0 and 50 percent');
    setSetting('service_fee_percent', Math.round(v * 100) / 100);
    res.json({ serviceFeePercent: serviceFeePercent() });
  });

  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // ---- Static files & SPA fallback ---------------------------------------
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // ---- Errors -------------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message });
  });

  return app;
}

// Creates the admin account on first start.
function ensureAdmin() {
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return;
  const phone = normalizePhone(process.env.ADMIN_PHONE || '+23299000000');
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (role, name, phone, password_hash, district) VALUES ('admin', 'Administrator', ?, ?, 'Western Area Urban')")
    .run(phone, auth.hashPassword(password));
  console.log('\n  Admin account created');
  console.log(`    phone:    ${phone}`);
  console.log(`    password: ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : password}`);
  console.log('  Save this password now; it will not be shown again.\n');
}

module.exports = { createApp, ensureAdmin, normalizePhone };

if (require.main === module) {
  ensureAdmin();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`Salone Fresh Harvest running at http://localhost:${port}`);
    console.log(`Payments: ${payments.mode()} mode, service fee ${serviceFeePercent()}%`);
  });
}
