'use strict';

// 开发用本地 mock：模拟 OpenAI 兼容的 /chat/completions 端点。
//
// 用法：node scripts/mock-llm.js [port] [mode]
//   port 默认 8790
//   mode 默认 ok，可选：
//     ok          正常返回（保留 <tpN> 标记，译文加 [mock] 前缀）
//     dropmarkers 故意丢弃标记，验证 content 侧的校验/重试/回退
//     misalign    编号整体错位，验证对齐处理
//     missing     缺少最后一段，验证缺失重试
//     slow        延迟 5 秒返回，验证超时与懒加载体验
//     nonjson     返回非 JSON，验证 BAD_RESPONSE
//
// 把设置页的 Base URL 填成 http://localhost:<port> 即可。
// 以 URL 前缀也可临时切换模式，例如 http://localhost:8790/slow

const http = require('http');

const port = Number(process.argv[2] || 8790);
const argMode = process.argv[3] || 'ok';
const KNOWN_MODES = new Set(['ok', 'dropmarkers', 'misalign', 'missing', 'slow', 'nonjson']);

function extractSegments(userContent) {
  const segs = [];
  const re = /\[\[(\d+)\]\]([\s\S]*?)(?=\n\[\[\d+\]\]|$)/g;
  let m;
  while ((m = re.exec(userContent))) {
    segs.push({ i: Number(m[1]), text: m[2].trim() });
  }
  return segs;
}

function buildContent(mode, segs) {
  if (mode === 'nonjson') return '抱歉，我无法按要求输出 JSON。';

  let items;
  if (mode === 'dropmarkers') {
    items = segs.map((s) => ({ i: s.i, t: '[mock] ' + s.text.replace(/<\/?tp\d+>/gi, '') }));
  } else if (mode === 'misalign') {
    items = segs.map((s) => ({ i: s.i + 1, t: '[mock] ' + s.text }));
  } else if (mode === 'missing') {
    items = segs.slice(0, Math.max(0, segs.length - 1)).map((s) => ({ i: s.i, t: '[mock] ' + s.text }));
  } else {
    items = segs.map((s) => ({ i: s.i, t: '[mock] ' + s.text }));
  }
  return JSON.stringify({ t: items });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const isChat = url.pathname.endsWith('/chat/completions');
  const isMessages = url.pathname.endsWith('/messages');
  if (req.method !== 'POST' || (!isChat && !isMessages)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found. Try POST /chat/completions or /v1/messages' } }));
    return;
  }

  const prefix = url.pathname.replace(/\/(?:chat\/completions|messages)$/, '').split('/').filter(Boolean).pop();
  const mode = KNOWN_MODES.has(prefix) ? prefix : argMode;

  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch (_) {}

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const user = messages.find((m) => m && m.role === 'user');
    const segs = extractSegments(user && typeof user.content === 'string' ? user.content : '');
    const content = buildContent(mode, segs);

    console.log(
      `[mock] protocol=${isMessages ? 'anthropic' : 'openai'} mode=${mode} segments=${segs.length} chars=${content.length}`
    );

    const send = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (isMessages) {
        res.end(
          JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            model: body.model || 'mock',
            content: [{ type: 'text', text: content }],
            stop_reason: 'end_turn',
          })
        );
      } else {
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            model: body.model || 'mock',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
          })
        );
      }
    };

    if (mode === 'slow') setTimeout(send, 5000);
    else send();
  });
});

server.listen(port, () => {
  console.log(`mock LLM listening on http://localhost:${port}  (mode=${argMode})`);
  console.log('把设置页 Base URL 填成 http://localhost:' + port + '，模型名任意。');
});
