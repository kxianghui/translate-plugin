'use strict';

// 整页翻译（视口懒加载）+ 划词翻译 + 悬浮输入框翻译
(function () {
  const HOST_ID = 'tp-root';

  const EXCLUDE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CODE', 'PRE',
    'TEXTAREA', 'INPUT', 'SELECT', 'CANVAS', 'TEMPLATE',
  ]);
  const VOID_TAGS = new Set(['BR', 'IMG', 'HR', 'WBR']);

  const BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'DIV',
    'BLOCKQUOTE', 'FIGCAPTION', 'DT', 'DD', 'SUMMARY',
  ]);
  const BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,td,th,div,blockquote,figcaption,dt,dd,summary';

  const MAX_SEGMENT_CHARS = 4000;
  const MAX_BATCH_ITEMS = 20;
  const MAX_BATCH_CHARS = 1800;
  const MAX_CONCURRENT = 1;
  const BATCH_DEBOUNCE_MS = 200;
  const SELECTION_DEBOUNCE_MS = 350;
  const MAX_SELECTION_CHARS = 1500;

  const ERROR_TEXT = {
    NO_CONFIG: '尚未配置翻译服务，请先在设置中填写 Base URL、API Key 和模型。',
    AUTH: '认证失败，请检查 API Key 是否正确。',
    RATE_LIMIT: '请求过于频繁，请稍后再试。',
    TIMEOUT: '翻译请求超时，请稍后重试。',
    NETWORK: '网络连接失败，请检查网络后重试。',
    BAD_RESPONSE: '模型返回内容无法解析，请重试。',
    SERVER: '翻译服务暂时不可用，请稍后重试。',
  };

  let targetLang = '简体中文';
  let selectionTimer = null;
  let selectionReqId = 0;

  const page = {
    active: false,
    observer: null,
    snapshots: new Map(),
    infoByEl: new WeakMap(),
    queue: [],
    inFlight: 0,
    batchTimer: null,
    generation: 0,
    translatedCount: 0,
    failedCount: 0,
    totalBlocks: 0,
  };

  // -------------------------------------------------------------------------
  // 配置
  // -------------------------------------------------------------------------
  try {
    chrome.storage.local.get({ targetLang: '简体中文' }, (s) => {
      if (s && s.targetLang) targetLang = s.targetLang;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.targetLang && changes.targetLang.newValue) {
        targetLang = changes.targetLang.newValue;
      }
    });
  } catch (_) {}

  // -------------------------------------------------------------------------
  // 与后台通信
  // -------------------------------------------------------------------------
  function sendTranslate(texts) {
    return new Promise((resolve) => {
      const attempt = (n) => {
        try {
          chrome.runtime.sendMessage({ type: 'translate', texts }, (resp) => {
            const failed = chrome.runtime.lastError || resp === undefined;
            if (failed) {
              if (n === 0) {
                setTimeout(() => attempt(1), 300);
              } else {
                resolve({ ok: false, error: { code: 'NETWORK', message: '无法连接扩展后台，请刷新页面后重试' } });
              }
              return;
            }
            resolve(resp);
          });
        } catch (_) {
          if (n === 0) {
            setTimeout(() => attempt(1), 300);
          } else {
            resolve({ ok: false, error: { code: 'NETWORK', message: '扩展已重新加载，请刷新页面' } });
          }
        }
      };
      attempt(0);
    });
  }

  function errorText(err) {
    if (!err) return '翻译失败。';
    return ERROR_TEXT[err.code] || err.message || '翻译失败。';
  }

  async function translatePanelText(text) {
    const resp = await sendTranslate([text]);
    if (resp && resp.ok && Array.isArray(resp.translations) && typeof resp.translations[0] === 'string') {
      return { ok: true, translation: resp.translations[0] };
    }
    return { ok: false, error: (resp && resp.error) || { code: 'NETWORK', message: '翻译失败' } };
  }

  // -------------------------------------------------------------------------
  // 初始化 UI
  // -------------------------------------------------------------------------
  window.TpUI.init({
    onTranslateText: translatePanelText,
    onTranslatePage: startPageTranslation,
    onRestorePage: restorePage,
    onOpenOptions: () => {
      try {
        chrome.runtime.sendMessage({ type: 'open-options' });
      } catch (_) {}
    },
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'toggle-panel') window.TpUI.togglePanel();
    else if (msg.type === 'toggle-page') togglePageTranslation();
  });

  // -------------------------------------------------------------------------
  // 候选块收集
  // -------------------------------------------------------------------------
  function isExcludedEl(el) {
    if (!el || el.nodeType !== 1) return true;
    if (EXCLUDE_TAGS.has(el.tagName)) return true;
    if (VOID_TAGS.has(el.tagName)) return true;
    if (el.id === HOST_ID) return true;
    if (el.hasAttribute('data-tp-translated')) return true;
    const ce = el.getAttribute('contenteditable');
    if (ce !== null && ce !== 'false') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.getAttribute('translate') === 'no') return true;
    return false;
  }

  function hasBlockDescendant(el) {
    return el.querySelector(BLOCK_SELECTOR) !== null;
  }

  function isMeaningful(str) {
    return !!str && /\p{L}/u.test(str);
  }

  // 没有渲染盒（display:none、折叠菜单、隐藏标签页等）的元素永远不会触发
  // IntersectionObserver，若计入总数会导致进度永远走不满，直接跳过。
  function isRendered(el) {
    return !!(el && el.getClientRects && el.getClientRects().length > 0);
  }

  function collectCandidates() {
    const out = [];
    if (!document.body) return out;
    collectInto(document.body, out);
    return out;
  }

  function collectInto(el, out) {
    if (isExcludedEl(el)) return;
    if (!hasBlockDescendant(el)) {
      if (isRendered(el)) out.push(el);
      return;
    }
    const children = Array.from(el.childNodes);
    let canWrap;
    for (const node of children) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (isMeaningful(node.nodeValue)) {
          if (canWrap === undefined) canWrap = isRendered(el);
          if (canWrap) {
            const span = document.createElement('span');
            span.setAttribute('data-tp-wrapped', '');
            node.parentNode.insertBefore(span, node);
            span.appendChild(node);
            out.push(span);
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        collectInto(node, out);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 语言跳过
  // -------------------------------------------------------------------------
  function shouldSkipByLanguage(el) {
    const text = el.textContent || '';
    const letters = text.match(/\p{L}/gu);
    if (!letters || letters.length < 2) return true;
    const total = letters.length;

    if (/中文|汉语|漢語|简体|繁体|chinese|zh/i.test(targetLang)) {
      const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
      if (han / total > 0.5) return true;
    } else if (/英文|英语|english|en\b/i.test(targetLang)) {
      const latin = (text.match(/[A-Za-z]/g) || []).length;
      if (latin / total > 0.5) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 序列化：文本节点转义，行内元素包成 <tpN>…</tpN>
  // -------------------------------------------------------------------------
  function escapeText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function decodeEntities(s) {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&#x0*27;/gi, "'")
      .replace(/&amp;/g, '&');
  }

  function piecesToString(pieces) {
    let out = '';
    for (const p of pieces) out += p.kind === 'text' ? p.value : p.markup;
    return out;
  }

  function buildPieces(nodes, markers, counter) {
    const pieces = [];
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue) pieces.push({ kind: 'text', value: escapeText(node.nodeValue) });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const opaque = EXCLUDE_TAGS.has(node.tagName) || VOID_TAGS.has(node.tagName);
        const id = counter.v++;
        markers.set(id, { node, opaque });
        if (opaque) {
          pieces.push({ kind: 'marker', id, markup: `<tp${id}></tp${id}>` });
        } else {
          const inner = buildPieces(node.childNodes, markers, counter);
          pieces.push({ kind: 'marker', id, markup: `<tp${id}>${piecesToString(inner)}</tp${id}>` });
        }
      }
    }
    return pieces;
  }

  function serializeBlock(el) {
    const markers = new Map();
    const counter = { v: 1 };
    const pieces = buildPieces(el.childNodes, markers, counter);
    return { pieces, text: piecesToString(pieces), markers };
  }

  function splitSentences(s) {
    const out = [];
    const re = /[.!?。！？；;…]+[\s"'”’)\]]*/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      out.push(s.slice(last, re.lastIndex));
      last = re.lastIndex;
    }
    if (last < s.length) out.push(s.slice(last));
    return out.length ? out : [s];
  }

  function makeSegments(pieces) {
    const full = piecesToString(pieces);
    if (full.length <= MAX_SEGMENT_CHARS) return [full];

    const segments = [];
    let buf = [];
    let len = 0;
    const flush = () => {
      if (buf.length) {
        segments.push(piecesToString(buf));
        buf = [];
        len = 0;
      }
    };

    for (const p of pieces) {
      if (p.kind === 'marker') {
        const mlen = p.markup.length;
        if (len > 0 && len + mlen > MAX_SEGMENT_CHARS) flush();
        buf.push(p);
        len += mlen;
        continue;
      }
      for (const sentence of splitSentences(p.value)) {
        if (len > 0 && len + sentence.length > MAX_SEGMENT_CHARS) flush();
        buf.push({ kind: 'text', value: sentence });
        len += sentence.length;
      }
    }
    flush();
    return segments;
  }

  function makeBlockInfo(el) {
    const { pieces, text, markers } = serializeBlock(el);
    if (!/\p{L}/u.test(text)) return null;
    const segments = makeSegments(pieces);
    if (!segments.length) return null;
    return {
      el,
      segments,
      markers,
      results: new Array(segments.length).fill(undefined),
      status: 'pending',
      lastTranslation: '',
    };
  }

  // -------------------------------------------------------------------------
  // 重建：解析译文标记，复用原行内节点
  // -------------------------------------------------------------------------
  function normalizeMarkers(s) {
    let out = String(s);
    out = out.replace(/＜/g, '<').replace(/＞/g, '>').replace(/／/g, '/');
    out = out.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    out = out.replace(/<\s*(\/?)\s*tp\s*(\d+)\s*>/gi, (_m, slash, n) => `<${slash}tp${n}>`);
    return out;
  }

  function parseMarkup(s) {
    const re = /<(\/?)tp(\d+)>/g;
    const root = [];
    const stack = [{ type: 'root', children: root }];
    const ids = new Set();
    let duplicate = false;
    let error = null;
    let last = 0;
    let m;

    while ((m = re.exec(s))) {
      const text = s.slice(last, m.index);
      if (text) stack[stack.length - 1].children.push({ type: 'text', value: text });

      const closing = m[1] === '/';
      const id = Number(m[2]);
      if (!closing) {
        if (ids.has(id)) duplicate = true;
        ids.add(id);
        const tok = { type: 'marker', id, children: [] };
        stack[stack.length - 1].children.push(tok);
        stack.push(tok);
      } else {
        const top = stack[stack.length - 1];
        if (top.type !== 'marker' || top.id !== id) {
          error = 'marker-mismatch';
          break;
        }
        stack.pop();
      }
      last = re.lastIndex;
    }

    if (!error) {
      const tail = s.slice(last);
      if (tail) stack[stack.length - 1].children.push({ type: 'text', value: tail });
      if (stack.length !== 1) error = 'unclosed';
    }

    return { tokens: root, ids, duplicate, error };
  }

  function buildTokens(tokens, parent, markers) {
    for (const tok of tokens) {
      if (tok.type === 'text') {
        const text = decodeEntities(tok.value);
        if (text) parent.appendChild(document.createTextNode(text));
      } else {
        const info = markers.get(tok.id);
        if (!info) continue;
        if (!info.opaque) {
          const sub = document.createDocumentFragment();
          buildTokens(tok.children, sub, markers);
          info.node.replaceChildren(sub);
        }
        parent.appendChild(info.node);
      }
    }
  }

  function tryRebuild(info, translated) {
    const parsed = parseMarkup(normalizeMarkers(translated));
    if (parsed.error || parsed.duplicate) return false;
    if (parsed.ids.size !== info.markers.size) return false;
    for (const id of info.markers.keys()) {
      if (!parsed.ids.has(id)) return false;
    }

    for (const m of info.markers.values()) {
      if (m.node.parentNode) m.node.remove();
    }

    const frag = document.createDocumentFragment();
    buildTokens(parsed.tokens, frag, info.markers);
    info.el.replaceChildren(frag);
    info.el.setAttribute('data-tp-translated', '1');
    return true;
  }

  function stripMarkup(s) {
    return decodeEntities(String(s).replace(/<\/?tp\d+>/gi, ''));
  }

  // -------------------------------------------------------------------------
  // 整页翻译：扫描 + 懒加载 + 攒批
  // -------------------------------------------------------------------------
  function togglePageTranslation() {
    if (page.active) restorePage();
    else startPageTranslation();
  }

  function startPageTranslation() {
    if (!document.body) return;
    if (page.active) {
      window.TpUI.setStatus('整页翻译已在进行中，可点击“还原原文”');
      return;
    }

    const candidates = collectCandidates();
    if (!candidates.length) {
      unwrapWrappers();
      window.TpUI.setStatus('没有找到可翻译的文本');
      return;
    }

    page.generation++;
    page.active = true;
    page.snapshots = new Map();
    page.infoByEl = new WeakMap();
    page.queue = [];
    page.inFlight = 0;
    page.translatedCount = 0;
    page.failedCount = 0;
    page.totalBlocks = 0;
    if (page.batchTimer) {
      clearTimeout(page.batchTimer);
      page.batchTimer = null;
    }

    page.observer = new IntersectionObserver(onIntersect, {
      root: null,
      rootMargin: '0px 0px 100% 0px',
      threshold: 0,
    });

    for (const el of candidates) {
      if (shouldSkipByLanguage(el)) continue;
      const info = makeBlockInfo(el);
      if (!info) continue;
      snapshotSubtree(el);
      page.infoByEl.set(el, info);
      page.totalBlocks++;
      page.observer.observe(el);
    }

    if (page.totalBlocks === 0) {
      page.active = false;
      page.observer.disconnect();
      page.observer = null;
      unwrapWrappers();
      window.TpUI.setStatus('没有需要翻译的文本');
      return;
    }

    console.log(`[tp] page start blocks=${page.totalBlocks}`);
    window.TpUI.setStatus(`准备翻译 ${page.totalBlocks} 段…`);
  }

  function snapshotSubtree(el) {
    const visit = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (page.snapshots.has(node)) return;
      page.snapshots.set(node, Array.from(node.childNodes));
      for (const child of node.children) visit(child);
    };
    visit(el);
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      page.observer.unobserve(entry.target);
      enqueueBlock(entry.target);
    }
  }

  function enqueueBlock(el) {
    const info = page.infoByEl.get(el);
    if (!info || info.status !== 'pending') return;
    info.status = 'queued';
    const dist = distanceFromCenter(el);
    for (let i = 0; i < info.segments.length; i++) {
      const text = info.segments[i];
      insertJob({ info, segIndex: i, text, retry: false, exclusive: text.length > MAX_BATCH_CHARS, dist });
    }
    scheduleBatch();
  }

  function distanceFromCenter(el) {
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - window.innerWidth / 2;
    const dy = r.top + r.height / 2 - window.innerHeight / 2;
    return dx * dx + dy * dy;
  }

  // 队列按与视口中心的距离升序，保证先翻离视口最近的块
  function insertJob(job) {
    let i = page.queue.length;
    while (i > 0) {
      const prev = page.queue[i - 1];
      if (prev.retry || prev.dist <= job.dist) break;
      i--;
    }
    page.queue.splice(i, 0, job);
  }

  function scheduleBatch() {
    if (page.batchTimer || page.inFlight >= MAX_CONCURRENT) return;
    page.batchTimer = setTimeout(() => {
      page.batchTimer = null;
      flushQueue();
    }, BATCH_DEBOUNCE_MS);
  }

  function flushQueue() {
    // 填满并发槽位：最多 MAX_CONCURRENT 个请求在途
    while (page.inFlight < MAX_CONCURRENT && page.queue.length > 0) {
      const taken = [];
      let chars = 0;
      while (page.queue.length > 0 && taken.length < MAX_BATCH_ITEMS) {
        const job = page.queue[0];
        if (job.exclusive) {
          if (taken.length === 0) taken.push(page.queue.shift());
          break;
        }
        if (taken.length > 0 && chars + job.text.length > MAX_BATCH_CHARS) break;
        page.queue.shift();
        taken.push(job);
        chars += job.text.length;
      }

      if (taken.length === 0) break;
      runJobs(taken);
    }
  }

  function runJobs(jobs) {
    const gen = page.generation;
    page.inFlight++;
    const chars = jobs.reduce((sum, j) => sum + j.text.length, 0);
    console.log(`[tp] batch send segments=${jobs.length} chars=${chars} inFlight=${page.inFlight}`);
    sendTranslate(jobs.map((j) => j.text))
      .then((resp) => {
        // 先判代次：还原/重开会重置 inFlight，旧代次的响应不得再改计数与状态
        if (gen !== page.generation) return;
        page.inFlight--;

        if (!resp || resp.ok !== true) {
          const err = (resp && resp.error) || { code: 'NETWORK', message: '翻译失败' };
          console.warn(`[tp] batch failed code=${err.code || '?'} message=${err.message || ''}`);
          for (const job of jobs) onJobFailed(job);
          window.TpUI.setStatus('翻译失败：' + errorText(err), true);
          if (page.queue.length > 0) scheduleBatch();
        } else {
          const translations = Array.isArray(resp.translations) ? resp.translations : [];
          let ok = 0;
          for (let k = 0; k < jobs.length; k++) {
            const tr = translations[k];
            if (typeof tr === 'string' && tr) ok++;
            onJobResult(jobs[k], typeof tr === 'string' && tr ? tr : null);
          }
          console.log(`[tp] batch done ok=${ok}/${jobs.length}`);
          if (page.queue.length > 0) scheduleBatch();
          else maybeIdleHint();
        }
      })
      .catch((e) => {
        if (gen !== page.generation) return;
        page.inFlight--;
        for (const job of jobs) onJobFailed(job);
        window.TpUI.setStatus('翻译失败：' + errorText({ code: 'NETWORK', message: String(e) }), true);
        if (page.queue.length > 0) scheduleBatch();
      });
  }

  function failBlock(info) {
    if (info.status === 'done' || info.status === 'failed') return;
    info.status = 'failed';
    page.failedCount++;
    updateProgress();
  }

  function onJobFailed(job) {
    const info = job.info;
    if (info.status === 'done' || info.status === 'failed') return;
    if (job.retry) {
      finalizeFallback(info);
    } else {
      info.results[job.segIndex] = null;
      failBlock(info);
    }
  }

  function onJobResult(job, tr) {
    const info = job.info;
    if (info.status === 'done' || info.status === 'failed') return;

    if (tr == null) {
      if (job.retry) {
        finalizeFallback(info);
      } else {
        info.results[job.segIndex] = null;
        failBlock(info);
      }
      return;
    }

    if (job.retry) {
      info.lastTranslation = tr;
      if (tryRebuild(info, tr)) markDone(info);
      else finalizeFallback(info);
      return;
    }

    info.results[job.segIndex] = tr;
    if (info.results.some((r) => r === null)) {
      failBlock(info);
      return;
    }
    if (info.results.every((r) => typeof r === 'string')) {
      const joined = info.results.join('');
      info.lastTranslation = joined;
      if (tryRebuild(info, joined)) {
        markDone(info);
      } else {
        // 标记校验失败：该块整段单独重试一次
        info.status = 'queued';
        page.queue.unshift({ info, segIndex: -1, text: info.segments.join(''), retry: true, exclusive: true });
        scheduleBatch();
      }
    }
  }

  function markDone(info) {
    info.status = 'done';
    page.translatedCount++;
    updateProgress();
  }

  function finalizeFallback(info) {
    console.warn('[tp] 标记校验失败，该块回退为纯文本');
    try {
      info.el.replaceChildren(document.createTextNode(stripMarkup(info.lastTranslation || '')));
      info.el.setAttribute('data-tp-translated', '1');
    } catch (_) {}
    info.status = 'failed';
    page.translatedCount++;
    updateProgress();
  }

  function updateProgress() {
    const processed = page.translatedCount + page.failedCount;
    if (processed >= page.totalBlocks) {
      const failed = page.failedCount ? `（${page.failedCount} 段失败）` : '';
      window.TpUI.setStatus(`已翻译 ${page.translatedCount} 段${failed}`);
      const gen = page.generation;
      setTimeout(() => {
        if (gen === page.generation && page.active && page.translatedCount + page.failedCount >= page.totalBlocks) {
          window.TpUI.setStatus('');
        }
      }, 6000);
    } else {
      window.TpUI.setStatus(`翻译中… 已翻译 ${page.translatedCount}/${page.totalBlocks} 段`);
    }
  }

  // 队列与在途都清空、但仍有视口外未触发的块时，提示用户继续滚动（懒加载）
  function maybeIdleHint() {
    if (!page.active) return;
    if (page.queue.length > 0 || page.inFlight > 0) return;
    if (page.translatedCount + page.failedCount >= page.totalBlocks) return;
    window.TpUI.setStatus(`已翻译 ${page.translatedCount}/${page.totalBlocks} 段，滚动页面继续翻译`);
  }

  function restorePage() {
    if (!page.active && page.snapshots.size === 0) {
      window.TpUI.setStatus('没有可还原的内容');
      return;
    }

    page.generation++;
    page.active = false;
    console.log('[tp] restore page');
    if (page.observer) {
      page.observer.disconnect();
      page.observer = null;
    }
    if (page.batchTimer) {
      clearTimeout(page.batchTimer);
      page.batchTimer = null;
    }
    page.queue = [];
    page.inFlight = 0;

    for (const [el, nodes] of page.snapshots) {
      try {
        el.replaceChildren(...nodes);
      } catch (_) {}
      if (el.isConnected) el.removeAttribute('data-tp-translated');
    }
    page.snapshots = new Map();
    page.infoByEl = new WeakMap();
    page.translatedCount = 0;
    page.failedCount = 0;
    page.totalBlocks = 0;

    unwrapWrappers();
    window.TpUI.setStatus('已还原原文');
    setTimeout(() => window.TpUI.setStatus(''), 1500);
  }

  function unwrapWrappers() {
    const wrappers = document.querySelectorAll('span[data-tp-wrapped]');
    for (const w of wrappers) {
      const parent = w.parentNode;
      if (!parent) continue;
      while (w.firstChild) parent.insertBefore(w.firstChild, w);
      w.remove();
    }
  }

  // -------------------------------------------------------------------------
  // 划词翻译
  // -------------------------------------------------------------------------
  document.addEventListener('selectionchange', () => {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(onSelectionSettled, SELECTION_DEBOUNCE_MS);
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        selectionReqId++;
        window.TpUI.hideSelectionTrigger();
        window.TpUI.hideCard();
      }
    },
    true
  );

  document.addEventListener(
    'mousedown',
    (e) => {
      if (!window.TpUI.isEventFromUI(e)) {
        selectionReqId++;
        window.TpUI.hideSelectionTrigger();
        window.TpUI.hideCard();
      }
    },
    true
  );

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return !!el.isContentEditable;
  }

  function isInsideEditable(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el) {
      if (el.isContentEditable) return true;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
      el = el.parentElement;
    }
    return false;
  }

  function truncateText(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // 选中后只显示一个小“译”按钮，点击才发起翻译（主动触发）
  function onSelectionSettled() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      window.TpUI.hideSelectionTrigger();
      return;
    }

    const text = sel.toString().trim();
    if (!text || text.length > MAX_SELECTION_CHARS) {
      window.TpUI.hideSelectionTrigger();
      return;
    }
    if (isEditable(document.activeElement)) {
      window.TpUI.hideSelectionTrigger();
      return;
    }

    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    if (window.TpUI.isInsideUI(container)) {
      window.TpUI.hideSelectionTrigger();
      return;
    }
    if (isInsideEditable(container)) {
      window.TpUI.hideSelectionTrigger();
      return;
    }

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      window.TpUI.hideSelectionTrigger();
      return;
    }

    const captured = { text, rect };
    window.TpUI.showSelectionTrigger(rect, () => triggerSelectionTranslation(captured));
  }

  async function triggerSelectionTranslation(captured) {
    const reqId = ++selectionReqId;
    const original = truncateText(captured.text, 300);
    window.TpUI.showCard({ rect: captured.rect, original, state: 'loading' });

    const resp = await sendTranslate([captured.text]);
    if (reqId !== selectionReqId) return;

    if (resp && resp.ok && Array.isArray(resp.translations) && typeof resp.translations[0] === 'string') {
      window.TpUI.showCard({ rect: captured.rect, original, translation: resp.translations[0], state: 'done' });
    } else {
      window.TpUI.showCard({ rect: captured.rect, original, state: 'error', error: errorText(resp && resp.error) });
    }
  }
})();
