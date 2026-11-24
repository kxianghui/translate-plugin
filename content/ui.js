'use strict';

// 页面内 UI：悬浮按钮 / 输入面板 / 划词卡片 / 状态提示
// 全部放在 closed Shadow DOM 里，避免与页面样式互相污染。
(function () {
  if (window.TpUI) return;

  const HOST_ID = 'tp-root';

  const ERROR_TEXT = {
    NO_CONFIG: '尚未配置翻译服务，点击下方“打开设置”填写 Base URL、API Key 和模型。',
    AUTH: '认证失败，请检查 API Key 是否正确。',
    RATE_LIMIT: '请求过于频繁，请稍后再试。',
    TIMEOUT: '翻译请求超时，请稍后重试。',
    NETWORK: '无法连接翻译服务，请检查网络或刷新页面。',
    BAD_RESPONSE: '模型返回内容无法解析，请重试。',
    SERVER: '翻译服务暂时不可用，请稍后重试。',
  };

  const CSS = `
    :host { all: initial; }
    *[hidden] { display: none !important; }
    * { box-sizing: border-box; }
    .tp-fab, .tp-panel, .tp-card, .tp-status, .tp-selbtn {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #1f2328;
    }
    .tp-fab {
      position: fixed; right: 20px; bottom: 20px;
      width: 48px; height: 48px; border-radius: 50%;
      border: none; background: #2563eb; color: #fff;
      font-size: 20px; font-weight: 700; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; pointer-events: auto;
      box-shadow: 0 6px 20px rgba(37, 99, 235, .4);
      transition: transform .15s, background .15s;
    }
    .tp-fab:hover { background: #1d4ed8; transform: translateY(-2px); }

    .tp-selbtn {
      position: fixed; width: 30px; height: 30px; border-radius: 50%;
      border: none; background: #2563eb; color: #fff;
      font-size: 13px; font-weight: 700; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; pointer-events: auto; z-index: 3;
      box-shadow: 0 4px 14px rgba(37, 99, 235, .45);
      transition: transform .12s, background .12s;
    }
    .tp-selbtn:hover { background: #1d4ed8; transform: scale(1.08); }

    .tp-panel {
      position: fixed; right: 20px; bottom: 80px;
      width: 340px; max-width: calc(100vw - 40px);
      background: #fff; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .18);
      padding: 14px; pointer-events: auto;
    }
    .tp-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .tp-panel-title { font-size: 14px; font-weight: 700; }
    .tp-x {
      width: 26px; height: 26px; border: none; background: transparent;
      font-size: 18px; line-height: 1; color: #6b7280; cursor: pointer; border-radius: 6px;
    }
    .tp-x:hover { background: #f3f4f6; color: #1f2328; }
    .tp-input {
      width: 100%; resize: vertical; min-height: 66px;
      padding: 9px 10px; font-size: 14px; line-height: 1.5;
      border: 1px solid #d0d5dd; border-radius: 9px; outline: none;
      font-family: inherit; color: inherit; background: #fff;
    }
    .tp-input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .12); }
    .tp-row { display: flex; justify-content: flex-end; margin-top: 8px; }
    .tp-btn {
      padding: 7px 14px; font-size: 13px; border-radius: 8px;
      border: 1px solid #d0d5dd; background: #fff; color: #1f2328;
      cursor: pointer; font-family: inherit;
    }
    .tp-btn:hover { background: #f3f4f6; }
    .tp-btn.tp-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    .tp-btn.tp-primary:hover { background: #1d4ed8; }
    .tp-btn:disabled { opacity: .55; cursor: default; }
    .tp-result {
      margin-top: 10px; max-height: 200px; overflow: auto;
      padding: 10px; border-radius: 9px; background: #f6f8fb;
      font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
    }
    .tp-panel-foot { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .tp-panel-status { margin-top: 10px; font-size: 12.5px; line-height: 1.55; color: #b42318; word-break: break-word; }
    .tp-panel-status .tp-link { color: #2563eb; text-decoration: underline; cursor: pointer; background: none; border: none; font: inherit; padding: 0; }

    .tp-card {
      position: fixed; width: 320px; max-width: calc(100vw - 24px);
      background: #fff; border-radius: 12px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, .2);
      padding: 12px; pointer-events: auto; z-index: 2;
    }
    .tp-card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .tp-card-title { font-size: 12px; font-weight: 700; color: #2563eb; letter-spacing: .3px; }
    .tp-card-original {
      font-size: 12px; color: #6b7280; line-height: 1.5; margin-bottom: 8px;
      padding-bottom: 8px; border-bottom: 1px dashed #e5e7eb;
      max-height: 72px; overflow: auto; white-space: pre-wrap; word-break: break-word;
    }
    .tp-card-body { font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
    .tp-card-body.tp-loading { color: #6b7280; font-size: 13px; }
    .tp-card-body.tp-error { color: #b42318; font-size: 13px; }
    .tp-card-foot { display: flex; justify-content: flex-end; margin-top: 10px; }

    .tp-status {
      position: fixed; left: 50%; transform: translateX(-50%); bottom: 22px;
      max-width: 70vw; padding: 8px 14px; border-radius: 999px;
      background: rgba(31, 35, 40, .92); color: #fff; font-size: 13px; line-height: 1.4;
      pointer-events: none; box-shadow: 0 6px 20px rgba(0, 0, 0, .2);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .tp-status.tp-status-error { background: #b42318; }

    @keyframes tp-spin { to { transform: rotate(360deg); } }
    .tp-spin {
      display: inline-block; width: 12px; height: 12px; margin-right: 6px;
      border: 2px solid #c7d2fe; border-top-color: #2563eb; border-radius: 50%;
      animation: tp-spin .7s linear infinite; vertical-align: -2px;
    }
  `;

  const state = {
    host: null,
    shadow: null,
    callbacks: {},
    fab: null,
    panel: null,
    panelVisible: false,
    input: null,
    result: null,
    panelStatus: null,
    translateBtn: null,
    busy: false,
    card: null,
    cardOriginal: null,
    cardBody: null,
    cardCopy: null,
    cardRect: null,
    cardTranslation: '',
    selBtn: null,
    selTrigger: null,
    statusEl: null,
    statusTimer: null,
  };

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'on') {
          for (const ev of Object.keys(value)) node.addEventListener(ev, value[ev]);
        } else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
      }
    }
    for (const child of children) if (child) node.appendChild(child);
    return node;
  }

  function friendly(err) {
    if (!err) return '翻译失败。';
    return ERROR_TEXT[err.code] || err.message || '翻译失败。';
  }

  // -------------------------------------------------------------------------
  // 构建 UI
  // -------------------------------------------------------------------------
  function init(callbacks) {
    if (state.host) return;
    state.callbacks = callbacks || {};

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important;' +
      'z-index: 2147483647 !important; pointer-events: none !important; display: block !important;';

    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    buildFab(shadow);
    buildPanel(shadow);
    buildCard(shadow);
    buildSelectionTrigger(shadow);

    state.statusEl = el('div', { class: 'tp-status', hidden: true });
    shadow.appendChild(state.statusEl);

    (document.body || document.documentElement).appendChild(host);
    state.host = host;
    state.shadow = shadow;
  }

  function buildFab(shadow) {
    state.fab = el('button', {
      class: 'tp-fab',
      title: '大模型网页翻译',
      text: '译',
      on: { click: togglePanel },
    });
    shadow.appendChild(state.fab);
  }

  function buildPanel(shadow) {
    state.input = el('textarea', {
      class: 'tp-input',
      placeholder: '输入要翻译的文字，Ctrl+Enter 翻译',
      rows: 3,
      on: {
        keydown: (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            runPanelTranslate();
          }
        },
      },
    });

    state.result = el('div', { class: 'tp-result', hidden: true });
    state.panelStatus = el('div', { class: 'tp-panel-status', hidden: true });
    state.translateBtn = el('button', {
      class: 'tp-btn tp-primary',
      text: '翻译',
      on: { click: runPanelTranslate },
    });

    const panel = el(
      'div',
      { class: 'tp-panel', hidden: true },
      el(
        'div',
        { class: 'tp-panel-head' },
        el('span', { class: 'tp-panel-title', text: '网页翻译' }),
        el('button', { class: 'tp-x', title: '关闭', text: '×', on: { click: hidePanel } })
      ),
      state.input,
      el('div', { class: 'tp-row' }, state.translateBtn),
      state.result,
      el(
        'div',
        { class: 'tp-panel-foot' },
        el('button', { class: 'tp-btn', text: '整页翻译', on: { click: onTranslatePage } }),
        el('button', { class: 'tp-btn', text: '还原原文', on: { click: onRestorePage } }),
        el('button', { class: 'tp-btn', text: '设置', on: { click: openOptions } })
      ),
      state.panelStatus
    );

    state.panel = panel;
    shadow.appendChild(panel);
  }

  function buildCard(shadow) {
    state.cardOriginal = el('div', { class: 'tp-card-original' });
    state.cardBody = el('div', { class: 'tp-card-body' });
    state.cardCopy = el('button', {
      class: 'tp-btn',
      text: '复制译文',
      on: { click: copyCardTranslation },
    });

    const card = el(
      'div',
      { class: 'tp-card', hidden: true },
      el(
        'div',
        { class: 'tp-card-head' },
        el('span', { class: 'tp-card-title', text: '翻译' }),
        el('button', { class: 'tp-x', title: '关闭', text: '×', on: { click: hideCard } })
      ),
      state.cardOriginal,
      state.cardBody,
      el('div', { class: 'tp-card-foot' }, state.cardCopy)
    );

    state.card = card;
    shadow.appendChild(card);
  }

  function buildSelectionTrigger(shadow) {
    state.selBtn = el('button', {
      class: 'tp-selbtn',
      title: '翻译选中文字',
      text: '译',
      hidden: true,
      on: { click: onSelBtnClick },
    });
    shadow.appendChild(state.selBtn);
  }

  function onSelBtnClick() {
    const cb = state.selTrigger;
    hideSelectionTrigger();
    if (cb) cb();
  }

  function showSelectionTrigger(rect, onTrigger) {
    state.selTrigger = onTrigger || null;
    const btn = state.selBtn;
    btn.hidden = false;

    const w = btn.offsetWidth || 30;
    const h = btn.offsetHeight || 30;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.right + 6;
    let top = rect.bottom + 6;
    if (left + w > vw - 8) left = rect.right - w;
    if (top + h > vh - 8) top = rect.top - h - 6;

    left = Math.max(8, Math.min(left, vw - w - 8));
    top = Math.max(8, Math.min(top, vh - h - 8));

    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
  }

  function hideSelectionTrigger() {
    state.selTrigger = null;
    if (state.selBtn) state.selBtn.hidden = true;
  }

  // -------------------------------------------------------------------------
  // 面板行为
  // -------------------------------------------------------------------------
  function togglePanel() {
    if (state.panelVisible) hidePanel();
    else showPanel();
  }

  function showPanel() {
    state.panelVisible = true;
    state.panel.hidden = false;
    state.input.focus();
  }

  function hidePanel() {
    state.panelVisible = false;
    state.panel.hidden = true;
  }

  function setPanelStatus(text, asError) {
    const node = state.panelStatus;
    while (node.firstChild) node.removeChild(node.firstChild);
    if (!text) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.style.color = asError ? '#b42318' : '#6b7280';
    node.appendChild(document.createTextNode(text));
  }

  function setPanelError(text, withOptionsLink) {
    const node = state.panelStatus;
    while (node.firstChild) node.removeChild(node.firstChild);
    node.hidden = false;
    node.style.color = '#b42318';
    node.appendChild(document.createTextNode(text));
    if (withOptionsLink) {
      node.appendChild(document.createTextNode(' '));
      node.appendChild(
        el('button', { class: 'tp-link', text: '打开设置', on: { click: openOptions } })
      );
    }
  }

  async function runPanelTranslate() {
    if (state.busy) return;
    const text = state.input.value.trim();
    if (!text) return;

    state.busy = true;
    state.translateBtn.disabled = true;
    state.result.hidden = true;
    setPanelStatus('翻译中…', false);

    try {
      const res = await state.callbacks.onTranslateText(text);
      if (res && res.ok) {
        state.result.textContent = res.translation;
        state.result.hidden = false;
        setPanelStatus('');
      } else {
        const err = res && res.error;
        setPanelError(friendly(err), err && err.code === 'NO_CONFIG');
      }
    } catch (e) {
      setPanelError('翻译失败：' + (e && e.message ? e.message : String(e)), false);
    } finally {
      state.busy = false;
      state.translateBtn.disabled = false;
    }
  }

  function onTranslatePage() {
    if (state.callbacks.onTranslatePage) state.callbacks.onTranslatePage();
  }

  function onRestorePage() {
    if (state.callbacks.onRestorePage) state.callbacks.onRestorePage();
  }

  function openOptions() {
    if (state.callbacks.onOpenOptions) state.callbacks.onOpenOptions();
  }

  // -------------------------------------------------------------------------
  // 划词卡片
  // -------------------------------------------------------------------------
  function showCard(opts) {
    opts = opts || {};
    const card = state.card;
    if (opts.rect) state.cardRect = opts.rect;

    state.cardOriginal.textContent = opts.original || '';
    state.cardTranslation = '';
    state.cardCopy.hidden = true;

    const body = state.cardBody;
    body.className = 'tp-card-body';

    if (opts.state === 'loading') {
      while (body.firstChild) body.removeChild(body.firstChild);
      body.classList.add('tp-loading');
      body.appendChild(el('span', { class: 'tp-spin' }));
      body.appendChild(document.createTextNode('翻译中…'));
    } else if (opts.state === 'error') {
      body.classList.add('tp-error');
      body.textContent = opts.error || '翻译失败。';
    } else {
      body.textContent = opts.translation || '';
      state.cardTranslation = opts.translation || '';
      state.cardCopy.hidden = !state.cardTranslation;
    }

    card.hidden = false;
    positionCard();
  }

  function hideCard() {
    if (state.card) state.card.hidden = true;
  }

  function positionCard() {
    const card = state.card;
    const rect = state.cardRect;
    if (!rect) return;

    // 先放到无障碍的位置测量尺寸
    card.style.left = '8px';
    card.style.top = '8px';
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left + rect.width / 2 - cw / 2;
    left = Math.max(8, Math.min(left, vw - cw - 8));

    let top = rect.bottom + 8;
    if (top + ch > vh - 8) {
      const above = rect.top - ch - 8;
      top = above >= 8 ? above : Math.max(8, vh - ch - 8);
    }

    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  async function copyCardTranslation() {
    const text = state.cardTranslation;
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {
      ok = fallbackCopy(text);
    }
    state.cardCopy.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => {
      state.cardCopy.textContent = '复制译文';
    }, 1500);
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      state.shadow.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 状态提示
  // -------------------------------------------------------------------------
  function setStatus(text, isError) {
    const node = state.statusEl;
    if (state.statusTimer) {
      clearTimeout(state.statusTimer);
      state.statusTimer = null;
    }
    if (!text) {
      node.hidden = true;
      return;
    }
    node.textContent = text;
    node.className = 'tp-status' + (isError ? ' tp-status-error' : '');
    node.hidden = false;
    if (isError) {
      state.statusTimer = setTimeout(() => {
        node.hidden = true;
      }, 4000);
    }
  }

  // -------------------------------------------------------------------------
  // 事件来源判定
  // -------------------------------------------------------------------------
  function isEventFromUI(event) {
    if (!state.host || !event || typeof event.composedPath !== 'function') return false;
    return event.composedPath().includes(state.host);
  }

  function isInsideUI(node) {
    if (!state.host || !node) return false;
    if (state.shadow && typeof node.getRootNode === 'function' && node.getRootNode() === state.shadow) {
      return true;
    }
    return state.host.contains(node);
  }

  window.TpUI = {
    init,
    togglePanel,
    showPanel,
    hidePanel,
    showCard,
    hideCard,
    showSelectionTrigger,
    hideSelectionTrigger,
    setStatus,
    isEventFromUI,
    isInsideUI,
  };
})();
