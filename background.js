'use strict';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const DEFAULTS = {
  protocol: 'openai', // 'openai' | 'anthropic'
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
};

const CACHE_MAX = 1000;
const TIMEOUT_MS = 60000;
const RATE_LIMIT_DELAY_MS = 2000;
const MAX_ROUNDS = 8;
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 8192;

/** @type {Map<string, string>} 翻译缓存（内存，SW 重启即清空） */
const cache = new Map();

// 不同协议下遇到不兼容参数时，降级并记忆，避免每次都触发 400
const disabledFlags = {
  openai: { json: false, temperature: false },
  anthropic: { temperature: false },
};

class TpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TpError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 消息入口
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'translate') {
    // 必须在进入 async 之前同步返回 true，保持消息通道打开
    handleTranslate(msg.texts).then(
      (translations) => sendResponse({ ok: true, translations }),
      (err) => {
        const error = toErrorPayload(err);
        console.warn(`[tp] translate failed code=${error.code} message=${error.message}`);
        sendResponse({ ok: false, error });
      }
    );
    return true;
  }

  if (msg.type === 'open-options') {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_) {}
  }
});

chrome.action.onClicked.addListener((tab) => {
  notifyTab(tab && tab.id, { type: 'toggle-panel' });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-page') return;
  if (tab && tab.id != null) {
    notifyTab(tab.id, { type: 'toggle-page' });
  } else {
    getActiveTabId().then((id) => notifyTab(id, { type: 'toggle-page' }));
  }
});

function notifyTab(tabId, message) {
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      // 受限页面 / 无 content script 时会报错，读取 lastError 静默吞掉
      void chrome.runtime.lastError;
    });
  } catch (_) {}
}

async function getActiveTabId() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0].id : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function handleTranslate(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const settings = await getSettings(); // 可能抛 NO_CONFIG

  const result = new Array(texts.length).fill(null);
  const misses = []; // { index, text }

  for (let i = 0; i < texts.length; i++) {
    const text = typeof texts[i] === 'string' ? texts[i] : '';
    if (!text.trim()) {
      result[i] = '';
      continue;
    }
    const key = cacheKey(settings, text);
    if (cache.has(key)) {
      result[i] = cache.get(key);
    } else {
      misses.push({ index: i, text });
    }
  }

  if (misses.length === 0) {
    console.log(`[tp] translate all-cached segments=${texts.length}`);
    return result;
  }

  const started = Date.now();
  console.log(
    `[tp] translate start protocol=${settings.protocol} model=${settings.model} segments=${texts.length} cacheHits=${texts.length - misses.length} misses=${misses.length}`
  );

  const translations = await requestTranslations(settings, misses.map((m) => m.text));

  let okCount = 0;
  for (let j = 0; j < misses.length; j++) {
    const tr = translations[j];
    if (typeof tr === 'string' && tr) {
      result[misses[j].index] = tr;
      setCache(cacheKey(settings, misses[j].text), tr);
      okCount++;
    } else {
      result[misses[j].index] = null;
    }
  }

  console.log(`[tp] translate done ok=${okCount}/${misses.length} elapsed=${Date.now() - started}ms`);
  return result;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  const settings = {
    protocol: String(stored.protocol || '').toLowerCase() === 'anthropic' ? 'anthropic' : 'openai',
    baseURL: String(stored.baseURL || '').trim(),
    apiKey: String(stored.apiKey || '').trim(),
    model: String(stored.model || '').trim(),
    targetLang: String(stored.targetLang || '').trim() || DEFAULTS.targetLang,
  };
  if (!settings.baseURL || !settings.apiKey || !settings.model) {
    throw new TpError('NO_CONFIG', '未配置 Base URL / API Key / 模型');
  }
  return settings;
}

/**
 * 翻译一组文本，返回与输入等长同序的数组（缺失项为 null）。
 * 仅当“完全没有任何有效段”时抛 BAD_RESPONSE。
 */
