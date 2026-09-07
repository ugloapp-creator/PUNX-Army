/* ============================================================================
   PUNX ARMY / NET LAYER
   ----------------------------------------------------------------------------
   Section 1 . GAME CONFIG        tunables, one place
   Section 2 . SHARED TYPES       the vocabulary both ends speak
   Section 3 . WIRE PROTOCOL      envelope + validation (untrusted input)
   Section 4 . TRANSPORT          BroadcastChannel (here) | WebSocket (prod)
   ----------------------------------------------------------------------------
   Nothing in this file touches the DOM. It is loaded byte-identical by the
   browser client, by the browser acting as authority, and by the Node
   dedicated server in server/authority-node.js.
   ========================================================================== */

/* ---------- Section 1 . GAME CONFIG ------------------------------------- */
var NETCFG={
  PROTOCOL:3,                 /* bump on any breaking wire change            */
  MIN_PLAYERS:2,
  MAX_PLAYERS:8,              /* one per squad colour                        */
  CODE_LEN:6,
  CODE_ALPHABET:'ACDEFGHJKLMNPQRTUVWXY34679', /* no O/0 I/1 S/5 B/8 confusion */
  TICK_HZ:20,                 /* authority simulation rate                   */
  SNAP_HZ:10,                 /* broadcast rate                              */
  HEARTBEAT_MS:1500,
  PEER_TIMEOUT_MS:5000,       /* silence before we call a peer gone          */
  RECONNECT_MS:30000,         /* slot held open for a returning player       */
  COUNTDOWN:5,
  ROOM_IDLE_MS:600000,        /* abandoned room cleanup: 10 min              */
  PROBE_MS:600,               /* how long we wait for a room to answer       */
  /* --- drill rules (authority owns every one of these) --- */
  MATCH_LEN:44,               /* seconds                                     */
  BPM:104,
  MORALE_START:58,
  MORALE_PASS:30,
  HIT_WINDOW:0.17,            /* seconds either side of the note             */
  PERFECT_WINDOW:0.07,
  M_PERFECT:3.5, M_CLOSE:2.5, M_WRONG:-2.5, M_MISS:-4.5,
  /* --- anti-cheat envelopes --- */
  MAX_INPUT_HZ:22,            /* a human cannot sustain more than this       */
  INPUT_BURST:14,
  CLOCK_SLOP:0.45,            /* seconds a client clock may differ           */
  CHAT_MIN_MS:900,            /* rate limit between messages                 */
  CHAT_MAX:120,               /* characters                                  */
  CHAT_BURST:5
};

/* ---------- Section 2 . SHARED TYPES ------------------------------------
   @typedef {Object} PlayerState
     id       {string}  durable player id (survives reconnect)
     peer     {string}  current transport address, changes on reconnect
     name     {string}  sanitised display name
     squad    {number}  index into SQUADS
     pose     {number}  index into POSES
     ready    {boolean}
     conn     {'live'|'gone'}
     goneAt   {number}  epoch ms, when conn went 'gone'
     morale   {number}  0..100, AUTHORITY ONLY
     combo,hits,miss,best {number}  AUTHORITY ONLY
     alive    {boolean} still in the column
   @typedef {Object} MatchState
     phase    {'lobby'|'countdown'|'active'|'result'}
     round    {number}  increments per rematch; seeds the chart
     seed     {number}
     startAt  {number}  authority clock, seconds
     players  {PlayerState[]}
--------------------------------------------------------------------------- */

/* ---------- Section 3 . WIRE PROTOCOL ------------------------------------ */

function mkCode(){
  var A=NETCFG.CODE_ALPHABET,s='';
  var b=new Uint8Array(NETCFG.CODE_LEN);
  if(typeof crypto!=='undefined'&&crypto.getRandomValues)crypto.getRandomValues(b);
  else for(var j=0;j<b.length;j++)b[j]=Math.floor(Math.random()*256);
  for(var i=0;i<NETCFG.CODE_LEN;i++)s+=A.charAt(b[i]%A.length);
  return s;
}
function okCode(c){
  if(typeof c!=='string')return false;
  c=c.toUpperCase();
  if(c.length!==NETCFG.CODE_LEN)return false;
  for(var i=0;i<c.length;i++)if(NETCFG.CODE_ALPHABET.indexOf(c.charAt(i))<0)return false;
  return true;
}
function normCode(c){return String(c==null?'':c).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,NETCFG.CODE_LEN)}

