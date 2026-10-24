// 离线验证（Node 版）：6 人房 StartGameP 能不能正确编码/解码
import { readFileSync } from "node:fs";
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? String(v) : v));

const DATA = "/workspace/php-backend/sy_api/data/";
globalThis.Deno = { env: { get: (k) => process.env[k] } };

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/data.php?f=")) {
    const f = u.split("f=")[1];
    const txt = readFileSync(DATA + f + ".json", "utf8");
    return new Response(txt, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.includes("/internal.php")) {
    return new Response('{"ok":1,"data":null}', { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

const src = readFileSync("/workspace/deno-ws/server.mjs", "utf8");
const cut = src.indexOf("// ---------------- 连接 ----------------");
if (cut < 0) throw new Error("cut point not found");
const code = src.slice(0, cut) +
  "\nexport { tables, encode, decode, decodeC2S, battleStartGameP, runGM, defaultPlayer, playerInfoOf, heroListOf, buildList, adventureInfo };\n";
const mod = await import("data:text/javascript;base64," + Buffer.from(code, "utf8").toString("base64"));

await mod.tables();

const p = mod.defaultPlayer();
p.lastBattleUuid = "testuuid123";
p.heroLevel = 30;
const sp = mod.battleStartGameP(p, 3, 2, new URLSearchParams());
const buf = mod.encode("StartGameP_BuildRoom_S2C", sp);
const back = mod.decode("StartGameP_BuildRoom_S2C", buf);
console.log("bytes", buf.length);
console.log("players", back.playerInfos.length, back.playerInfos.map((x) => x.playerId).join(","));
console.log("builds", back.playerInfos.map((x) => (x.builds || []).length).join(","));
console.log("heros", back.playerInfos.map((x) => (x.heros || []).length).join(","));
console.log("uuid", back.uuid, "bt", back.battleType, "lv", back.level);
console.log("ver", back.battleVersion, back.configVersion, back.mapVersion);
const b0 = back.playerInfos[0].builds[0];
const b4 = back.playerInfos[0].builds[4];
console.log("build0", J(b0, (k,v)=>typeof v==="bigint"?String(v):v), "build4", J(b4, (k,v)=>typeof v==="bigint"?String(v):v));
console.log("hero0", J(back.playerInfos[0].heros[0]).slice(0, 260));

// GM 各条指令跑一遍
const cases = [
  ["AddRewards", '{"rewards":"[[1,2,5000],[3,30000001,10],[4,50000001,7]]"}'],
  ["gmStr", "gm_hero_setAllHeroLevelGM_{ \"level\": 66 }"],
  ["gmStr", "gm_hero_createHeroGM_{ \"code\": 50000099 }"],
  ["gmStr", "gm_hero_giveAllNStarHero_{ \"star\": 6 }"],
  ["gmStr", "setLevel_99"],
  ["adventureSkipLevel", "12"],
  ["gmStr", "SetClimbTowerNum_30"],
  ["gmStr", "gm_artifact_oneClickActivate_{}"],
];
for (const [cmd, extra] of cases) {
  const r = mod.runGM(p, { cmd, extra });
  console.log("GM", cmd, J(extra).slice(0, 60), "=>", r.ret, "reward", J(r.reward));
}
console.log("money", J(p.money), "level", p.level, "heroLevel", p.heroLevel, "adv", p.adventureLevel);

// 玩家信息推送必须能编码（含 moduleBaseList）
const buf2 = mod.encode("PlayerInfoP_PlayerInfo_S2C", { info: mod.playerInfoOf(p) });
const back2 = mod.decode("PlayerInfoP_PlayerInfo_S2C", buf2);
console.log("PlayerInfoP bytes", buf2.length, "moduleBaseList", (back2.info.moduleBaseList || []).length, "level", back2.info.level);

// 英雄推送
const buf3 = mod.encode("HeroInfoP_Hero_S2C", { heroList: mod.heroListOf(p) });
const back3 = mod.decode("HeroInfoP_Hero_S2C", buf3);
console.log("HeroInfoP bytes", buf3.length, "heros", back3.heroList.length, "lv", back3.heroList[0].level, "section", back3.heroList[0].section);

// 主线推进推送
const buf4 = mod.encode("AdventureInfoP_Adventure_S2C", { info: mod.adventureInfo(p) });
console.log("AdventureInfoP bytes", buf4.length);

// 结算 / 未完成房间
const buf5 = mod.encode("QuitRoomR_Build_S2C", { err: 0, result: 1, uuid: p.lastBattleUuid });
console.log("QuitRoomR", J(mod.decode("QuitRoomR_Build_S2C", buf5)));
const buf6 = mod.encode("UnfinishedRoomR_Build_S2C", { err: 0, battleType: 0 });
console.log("UnfinishedRoomR", J(mod.decode("UnfinishedRoomR_Build_S2C", buf6)));

// GM 回包
const gmBody = { err: 0, retExtra: "ok", status: "ok", clientReward: { money: [{ type: 1, code: 2, num: 100 }], chipItems: [{ type: 4, code: 5, num: 3 }] } };
const buf7 = mod.encode("MakeTestOperR_Test_S2C", gmBody);
console.log("MakeTestOperR", J(mod.decode("MakeTestOperR_Test_S2C", buf7)).slice(0, 300));