async function requestTranslations(settings, texts) {
  const result = new Array(texts.length).fill(null);

  const map = await callModel(settings, texts);

  const missing = [];
  for (let idx = 0; idx < texts.length; idx++) {
    const v = map.get(idx + 1);
    if (typeof v === 'string' && v.trim()) {
      result[idx] = v;
    } else {
      missing.push(idx);
    }
  }

  if (missing.length === 0) return result;

  if (missing.length === texts.length) {
    // 完全没对齐上，视为模型返回不可用
    throw new TpError('BAD_RESPONSE', '模型返回与输入无法对齐');
  }

  // 缺失段单独重试一次（合成一个请求）；失败则保持 null
  try {
    const retryMap = await callModel(settings, missing.map((i) => texts[i]));
    for (let k = 0; k < missing.length; k++) {
      const v = retryMap.get(k + 1);
      if (typeof v === 'string' && v.trim()) result[missing[k]] = v;
    }
  } catch (_) {
    // 忽略重试失败，缺失项保持 null
  }

  return result;
}

// ---------------------------------------------------------------------------
// 请求模型
// ---------------------------------------------------------------------------
async function callModel(settings, texts) {
  const system = buildSystemPrompt(settings.targetLang);
  const user = texts.map((t, i) => `[[${i + 1}]] ${t}`).join('\n');
  const content = await sendChat(settings, () => buildBody(settings, system, user));
  return parseModelOutput(content);
}

function buildSystemPrompt(targetLang) {
  return [
    `你是一个专业的网页翻译引擎。将用户给出的每个编号段落翻译为${targetLang}。`,
    '必须严格遵守：',
    '1. 只输出一个 JSON 对象，格式为 {"t":[{"i":1,"t":"译文"}, ...]}，不要输出任何额外文字、解释或代码块围栏。',
    '2. 输出中的 i 必须与输入段落编号一一对应，不能遗漏、重复或改变顺序。',
    '3. 文本里的 <tpN>…</tpN> 是受保护的行内标记（代表链接、加粗、图片等），必须成对、原样保留；标记内的文字照常翻译，但标记本身与其编号不得修改、删除、增加或挪动到别的段落。',
    '4. 只翻译自然语言文本，不要翻译代码、URL、邮箱、占位符等内容。',
    '示例输入：',
    '[[1]] 请阅读 <tp1>文档</tp1>。',
    '[[2]] Hello world.',
    '示例输出：',
    '{"t":[{"i":1,"t":"Please read the <tp1>document</tp1>."},{"i":2,"t":"你好世界。"}]}',
  ].join('\n');
}

function buildBody(settings, system, user) {
  const flags = disabledFlags[settings.protocol] || disabledFlags.openai;

  if (settings.protocol === 'anthropic') {
    const body = {
      model: settings.model,
      max_tokens: Math.min(ANTHROPIC_MAX_TOKENS, Math.max(1024, user.length + 512)),
      system,
      messages: [{ role: 'user', content: user }],
    };
    if (!flags.temperature) body.temperature = 0;
    return body;
  }

  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (!flags.temperature) body.temperature = 0;
  if (!flags.json) body.response_format = { type: 'json_object' };
  return body;
}

function extractContent(settings, data) {
  if (settings.protocol === 'anthropic') {
    if (!data || !Array.isArray(data.content)) return null;
    let out = '';
    for (const block of data.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
    }
    return out || null;
  }

  const message = data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message;
  return message && typeof message.content === 'string' ? message.content : null;
}

