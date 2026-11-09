// Salone Fresh Harvest — single-page client (no build step).

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');

const state = { me: null, meta: null, cart: loadCart() };

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const money = (minor) => `SLe ${((minor || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const leones = (minor) => ((minor || 0) / 100).toFixed(2).replace(/\.00$/, '');
const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const localPhone = (p) => (p || '').replace(/^\+232(\d{2})(\d{6})$/, '0$1 $2');
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];
const formData = (form) => Object.fromEntries(new FormData(form).entries());

const EMOJI = {
  'Vegetables': '🥬', 'Fruits': '🍍', 'Rice & grains': '🌾', 'Roots & tubers': '🍠', 'Legumes & nuts': '🥜',
  'Palm oil & oils': '🌴', 'Poultry & eggs': '🥚', 'Livestock': '🐐', 'Fish': '🐟', 'Spices & peppers': '🌶️',
};
const thumb = (p) => `<div class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">` : `<span aria-hidden="true">${EMOJI[p.category] || '🧺'}</span>`}</div>`;
const pill = (o) => `<span class="pill ${esc(o.status)}">${esc(o.statusLabel)}</span>`;
const options = (list, selected, placeholder) =>
  (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
  list.map((v) => `<option ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');

let toastTimer;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 3500);
}

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Wraps a form submit: disables the button, shows errors as a toast.
function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try { await handler(formData(form), form); } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
  });
}

async function act(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
}

const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

// ---------------------------------------------------------------------------
// Basket (stored on this device)
// ---------------------------------------------------------------------------

function loadCart() {
  try { return JSON.parse(localStorage.getItem('sfh_cart')) || []; } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem('sfh_cart', JSON.stringify(state.cart)); } catch { /* storage unavailable */ }
  renderNav();
}
function addToCart(p, qty) {
  const line = state.cart.find((l) => l.productId === p.id);
  const next = Math.min((line ? line.quantity : 0) + qty, p.quantity);
  if (line) Object.assign(line, { quantity: next, price: p.price, max: p.quantity });
  else state.cart.push({ productId: p.id, quantity: next, name: p.name, unit: p.unit, price: p.price, max: p.quantity, farmerId: p.farmerId, farmName: p.farmName, image: p.image, category: p.category });
  saveCart();
}
const cartCount = () => state.cart.reduce((s, l) => s + l.quantity, 0);
const cartSubtotal = () => state.cart.reduce((s, l) => s + l.price * l.quantity, 0);

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function renderNav() {
  const me = state.me;
  const here = location.hash || '#/';
  const link = (href, label) => `<a href="${href}" class="${here === href || (href !== '#/' && here.startsWith(href)) ? 'active' : ''}">${label}</a>`;
  let html = link('#/', 'Shop');
  if (!me || me.role === 'customer') html += link('#/basket', `Basket${cartCount() ? `<span class="badge">${cartCount()}</span>` : ''}`);
  if (me?.role === 'customer') html += link('#/orders', 'My orders') + link('#/account', 'Account');
  if (me?.role === 'farmer') html += link('#/farmer', 'Farm dashboard');
  if (me?.role === 'admin') html += link('#/admin', 'Admin');
  html += me ? '<button type="button" id="logout">Log out</button>' : link('#/login', 'Log in') + link('#/register', 'Sign up');
  nav.innerHTML = html;
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = async () => { await api('POST', '/auth/logout', {}); state.me = null; toast('Logged out'); go('#/'); };
}

function needLogin(role) {
  if (!state.me) { sessionStorage.setItem('sfh_after_login', location.hash); go('#/login'); return true; }
  if (role && state.me.role !== role) { app.innerHTML = `<div class="empty"><div class="icon">🔒</div><p>This page is for ${esc(role)} accounts.</p></div>`; return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function viewHome() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '', category = params.get('category') || '', district = params.get('district') || '', sort = params.get('sort') || '';
  const showHero = !q && !category && !district && !sort;
  app.innerHTML = `
    ${showHero ? `
    <section class="hero">
      <div class="eyebrow">Agriculture and technology · Sierra Leone</div>
      <h1>Fresh produce, straight from the farmer</h1>
      <p>Browse what farmers across Sierra Leone are harvesting, order and pay online, and the farmer delivers to your door.</p>
      <div class="steps">
        <div class="step"><b>1</b>Farmers list produce, quantities and prices</div>
        <div class="step"><b>2</b>You order and pay on web or mobile</div>
        <div class="step"><b>3</b>The farmer delivers your order</div>
        <div class="step"><b>4</b>Fresh at your door, from the source</div>
      </div>
      ${!state.me ? '<div class="row" style="margin-top:20px"><a class="btn accent" href="#/register/farmer">Sell your produce</a><a class="btn ghost" href="#/register">Create a buyer account</a></div>' : ''}
    </section>` : ''}
    <form class="filters" id="filters" role="search">
      <input class="search" name="q" type="search" placeholder="Search produce or farm…" value="${esc(q)}" aria-label="Search">
      <select name="category" aria-label="Category">${options(state.meta.categories, category, 'All categories')}</select>
      <select name="district" aria-label="District">${options(state.meta.districts, district, 'All districts')}</select>
      <select name="sort" aria-label="Sort">
        <option value="">Newest</option>
        <option value="price_asc" ${sort === 'price_asc' ? 'selected' : ''}>Price: low to high</option>
        <option value="price_desc" ${sort === 'price_desc' ? 'selected' : ''}>Price: high to low</option>
      </select>
    </form>
    <div id="grid"><div class="spinner">Loading produce…</div></div>`;

  const form = $('#filters');
  const apply = () => {
    const p = new URLSearchParams(Object.entries(formData(form)).filter(([, v]) => v));
    location.hash = `#/${p.toString() ? '?' + p : ''}`;
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  $$('select', form).forEach((s) => s.addEventListener('change', apply));

  const { products } = await api('GET', `/products?${new URLSearchParams({ q, category, district, sort })}`);
  $('#grid').innerHTML = products.length ? `<div class="products">${products.map((p) => `
    <a class="product" href="#/product/${p.id}">
      ${thumb(p)}
      <div class="body">
        <div class="name">${esc(p.name)}</div>
        <div class="meta">${esc(p.farmName)} · ${esc(p.district)}</div>
        <div class="price">${money(p.price)} <span class="muted small">/ ${esc(p.unit)}</span></div>
      </div>
    </a>`).join('')}</div>`
    : '<div class="empty"><div class="icon">🌱</div><p>No produce matches your search yet.</p></div>';
}

async function viewProduct(id) {
  const { product: p } = await api('GET', `/products/${id}`);
  const canBuy = !state.me || state.me.role === 'customer';
  app.innerHTML = `
    <p><a href="#/">← Back to shop</a></p>
    <div class="detail">
      ${thumb(p)}
      <div class="stack">
        <div>
          <div class="muted">${esc(p.category)}</div>
          <h1>${esc(p.name)}</h1>
          <div class="big-price">${money(p.price)} <span class="muted small">per ${esc(p.unit)}</span></div>
        </div>
        ${p.description ? `<p>${esc(p.description)}</p>` : ''}
        <div class="card small">
          <div><b>Farm:</b> <a href="#/?q=${encodeURIComponent(p.farmName)}">${esc(p.farmName)}</a> (${esc(p.farmerName)})</div>
          <div><b>District:</b> ${esc(p.district)}</div>
          ${p.harvestDate ? `<div><b>Harvested:</b> ${esc(p.harvestDate)}</div>` : ''}
          <div><b>Available:</b> ${p.quantity} ${esc(p.unit)}</div>
        </div>
        ${canBuy && p.quantity > 0 ? `
          <form id="add" class="row">
            <div class="qty">
              <button type="button" data-step="-1" aria-label="Less">−</button>
              <input name="qty" type="number" min="1" max="${p.quantity}" value="1" inputmode="numeric" aria-label="Quantity">
              <button type="button" data-step="1" aria-label="More">+</button>
            </div>
            <button class="btn accent" type="submit">Add to basket</button>
          </form>` : ''}
        ${p.quantity === 0 ? '<div class="notice">Sold out for now.</div>' : ''}
      </div>
    </div>`;
  const form = $('#add');
  if (!form) return;
  const input = form.qty;
  $$('[data-step]', form).forEach((b) => b.addEventListener('click', () => {
    input.value = Math.max(1, Math.min(p.quantity, Number(input.value || 1) + Number(b.dataset.step)));
  }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const qty = Math.max(1, Math.min(p.quantity, Math.floor(Number(input.value) || 1)));
    addToCart(p, qty);
    toast(`Added ${qty} ${p.unit} of ${p.name} to your basket`);
  });
}

function viewBasket() {
  if (state.me && state.me.role !== 'customer') { app.innerHTML = '<div class="empty"><p>Only buyer accounts can order produce.</p></div>'; return; }
  if (!state.cart.length) {
    app.innerHTML = '<div class="empty"><div class="icon">🧺</div><p>Your basket is empty.</p><a class="btn" href="#/">Browse produce</a></div>';
    return;
  }
  const farms = [...new Set(state.cart.map((l) => l.farmerId))];
  const pct = state.meta.serviceFeePercent;
  app.innerHTML = `
    <div class="page-head"><h1>Your basket</h1></div>
    <div class="grid-2">
      <div class="card table-wrap">
        <table>
          <thead><tr><th>Produce</th><th>Qty</th><th class="num">Total</th><th></th></tr></thead>
          <tbody>${state.cart.map((l, i) => `
            <tr>
              <td><a href="#/product/${l.productId}">${esc(l.name)}</a><div class="muted small">${esc(l.farmName)} · ${money(l.price)} / ${esc(l.unit)}</div></td>
              <td><input type="number" min="1" max="${l.max}" value="${l.quantity}" data-i="${i}" class="qty-in" style="width:80px" aria-label="Quantity of ${esc(l.name)}"></td>
              <td class="num">${money(l.price * l.quantity)}</td>
              <td><button class="btn danger sm" data-remove="${i}" aria-label="Remove ${esc(l.name)}">✕</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="card stack">
        <h2>Summary</h2>
        <div class="row between"><span>Produce</span><b>${money(cartSubtotal())}</b></div>
        <div class="row between"><span>Service fee (${pct}%)</span><b>${money(Math.round(cartSubtotal() * pct / 100))}</b></div>
        <div class="row between muted"><span>Delivery</span><span>Set by each farmer</span></div>
        ${farms.length > 1 ? `<div class="notice">Your basket has produce from ${farms.length} farms. Each farm confirms, delivers and is paid separately, so you will get ${farms.length} orders.</div>` : ''}
        <a class="btn accent block" href="#/checkout">Continue to checkout</a>
      </div>
    </div>`;
  $$('.qty-in').forEach((inp) => inp.addEventListener('change', () => {
    const l = state.cart[inp.dataset.i];
    l.quantity = Math.max(1, Math.min(l.max, Math.floor(Number(inp.value) || 1)));
    saveCart(); viewBasket();
  }));
  $$('[data-remove]').forEach((b) => b.addEventListener('click', () => { state.cart.splice(Number(b.dataset.remove), 1); saveCart(); viewBasket(); }));
}

function viewCheckout() {
  if (needLogin('customer')) return;
  if (!state.cart.length) { go('#/basket'); return; }
  const me = state.me;
  app.innerHTML = `
    <div class="page-head"><h1>Checkout</h1></div>
    <div class="grid-2">
      <form id="checkout" class="card">
        <h2>Delivery details</h2>
        <div class="field"><label for="addr">Delivery address</label><textarea id="addr" name="deliveryAddress" required minlength="5" maxlength="200" placeholder="House number, street, nearest landmark">${esc(me.address)}</textarea></div>
        <div class="form-grid">
          <div class="field"><label for="dd">District</label><select id="dd" name="deliveryDistrict" required>${options(state.meta.districts, me.district)}</select></div>
          <div class="field"><label for="dp">Phone for delivery</label><input id="dp" name="deliveryPhone" type="tel" required value="${esc(localPhone(me.phone))}"></div>
        </div>
        <div class="field"><label for="nt">Notes for the farmer (optional)</label><textarea id="nt" name="notes" maxlength="500" placeholder="Best time to deliver, gate colour…"></textarea></div>
        <p class="muted small">You do not pay yet. Each farmer first confirms your order and sets the delivery charge, then you pay from <b>My orders</b>.</p>
        <button class="btn accent block" type="submit">Place order</button>
      </form>
      <div class="card">
        <h2>Order summary</h2>
        <table><tbody>
          ${state.cart.map((l) => `<tr><td>${esc(l.name)} × ${l.quantity}<div class="muted small">${esc(l.farmName)}</div></td><td class="num">${money(l.price * l.quantity)}</td></tr>`).join('')}
          <tr class="total"><td>Produce subtotal</td><td class="num">${money(cartSubtotal())}</td></tr>
        </tbody></table>
      </div>
    </div>`;
  onSubmit($('#checkout'), async (data) => {
    const { orders } = await api('POST', '/orders', { ...data, items: state.cart.map((l) => ({ productId: l.productId, quantity: l.quantity })) });
    if (data.deliveryAddress && !me.address) api('PATCH', '/me', { address: data.deliveryAddress }).then((r) => { state.me = r.user; }).catch(() => {});
    state.cart = []; saveCart();
    toast(orders.length > 1 ? `${orders.length} orders placed` : `Order ${orders[0].code} placed`);
    go(orders.length === 1 ? `#/orders/${orders[0].id}` : '#/orders');
  });
}

