// 妖怪金手指 私服 - WebSocket 游戏服（Deno Deploy 单文件版）
// 依赖：只有 PHP 主机上的 data.php（协议表）和 internal.php（存档读写）
// 部署：Deno Deploy 新建 Playground / Project，粘贴本文件，设置环境变量 PHP_BASE、TOKEN
import { Buffer } from "node:buffer";

// ---------------- 配置 ----------------
const PHP_BASE = (Deno.env.get("PHP_BASE") || "https://zx.lytnb.top/sy_api").replace(/\/+$/, "");
const TOKEN = Deno.env.get("TOKEN") || "yg_9f3c1a7b_change_me";
const PLAYER_ID = Number(Deno.env.get("PLAYER_ID") || 0) || 67820771;
const SAVE_DELAY = 800; // 毫秒，改档后延迟合并写入
const PORT = Number(Deno.env.get("PORT") || 8000);
const VERBOSE = Deno.env.get("VERBOSE") !== "0";

const log = (...a) => {
  if (VERBOSE) console.log(...a);
};
const now = () => Math.floor(Date.now() / 1000);

// 后台任务（Deno Deploy 防止 isolate 提前回收；本地跑没有 EdgeRuntime）
function bg(p) {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(p);
}

// ---------------- 远端表（协议 / 指令 / 道具） ----------------
let SCHEMA = {};
let CMDS = {};
let ITEMS = [];
let REPLAY = { pairs: {}, pushes: [] };
let tablesPromise = null;

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(url + " -> " + r.status);
  return await r.json();
}

async function loadTables() {
  const [proto, cmds, items, replay] = await Promise.all([
    getJson(PHP_BASE + "/data.php?f=protocol"),
    getJson(PHP_BASE + "/data.php?f=cmds"),
    getJson(PHP_BASE + "/data.php?f=items"),
    getJson(PHP_BASE + "/data.php?f=replay"),
  ]);
  SCHEMA = proto.messages || proto;
  CMDS = cmds;
  ITEMS = items;
  REPLAY = replay || { pairs: {}, pushes: [] };
  log(
    "[init] 协议 " + Object.keys(SCHEMA).length + " 条, 指令 " + Object.keys(CMDS).length +
      " 组, 道具 " + ITEMS.length + ", 真实回包 " + Object.keys(REPLAY.pairs || {}).length,
  );
}

function tables() {
  if (tablesPromise) return tablesPromise;
  tablesPromise = loadTables().catch((e) => {
    tablesPromise = null; // 失败下次请求重试
    throw e;
  });
  return tablesPromise;
}

// ---------------- protobuf 极简编解码 ----------------
function fieldsOf(name) {
  const f = SCHEMA[name];
  if (!f) throw new Error("unknown message: " + name);
  return f;
}
const isNumType = (t) => t === "int32" || t === "uint32" || t === "int64" || t === "uint64" || t === "bool";
const wireTypeOf = (t) => (t === "double" ? 1 : t === "string" || t === "object" ? 2 : 0);

function Writer() {
  this.bufs = [];
  this.len = 0;
}
Writer.prototype.push = function (b) {
  this.bufs.push(b);
  this.len += b.length;
};
Writer.prototype.varint = function (v) {
  let n = typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v) || 0));
  if (n < 0n) n += 1n << 64n;
  const out = [];
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  this.push(Buffer.from(out));
};
Writer.prototype.tag = function (field, wire) {
  this.varint(BigInt(field) * 8n + BigInt(wire));
};
Writer.prototype.double = function (v) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(Number(v) || 0, 0);
  this.push(b);
};
Writer.prototype.bytes = function (b) {
  this.varint(b.length);
  this.push(b);
};
Writer.prototype.result = function () {
  return Buffer.concat(this.bufs, this.len);
};

function encodeScalar(w, t, v) {
  switch (t) {
    case "bool":
      w.varint(v ? 1 : 0);
      break;
    case "double":
      w.double(v);
      break;
    case "string":
      w.bytes(Buffer.from(String(v), "utf8"));
      break;
    default:
      w.varint(v);
  }
}

