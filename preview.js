window.__catGuardPreviewPage = true;

      for (let i = 0; i < 6; i++) {
        const rec = document.createElement('div');
        rec.className = 'rec';
        rec.innerHTML = '<div class="thumb"></div><div class="lines"><div class="line"></div><div class="line" style="width:72%"></div></div>';
        document.getElementById('recommendations').appendChild(rec);
      }

      let catMessageListener = null;
      window.chrome = {
        runtime: {
          onMessage: { addListener(fn) { catMessageListener = fn; } },
          sendMessage() {},
          getURL(path) { return path; },
          lastError: null
        },
        storage: {
          local: {
            get(keys, cb) {
              const value = { threshold: 30 };
              if (typeof cb === 'function') cb(value);
              return Promise.resolve(value);
            }
          },
          onChanged: { addListener() {} }
        }
      };

      function showStage(stage) {
        if (!catMessageListener) return;
        const old = document.getElementById('cat-guard-root');
        if (old) catMessageListener({ type: 'HIDE_CAT', resume: true }, {}, () => {});
        const minutes = stage === 1 ? 30 : stage === 2 ? 40 : stage === 3 ? 50 : 60;
        catMessageListener(
          {
            type: 'SHOW_CAT',
            preview: true,
            reminderIndex: stage,
            minutes,
            repeatIntervalMin: 10
          },
          {},
          () => {}
        );
      }

      document.querySelectorAll('[data-stage]').forEach((button) => {
        button.addEventListener('click', () => showStage(Number(button.dataset.stage)));
      });
