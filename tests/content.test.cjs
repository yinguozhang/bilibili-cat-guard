const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
function setup() {
  let document;
  const intervals = new Map();
  const handlers = new Map();
  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.parentNode = null;
      this.style = {}; this.dataset = {}; this.attrs = {}; this.inert = false;
      this.events = {}; this.disabled = false; this.classes = new Set();
      this.classList = { add: x => this.classes.add(x), remove: x => this.classes.delete(x),
        contains: x => this.classes.has(x), toggle: (x, on) => on ? this.classes.add(x) : this.classes.delete(x) };
    }
    get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    append(...children) { children.forEach(c => this.appendChild(c)); }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this);
      this.parentNode = null;
    }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(name, fn) { this.events[name] = fn; }
    focus() { if (this.isConnected) document.activeElement = this; }
  }
  function all(root) { return [root, ...root.children.flatMap(all)]; }
  document = {
    documentElement: { style: { overflow: 'scroll' } }, fullscreenElement: null, hidden: false,
    createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('text'), { textContent: text }),
    getElementById: id => all(document.body).find(e => e.id === id) || null,
    querySelectorAll: query => query === 'video, audio' ? [media, paused] : [],
    querySelector: () => null,
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
    async exitFullscreen() { document.fullscreenElement = null; }
  };
  document.body = new Element('body');
  const previous = document.body.appendChild(new Element('button'));
  document.activeElement = previous;
  const priorInert = document.body.appendChild(new Element('aside')); priorInert.inert = true;
  const media = document.body.appendChild(new Element('video'));
  media.paused = false; media.ended = false; media.pause = () => { media.paused = true; };
  media.playCount = 0; media.play = () => { media.playCount++; media.paused = false; return Promise.resolve(); };
  const paused = document.body.appendChild(new Element('audio'));
  paused.paused = true; paused.ended = false; paused.playCount = 0;
  paused.pause = () => { paused.paused = true; };
  paused.play = () => { paused.playCount++; return Promise.resolve(); };
  const env = { listener: null, changes: null, action: null };
  const chrome = {
    runtime: { getURL: p => p, lastError: null, onMessage: { addListener(fn) { env.listener = fn; } },
      sendMessage(msg, cb) { if (msg.type === 'REMINDER_ACTION') env.action = { msg, cb }; } },
    storage: { onChanged: { addListener(fn) { env.changes = fn; } } }
  };
  const window = { __catGuardPreviewPage: true, setInterval(fn) {
    const id = intervals.size + 1; intervals.set(id, fn); return id;
  } };
  const ctx = vm.createContext({ document, window, chrome,
    MutationObserver: class { observe() {} disconnect() {} },
    clearInterval: id => intervals.delete(id), setTimeout, console: { log() {} } });
  vm.runInContext(source, ctx);
  const message = msg => new Promise(resolve => env.listener(msg, {}, resolve));
  const show = options => message({ type: 'SHOW_CAT', minutes: 30, reminderIndex: 1, ...options });
  const root = () => document.getElementById('cat-guard-root');
  const buttons = () => all(root()).filter(e => e.tagName === 'button');
  return { env, document, media, paused, previous, priorInert, intervals, handlers, message, show, root, buttons };
}
test('preview upgraded to a real reminder retains media and restores focus/inert state', async () => {
  const e = setup(); await e.show({ preview: true });
  assert.equal(e.media.paused, true); assert.equal(e.previous.inert, true);
  await e.show({ preview: false, reminderId: 'real' });
  const clicking = e.buttons()[0].events.click();
  assert.equal(e.env.action.msg.reminderId, 'real');
  e.env.action.cb({ ok: true }); await clicking;
  assert.equal(e.media.playCount, 1); assert.equal(e.paused.playCount, 0);
  assert.equal(e.document.documentElement.style.overflow, 'scroll');
  assert.equal(e.document.activeElement, e.previous);
  assert.equal(e.previous.inert, false); assert.equal(e.priorInert.inert, true);
  assert.equal(e.intervals.size, 0); assert.equal(e.handlers.get('keydown').size, 0);
});
test('hide for another reminder cannot remove the current overlay', async () => {
  const e = setup(); await e.show({ reminderId: 'current' });
  await e.message({ type: 'HIDE_CAT', reminderId: 'old', resume: true });
  assert.equal(e.root().dataset.reminderId, 'current'); assert.equal(e.media.playCount, 0);
});
test('normal hide restores original state and safe preview leave never sends an action', async () => {
  const e = setup(); await e.show({ preview: true });
  await e.buttons()[1].events.click();
  assert.equal(e.env.action, null); assert.equal(e.root(), null); assert.equal(e.media.playCount, 1);
});
test('fullscreen exit completes before rendering, and a later hide cancels pending display', async () => {
  const e = setup(); let finishExit;
  e.document.fullscreenElement = {};
  e.document.exitFullscreen = () => new Promise(resolve => { finishExit = () => {
    e.document.fullscreenElement = null; resolve(); }; });
  const showing = e.show({ reminderId: 'pending' });
  assert.equal(e.root(), null);
  await e.message({ type: 'HIDE_CAT', reminderId: 'pending', resume: false });
  finishExit(); await showing; assert.equal(e.root(), null);
});
test('tab and shift-tab stay in the reminder, while close restores focus', async () => {
  const e = setup(); await e.show({ reminderId: 'r' });
  const [first, second] = e.buttons(); first.focus();
  const handler = [...e.handlers.get('keydown')][0];
  let prevented = false;
  handler({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(e.document.activeElement, second);
  handler({ key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.equal(e.document.activeElement, first);
  handler({ key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(e.document.activeElement, second);
  await e.message({ type: 'HIDE_CAT', reminderId: 'r', resume: true });
  assert.equal(e.document.activeElement, e.previous);
});
