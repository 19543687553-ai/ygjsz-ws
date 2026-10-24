'use strict';
// 协议层：封包编解码 + 登录/游戏服最小实现 + GM 指令
const fs = require('fs');
const path = require('path');
const pb = require('./pb');
const CMDS = require('../data/cmds.json');
const ITEMS = require('../data/items.json');
const REPLAY = require('../data/replay.json');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SAVE = path.join(DATA_DIR, 'player.json');

// S2C: uint16 total | uint8 ssid | uint8 id | uint8 count | uint8 module | uint16 cmd | uint8 compress | body
const HDR = 9;

function encodeS2C(module, cmd, ssid, body, comp) {
  const head = Buffer.alloc(HDR);
  head.writeUInt16BE(7 + body.length, 0); // 长度字段后的字节数
  head[2] = ssid & 0xff;
  head[3] = 1; // 分包 id
  head[4] = 1; // 分包总数
  head[5] = module & 0xff;
  head.writeUInt16BE(cmd & 0xffff, 6);
  head[8] = comp ? 1 : 0; // 1 = 客户端自行解压
  return Buffer.concat([head, body]);
}

// C2S: uint16 total | uint8 module | uint16 cmd | uint8 ssid | body
function decodeC2S(buf) {
  if (buf.length < 5) return null;
  const total = buf.readUInt16BE(0);
  const module = buf[2];
  const cmd = buf.readUInt16BE(3);
  const ssid = buf[5];
  return { total, module, cmd, ssid, body: buf.subarray(6) };
}

function msgOf(module, cmd) {
  const list = CMDS[String(module)];
  if (!list) return null;
  const e = list.find((x) => x.cmd === cmd);
  return e ? e.msg : null;
}

function tryEncode(name, obj) {
  try {
    return pb.encode(name, obj || {});
  } catch (e) {
    console.log('[pb] encode fail ' + name + ': ' + e.message);
    return Buffer.alloc(0);
  }
}

// ---------------- 玩家数据 ----------------
const now = () => Math.floor(Date.now() / 1000);

function defaultPlayer() {
  return {
    playerId: REPLAY.playerId || 67820771,
    name: REPLAY.name || '宇文三娘',
    level: 2,
    exp: 0,
    createDt: now(),
    money: { diamond: 1000000, gold: 1000000 },
    items: [
      { code: 30000004, num: 999 }, // 低级芯片
      { code: 30000005, num: 999 }, // 高级芯片
      { code: 30000006, num: 999 }, // 顶级芯片
      { code: 30000007, num: 999 }, // 皮革
      { code: 30000008, num: 999 }, // 古铜币
      { code: 30000009, num: 999 }, // 秘银币
      { code: 30000010, num: 999 }, // 耀金币
      { code: 30000011, num: 999 }, // 魂火
    ],
    guide: '',
    guideFlag: true,
    localStorage: {},
  };
}

function loadPlayer() {
  try {
    return Object.assign(defaultPlayer(), JSON.parse(fs.readFileSync(SAVE, 'utf8')));
  } catch (e) {
    return defaultPlayer();
  }
}

function savePlayer(p) {
  try {
    fs.writeFileSync(SAVE, JSON.stringify(p, null, 1));
  } catch (e) {
    console.log('[save] ' + e.message);
  }
}

const player = loadPlayer();
const itemName = (code) => {
  const r = ITEMS.find((x) => x[0] === code);
  return r ? r[1] : '未知物品';
};

function addItem(code, num) {
  code = Number(code) || 0;
  num = Number(num) || 0;
  if (!code) return false;
  const it = player.items.find((x) => x.code === code);
  if (it) it.num += num;
  else player.items.push({ code, num });
  savePlayer(player);
  console.log('[gm] 加物品 ' + code + ' ' + itemName(code) + ' x' + num);
  return true;
}