function encodeField(w, f, v, def) {
  const wt = wireTypeOf(f.type);
  switch (f.rule) {
    case "Repeated": {
      if (!Array.isArray(v) || !v.length) return;
      if (f.type !== "object" && f.type !== "string") {
        const sub = new Writer();
        for (const item of v) encodeScalar(sub, f.type, item);
        w.tag(f.tag, 2);
        w.bytes(sub.result());
        return;
      }
      for (const item of v) {
        w.tag(f.tag, wt);
        if (f.type === "object") w.bytes(encode(f.ref, item));
        else encodeScalar(w, f.type, item);
      }
      return;
    }
    case "Map": {
      const entries = v instanceof Map ? Array.from(v.entries()) : Object.entries(v || {});
      for (const [k, val] of entries) {
        const sub = new Writer();
        sub.tag(1, wireTypeOf(def.keyType || "string"));
        encodeScalar(sub, def.keyType || "string", k);
        sub.tag(2, wireTypeOf(def.valType || "uint32"));
        if (def.valType === "object") sub.bytes(encode(def.valRef, val));
        else encodeScalar(sub, def.valType || "uint32", val);
        w.tag(f.tag, 2);
        w.bytes(sub.result());
      }
      return;
    }
    default: {
      if (f.type === "object") {
        w.tag(f.tag, 2);
        w.bytes(encode(f.ref, v));
      } else {
        w.tag(f.tag, wt);
        encodeScalar(w, f.type, v);
      }
    }
  }
}

function encode(name, obj, mapDefs) {
  if (!obj) return Buffer.alloc(0);
  const w = new Writer();
  for (const f of fieldsOf(name)) {
    const v = obj[f.name];
    if (v === undefined || v === null) continue;
    const md = (mapDefs || {})[name + "." + f.name];
    encodeField(w, f, v, md || {});
  }
  return w.result();
}

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let byte;
  do {
    byte = buf[pos.i++];
    if (byte === undefined) throw new Error("varint eof");
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  return result;
}

function toNumber(v, is64) {
  if (!is64) {
    if (v >= 0x80000000n && v < 0x100000000n) return Number(BigInt.asIntN(32, v));
    if (v >= 0xffffffff80000000n) return Number(BigInt.asIntN(64, v));
    return Number(v);
  }
  if (v >= 0x8000000000000000n) return Number(BigInt.asIntN(64, v));
  return Number(v);
}

function decodeScalar(buf, pos, t) {
  switch (t) {
    case "bool":
      return readVarint(buf, pos) !== 0n;
    case "double": {
      const v = buf.readDoubleLE(pos.i);
      pos.i += 8;
      return v;
    }
    case "string": {
      const len = Number(readVarint(buf, pos));
      const s = buf.toString("utf8", pos.i, pos.i + len);
      pos.i += len;
      return s;
    }
    case "int32":
    case "int64":
    case "uint32":
    case "uint64":
      return toNumber(readVarint(buf, pos), t === "int64" || t === "uint64");
    default:
      return Number(readVarint(buf, pos));
  }
}

function readBytes(buf, pos) {
  const len = Number(readVarint(buf, pos));
  const b = buf.subarray(pos.i, pos.i + len);
  pos.i += len;
  return b;
}

function decodeInto(obj, name, buf, mapDefs) {
  const pos = { i: 0 };
  const defs = fieldsOf(name);
  const byTag = {};
  for (const f of defs) byTag[f.tag] = f;
  while (pos.i < buf.length) {
    const key = Number(readVarint(buf, pos));
    const tag = key >> 3;
    const wt = key & 7;
    const f = byTag[tag];
    if (!f) {
      if (wt === 0) readVarint(buf, pos);
      else if (wt === 1) pos.i += 8;
      else if (wt === 2) pos.i += Number(readVarint(buf, pos));
      else if (wt === 5) pos.i += 4;
      else throw new Error("bad wire type " + wt);
      continue;
    }
    if (f.rule === "Repeated") {
      if (!obj[f.name]) obj[f.name] = [];
      if (wt === 2 && f.type !== "object" && f.type !== "string") {
        const sub = readBytes(buf, pos);
        const p2 = { i: 0 };
        while (p2.i < sub.length) obj[f.name].push(decodeScalar(sub, p2, f.type));
      } else {
        obj[f.name].push(f.type === "object" ? decode(f.ref, readBytes(buf, pos), mapDefs) : decodeScalar(buf, pos, f.type));
      }
    } else if (f.rule === "Map") {
      const md = (mapDefs || {})[name + "." + f.name] || {};
      const sub = readBytes(buf, pos);
      const e = readMapEntry(sub, md);
      if (!obj[f.name]) obj[f.name] = {};
      obj[f.name][e.key] = e.val;
    } else {
      obj[f.name] = f.type === "object" ? decode(f.ref, readBytes(buf, pos), mapDefs) : decodeScalar(buf, pos, f.type);
    }
  }
  return obj;
}