function viewLogin() {
  if (state.me) { go(homeFor(state.me)); return; }
  app.innerHTML = `
    <div style="max-width:420px;margin:0 auto">
      <form id="login" class="card">
        <h1>Log in</h1>
        <div class="field"><label for="ph">Phone number</label><input id="ph" name="phone" type="tel" autocomplete="tel" required placeholder="076 123456"></div>
        <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn block" type="submit">Log in</button>
        <p class="muted small" style="margin-bottom:0">New here? <a href="#/register">Create a buyer account</a> or <a href="#/register/farmer">sell as a farmer</a>.</p>
      </form>
    </div>`;
  onSubmit($('#login'), async (data) => {
    const { user } = await api('POST', '/auth/login', data);
    state.me = user;
    toast(`Welcome back, ${user.name.split(' ')[0]}`);
    const next = sessionStorage.getItem('sfh_after_login');
    sessionStorage.removeItem('sfh_after_login');
    go(next || homeFor(user));
  });
}

const homeFor = (u) => (u.role === 'farmer' ? '#/farmer' : u.role === 'admin' ? '#/admin' : '#/');

function viewRegister(roleParam) {
  if (state.me) { go(homeFor(state.me)); return; }
  const role = roleParam === 'farmer' ? 'farmer' : 'customer';
  app.innerHTML = `
    <div style="max-width:560px;margin:0 auto">
      <form id="reg" class="card">
        <h1>Create an account</h1>
        <div class="segmented" role="radiogroup" aria-label="Account type">
          <label><input type="radio" name="role" value="customer" ${role === 'customer' ? 'checked' : ''}>I want to buy</label>
          <label><input type="radio" name="role" value="farmer" ${role === 'farmer' ? 'checked' : ''}>I am a farmer</label>
        </div>
        <div class="field"><label for="nm">Full name</label><input id="nm" name="name" required minlength="2" maxlength="80" autocomplete="name"></div>
        <div class="field farm-only"><label for="fm">Farm or group name</label><input id="fm" name="farmName" maxlength="80"></div>
        <div class="form-grid">
          <div class="field"><label for="ph">Phone number</label><input id="ph" name="phone" type="tel" required placeholder="076 123456" autocomplete="tel"></div>
          <div class="field"><label for="ds">District</label><select id="ds" name="district" required>${options(state.meta.districts, '', 'Choose district')}</select></div>
        </div>
        <div class="field"><label for="em">Email (optional)</label><input id="em" name="email" type="email" autocomplete="email"></div>
        <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" required minlength="8" autocomplete="new-password"><div class="hint">At least 8 characters.</div></div>
        <button class="btn accent block" type="submit">Create account</button>
        <p class="muted small" style="margin-bottom:0">Already registered? <a href="#/login">Log in</a></p>
      </form>
    </div>`;
  const form = $('#reg');
  const sync = () => {
    const isFarmer = form.role.value === 'farmer';
    $('.farm-only').classList.toggle('hidden', !isFarmer);
    form.farmName.required = isFarmer;
  };
  $$('input[name=role]', form).forEach((r) => r.addEventListener('change', sync));
  sync();
  onSubmit(form, async (data) => {
    const { user } = await api('POST', '/auth/register', data);
    state.me = user;
    toast('Account created');
    go(user.role === 'farmer' ? '#/farmer/listings/new' : (sessionStorage.getItem('sfh_after_login') || '#/'));
  });
}

