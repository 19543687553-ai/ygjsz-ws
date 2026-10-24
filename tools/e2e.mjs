// 端到端联调：真实 WebSocket 走完整流程
import { c2s, decode, J, encode } from "./pb.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:8010";
const WSURL = BASE.replace(/^http/, "ws") + "/";

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  ✔ " + name + (extra ? "  " + extra : ""));
  } else {
    fail++;
    console.log("  ✘ " + name + (extra ? "  " + extra : ""));
  }
}

class Conn {
  constructor(url) {
    this.frames = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.closed = new Promise((r) => (this._closedResolve = r));
    this.ws.onmessage = (ev) => {
      const buf = Buffer.from(new Uint8Array(ev.data));
      const total = buf.readUInt16BE(0); // = 7 + body.length
      const f = { module: buf[5], cmd: buf.readUInt16BE(6), body: buf.subarray(9, total + 2) };
      f.raw = buf;
      this.frames.push(f);
      const i = this.waiters.findIndex((w) => w.module === f.module && w.cmd === f.cmd);
      if (i >= 0) {
        f.used = true;
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(f);
      }
    };
    this.ws.onclose = () => this._closedResolve({ code: this.ws._closeCode || 0 });
    this.ws.onerror = () => {};
  }
  open() {
    if (this.ws.readyState === 1) return Promise.resolve(this);
    return new Promise((res, rej) => {
      this.ws.onopen = () => res(this);
      setTimeout(() => rej(new Error("ws open timeout")), 8000);
    });
  }
  send(module, cmd, obj, msgName) {
    this.ws.send(c2s(module, cmd, obj, msgName));
  }
  raw(buf) {
    this.ws.send(buf);
  }
  wait(module, cmd, ms = 8000) {
    const i0 = this.frames.findIndex((f) => !f.used && f.module === module && f.cmd === cmd);
    if (i0 >= 0) {
      this.frames[i0].used = true;
      return Promise.resolve(this.frames[i0]);
    }
    return new Promise((res, rej) => {
      const w = { module, cmd, resolve: res };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        rej(new Error(`wait ${module}/${cmd} timeout`));
      }, ms);
      this.waiters.push(w);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("== 1. 连接游戏服 ==");
  const c = await new Conn(WSURL).open();
  ok("WebSocket 连上", true);

  console.log("== 2. 登录 ==");
  c.send(2, 1, {}, "LoginGame_LoginGame_C2S");
  const login = await c.wait(2, 2);
  const lr = decode("LoginGameR_LoginGame_S2C", login.body);
  ok("LoginGameR err=0", Number(lr.err) === 0, J(lr).slice(0, 120));

  c.send(2, 12, {}, "GetLoginGameCommonInfo_LoginGame_C2S");
  const common = await c.wait(2, 13, 10000);
  const cr = decode("GetLoginGameCommonInfoR_LoginGame_S2C", common.body);
  ok("GetLoginGameCommonInfoR", !!cr.playerInfo, "items=" + ((cr.playerItem || {}).items || []).length);

  console.log("== 3. 未完成房间 ==");
  c.send(82, 6, null, null);
  const un = decode("UnfinishedRoomR_Build_S2C", (await c.wait(82, 7)).body);
  ok("82/6 回 battleType=0", Number(un.battleType) === 0, J(un));

  console.log("== 4. 进战斗房间 ==");
  c.send(82, 1, { battleType: 3, level: 2 }, "EnterRoom_Build_C2S");
  const er = decode("EnterRoomR_Build_S2C", (await c.wait(82, 2)).body);
  ok("EnterRoomR err=0", Number(er.err) === 0, "addr=" + er.addr);
  ok("EnterRoomR 带 addr/authCode", !!er.addr && !!er.authCode);
  ok("addr 不含协议前缀", String(er.addr || "").indexOf("://") < 0, String(er.addr).slice(0, 80));

  // 连战斗服
  const b = await new Conn("ws://" + er.addr).open();
  b.send(90, 1, { authCode: er.authCode, playerId: 67820771, platform: "h5" }, "Auth_BuildRoom_C2S");
  const ar = decode("AuthR_BuildRoom_S2C", (await b.wait(90, 2)).body);
  ok("90/1 AuthR err=0", Number(ar.err) === 0, J(ar));

  const sgpFrame = await b.wait(90, 12, 8000);
  const sgp = decode("StartGameP_BuildRoom_S2C", sgpFrame.body);
  ok("收到 90/12 StartGameP", true, "bytes=" + sgpFrame.body.length);
  ok("6 个 playerInfos", (sgp.playerInfos || []).length === 6, (sgp.playerInfos || []).map((x) => x.playerId).join(","));
  ok("每人 109 builds", (sgp.playerInfos || []).every((x) => (x.builds || []).length === 109));
  ok("真人 roomCode=6", Number(sgp.playerInfos[0].roomCode) === 6);
  ok("机器人都是 roomCode=0", (sgp.playerInfos || []).slice(1).every((x) => !x.roomCode || Number(x.roomCode) === 0));
  ok("battleVersion/configVersion/mapVersion", !!sgp.battleVersion && !!sgp.configVersion && !!sgp.mapVersion,
    [sgp.battleVersion, sgp.configVersion, sgp.mapVersion].join(" "));
  const b0 = sgp.playerInfos[0].builds[0];
  ok("build attr 是 Map 不是字符串", b0 && b0.attr && typeof b0.attr["1"] !== "undefined", J(b0 && b0.attr));
  ok("uuid 非空", !!sgp.uuid, sgp.uuid);

  console.log("== 5. 打完一关（QuitRoom Win）==");
  c.send(82, 4, { battleType: 3, type: 1, endFrame: 100, totalTime: 30, operations: [] }, "QuitRoom_Build_C2S");
  const qr = decode("QuitRoomR_Build_S2C", (await c.wait(82, 5)).body);
  ok("82/5 err=0 result=1 uuid", Number(qr.err) === 0 && Number(qr.result) === 1 && !!qr.uuid, J(qr));

  const advPush = await c.wait(11, 12, 5000);
  const adv = decode("AdventureInfoP_Adventure_S2C", advPush.body);
  ok("过关后推 11/12 且 level 推进到 3", Number(adv.info.level) === 3, "level=" + adv.info.level);

  console.log("== 6. 下一关能再进 ==");
  c.send(82, 1, { battleType: 3, level: 3 }, "EnterRoom_Build_C2S");
  const er2 = decode("EnterRoomR_Build_S2C", (await c.wait(82, 2)).body);
  ok("第二关 EnterRoomR err=0", Number(er2.err) === 0, "addr=" + String(er2.addr).slice(0, 60));
  const b2 = await new Conn("ws://" + er2.addr).open();
  b2.send(90, 1, { authCode: er2.authCode, playerId: 67820771, platform: "h5" }, "Auth_BuildRoom_C2S");
  await b2.wait(90, 2);
  const sgp2 = decode("StartGameP_BuildRoom_S2C", (await b2.wait(90, 12)).body);
  ok("第二关 StartGameP level=3 且 6 人", Number(sgp2.level) === 3 && sgp2.playerInfos.length === 6, "lv=" + sgp2.level);

  console.log("== 7. GM ==");
  c.send(5, 174, { cmd: "AddRewards", extra: '{"rewards":"[[1,2,1000]]"}' }, "MakeTestOper_Test_C2S");
  const gm = decode("MakeTestOperR_Test_S2C", (await c.wait(5, 175)).body);
  ok("5/175 err=0 带 clientReward", Number(gm.err) === 0 && gm.clientReward && (gm.clientReward.money || []).length > 0, J(gm).slice(0, 160));
  c.send(13, 1, null, null);
  const money = decode("GetPlayerMoneyR_PlayerInfo_S2C", (await c.wait(13, 2)).body);
  ok("钻石已加 1000（落档生效）", Number(money.playerMoney.money[0]) > 1000000, J(money.playerMoney.money));

  c.send(5, 174, { cmd: "gmStr", extra: "gm_hero_setAllHeroLevelGM_{ \"level\": 88 }" }, "MakeTestOper_Test_C2S");
  await c.wait(5, 175);
  const hp = decode("HeroInfoP_Hero_S2C", (await c.wait(23, 9, 5000)).body);
  ok("英雄满级后推 23/9 且 level=88", (hp.heroList || []).every((h) => Number(h.level) === 88), "n=" + (hp.heroList || []).length);

  c.send(5, 174, { cmd: "adventureSkipLevel", extra: "15" }, "MakeTestOper_Test_C2S");
  await c.wait(5, 175);
  const adv2 = decode("AdventureInfoP_Adventure_S2C", (await c.wait(11, 12, 5000)).body);
  ok("GM 跳关 → 推 11/12 level=15", Number(adv2.info.level) === 15, "level=" + adv2.info.level);

  console.log("== 8. 未实现指令统计 ==");
  c.send(231, 1, null, null);
  await sleep(300);
  const logs = await (await fetch(BASE + "/logs?token=CHANGE_ME_请替换成自己的token")).json();
  ok("/logs 记录到 231/1", (logs.miss || []).some((x) => x.cmd === "231/1"), J(logs.miss).slice(0, 120));

  console.log("== 9. 维护模式拦截 ==");
  const adminUrl = process.env.PHP + "/admin.php?token=CHANGE_ME_请替换成自己的token";
  let r = await fetch(adminUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "act=on&msg=" + encodeURIComponent("联调维护中") + "&end=",
  });
  ok("admin 开启维护 200", r.ok);
  let st = await (await fetch(process.env.PHP + "/maint.php")).json();
  ok("maint.php on=1", st.on === 1, J(st));

