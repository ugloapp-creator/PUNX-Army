# PUNX ARMY — deploying to punxarmy.com

Two pieces. The site is one file and needs no server. The room server is
optional and only buys you one thing: players on *different machines*.

```
punxarmy.html          the whole site. one file. no build, no dependencies.
server/
  net.js               wire protocol + transports   ─┐ the SAME two files
  authority.js         all the game rules            ─┘ the browser loads
  room-server.js       sockets in, rooms out
  package.json
```

`net.js` and `authority.js` are not a port of the browser code. They are the
browser code. Change a rule once and both sides change.

---

## 1. The site

Upload `punxarmy.html` anywhere static and point the domain at it.

| Host | What to do | Cost |
|---|---|---|
| Cloudflare Pages | drag the file in, add `punxarmy.com` | free |
| Netlify / Vercel | same | free |
| GitHub Pages | commit + set a custom domain | free |
| S3 + CloudFront | upload, alias the domain | pennies |

Serve it as `index.html` at the root. Set `Cache-Control: public, max-age=300`
— the file is ~9 MB because the two mixes are embedded, so you want it cached
but you don't want a stale copy pinned for a week.

At this point **everything works**: the whole campaign, the drill, and
multiplayer between browser tabs and windows on one machine.

## 2. The room server (for play between different machines)

> **Step-by-step click path: `DEPLOY-ROOMS.md`.** It covers Fly, Render and
> Railway, the DNS records, how to verify in two minutes, and what each failure
> mode looks like. The summary below is the shape of it.


Without it, a room is shared over `BroadcastChannel`, which reaches other
tabs in the same browser and nothing further. With it, a room is shared over
a WebSocket and reaches anyone.

```bash
cd server
node room-server.js          # listens on :8080, or $PORT
```

**Zero dependencies** - there is no `npm install` step. The WebSocket layer is
`ws-lite.js`, written against Node's built-ins, so there is no lockfile, no
supply chain and nothing to keep patched.

Then add **one line** to `punxarmy.html`, anywhere before the main script:

```html
<script>window.PUNX_WS='wss://rooms.punxarmy.com';</script>
```

That is the whole integration. No other line in the site is transport-aware.
When `PUNX_WS` is set the page stops refereeing its own rooms and becomes an
ordinary client of the server.

### Where to run it

It is a single small Node process with no database.

| Host | Notes | Cost |
|---|---|---|
| Fly.io | 1 shared-cpu-1x, scale-to-zero | free–$3/mo |
| Railway / Render | one service, WebSockets on by default | free–$7/mo |
| A $5 VPS | behind nginx or Caddy for TLS | $5/mo |

WebSockets need TLS on an https site (`wss://`, not `ws://`). Any of the above
terminate TLS for you; behind your own nginx you need `proxy_set_header
Upgrade`/`Connection` for the socket to survive.

Health check: `GET /health` → `{"ok":true,"rooms":N}`.

### Why bother

While the referee is a browser tab, that tab is trusted — the person hosting
the room *could* tamper with their own scores, because the rules are running
on their machine. Every other player is fully validated against them, and no
client can forge a score. The server closes the last gap: the referee becomes
a machine you own, that nobody is playing on.

## 3. Environment

The site needs nothing. The server:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |

There are no keys, no database and no secrets anywhere in this project.

## 4. Scale

The site is a static file on a CDN — that part genuinely serves millions.

The room server holds rooms in memory, so one process is one island of rooms.
A single small instance handles roughly 1–2k concurrent players (8 per room,
20 ticks/s, ~200 bytes a snapshot). To go past that, route by room code —
hash the code to an instance so everyone with the same code lands together —
which is a load-balancer rule, not a code change. Only reach for Redis or a
matchmaking service if you want rooms to survive a deploy.

## 5. Mail

`booking@punxarmy.com` appears on the rights page. It needs to exist — any
mail host, or a forwarding rule at the registrar, is enough.

---

## 6. Where Wix fits

Short version: **Wix is the right tool for the business, and the wrong host for the game.**

Do not put `punxarmy.html` inside a Wix page. Wix embeds custom HTML in a sandboxed
iframe on its own origin, behind a page that already loads its own framework first.
A 9 MB canvas game with Web Audio, per-tab identity and cross-tab rooms fights that
container the whole way, and you lose control of the page shell that carries the
whole look.

Split it instead:

| Layer | Where | Why |
|---|---|---|
| The game, `punxarmy.com` | static host (section 1) | full control, free, fast |
| Merch + payments | **Wix Stores** | real checkout, tax, shipping, and native Printful / Printify fulfilment — you never touch inventory |
| Show tickets | **Wix Events** | for a working artist this is usually the biggest line |
| The mailing list | **Wix Contacts** | you own the fanbase instead of renting it from a platform |
| Domain + DNS | Wix or any registrar | point `punxarmy.com` at the static host, `shop.` at Wix |

### Wiring the quartermaster to Wix — today, no code

`STORE.items[].url` in the site takes any `https://` URL. Wix Stores gives every
product its own page. Paste those URLs in, set `STORE.OPEN = true`, and the counter
is live with real fulfilment behind it. No API, no keys, no build step.

This is also strictly better than raw Stripe links for physical goods: Wix carries
the print-on-demand integration, so a sticker sheet or a tee is printed and posted
without you touching it.

### Live products in the page — ALREADY BUILT

The quartermaster now reads your Wix Stores catalogue at runtime over the public
client id `4a020543-c911-49b8-aea9-ad52a4a3db64`, and buying goes:

    add to the visitor's cart  ->  Wix redirect session  ->  Wix hosted checkout

The page never sees a card and never builds a checkout URL by hand. Products with
options (a tee with sizes) show their choices and resolve the variant before
adding. Out-of-stock is greyed; a pre-order says PRE-ORDER.

**Important: this only works on YOUR host.** A page published as a claude.ai
artifact cannot make outbound requests — its CSP blocks them — so the counter
reads SHUT in the preview no matter what is in the store. That is expected and
correct behaviour, not a bug. Deployed to punxarmy.com it fetches normally.

**Before it can work, on the Wix side:**

1. Wix Stores installed on the site, with at least one **visible** product
2. Settings -> Payments -> a payout method connected
3. Settings -> Headless -> the OAuth client's allowed domains must include
   `https://punxarmy.com` — without it hosted checkout cannot return to the site

**How to verify in two minutes**, once deployed: open the site, go to THE
QUARTERMASTER. Real products means it works. "The counter cannot be reached"
means the fetch failed — open the browser console for the reason (`428` = Wix
Stores is not installed on the site). Add `#debug` to the URL to log details.

### The credential rule

The browser credential is the public `WIX_CLIENT_ID`, and nothing else:

- **Never put a Wix API key in the site.** An account-scoped key can read and change
  everything in the account. The browser credential is the public client id, and
  nothing else.
- Wix returns money as an object (`{value, currency, formattedValue}`), not a number.
  Render `formattedValue`. Checkout must go through Wix's own redirect session — a
  hand-built checkout URL will not work.
- The deployed domain has to be allow-listed on the OAuth client, or hosted checkout
  cannot return to the site.

### Getting set up

1. Wix dashboard → add **Wix Stores** (and **Wix Events** if you sell tickets)
2. **Settings → Payments** → connect a payout method
3. Add the products from section 4 of the monetisation plan
4. Copy each product's public URL into `STORE.items[].url`
5. For the headless path: **Settings → Headless** → create an OAuth app → copy the
   **client ID** (not an API key) and add `https://punxarmy.com` to its allowed domains
