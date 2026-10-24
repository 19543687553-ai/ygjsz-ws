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

// 未实现的指令统计：客户端点了某个功能、服务端没接住，就会记在这里，
// 通过 GET /logs?token=xxx 读出来，用来定位「哪个玩法打不开」
const MISS = new Map();
function miss(module, cmd, battle) {
  const k = (battle ? "battle " : "") + module + "/" + cmd;
  const e = MISS.get(k) || { n: 0, at: 0 };
  e.n++;
  e.at = now();
  MISS.set(k, e);
  log("[miss] " + k);
}

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
      // 表里的 Map 值类型用 ref 表示（如 localStorage: Map<string, CacheInfo>），
      // 老存档可能只存了字符串，这里自动补成 {value, dt}
      const valRef = def.valRef || def.ref;
      const valIsObj = def.valType === "object" || (!def.valType && !!valRef);
      // Map 的值类型在 schema 里写在 type 上（如 attr: Map<uint32,uint32> → type:"uint32"），
      // 以前一律当字符串编，英雄/建筑的属性表会对不上
      const valType = def.valType || (valIsObj ? "object" : def.type && def.type !== "object" ? def.type : "string");
      // key 类型：schema 只写了值类型，数字 key（如英雄 attr Map<uint32,uint32>）要编成 varint，
      // 字符串 key（如 localStorage 的 UnlockFun）要编成 bytes，按实际 key 判断
      const keyType = def.keyType ||
        (entries.length && entries.every(([k]) => /^\d+$/.test(String(k))) ? "uint32" : "string");
      for (const [k, val] of entries) {
        const sub = new Writer();
        sub.tag(1, wireTypeOf(keyType));
        encodeScalar(sub, keyType, k);
        sub.tag(2, wireTypeOf(valType));
        if (valIsObj) {
          const inner = val && typeof val === "object" ? val : { value: String(val), dt: 0 };
          sub.bytes(encode(valRef, inner));
        } else encodeScalar(sub, valType, val);
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
    // 必须把字段本身的类型带上：Map 的值类型就写在 f.type 上
    // （attr: Map<uint32,uint32> → type:"uint32"），漏了会被当成字符串编码，
    // 客户端解析 StartGameP 时会直接报「协议解析发生错误」
    const md = Object.assign({}, f, (mapDefs || {})[name + "." + f.name] || {});
    encodeField(w, f, v, md);
  }
  return w.result();
}

