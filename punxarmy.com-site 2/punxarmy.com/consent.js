/* PUNX ARMY: cookie consent + Google Analytics 4.
   ───────────────────────────────────────────────────────────────────────────
   1. Paste your GA4 Measurement ID below (Google Analytics > Admin > Data streams
      > your web stream > Measurement ID, looks like G-AB12CD34EF).
   2. Upload this file. That's it.
   Until a real ID is pasted, nothing loads and no popup shows.

   How it behaves (built to satisfy US state privacy laws and EU/UK cookie rules):
   - Google's script does not load, and no Google cookie is set, until the visitor
     taps "Accept analytics". "Decline" is the same size and just as easy.
   - Browsers sending Global Privacy Control are treated as "decline" automatically.
   - Ads features are off: no ad storage, no ad personalization, no Google signals.
   - Personal codes are stripped before anything is sent: /pass/xxxx, /passport/PP-xxxx
     and /t/xxxx are reported as /pass/:code etc., and query strings are dropped.
   - The choice is remembered for 12 months, then asked again. Anyone can change it
     from any "Cookie settings" link or on /privacy.
   - punxTrack(name, params) sends a custom event only if analytics is on. */
(() => {
  'use strict';
  const GA_ID = 'G-S1VJ9KL9R3'; // your GA4 Measurement ID
  const KEY = 'punx_consent', VERSION = 1, MAX_AGE = 365 * 864e5;
  const enabled = /^G-[A-Z0-9]{6,}$/.test(GA_ID) && GA_ID !== 'G-XXXXXXXXXX';
  const gpc = !!navigator.globalPrivacyControl;

  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const read = () => { try { const c = JSON.parse(get(KEY) || 'null'); return c && c.v === VERSION && Date.now() - c.t < MAX_AGE ? c.a : null; } catch (e) { return null; } };
  const save = (a) => set(KEY, JSON.stringify({ v: VERSION, t: Date.now(), a }));

  // a page address with nothing personal in it
  function cleanUrl() {
    let p = location.pathname;
    p = p.replace(/^\/pass\/[^/]+/, '/pass/:code').replace(/^\/passport\/[^/]+/, '/passport/:id').replace(/^\/t\/[^/]+/, '/t/:code');
    return location.origin + p;
  }

  let loaded = false;
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  function load() {
    if (loaded || !enabled) return; loaded = true;
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('config', GA_ID, { page_location: cleanUrl(), page_referrer: document.referrer ? new URL(document.referrer).origin : '', allow_google_signals: false, allow_ad_personalization_signals: false });
    const s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }
  function dropCookies() {
    const host = location.hostname, parts = host.split('.');
    const domains = ['', host, '.' + host, parts.length > 1 ? '.' + parts.slice(-2).join('.') : host];
    for (const c of document.cookie.split(';')) {
      const name = c.split('=')[0].trim();
      if (!/^_ga|^_gid|^_gat/.test(name)) continue;
      for (const d of domains) document.cookie = name + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
    }
  }
  function choose(a) {
    save(a);
    if (a === 'granted') load();
    else { if (loaded) gtag('consent', 'update', { analytics_storage: 'denied' }); dropCookies(); }
    hide(); paintPanel();
    document.dispatchEvent(new CustomEvent('punx:consent', { detail: a }));
  }

  // custom events, only ever sent with consent
  window.punxTrack = (name, params) => { if (loaded && read() === 'granted') { try { gtag('event', name, params || {}); } catch (e) {} } };

  // ── the popup ──
  let box = null;
  const css = `
.pcx{position:fixed;left:max(.75rem,env(safe-area-inset-left));right:max(.75rem,env(safe-area-inset-right));bottom:max(.75rem,env(safe-area-inset-bottom));z-index:2147483000;max-width:36rem;margin:0 auto;
  padding:1rem 1.1rem 1.05rem;background:rgba(18,18,17,.98);color:#E6E4DE;border:1px solid #3a3a38;border-left:3px solid #A6FF00;border-radius:6px;box-shadow:0 12px 34px rgba(0,0,0,.65);
  font:400 .8rem/1.5 "IBM Plex Mono","Courier New",monospace;text-align:left;letter-spacing:0;text-transform:none}
.pcx h2{all:unset;display:block;font:700 .72rem "IBM Plex Mono","Courier New",monospace;letter-spacing:.2em;text-transform:uppercase;color:#A6FF00;margin:0 0 .4rem}
.pcx p{margin:0 0 .85rem;color:#E6E4DE;font-size:.8rem;max-width:none}
.pcx a{color:#E6E4DE;text-decoration:underline;text-underline-offset:3px}.pcx a:hover{color:#A6FF00}
.pcx .r{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
.pcx button{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;min-height:2.75rem;padding:.55rem .8rem;border-radius:4px;cursor:pointer;text-align:center;
  font:700 .68rem "IBM Plex Mono","Courier New",monospace;letter-spacing:.16em;text-transform:uppercase;border:1px solid #6f706c;background:linear-gradient(#d8dad6,#a9aca8);color:#070707}
.pcx button:hover{filter:brightness(1.07)}
.pcx button:focus-visible{outline:2px solid #A6FF00;outline-offset:3px}
.pcx-chip{all:unset;box-sizing:border-box;position:fixed;left:max(.6rem,env(safe-area-inset-left));bottom:max(.6rem,env(safe-area-inset-bottom));z-index:2147483000;cursor:pointer;
  padding:.45rem .7rem;border:1px solid #3a3a38;border-left:3px solid #A6FF00;border-radius:4px;background:rgba(18,18,17,.92);color:#A39D91;
  font:600 .58rem "IBM Plex Mono","Courier New",monospace;letter-spacing:.18em;text-transform:uppercase}
.pcx-chip:hover{color:#E6E4DE}.pcx-chip:focus-visible{outline:2px solid #A6FF00;outline-offset:3px}
@media (max-width:360px){.pcx .r{grid-template-columns:1fr}}
@media (max-height:520px) and (min-width:600px){.pcx{display:grid;grid-template-columns:1fr 12rem;gap:.2rem 1rem;align-items:center;max-width:52rem;padding:.7rem .9rem}.pcx h2,.pcx p{grid-column:1;margin:0}.pcx .r{grid-column:2;grid-row:1/3;grid-template-columns:1fr;gap:.4rem}.pcx button{min-height:2.3rem}}`;
  function show() {
    if (!enabled || box) return;
    if (!document.getElementById('pcx-css')) { const st = document.createElement('style'); st.id = 'pcx-css'; st.textContent = css; document.head.appendChild(st); }
    box = document.createElement('section');
    box.className = 'pcx'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-labelledby', 'pcx-h'); box.setAttribute('aria-describedby', 'pcx-p');
    box.innerHTML = '<h2 id="pcx-h">Cookies, briefly</h2><p id="pcx-p">Can we use Google Analytics cookies to see which parts of the archive people reach? It helps us make it better. No ads, nothing sold, and everything works the same if you say no. <a href="/privacy/#storage">Details</a></p><div class="r"><button type="button" data-a="granted">Accept analytics</button><button type="button" data-a="denied">Decline</button></div>';
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => choose(b.dataset.a)));
    document.body.appendChild(box);
  }
  function hide() { if (box) { box.remove(); box = null; } if (chip) { chip.remove(); chip = null; } }
  // On the initiation, the popup must never sit on top of the story. Once the visitor presses Begin
  // without answering, it folds into a small chip in the corner. No answer still means analytics stays off.
  let chip = null;
  function fold() {
    if (!box || chip) return;
    box.remove(); box = null;
    chip = document.createElement('button'); chip.type = 'button'; chip.className = 'pcx-chip'; chip.textContent = 'Cookie choice';
    chip.setAttribute('aria-label', 'Open the cookie choice');
    chip.addEventListener('click', () => { chip.remove(); chip = null; show(); });
    document.body.appendChild(chip);
  }
  function watchGate() {
    const gate = document.getElementById('gate'); if (!gate) return;
    const mo = new MutationObserver(() => { if (!document.getElementById('gate')) { mo.disconnect(); fold(); } });
    mo.observe(document.body, { childList: true, subtree: true });
    const b = document.getElementById('begin'); if (b) b.addEventListener('click', () => setTimeout(fold, 50));
  }

  // ── "Cookie settings" links and the panel on /privacy ──
  function paintPanel() {
    const p = document.getElementById('choices'); if (!p) return;
    const st = p.querySelector('[data-consent]'); if (!st) return;
    const a = read();
    st.textContent = !enabled ? 'analytics is not switched on for this site.' : a === 'granted' ? 'on. You allowed Google Analytics cookies.' : gpc && !a ? 'off. Your browser sends Global Privacy Control, so we never ask.' : a === 'denied' ? 'off. You declined.' : 'not chosen yet (off until you allow it).';
    p.querySelectorAll('[data-set]').forEach((b) => { b.disabled = !enabled || b.dataset.set === a; });
  }
  function storagePanel(box) {
    const list = box.querySelector('[data-saved]'), g = box.querySelector('[data-gpc]'), clear = box.querySelector('[data-clear]'), note = box.querySelector('[data-note]');
    if (!list || !clear) return;
    const keys = () => { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('punx_')) out.push(k); } } catch (e) {} return out.sort(); };
    const cookies = () => document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter((n) => /^_ga|^_gid|^_gat/.test(n));
    const paint = () => { const k = keys().concat(cookies()); list.textContent = k.length ? k.join(', ') : 'nothing (this browser has no PUNX data saved)'; clear.disabled = !k.length; };
    if (g) g.textContent = gpc ? 'on. We honor it: analytics stays off and we never ask.' : 'not detected.';
    clear.addEventListener('click', () => { for (const k of keys()) { try { localStorage.removeItem(k); } catch (e) {} } if (loaded) gtag('consent', 'update', { analytics_storage: 'denied' }); dropCookies(); paint(); paintPanel(); if (note) note.textContent = 'Cleared. This browser no longer holds any PUNX data or analytics cookies.'; });
    paint();
  }
  function wire() {
    document.querySelectorAll('[data-cookie-settings]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); hide(); if (enabled) show(); else location.href = '/privacy/#choices'; }));
    const p = document.getElementById('choices');
    if (p) p.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => choose(b.dataset.set)));
    paintPanel();
    if (p) storagePanel(p);
    const a = read();
    if (a === 'granted') load();
    else if (enabled && !a && !gpc && !document.querySelector('[data-no-notice]')) { show(); watchGate(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
