'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Accounts, readCookie, verifyPassword } = require('../server/accounts');

test('kayıt, giriş, şifre özeti, duplicate casefold, güvenli oturum ve çıkış', () => {
  const accounts = new Accounts();
  const result = accounts.register('Zirad', 'DahaUzunS1fre!');
  assert.equal(result.user.username, 'Zirad');
  assert.throws(() => accounts.register('zIRAD', 'FarkliSifre!'), /zaten kullanılıyor/);
  assert.throws(() => accounts.login('Zirad', 'yanlis'), /yanlış/);
  assert.equal(accounts.login('zirad', 'DahaUzunS1fre!').user.id, result.user.id);
  assert.ok(accounts.resolveToken(result.token));
  const snapshot = accounts.serialize();
  assert.equal(JSON.stringify(snapshot).includes(result.token), false);
  assert.equal(JSON.stringify(snapshot).includes('DahaUzunS1fre!'), false);
  assert.ok(snapshot.users[0].passwordHash.startsWith('scrypt$'));
  assert.equal(verifyPassword('DahaUzunS1fre!', snapshot.users[0].passwordHash), true);
  assert.equal(readCookie(`abc=1; tavla_session=${result.token}; foo=2`), result.token);
  assert.equal(accounts.revokeToken(result.token), true);
  assert.equal(accounts.resolveToken(result.token), null);
});

test('sunucu yeniden açılınca oturum geri yüklenir ve biten oturum geçersiz olur', () => {
  const first = new Accounts();
  const issued = first.register('Testuser', 'YeterinceUzunSifre!');
  const { users, sessions } = first.serialize();
  const next = new Accounts();
  next.restore(users, sessions);
  assert.equal(next.resolveToken(issued.token)?.username, 'Testuser');
  next.sessions.get(sessions[0].hash).expiresAt = Date.now() - 100;
  assert.equal(next.resolveToken(issued.token), null);
  assert.equal(next.serialize().sessions.length, 0);
});

test('geçersiz kullanıcı adı ve zayıf parolalar reddedilir', () => {
  const accounts = new Accounts();
  for (const name of ['ab', 'some.name', 'Sistem', 'admin', 'a'.repeat(21)]) {
    assert.throws(() => accounts.register(name, 'Strongpass1!'), /Kullanıcı adı/);
  }
  assert.throws(() => accounts.register('ValidUser', '123'), /Şifre/);
  assert.equal(accounts.resolveToken('not-a-token'), null);
});


test('Türkçe harf içeren kullanıcı adları kayıt, giriş ve geri yüklemede korunur', () => {
  const accounts = new Accounts();
  const pass = 'TurkceKarakter123!';
  for (const name of ['Aybüke', 'Çağla', 'Şule', 'Yiğit', 'Işık', 'İpek', 'Özge', 'Ümit']) {
    const created = accounts.register(name, pass);
    assert.equal(created.user.username, name);
    assert.equal(accounts.login(name, pass).user.id, created.user.id);
  }
  assert.equal(accounts.login('AYBÜKE', pass).user.username, 'Aybüke');
  assert.equal(accounts.login('ipek', pass).user.username, 'İpek');
  assert.throws(() => accounts.register('aybüke', pass), /zaten kullanılıyor/);
  assert.throws(() => accounts.register('İPEK', pass), /zaten kullanılıyor/);
  assert.throws(() => accounts.register('ADMİN', pass), /Kullanıcı adı/);
  const restored = new Accounts();
  const snapshot = accounts.serialize();
  restored.restore(snapshot.users, snapshot.sessions);
  assert.equal(restored.login('Aybüke', pass).user.username, 'Aybüke');
  assert.equal(restored.login('Şule', pass).user.username, 'Şule');
});

test('Unicode birleşik ve ayrık yazımları tek kullanıcı adı kabul edilir', () => {
  const accounts = new Accounts();
  const pass = 'TurkceKarakter123!';
  const decomposed = 'Aybu\u0308ke';
  const created = accounts.register(decomposed, pass);
  assert.equal(created.user.username, 'Aybüke');
  assert.equal(accounts.login(decomposed, pass).user.id, created.user.id);
  assert.throws(() => accounts.register('Aybüke', pass), /zaten kullanılıyor/);
  for (const invalid of ['aybü.ke', 'ay büke', 'x😎x', 'aybüke!']) {
    assert.throws(() => accounts.register(invalid, pass), /Kullanıcı adı/);
  }
});
