'use strict';

const DEFAULTS = {
  protocol: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
};

const ERROR_TEXT = {
  NO_CONFIG: '尚未配置完整，请填写 Base URL、API Key 和模型。',
  AUTH: '认证失败，请检查 API Key 是否正确。',
  RATE_LIMIT: '请求过于频繁（429），请稍后再试。',
  TIMEOUT: '请求超时，请检查网络或稍后重试。',
  NETWORK: '网络连接失败，请检查 Base URL 与网络。',
  BAD_RESPONSE: '模型返回内容无法解析。',
  SERVER: '翻译服务返回服务端错误（5xx）。',
};

const $ = (id) => document.getElementById(id);
const form = $('form');
const statusEl = $('status');

function showStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (kind || '');
  statusEl.hidden = false;
}

function hideStatus() {
  statusEl.hidden = true;
}

function readForm() {
  return {
    protocol: $('protocol').value === 'anthropic' ? 'anthropic' : 'openai',
    baseURL: $('baseURL').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    targetLang: $('targetLang').value.trim() || DEFAULTS.targetLang,
  };
}

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  $('protocol').value = stored.protocol === 'anthropic' ? 'anthropic' : 'openai';
  $('baseURL').value = stored.baseURL || DEFAULTS.baseURL;
  $('apiKey').value = stored.apiKey || '';
  $('model').value = stored.model || DEFAULTS.model;
  $('targetLang').value = stored.targetLang || DEFAULTS.targetLang;
}

async function save() {
  await chrome.storage.local.set(readForm());
}

function errorText(err) {
  if (!err) return '翻译失败。';
  return ERROR_TEXT[err.code] || err.message || '翻译失败。';
}

function sendTranslate(texts) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'translate', texts }, (resp) => {
        if (chrome.runtime.lastError || resp === undefined) {
          resolve({ ok: false, error: { code: 'NETWORK', message: chrome.runtime.lastError ? chrome.runtime.lastError.message : '无响应' } });
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      resolve({ ok: false, error: { code: 'NETWORK', message: String(e) } });
    }
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await save();
  showStatus('已保存。', 'ok');
});

$('test').addEventListener('click', async () => {
  const values = readForm();
  if (!values.baseURL || !values.apiKey || !values.model) {
    showStatus(ERROR_TEXT.NO_CONFIG, 'err');
    return;
  }
  await save();
  const btn = $('test');
  btn.disabled = true;
  showStatus('正在测试连接…', '');
  try {
    const resp = await sendTranslate(['Hello']);
    if (resp && resp.ok && Array.isArray(resp.translations) && typeof resp.translations[0] === 'string') {
      showStatus('连接成功，示例翻译：' + resp.translations[0], 'ok');
    } else {
      showStatus('连接失败：' + errorText(resp && resp.error), 'err');
    }
  } catch (err) {
    showStatus('连接失败：' + errorText({ code: 'NETWORK', message: String(err) }), 'err');
  } finally {
    btn.disabled = false;
  }
});

load();
