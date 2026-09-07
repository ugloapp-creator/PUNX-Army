/* ============================================================================
   ws-lite - a minimal RFC 6455 WebSocket server on Node's built-ins
   ----------------------------------------------------------------------------
   This exists so the room server has ZERO dependencies: nothing to npm install,
   nothing to audit, nothing to keep patched. It implements exactly what PUNX
   ARMY needs and nothing else:

     - the upgrade handshake
     - text frames in and out, including continuation and 64-bit lengths
     - client->server unmasking (required by the spec)
     - ping/pong keepalive, and close

   It does NOT implement extensions (permessage-deflate), binary application
   frames, or subprotocol negotiation. The room protocol is small JSON text,
   so none of that is needed. If you ever want them, swap this file for the
   `ws` package - server.js only uses `onMessage`, `send`, `close` and the
   `connection` event, which `ws` provides with the same names.
   ========================================================================== */

const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function accept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class Socket {
  constructor(sock) {
    this.sock = sock;
    this.readyState = 1;            // OPEN, mirrors the ws package
    this._buf = Buffer.alloc(0);
    this._frag = [];                // continuation frames
    this._fragOp = 0;
    this._handlers = { message: [], close: [], error: [] };
    this.isAlive = true;

    sock.on('data', (d) => this._feed(d));
    sock.on('close', () => this._down());
    sock.on('error', (e) => { this._emit('error', e); this._down(); });
    sock.setTimeout(0);
    sock.setNoDelay(true);
  }

  on(ev, fn) { if (this._handlers[ev]) this._handlers[ev].push(fn); return this; }
  _emit(ev, a) { for (const fn of this._handlers[ev] || []) { try { fn(a) } catch (e) { console.error('handler', e) } } }
  _down() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._emit('close');
  }

  _feed(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    // A single TCP read can carry several frames, or half of one.
    for (;;) {
      const f = this._frame();
      if (!f) break;
      this._handle(f);
    }
  }

  /* Pull one complete frame off the buffer, or return null if it hasn't
     all arrived yet. */
  _frame() {
    const b = this._buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off); off += 8;
      if (big > 0x7fffffffn) { this.close(1009); return null; }  // too big
      len = Number(big);
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;

    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this._buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handle(f) {
    switch (f.opcode) {
      case 0x0:                                  // continuation
        this._frag.push(f.payload);
        if (f.fin) {
          const full = Buffer.concat(this._frag);
          this._frag = [];
          if (this._fragOp === 0x1) this._emit('message', full.toString('utf8'));
        }
        break;
      case 0x1:                                  // text
        if (f.fin) this._emit('message', f.payload.toString('utf8'));
        else { this._fragOp = 0x1; this._frag = [f.payload]; }
        break;
      case 0x2:                                  // binary: unused here
        break;
      case 0x8:                                  // close
        this.close(1000);
        break;
      case 0x9:                                  // ping -> pong
        this._send(0xA, f.payload);
        break;
      case 0xA:                                  // pong
        this.isAlive = true;
        break;
    }
  }

  _send(opcode, payload) {
    if (this.readyState !== 1) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.alloc(2);
      head[1] = len;
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    head[0] = 0x80 | opcode;                     // FIN + opcode
    // Server frames are never masked.
    try { this.sock.write(Buffer.concat([head, payload])) } catch (e) { this._down() }
  }

  send(text) { this._send(0x1, Buffer.from(String(text), 'utf8')); }
  ping() { this.isAlive = false; this._send(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.readyState !== 1) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this._send(0x8, p);
    this.readyState = 2;
    try { this.sock.end() } catch (e) { }
    setTimeout(() => { try { this.sock.destroy() } catch (e) { } }, 200);
  }
}

/**
 * Attach a WebSocket endpoint to an existing http.Server.
 * @param {import('http').Server} server
 * @param {(ws: Socket, req: import('http').IncomingMessage) => void} onConnection
 */
function attach(server, onConnection) {
  server.on('upgrade', (req, sock, head) => {
    const key = req.headers['sec-websocket-key'];
    const ver = req.headers['sec-websocket-version'];
    if (!key || String(ver) !== '13' ||
        String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      sock.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return sock.destroy();
    }
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept(key) + '\r\n\r\n'
    );
    const ws = new Socket(sock);
    if (head && head.length) ws._feed(head);
    onConnection(ws, req);
  });
}

module.exports = { attach, Socket };
