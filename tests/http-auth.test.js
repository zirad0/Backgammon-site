'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const game = require('../server/game');
const accounts = require('../server/accounts');

function makeApp() {
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
      : name === './storage' ? { loadSnapshot: () => null, saveSnapshot: () => {} } : require(name),
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
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
      json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; } };
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