// 解码后的 int64 是 BigInt，JSON.parse(JSON.stringify()) 会直接抛错，
// 自己写一个深拷贝，BigInt 原样保留
function deepClone(o) {
  if (o === null || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map(deepClone);
  const r = {};
  for (const k of Object.keys(o)) r[k] = deepClone(o[k]);
  return r;
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
      const md = Object.assign({}, f, (mapDefs || {})[name + "." + f.name] || {});
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
    const wire = k & 7;
    // Map 的 key 没有 schema 说明类型，只能看 wire type：
    // 0 = varint（Map<uint32,uint32> 的数字 key），2 = 字符串
    if (tag === 1) key = wire === 0 ? String(readVarint(buf, pos)) : decodeScalar(buf, pos, "string");
    else if (tag === 2) {
      const vRef = md.valRef || md.ref;
      if (vRef) val = decode(vRef, readBytes(buf, pos), null);
      else val = wire === 0 ? readVarint(buf, pos) : decodeScalar(buf, pos, "string");
    } else {
      if (wire === 0) readVarint(buf, pos);
      else if (wire === 2) readBytes(buf, pos);
      else if (wire === 1) pos.i += 8;
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

// 从官方抓包（2/12）里抄下来的已完成新手引导步骤
const GUIDE_DEFAULT = '{"10019000":1,"10021000":1,"10013000":1,"10022000":1,"10020000":1}';

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
    // 客户端会 JSON.parse 后当字典用，必须是对象字符串，不能是纯数字。
    // 先用官方抓包里已完成的新手引导，避免一直卡在“位置校验失败”
    guide: GUIDE_DEFAULT,
    guideFlag: false,
    localStorage: { UnlockFun: { value: "51000,5300,2201,49000", dt: 0 } },
    // GM 改过英雄等级后记在这，23/1 回包时套用
    heroLevel: 0,
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
  // 兼容老存档：guide 必须是 JSON 对象串（客户端会 parse 后当字典写入）
  if (typeof p.guide !== "string" || p.guide.trim()[0] !== "{" || p.guide.trim() === "{}") p.guide = GUIDE_DEFAULT;
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
  const o = deepClone(tpl);
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

// 英雄列表：官方抓包里 23/1 的真实回包，升级等操作都以它为底
let heroTpl = null;
function heroList() {
  if (heroTpl) return heroTpl;
  heroTpl = [];
  const rp = REPLAY.pairs && REPLAY.pairs["23/1"];
  if (!rp) return heroTpl;
  try {
    heroTpl = decode("GetHeroInfoR_Hero_S2C", Buffer.from(rp.raw, "base64")).heroList || [];
    log("[hero] 载入英雄 " + heroTpl.length + " 个");
  } catch (e) {
    log("[hero] 解析失败: " + e.message);
  }
  return heroTpl;
}

// 整个 23/1 回包模板，GM 改英雄等级后要重新编码
let heroFullTpl = null;
function heroFull() {
  if (heroFullTpl) return heroFullTpl;
  heroFullTpl = null;
  const rp = REPLAY.pairs && REPLAY.pairs["23/1"];
  if (!rp) return heroFullTpl;
  try {
    heroFullTpl = decode("GetHeroInfoR_Hero_S2C", Buffer.from(rp.raw, "base64"));
  } catch (e) {
    log("[hero] 完整包解析失败: " + e.message);
  }
  return heroFullTpl;
}

// 挂机（离线收益）基础信息
// isGetFirstCustoms 是主城「开始挑战」按钮的开关：
// AdventureMainCom 里 btn_adv_challenge.active = isGetFirstCoustomReward && 状态!=LOCK，
// 之前这里写 false，11/13 回包又会 updateNewAdvInfoByInfo 覆盖掉登录推包里的 true，
// 结果按钮被隐藏、只剩「已通关请领取奖励」，什么都点不了。
// hangUpTime 给 0：不要一登录就弹离线收益窗
function adventureInfo(p) {
  return {
    level: 2,
    chapterId: 1,
    // 主线体力：AdventureMainCom._onBtnChalenge 里先判断
    // getNewAdvLessTime() < costs[2]，不足就直接弹「购买体力」窗口，
    // 根本走不到进对局那一步。抓包真实值是 25，这里给 25。
    lessTimes: 25,
    buyTimes: 0,
    // getDt 是「挂机收益计时起点」，客户端 checkHangupOfflineReward 里判断
    // 当前时间 - getDt >= 7200 就自动弹「离线收益」窗（而且这个窗没有关闭按钮）。
    // 之前给的是账号创建时间，必然超过 2 小时 → 一登录就弹、挡死所有点击。
    getDt: now(),
    targetList: [],
    hangUpExtendTime: 0,
    levelRewardFlag: [],
    shareNum: 0,
    shareFlag: [],
    alreadyReward: [],
    inspireEndDt: 0,
    inspireType: 0,
    drumBuyLimit: {},
    buyRechargeCard: false,
    levelInfos: [],
    sweepTimes: 3,
    flushTime: now(),
    infoList: [],
    storageTimes: 0,
    isGetFirstCustoms: true,
    hangUpTime: 0,
    maxHangUpTime: 43200,
  };
}

// 离线挂机奖励：type 1=金币 2=钻石 3=道具
function hangUpRewards() {
  return [
    { type: 1, code: 1, num: 500000 },
    { type: 2, code: 2, num: 5000 },
    { type: 3, code: 30000004, num: 100 },
  ];
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
// 2/12 先直接用抓包真实回包：自己重编码的字段类型和客户端对不上，解析会报错
const OWN_CMDS = new Set(["1/2", "2/1", "2/6", "2/8", "2/14", "2/18", "5/174", "82/1", "82/4", "90/1", "90/3"]);

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
  // 23/1 被 GM 改过英雄等级时要自己编码，不能直接回放旧包
  const forceOwn = mod === 23 && cmd === 1 && p.heroLevel;
  if (!forceOwn && !OWN_CMDS.has(key0) && REPLAY.pairs && REPLAY.pairs[key0]) {
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
  }

  // 战斗房间 module 82 (Build)
  if (mod === 82) {
    if (cmd === 1) {
      // 以前 addr 指向游戏服自己、authCode 是写死的假值，
      // 客户端连上去后没人处理 90/Auth，也收不到 StartGameP，所以永远进不了对局。
      // 现在把 addr 指到本服务的战斗房间通道（?role=battle），由 handleBattle 接手。
      const bt = req ? Number(req.battleType) || 0 : 0;
      const lv = req ? Number(req.level) || 1 : 1;
      const auth = "yg" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const host = String(ctx.gameUrl || "").replace(/\/+$/, "");
      const vs = req
        ? "&bv=" + encodeURIComponent(req.battleVersion || "") +
          "&cv=" + encodeURIComponent(req.configVersion || "") +
          "&mv=" + encodeURIComponent(req.mapVersion || "")
        : "";
      reply(2, "EnterRoomR_Build_S2C", {
        err: 0,
        authCode: auth,
        addr: host + "/ws?role=battle&auth=" + auth + "&bt=" + bt + "&lv=" + lv + vs,
        battleType: bt,
        pingInterval: 40,
        frameInterval: 30,
      });
      return true;
    }
    if (cmd === 4) {
      reply(5, "QuitRoomR_Build_S2C", { err: 0 });
      return true;
    }
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
  }

  // 冒险 / 挂机收益 module 11（Adventure）
  if (mod === 11) {
    if (cmd === 4) {
      reply(5, "GetAdventureInfoR_Adventure_S2C", { err: 0, info: adventureInfo(p) });
      return true;
    }
    if (cmd === 36) {
      // 主线体力查询，和 AdventureInfo.lessTimes 保持一致，
      // 否则界面/校验一边是 25 一边是 0，会莫名提示体力不足
      reply(37, "GetPowerInfoR_Adventure_S2C", { err: 0, lessTimes: 25, flushTime: now() });
      return true;
    }
    if (cmd === 13) {
      // 挂机收益预览：真实账号 hangUpTime=0 时服务端回空奖励，
      // 客户端就不会弹「挂机收益」窗口。之前这里固定回一堆奖励，
      // 导致一登录/一进战斗就弹窗，而且没完整数据时点「领取」关不掉。
      reply(14, "GetHangUpShowRewardsR_Adventure_S2C", {
        err: 0,
        info: { ...adventureInfo(p), hangUpTime: 0 },
        showRewards: [],
      });
      return true;
    }
    if (cmd === 8) {
      const got = hangUpRewards();
      for (const r of got) {
        const it = p.items.find((x) => x.code === r.code);
        if (it) it.num += r.num;
        else p.items.push({ code: r.code, num: r.num });
      }
      queueSave(p);
      const after = adventureInfo(p);
      after.hangUpTime = 0; // 已领取，清空挂机时长，客户端才会收起弹窗
      reply(9, "GetHangUpRewardsR_Adventure_S2C", {
        err: 0,
        info: after,
        clientReward: {
          money: got.filter((r) => r.type <= 2),
          items: got.filter((r) => r.type >= 3),
        },
      });
      return true;
    }
  }

  // 英雄 module 23：升级 / 升阶等都基于抓包里的真实英雄数据
  if (mod === 23) {
    if (cmd === 1 && p.heroLevel) {
      const tpl = heroFull();
      if (tpl) {
        try {
          const o = deepClone(tpl);
          o.err = 0;
          if (Array.isArray(o.heroList)) {
            for (const h of o.heroList) h.level = p.heroLevel;
          }
          reply(2, "GetHeroInfoR_Hero_S2C", o);
          return true;
        } catch (e) {
          log("[hero] GM 等级回包失败，回退原包: " + e.message);
        }
      }
    }
    if (cmd === 3) {
      const list = heroList();
      const h = list.find((x) => x.uuid === (req && req.uuid)) || list[0];
      if (h) {
        const up = deepClone(h);
        up.level = (up.level || 1) + 1;
        up.fightCap = Math.round((up.fightCap || 0) * 1.2);
        reply(4, "HeroUpGradeR_Hero_S2C", { err: 0, hero: up });
        return true;
      }
    }
    if (cmd === 5 || cmd === 7) {
      const list = heroList();
      const h = list.find((x) => x.uuid === (req && req.uuid)) || list[0];
      if (h) {
        const up = deepClone(h);
        if (cmd === 5) up.section = (up.section || 0) + 1;
        else up.crown = (up.crown || 0) + 1;
        up.fightCap = Math.round((up.fightCap || 0) * 1.2);
        reply(cmd + 1, cmd === 5 ? "HeroUpSectionR_Hero_S2C" : "HeroUpStarR_Hero_S2C", { err: 0, hero: up });
        return true;
      }
    }
  }

  // 抽卡 module 26
  if (mod === 26) {
    if (cmd === 1) {
      // freeSummon / extractInfo / wishInfo 不传的话客户端拿不到免费次数，
      // 抽卡界面会“点了没反应”，这里把每种卡池的免费次数都置 0（都可免单一次）
      reply(2, "GetSearchSummonInfoR_SearchSummon_S2C", {
        err: 0,
        freeSummon: [1, 2, 6, 7, 8, 9, 10].map((t) => ({ type: t, num: 0 })),
        extractInfo: [],
        wishInfo: [],
        isContinuous: false,
        autoContinuousBtn: false,
      });
      return true;
    }
    if (cmd === 3) {
      const times = (req && req.code) === 1010 ? 10 : 1;
      const got = [];
      for (let i = 0; i < times; i++) {
        const code = 30000004 + (i % 8);
        addItem(p, code, 1);
        got.push({ type: 3, code, num: 1 });
      }
      reply(4, "GetSummonRewardR_SearchSummon_S2C", {
        err: 0,
        freeSummon: [1, 2, 6, 7, 8, 9, 10].map((t) => ({ type: t, num: 0 })),
        extractInfo: [],
        clientReward: { items: got },
        // 抽卡动画会读 fakeReward.entites，不传的话飞卡动画直接抛
        // TypeError: Cannot read properties of null (reading 'entites')
        fakeReward: got,
        specialNum: 0,
        luckyNum: 0,
      });
      return true;
    }
  }

  // 钱包查询 module 13：GM 改完客户端会重新拉一次，返回存档里的值
  if (mod === 13 && cmd === 1) {
    reply(2, "GetPlayerMoneyR_PlayerInfo_S2C", {
      err: 0,
      playerMoney: { money: [p.money.diamond, p.money.gold] },
    });
    return true;
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

  // "增加资源/添加货币/添加道具" 都是这条：rewards = [[type, code, num], ...]
  // type 1 = 货币（code 1 金币 / 2 钻石），type 3 = 道具
  if (cmd === "AddRewards") {
    const a = parseExtra(extra) || {};
    let list = a.rewards;
    if (typeof list === "string") {
      try {
        list = JSON.parse(list);
      } catch (e) {
        list = null;
      }
    }
    if (!Array.isArray(list)) return "bad rewards";
    const parts = [];
    for (const r of list) {
      if (!Array.isArray(r) || r.length < 3) continue;
      const type = Number(r[0]);
      const code = Number(r[1]);
      const num = Number(r[2]) || 0;
      if (type === 1) {
        if (code === 1) {
          p.money.gold += num;
          parts.push("金币+" + num);
        } else if (code === 2) {
          p.money.diamond += num;
          parts.push("钻石+" + num);
        }
      } else if (addItem(p, code, num)) {
        parts.push(itemName(code) + "×" + num);
      }
    }
    queueSave(p);
    return "ok " + (parts.join("，") || "无变化");
  }

  if (cmd === "addItem") {
    const a = parseExtra(extra) || {};
    const code = Number(a.code || a.id || 0);
    const num = Number(a.num || a.count || 0);
    return addItem(p, code, num) ? "added " + code + " x" + num + " (" + itemName(code) + ")" : "bad code";
  }

  if (cmd === "addExp") {
    const a = parseExtra(extra) || {};
    const num = Number(a.num || 0);
    p.exp = (p.exp || 0) + num;
    queueSave(p);
    return "经验+" + num + "（总 " + p.exp + "）";
  }

  // 直接改玩家等级：setLevel_99
  if (/^setLevel_\d+/.test(extra)) {
    const n = Number(extra.split("_")[1]) || 1;
    p.level = n;
    queueSave(p);
    return "等级 → " + n;
  }

  // 所有英雄等级：gm_hero_setAllHeroLevelGM_{ "level": 99 }
  if (/^gm_hero_setAllHeroLevelGM_/.test(extra)) {
    const i = extra.indexOf("{");
    const a = i > 0 ? parseExtra(extra.slice(i)) : null;
    const lv = a && Number(a.level);
    if (lv) {
      p.heroLevel = lv;
      queueSave(p);
      return "所有英雄等级 → " + lv;
    }
    return "ok";
  }

  if (/^addItem_\d+/.test(extra)) {
    const a = extra.split("_");
    return addItem(p, Number(a[1]), Number(a[2] || 1)) ? "added " + a[1] : "bad";
  }

  if (cmd === "adventureSkipLevel") {
    p.adventureLevel = Number(extra) || 1;
    queueSave(p);
    return "adventureLevel=" + p.adventureLevel;
  }

  // 其余 GM 指令（装备、神器、遗物等）本服没有对应系统，回 ok 让客户端继续
  return "ok";
}

// ---------------- 战斗房间（module 90） ----------------
// 客户端收到 82/1 的 addr 后会自己连过来，先发 90/1 Auth，
// 认证通过后服务端必须主动推 90/12 StartGameP，战斗才会真正开始。
// 主线/爬塔/挂机这类 battleType 的 getFrameSyncType() 都是 Local，
// 也就是战场跑在客户端本地，只要 StartGameP 数据对就能打，不需要逐帧同步。
function battleStartGameP(p, bt, lv, params) {
  const heros = (heroList() || []).map((h) => {
    const o = deepClone(h);
    if (p && p.heroLevel) o.level = p.heroLevel;
    return o;
  });
  const builds = [
    // Door：Life=2，Defence=3。血量拉满，保证战场不会因为基地被打爆而秒退
    { type: 1, attr: { 2: 1000000000, 3: 1 } },
  ];
  const organs = [1, 2, 3, 4, 5, 6, 7, 8].map((c) => ({
    code: c,
    star: c === 2 || c === 5 || c === 8 ? 4 : 1,
    level: 1,
    skillCode: 0,
  }));
  return {
    playerInfos: [
      {
        playerId: p.playerId,
        heros,
        builds,
        organs,
        identity: 1,
      },
    ],
    uuid: String(Date.now()),
    battleType: bt,
    level: lv,
    battleVersion: params.get("bv") || "",
    configVersion: params.get("cv") || "",
    mapVersion: params.get("mv") || "",
    adventureLevel: lv,
    mapId: 0,
  };
}

function handleBattle(conn, state, mod, cmd, ssid, body, params) {
  const p = state.player;
  const reply = (cmdOut, msg, obj) => {
    conn.send(encodeS2C(mod, cmdOut, ssid, tryEncode(msg, obj)));
  };

  if (mod === 90) {
    if (cmd === 1) {
      reply(2, "AuthR_BuildRoom_S2C", { err: 0 });
      const bt = Number(params.get("bt")) || 0;
      const lv = Number(params.get("lv")) || 1;
      setTimeout(() => {
        try {
          const sp = battleStartGameP(p, bt, lv, params);
          log("[battle] StartGameP bt=" + bt + " lv=" + lv + " heros=" + sp.playerInfos[0].heros.length);
          conn.send(encodeS2C(90, 12, 0, encode("StartGameP_BuildRoom_S2C", sp)));
        } catch (e) {
          log("[battle] StartGameP fail: " + e.message);
        }
      }, 300);
      return true;
    }
    if (cmd === 3) {
      reply(4, "PingR_BuildRoom_S2C", { err: 0, sysDt: now() });
      return true;
    }
    // 其余指令统一按 cmd+1 回 {err:0}，让客户端继续跑
    const outCmd = cmd + 1;
    const outName = msgOf(90, outCmd);
    if (outName) {
      reply(outCmd, outName, { err: 0 });
      return true;
    }
    return false;
  }

  if (mod === 82 && (cmd === 4 || cmd === 6)) {
    reply(cmd === 4 ? 5 : 7, msgOf(82, cmd === 4 ? 5 : 7) || "QuitRoomR_Build_S2C", { err: 0 });
    return true;
  }

  return false;
}

// ---------------- 连接 ----------------
const clients = new Set();

function attach(socket, gameUrl, role, params) {
  socket.binaryType = "arraybuffer";
  const isBattle = role === "battle";
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
    if (isBattle) {
      const ok = handleBattle(conn, state, f.module, f.cmd, f.ssid, f.body, params);
      if (!ok) miss(f.module, f.cmd, true);
      return;
    }
    const ctx = { player: state.player, gameUrl: state.gameUrl };
    const ok = handle(conn, f.module, f.cmd, f.ssid, f.body, ctx);
    if (!ok) miss(f.module, f.cmd, false);
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

// 游戏服地址：必须不带协议（客户端会自己拼 wss://，带了就变成 wss://wss//...）
function wsUrlOf(req) {
  const u = new URL(req.url);
  return u.host + "/";
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
    // 未实现指令统计：/logs?token=xxx 直接看，用于排查某个玩法为什么点了没反应
    if (u.pathname === "/logs") {
      if (u.searchParams.get("token") !== TOKEN) {
        return new Response(JSON.stringify({ err: "token" }), {
          status: 403,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const list = Array.from(MISS.entries())
        .sort((a, b) => b[1].n - a[1].n)
        .map(([k, v]) => ({ cmd: k, count: v.n, at: v.at }));
      return new Response(JSON.stringify({ online: clients.size, miss: list }, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response("YG private game server\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  const q = new URL(req.url).searchParams;
  bg(attach(socket, wsUrlOf(req), q.get("role") || "", q));
  return response;
});
