# Turning on multiplayer between different machines

Right now a room reaches other tabs on your own computer. This turns it into
Atlanta-plays-Chicago. Budget 30 minutes, most of it waiting for DNS.

**It has already been tested.** Two real browsers played a full match through
this exact server: 34 checks, 0 failures — room creation, a wrong code failing
honestly, chat, countdown, synchronised play, anti-cheat, a dropped connection
holding its slot, reconnection, rematch. You are deploying something that
works, not something that should.

---

## Two tools do the fiddly parts

**`verify-rooms.js`** - proves a server works before you wire anything to it.
It opens two real connections, plays a whole match between them, and reports
24 checks. Run it the moment the deploy finishes.

```bash
node verify-rooms.js wss://rooms.punxarmy.com
```

**`wire.js`** - points the site at your server without you editing 9 MB of HTML.

```bash
node wire.js wss://rooms.punxarmy.com     # writes punxarmy-live.html
node wire.js --off                        # back to same-machine rooms
```

It always works from the pristine `punxarmy.html`, so re-running swaps the
setting rather than stacking two of them. It refuses an insecure `ws://` URL,
because browsers block those from an https page silently and you would spend
an hour wondering why nothing connects.

Both are zero-dependency and need Node 22+. Both were run end to end before
shipping: 24/24 on the verifier, and a file `wire.js` produced played a full
match between two real browsers through a real server, 34/34.

## Before you start

- The server has **zero dependencies**. No `npm install`, no lockfile, nothing
  to keep patched. Node 18 or newer and the four files in `server/`.
- You need a **credit card on file** at Fly (they ask even for the free
  allowance). Render's free tier does not, but it sleeps — see the comparison.
- You need the domain from step 2 of the main README.

---

## Pick a host

| | Fly.io | Render | Railway |
|---|---|---|---|
| Cost | free–$3/mo | free tier | ~$5/mo |
| Sleeps when idle | suspends, wakes in ~1s | **sleeps ~15 min, wakes in ~30s** | no |
| WebSockets | yes | yes | yes |
| Card required | yes | no | yes |
| Config included | `fly.toml` | `render.yaml` | `railway.json` |

**Recommendation: Fly.** A room server that takes 30 seconds to wake means the
first person to open a room sits looking at a spinner and assumes it's broken.
Fly suspends to zero and wakes in about a second, so it costs about the same as
Render's free tier in practice without that first-visitor penalty.

Use Render if you'd rather not put a card down to start.

---

## Option A — Fly.io (recommended)

**1. Install the CLI**

```bash
# macOS
brew install flyctl
# or, any platform
curl -L https://fly.io/install.sh | sh
```

**2. Sign in** — opens a browser

```bash
fly auth login
```

**3. From the `server/` folder, create the app**

```bash
cd server
fly launch --no-deploy --name punxarmy-rooms --region atl
```

Say **no** to a Postgres database, **no** to Redis. There's no database.
It will notice the `fly.toml` already here and ask whether to overwrite it —
**say no**, keep the one shipped. It has the WebSocket idle timeout and the
health check already set.

`atl` is Atlanta. Change it if your crowd is elsewhere; `fly platform regions`
lists them.

**4. Deploy**

```bash
fly deploy
```

**5. Check it**

```bash
curl https://punxarmy-rooms.fly.dev/health
# {"ok":true,"rooms":0}
```

If you get that JSON back, the server is live.

**6. Point your subdomain at it**

```bash
fly certs add rooms.punxarmy.com
```

It prints the DNS records to create. At your registrar, add them — usually one
`CNAME` for `rooms` pointing at `punxarmy-rooms.fly.dev`, plus an `_acme-challenge`
record for the certificate. Then:

```bash
fly certs check rooms.punxarmy.com
```

Wait until it says the certificate is issued. Usually a few minutes.

---

## Option B — Render (no card)

