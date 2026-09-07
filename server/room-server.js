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
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  res.writeHead(404); res.end();
});

attach(server, (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const code = String(u.searchParams.get('room') || '').toUpperCase().slice(0, 12);
  const peer = String(u.searchParams.get('peer') || '').replace(/[^a-f0-9]/g, '').slice(0, 18);
  if (!code || !peer) return ws.close();
  /* Only an explicit "open a room" connection may CREATE one. Without this a
     mistyped code would quietly conjure an empty room and report itself as
     found, instead of failing the way it should. */
  const wantsNew = u.searchParams.get('new') === '1';
  if (!rooms.has(code) && !wantsNew) return ws.close(4404);
  /* A hard cap so nobody can open rooms without limit. */
  if (rooms.size > 5000 && !rooms.has(code)) return ws.close(4429);

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
  ws.on('error', () => { try { ws.close() } catch (e) { } });
});

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