function readMapEntry(buf, md) {
  const pos = { i: 0 };
  let key = "";
  let val = 0;
  while (pos.i < buf.length) {
    const k = Number(readVarint(buf, pos));
    const tag = k >> 3;
    if (tag === 1) key = decodeScalar(buf, pos, md.keyType || "string");
    else if (tag === 2) {
      if (md.valType === "object") val = decode(md.valRef, readBytes(buf, pos), null);
      else val = decodeScalar(buf, pos, md.valType || "uint32");
    } else {
      if ((k & 7) === 0) readVarint(buf, pos);
      else if ((k & 7) === 2) readBytes(buf, pos);
      else if ((k & 7) === 1) pos.i += 8;
      else pos.i += 4;
    }
  }
  return { key, val };
}

function decode(name, buf, mapDefs) {
  return decodeInto({}, name, buf, mapDefs);
}

// 按消息定义生成空骨架：列表给空数组，对象递归
function skeleton(name, depth) {
  if (depth === undefined) depth = 2;
  const obj = {};
  const defs = SCHEMA[name];
  if (!defs) return obj;
  for (const f of defs) {
    if (f.rule === "Repeated") obj[f.name] = [];
    else if (f.rule === "Map") obj[f.name] = {};
    else if (f.type === "object") obj[f.name] = depth > 0 ? skeleton(f.ref, depth - 1) : {};
    else if (f.type === "string") obj[f.name] = "";
    else if (f.type === "bool") obj[f.name] = false;
    else obj[f.name] = 0;
  }
  return obj;
}

// ---------------- 封包 ----------------
// S2C: uint16 total | uint8 ssid | uint8 id | uint8 count | uint8 module | uint16 cmd | uint8 compress | body
const HDR = 9;

function encodeS2C(module, cmd, ssid, body, comp) {
  const head = Buffer.alloc(HDR);
  head.writeUInt16BE(7 + body.length, 0);
  head[2] = ssid & 0xff;
  head[3] = 1;
  head[4] = 1;
  head[5] = module & 0xff;
  head.writeUInt16BE(cmd & 0xffff, 6);
  head[8] = comp ? 1 : 0;
  return Buffer.concat([head, body]);
}

// C2S: uint16 total | uint8 module | uint16 cmd | uint8 ssid | body
function decodeC2S(buf) {
  if (buf.length < 6) return null;
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
    return encode(name, obj || {});
  } catch (e) {
    log("[pb] encode fail " + name + ": " + e.message);
    return Buffer.alloc(0);
  }
}

// ---------------- 存档（PHP 主机） ----------------
const players = new Map();
const saveTimers = new Map();

function defaultPlayer() {
  return {
    playerId: REPLAY.playerId || PLAYER_ID,
    name: REPLAY.name || "宇文三娘",
    level: 2,
    exp: 0,
    createDt: now(),
    money: { diamond: 1000000, gold: 1000000 },
    items: [
      { code: 30000004, num: 999 },
      { code: 30000005, num: 999 },
      { code: 30000006, num: 999 },
      { code: 30000007, num: 999 },
      { code: 30000008, num: 999 },
      { code: 30000009, num: 999 },
      { code: 30000010, num: 999 },
      { code: 30000011, num: 999 },
    ],
    guide: "",
    guideFlag: true,
    localStorage: {},
  };
}

const playerUrl = () => PHP_BASE + "/internal.php?token=" + encodeURIComponent(TOKEN);

async function loadPlayer(id) {
  let saved = null;
  try {
    const r = await fetch(playerUrl(), { headers: { accept: "application/json" } });
    const j = await r.json();
    if (j && j.ok && j.data) saved = JSON.parse(j.data);
  } catch (e) {
    log("[save] load fail: " + e.message);
  }
  const p = Object.assign(defaultPlayer(), saved || {});
  p.playerId = id || p.playerId || PLAYER_ID;
  return p;
}

function getPlayer(id) {
  if (!players.has(id)) players.set(id, loadPlayer(id));
  return players.get(id); // Promise
}

async function flushSave(p) {
  try {
    const r = await fetch(playerUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    });
    const j = await r.json();
    if (!j.ok) log("[save] fail: " + JSON.stringify(j));
  } catch (e) {
    log("[save] post fail: " + e.message);
  }
}