1. Push the `server/` folder to a GitHub repo
2. Render dashboard → **New +** → **Blueprint** → pick that repo
3. It reads `render.yaml` and fills everything in. Click **Apply**
4. Check `https://<your-service>.onrender.com/health`
5. Settings → **Custom Domain** → add `rooms.punxarmy.com`, then add the CNAME
   Render shows you at your registrar

Remember it sleeps. The first person to open a room after a quiet spell waits
about 30 seconds.

---

## Option C — Railway

1. Push `server/` to GitHub
2. Railway → **New Project** → **Deploy from GitHub repo**
3. It reads `railway.json`. No settings to change
4. **Settings → Networking → Generate Domain**, then add your custom domain

---

## Turn it on in the site

`wire.js` does this for you - see below. By hand it is one line, anywhere
before the main `<script>` in `punxarmy.html`:

```html
<script>window.PUNX_WS='wss://rooms.punxarmy.com';</script>
```

**`wss://`, not `ws://`.** An https page cannot open an insecure socket; the
browser blocks it silently and rooms just never connect.

Re-upload the file to your static host. That is the entire integration — no
other line in the site is transport-aware. With that set, the page stops
refereeing its own rooms and becomes a client of the server.

---

## Verify it worked

**First, before touching the site:**

```bash
node verify-rooms.js wss://rooms.punxarmy.com
```

24 checks in about a minute. If they all pass, the server genuinely works -
room creation, a wrong code refused, chat, countdown, clock sync, synchronised
play, anti-cheat, disconnect, reconnect, standings. If something fails it names
what, and `fly logs` will say why. Fix it here, before the site is involved.

**Then wire the site:**

```bash
node wire.js wss://rooms.punxarmy.com
```

Upload the `punxarmy-live.html` it writes, as `index.html`.

**Then the human check, in two minutes**

1. Open `punxarmy.com` on your phone, on mobile data (not your wifi)
2. Open it on your computer
3. Both: ENLIST, cast a figure, go to **THE MUSTER**
4. The pill top-right should read **NETWORK**. If it says **LOCAL LINK**, the
   `PUNX_WS` line didn't take — check you re-uploaded the file
5. Computer: **OPEN A ROOM**, read the six-character code
6. Phone: type the code, **FALL IN**
7. Both stand ready, computer calls the drill

Two devices on different networks in one column means it's live.

Add `#debug` to the URL for a panel showing ping, the clock offset, the
transport in use, and the room state.

---

## When something is wrong

| What you see | What it is |
|---|---|
| Pill says LOCAL LINK | `PUNX_WS` not set, or the old file is still cached. Hard-refresh |
| "No room answered to XXXXXX" | The code is wrong, the room closed, or the server is down. Check `/health` |
| Rooms connect then drop after ~60s | A proxy is closing idle sockets. Fly's `idle_timeout` in `fly.toml` covers this; on another host raise its WebSocket timeout |
| Works on your wifi, not on mobile data | You're on `ws://` instead of `wss://`, or the certificate isn't issued yet |
| Nothing connects at all | Open the browser console. A failed WebSocket names its reason |

Server logs: `fly logs`, or the host's log tab. Every room opening and closing
is logged, so you can watch a room appear as someone creates it.

---

## What this changes in the game

- Rooms reach anyone, anywhere, instead of tabs on one machine
- **The referee stops being a player's browser.** While a tab hosts the room,
  that tab is trusted — the person hosting could tamper with their own score.
  Every other player was always validated against them and no client could ever
  forge a score, but the host was the gap. This closes it: the referee is now a
  machine you own that nobody is playing on
- Rooms outlive any one tab
- The formation fills with the real army instead of just your own room

## Scale, when you need it

One small instance handles roughly 1–2k concurrent players — 8 per room, 20
ticks a second, about 200 bytes a snapshot. Past that, route by room code: hash
the code to an instance so everyone with the same code lands together. That's a
load-balancer rule, not a code change. Rooms live in memory, so a deploy ends
whatever matches are running; deploy when it's quiet, or add Redis if that ever
matters.
