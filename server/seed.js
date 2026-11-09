'use strict';

// Loads demo farmers, a demo customer and sample produce so the portal can be
// tried end to end. Safe to run more than once: it skips existing accounts.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, UPLOAD_DIR } = require('./db');
const { hashPassword } = require('./auth');
const { ensureAdmin } = require('./index');

const PASSWORD = 'harvest123';

const farmers = [
  { name: 'Aminata Kamara', phone: '+23276111111', farm: 'Kamara Family Farm', district: 'Bo', fee: 40 },
  { name: 'Mohamed Sesay', phone: '+23277222222', farm: 'Sesay Rice Growers', district: 'Bombali', fee: 60 },
  { name: 'Fatmata Koroma', phone: '+23278333333', farm: 'Waterloo Greens', district: 'Western Area Rural', fee: 25 },
];

const products = [
  [0, 'Cassava', 'Roots & tubers', 'bag (50kg)', 450, 20, 'Freshly harvested sweet cassava.'],
  [0, 'Sweet potatoes', 'Roots & tubers', 'basket', 120, 30, 'Orange-flesh sweet potatoes.'],
  [0, 'Palm oil', 'Palm oil & oils', 'gallon', 180, 40, 'Red palm oil, pressed this week.'],
  [0, 'Groundnuts', 'Legumes & nuts', 'kg', 35, 100, 'Shelled, sun-dried groundnuts.'],
  [1, 'Local rice (parboiled)', 'Rice & grains', 'bag (50kg)', 950, 25, 'Bombali upland rice, parboiled and cleaned.'],
  [1, 'Local rice (white)', 'Rice & grains', 'bag (25kg)', 480, 18, 'Milled white rice.'],
  [1, 'Hot pepper', 'Spices & peppers', 'kg', 60, 15, 'Fresh scotch bonnet peppers.'],
  [2, 'Cassava leaves', 'Vegetables', 'bunch', 10, 80, 'Picked this morning, ready to pound.'],
  [2, 'Potato leaves', 'Vegetables', 'bunch', 10, 60, 'Tender potato leaves.'],
  [2, 'Tomatoes', 'Vegetables', 'basket', 150, 12, 'Ripe tomatoes for stew and salad.'],
  [2, 'Garden eggs', 'Vegetables', 'kg', 40, 25, 'Firm local garden eggs.'],
  [2, 'Pineapples', 'Fruits', 'piece', 25, 50, 'Sweet pineapples.'],
];

// Demo photos in server/seed-images, keyed by product name. They are copied
// into the uploads folder under a content-hash name so they pass the same
// validation as farmer uploads.
const PHOTOS = {
  'Cassava': 'cassava.jpg',
  'Cassava leaves': 'cassava-leaves.jpg',
  'Hot pepper': 'hot-pepper.jpg',
};
function photoUrl(productName) {
  const file = PHOTOS[productName];
  if (!file) return null;
  const buf = fs.readFileSync(path.join(__dirname, 'seed-images', file));
  const name = `${crypto.createHash('md5').update(buf).digest('hex')}.jpg`;
  const dest = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  return `/uploads/${name}`;
}

ensureAdmin();

const insUser = db.prepare(`INSERT INTO users (role, name, phone, password_hash, district, farm_name, delivery_fee)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const ids = farmers.map((f) => {
  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(f.phone);
  if (existing) return existing.id;
  return Number(insUser.run('farmer', f.name, f.phone, hashPassword(PASSWORD), f.district, f.farm, f.fee * 100).lastInsertRowid);
});

if (!db.prepare('SELECT 1 FROM users WHERE phone = ?').get('+23279444444')) {
  db.prepare(`INSERT INTO users (role, name, phone, password_hash, district, address) VALUES ('customer', ?, ?, ?, ?, ?)`)
    .run('Ibrahim Conteh', '+23279444444', hashPassword(PASSWORD), 'Western Area Urban', '12 Wilkinson Road, Freetown');
}

const insProduct = db.prepare(`INSERT INTO products (farmer_id, name, category, unit, price, quantity, district, description, image)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
let added = 0;
for (const [fi, name, cat, unit, price, qty, desc] of products) {
  const image = photoUrl(name);
  const existing = db.prepare('SELECT id, image FROM products WHERE farmer_id = ? AND name = ?').get(ids[fi], name);
  if (existing) {
    // Give earlier demo listings their photo, without replacing one a farmer chose.
    if (image && !existing.image) db.prepare('UPDATE products SET image = ? WHERE id = ?').run(image, existing.id);
    continue;
  }
  insProduct.run(ids[fi], name, cat, unit, price * 100, qty, farmers[fi].district, desc, image);
  added += 1;
}

console.log(`Seeded ${added} products.`);
console.log(`Demo farmer:   076 111111 / ${PASSWORD}`);
console.log(`Demo customer: 079 444444 / ${PASSWORD}`);
