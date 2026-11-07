'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const storageModule = path.join(__dirname, '..', 'server', 'storage.js');

test('kalıcı kayıt dosyası atomik yazılır, yeniden başlayan süreçten geri okunur', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavla-store-'));
  const filename = path.join(dir, 'store', 'matches.json');
  const env = { ...process.env, TAVLA_DATA_FILE: filename };
  try {
    const sample = { version: 1, rooms: [{ roomCode: 'ABCDE' }], history: [{ id: 'game-1' }], nextChatId: 7 };
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(storageModule)}).saveSnapshot(${JSON.stringify(sample)});`], { env });
    assert.equal(fs.existsSync(filename), true);
    assert.equal(fs.readdirSync(path.dirname(filename)).filter(file => file.endsWith('.tmp')).length, 0);
    const restored = JSON.parse(execFileSync(process.execPath,
      ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(storageModule)}).loadSnapshot()));`],
      { env, encoding: 'utf8' }));
    assert.deepEqual(restored, sample);
    fs.writeFileSync(filename, '{bozuk: json');
    assert.throws(() => execFileSync(process.execPath,
      ['-e', `require(${JSON.stringify(storageModule)}).loadSnapshot();`],
      { env, stdio: 'pipe' }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
