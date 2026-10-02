const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
test('manifest and HTML only reference existing packaged resources', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  const refs = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap(item => [...item.js, ...item.css])];
  for (const html of ['popup.html', 'preview.html']) {
    const source = fs.readFileSync(path.join(root, html), 'utf8');
    for (const match of source.matchAll(/(?:src|href)="([^"]+)"/g)) refs.push(match[1]);
    assert.equal(/<script>([\s\S]*?)<\/script>/.test(source), false);
  }
  refs.push('assets/cat-gentle.png', 'assets/cat-sleepy.png', 'assets/cat-serious.png');
  for (const ref of refs) assert(fs.existsSync(path.join(root, ref)), ref);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'scripting']);
  assert.deepEqual(manifest.host_permissions, ['*://*.bilibili.com/*']);
});
function luminance(hex) {
  const channels = hex.match(/\w\w/g).map(s => parseInt(s, 16) / 255)
    .map(s => s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
test('primary choice buttons have adequate text contrast across their gradients', () => {
  const cat = fs.readFileSync(path.join(root, 'cat.css'), 'utf8');
  const popup = fs.readFileSync(path.join(root, 'popup.css'), 'utf8');
  for (const [source, selector] of [[cat, '.cat-btn-leave'], [popup, '.test-btn'], [popup, '.chip.active']]) {
    const escaped = selector.replaceAll('.', '\\.');
    const block = source.match(new RegExp(escaped + ' \\{([^}]+)\\}'))[1];
    const text = block.match(/color:\s*#([0-9a-f]{6})/)[1];
    const stops = block.match(/linear-gradient\([^;]+/)[0].match(/#[0-9a-f]{6}/g);
    for (const stop of stops) {
      const a = luminance(text), b = luminance(stop.slice(1));
      assert((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, selector + stop);
    }
  }
});