// ---- Orders (shared by customers, farmers and admin) ----------------------

function orderSummaryCard(o, href) {
  const who = state.me.role === 'farmer' ? `${esc(o.customerName)} · ${esc(o.deliveryDistrict)}` : esc(o.farmName);
  return `
    <a class="card order-card" href="${href}" style="text-decoration:none;color:inherit">
      <div class="row between"><b>${esc(o.code)}</b>${pill(o)}</div>
      <div class="muted small">${who} · ${fmtDate(o.createdAt)}</div>
      <div class="small">${o.items.map((i) => `${esc(i.name)} × ${i.quantity}`).join(', ')}</div>
      <div class="row between"><span class="muted small">${o.total != null ? 'Total' : 'Produce subtotal'}</span><b>${money(o.total ?? o.subtotal)}</b></div>
    </a>`;
}

async function viewOrders() {
  if (needLogin('customer')) return;
  const { orders } = await api('GET', '/orders');
  app.innerHTML = `
    <div class="page-head"><h1>My orders</h1></div>
    ${orders.length ? orders.map((o) => orderSummaryCard(o, `#/orders/${o.id}`)).join('') : '<div class="empty"><div class="icon">📦</div><p>No orders yet.</p><a class="btn" href="#/">Start shopping</a></div>'}`;
}

