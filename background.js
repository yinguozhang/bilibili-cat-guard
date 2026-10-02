// All session mutations are serialized, including timer, settings and decisions.
const ALARM_TICK = 'cat-guard-tick';
const ALARM_DEADLINE = 'cat-guard-deadline';
const REPEAT_INTERVAL_MIN = 10;
const IDLE_RESET_MS = 5 * 60000;
// Longer gaps cannot be distinguished reliably from device sleep. Never credit them.
const MAX_OBSERVATION_GAP_MS = 2 * 60000;
const DEFAULT_STATS = { shown: 0, dismissed: 0, closedBilibili: 0 };
const DEFAULT_DAILY_STATS = { date: '', watchMs: 0, shown: 0, continued: 0, left: 0 };
const DEFAULTS = {
  enabled: true, threshold: 30, accumulatedMs: 0, sessionMs: 0,
  awayMs: 0, repeatCount: 0, awaitingDecision: false, reminderMinutes: 0,
  reminderId: '', lastTickAt: 0, wasActive: false, awaySince: 0,
  stats: DEFAULT_STATS, dailyStats: DEFAULT_DAILY_STATS
};
let mutationQueue = Promise.resolve();
function enqueue(work) {
  const result = mutationQueue.then(work);
  mutationQueue = result.catch((error) => console.error('[CatGuard]', error));
  return result;
}
function getLocalDateKey(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}
function normalizeDailyStats(value) {
  const today = getLocalDateKey();
  return { ...DEFAULT_DAILY_STATS, ...(value?.date === today ? value : {}), date: today };
}
function isBilibiliUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) &&
      (parsed.hostname === 'bilibili.com' || parsed.hostname.endsWith('.bilibili.com'));
  } catch { return false; }
}
async function getActiveBilibiliTab() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (!win?.focused) return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab && isBilibiliUrl(tab.url) ? tab : null;
  } catch { return null; }
}
function clearSession(s) {
  Object.assign(s, { accumulatedMs: 0, sessionMs: 0, awayMs: 0, awaySince: 0,
    repeatCount: 0, awaitingDecision: false, reminderMinutes: 0, reminderId: '' });
}
function eventStats(s, kind) {
  s.stats = { ...DEFAULT_STATS, ...s.stats };
  s.dailyStats = normalizeDailyStats(s.dailyStats);
  s.stats[{ shown: 'shown', continued: 'dismissed', left: 'closedBilibili' }[kind]]++;
  s.dailyStats[kind]++;
}
function addWatchInterval(s, start, end) {
  s.dailyStats = normalizeDailyStats(s.dailyStats);
  // Only retain today's share when an observed interval straddles midnight.
  const midnight = new Date(end);
  midnight.setHours(0, 0, 0, 0);
  s.dailyStats.watchMs += Math.max(0, end - Math.max(start, midnight.getTime()));
}
async function readState() {
  const s = await chrome.storage.local.get(DEFAULTS);
  s.dailyStats = normalizeDailyStats(s.dailyStats);
  if (![5, 15, 30, 45, 60].includes(s.threshold)) s.threshold = 30;
  return s;
}
function reminderMessage(s, type = 'ENSURE_CAT') {
  return { type, reminderId: s.reminderId, minutes: s.reminderMinutes,
    reminderIndex: s.repeatCount, isRepeat: s.repeatCount > 1,
    repeatIntervalMin: REPEAT_INTERVAL_MIN };
}
async function bounded(promise) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('message-timeout')), 2500);
    })]);
  } finally { clearTimeout(timeout); }
}
async function hideVisibleReminders(reminderId = '', resume = false) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter(tab => Number.isInteger(tab.id) && isBilibiliUrl(tab.url))
    .map(tab => bounded(chrome.tabs.sendMessage(tab.id,
      { type: 'HIDE_CAT', reminderId, resume })).catch(() => {})));
}
async function sendMessageWithInjection(tab, message) {
  if (!Number.isInteger(tab?.id) || !isBilibiliUrl(tab.url)) return false;
  try {
    const response = await bounded(chrome.tabs.sendMessage(tab.id, message));
    return response?.ok === true;
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['cat.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      const response = await bounded(chrome.tabs.sendMessage(tab.id, message));
      return response?.ok === true;
    } catch (error) {
      console.error('[CatGuard] 补注入失败', error);
      return false;
    }
  }
}
async function schedule(s, tab) {
  if (!await chrome.alarms.get(ALARM_TICK)) {
    await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
  }
  await chrome.alarms.clear(ALARM_DEADLINE);
  if (!s.enabled) return;
  const now = Date.now();
  let remaining;
  if (tab && !s.awaitingDecision) {
    remaining = (s.repeatCount ? REPEAT_INTERVAL_MIN : s.threshold) * 60000 - s.accumulatedMs;
  } else if (!tab && s.awaySince) {
    remaining = IDLE_RESET_MS - (now - s.awaySince);
  }
  if (remaining !== undefined) {
    await chrome.alarms.create(ALARM_DEADLINE, { when: now + Math.max(30000, remaining) });
  }
}
// Settle the previous observed foreground interval before adopting the new foreground state.
async function observe(display = true) {
  const s = await readState();
  const tab = await getActiveBilibiliTab();
  const now = Date.now();
  const delta = s.lastTickAt ? now - s.lastTickAt : 0;
  if (delta < 0 || delta > MAX_OBSERVATION_GAP_MS) {
    const oldId = s.reminderId;
    clearSession(s);
    await hideVisibleReminders(oldId, false);
  } else if (s.enabled && s.wasActive && !s.awaitingDecision && delta > 0) {
    s.sessionMs += delta;
    s.accumulatedMs += delta;
    addWatchInterval(s, s.lastTickAt, now);
  }
  if (!s.enabled) {
    s.wasActive = false;
  } else if (tab) {
    // Evaluate an expired away interval before clearing its timestamp.
    if (s.awaySince && now - s.awaySince >= IDLE_RESET_MS) {
      const oldId = s.reminderId;
      clearSession(s);
      await hideVisibleReminders(oldId, false);
    }
    s.awaySince = 0;
    s.awayMs = 0;
    s.wasActive = true;
  } else {
    if (!s.awaySince) s.awaySince = now;
    s.awayMs = now - s.awaySince;
    s.wasActive = false;
    if (s.awayMs >= IDLE_RESET_MS) {
      const oldId = s.reminderId;
      clearSession(s);
      s.awaySince = now;
      await hideVisibleReminders(oldId, false);
    }
  }
  s.lastTickAt = now;
  // Persist before display; subsequent decisions run after this operation, never under it.
  await chrome.storage.local.set(s);
  if (display && s.enabled && tab) {
    if (s.awaitingDecision) {
      await sendMessageWithInjection(tab, reminderMessage(s));
    } else if (s.accumulatedMs >= (s.repeatCount ? REPEAT_INTERVAL_MIN : s.threshold) * 60000) {
      const previousCount = s.repeatCount;
      s.awaitingDecision = true;
      s.reminderMinutes = Math.max(1, Math.round(s.sessionMs / 60000));
      s.repeatCount++;
      s.reminderId = crypto.randomUUID();
      await chrome.storage.local.set(s);
      if (await sendMessageWithInjection(tab, reminderMessage(s, 'SHOW_CAT'))) {
        eventStats(s, 'shown');
      } else {
        s.awaitingDecision = false;
        s.reminderMinutes = 0;
        s.reminderId = '';
        s.repeatCount = previousCount;
      }
      await chrome.storage.local.set(s);
    }
  }
  await schedule(s, tab);
  return { s, tab };
}
async function handleAction(msg, sender) {
  const s = await readState();
  if (!s.enabled || !s.awaitingDecision || !msg.reminderId || msg.reminderId !== s.reminderId) {
    return { ok: false, error: 'stale-reminder' };
  }
  if (!Number.isInteger(sender.tab?.id) || !isBilibiliUrl(sender.tab.url)) {
    return { ok: false, error: 'invalid-tab' };
  }
  const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
  if (!tab || !isBilibiliUrl(tab.url)) return { ok: false, error: 'invalid-tab' };
  if (!['continue', 'leave'].includes(msg.action)) return { ok: false, error: 'unknown-action' };
  if (msg.action === 'leave') {
    try { await chrome.tabs.remove(tab.id); }
    catch { return { ok: false, error: 'close-failed' }; }
  }
  const oldId = s.reminderId;
  eventStats(s, msg.action === 'continue' ? 'continued' : 'left');
  if (msg.action === 'continue') {
    Object.assign(s, { accumulatedMs: 0, awayMs: 0, awaySince: 0,
      awaitingDecision: false, reminderMinutes: 0, reminderId: '' });
  } else {
    clearSession(s);
  }
  // A continuation starts at the decision, rather than the next minute sample.
  s.lastTickAt = Date.now();
  s.wasActive = Boolean(await getActiveBilibiliTab());
  await chrome.storage.local.set(s);
  await hideVisibleReminders(oldId, msg.action === 'continue');
  await schedule(s, await getActiveBilibiliTab());
  return { ok: true, repeatIntervalMin: REPEAT_INTERVAL_MIN };
}
async function setSettings(msg) {
  const { s } = await observe(false);
  const next = msg.settings || {};
  if ((next.enabled !== undefined && typeof next.enabled !== 'boolean') ||
      (next.threshold !== undefined && ![5, 15, 30, 45, 60].includes(next.threshold))) {
    return { ok: false, error: 'invalid-setting' };
  }
  const changed = (next.enabled !== undefined && next.enabled !== s.enabled) ||
    (next.threshold !== undefined && next.threshold !== s.threshold);
  if (changed) {
    const oldId = s.reminderId;
    clearSession(s);
    if (next.enabled !== undefined) s.enabled = next.enabled;
    if (next.threshold !== undefined) s.threshold = next.threshold;
    s.lastTickAt = Date.now();
    s.wasActive = s.enabled && Boolean(await getActiveBilibiliTab());
    await chrome.storage.local.set(s);
    await hideVisibleReminders(oldId, true);
    await schedule(s, await getActiveBilibiliTab());
  }
  return { ok: true };
}
async function startSession() {
  const s = await readState();
  clearSession(s);
  s.lastTickAt = Date.now();
  s.wasActive = s.enabled && Boolean(await getActiveBilibiliTab());
  await chrome.storage.local.set(s);
  await hideVisibleReminders('', false);
  await schedule(s, await getActiveBilibiliTab());
}
chrome.runtime.onInstalled.addListener(() => enqueue(startSession));
chrome.runtime.onStartup.addListener(() => enqueue(startSession));
chrome.alarms.onAlarm.addListener(alarm => {
  if ([ALARM_TICK, ALARM_DEADLINE].includes(alarm.name)) enqueue(observe);
});
chrome.tabs.onActivated.addListener(() => enqueue(observe));
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url || change.status === 'complete') enqueue(observe);
});
chrome.tabs.onRemoved.addListener(() => enqueue(observe));
chrome.windows.onFocusChanged.addListener(() => enqueue(observe));
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!['REMINDER_ACTION', 'GET_REMINDER_STATE', 'SET_SETTINGS'].includes(msg?.type)) return;
  enqueue(async () => {
    if (msg.type === 'REMINDER_ACTION') return handleAction(msg, sender);
    if (msg.type === 'SET_SETTINGS') {
      if (sender.tab || sender.id !== chrome.runtime.id) return { ok: false, error: 'invalid-sender' };
      return setSettings(msg);
    }
    const { s } = await observe();
    return { ok: true, reminder: s.enabled && s.awaitingDecision ? reminderMessage(s) : null };
  }).then(sendResponse, error => {
    console.error('[CatGuard] 处理消息失败', error);
    sendResponse({ ok: false, error: 'internal-error' });
  });
  return true;
});
// On worker wake, persisted timestamps retain short sessions, while long gaps end them.
enqueue(observe);