  // 接口拦截
  const api = await (await fetch(process.env.PHP + "/game_api.php?action=login")).json();
  ok("game_api.php 维护拦截", api.maintenance === 1 && api.msg === "联调维护中", J(api).slice(0, 100));

  // WS 拦截（等缓存过期）
  await sleep(11000);
  let blocked = false;
  let status = 0;
  try {
    const bad = new Conn(WSURL);
    await bad.open();
    bad.close();
  } catch (e) {
    blocked = true;
  }
  const hres = await fetch(BASE + "/health");
  status = hres.status;
  const hj = await hres.json();
  ok("维护中 WS 连接被拒", blocked);
  ok("/health maintenance=true", hj.maintenance === true, J(hj));

  // 关闭维护，恢复
  r = await fetch(adminUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "act=off&msg=" + encodeURIComponent("服务器维护中，请稍后再试") + "&end=",
  });
  ok("admin 关闭维护", r.ok);
  await sleep(11000);
  const h2 = await (await fetch(BASE + "/health")).json();
  ok("关闭后 maintenance=false", h2.maintenance === false, J(h2).slice(0, 120));
  let reopened = false;
  try {
    const good = new Conn(WSURL);
    await good.open();
    reopened = true;
    good.close();
  } catch (e) {
    reopened = false;
  }
  ok("关闭后 WS 可再连", reopened);

  c.close();
  b.close();
  b2.close();
  console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