function orderBreakdown(o) {
  return `
    <table>
      <thead><tr><th>Produce</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
      <tbody>
        ${o.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.quantity} ${esc(i.unit)}</td><td class="num">${money(i.unitPrice)}</td><td class="num">${money(i.lineTotal)}</td></tr>`).join('')}
        <tr><td colspan="3">Produce subtotal</td><td class="num">${money(o.subtotal)}</td></tr>
        <tr><td colspan="3">Delivery charge</td><td class="num">${o.deliveryFee != null ? money(o.deliveryFee) : '<span class="muted">to be set by farmer</span>'}</td></tr>
        <tr><td colspan="3">Service fee (${o.serviceFeePercent}%)</td><td class="num">${money(o.serviceFee)}</td></tr>
        ${o.total != null ? `<tr class="total"><td colspan="3">Total</td><td class="num">${money(o.total)}</td></tr>` : ''}
      </tbody>
    </table>`;
}

function orderTimeline(o) {
  return `<ul class="timeline">${o.events.map((e) => `<li><b>${esc(state.meta.statuses[e.status] || e.status)}</b><div class="muted small">${fmtDate(e.at)}${e.note ? ' · ' + esc(e.note) : ''}</div></li>`).join('')}</ul>`;
}

async function viewOrder(id) {
  if (needLogin()) return;
  const { order: o } = await api('GET', `/orders/${id}`);
  const me = state.me;
  const back = me.role === 'farmer' ? '#/farmer/orders' : me.role === 'admin' ? '#/admin/orders' : '#/orders';

  let actions = '';
  if (me.role === 'customer') {
    if (o.status === 'placed') actions = '<div class="notice">The farmer has been notified and will confirm the order and delivery charge. You can pay once they confirm.</div>';
    if (o.status === 'awaiting_payment') {
      actions = `
        <form id="pay" class="stack">
          <h2>Pay ${money(o.total)}</h2>
          ${o.farmerNote ? `<div class="notice"><b>Farmer's note:</b> ${esc(o.farmerNote)}</div>` : ''}
          <div class="field"><label for="pm">Payment method</label><select id="pm" name="method">${state.meta.paymentMethods.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('')}</select></div>
          <div class="field" id="msisdn-f"><label for="ms">Mobile money number</label><input id="ms" name="msisdn" type="tel" value="${esc(localPhone(me.phone))}"><div class="hint">You will approve the payment on your phone.</div></div>
          ${state.meta.paymentMode === 'simulated' ? '<div class="hint">Test mode: payments are simulated and no money moves. A number ending in 0000 simulates a declined payment.</div>' : ''}
          <button class="btn accent block" type="submit">Pay now</button>
        </form>`;
    }
    if (['placed', 'awaiting_payment'].includes(o.status)) actions += '<button class="btn danger block" id="cancel" type="button" style="margin-top:12px">Cancel order</button>';
    if (o.status === 'paid') actions = '<div class="notice">Payment received. The farmer is preparing your delivery.</div>';
    if (o.status === 'out_for_delivery') actions = `<div class="notice">Your order is on the way. Farmer's phone: <a href="tel:${esc(o.farmerPhone)}">${esc(localPhone(o.farmerPhone))}</a></div>`;
  }
  if (me.role === 'farmer') {
    if (o.status === 'placed') {
      actions = `
        <form id="confirm" class="stack">
          <h2>Confirm this order</h2>
          <div class="field"><label for="df">Delivery charge (SLe)</label><input id="df" name="deliveryFee" type="number" min="0" step="0.5" required value="${leones(me.deliveryFee)}"><div class="hint">Your default is set in Profile. Adjust for this delivery's distance.</div></div>
          <div class="field"><label for="fn">Note to customer (optional)</label><input id="fn" name="note" maxlength="300" placeholder="e.g. Delivery on Saturday morning"></div>
          <button class="btn accent block" type="submit">Confirm and request payment</button>
        </form>`;
    }
    if (['placed', 'awaiting_payment'].includes(o.status)) actions += '<button class="btn danger block" id="decline" type="button" style="margin-top:12px">Decline order</button>';
    if (o.status === 'awaiting_payment') actions = '<div class="notice">Waiting for the customer to pay. Do not deliver until the order shows Paid.</div>' + actions;
    if (o.status === 'paid') actions = '<button class="btn accent block" id="dispatch" type="button">Mark as out for delivery</button>';
    if (o.status === 'out_for_delivery') actions = '<button class="btn accent block" id="deliver" type="button">Mark as delivered</button>';
  }

  app.innerHTML = `
    <p><a href="${back}">← Back to orders</a></p>
    <div class="page-head"><h1>Order ${esc(o.code)}</h1>${pill(o)}</div>
    <div class="grid-2">
      <div class="stack">
        <div class="card table-wrap">${orderBreakdown(o)}</div>
        <div class="card"><h3>Progress</h3>${orderTimeline(o)}</div>
      </div>
      <div class="stack">
        ${actions ? `<div class="card">${actions}</div>` : ''}
        <div class="card small stack">
          <div><b>Farm:</b> ${esc(o.farmName)} (${esc(o.farmerName)})</div>
          <div><b>Customer:</b> ${esc(o.customerName)}</div>
          <div><b>Deliver to:</b> ${esc(o.deliveryAddress)}, ${esc(o.deliveryDistrict)}</div>
          <div><b>Delivery phone:</b> <a href="tel:${esc(o.deliveryPhone)}">${esc(localPhone(o.deliveryPhone))}</a></div>
          ${o.notes ? `<div><b>Customer notes:</b> ${esc(o.notes)}</div>` : ''}
          ${o.paymentRef ? `<div><b>Payment:</b> ${esc(o.paymentMethod)} · ref ${esc(o.paymentRef)}</div>` : ''}
        </div>
      </div>
    </div>`;

  const reload = () => viewOrder(id);
  const pay = $('#pay');
  if (pay) {
    const sync = () => $('#msisdn-f').classList.toggle('hidden', !state.meta.paymentMethods.find((m) => m.id === pay.method.value)?.mobile);
    pay.method.addEventListener('change', sync); sync();
    onSubmit(pay, async (d) => { await api('POST', `/orders/${id}/pay`, d); toast('Payment successful'); reload(); });
  }
  const confirm = $('#confirm');
  if (confirm) onSubmit(confirm, async (d) => { await api('POST', `/orders/${id}/confirm`, d); toast('Order confirmed. The customer can now pay.'); reload(); });
  const bind = (sel, url, msg, { ask, confirmText } = {}) => {
    const b = $(sel);
    if (b) b.addEventListener('click', () => {
      if (confirmText && !window.confirm(confirmText)) return;
      let body = {};
      if (ask) { const r = window.prompt(ask); if (r === null) return; body = { note: r }; }
      act(b, async () => { await api('POST', `/orders/${id}/${url}`, body); toast(msg); reload(); });
    });
  };
  bind('#cancel', 'cancel', 'Order cancelled', { confirmText: 'Cancel this order?' });
  bind('#decline', 'decline', 'Order declined', { ask: 'Reason for declining (optional):' });
  bind('#dispatch', 'dispatch', 'Marked as out for delivery');
  bind('#deliver', 'deliver', 'Marked as delivered');
}

