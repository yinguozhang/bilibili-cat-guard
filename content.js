// content.js - Content Script
// v0.4.0：角色改为本地透明 PNG 素材；代码只负责状态、文案、按钮和动画。
// 核心原则：第一次提醒，第二次陪你等，第三次以后认真看着你；决定权仍然在用户手里。

if (!window.__catGuardInjected) {
  window.__catGuardInjected = true;

  let pausedMedia = new Set();
  let mediaPauseTimer = null;
  let previousOverflow = '';
  let activeKeydownHandler = null;

  function getReminderCopy(reminderIndex, minutes) {
    const stage = Math.max(1, Number(reminderIndex) || 1);

    if (stage === 1) {
      return {
        face: 'surprised',
        prefix: '喵～你已经看了 ',
        emphasis: `${minutes} 分钟`,
        suffix: ' 啦',
        question: '要不要歇一下？',
        note: '眼睛也需要休息，你还有更重要的事情在等着呢～'
      };
    }

    if (stage === 2) {
      return {
        face: 'yawning',
        prefix: '又 10 分钟过去啦',
        emphasis: '',
        suffix: '',
        question: `这一轮已经 ${minutes} 分钟，要不要停在这里？`,
        note: '论文还在等你哦，橘猫陪你再做一次选择。'
      };
    }

    if (stage === 3) {
      return {
        face: 'serious',
        prefix: '橘猫第三次来找你了',
        emphasis: '',
        suffix: '',
        question: `已经 ${minutes} 分钟了，真的还要继续吗？`,
        note: '不催你，只是认真看着你。'
      };
    }

    return {
      face: 'serious',
      prefix: `橘猫第 ${stage} 次来找你了`,
      emphasis: '',
      suffix: '',
      question: `这一轮已经 ${minutes} 分钟，还要再给自己 10 分钟吗？`,
      note: '可以继续，但这是你主动做的决定。'
    };
  }

  function getCatImagePath(face) {
    const filename = {
      surprised: 'cat-gentle.png',
      yawning: 'cat-sleepy.png',
      serious: 'cat-serious.png'
    }[face] || 'cat-gentle.png';

    return chrome.runtime.getURL(`assets/${filename}`);
  }

  function buildCatImage(face) {
    const img = document.createElement('img');
    img.className = 'cat-character-image';
    img.src = getCatImagePath(face);
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.decoding = 'async';
    img.draggable = false;
    return img;
  }

  function pausePageMedia() {
    document.querySelectorAll('video, audio').forEach((media) => {
      if (!media.paused && !media.ended) {
        pausedMedia.add(media);
        try {
          media.pause();
        } catch {
          // 单个媒体暂停失败不影响遮罩本身。
        }
      }
    });
  }

  function startMediaGuard() {
    pausePageMedia();
    if (!mediaPauseTimer) {
      mediaPauseTimer = window.setInterval(pausePageMedia, 400);
    }
  }

  function stopMediaGuard({ resume = false } = {}) {
    if (mediaPauseTimer) {
      clearInterval(mediaPauseTimer);
      mediaPauseTimer = null;
    }

    if (resume) {
      pausedMedia.forEach((media) => {
        if (!media.isConnected) return;
        try {
          const result = media.play();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch {
          // 页面自己的播放器可能接管播放状态；恢复失败不阻塞用户继续操作。
        }
      });
    }

    pausedMedia.clear();
  }

  function lockPage() {
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    startMediaGuard();
  }

  function unlockPage({ resume = false } = {}) {
    document.documentElement.style.overflow = previousOverflow;
    stopMediaGuard({ resume });

    if (activeKeydownHandler) {
      document.removeEventListener('keydown', activeKeydownHandler, true);
      activeKeydownHandler = null;
    }
  }

  function nudgePanel() {
    const panel = document.querySelector('#cat-guard-root .cat-panel');
    if (!panel) return;
    panel.classList.remove('cat-nudge');
    void panel.offsetWidth;
    panel.classList.add('cat-nudge');
  }

  function removeOverlay({ resume = false, animate = true } = {}) {
    const root = document.getElementById('cat-guard-root');
    unlockPage({ resume });

    if (!root) return;

    if (!animate) {
      root.remove();
      return;
    }

    root.classList.add('cat-leaving');
    setTimeout(() => root.remove(), 300);
  }

  function sendAction(action) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'REMINDER_ACTION', action }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });
  }

  function buildBubble(copy) {
    const bubble = document.createElement('div');
    bubble.className = 'cat-bubble';
    bubble.id = 'cat-guard-message';
    bubble.setAttribute('aria-live', 'assertive');

    const main = document.createElement('div');
    main.className = 'cat-bubble-main';
    main.append(document.createTextNode(copy.prefix));

    if (copy.emphasis) {
      const emphasis = document.createElement('strong');
      emphasis.className = 'cat-bubble-emphasis';
      emphasis.textContent = copy.emphasis;
      main.appendChild(emphasis);
    }

    main.append(document.createTextNode(copy.suffix));

    const question = document.createElement('div');
    question.className = 'cat-bubble-question';
    question.textContent = copy.question;

    const note = document.createElement('div');
    note.className = 'cat-bubble-note';
    note.textContent = copy.note;

    bubble.appendChild(main);
    bubble.appendChild(question);
    bubble.appendChild(note);
    return bubble;
  }

  function renderCat(minutes, options = {}) {
    if (document.getElementById('cat-guard-root')) return;

    const repeatMin = Number(options.repeatIntervalMin) || 10;
    const reminderIndex = Math.max(1, Number(options.reminderIndex) || 1);
    const isPreview = Boolean(options.preview);
    const copy = getReminderCopy(reminderIndex, minutes);

    const root = document.createElement('div');
    root.id = 'cat-guard-root';
    root.dataset.preview = isPreview ? 'true' : 'false';
    root.dataset.stage = String(reminderIndex);
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'cat-guard-message');

    const panel = document.createElement('div');
    panel.className = 'cat-panel';

    const bubble = buildBubble(copy);

    const body = document.createElement('div');
    body.className = `cat-body cat-face-${copy.face}`;
    body.appendChild(buildCatImage(copy.face));

    const actions = document.createElement('div');
    actions.className = 'cat-actions';

    const btnContinue = document.createElement('button');
    btnContinue.className = 'cat-btn cat-btn-later';
    btnContinue.innerHTML = `<span class="cat-btn-icon" aria-hidden="true">◷</span><span>再看 ${repeatMin} 分钟</span>`;

    const btnLeave = document.createElement('button');
    btnLeave.className = 'cat-btn cat-btn-leave';
    btnLeave.innerHTML = '<span class="cat-btn-icon cat-book-icon" aria-hidden="true">▣</span><span>好，这就去写论文</span>';

    const footer = document.createElement('div');
    footer.className = 'cat-footer';
    footer.textContent = '少看一会儿，和更好的自己多待一会儿 ♡';

    const status = document.createElement('div');
    status.className = 'cat-status';
    status.setAttribute('aria-live', 'polite');
    if (isPreview) {
      status.textContent = '预览模式 · 两个按钮只会关闭预览，不影响计时或标签页';
    }

    const setBusy = (busy) => {
      btnContinue.disabled = busy;
      btnLeave.disabled = busy;
      root.classList.toggle('cat-busy', busy);
    };

    btnContinue.addEventListener('click', async () => {
      if (isPreview) {
        removeOverlay({ resume: true });
        return;
      }

      setBusy(true);
      status.textContent = `好，橘猫给你再留 ${repeatMin} 分钟。`;
      const response = await sendAction('continue');

      if (response?.ok) {
        removeOverlay({ resume: true });
        return;
      }

      setBusy(false);
      status.textContent = '刚才没有保存成功，再点一次试试～';
    });

    btnLeave.addEventListener('click', async () => {
      if (isPreview) {
        removeOverlay({ resume: true });
        return;
      }

      setBusy(true);
      status.textContent = '好，橘猫帮你把这一页关掉。';
      const response = await sendAction('leave');

      if (!response?.ok) {
        setBusy(false);
        status.textContent = '这一页没能关掉，再点一次试试～';
      }
    });

    actions.appendChild(btnContinue);
    actions.appendChild(btnLeave);

    panel.appendChild(bubble);
    panel.appendChild(body);
    panel.appendChild(actions);
    panel.appendChild(footer);
    panel.appendChild(status);
    root.appendChild(panel);

    root.addEventListener('click', (e) => {
      if (e.target === root) nudgePanel();
    });

    root.addEventListener('keydown', (e) => e.stopPropagation());

    document.body.appendChild(root);
    lockPage();

    activeKeydownHandler = (e) => {
      if (!document.getElementById('cat-guard-root')) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        nudgePanel();
        return;
      }

      if (e.key !== 'Tab') return;

      const focusable = [btnContinue, btnLeave].filter((btn) => !btn.disabled);
      if (!focusable.length) {
        e.preventDefault();
        return;
      }

      const currentIndex = focusable.indexOf(document.activeElement);
      let nextIndex;

      if (e.shiftKey) {
        nextIndex = currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1;
      } else {
        nextIndex = currentIndex === focusable.length - 1 ? 0 : currentIndex + 1;
      }

      e.preventDefault();
      focusable[nextIndex].focus();
    };

    document.addEventListener('keydown', activeKeydownHandler, true);
    setTimeout(() => btnContinue.focus({ preventScroll: true }), 0);
  }

  function showReminder(msg) {
    const existing = document.getElementById('cat-guard-root');
    if (existing) {
      if (!msg.preview && existing.dataset.preview === 'true') {
        removeOverlay({ resume: false, animate: false });
      } else {
        pausePageMedia();
        return;
      }
    }

    const minutes = typeof msg.minutes === 'number' && msg.minutes > 0 ? msg.minutes : 30;

    renderCat(minutes, {
      repeatIntervalMin: msg.repeatIntervalMin,
      reminderIndex: msg.reminderIndex,
      preview: Boolean(msg.preview)
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SHOW_CAT' || msg.type === 'ENSURE_CAT') {
      if (typeof msg.minutes === 'number' && msg.minutes > 0) {
        showReminder(msg);
      } else {
        chrome.storage.local.get(['threshold'], (data) => {
          showReminder({ ...msg, minutes: data.threshold || 30 });
        });
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'HIDE_CAT') {
      if (document.getElementById('cat-guard-root')) {
        removeOverlay({ resume: Boolean(msg.resume) });
      }
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;

    if (changes.enabled?.newValue === false || changes.threshold) {
      if (document.getElementById('cat-guard-root')) {
        removeOverlay({ resume: true });
      }
    }
  });

  console.log('[CatGuard] content script v0.5.0 已就绪，等待全屏提醒');
}
