// background.js - Service Worker
//
// 计时策略 v4：按【一次 B 站使用会话】累计，并在提醒时等待用户明确选择。
// - 同一会话内换视频 / 开新标签不清零。
// - 暂时切走 B 站只暂停；连续离开 5 分钟才结束本轮。
// - sessionMs = 本轮总时长（用于 UI / 提示语）
// - accumulatedMs = 距离下一次提醒的计时
// - awaitingDecision = 全屏橘猫已出现，等待“再看 10 分钟 / 去写论文”
//
// MV3 的 service worker 会休眠，因此用 chrome.alarms 周期唤醒。

const ALARM_TICK = 'cat-guard-tick';
const TICK_MS = 60 * 1000;
const REPEAT_INTERVAL_MIN = 10;
const IDLE_RESET_MIN = 5;

const DEFAULT_STATS = { shown: 0, dismissed: 0, closedBilibili: 0 };
const DEFAULT_DAILY_STATS = {
  date: '',
  watchMs: 0,
  shown: 0,
  continued: 0,
  left: 0
};

function getLocalDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeDailyStats(value) {
  const today = getLocalDateKey();
  if (!value || value.date !== today) {
    return { ...DEFAULT_DAILY_STATS, date: today };
  }

  return { ...DEFAULT_DAILY_STATS, ...value, date: today };
}

const DEFAULTS = {
  enabled: true,
  threshold: 30,
  accumulatedMs: 0,
  sessionMs: 0,
  awayMs: 0,
  repeatCount: 0,
  awaitingDecision: false,
  reminderMinutes: 0,
  stats: DEFAULT_STATS,
  dailyStats: DEFAULT_DAILY_STATS
};

// ====== 工具 ======

function isBilibiliUrl(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (host === 'bilibili.com' || host.endsWith('.bilibili.com'))
    );
  } catch {
    return false;
  }
}

// 只在浏览器窗口本身处于前台、且当前活动标签为 B 站时计时。
async function getActiveBilibiliTab() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (!win || !win.focused) return null;

    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab && isBilibiliUrl(tab.url) ? tab : null;
  } catch (e) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab && isBilibiliUrl(tab.url) ? tab : null;
    } catch {
      return null;
    }
  }
}

async function ensureTickAlarm() {
  try {
    const existing = await chrome.alarms.get(ALARM_TICK);
    if (!existing) {
      await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
      console.log('[CatGuard] 周期计时器已启动（每 1 分钟检查一次）');
    }
  } catch (e) {
    console.error('[CatGuard] 创建计时器失败', e);
  }
}

async function resetSession() {
  await chrome.storage.local.set({
    accumulatedMs: 0,
    sessionMs: 0,
    awayMs: 0,
    repeatCount: 0,
    awaitingDecision: false,
    reminderMinutes: 0
  });
}

async function updateEventStats(kind) {
  const data = await chrome.storage.local.get(['stats', 'dailyStats']);
  const stats = { ...DEFAULT_STATS, ...(data.stats || {}) };
  const dailyStats = normalizeDailyStats(data.dailyStats);

  const cumulativeKey = {
    shown: 'shown',
    continued: 'dismissed',
    left: 'closedBilibili'
  }[kind];

  if (cumulativeKey && Object.prototype.hasOwnProperty.call(stats, cumulativeKey)) {
    stats[cumulativeKey] += 1;
  }

  if (Object.prototype.hasOwnProperty.call(dailyStats, kind)) {
    dailyStats[kind] += 1;
  }

  await chrome.storage.local.set({ stats, dailyStats });
}

async function addDailyWatchMs(ms) {
  const data = await chrome.storage.local.get(['dailyStats']);
  const dailyStats = normalizeDailyStats(data.dailyStats);
  dailyStats.watchMs += Math.max(0, Number(ms) || 0);
  await chrome.storage.local.set({ dailyStats });
}

