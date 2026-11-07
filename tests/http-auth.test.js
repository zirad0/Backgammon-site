'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const game = require('../server/game');
const accounts = require('../server/accounts');

function makeApp({ env = {}, snapshot = null } = {}) {
  const routes = new Map();
  const app = { disable() {}, use() {}, get(route, cb) { routes.set(`GET ${route}`, cb); },
    post(route, cb) { routes.set(`POST ${route}`, cb); } };
  const express = () => app;
  express.static = () => () => {};
  express.json = () => () => {};
  const io = { on() {}, sockets: { sockets: new Map() }, to() { return { emit() {} }; } };
  const context = {
    require: name => name === 'express' ? express : name === 'http' ? { createServer() { return { listen(_port, _host, cb) { cb(); } }; } }
      : name === 'socket.io' ? { Server: class { constructor() { return io; } } }
      : name === './game' ? game : name === './accounts' ? accounts
      : name === './friends' ? require('../server/friends')
      : name === './admin-activity' ? require('../server/admin-activity')
      : name === './storage' ? { loadSnapshot: () => snapshot, saveSnapshot: () => {} } : require(name),
    process: { env }, console: { log() {}, warn() {}, error() {} },
    __dirname: path.join(__dirname, '..', 'server'), URL,
    setTimeout, clearTimeout, setInterval: () => ({ unref() {} })
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  vm.runInNewContext(source, context);
  async function request(method, url, { body = {}, cookie = '', origin = 'http://localhost:3000', ip = '127.0.0.1', contentType = true } = {}) {
    const headers = { host: 'localhost:3000', cookie, origin };
    const req = { headers, ip, protocol: 'http', body, get(key) { return headers[key.toLowerCase()]; },
      is() { return contentType; } };
    const response = { statusCode: 200, headers: {}, body: null,
      status(code) { this.statusCode = code; return this; },
      setHeader(key, value) { this.headers[key] = value; },
      json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
      sendFile(value) { this.filePath = value; return this; } };
    const handler = routes.get(`${method} ${url}`);
    assert.ok(handler, `Route must exist: ${method} ${url}`);
    await handler(req, response);
    return response;
  }
  return { request };
}

test('HTTP hesap oluşturma, profil okuma, giriş ve çıkış yaşam döngüsü', async () => {
  const { request } = makeApp();
  const register = await request('POST', '/api/auth/register', { body: { username: 'Zirad', password: 'StrongSifre123!' } });
  assert.equal(register.statusCode, 200);
  assert.equal(register.body.user.username, 'Zirad');
  assert.equal(register.body.stats.games, 0);
  const cookie = register.headers['Set-Cookie'].split(';')[0];
  assert.match(register.headers['Set-Cookie'], /HttpOnly; SameSite=Strict/);
  const profile = await request('GET', '/api/me', { cookie });
  assert.equal(profile.body.user.username, 'Zirad');
  assert.equal(profile.headers['Cache-Control'], 'no-store');
  const wrong = await request('POST', '/api/auth/login', { body: { username: 'Zirad', password: 'notcorrect' } });
  assert.equal(wrong.statusCode, 401);
  const good = await request('POST', '/api/auth/login', { body: { username: 'zirad', password: 'StrongSifre123!' } });
  assert.equal(good.statusCode, 200);
  const logout = await request('POST', '/api/auth/logout', { cookie });
  assert.equal(logout.statusCode, 200);
  assert.match(logout.headers['Set-Cookie'], /Max-Age=0/);
  assert.equal((await request('GET', '/api/me', { cookie })).body.authenticated, false);
});

test('HTTP hesap istekleri aynı origin ve JSON içerik türü ister', async () => {
  const { request } = makeApp();
  const payload = { body: { username: 'Another', password: 'StrongSifre123!' } };
  assert.equal((await request('POST', '/api/auth/register', { ...payload, origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await request('POST', '/api/auth/register', { ...payload, contentType: false })).statusCode, 403);
  assert.equal((await request('GET', '/api/me')).body.authenticated, false);
});

test('yönetim API ve özel HTML gerçek hesap kimliği olmadan açılamaz', async () => {
  const existing = new accounts.Accounts();
  const owner = existing.register('Zirad', 'OwnerPassword123!');
  const other = existing.register('RandomPlayer', 'NormalPassword123!');
  const snapshot = { ...existing.serialize(), rooms: [], history: [] };
  const { request } = makeApp({ env: { ADMIN_USER_ID: owner.user.id }, snapshot });
  const adminCookie = `tavla_session=${owner.token}`;
  const otherCookie = `tavla_session=${other.token}`;
  assert.equal((await request('GET', '/api/admin/overview')).statusCode, 401);
  assert.equal((await request('GET', '/api/admin/overview', { cookie: otherCookie })).statusCode, 403);
  assert.equal((await request('GET', '/yonetim', { cookie: otherCookie })).statusCode, 403);
  const ok = await request('GET', '/api/admin/overview', { cookie: adminCookie });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.equal(ok.body.stats.players, 0);
  assert.deepEqual(ok.body.online, []);
  const page = await request('GET', '/yonetim', { cookie: adminCookie });
  assert.equal(page.statusCode, 200);
  assert.match(page.filePath, /server[/\\]private[/\\]admin\.html$/);
  assert.equal((await request('GET', '/api/me', { cookie: adminCookie })).body.isAdmin, true);
  assert.equal((await request('GET', '/api/me', { cookie: otherCookie })).body.isAdmin, false);
});

test('ADMIN_USER_ID ayarlanmamışsa hesabı olan kullanıcı bile yönetici değildir', async () => {
  const { request } = makeApp();
  const signup = await request('POST', '/api/auth/register', {
    body: { username: 'PlayerForAdmin', password: 'GoodPassword123!' }
  });
  const cookie = signup.headers['Set-Cookie'].split(';')[0];
  assert.equal(signup.body.isAdmin, false);
  assert.equal((await request('GET', '/api/admin/overview', { cookie })).statusCode, 403);
});


test('HTTP API Türkçe karakterli kullanıcı adıyla kayıt ve girişe izin verir', async () => {
  const { request } = makeApp();
  const signup = await request('POST', '/api/auth/register', {
    body: { username: 'Aybüke', password: 'TurkceKarakter123!' }
  });
  assert.equal(signup.statusCode, 200);
  assert.equal(signup.body.user.username, 'Aybüke');
  const login = await request('POST', '/api/auth/login', {
    body: { username: 'aybüke', password: 'TurkceKarakter123!' }
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.body.user.id, signup.body.user.id);
  const duplicate = await request('POST', '/api/auth/register', {
    body: { username: 'AYBÜKE', password: 'TurkceKarakter123!' }
  });
  assert.equal(duplicate.statusCode, 400);
  assert.match(duplicate.body.error, /zaten kullanılıyor/);
});