async function sendChat(settings, buildBodyFn) {
  let rateLimitRetried = false;
  const flags = disabledFlags[settings.protocol] || disabledFlags.openai;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = buildBodyFn();
    const { status, text } = await doFetch(settings, body);

    if (status >= 200 && status < 300) {
      const content = extractContent(settings, safeJsonParse(text));
      if (content == null) throw new TpError('BAD_RESPONSE', '模型响应缺少内容');
      return content;
    }

    if (status === 400) {
      const lower = text.toLowerCase();
      let adjusted = false;
      if (settings.protocol === 'openai' && !flags.json && lower.includes('response_format')) {
        flags.json = true;
        adjusted = true;
        console.warn('[tp] 400: response_format 不受支持，去掉后重试');
      }
      if (!flags.temperature && lower.includes('temperature')) {
        flags.temperature = true;
        adjusted = true;
        console.warn('[tp] 400: temperature 不受支持，去掉后重试');
      }
      if (adjusted) continue;
    }

    if (status === 429) {
      if (!rateLimitRetried) {
        rateLimitRetried = true;
        console.warn('[tp] 429: 限流，2s 后重试一次');
        await sleep(RATE_LIMIT_DELAY_MS);
        continue;
      }
      throw new TpError('RATE_LIMIT', '请求过于频繁（429）');
    }

    if (status === 401 || status === 403) {
      throw new TpError('AUTH', `认证失败（${status}），请检查 API Key`);
    }

    if (status >= 500) {
      throw new TpError('SERVER', `服务端错误（${status}）`);
    }

    throw new TpError('BAD_RESPONSE', `请求失败（${status}）：${truncate(text, 160)}`);
  }

  throw new TpError('BAD_RESPONSE', '请求重试次数过多');
}

async function doFetch(settings, body) {
  const url = buildEndpoint(settings);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(settings),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    console.log(`[tp] http ${resp.status} ${url} ${Date.now() - started}ms`);
    return { status: resp.status, text };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      console.warn(`[tp] http timeout ${url} (${Date.now() - started}ms)`);
      throw new TpError('TIMEOUT', '请求超时');
    }
    console.warn(`[tp] http error ${url}: ${e && e.name ? e.name : e}`);
    throw new TpError('NETWORK', '网络请求失败：' + (e && e.message ? e.message : String(e)));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 解析模型输出
// ---------------------------------------------------------------------------
function parseModelOutput(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new TpError('BAD_RESPONSE', '模型返回为空');
  }

  let s = stripThink(content);
  s = stripFences(s).trim();

  let obj = safeJsonParse(s);
  if (obj == null) {
    const candidate = extractJsonObject(s);
    if (candidate) obj = safeJsonParse(candidate);
  }
  if (obj == null || typeof obj !== 'object') {
    throw new TpError('BAD_RESPONSE', '模型返回无法解析为 JSON');
  }
  if (!Array.isArray(obj.t)) {
    throw new TpError('BAD_RESPONSE', '模型返回缺少 t 数组');
  }

  const map = new Map();
  for (const item of obj.t) {
    if (!item || typeof item !== 'object') continue;
    const i = item.i;
    const t = item.t;
    if (!Number.isInteger(i) || i < 1) continue;
    if (typeof t !== 'string') continue;
    if (map.has(i)) continue;
    map.set(i, t);
  }
  return map;
}

function stripThink(s) {
  return s
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '');
}

function stripFences(s) {
  let m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) return m[1];
  m = s.match(/```(?:json)?\s*([\s\S]*)$/i);
  if (m) return m[1];
  return s;
}

function extractJsonObject(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function buildEndpoint(settings) {
  let base = String(settings.baseURL || '').trim().replace(/\/+$/, '');
  base = base.replace(/\/(?:chat\/completions|messages)$/i, '');

  if (settings.protocol === 'anthropic') {
    // Anthropic Messages API 原生路径为 /v1/messages
    return /\/v1$/i.test(base) ? base + '/messages' : base + '/v1/messages';
  }
  return base + '/chat/completions';
}

function buildHeaders(settings) {
  if (settings.protocol === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      Authorization: `Bearer ${settings.apiKey}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${settings.apiKey}`,
  };
}

function cacheKey(settings, text) {
  return settings.protocol + '\u0000' + settings.model + '\u0000' + settings.targetLang + '\u0000' + text;
}

function setCache(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function toErrorPayload(err) {
  if (err instanceof TpError) return { code: err.code, message: err.message };
  return {
    code: 'NETWORK',
    message: err && err.message ? err.message : '未知错误',
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') return String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
