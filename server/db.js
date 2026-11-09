'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'sfh.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('farmer','customer','admin')),
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT NOT NULL,
  district      TEXT,
  farm_name     TEXT,
  address       TEXT,
  delivery_fee  INTEGER NOT NULL DEFAULT 0,   -- farmer's default delivery charge, minor units (cents of SLe)
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY,
  farmer_id    INTEGER NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  unit         TEXT NOT NULL,
  price        INTEGER NOT NULL CHECK (price > 0),       -- minor units per unit
  quantity     INTEGER NOT NULL CHECK (quantity >= 0),   -- units in stock
  district     TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  image        TEXT,
  harvest_date TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  customer_id         INTEGER NOT NULL REFERENCES users(id),
  farmer_id           INTEGER NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL,
  subtotal            INTEGER NOT NULL,
  delivery_fee        INTEGER,
  service_fee_percent REAL NOT NULL,
  service_fee         INTEGER NOT NULL,
  total               INTEGER,
  delivery_address    TEXT NOT NULL,
  delivery_district   TEXT NOT NULL,
  delivery_phone      TEXT NOT NULL,
  notes               TEXT NOT NULL DEFAULT '',
  farmer_note         TEXT NOT NULL DEFAULT '',
  payment_method      TEXT,
  payment_ref         TEXT,
  paid_at             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity   INTEGER NOT NULL,
  line_total INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  method     TEXT NOT NULL,
  msisdn     TEXT,
  amount     INTEGER NOT NULL,
  reference  TEXT NOT NULL,
  status     TEXT NOT NULL,
  message    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_farmer ON products(farmer_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_farmer ON orders(farmer_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function serviceFeePercent() {
  return Number(getSetting('service_fee_percent', process.env.SERVICE_FEE_PERCENT || '5'));
}

module.exports = { db, tx, getSetting, setSetting, serviceFeePercent, DATA_DIR, UPLOAD_DIR };