function queueSave(p) {
  const id = p.playerId;
  if (saveTimers.has(id)) return;
  saveTimers.set(
    id,
    setTimeout(() => {
      saveTimers.delete(id);
      bg(flushSave(p));
    }, SAVE_DELAY),
  );
}

const itemName = (code) => {
  const r = ITEMS.find((x) => x[0] === Number(code));
  return r ? r[1] : "未知物品";
};

function addItem(p, code, num) {
  code = Number(code) || 0;
  num = Number(num) || 0;
  if (!code) return false;
  const it = p.items.find((x) => x.code === code);
  if (it) it.num += num;
  else p.items.push({ code, num });
  queueSave(p);
  log("[gm] 加物品 " + code + " " + itemName(code) + " x" + num);
  return true;
}

// ---------------- 响应构造 ----------------
let commonTemplate = null;
function commonTemplateOf() {
  if (commonTemplate !== null) return commonTemplate;
  const rp = REPLAY.pairs && REPLAY.pairs["2/12"];
  commonTemplate = false;
  if (rp) {
    try {
      commonTemplate = decode("GetLoginGameCommonInfoR_LoginGame_S2C", Buffer.from(rp.raw, "base64"));
    } catch (e) {
      log("[replay] 模板解析失败: " + e.message);
    }
  }
  return commonTemplate;
}

function buildCommonInfo(p) {
  const tpl = commonTemplateOf();
  if (!tpl) return legacyCommonInfo(p);
  const o = JSON.parse(JSON.stringify(tpl));
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
        avatar: "",
        frame: 0,
        roleSecLevel: 0,
        forbidChat: 0,
        serverId: 1,
        serverName: "私服",
        sex: 1,
        chatPopCode: 0,
        moduleBaseList: [],
        title: 0,
        derma: 0,
        mount: 0,
      },
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
    platform: "huawei",
  };
}

// 登录完成后补发抓包里的服务端推送（活动、聊天、任务、红点等）
function sendPushes(conn) {
  for (const pu of REPLAY.pushes || []) {
    conn.send(encodeS2C(pu.mod, pu.replyCmd, 0, Buffer.from(pu.raw, "base64"), pu.comp));
  }
}

// 这些指令由本地逻辑处理，其余优先回放抓包里的真实回包
const OWN_CMDS = new Set(["1/2", "2/1", "2/6", "2/8", "2/12", "2/14", "2/18", "5/174", "82/1", "82/4", "90/1", "90/3"]);

