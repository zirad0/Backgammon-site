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
