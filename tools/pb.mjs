// 从 server.mjs 抽出 protobuf 编解码器，供联调客户端用
import { readFileSync } from "node:fs";

const DATA = "/workspace/php-backend/sy_api/data/";
globalThis.Deno = { env: { get: (k) => process.env[k] } };

const realFetch = globalThis.fetch;

globalThis.fetch = async (url, opt) => {
  const u = String(url);
  if (u.includes("/data.php?f=")) {
    const f = u.split("f=")[1];
    const txt = readFileSync(DATA + f + ".json", "utf8");
    return new Response(txt, { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, opt);
};

const src = readFileSync("/workspace/deno-ws/server.mjs", "utf8");
const cut = src.indexOf("// ---------------- 连接 ----------------");
if (cut < 0) throw new Error("cut point not found");
const code = src.slice(0, cut) + "\nexport { tables, encode, decode, encodeS2C, decodeC2S };\n";
const mod = await import("data:text/javascript;base64," + Buffer.from(code, "utf8").toString("base64"));
await mod.tables();

export const encode = mod.encode;
export const decode = mod.decode;
export const encodeS2C = mod.encodeS2C;
export const decodeC2S = mod.decodeC2S;
export const J = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? String(v) : v));

// C2S 封包：uint16 total | uint8 module | uint16 cmd | uint8 ssid | body
export function c2s(module, cmd, obj, msgName, ssid = 1) {
  const body = obj && msgName ? encode(msgName, obj) : Buffer.alloc(0);
  const head = Buffer.alloc(6);
  head.writeUInt16BE(6 + body.length, 0);
  head[2] = module & 0xff;
  head.writeUInt16BE(cmd & 0xffff, 3);
  head[5] = ssid;
  return Buffer.concat([head, body]);
}