/* A durable, opaque id. Not an account, carries nothing about the person. */
function mkId(){
  var b=new Uint8Array(9);
  if(typeof crypto!=='undefined'&&crypto.getRandomValues)crypto.getRandomValues(b);
  else for(var j=0;j<b.length;j++)b[j]=Math.floor(Math.random()*256);
  var s='';for(var i=0;i<b.length;i++)s+=('0'+b[i].toString(16)).slice(-2);
  return s;
}

/* Every field that crosses the wire is re-derived here, on arrival, from
   scratch. Nothing an peer sends is used in the shape it arrived in.      */
var WIRE={
  name:function(v){
    return String(v==null?'':v).toUpperCase().replace(/\s+/g,'_')
      .replace(/[^A-Z0-9_\-]/g,'').slice(0,14)||'RECRUIT';
  },
  idx:function(v,n){
    v=(typeof v==='number'&&isFinite(v))?Math.floor(v):0;
    return (v<0||v>=n)?0:v;
  },
  bool:function(v){return v===true},
  num:function(v,lo,hi,d){
    if(typeof v!=='number'||!isFinite(v))return d;
    return v<lo?lo:v>hi?hi:v;
  },
  id:function(v){
    v=String(v==null?'':v).replace(/[^a-f0-9]/g,'').slice(0,18);
    return v.length===18?v:'';
  },
  /* Chat is the only free text that other people see. It is stripped to a
     printable subset, length-capped, and never inserted as HTML anywhere. */
  chat:function(v){
    return String(v==null?'':v)
      .replace(/[\x00-\x1f\x7f-\x9f]/g,' ')          /* control   */
      .replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,'') /* invisible */
      .replace(/[<>]/g,'')                          /* no markup  */
      .replace(/\s+/g,' ').trim().slice(0,NETCFG.CHAT_MAX);
  }
};

/* A small, deliberately conservative filter. It softens slurs and abuse in
   a shared lobby; it is not a moderation system and does not pretend to be.
   Words are matched whole, with common letter-for-symbol substitutions
   folded first, so it does not mangle innocent text.                       */
var BADWORDS=('nigger nigga faggot fag retard retarded kike spic chink tranny '+
  'whore slut rape rapist kill yourself kys cunt').split(' ');
function filterChat(s){
  var probe=s.toLowerCase()
    .replace(/[@4]/g,'a').replace(/[3]/g,'e').replace(/[!1|]/g,'i')
    .replace(/[0]/g,'o').replace(/[$5]/g,'s').replace(/[7]/g,'t')
    .replace(/[^a-z ]/g,'');
  var words=probe.split(/\s+/),out=s.split(/\s+/),hit=false;
  for(var i=0;i<words.length;i++){
    if(BADWORDS.indexOf(words[i])>=0){out[i]='****';hit=true}
  }
  /* multi-word phrases */
  if(/kill yourself/.test(probe)){return{text:'****',flagged:true}}
  return {text:out.join(' '),flagged:hit};
}

/* Envelope. `to` is a peer address or '*'. Anything failing shape is dropped
   silently by the receiver rather than throwing into the game loop.        */
function envOK(m){
  return !!m&&typeof m==='object'&&typeof m.t==='string'&&
         m.t.length<24&&typeof m.from==='string'&&m.from.length<64&&
         m.v===NETCFG.PROTOCOL;
}

/* ---------- Section 4 . TRANSPORT ---------------------------------------
   Both transports expose exactly this shape, so the authority and the client
   are written once and neither knows which one it is talking over:

     t.id                 my own peer address
     t.send(to, type, d)  to = peer address | '*'
     t.onMessage(fn)      fn({from,to,t,d})
     t.close()
     t.kind               'local' | 'ws'
--------------------------------------------------------------------------- */

/* --- 4a. BroadcastChannel: real multiplayer between tabs/windows on this
   machine. Genuinely asynchronous, genuinely multi-client: each tab is an
   independent peer with its own clock, its own state and its own view. --- */