// ---- Customer account ------------------------------------------------------

function profileForm(me) {
  return `
    <form id="profile" class="card" style="max-width:640px">
      <h2>Profile</h2>
      <div class="field"><label for="nm">Name</label><input id="nm" name="name" required value="${esc(me.name)}"></div>
      ${me.role === 'farmer' ? `
        <div class="field"><label for="fm">Farm name</label><input id="fm" name="farmName" required value="${esc(me.farmName)}"></div>
        <div class="field"><label for="df">Default delivery charge (SLe)</label><input id="df" name="deliveryFee" type="number" min="0" step="0.5" value="${leones(me.deliveryFee)}"><div class="hint">Pre-filled when you confirm an order; you can change it per order.</div></div>` : ''}
      <div class="form-grid">
        <div class="field"><label>Phone</label><input value="${esc(localPhone(me.phone))}" disabled></div>
        <div class="field"><label for="ds">District</label><select id="ds" name="district">${options(state.meta.districts, me.district)}</select></div>
      </div>
      <div class="field"><label for="em">Email</label><input id="em" name="email" type="email" value="${esc(me.email)}"></div>
      <div class="field"><label for="ad">${me.role === 'farmer' ? 'Farm location' : 'Default delivery address'}</label><input id="ad" name="address" value="${esc(me.address)}"></div>
      <details class="field"><summary>Change password</summary>
        <div class="form-grid" style="margin-top:10px">
          <div class="field"><label for="cp">Current password</label><input id="cp" name="currentPassword" type="password" autocomplete="current-password"></div>
          <div class="field"><label for="np">New password</label><input id="np" name="newPassword" type="password" minlength="8" autocomplete="new-password"></div>
        </div>
      </details>
      <button class="btn" type="submit">Save changes</button>
    </form>`;
}

