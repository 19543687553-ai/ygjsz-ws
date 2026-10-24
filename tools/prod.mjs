// 线上验证：真连 Deno，确认 6 人房 StartGameP 下发正常（不做结算、不动数值）
import { c2s, decode } from "./pb.mjs";

const WS = "wss://ygjsz-ws.19543687553-ai.deno.net/";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => (c ? (pass++, console.log("  ✔ " + n + (x ? "  " + x : ""))) : (fail++, console.log("  ✘ " + n + (x ? "  " + x : ""))));

function conn(url) {
  const c = { frames: [], waiters: [] };
  c.ws = new WebSocket(url);
  c.ws.binaryType = "arraybuffer";
  c.ws.onmessage = (ev) => {
    const buf = Buffer.from(new Uint8Array(ev.data));
    const f = { module: buf[5], cmd: buf.readUInt16BE(6), body: buf.subarray(9, buf.readUInt16BE(0) + 2) };
    c.frames.push(f);
    const i = c.waiters.findIndex((w) => w.module === f.module && w.cmd === f.cmd);
    if (i >= 0) { f.used = true; const w = c.waiters.splice(i, 1)[0]; clearTimeout(w.t); w.res(f); }
  };
  c.open = () => new Promise((res, rej) => { c.ws.onopen = () => res(); setTimeout(() => rej(new Error("open timeout")), 12000); });
  c.send = (m, cm, obj, name) => c.ws.send(c2s(m, cm, obj, name));
  c.wait = (m, cm, ms = 15000) => new Promise((res, rej) => {
    const i = c.frames.findIndex((f) => !f.used && f.module === m && f.cmd === cm);
    if (i >= 0) { c.frames[i].used = true; return res(c.frames[i]); }
    const w = { module: m, cmd: cm, res };
    w.t = setTimeout(() => { const k = c.waiters.indexOf(w); if (k >= 0) c.waiters.splice(k, 1); rej(new Error(`wait ${m}/${cm} timeout`)); }, ms);
    c.waiters.push(w);
  });
  return c;
}

(async () => {
  console.log("== 线上 /health ==");
  const h = await (await fetch("https://ygjsz-ws.19543687553-ai.deno.net/health")).json();
  ok("health 有新字段 maintenance", Object.prototype.hasOwnProperty.call(h, "maintenance"), JSON.stringify(h));

  console.log("== 线上登录 ==");
  const c = conn(WS);
  await c.open();
  ok("wss 连上", true);
  c.send(2, 1, {}, "LoginGame_LoginGame_C2S");
  const lr = decode("LoginGameR_LoginGame_S2C", (await c.wait(2, 2)).body);
  ok("LoginGameR err=0", Number(lr.err) === 0);

  c.send(82, 6, null, null);
  const un = decode("UnfinishedRoomR_Build_S2C", (await c.wait(82, 7)).body);
  ok("82/6 battleType=0（不会自动放弃）", Number(un.battleType) === 0);

  c.send(82, 1, { battleType: 3, level: 2 }, "EnterRoom_Build_C2S");
  const er = decode("EnterRoomR_Build_S2C", (await c.wait(82, 2)).body);
  ok("82/1 EnterRoomR err=0", Number(er.err) === 0, "addr=" + String(er.addr).slice(0, 60));
  ok("addr 指向 Deno + 不带协议", String(er.addr).indexOf("deno.net") > 0 && String(er.addr).indexOf("://") < 0);

  const b = conn("wss://" + er.addr);
  await b.open();
  b.send(90, 1, { authCode: er.authCode, playerId: 67820771, platform: "h5" }, "Auth_BuildRoom_C2S");
  const ar = decode("AuthR_BuildRoom_S2C", (await b.wait(90, 2)).body);
  ok("90/1 AuthR err=0", Number(ar.err) === 0);
  const fr = await b.wait(90, 12);
  const sgp = decode("StartGameP_BuildRoom_S2C", fr.body);
  ok("StartGameP 6 人房", (sgp.playerInfos || []).length === 6, (sgp.playerInfos || []).map((x) => x.playerId).join(","));
  ok("每人 109 builds", (sgp.playerInfos || []).every((x) => (x.builds || []).length === 109));
  ok("版本号齐全", !!sgp.battleVersion && !!sgp.configVersion && !!sgp.mapVersion,
    [sgp.battleVersion, sgp.configVersion, sgp.mapVersion].join(" "));
  const a0 = sgp.playerInfos[0].builds[0].attr || {};
  ok("build.attr 是 Map", String(a0["1"]) === "10", JSON.stringify(a0, (k, v) => (typeof v === "bigint" ? String(v) : v)));

  c.ws.close(); b.ws.close();
  console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
