'use strict';
// 极简 protobuf 编解码：schema 来自客户端反编译的 *_Def 字段表
// 支持 int32/uint32/int64/uint64/bool/double/string/object/Repeated/Map

const SCHEMA = require('../data/protocol.json').messages;

function fieldsOf(name) {
  const f = SCHEMA[name];
  if (!f) throw new Error('unknown message: ' + name);
  return f;
}

function isNumType(t) {
  return t === 'int32' || t === 'uint32' || t === 'int64' || t === 'uint64' || t === 'bool';
}

function wireTypeOf(t) {
  if (t === 'double') return 1;
  if (t === 'string' || t === 'object') return 2;
  return 0;
}

// ---------- 写 ----------
function Writer() {
  this.bufs = [];
  this.len = 0;
}
Writer.prototype.push = function (b) {
  this.bufs.push(b);
  this.len += b.length;
};
Writer.prototype.varint = function (v) {
  let n = typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v) || 0));
  if (n < 0n) n += 1n << 64n; // 负数按 64 位补码
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
    case 'bool':
      w.varint(v ? 1 : 0);
      break;
    case 'double':
      w.double(v);
      break;
    case 'string':
      w.bytes(Buffer.from(String(v), 'utf8'));
      break;
    default:
      w.varint(v);
  }
}

function encodeField(w, f, v, def) {
  const wt = wireTypeOf(f.type);
  switch (f.rule) {
    case 'Repeated': {
      if (!Array.isArray(v) || !v.length) return;
      // 客户端 readList 对数字数组按 packed 解析，必须打包
      if (f.type !== 'object' && f.type !== 'string') {
        const sub = new Writer();
        for (const item of v) encodeScalar(sub, f.type, item);
        w.tag(f.tag, 2);
        w.bytes(sub.result());
        return;
      }
      for (const item of v) {
        w.tag(f.tag, wt);
        if (f.type === 'object') w.bytes(encode(f.ref, item));
        else encodeScalar(w, f.type, item);
      }
      return;
    }
    case 'Map': {
      const entries = v instanceof Map ? Array.from(v.entries()) : Object.entries(v || {});
      for (const [k, val] of entries) {
        const sub = new Writer();
        sub.tag(1, wireTypeOf(def.keyType || 'string'));
        encodeScalar(sub, def.keyType || 'string', k);
        sub.tag(2, wireTypeOf(def.valType || 'uint32'));
        if (def.valType === 'object') sub.bytes(encode(def.valRef, val));
        else encodeScalar(sub, def.valType || 'uint32', val);
        w.tag(f.tag, 2);
        w.bytes(sub.result());
      }
      return;
    }
    default: {
      if (f.type === 'object') {
        w.tag(f.tag, 2);
        w.bytes(encode(f.ref, v));
      } else {
        w.tag(f.tag, wt);
        encodeScalar(w, f.type, v);
      }
    }
  }
}

// mapDefs: { 'Msg.field': {keyType, valType, valRef} }
function encode(name, obj, mapDefs) {
  if (!obj) return Buffer.alloc(0);
  const w = new Writer();
  for (const f of fieldsOf(name)) {
    const v = obj[f.name];
    if (v === undefined || v === null) continue;
    const md = (mapDefs || {})[name + '.' + f.name];
    encodeField(w, f, v, md || {});
  }
  return w.result();
}

// ---------- 读 ----------
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let byte;
  do {
    byte = buf[pos.i++];
    if (byte === undefined) throw new Error('varint eof');
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  return result;
}

function toNumber(v, is64) {
  if (!is64) {
    // int32 负数按 64 位补码存
    if (v >= 0x80000000n && v < 0x100000000n) return Number(BigInt.asIntN(32, v));
    if (v >= 0xffffffff80000000n) return Number(BigInt.asIntN(64, v));
    return Number(v);
  }
  if (v >= 0x8000000000000000n) return Number(BigInt.asIntN(64, v));
  return Number(v);
}