// ---------------- 路由 ----------------
function handle(conn, mod, cmd, ssid, body, ctx) {
  const p = ctx.player;
  const reqName = msgOf(mod, cmd);
  const label = "mod" + mod + "/cmd" + cmd + " " + (reqName || "?");
  let req = null;
  if (reqName) {
    try {
      req = decode(reqName, body);
    } catch (e) {
      log("[pb] decode fail " + reqName + ": " + e.message);
    }
  }
  log("[recv] " + label + " ssid=" + ssid + (req ? " " + JSON.stringify(req).slice(0, 300) : ""));

  const reply = (cmdOut, msg, obj) => {
    const buf = tryEncode(msg, obj);
    conn.send(encodeS2C(mod, cmdOut, ssid, buf));
  };

  // 抓包里录到的真实回包优先
  const key0 = mod + "/" + cmd;
  if (!OWN_CMDS.has(key0) && REPLAY.pairs && REPLAY.pairs[key0]) {
    const rp0 = REPLAY.pairs[key0];
    conn.send(encodeS2C(mod, rp0.replyCmd, ssid, Buffer.from(rp0.raw, "base64"), rp0.comp));
    return true;
  }

  // 登录服 module 1
  if (mod === 1) {
    if (cmd === 2) {
      reply(3, "LoginR_Login_S2C", {
        err: 0,
        role: {
          playerId: p.playerId,
          name: p.name,
          sessionkey: "sess_" + p.playerId,
          gameUrl: ctx.gameUrl,
          sGameUrl: ctx.gameUrl,
          createDt: p.createDt,
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
      reply(2, "LoginGameR_LoginGame_S2C", {
        err: 0,
        sysDt: now(),
        timeZone: "+8",
        serverOpenDt: p.createDt,
        offlineTime: 0,
        codeVersion: "1.0.0.0",
        configVersion: "hunfu147127",
        forbidTime: 0,
      });
      return true;
    }
    if (cmd === 4) {
      reply(5, "GetGuideInfoR_LoginGame_S2C", {
        err: 0,
        guide: p.guide,
        guideFlag: p.guideFlag,
        localStorage: p.localStorage,
      });
      return true;
    }
    if (cmd === 6) {
      if (req && req.guide !== undefined) p.guide = req.guide;
      queueSave(p);
      reply(7, "SetGuideInfoR_LoginGame_S2C", { err: 0 });
      return true;
    }
    if (cmd === 8) {
      reply(9, "PingR_LoginGame_S2C", { err: 0, sysDt: now() });
      return true;
    }
    if (cmd === 10) {
      reply(11, "GetServerInfoR_LoginGame_S2C", {
        err: 0,
        sysDt: now(),
        timeZone: "+8",
        serverOpenDt: p.createDt,
        singleSign: false,
      });
      return true;
    }
    if (cmd === 12) {
      reply(13, "GetLoginGameCommonInfoR_LoginGame_S2C", buildCommonInfo(p));
      return true;
    }
    if (cmd === 14) {
      reply(15, "LoginGameCompleteR_LoginGame_S2C", { err: 0 });
      sendPushes(conn);
      return true;
    }
    if (cmd === 18) {
      if (req && req.key) {
        p.localStorage[req.key] = req.info && req.info.value !== undefined ? req.info.value : "";
        queueSave(p);
      }
      reply(19, "SetLocalStorageR_LoginGame_S2C", { err: 0 });
      return true;
    }
    return false;
  }

  // 战斗房间 module 82 (Build)
  if (mod === 82) {
    if (cmd === 1) {
      reply(2, "EnterRoomR_Build_S2C", {
        err: 0,
        authCode: "dev_auth",
        addr: ctx.gameUrl,
        battleType: req ? req.battleType : 0,
        pingInterval: 5,
        frameInterval: 10,
      });
      return true;
    }
    if (cmd === 4) {
      reply(5, "QuitRoomR_Build_S2C", { err: 0 });
      return true;
    }
    return false;
  }

  // 房间服 module 90 (BuildRoom)
  if (mod === 90) {
    if (cmd === 1) {
      reply(2, "AuthR_BuildRoom_S2C", { err: 0 });
      return true;
    }
    if (cmd === 3) {
      reply(4, "PingR_BuildRoom_S2C", { err: 0, sysDt: now() });
      return true;
    }
    return false;
  }

  // 套装 module 110
  if (mod === 110) {
    if (cmd === 3) {
      reply(4, "GetSuitInfosR_Suit_S2C", {
        suitInfos: [{ code: 0, components: [{ index: 0, state: 1 }] }],
        err: 0,
      });
      return true;
    }
    return false;
  }

  // GM / Test module 5
  if (mod === 5 && cmd === 174) {
    const ret = runGM(p, req || {});
    reply(175, "MakeTestOperR_Test_S2C", { err: 0, retExtra: ret, status: "ok" });
    return true;
  }

  // 抓包里录到的真实回包：客户端问什么就原样回什么
  const rp = REPLAY.pairs && REPLAY.pairs[mod + "/" + cmd];
  if (rp) {
    conn.send(encodeS2C(mod, rp.replyCmd, ssid, Buffer.from(rp.raw, "base64"), rp.comp));
    return true;
  }

  // 兜底：未实现的 C2S，按 cmd+1 回空骨架包
  if (reqName && /_C2S$/.test(reqName)) {
    const outCmd = cmd + 1;
    const outName = msgOf(mod, outCmd);
    if (outName) {
      log("[fallback] mod" + mod + "/cmd" + outCmd + " " + outName);
      const bodyOut = SCHEMA[outName] ? tryEncode(outName, skeleton(outName)) : Buffer.alloc(0);
      conn.send(encodeS2C(mod, outCmd, ssid, bodyOut));
      return true;
    }
  }

  return false;
}

function parseExtra(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

function runGM(p, req) {
  const cmd = String(req.cmd || "");
  const extra = String(req.extra || "");
  log("[GM] cmd=" + cmd + " extra=" + extra);
  let out = "ok";

  if (cmd === "addItem") {
    const a = parseExtra(extra) || {};
    const code = Number(a.code || a.id || 0);
    const num = Number(a.num || a.count || 0);
    out = addItem(p, code, num) ? "added " + code + " x" + num + " (" + itemName(code) + ")" : "bad code";
  } else if (/^addItem_\d+/.test(extra)) {
    const a = extra.split("_");
    out = addItem(p, Number(a[1]), Number(a[2] || 1)) ? "added " + a[1] : "bad";
  } else if (cmd === "adventureSkipLevel") {
    p.adventureLevel = Number(extra) || 1;
    queueSave(p);
    out = "adventureLevel=" + p.adventureLevel;
  } else if (cmd === "gmStr") {
    const m = extra.match(/^([A-Za-z0-9_]+)_(\{[\s\S]*\}|.*)$/);
    out = "gmStr:" + (m ? m[1] : extra);
  } else {
    out = "ok(未实现指令 " + cmd + ")";
  }
  return out;
}

// ---------------- 连接 ----------------
const clients = new Set();

function attach(socket, gameUrl) {
  socket.binaryType = "arraybuffer";
  const state = { player: null, ready: false, queue: [], gameUrl };
  const conn = {
    send(buf) {
      try {
        if (socket.readyState === 1) socket.send(buf);
      } catch (e) {
        log("[ws] send fail: " + e.message);
      }
    },
    close() {
      try {
        socket.close();
      } catch (e) {
        /* ignore */
      }
    },
  };

  const run = (buf) => {
    const f = decodeC2S(buf);
    if (!f) return;
    const ctx = { player: state.player, gameUrl: state.gameUrl };
    const ok = handle(conn, f.module, f.cmd, f.ssid, f.body, ctx);
    if (!ok) log("[miss] mod" + f.module + "/cmd" + f.cmd);
  };

  socket.onopen = () => {
    clients.add(socket);
    log("[ws] open, 在线 " + clients.size);
  };

  socket.onmessage = (ev) => {
    let buf;
    if (ev.data instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(ev.data));
    else if (typeof ev.data === "string") buf = Buffer.from(ev.data, "binary");
    else return;
    if (!state.ready) {
      state.queue.push(buf);
      return;
    }
    run(buf);
  };

  socket.onclose = () => {
    clients.delete(socket);
    if (state.player) bg(flushSave(state.player));
    log("[ws] close, 在线 " + clients.size);
  };

  socket.onerror = (e) => log("[ws] error " + (e && e.message ? e.message : ""));

  // 先拉表 + 读档，再处理积压的包
  return (async () => {
    try {
      await tables();
      state.player = await getPlayer(PLAYER_ID);
      state.ready = true;
      const q = state.queue;
      state.queue = [];
      for (const b of q) run(b);
    } catch (e) {
      log("[init] fail: " + e.message);
      conn.close();
    }
  })();
}

// 握手地址换成 wss://host（客户端拿它连房间服）
function wsUrlOf(req) {
  const u = new URL(req.url);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + u.host;
}

// 静态资源代理：页面用 <base> 指向本服务的 /res/，
// 其余缺省资源回源官方 CDN，remoteConfig（CDN 上没有）回源 PHP 主机
const CDN_RES = "https://menggui-cdnres.bhsg.lintey.com/huawei/web-mobile";
const PHP_ORIGIN = PHP_BASE.replace(/\/sy_api\/?$/, "");

async function serveRes(pathAfterRes) {
  const rel = pathAfterRes.replace(/^\/+/, "");
  const cors = {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=86400",
  };
  if (!rel || rel.includes("..")) return new Response("bad path", { status: 400, headers: cors });
  const src = rel.startsWith("remoteConfig/") ? PHP_ORIGIN + "/" + rel : CDN_RES + "/" + rel;
  let r;
  try {
    r = await fetch(src, { headers: { "user-agent": "ygjsz-private/1.0" } });
  } catch (e) {
    return new Response("upstream fail: " + e.message, { status: 502, headers: cors });
  }
  if (!r.ok) return new Response(String(r.status), { status: r.status, headers: cors });
  const h = new Headers(cors);
  h.set("content-type", r.headers.get("content-type") || "application/octet-stream");
  return new Response(r.body, { status: 200, headers: h });
}

Deno.serve({ port: PORT }, async (req) => {
  const upgrade = (req.headers.get("upgrade") || "").toLowerCase();
  if (upgrade !== "websocket") {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/res/")) return await serveRes(u.pathname.slice(5));
    if (u.pathname === "/health") {
      let t = "not loaded";
      try {
        await tables();
        t = "ok schema=" + Object.keys(SCHEMA).length;
      } catch (e) {
        t = "fail " + e.message;
      }
      return new Response(JSON.stringify({ ok: t.startsWith("ok"), tables: t, online: clients.size }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response("YG private game server\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  bg(attach(socket, wsUrlOf(req)));
  return response;
});
