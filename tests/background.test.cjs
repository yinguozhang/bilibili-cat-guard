const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
function setup(initial = {}) {
  const env = { time: new Date(2026, 8, 14, 12).getTime(), active: true, activeId: 1,
    failClose: false, hook: null, messages: [], removed: [], alarms: new Map() };
  let data = structuredClone(initial);
  const listeners = {};
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [env.time])); }
    static now() { return env.time; }
  }
  const tabs = [{ id: 1, url: 'https://www.bilibili.com/video/a' },
    { id: 2, url: 'https://www.bilibili.com/video/b' }];
  const chrome = {
    runtime: { id: 'test-extension', onInstalled: event('installed'), onStartup: event('startup'),
      onMessage: event('message') },
    storage: { local: {
      async get(keys) {
        if (Array.isArray(keys)) return structuredClone(Object.fromEntries(keys.map(k => [k, data[k]])));
        return structuredClone({ ...keys, ...data });
      },
      async set(next) { Object.assign(data, structuredClone(next)); }
    } },
    windows: { async getLastFocused() { return { id: 1, focused: env.active }; },
      onFocusChanged: event('focus') },
    tabs: { async query(query) { return query.active ? tabs.filter(t => t.id === env.activeId) : tabs; },
      async get(id) { const tab = tabs.find(t => t.id === id); if (!tab) throw Error('missing'); return tab; },
      async sendMessage(id, msg) { env.messages.push({ id, ...msg }); env.hook?.(id, msg); return { ok: true }; },
      async remove(id) { if (env.failClose) throw Error('close failed');
        env.removed.push(id); tabs.splice(tabs.findIndex(t => t.id === id), 1); },
      onActivated: event('activated'), onUpdated: event('updated'), onRemoved: event('removed') },
    scripting: { async insertCSS() {}, async executeScript() {} },
    alarms: { async get(name) { return env.alarms.get(name); },
      async create(name, value) { env.alarms.set(name, value); },
      async clear(name) { env.alarms.delete(name); return true; },
      onAlarm: event('alarm') }
  };
  let sequence = 0;
  const ctx = vm.createContext({ chrome, URL, Date: ClockDate, crypto: { randomUUID: () => 'r' + ++sequence },
    setTimeout, clearTimeout, console: { log() {}, error() {} } });
  vm.runInContext(source, ctx);
  const drain = () => ctx.enqueue(async () => {});
  const observe = () => ctx.enqueue(ctx.observe);
  const message = (msg, sender = { id: chrome.runtime.id, tab: tabs[0] }) =>
    new Promise(resolve => listeners.message(msg, sender, resolve));
  const action = (name, reminderId = data.reminderId, tabId = 1) =>
    message({ type: 'REMINDER_ACTION', action: name, reminderId },
      { id: chrome.runtime.id, tab: tabs.find(t => t.id === tabId) });
  const advance = async ms => { env.time += ms; await observe(); };
  const reachReminder = async () => { for (let i = 0; i < 5; i++) await advance(60000); };
  return { env, listeners, get data() { return data; }, drain, observe, message, action, advance, reachReminder };
}
test('fast continuation cannot be overwritten by the displaying timer', async () => {
  const e = setup({ threshold: 5 }); await e.drain();
  let decision;
  e.env.hook = (_, msg) => { if (msg.type === 'SHOW_CAT')
    decision = e.action('continue', msg.reminderId); };
  await e.reachReminder(); assert.equal((await decision).ok, true); await e.drain();
  assert.equal(e.data.awaitingDecision, false); assert.equal(e.data.accumulatedMs, 0);
  assert.equal(e.data.dailyStats.shown, 1); assert.equal(e.data.dailyStats.continued, 1);
});
test('duplicate and stale decisions do not count twice or close a new session', async () => {
  const e = setup({ threshold: 5 }); await e.drain(); await e.reachReminder();
  const id = e.data.reminderId;
  const responses = await Promise.all([e.action('continue', id), e.action('continue', id)]);
  assert.equal(responses.filter(x => x.ok).length, 1);
  assert.equal((await e.action('leave', id)).error, 'stale-reminder');
  assert.equal(e.data.dailyStats.continued, 1); assert.deepEqual(e.env.removed, []);
});
test('deciding in the second tab clears the same reminder in both tabs', async () => {
  const e = setup({ threshold: 5 }); await e.drain(); await e.reachReminder();
  e.env.activeId = 2; await e.observe(); const id = e.data.reminderId;
  e.env.messages.length = 0; await e.action('continue', id, 2);
  assert.deepEqual(e.env.messages.filter(m => m.type === 'HIDE_CAT')
    .map(m => [m.id, m.reminderId, m.resume]), [[1, id, true], [2, id, true]]);
});
test('failed close leaves the session and statistics intact, retry counts once', async () => {
  const e = setup({ threshold: 5 }); await e.drain(); await e.reachReminder();
  const id = e.data.reminderId; const minutes = e.data.sessionMs;
  e.env.failClose = true; assert.equal((await e.action('leave', id)).error, 'close-failed');
  assert.equal(e.data.reminderId, id); assert.equal(e.data.sessionMs, minutes);
  assert.equal(e.data.dailyStats.left, 0);
  e.env.failClose = false; assert.equal((await e.action('leave', id)).ok, true);
  assert.equal(e.data.dailyStats.left, 1); assert.equal(e.data.sessionMs, 0);
});
test('continuation measures ten minutes from the click', async () => {
  const e = setup({ threshold: 5 }); await e.drain(); await e.reachReminder();
  e.env.time += 47000; await e.action('continue');
  for (let i = 0; i < 9; i++) await e.advance(60000);
  await e.advance(59000); assert.equal(e.data.awaitingDecision, false);
  await e.advance(1000); assert.equal(e.data.awaitingDecision, true);
});
test('actual foreground seconds, not number of alarm samples, are credited', async () => {
  const e = setup({ threshold: 5 }); await e.drain();
  await e.advance(10000); e.env.active = false; await e.observe();
  await e.advance(60000); e.env.active = true; await e.observe(); await e.advance(10000);
  assert.equal(e.data.sessionMs, 20000); assert.equal(e.data.dailyStats.watchMs, 20000);
});
test('away 4:59 keeps the session, away five minutes resets before return', async () => {
  const e = setup({ threshold: 30 }); await e.drain(); await e.advance(60000);
  e.env.active = false; await e.observe();
  for (let i = 0; i < 4; i++) await e.advance(60000);
  await e.advance(59000); e.env.active = true; await e.observe();
  assert.equal(e.data.sessionMs, 60000);
  e.env.active = false; await e.observe();
  for (let i = 0; i < 5; i++) await e.advance(60000);
  e.env.active = true; await e.observe(); assert.equal(e.data.sessionMs, 0);
});
test('restart and unobserved sleep do not retain or credit stale sessions', async () => {
  const e = setup({ threshold: 30 }); await e.drain(); await e.advance(60000);
  await e.advance(3600000); assert.equal(e.data.sessionMs, 0);
  assert.equal(e.data.dailyStats.watchMs, 60000);
  await e.advance(60000); await e.listeners.startup(); await e.drain();
  assert.equal(e.data.sessionMs, 0);
});
test('an observed interval crossing midnight only adds the new-day portion', async () => {
  const e = setup({ threshold: 30 }); await e.drain();
  e.env.time = new Date(2026, 8, 14, 23, 59, 30).getTime(); await e.observe();
  await e.advance(60000);
  assert.equal(e.data.dailyStats.date, '2026-09-15');
  assert.equal(e.data.dailyStats.watchMs, 30000);
  assert.equal(e.data.sessionMs, 60000);
});
test('reselecting the current threshold does not reset; disable is serialized', async () => {
  const e = setup({ threshold: 5 }); await e.drain(); await e.advance(60000);
  await e.message({ type: 'SET_SETTINGS', settings: { threshold: 5 } }, { id: 'test-extension' });
  assert.equal(e.data.sessionMs, 60000);
  await e.message({ type: 'SET_SETTINGS', settings: { enabled: false } }, { id: 'test-extension' });
  assert.equal(e.data.enabled, false); assert.equal(e.data.sessionMs, 0);
});
test('content state query returns the pending reminder without counting another show', async () => {
  const e = setup({ threshold: 5 }); await e.drain(); await e.reachReminder();
  const response = await e.message({ type: 'GET_REMINDER_STATE' });
  assert.equal(response.reminder.reminderId, e.data.reminderId);
  assert.equal(e.data.dailyStats.shown, 1);
});
test('missing receiver is retried without recording a shown reminder', async () => {
  const e = setup({ threshold: 5 }); await e.drain();
  e.env.hook = () => { throw Error('missing receiver'); };
  await e.reachReminder();
  assert.equal(e.data.awaitingDecision, false); assert.equal(e.data.repeatCount, 0);
  assert.equal(e.data.dailyStats.shown, 0);
});