// ---------------- 响应构造 ----------------
// 用抓包里的真实公共信息做模板，只替换玩家自己的数值，字段结构跟官服一致
const COMMON_TEMPLATE = (() => {
  const rp = REPLAY.pairs['2/12'];
  if (!rp) return null;
  try {
    return pb.decode('GetLoginGameCommonInfoR_LoginGame_S2C', Buffer.from(rp.raw, 'base64'));
  } catch (e) {
    console.log('[replay] 模板解析失败: ' + e.message);
    return null;
  }
})();

function buildCommonInfo(p) {
  if (!COMMON_TEMPLATE) return legacyCommonInfo(p);
  const o = JSON.parse(JSON.stringify(COMMON_TEMPLATE));
  o.playerItem = o.playerItem || {};
  o.playerItem.err = 0;
  o.playerItem.items = p.items.map((it) => ({
    code: it.code,
    num: it.num,
    dt: p.createDt,
    expiredDt: 0,
    playerLevel: p.level,
  }));
  if (o.playerInfo && o.playerInfo.info) {
    const i = o.playerInfo.info;
    i.playerId = p.playerId;
    i.name = p.name;
    i.level = p.level;
    i.exp = p.exp;
    i.createDt = p.createDt;
  }
  if (o.playerInfo && o.playerInfo.playerMoney) o.playerInfo.playerMoney.money = [p.money.diamond, p.money.gold];
  if (o.summonerInfo && o.summonerInfo.info) {
    o.summonerInfo.info.level = p.level;
    o.summonerInfo.info.exp = p.exp;
  }
  if (o.guideInfo) {
    o.guideInfo.guide = p.guide;
    o.guideInfo.guideFlag = p.guideFlag;
    o.guideInfo.localStorage = p.localStorage;
  }
  return o;
}

function legacyCommonInfo(p) {
  const t = now();
  return {
    err: 0,
    playerItem: {
      err: 0,
      items: p.items.map((it) => ({
        code: it.code,
        num: it.num,
        dt: p.createDt,
        expiredDt: 0,
        playerLevel: p.level,
      })),
      chipItems: [],
    },
    summonerInfo: { err: 0, info: { level: p.level, exp: p.exp, title: 0, derma: 0, attr: {} } },
    playerInfo: {
      err: 0,
      info: {
        playerId: p.playerId,
        name: p.name,
        level: p.level,
        exp: p.exp,
        fightCap: 100,
        createDt: p.createDt,
        avatar: '',
        frame: 0,
        roleSecLevel: 0,
        forbidChat: 0,
        serverId: 1,
        serverName: '私服',
        sex: 1,
        chatPopCode: 0,
        moduleBaseList: [],
        title: 0,
        derma: 0,
        mount: 0,
      },
      // money[0]=钻石(1) money[1]=金币(2)
      playerMoney: { money: [p.money.diamond, p.money.gold] },
      compressionFightCap: 0,
      mergeServerNum: 0,
      speedCardEndDt: 0,
    },
    adventureInfo: {
      err: 0,
      info: {
        level: 1,
        chapterId: 1,
        lessTimes: 0,
        buyTimes: 0,
        getDt: t,
        targetList: [],
        hangUpExtendTime: 0,
        levelRewardFlag: [],
        shareNum: 0,
        shareFlag: [],
      },
    },
    guildInfo: { err: 0, memberInfo: [], applyInfo: [] },
    taskInfo: { err: 0, tasks: [] },
    guideInfo: { err: 0, guide: p.guide, guideFlag: p.guideFlag },
    platform: 'huawei',
  };
}

// 登录完成后补发抓包里的服务端推送（活动、聊天、任务、红点等）
function sendPushes(conn) {
  for (const p of REPLAY.pushes || []) {
    conn.send(encodeS2C(p.mod, p.replyCmd, 0, Buffer.from(p.raw, 'base64'), p.comp));
  }
}

// 这些指令由本地逻辑处理（登录、公共信息、GM 等），其余优先回放抓包里的真实回包
const OWN_CMDS = new Set(['1/2', '2/1', '2/6', '2/8', '2/12', '2/14', '2/18', '5/174', '82/1', '82/4', '90/1', '90/3']);

