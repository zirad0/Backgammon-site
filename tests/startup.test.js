'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const gameRules = require('../server/game');
const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');

async function runStartup(env, snapshot = null) {
  const app = { routes: new Map(), get(route, callback) { this.routes.set(route, callback); }, use() {}, disable() {} };
  const FakeExpress = () => app;
  FakeExpress.static = () => () => {};
  let listenCount = 0;
  let exitCode;
  let dbSaved = snapshot;
  const io = { sockets: { sockets: new Map() }, on() {}, close() {}, to() { return { emit() {} }; } };
  class FakeIO { constructor() { return io; } }
  class FakePostgres {
    constructor(options) { this.options = options; this.healthy = false; }
    async initialize() { this.healthy = true; this.options.onStatus(true); return dbSaved; }
    save(record) { dbSaved = structuredClone(record); return Promise.resolve(); }
    ping() { return Promise.resolve(true); }
    flush() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  const server = { listen(_port, _host, callback) { listenCount++; callback(); }, on() {}, close() {} };
  const context = {
    URL, console: { log() {}, warn() {}, error() {} }, __dirname: path.join(__dirname, '..', 'server'),
    process: { env, exit: code => { exitCode = code; } },
    require: name => name === 'express' ? FakeExpress : name === 'http' ? { createServer: () => server }
      : name === 'socket.io' ? { Server: FakeIO } : name === './game' ? gameRules
      : name === './accounts' ? require('../server/accounts')
      : name === './friends' ? require('../server/friends')
      : name === './storage' ? { loadSnapshot: () => null, saveSnapshot: () => {} }
      : name === './postgres-store' ? { PostgresStore: FakePostgres } : require(name),
    setTimeout, clearTimeout, setInterval: () => ({ unref() {} })
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  const health = () => {
    let statusCode;
    let body;
    const response = { status(code) { statusCode = code; return this; }, json(payload) { body = payload; return this; } };
    app.routes.get('/health')({}, response);
    return { statusCode, body };
  };
  return { health, get listenCount() { return listenCount; }, get exitCode() { return exitCode; }, get dbSaved() { return dbSaved; } };
}

test('üretim PostgreSQL kuruluysa kayıt yüklenip sonra HTTP servis başlar', async () => {
  const initial = { version: 1, rooms: [], history: [{ id: 'from-prior-deploy', playerTokens: [] }] };
  const runtime = await runStartup({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/test' }, initial);
  assert.equal(runtime.listenCount, 1);
  assert.equal(runtime.exitCode, undefined);
  assert.equal(runtime.health().statusCode, 200);
  assert.equal(runtime.health().body.storage, 'postgres');
});

test('üretimde DATABASE_URL eksikse güvensiz geçici dosya ile başlatılmaz', async () => {
  const runtime = await runStartup({ NODE_ENV: 'production' });
  assert.equal(runtime.listenCount, 0);
  assert.equal(runtime.exitCode, 1);
});
