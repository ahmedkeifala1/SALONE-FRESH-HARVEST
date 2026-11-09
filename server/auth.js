'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');

const COOKIE = 'sfh_session';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(res, userId, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_DAYS * 864e5, path: '/',
  });
}

function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Attaches req.user when a valid session cookie is present.
function loadUser(req, _res, next) {
  const token = readCookie(req, COOKIE);
  req.user = null;
  if (token) {
    const row = db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, Date.now());
    if (row) req.user = row;
  }
  next();
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, role: u.role, name: u.name, phone: u.phone, email: u.email,
    district: u.district, farmName: u.farm_name, address: u.address,
    deliveryFee: u.delivery_fee, active: !!u.active, createdAt: u.created_at,
  };
}

// Very small in-memory limiter for login attempts per phone+IP.
const attempts = new Map();
function loginAllowed(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > 15 * 60e3) return true;
  return rec.count < 10;
}
function recordLoginFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > 15 * 60e3) attempts.set(key, { first: now, count: 1 });
  else rec.count += 1;
}
function clearLoginFailures(key) { attempts.delete(key); }

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, loadUser, publicUser,
  loginAllowed, recordLoginFailure, clearLoginFailures,
};