function bindProfile() {
  onSubmit($('#profile'), async (d, form) => {
    const { user } = await api('PATCH', '/me', d);
    state.me = user;
    form.currentPassword.value = ''; form.newPassword.value = '';
    toast('Saved');
  });
}

function viewAccount() {
  if (needLogin('customer')) return;
  app.innerHTML = `<div class="page-head"><h1>Account</h1></div>${profileForm(state.me)}`;
  bindProfile();
}

// ---- Farmer dashboard ------------------------------------------------------

function farmerTabs(active) {
  const t = (k, l) => `<a href="#/farmer/${k}" class="${active === k ? 'active' : ''}">${l}</a>`;
  return `<div class="tabs">${t('orders', 'Orders')}${t('listings', 'My produce')}${t('profile', 'Profile')}</div>`;
}

async function viewFarmer(tab = 'orders', sub) {
  if (needLogin('farmer')) return;
  if (tab === 'listings' && sub) return viewListingForm(sub === 'new' ? null : sub);
  const me = state.me;
  app.innerHTML = `<div class="page-head"><div><div class="muted">${esc(me.farmName)}</div><h1>Farm dashboard</h1></div><a class="btn accent" href="#/farmer/listings/new">+ List produce</a></div>
    <div id="stats"></div>${farmerTabs(tab)}<div id="tab"><div class="spinner">Loading…</div></div>`;

  api('GET', '/farmer/summary').then((s) => {
    const n = (k) => s.byStatus[k] || 0;
    $('#stats').innerHTML = `<div class="stats">
      <div class="stat"><div class="v">${n('placed')}</div><div class="k">New orders to confirm</div></div>
      <div class="stat"><div class="v">${n('paid')}</div><div class="k">Paid, ready to deliver</div></div>
      <div class="stat"><div class="v">${s.listings}</div><div class="k">Live listings${s.lowStock ? ` · ${s.lowStock} low stock` : ''}</div></div>
      <div class="stat"><div class="v">${money(s.earned)}</div><div class="k">Earned (paid orders)</div></div>
    </div>`;
  }).catch(() => {});

  const tabEl = $('#tab');
  if (tab === 'profile') { tabEl.innerHTML = profileForm(me); bindProfile(); return; }

  if (tab === 'listings') {
    const { products } = await api('GET', '/farmer/products');
    tabEl.innerHTML = products.length ? `<div class="card table-wrap"><table>
      <thead><tr><th>Produce</th><th class="num">Price</th><th class="num">In stock</th><th>Status</th><th></th></tr></thead>
      <tbody>${products.map((p) => `<tr>
        <td><b>${esc(p.name)}</b><div class="muted small">${esc(p.category)} · ${esc(p.district)}</div></td>
        <td class="num">${money(p.price)} / ${esc(p.unit)}</td>
        <td class="num">${p.quantity}${p.quantity <= 5 ? ' <span class="pill placed">low</span>' : ''}</td>
        <td>${p.active ? '<span class="pill delivered">Live</span>' : '<span class="pill off">Hidden</span>'}</td>
        <td class="right"><a class="btn ghost sm" href="#/farmer/listings/${p.id}">Edit</a></td>
      </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty"><div class="icon">🌱</div><p>You have not listed any produce yet.</p><a class="btn accent" href="#/farmer/listings/new">List your first produce</a></div>';
    return;
  }

  const status = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || '';
  const { orders } = await api('GET', `/orders${status ? `?status=${status}` : ''}`);
  const filters = ['', 'placed', 'awaiting_payment', 'paid', 'out_for_delivery', 'delivered']
    .map((s) => `<a class="btn ${s === status ? '' : 'ghost'} sm" href="#/farmer/orders${s ? `?status=${s}` : ''}">${s ? esc(state.meta.statuses[s]) : 'All'}</a>`).join('');
  tabEl.innerHTML = `<div class="row" style="margin-bottom:16px">${filters}</div>` +
    (orders.length ? orders.map((o) => orderSummaryCard(o, `#/farmer/order/${o.id}`)).join('') : '<div class="empty"><div class="icon">📦</div><p>No orders here yet.</p></div>');
}

