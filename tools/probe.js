'use strict';
// 用 CDP 驱动 Chrome 打开私服页面，收集 console / 网络 / WebSocket，并截图
// 用法: node tools/probe.js [url] [seconds]
const http = require('http');
const fs = require('fs');

const URL_ = process.argv[2] || 'http://127.0.0.1:8080/';
const SECONDS = Number(process.argv[3] || 40);
const CDP = process.env.CDP || 'http://[::1]:9222';

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(CDP + path, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
}

(async () => {
  console.log('[probe] start cdp=' + CDP);
  const targets = await getJson('/json');
  console.log('[probe] targets=' + targets.length);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  const net = [];
  const sockets = [];

  const send = (method, params) => {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    return new Promise((r) => pending.set(mid, r));
  };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
      return;
    }
    const p = m.params || {};
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (p.args || []).map((a) => a.value !== undefined ? a.value : a.description).join(' ');
      logs.push('[' + p.type + '] ' + text);
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (p.exceptionDetails && p.exceptionDetails.text) + ' ' +
        ((p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description) || ''));
    } else if (m.method === 'Log.entryAdded') {
      logs.push('[log:' + p.entry.level + '] ' + p.entry.text);
    } else if (m.method === 'Network.responseReceived') {
      net.push(p.response.status + ' ' + p.response.url);
    } else if (m.method === 'Network.loadingFailed') {
      net.push('FAIL ' + p.errorText + ' ' + (p.type || ''));
    } else if (m.method === 'Network.webSocketCreated') {
      sockets.push('created ' + p.url);
    } else if (m.method === 'Network.webSocketWillSendHandshakeRequest') {
      sockets.push('handshake ' + JSON.stringify(p.request && p.request.headers));
    } else if (m.method === 'Network.webSocketClosed') {
      sockets.push('closed');
    } else if (m.method === 'Network.webSocketFrameError') {
      sockets.push('frameError ' + p.errorMessage);
    }
  };

  if (ws.readyState !== 1) await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.navigate', { url: URL_ });
  await new Promise((r) => setTimeout(r, SECONDS * 1000));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) fs.writeFileSync('/tmp/probe.png', Buffer.from(shot.data, 'base64'));
  const title = await send('Runtime.evaluate', { expression: 'document.title + " | " + location.href', returnByValue: true });

  console.log('=== page ===');
  console.log(title.result && title.result.result && title.result.result.value);
  console.log('=== console (' + logs.length + ') ===');
  logs.forEach((l) => {
    if (/load agent|私服|login|Login|ws|错误|exception|error|连接|协议|收到|SDK|manifest|Cocos|webgl|WebGL/.test(l)) console.log(l.slice(0, 500));
  });
  console.log('=== network (' + net.length + ') ===');
  net.filter((l) => !/\.(png|jpg|mp3|ogg|ttf|atlas|plist)/.test(l)).slice(0, 120).forEach((l) => console.log(l));
  console.log('=== websocket ===');
  sockets.slice(0, 20).forEach((l) => console.log(l));
  ws.close();
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
})().catch((e) => {
  console.error('probe error', e);
  process.exit(1);
});
