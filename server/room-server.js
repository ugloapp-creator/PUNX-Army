/* ============================================================================
   PUNX ARMY / ROOM SERVER
   ----------------------------------------------------------------------------
   The dedicated authority for punxarmy.com.

   This file is only plumbing: sockets in, rooms out. Every rule of the game
   lives in authority.js, which is the SAME FILE the browser loads - not a
   port of it, not a second implementation that can drift. When you change a
   rule you change it once.

   What running this buys you over the in-page authority:
     - players on different machines, anywhere, instead of tabs on one
     - the referee is a machine you own, so a player cannot referee themselves
     - rooms outlive any one player's tab

   Run:   npm install && node room-server.js
   Env:   PORT (default 8080)
   ========================================================================== */

const http = require('http');
const { attach } = require('./ws-lite');   // zero dependencies, see ws-lite.js

/* The browser bundle is plain script, not a module, so it is evaluated here
   in a context that hands back exactly what the page's own build injects. */
const fs = require('fs');
const vm = require('vm');
const sandbox = { console, Date, Math, JSON, setTimeout, clearTimeout,
                  performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
                  crypto: require('crypto').webcrypto, Uint8Array, isFinite, String, Number,
                  Array, Object, RegExp, TypeError, reportErr: (w, e) => console.error(w, e) };
vm.createContext(sandbox);
for (const f of ['net.js', 'authority.js']) {
  vm.runInContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), sandbox, { filename: f });
}
const { Authority, NETCFG } = sandbox;


/* ---------------------------------------------------------------------------
   Per-address limits. Without these one client can open sockets until the
   process runs out of them, or mint rooms until the global cap is full and
   nobody else can open one. Neither needs a botnet - a for-loop does it.

   Behind Fly / Render / Railway the socket's remote address is the proxy, so
   the real client is in x-forwarded-for. We take the FIRST hop, and only when
   TRUST_PROXY is on, because that header is client-controlled and trusting it
   blindly would let anyone forge a fresh identity per connection.
--------------------------------------------------------------------------- */
const TRUST_PROXY   = process.env.TRUST_PROXY !== '0';   /* on by default: these hosts all proxy */
const MAX_CONN_PER_IP  = Number(process.env.MAX_CONN_PER_IP  || 12);
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 6);
const ROOM_WINDOW_MS   = 10 * 60 * 1000;

const conns = new Map();      /* ip -> live socket count */
const minted = new Map();     /* ip -> [timestamps of rooms opened] */

function clientIp(req) {
  if (TRUST_PROXY) {
    const f = req.headers['x-forwarded-for'];
    if (typeof f === 'string' && f.length && f.length < 200) {
      const first = f.split(',')[0].trim();
      if (first) return first.slice(0, 45);
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function mayMintRoom(ip) {
  const now = Date.now();
  const list = (minted.get(ip) || []).filter(t => now - t < ROOM_WINDOW_MS);
  if (list.length >= MAX_ROOMS_PER_IP) { minted.set(ip, list); return false }
  list.push(now); minted.set(ip, list);
  return true;
}
/* Keep the maps from growing forever on a long-lived process. */
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of minted) {
    const keep = list.filter(t => now - t < ROOM_WINDOW_MS);
    if (keep.length) minted.set(ip, keep); else minted.delete(ip);
  }
  for (const [ip, c] of conns) if (c <= 0) conns.delete(ip);
}, ROOM_WINDOW_MS);

const PORT = process.env.PORT || 8080;
const rooms = new Map();               /* code -> {auth, sockets:Map} */

/* A transport with the same four members the browser one has, so Authority
   cannot tell the difference and does not need to. */