async function viewListingForm(id) {
  const p = id ? (await api('GET', `/products/${id}`)).product : { district: state.me.district, active: true };
  app.innerHTML = `
    <p><a href="#/farmer/listings">← Back to my produce</a></p>
    <form id="listing" class="card" style="max-width:720px">
      <h1>${id ? 'Edit produce' : 'List produce'}</h1>
      <div class="field"><label for="nm">Produce name</label><input id="nm" name="name" required maxlength="80" value="${esc(p.name)}" placeholder="e.g. Cassava leaves"></div>
      <div class="form-grid">
        <div class="field"><label for="ct">Category</label><select id="ct" name="category" required>${options(state.meta.categories, p.category, 'Choose category')}</select></div>
        <div class="field"><label for="un">Sold per</label><input id="un" name="unit" list="units" required maxlength="30" value="${esc(p.unit)}" placeholder="kg, bag, bunch…"><datalist id="units">${state.meta.units.map((u) => `<option value="${esc(u)}">`).join('')}</datalist></div>
        <div class="field"><label for="pr">Price per unit (SLe)</label><input id="pr" name="price" type="number" min="0.01" step="0.01" required value="${p.price ? leones(p.price) : ''}"></div>
        <div class="field"><label for="qt">Quantity available</label><input id="qt" name="quantity" type="number" min="0" step="1" required value="${p.quantity ?? ''}"></div>
        <div class="field"><label for="ds">District</label><select id="ds" name="district" required>${options(state.meta.districts, p.district)}</select></div>
        <div class="field"><label for="hd">Harvest date (optional)</label><input id="hd" name="harvestDate" type="date" value="${esc(p.harvestDate)}"></div>
      </div>
      <div class="field"><label for="de">Description</label><textarea id="de" name="description" maxlength="1000" placeholder="Quality, variety, how it is packed…">${esc(p.description)}</textarea></div>
      <div class="field">
        <label for="im">Photo (optional)</label>
        <div class="row"><div id="preview" style="width:120px">${p.image ? `<img src="${esc(p.image)}" alt="" style="border-radius:8px">` : ''}</div><input id="im" type="file" accept="image/*" style="flex:1"></div>
        <input type="hidden" name="image" value="${esc(p.image)}">
      </div>
      <div class="field"><label><input type="checkbox" name="active" ${p.active ? 'checked' : ''} style="width:auto;min-height:0"> Show this produce in the shop</label></div>
      <div class="row between">
        <button class="btn accent" type="submit">${id ? 'Save changes' : 'Publish listing'}</button>
        ${id ? '<button class="btn danger" type="button" id="del">Delete listing</button>' : ''}
      </div>
    </form>`;
  const form = $('#listing');
  $('#im').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await shrinkImage(file);
      const { url } = await api('POST', '/uploads', { dataUrl });
      form.image.value = url;
      $('#preview').innerHTML = `<img src="${esc(url)}" alt="" style="border-radius:8px">`;
    } catch (err) { toast(err.message, true); }
  });
  onSubmit(form, async (d) => {
    const body = { ...d, active: form.active.checked, image: d.image || null };
    if (id) await api('PATCH', `/farmer/products/${id}`, body);
    else await api('POST', '/farmer/products', body);
    toast(id ? 'Listing updated' : 'Produce listed');
    go('#/farmer/listings');
  });
  const del = $('#del');
  if (del) del.addEventListener('click', () => {
    if (!window.confirm('Delete this listing? Existing orders are kept.')) return;
    act(del, async () => { await api('DELETE', `/farmer/products/${id}`); toast('Listing deleted'); go('#/farmer/listings'); });
  });
}