// ---------------- 路由 ----------------
function handle(conn, mod, cmd, ssid, body, ctx) {
  const reqName = msgOf(mod, cmd);
  const label = 'mod' + mod + '/cmd' + cmd + ' ' + (reqName || '?');
  let req = null;
  if (reqName) {
    try {
      req = pb.decode(reqName, body);
    } catch (e) {
      console.log('[pb] decode fail ' + reqName + ': ' + e.message);
    }
  }
  console.log('[recv] ' + label + ' ssid=' + ssid + (req ? ' ' + JSON.stringify(req).slice(0, 300) : ''));

  const reply = (cmdOut, msg, obj) => {
    const buf = tryEncode(msg, obj);
    conn.send(encodeS2C(mod, cmdOut, ssid, buf));
  };

  // 抓包里录到的真实回包：客户端问什么就原样回什么
  const key0 = mod + '/' + cmd;
  if (!OWN_CMDS.has(key0) && REPLAY.pairs[key0]) {
    const rp0 = REPLAY.pairs[key0];
    conn.send(encodeS2C(mod, rp0.replyCmd, ssid, Buffer.from(rp0.raw, 'base64'), rp0.comp));
    return true;
  }

  // 登录服 module 1
  if (mod === 1) {
    if (cmd === 2) {
      // Login -> LoginR
      reply(3, 'LoginR_Login_S2C', {
        err: 0,
        role: {
          playerId: player.playerId,
          name: player.name,
          sessionkey: 'sess_' + player.playerId,
          gameUrl: ctx.gameUrl,
          sGameUrl: ctx.gameUrl,
          createDt: player.createDt,
        },
        newRole: false,
      });
      return true;
    }
    return false;
  }

  // 游戏服 module 2 (LoginGame)
  if (mod === 2) {
    if (cmd === 1) {
      reply(2, 'LoginGameR_LoginGame_S2C', {
        err: 0,
        sysDt: now(),
        timeZone: '+8',
        serverOpenDt: player.createDt,
        offlineTime: 0,
        codeVersion: '1.0.0.0',
        configVersion: 'hunfu147127',
        forbidTime: 0,
      });
      return true;
    }
    if (cmd === 4) {
      reply(5, 'GetGuideInfoR_LoginGame_S2C', {
        err: 0,
        guide: player.guide,
        guideFlag: player.guideFlag,
        localStorage: player.localStorage,
      });
      return true;
    }
    if (cmd === 6) {
      if (req && req.guide !== undefined) player.guide = req.guide;
      savePlayer(player);
      reply(7, 'SetGuideInfoR_LoginGame_S2C', { err: 0 });
      return true;
    }
    if (cmd === 8) {
      reply(9, 'PingR_LoginGame_S2C', { err: 0, sysDt: now() });
      return true;
    }
    if (cmd === 10) {
      reply(11, 'GetServerInfoR_LoginGame_S2C', {
        err: 0,
        sysDt: now(),
        timeZone: '+8',
        serverOpenDt: player.createDt,
        singleSign: false,
      });
      return true;
    }
    if (cmd === 12) {
      reply(13, 'GetLoginGameCommonInfoR_LoginGame_S2C', buildCommonInfo(player));
      return true;
    }
    if (cmd === 14) {
      reply(15, 'LoginGameCompleteR_LoginGame_S2C', { err: 0 });
      sendPushes(conn);
      return true;
    }
    if (cmd === 18) {
      if (req && req.key) {
        player.localStorage[req.key] = req.info && req.info.value !== undefined ? req.info.value : '';
        savePlayer(player);
      }
      reply(19, 'SetLocalStorageR_LoginGame_S2C', { err: 0 });
      return true;
    }
    return false;
  }

  // 战斗房间 module 82 (Build)
  if (mod === 82) {
    if (cmd === 1) {
      // EnterRoom -> EnterRoomR（addr 必须带，客户端拿它连房间服）
      reply(2, 'EnterRoomR_Build_S2C', {
        err: 0,
        authCode: 'dev_auth',
        addr: ctx.gameUrl,
        battleType: req ? req.battleType : 0,
        pingInterval: 5,
        frameInterval: 10,
      });
      return true;
    }
    if (cmd === 4) {
      reply(5, 'QuitRoomR_Build_S2C', { err: 0 });
      return true;
    }
    return false;
  }

  // 房间服 module 90 (BuildRoom)：Auth / Ping
  if (mod === 90) {
    if (cmd === 1) {
      reply(2, 'AuthR_BuildRoom_S2C', { err: 0 });
      return true;
    }
    if (cmd === 3) {
      reply(4, 'PingR_BuildRoom_S2C', { err: 0, sysDt: now() });
      return true;
    }
    return false;
  }

  // 套装 module 110：客户端对 suitInfos 直接 forEach，必须至少给一条
  if (mod === 110) {
    if (cmd === 3) {
      reply(4, 'GetSuitInfosR_Suit_S2C', {
        // 客户端 showQutfitRed 直接读 components.some，必须给一条合法组件
        suitInfos: [{ code: 0, components: [{ index: 0, state: 1 }] }],
        err: 0,
      });
      return true;
    }
    return false;
  }

  // GM / Test module 5
  if (mod === 5 && cmd === 174) {
    const ret = runGM(req || {});
    reply(175, 'MakeTestOperR_Test_S2C', { err: 0, retExtra: ret, status: 'ok' });
    return true;
  }

  // 抓包里录到的真实回包：客户端问什么就原样回什么
  const rp = REPLAY.pairs[mod + '/' + cmd];
  if (rp) {
    conn.send(encodeS2C(mod, rp.replyCmd, ssid, Buffer.from(rp.raw, 'base64'), rp.comp));
    return true;
  }

  // 兜底：未实现的 C2S 按 name/cmd 配对（cmd+1 为对应 S2C）回一个空骨架包
  if (reqName && /_C2S$/.test(reqName)) {
    const outCmd = cmd + 1;
    const outName = msgOf(mod, outCmd);
    if (outName) {
      fallbackStat[mod] = fallbackStat[mod] || {};
      fallbackStat[mod][outName] = (fallbackStat[mod][outName] || 0) + 1;
      console.log('[fallback] mod' + mod + '/cmd' + outCmd + ' ' + outName);
      const bodyOut = pb.SCHEMA[outName] ? tryEncode(outName, pb.skeleton(outName)) : Buffer.alloc(0);
      conn.send(encodeS2C(mod, outCmd, ssid, bodyOut));
      return true;
    }
  }

  return false;
}