async function hideVisibleReminders() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => tab.id && isBilibiliUrl(tab.url))
        .map((tab) =>
          chrome.tabs.sendMessage(tab.id, { type: 'HIDE_CAT', resume: false }).catch(() => {})
        )
    );
  } catch {
    // 清理遮罩失败不影响会话状态重置。
  }
}

// ====== 生命周期 ======

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(null);
  const next = { ...DEFAULTS, ...current };

  if (!Object.prototype.hasOwnProperty.call(current, 'sessionMs')) {
    next.sessionMs = current.accumulatedMs || 0;
  }

  // 升级版本时不保留一个可能已经失效的“等待选择”遮罩状态。
  next.awaitingDecision = false;
  next.reminderMinutes = 0;
  next.stats = { ...DEFAULT_STATS, ...(current.stats || {}) };
  next.dailyStats = normalizeDailyStats(current.dailyStats);

  await chrome.storage.local.set(next);
  await ensureTickAlarm();
  console.log('[CatGuard] 已就绪 · v0.5 今日记录 + 图片角色');
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureTickAlarm();
});

ensureTickAlarm();

// ====== 周期 tick ======

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_TICK) await tick();
});

async function tick() {
  const s = await chrome.storage.local.get(DEFAULTS);
  if (!s.enabled) return;

  const activeBiliTab = await getActiveBilibiliTab();

  // 橘猫已经覆盖页面时，不继续累计观看时间。
  // 如果用户刷新/切到另一个 B 站标签导致遮罩消失，则重新确保遮罩存在。
  if (s.awaitingDecision) {
    if (activeBiliTab) {
      await ensureReminderVisible(
        activeBiliTab,
        s.reminderMinutes || Math.max(1, Math.round(s.sessionMs / 60000)),
        s.repeatCount || 1
      );
      if (s.awayMs !== 0) {
        await chrome.storage.local.set({ awayMs: 0 });
      }
      return;
    }

    const awayMs = (s.awayMs || 0) + TICK_MS;
    if (awayMs >= IDLE_RESET_MIN * 60 * 1000) {
      console.log('[CatGuard] 提醒期间连续离开 B 站已满 5 分钟，本轮结束');
      await resetSession();
      await hideVisibleReminders();
    } else {
      await chrome.storage.local.set({ awayMs });
    }
    return;
  }

  if (activeBiliTab) {
    s.accumulatedMs = (s.accumulatedMs || 0) + TICK_MS;
    s.sessionMs = (s.sessionMs || 0) + TICK_MS;
    s.awayMs = 0;
    await addDailyWatchMs(TICK_MS);

    const needMin = s.repeatCount === 0 ? s.threshold : REPEAT_INTERVAL_MIN;
    const needMs = needMin * 60 * 1000;

    if (s.accumulatedMs >= needMs) {
      const minutes = Math.max(1, Math.round(s.sessionMs / 60000));
      const previousRepeatCount = s.repeatCount || 0;

      // 先落盘“正在等待选择”，再显示遮罩，避免用户极快点击时状态还没保存。
      s.awaitingDecision = true;
      s.reminderMinutes = minutes;
      s.repeatCount = previousRepeatCount + 1;
      await chrome.storage.local.set({
        awaitingDecision: true,
        reminderMinutes: minutes,
        repeatCount: s.repeatCount
      });

      const shown = await triggerReminder(
        activeBiliTab,
        minutes,
        previousRepeatCount > 0,
        s.repeatCount
      );

      if (!shown) {
        // 没显示成功就回滚，下一次 tick 还能重试。
        s.awaitingDecision = false;
        s.reminderMinutes = 0;
        s.repeatCount = previousRepeatCount;
      }

      // 不在“显示提醒”这一刻重置 accumulatedMs。
      // 用户真正选择“再看 10 分钟”后才开始新的一轮 10 分钟。
    }
  } else {
    s.awayMs = (s.awayMs || 0) + TICK_MS;

    if (s.awayMs >= IDLE_RESET_MIN * 60 * 1000) {
      if (
        (s.accumulatedMs || 0) > 0 ||
        (s.sessionMs || 0) > 0 ||
        (s.repeatCount || 0) > 0
      ) {
        console.log('[CatGuard] 连续离开 B 站已满 5 分钟，本轮结束');
      }

      s.accumulatedMs = 0;
      s.sessionMs = 0;
      s.repeatCount = 0;
      s.reminderMinutes = 0;
      await hideVisibleReminders();
    }
  }

  await chrome.storage.local.set({
    accumulatedMs: s.accumulatedMs,
    sessionMs: s.sessionMs,
    awayMs: s.awayMs,
    repeatCount: s.repeatCount,
    awaitingDecision: s.awaitingDecision,
    reminderMinutes: s.reminderMinutes
  });
}