function serverTransport(room) {
  return {
    kind: 'ws',
    id: '@authority',
    send(to, t, d) {
      const msg = JSON.stringify({ v: NETCFG.PROTOCOL, from: '@authority', to: to || '*', t, d });
      for (const [peer, ws] of room.sockets) {
        if (to !== '*' && to !== peer) continue;
        if (ws.readyState === 1) { try { ws.send(msg) } catch (e) { } }
      }
    },
    onMessage(fn) { room.handlers.push(fn) },
    close() { }
  };
}

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { code, sockets: new Map(), handlers: [] };
    r.auth = new Authority(serverTransport(r), code, () => Number(process.hrtime.bigint() / 1000000n) / 1000);
    r.timer = setInterval(() => {
      try { r.auth.tick() } catch (e) { console.error('tick', code, e) }
      if (r.auth.idle()) { closeRoom(code) }
    }, 1000 / NETCFG.TICK_HZ);
    rooms.set(code, r);
    console.log('[room] opened', code, '(' + rooms.size + ' open)');
  }
  return r;
}
function closeRoom(code) {
  const r = rooms.get(code); if (!r) return;
  clearInterval(r.timer);
  for (const [, ws] of r.sockets) { try { ws.close() } catch (e) { } }
  rooms.delete(code);
  console.log('[room] closed', code, '(' + rooms.size + ' open)');
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    /* Deliberately thin: liveness and load, nothing about who is playing.
       Headers go in writeHead - setHeader after it throws and would take the
       process down on the first health check a platform makes. */
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  res.writeHead(404, { 'x-content-type-options': 'nosniff' }); res.end();
});

function parse(req) {
  const u = new URL(req.url, 'http://x');
  return {
    code: String(u.searchParams.get('room') || '').toUpperCase().slice(0, 12),
    peer: String(u.searchParams.get('peer') || '').replace(/[^a-f0-9]/g, '').slice(0, 18),
    wantsNew: u.searchParams.get('new') === '1',
  };
}

/* Every reason to say no, decided before a single byte of WebSocket is spoken. */
function verify(req) {
  const { code, peer, wantsNew } = parse(req);
  if (!code || !peer) return '400 Bad Request';
  /* Only an explicit "open a room" connection may CREATE one - otherwise a
     mistyped code quietly conjures an empty room and reports itself found. */
  if (!rooms.has(code) && !wantsNew) return '404 Not Found';
  if (!rooms.has(code) && rooms.size > 5000) return '503 Service Unavailable';
  const ip = clientIp(req);
  if ((conns.get(ip) || 0) >= MAX_CONN_PER_IP) return '429 Too Many Requests';
  if (!rooms.has(code) && !mayMintRoom(ip)) return '429 Too Many Requests';
  return null;
}

attach(server, (ws, req) => {
  const { code, peer } = parse(req);
  const ip = clientIp(req);
  conns.set(ip, (conns.get(ip) || 0) + 1);
  let counted = true;
  const release = () => { if (!counted) return; counted = false;
    const c = (conns.get(ip) || 1) - 1;
    if (c > 0) conns.set(ip, c); else conns.delete(ip); };

  const room = getRoom(code);
  room.sockets.set(peer, ws);

  ws.on('message', (buf) => {
    if (buf.length > 8192) return;
    let m; try { m = JSON.parse(buf) } catch (e) { return }
    if (!m || typeof m !== 'object') return;
    /* The sender is whoever the socket says it is, never whoever the
       payload claims to be. This is the line the browser authority cannot
       draw for itself, and the reason this process exists. */
    m.from = peer;
    for (const fn of room.handlers) { try { fn(m) } catch (e) { console.error('handler', e) } }
  });

  ws.on('close', () => {
    release();
    room.sockets.delete(peer);
    for (const fn of room.handlers) {
      /* 'drop', not 'leave' - a closed socket is a disconnection, and the
         player keeps their slot for the reconnect window. A deliberate exit
         arrives as its own 'leave' message before the socket goes. */
      try { fn({ v: NETCFG.PROTOCOL, from: peer, to: '*', t: 'drop', d: {} }) } catch (e) { }
    }
    if (!room.sockets.size) setTimeout(() => {
      const r = rooms.get(code);
      if (r && !r.sockets.size) closeRoom(code);
    }, NETCFG.RECONNECT_MS + 5000);
  });
  ws.on('error', () => { release(); try { ws.close() } catch (e) { } });
}, verify);

/* Idle sockets behind a proxy die quietly; ping them so a dead one is noticed
   and the player's slot enters its reconnect window instead of lingering. */
setInterval(() => {
  for (const [, room] of rooms) {
    for (const [peer, ws] of room.sockets) {
      if (ws.readyState !== 1) { room.sockets.delete(peer); continue }
      if (ws.isAlive === false) { ws.close(1001); room.sockets.delete(peer); continue }
      ws.ping();
    }
  }
}, 30000);

server.listen(PORT, () => console.log('[punx] room server on :' + PORT));