function LocalTransport(code){
  var self=this;
  this.kind='local';
  this.id=mkId();
  this.code=code;
  this._h=[];
  this._ch=new BroadcastChannel('punxarmy.mp.'+code);
  this._ch.onmessage=function(ev){self._dispatch(ev.data)};
}
/* One gate for everything that arrives, whichever door it came through. */
LocalTransport.prototype._dispatch=function(m){
  if(!envOK(m))return;
  if(m.from===this.id)return;                    /* never hear yourself     */
  if(m.to!=='*'&&m.to!==this.id)return;          /* not addressed to me     */
  for(var i=0;i<this._h.length;i++){
    try{this._h[i](m)}catch(e){reportErr('transport handler',e)}
  }
};
/* When this tab is ALSO the authority, the referee's own messages have to
   reach the player sharing the tab. BroadcastChannel deliberately does not
   echo to its sender, so the authority hands them in through this door.
   They carry a reserved sender that no peer can forge (transport ids are
   hex; this one is not), so the client path is identical either way. */
LocalTransport.prototype.local=function(to,type,d){
  this._dispatch({v:NETCFG.PROTOCOL,from:'@authority',to:to||'*',t:type,d:d});
};
LocalTransport.prototype.send=function(to,type,d){
  try{this._ch.postMessage({v:NETCFG.PROTOCOL,from:this.id,to:to||'*',t:type,d:d})}
  catch(e){/* channel closed mid-teardown; nothing to recover */}
};
LocalTransport.prototype.onMessage=function(fn){this._h.push(fn)};
LocalTransport.prototype.close=function(){
  try{this._ch.close()}catch(e){}
  this._h=[];
};

/* --- 4b. WebSocket: the same protocol to a dedicated authority.
   >>> PRODUCTION INTEGRATION POINT <<<
   Set window.PUNX_WS to your server URL (see server/README.md) and every
   room in this page routes through it instead of BroadcastChannel. The
   authority module is byte-identical on both sides; only this class
   changes. No other line in the app is transport-aware.                 --- */
function WSTransport(code,url,create){
  var self=this;
  this.kind='ws';
  this.id=mkId();
  this.code=code;
  this._h=[];
  this._q=[];
  this._open=false;
  this._url=url;
  this._new=create?1:0;
  this._sock=null;
  this._tries=0;
  this._dial();
}
WSTransport.prototype._dial=function(){
  var self=this;
  try{this._sock=new WebSocket(this._url+'?room='+encodeURIComponent(this.code)+'&peer='+this.id+(this._new?'&new=1':''))}
  catch(e){this._retry();return}
  this._sock.onopen=function(){
    self._open=true;self._tries=0;
    while(self._q.length){var m=self._q.shift();try{self._sock.send(m)}catch(e){}}
  };
  this._sock.onmessage=function(ev){
    var m;try{m=JSON.parse(ev.data)}catch(e){return}
    if(!envOK(m))return;
    if(m.from===self.id)return;
    if(m.to!=='*'&&m.to!==self.id)return;
    for(var i=0;i<self._h.length;i++){try{self._h[i](m)}catch(e){reportErr('ws handler',e)}}
  };
  this._sock.onclose=function(){self._open=false;self._retry()};
  this._sock.onerror=function(){try{self._sock.close()}catch(e){}};
};
WSTransport.prototype._retry=function(){
  if(this._closed)return;
  var self=this,wait=Math.min(8000,600*Math.pow(2,this._tries++));
  setTimeout(function(){if(!self._closed)self._dial()},wait);
};
WSTransport.prototype.send=function(to,type,d){
  var m=JSON.stringify({v:NETCFG.PROTOCOL,from:this.id,to:to||'*',t:type,d:d});
  if(this._open){try{this._sock.send(m)}catch(e){this._q.push(m)}}
  else if(this._q.length<64)this._q.push(m);
};
WSTransport.prototype.onMessage=function(fn){this._h.push(fn)};
WSTransport.prototype.local=function(){/* authority is remote: nothing to echo */};
WSTransport.prototype.close=function(){
  this._closed=true;this._h=[];
  try{this._sock&&this._sock.close()}catch(e){}
};

/* One factory. The rest of the app calls this and never names a transport. */
function openTransport(code,create){
  var url=(typeof window!=='undefined'&&window.PUNX_WS)||null;
  if(url)return new WSTransport(code,url,create);
  if(typeof BroadcastChannel==='undefined')return null;
  return new LocalTransport(code);
}
function transportName(){
  return (typeof window!=='undefined'&&window.PUNX_WS)?'NETWORK':'LOCAL LINK';
}