function decodeScalar(buf, pos, t) {
  switch (t) {
    case 'bool':
      return readVarint(buf, pos) !== 0n;
    case 'double': {
      const v = buf.readDoubleLE(pos.i);
      pos.i += 8;
      return v;
    }
    case 'string': {
      const len = Number(readVarint(buf, pos));
      const s = buf.toString('utf8', pos.i, pos.i + len);
      pos.i += len;
      return s;
    }
    case 'int32':
    case 'int64':
    case 'uint32':
    case 'uint64':
      return toNumber(readVarint(buf, pos), t === 'int64' || t === 'uint64');
    default:
      return Number(readVarint(buf, pos));
  }
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
      // 未知字段：按 wire type 跳过
      if (wt === 0) readVarint(buf, pos);
      else if (wt === 1) pos.i += 8;
      else if (wt === 2) pos.i += Number(readVarint(buf, pos));
      else if (wt === 5) pos.i += 4;
      else throw new Error('bad wire type ' + wt);
      continue;
    }
    if (f.rule === 'Repeated') {
      if (!obj[f.name]) obj[f.name] = [];
      if (wt === 2 && f.type !== 'object' && f.type !== 'string') {
        // packed
        const sub = readBytes(buf, pos);
        const p2 = { i: 0 };
        while (p2.i < sub.length) obj[f.name].push(decodeScalar(sub, p2, f.type));
      } else {
        obj[f.name].push(f.type === 'object' ? decode(f.ref, readBytes(buf, pos), mapDefs) : decodeScalar(buf, pos, f.type));
      }
    } else if (f.rule === 'Map') {
      const md = (mapDefs || {})[name + '.' + f.name] || {};
      const sub = readBytes(buf, pos);
      const e = readMapEntry(sub, md);
      if (!obj[f.name]) obj[f.name] = {};
      obj[f.name][e.key] = e.val;
    } else {
      obj[f.name] = f.type === 'object' ? decode(f.ref, readBytes(buf, pos), mapDefs) : decodeScalar(buf, pos, f.type);
    }
  }
  return obj;
}

function readBytes(buf, pos) {
  const len = Number(readVarint(buf, pos));
  const b = buf.subarray(pos.i, pos.i + len);
  pos.i += len;
  return b;
}

function readMapEntry(buf, md) {
  const pos = { i: 0 };
  let key = '';
  let val = 0;
  while (pos.i < buf.length) {
    const key2 = Number(readVarint(buf, pos));
    const tag = key2 >> 3;
    if (tag === 1) key = decodeScalar(buf, pos, md.keyType || 'string');
    else if (tag === 2) {
      if (md.valType === 'object') val = decode(md.valRef, readBytes(buf, pos), null);
      else val = decodeScalar(buf, pos, md.valType || 'uint32');
    } else {
      if ((key2 & 7) === 0) readVarint(buf, pos);
      else if ((key2 & 7) === 2) readBytes(buf, pos);
      else if ((key2 & 7) === 1) pos.i += 8;
      else pos.i += 4;
    }
  }
  return { key, val };
}

function decode(name, buf, mapDefs) {
  return decodeInto({}, name, buf, mapDefs);
}

// 按消息定义生成“空骨架”响应：列表字段给空列表（客户端要求字段存在）
function skeleton(name, depth) {
  if (depth === undefined) depth = 2;
  const obj = {};
  const defs = SCHEMA[name];
  if (!defs) return obj;
  for (const f of defs) {
    if (f.rule === 'Repeated') {
      // 空列表比塞一个假元素安全：客户端遍历假元素会去查配置表并报错
      obj[f.name] = [];
    } else if (f.rule === 'Map') {
      obj[f.name] = {};
    } else if (f.type === 'object') {
      obj[f.name] = depth > 0 ? skeleton(f.ref, depth - 1) : {};
    } else if (f.type === 'string') {
      obj[f.name] = '';
    } else if (f.type === 'bool') {
      obj[f.name] = false;
    } else {
      obj[f.name] = 0;
    }
  }
  return obj;
}

module.exports = { encode, decode, fieldsOf, skeleton, SCHEMA };
