'use strict';
// 极简 WebSocket 服务端（RFC6455，仅二进制帧 + ping/pong/close，无扩展）
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function attach(server, onConnection) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );
    socket.setNoDelay(true);

    const conn = {
      socket,
      alive: true,
      onMessage: null,
      onClose: null,
      send(buf) {
        if (!socket.writable) return;
        socket.write(frame(0x2, buf));
      },
      close() {
        try {
          socket.write(frame(0x8, Buffer.alloc(0)));
          socket.end();
        } catch (e) {
          /* ignore */
        }
      }
    };
    onConnection(conn, req);

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const parsed = parseFrame(buf);
        if (!parsed) break;
        buf = buf.subarray(parsed.size);
        if (parsed.opcode === 0x8) {
          conn.alive = false;
          if (conn.onClose) conn.onClose();
          conn.close();
          return;
        } else if (parsed.opcode === 0x9) {
          socket.write(frame(0xA, parsed.payload));
        } else if (parsed.opcode === 0x1 || parsed.opcode === 0x2 || parsed.opcode === 0x0) {
          if (conn.onMessage) conn.onMessage(parsed.payload);
        }
      }
    });
    socket.on('error', () => closeConn(conn));
    socket.on('close', () => closeConn(conn));

    function closeConn(c) {
      if (!c.alive) return;
      c.alive = false;
      if (c.onClose) c.onClose();
    }
  });
}

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  if (!fin) {
    // 不处理续帧（客户端单帧发送）
  }
  return { opcode, payload, size: off + len };
}

module.exports = { attach };
