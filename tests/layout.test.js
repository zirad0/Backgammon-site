const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'client');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('arayüzde yinelenen HTML kimliği yok, tek maç geçmişi ve büyütme aracı var', () => {
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((html.match(/class="matchHistorySection"/g) || []).length, 1);
  assert.ok(ids.includes('boardZoomBtn'));
  assert.ok(ids.includes('tableWrap'));
});

test('mobil büyütme/sığdırma ve dar ekran kaydırma davranışları korunur', () => {
  assert.match(css, /\.tableWrap\.boardZoomed\s+\.board/);
  assert.match(css, /@media\s*\(max-width:\s*299px\)/);
  assert.match(css, /overflow-x:\s*auto/);
  assert.match(js, /boardZoomBtn\?\.addEventListener\('click'/);
  assert.match(js, /window\.addEventListener\('resize', updateBoardScale/);
  assert.match(js, /checker\.style\.width\s*=\s*`\$\{size\}px`/);
});

test('izleyici izni ve canlı maç listesi arayüzde var; seyirci kontrolleri gizlenir', () => {
  for (const id of ['allowSpectatorsCheckbox','watchRoomBtn','liveMatchesList',
    'liveMatchesCount','spectatorBanner','viewerCountBadge']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(css, /#gameScreen\.spectatorMode \.confirmPanel/);
  assert.match(js, /socket\.on\('viewer:joined'/);
  assert.match(js, /socket\.on\('matches:list'/);
  assert.match(js, /socket\.emit\('viewer:leave'/);
});

test('v19: 2x sonucu, oda kapanışı ve sıra bildirimi görünür ve kapatılabilir', () => {
  for (const id of ['noticeModal', 'noticeModalTitle', 'noticeModalText',
    'noticeModalCloseBtn', 'roundModalTitle', 'turnCallout', 'turnSoundCheckbox']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(js, /socket\.on\('room:closed'/);
  assert.match(js, /Rakibin Odadan Ayrıldı/);
  assert.match(js, /showNotice\('2x Kabul Edildi'/);
  assert.match(js, /playTurnSound\(\)/);
  assert.match(js, /activeTurn && previousTurnKey !== nextTurnKey/);
  assert.match(js, /roundModalTitle\.textContent = summary\.kind === 'double_rejected'/);
  assert.match(css, /\.turnCallout/);
  assert.match(css, /prefers-reduced-motion/);
});


test('Kayıt formu ve sunucu Türkçe karakterli kullanıcı adlarında aynı kuralı kullanır', () => {
  const { checkUsername } = require('../server/accounts');
  const pattern = html.match(/id="authUsername"[^>]*\bpattern="([^"]+)"/)?.[1];
  assert.ok(pattern);
  const htmlPattern = new RegExp(`^(?:${pattern})$`, 'v');
  for (const username of ['Aybüke', 'Çağla', 'Şule', 'Yiğit', 'Işık', 'İpek']) {
    assert.equal(htmlPattern.test(username), true, username);
    assert.equal(checkUsername(username), true, username);
  }
  for (const username of ['ab', 'Aybüke!', 'a b', 'x😊x']) {
    assert.equal(htmlPattern.test(username), false, username);
    assert.equal(checkUsername(username), false, username);
  }
  assert.match(html, /id="authUsernameHint"/);
});
