'use strict';
// 私服入口：HTTP(版本信息/登录/静态资源) + WebSocket(登录服/游戏服)
const http = require('http');
const fs = require('fs');
const path = require('path');
const ws = require('./ws');
const game = require('./game');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
// 优先用私服目录里的 static（部署包只带核心文件，其余回源 CDN）
const LOCAL_STATIC = path.join(__dirname, '..', 'static');
const CLIENT_DIR = process.env.CLIENT_DIR || (fs.existsSync(LOCAL_STATIC) ? LOCAL_STATIC : '/workspace/妖怪金手指_H5前端');
const SELF = HOST + ':' + PORT;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.fnt': 'text/plain',
  '.atlas': 'text/plain',
  '.txt': 'text/plain',
  '.bin': 'application/octet-stream',
  '.plist': 'text/xml',
  '.xml': 'text/xml',
  '.dat': 'application/octet-stream',
};

function json(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 运行时按请求的 Host 还原对外地址（兼容反向代理 / 内网穿透）
function baseOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || SELF;
  return { proto, host };
}

function splitHost(host) {
  const m = host.match(/^(.*?)(?::(\d+))?$/);
  return { name: m[1], port: m[2] || '' };
}

function versionInfo(req) {
  const b = baseOf(req);
  const checkConfig = [
    'LogOpen:0',
    'DebugOpen:0',
    'isAdvertise:0',
    'EnableConsoleLog:1',
    'OpenGM:1',
    'GuideAutoReady:1',
    'Team2Speed:1',
    'BattleUpload:0',
    'BattleSilenceUpload:0',
    'MiniGame:0',
    'UserAndPrivacy:huawei',
    'publishInfo0:私服测试',
  ];
  return {
    code: 1,
    data: {
      version: 'online',
      http_server: b.proto + '://' + b.host + '/sy_api/game_api.php',
      http_server_shenhe: b.proto + '://' + b.host + '/sy_api/game_api.php',
      res_host: b.host + '/client',
      checkConfig: JSON.stringify(checkConfig),
      JSVer: '147192',
      cver: '147192',
      configVer: 'hunfu147127',
      t: Math.floor(Date.now() / 1000),
    },
  };
}

function loginResult(req) {
  const b = baseOf(req);
  const h = splitHost(b.host);
  const port = h.port || (b.proto === 'https' ? '443' : '80');
  return {
    success: 0,
    msg: '',
    sign: '',
    time: String(Math.floor(Date.now() / 1000)),
    t_token: 'dev_token',
    lastEnterGameDT: '',
    game_uin: String(game.player.playerId),
    sdk_uin: String(game.player.playerId),
    session_key: 'dev_session',
    login_id_type: 0,
    svrListT: [
      {
        s_ip: h.name,
        sPort: port,
        area: '1',
        s_id: 1,
        s_healthStatus: 1,
        list_name: '私服一区',
        pt_id: 4,
      },
    ],
  };
}

// ---------- 静态 ----------
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  if (rel.indexOf('/client/') === 0) rel = rel.slice(7);

  if (rel === '/h5SB_dalan.js') {
    return sendFile(res, path.join(__dirname, '..', 'client', 'h5SB_dev.js'), true);
  }

  const file = path.join(CLIENT_DIR, rel);
  if (!file.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  sendFile(res, file, rel === '/index.html', rel);
}

// 本地缺失时回源官方 CDN，部署包只需带少量核心文件
const CDN_BASE = process.env.CDN_BASE || 'https://menggui-cdnres.bhsg.lintey.com/huawei/web-mobile';

function sendFile(res, file, patchIndex, rel) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (rel && CDN_BASE) {
        res.writeHead(302, { Location: CDN_BASE + rel, 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 ' + file);
    }
    if (patchIndex && file.endsWith('.html')) buf = patchHtml(buf);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  });
}

// 把 localConfig 里的服务器地址换成私服
function patchHtml(buf) {
  let s = buf.toString('utf8');
  s = s.replace(/"HttpSerever"\s*:\s*"[^"]*"/g, '"HttpSerever": "' + SELF + '/sy_api/game_api.php"');
  s = s.replace(/"PaySerever"\s*:\s*"[^"]*"/g, '"PaySerever": "http://' + SELF + '/sy_api/pay.php"');
  // 反向代理/内网穿透场景：用当前页面的 host 覆盖，避免写死 127.0.0.1
  const fix = ';(function(){var h=location.host;localConfig.HttpSerever=h+"/sy_api/game_api.php";' +
    'localConfig.PaySerever=location.protocol+"//"+h+"/sy_api/pay.php";' +
    'console.log("[私服] 接口地址已切换:",localConfig.HttpSerever);})();';
  s = s.replace(/(var localConfig = \{[^\n]*\};?)/, '$1\n' + fix);
  return Buffer.from(s, 'utf8');
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || SELF));
  const p = u.pathname;

  if (p === '/sy_api/get_versionInfoApi.php') {
    console.log('[http] version info host=' + (req.headers.host || ''));
    return json(res, versionInfo(req));
  }
  if (p === '/sy_api/game_api.php') {
    const action = u.searchParams.get('action') || '';
    console.log('[http] game_api action=' + action);
    if (action === 'login') return json(res, loginResult(req));
    if (action === 'get_AllServerList') return json(res, { code: 1, data: [] });
    if (action === 'register') return json(res, { code: 1, success: 0, game_uin: String(game.player.playerId) });
    return json(res, { code: 0, success: 0, msg: 'ok', data: {} });
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
  res.writeHead(405);
  res.end();
});

// ---------- WebSocket ----------
ws.attach(server, (conn, req) => {
  const b = baseOf(req);
  const h = splitHost(b.host);
  const gameUrl = h.name + ':' + (h.port || (b.proto === 'https' ? '443' : '80'));
  console.log('[ws] 连接建立 host=' + b.host + ' -> gameUrl=' + gameUrl);
  conn.onMessage = (data) => {
    const frame = game.decodeC2S(data);
    if (!frame) return;
    game.handle(conn, frame.module, frame.cmd, frame.ssid, frame.body, { gameUrl });
  };
  conn.onClose = () => console.log('[ws] 连接关闭');
});

server.listen(PORT, HOST, () => {
  console.log('私服已启动: http://' + SELF);
  console.log('客户端目录: ' + CLIENT_DIR);
});