// Resizes a photo on the phone before upload to save mobile data.
function shrinkImage(file, max = 1000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

// ---- Admin -------------------------------------------------------------------

async function viewAdmin(tab = 'overview') {
  if (needLogin('admin')) return;
  const t = (k, l) => `<a href="#/admin/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`;
  app.innerHTML = `<div class="page-head"><h1>Administration</h1></div><div class="tabs">${t('overview', 'Overview')}${t('orders', 'Orders')}${t('users', 'Users')}</div><div id="tab"><div class="spinner">Loading…</div></div>`;
  const tabEl = $('#tab');

  if (tab === 'overview') {
    const s = await api('GET', '/admin/summary');
    const o = (k) => s.orders[k] || 0;
    tabEl.innerHTML = `
      <div class="stats">
        <div class="stat"><div class="v">${s.users.farmer || 0}</div><div class="k">Farmers</div></div>
        <div class="stat"><div class="v">${s.users.customer || 0}</div><div class="k">Customers</div></div>
        <div class="stat"><div class="v">${s.listings}</div><div class="k">Live listings</div></div>
        <div class="stat"><div class="v">${money(s.gmv)}</div><div class="k">Paid order value</div></div>
        <div class="stat"><div class="v">${money(s.serviceFees)}</div><div class="k">Service fees earned</div></div>
      </div>
      <div class="grid-2">
        <div class="card"><h2>Orders by status</h2><table><tbody>
          ${Object.entries(state.meta.statuses).map(([k, l]) => `<tr><td>${esc(l)}</td><td class="num">${o(k)}</td></tr>`).join('')}
        </tbody></table></div>
        <form id="fee" class="card">
          <h2>Service fee</h2>
          <p class="muted small">Percentage of produce value charged on each order. It applies to new orders only.</p>
          <div class="field"><label for="sf">Service fee (%)</label><input id="sf" name="serviceFeePercent" type="number" min="0" max="50" step="0.1" value="${s.serviceFeePercent}"></div>
          <button class="btn" type="submit">Save</button>
        </form>
      </div>`;
    onSubmit($('#fee'), async (d) => {
      const r = await api('PATCH', '/admin/settings', d);
      state.meta.serviceFeePercent = r.serviceFeePercent;
      toast(`Service fee set to ${r.serviceFeePercent}%`);
    });
    return;
  }

  if (tab === 'orders') {
    const { orders } = await api('GET', '/orders');
    tabEl.innerHTML = orders.length ? `<div class="card table-wrap"><table>
      <thead><tr><th>Order</th><th>Customer</th><th>Farm</th><th>Status</th><th class="num">Total</th><th>Placed</th></tr></thead>
      <tbody>${orders.map((o) => `<tr>
        <td><a href="#/admin/order/${o.id}">${esc(o.code)}</a></td><td>${esc(o.customerName)}</td><td>${esc(o.farmName)}</td>
        <td>${pill(o)}</td><td class="num">${money(o.total ?? o.subtotal)}</td><td class="small">${fmtDate(o.createdAt)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty"><p>No orders yet.</p></div>';
    return;
  }

  const { users } = await api('GET', '/admin/users');
  tabEl.innerHTML = `<div class="card table-wrap"><table>
    <thead><tr><th>Name</th><th>Type</th><th>Phone</th><th>District</th><th>Joined</th><th>Status</th><th></th></tr></thead>
    <tbody>${users.map((u) => `<tr>
      <td><b>${esc(u.name)}</b>${u.farmName ? `<div class="muted small">${esc(u.farmName)}</div>` : ''}</td>
      <td>${esc(u.role)}</td><td>${esc(localPhone(u.phone))}</td><td>${esc(u.district)}</td><td class="small">${fmtDate(u.createdAt)}</td>
      <td>${u.active ? '<span class="pill delivered">Active</span>' : '<span class="pill cancelled">Suspended</span>'}</td>
      <td class="right">${u.id === state.me.id ? '' : `<button class="btn ${u.active ? 'danger' : 'ghost'} sm" data-user="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Suspend' : 'Reactivate'}</button>`}</td>
    </tr>`).join('')}</tbody></table></div>`;
  $$('[data-user]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
    await api('PATCH', `/admin/users/${b.dataset.user}`, { active: b.dataset.active === '1' });
    toast('User updated'); viewAdmin('users');
  })));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function render() {
  renderNav();
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const [a, b, c] = path.split('/').filter(Boolean);
  try {
    if (!a) await viewHome();
    else if (a === 'product' && b) await viewProduct(b);
    else if (a === 'basket') viewBasket();
    else if (a === 'checkout') viewCheckout();
    else if (a === 'login') viewLogin();
    else if (a === 'register') viewRegister(b);
    else if (a === 'orders' && b) await viewOrder(b);
    else if (a === 'orders') await viewOrders();
    else if (a === 'account') viewAccount();
    else if (a === 'farmer' && b === 'order' && c) await viewOrder(c);
    else if (a === 'farmer') await viewFarmer(b || 'orders', c);
    else if (a === 'admin' && b === 'order' && c) await viewOrder(c);
    else if (a === 'admin') await viewAdmin(b || 'overview');
    else app.innerHTML = '<div class="empty"><div class="icon">🧭</div><p>Page not found.</p><a class="btn" href="#/">Go to shop</a></div>';
  } catch (err) {
    if (err.status === 401) { state.me = null; sessionStorage.setItem('sfh_after_login', location.hash); go('#/login'); return; }
    app.innerHTML = `<div class="empty"><div class="icon">⚠️</div><p>${esc(err.message)}</p><a class="btn" href="#/">Go to shop</a></div>`;
  }
  renderNav();
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

(async function start() {
  try {
    const [meta, me] = await Promise.all([api('GET', '/meta'), api('GET', '/auth/me')]);
    state.meta = meta;
    state.me = me.user;
  } catch {
    app.innerHTML = '<div class="empty"><div class="icon">📡</div><p>Cannot reach the server. Check your connection and refresh.</p></div>';
    return;
  }
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
