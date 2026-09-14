// popup.js - 设置面板逻辑

const $ = (id) => document.getElementById(id);

const DEFAULT_DAILY_STATS = {
  date: '',
  watchMs: 0,
  shown: 0,
  continued: 0,
  left: 0
};
let previewStage = 1;

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

function formatWatchTime(ms) {
  const totalMinutes = Math.floor((ms || 0) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) return `${minutes} 分钟`;
  if (minutes === 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分`;
}

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

// 初始化
async function init() {
  const data = await chrome.storage.local.get({
    enabled: true,
    threshold: 30,
    sessionMs: 0,
    dailyStats: DEFAULT_DAILY_STATS
  });

  $('enabled').checked = data.enabled;
  renderChips(data.threshold);
  renderNow(data.sessionMs);
  renderDailyStats(data.dailyStats);
}

// 当前这一轮 B 站使用总时长
function renderNow(ms) {
  $('now-minutes').textContent = Math.floor((ms || 0) / 60000);
}

function renderChips(threshold) {
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', Number(chip.dataset.min) === threshold);
  });
}

function renderDailyStats(value) {
  const stats = normalizeDailyStats(value);
  $('today-watch').textContent = formatWatchTime(stats.watchMs);
  $('today-shown').textContent = stats.shown || 0;
  $('today-continued').textContent = stats.continued || 0;
  $('today-left').textContent = stats.left || 0;

  const now = new Date();
  $('today-date').textContent = `${now.getMonth() + 1}月${now.getDate()}日`;
}

// 开关：只改 enabled，不清除 alarm。
// 后台 tick 自己会在 disabled 时直接返回，重新打开也不会丢失计时器。
$('enabled').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
});

// 阈值
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', async () => {
    const min = Number(chip.dataset.min);
    await chrome.storage.local.set({ threshold: min });
    renderChips(min);
    renderNow(0);
  });
});

// 预览阶段：提醒阈值和“第几次提醒”是两个不同维度。
// 阈值只改变第一次出现的时间；角色状态由 reminderIndex 决定。
document.querySelectorAll('.stage-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    previewStage = Number(chip.dataset.stage) || 1;
    document.querySelectorAll('.stage-chip').forEach((item) => {
      item.classList.toggle('active', item === chip);
    });
  });
});

// 立刻召唤橘猫（预览）
$('test-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (!isBilibiliUrl(tab.url)) {
    alert('请先打开一个 B 站页面再召唤橘猫～');
    return;
  }

  const data = await chrome.storage.local.get({ threshold: 30 });

  const message = {
    type: 'SHOW_CAT',
    isRepeat: false,
    reminderIndex: previewStage,
    minutes: data.threshold || 30,
    repeatIntervalMin: 10,
    preview: true
  };

  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    // 扩展刚重载时旧页面可能没有 content script / CSS，补齐两者。
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
    } catch (injectError) {
      console.error('[CatGuard] 手动预览注入失败', injectError);
      alert('橘猫这次没能出现，请刷新当前 B 站页面后再试一次。');
      return;
    }
  }

  window.close();
});

// popup 打开期间同步后台状态
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local') return;

  if (changes.enabled) {
    $('enabled').checked = Boolean(changes.enabled.newValue);
  }

  if (changes.threshold) {
    renderChips(changes.threshold.newValue);
  }

  if (changes.sessionMs) {
    renderNow(changes.sessionMs.newValue);
  }

  if (changes.dailyStats) {
    renderDailyStats(changes.dailyStats.newValue);
  }
});

init();
