'use strict';

const crypto = require('node:crypto');
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const BLOCKED_NAMES = new Set(['sistem', 'system', 'admin', 'administrator', 'moderator']);
const DUMMY_SALT = 'e7e1c457cfc91e1723be07a35ed6a11a';
const DUMMY_HASH = crypto.scryptSync('deliberately-invalid-password', Buffer.from(DUMMY_SALT, 'hex'), 64);

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function usernameKey(username) { return String(username || '').trim().toLowerCase(); }
function checkUsername(username) {
  return typeof username === 'string' && USERNAME_REGEX.test(username) && !BLOCKED_NAMES.has(usernameKey(username));
}
function checkPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128 && !password.includes('\0');
}
function digestPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  let salt = Buffer.from(DUMMY_SALT, 'hex');
  let expected = DUMMY_HASH;
  if (parts.length === 3 && parts[0] === 'scrypt' && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{128}$/.test(parts[2])) {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  }
  const actual = crypto.scryptSync(typeof password === 'string' ? password : '', salt, 64);
  return crypto.timingSafeEqual(actual, expected) && expected !== DUMMY_HASH;
}
function publicUser(user) { return user ? { id: user.id, username: user.username, createdAt: user.createdAt } : null; }

class Accounts {
  constructor() {
    this.users = new Map();
    this.byUsername = new Map();
    this.sessions = new Map();
  }
  restore(users = [], sessions = []) {
    this.users.clear(); this.byUsername.clear(); this.sessions.clear();
    if (Array.isArray(users)) for (const user of users) {
      if (!user || typeof user.id !== 'string' || !checkUsername(user.username) ||
        typeof user.passwordHash !== 'string' || this.byUsername.has(usernameKey(user.username))) continue;
      this.users.set(user.id, { ...user });
      this.byUsername.set(usernameKey(user.username), user.id);
    }
    if (Array.isArray(sessions)) for (const session of sessions) {
      if (!session || typeof session.hash !== 'string' || !this.users.has(session.userId) ||
        !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) continue;
      this.sessions.set(session.hash, { ...session });
    }
  }
  serialize() {
    this.cleanup();
    return { users: [...this.users.values()], sessions: [...this.sessions.values()] };
  }
  cleanup() {
    const now = Date.now();
    for (const [hash, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(hash);
  }
  isReserved(name) { return this.byUsername.has(usernameKey(name)); }
  userByName(name) { return this.users.get(this.byUsername.get(usernameKey(name))) || null; }
  register(username, password) {
    if (!checkUsername(username)) throw new Error('Kullanıcı adı 3–20 karakter olmalı; yalnızca harf, rakam ve _ kullanılabilir.');
    if (!checkPassword(password)) throw new Error('Şifre 8–128 karakter olmalı.');
    if (this.isReserved(username)) throw new Error('Bu kullanıcı adı zaten kullanılıyor.');
    const user = { id: crypto.randomUUID(), username, passwordHash: digestPassword(password), createdAt: Date.now() };
    this.users.set(user.id, user);
    this.byUsername.set(usernameKey(username), user.id);
    return this.createSession(user);
  }
  login(username, password) {
    const user = this.userByName(username);
    if (!verifyPassword(password, user?.passwordHash)) throw new Error('Kullanıcı adı veya şifre yanlış.');
    return this.createSession(user);
  }
  createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const hash = tokenHash(token);
    const session = { hash, userId: user.id, expiresAt: Date.now() + SESSION_MAX_AGE_MS };
    this.sessions.set(hash, session);
    return { token, user: publicUser(user) };
  }
  resolveToken(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    return this.resolveHash(tokenHash(token));
  }
  resolveHash(hash) {
    const session = this.sessions.get(hash);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) { this.sessions.delete(hash); return null; }
    return this.users.get(session.userId) || null;
  }
  revokeToken(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    return this.sessions.delete(tokenHash(token));
  }
}

function readCookie(cookieHeader, cookieName = 'tavla_session') {
  if (typeof cookieHeader !== 'string') return null;
  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== cookieName) continue;
    return entry.slice(separator + 1).trim();
  }
  return null;
}

module.exports = { Accounts, SESSION_MAX_AGE_MS, publicUser, tokenHash, readCookie, checkUsername, verifyPassword };