const fallbackStat = {};

function parseExtra(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

const GM_LOG = [];
function runGM(req) {
  const cmd = String(req.cmd || '');
  const extra = String(req.extra || '');
  console.log('[GM] cmd=' + cmd + ' extra=' + extra);
  let out = 'ok';

  if (cmd === 'addItem') {
    const a = parseExtra(extra) || {};
    const code = Number(a.code || a.id || 0);
    const num = Number(a.num || a.count || 0);
    out = addItem(code, num) ? 'added ' + code + ' x' + num + ' (' + itemName(code) + ')' : 'bad code';
  } else if (/^addItem_\d+/.test(extra)) {
    const p = extra.split('_');
    out = addItem(Number(p[1]), Number(p[2] || 1)) ? 'added ' + p[1] : 'bad';
  } else if (cmd === 'gmStr') {
    out = runGmStr(extra);
  } else if (cmd === 'adventureSkipLevel') {
    player.adventureLevel = Number(extra) || 1;
    savePlayer(player);
    out = 'adventureLevel=' + player.adventureLevel;
  } else {
    out = 'ok(未实现指令 ' + cmd + ')';
  }

  GM_LOG.push({ t: now(), cmd, extra, out });
  return out;
}

function runGmStr(extra) {
  // 形如 gm_hero_createHeroGM_{ "code": 101 }
  const m = extra.match(/^([A-Za-z0-9_]+)_(\{[\s\S]*\}|.*)$/);
  const name = m ? m[1] : extra;
  console.log('[GM] gmStr ' + name);
  return 'gmStr:' + name;
}

module.exports = { handle, decodeC2S, encodeS2C, player, addItem, itemName };