// ====== 触发 / 恢复橘猫 ======

function reminderMessage(type, minutes, isRepeat = false, reminderIndex = 1) {
  return {
    type,
    minutes,
    isRepeat,
    reminderIndex,
    repeatIntervalMin: REPEAT_INTERVAL_MIN
  };
}

async function sendMessageWithInjection(tab, message) {
  if (!tab || !tab.id || !isBilibiliUrl(tab.url)) return false;

  try {
    await chrome.tabs.sendMessage(tab.id, message);
    return true;
  } catch (e) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['cat.css']
      });

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });

      await chrome.tabs.sendMessage(tab.id, message);
      return true;
    } catch (e2) {
      console.error('[CatGuard] 补注入失败', e2);
      return false;
    }
  }
}

async function triggerReminder(tab, minutes, isRepeat, reminderIndex) {
  const shown = await sendMessageWithInjection(
    tab,
    reminderMessage('SHOW_CAT', minutes, isRepeat, reminderIndex)
  );

  if (!shown) return false;

  await updateEventStats('shown');
  console.log(
    `[CatGuard] 触发全屏提醒（${isRepeat ? '再提醒' : '首次'}）· 本轮累计 ${minutes} 分钟`
  );
  return true;
}

async function ensureReminderVisible(tab, minutes, reminderIndex) {
  return sendMessageWithInjection(
    tab,
    reminderMessage('ENSURE_CAT', minutes, reminderIndex > 1, reminderIndex)
  );
}

// ====== 接收 content script 消息 ======

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'REMINDER_ACTION') return;

  const tabId = sender.tab?.id;

  (async () => {
    if (msg.action === 'continue') {
      const state = await chrome.storage.local.get({ awaitingDecision: false });
      if (!state.awaitingDecision) {
        sendResponse({ ok: true, alreadyHandled: true });
        return;
      }

      await updateEventStats('continued');
      await chrome.storage.local.set({
        accumulatedMs: 0,
        awayMs: 0,
        awaitingDecision: false,
        reminderMinutes: 0
      });

      console.log(`[CatGuard] 用户选择再看 ${REPEAT_INTERVAL_MIN} 分钟`);
      sendResponse({ ok: true, repeatIntervalMin: REPEAT_INTERVAL_MIN });
      return;
    }

    if (msg.action === 'leave') {
      await updateEventStats('left');
      await resetSession();

      if (typeof tabId !== 'number') {
        sendResponse({ ok: false, error: 'missing-tab' });
        return;
      }

      try {
        await chrome.tabs.remove(tabId);
        console.log('[CatGuard] 用户选择离开 · 已关闭当前 B 站标签');
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[CatGuard] 关闭当前 B 站标签失败', e);
        sendResponse({ ok: false, error: 'close-failed' });
      }
      return;
    }

    sendResponse({ ok: false, error: 'unknown-action' });
  })().catch((e) => {
    console.error('[CatGuard] 处理提醒选择失败', e);
    sendResponse({ ok: false, error: 'internal-error' });
  });

  return true;
});

// ====== 设置变化 ======

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local') return;

  if (changes.threshold) {
    resetSession();
    console.log(
      '[CatGuard] 阈值改为 ' + changes.threshold.newValue + ' 分钟 · 本轮已重置'
    );
  }

  if (changes.enabled) {
    if (changes.enabled.newValue === false) {
      resetSession();
    } else {
      ensureTickAlarm();
    }
  }
});
