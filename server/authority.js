/* ============================================================================
   PUNX ARMY / AUTHORITY  -  the referee
   ----------------------------------------------------------------------------
   The single owner of every number that decides a match: morale, combo, hits,
   misses, accuracy, who is still standing and who won. Clients send INTENT
   ("I struck lane 2 at t=13.44") and never results. Every arriving field is
   re-derived through WIRE.* before it is believed.

   Runs in two places, unchanged:
     - a browser tab that created the room (transport = BroadcastChannel)
     - Node, in server/authority-node.js          (transport = WebSocket)
   It touches no DOM and no timers other than the ones it is handed.
   ========================================================================== */

/* The cadence. Deterministic in the seed, so the authority and every client
   build the identical chart and no note data ever crosses the wire.        */
function buildChart(seed,len,bpm){
  var notes=[],beat=60/bpm,s=(seed>>>0)||11;
  function r(){s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff}
  var t=2.6,i=0;
  while(t<len-1){
    notes.push({i:i++,t:t,l:Math.floor(r()*4)});
    if(r()<0.14)notes.push({i:i++,t:t,l:Math.floor(r()*4)});
    t+=(r()<0.32)?beat/2:beat;
  }
  return notes;
}
function seedOf(code,round){
  var h=2166136261;
  var s=String(code)+':'+round;
  for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=(h*16777619)>>>0}
  return h>>>0;
}

function Authority(transport,code,clock){
  this.tp=transport;
  this.code=code;
  this.now=clock||function(){return Date.now()/1000};
  this.bornAt=Date.now();
  this.lastActivity=Date.now();
  this.room={
    code:code,phase:'lobby',round:0,seed:0,startAt:0,
    hostId:null,players:[],chat:[]
  };
  this.chart=[];
  this.log=[];              /* dev-only ring buffer                          */
  this._lastSnap=0;
  this._cd=0;               /* countdown value                               */
  this._cdAt=0;
  var self=this;
  transport.onMessage(function(m){self.onMsg(m)});
}

/* ---------- plumbing ----------------------------------------------------- */
Authority.prototype._send=function(to,t,d){
  this.tp.send(to,t,d);
  if(this.tp.local)this.tp.local(to,t,d);
};
Authority.prototype._bcast=function(t,d){
  this.tp.send('*',t,d);
  if(this.tp.local)this.tp.local('*',t,d);
};
Authority.prototype._dev=function(kind,detail){
  this.log.push({at:Date.now(),kind:kind,detail:detail});
  if(this.log.length>200)this.log.shift();
};
Authority.prototype.byPeer=function(p){
  for(var i=0;i<this.room.players.length;i++)
    if(this.room.players[i].peer===p)return this.room.players[i];
  return null;
};
Authority.prototype.byId=function(id){
  for(var i=0;i<this.room.players.length;i++)
    if(this.room.players[i].id===id)return this.room.players[i];
  return null;
};
Authority.prototype.live=function(){
  return this.room.players.filter(function(p){return p.conn==='live'});
};

/* What everyone is allowed to know about the room. Note what is NOT here:
   no peer addresses, no tokens, no client-supplied anything.               */
Authority.prototype.pub=function(){
  var r=this.room;
  return {
    code:r.code,phase:r.phase,round:r.round,seed:r.seed,startAt:r.startAt,
    hostId:r.hostId,cd:this._cd,
    len:NETCFG.MATCH_LEN,bpm:NETCFG.BPM,
    players:r.players.map(function(p){
      return {id:p.id,name:p.name,squad:p.squad,pose:p.pose,ready:p.ready,
              conn:p.conn,morale:Math.round(p.morale),combo:p.combo,best:p.best,
              hits:p.hits,miss:p.miss,alive:p.alive,wins:p.wins};
    })
  };
};
Authority.prototype.push=function(){this._bcast('state',this.pub())};

/* ---------- message entry point ------------------------------------------ */
Authority.prototype.onMsg=function(m){
  this.lastActivity=Date.now();
  var d=m.d||{};
  switch(m.t){
    case 'probe':  return this._send(m.from,'here',{code:this.code,
                     n:this.live().length,max:NETCFG.MAX_PLAYERS,phase:this.room.phase});
    case 'join':   return this.join(m.from,d);
    case 'ready':  return this.setReady(m.from,d);
    case 'kit':    return this.setKit(m.from,d);
    case 'start':  return this.hostStart(m.from);
    case 'cancel': return this.hostCancel(m.from);
    case 'input':  return this.input(m.from,d);
    case 'chat':   return this.chat(m.from,d);
    case 'rematch':return this.rematch(m.from);
    case 'lobby':  return this.toLobby(m.from);
    case 'leave':  return this.leave(m.from,true);
    /* A socket that fell over. Distinct from 'leave': the slot is HELD for the
       reconnect window instead of being given up. Only the transport can send
       this - it is stamped with the sender the socket belongs to, so nobody
       can drop anybody but themselves. */
    case 'drop':   return this.leave(m.from,false);
    case 'beat':   return this.beat(m.from);
    case 'ping':   return this._send(m.from,'pong',{t0:WIRE.num(d.t0,0,1e15,0),ts:this.now()});
  }
};
Authority.prototype._nope=function(peer,code,msg){
  this._dev('reject',code);
  this._send(peer,'nope',{code:code,msg:msg});
};

/* ---------- joining ------------------------------------------------------ */
Authority.prototype.join=function(peer,d){
  var id=WIRE.id(d.id);
  if(!id)return this._nope(peer,'bad_id','That figure has no service number.');

  /* Reconnection: the slot is still held, adopt the new peer address. */
  var back=this.byId(id);
  if(back){
    if(back.conn==='live'&&back.peer!==peer)
      return this._nope(peer,'duplicate','That figure is already standing in this room.');
    back.peer=peer;back.conn='live';back.goneAt=0;
    back.name=WIRE.name(d.name);
    this._dev('reconnect',back.name);
    this._send(peer,'welcome',{you:id,room:this.pub(),host:this.room.hostId===id});
    this._sys('rejoin',back.name);
    this.push();
    return;
  }

  if(this.room.phase!=='lobby')
    return this._nope(peer,'in_progress','The drill has already been called. Wait for the next round.');
  if(this.room.players.length>=NETCFG.MAX_PLAYERS)
    return this._nope(peer,'full','This room is at full strength.');

  var taken={},self=this;
  this.room.players.forEach(function(p){taken[p.squad]=1});
  var sq=WIRE.idx(d.squad,8);
  if(taken[sq]){for(var k=0;k<8;k++)if(!taken[k]){sq=k;break}}

  var p={
    id:id,peer:peer,name:WIRE.name(d.name),squad:sq,pose:WIRE.idx(d.pose,6),
    ready:false,conn:'live',goneAt:0,
    morale:NETCFG.MORALE_START,combo:0,best:0,hits:0,miss:0,alive:true,wins:0,
    seq:-1,bucket:NETCFG.INPUT_BURST,bucketAt:this.now(),
    chatAt:0,chatBurst:0,judged:{}
  };
  this.room.players.push(p);
  if(!this.room.hostId)this.room.hostId=id;
  this._dev('join',p.name);
  this._send(peer,'welcome',{you:id,room:this.pub(),host:this.room.hostId===id});
  this._sys('join',p.name);
  this.push();
};

Authority.prototype.setKit=function(peer,d){
  var p=this.byPeer(peer);if(!p)return;
  if(this.room.phase!=='lobby')return this._nope(peer,'locked','Kit is locked once the drill is called.');
  var want=WIRE.idx(d.squad,8),clash=false;
  for(var i=0;i<this.room.players.length;i++){
    var o=this.room.players[i];
    if(o!==p&&o.squad===want)clash=true;
  }
  if(clash)return this._nope(peer,'squad_taken','Another figure is already cast in that plastic.');
  p.squad=want;p.pose=WIRE.idx(d.pose,6);p.name=WIRE.name(d.name);
  this.push();
};

Authority.prototype.setReady=function(peer,d){
  var p=this.byPeer(peer);if(!p)return;
  if(this.room.phase!=='lobby')return;
  p.ready=WIRE.bool(d.ready);
  this._sys(p.ready?'ready':'unready',p.name);
  this.push();
};

Authority.prototype.beat=function(peer){
  var p=this.byPeer(peer);
  if(p){p.seenAt=Date.now();if(p.conn==='gone'){p.conn='live';this.push()}}
};

/* ---------- host controls ------------------------------------------------ */
Authority.prototype.canStart=function(){
  var l=this.live();
  if(l.length<NETCFG.MIN_PLAYERS)return 'Need '+NETCFG.MIN_PLAYERS+' figures in the room.';
  for(var i=0;i<l.length;i++)if(!l[i].ready)return 'Every figure must stand ready.';
  return null;
};
Authority.prototype.hostStart=function(peer){
  var p=this.byPeer(peer);if(!p)return;
  if(p.id!==this.room.hostId)return this._nope(peer,'not_host','Only the sergeant calls the drill.');
  if(this.room.phase!=='lobby')return;
  var why=this.canStart();
  if(why)return this._nope(peer,'not_ready',why);
  this.room.phase='countdown';
  this._cd=NETCFG.COUNTDOWN;this._cdAt=this.now();
  this._dev('countdown',this._cd);
  this.push();
};
Authority.prototype.hostCancel=function(peer){
  var p=this.byPeer(peer);if(!p)return;
  if(p.id!==this.room.hostId)return this._nope(peer,'not_host','Only the sergeant can stand the room down.');
  this._bcast('closed',{why:'The sergeant stood this room down.'});
  this.room.players=[];this.room.phase='lobby';
  this._dev('cancel','host');
};

/* ---------- the match ---------------------------------------------------- */
Authority.prototype.begin=function(){
  var r=this.room;
  r.round++;
  r.seed=seedOf(r.code,r.round);
  this.chart=buildChart(r.seed,NETCFG.MATCH_LEN,NETCFG.BPM);
  r.startAt=this.now()+0.6;
  r.phase='active';
  this.live().forEach(function(p){
    p.morale=NETCFG.MORALE_START;p.combo=0;p.best=0;p.hits=0;p.miss=0;
    p.alive=true;p.seq=-1;p.judged={};p.swept=0;
  });
  this._dev('begin','round '+r.round+' seed '+r.seed);
  this.push();
  this._bcast('go',{seed:r.seed,startAt:r.startAt,round:r.round,
                    len:NETCFG.MATCH_LEN,bpm:NETCFG.BPM});
};

/* One struck lane. The client tells us WHICH lane and WHEN it believes it
   struck; we decide whether that was possible, and what it was worth.     */
Authority.prototype.input=function(peer,d){
  var p=this.byPeer(peer);
  if(!p)return;
  if(this.room.phase!=='active')return this._nope(peer,'not_active','No drill is running.');
  if(!p.alive)return;                       /* broken rank: inputs ignored  */

  /* 1. shape */
  var lane=d&&typeof d.l==='number'?Math.floor(d.l):-1;
  if(lane<0||lane>3)return this._nope(peer,'bad_lane','x');
  var seq=WIRE.num(d.s,0,1e9,-1);
  if(seq<=p.seq)return;                     /* replay or reorder: drop      */
  p.seq=seq;

  /* 2. rate: token bucket, on the authority's own clock rather than the
        wall clock, so the referee is deterministic and can be replayed.
        The burst allowance absorbs a lagging client delivering several
        legitimate strikes in one batch; the refill rate is what no human
        can sustain. */
  var nowS=this.now();
  p.bucket=Math.min(NETCFG.INPUT_BURST,
    p.bucket+(nowS-p.bucketAt)*NETCFG.MAX_INPUT_HZ);
  p.bucketAt=nowS;
  if(p.bucket<1){this._dev('ratelimit',p.name);return this._nope(peer,'too_fast','x')}
  p.bucket-=1;

  /* 3. clock: the client's claimed moment must be near our own. This is what
        stops a client claiming a hit for a note that has not happened yet. */
  var mine=this.now()-this.room.startAt;
  var at=WIRE.num(d.t,-1,NETCFG.MATCH_LEN+2,mine);
  if(Math.abs(at-mine)>NETCFG.CLOCK_SLOP){
    this._dev('clockslop',p.name+' '+(at-mine).toFixed(2));
    at=mine;                                 /* judge on OUR clock instead   */
  }

  /* 4. judge against the chart */
  var best=null,bd=1e9;
  for(var i=0;i<this.chart.length;i++){
    var n=this.chart[i];
    if(n.l!==lane)continue;
    if(p.judged[n.i])continue;
    var dd=Math.abs(n.t-at);
    if(dd<bd){bd=dd;best=n}
  }
  var res;
  if(best&&bd<NETCFG.HIT_WINDOW){
    p.judged[best.i]=1;
    p.hits++;p.combo++;if(p.combo>p.best)p.best=p.combo;
    var perfect=bd<NETCFG.PERFECT_WINDOW;
    p.morale=Math.max(0,Math.min(100,p.morale+(perfect?NETCFG.M_PERFECT:NETCFG.M_CLOSE)));
    res=perfect?'perfect':'close';
  }else{
    p.combo=0;
    p.morale=Math.max(0,Math.min(100,p.morale+NETCFG.M_WRONG));
    res='wrong';
  }
  /* The client predicted something when it struck. Tell it what actually
     happened so it can correct itself. */
  this._send(peer,'judge',{s:seq,r:res,mo:Math.round(p.morale),cb:p.combo});
  if(p.morale<=0&&p.alive)this._break(p);
};

Authority.prototype._break=function(p){
  p.alive=false;p.combo=0;
  this._dev('broke',p.name);
  this._bcast('broke',{id:p.id,name:p.name});
};

/* Notes nobody struck. Swept on the authority's own clock, for every player,
   so a client that simply stops sending cannot avoid its misses.          */
Authority.prototype._sweep=function(t){
  var self=this,ps=this.room.players;
  for(var i=0;i<this.chart.length;i++){
    var n=this.chart[i];
    if(t-n.t<=NETCFG.HIT_WINDOW+0.01)continue;
    for(var j=0;j<ps.length;j++){
      var p=ps[j];
      if(!p.alive||p.judged[n.i])continue;
      p.judged[n.i]=1;
      p.miss++;p.combo=0;
      p.morale=Math.max(0,Math.min(100,p.morale+NETCFG.M_MISS));
      if(p.morale<=0)self._break(p);
    }
  }
};

Authority.prototype.finish=function(){
  var r=this.room;
  r.phase='result';
  var rows=r.players.map(function(p){
    var tot=p.hits+p.miss;
    return {id:p.id,name:p.name,squad:p.squad,
            acc:tot?Math.round(p.hits/tot*100):0,
            hits:p.hits,miss:p.miss,best:p.best,
            morale:Math.round(p.morale),alive:p.alive,
            passed:p.alive&&p.morale>=NETCFG.MORALE_PASS};
  });
  rows.sort(function(a,b){
    if(b.acc!==a.acc)return b.acc-a.acc;
    if(b.best!==a.best)return b.best-a.best;
    return b.morale-a.morale;
  });
  if(rows.length){
    var w=this.byId(rows[0].id);
    if(w&&rows[0].acc>0)w.wins++;
  }
  rows.forEach(function(row,i){row.place=i+1});
  this._dev('result',rows.map(function(x){return x.name+':'+x.acc}).join(' '));
  this.push();
  this._bcast('result',{round:r.round,standings:rows});
};

Authority.prototype.rematch=function(peer){
  var p=this.byPeer(peer);if(!p)return;
  if(p.id!==this.room.hostId)return this._nope(peer,'not_host','Only the sergeant calls the next drill.');
  if(this.room.phase!=='result')return;
  this.room.phase='lobby';
  this.room.players.forEach(function(x){x.ready=false});
  this.push();
};
Authority.prototype.toLobby=function(peer){return this.rematch(peer)};

/* ---------- leaving and cleanup ------------------------------------------ */
Authority.prototype.leave=function(peer,deliberate){
  var p=this.byPeer(peer);if(!p)return;
  if(deliberate){
    this._sys('leave',p.name);
    this.room.players=this.room.players.filter(function(x){return x!==p});
    this._dev('leave',p.name);
  }else{
    p.conn='gone';p.goneAt=Date.now();
    this._sys('drop',p.name);
    this._dev('drop',p.name);
  }
  this._rehost();
  this.push();
};
/* If the sergeant is gone, the longest-standing live figure takes the post. */
Authority.prototype._rehost=function(){
  var h=this.byId(this.room.hostId);
  if(h&&h.conn==='live')return;
  var l=this.live();
  this.room.hostId=l.length?l[0].id:null;
  if(l.length){this._sys('host',l[0].name);this._dev('rehost',l[0].name)}
};

Authority.prototype._sys=function(kind,who){
  this._bcast('sys',{kind:kind,who:who,at:Date.now()});
};

/* ---------- chat --------------------------------------------------------- */
Authority.prototype.chat=function(peer,d){
  var p=this.byPeer(peer);if(!p)return;
  var now=Date.now();
  if(now-p.chatAt<NETCFG.CHAT_MIN_MS){
    p.chatBurst++;
    if(p.chatBurst>NETCFG.CHAT_BURST)return this._nope(peer,'chat_flood','Slow down.');
    return this._nope(peer,'chat_fast','Slow down.');
  }
  p.chatAt=now;p.chatBurst=0;
  var raw=WIRE.chat(d.text);
  if(!raw)return;
  var f=filterChat(raw);
  /* Chat never touches match state. It is broadcast and forgotten. */
  /* Broadcast under a DIFFERENT type from the one peers send on. Peer
     traffic and referee traffic share one channel, so if both were called
     'chat' every client would render its neighbour's unjudged message as
     well as the referee's filtered one. Server-to-client types and
     client-to-server types are disjoint by construction. */
  this._bcast('said',{id:p.id,name:p.name,squad:p.squad,text:f.text,at:now});
};

/* ---------- the tick ----------------------------------------------------- */
Authority.prototype.tick=function(){
  var r=this.room,nowMs=Date.now(),t=this.now();

  /* peers that stopped breathing */
  var self=this,changed=false;
  r.players.forEach(function(p){
    if(p.conn==='live'&&p.seenAt&&nowMs-p.seenAt>NETCFG.PEER_TIMEOUT_MS){
      p.conn='gone';p.goneAt=nowMs;self._sys('drop',p.name);
      self._dev('timeout',p.name);changed=true;
    }
  });
  /* slots that were never reclaimed */
  var keep=r.players.filter(function(p){
    if(p.conn==='gone'&&nowMs-p.goneAt>NETCFG.RECONNECT_MS){
      self._sys('lost',p.name);self._dev('expire',p.name);return false;
    }
    return true;
  });
  if(keep.length!==r.players.length){r.players=keep;changed=true}
  if(changed){this._rehost();this.push()}

  if(r.phase==='countdown'){
    var left=NETCFG.COUNTDOWN-Math.floor(t-this._cdAt);
    if(left!==this._cd){
      this._cd=left;
      if(left>0){this._bcast('cd',{n:left});this.push()}
    }
    if(left<=0)this.begin();
    return;
  }

  if(r.phase==='active'){
    var mt=t-r.startAt;
    if(mt>0)this._sweep(mt);
    var anyAlive=false;
    r.players.forEach(function(p){if(p.alive)anyAlive=true});
    if(!anyAlive||mt>NETCFG.MATCH_LEN)return this.finish();
    if(nowMs-this._lastSnap>=1000/NETCFG.SNAP_HZ){
      this._lastSnap=nowMs;
      this._bcast('snap',{t:mt,p:r.players.map(function(p){
        return {i:p.id,mo:Math.round(p.morale),cb:p.combo,
                h:p.hits,m:p.miss,a:p.alive?1:0,c:p.conn==='live'?1:0};
      })});
    }
  }
};
Authority.prototype.idle=function(){
  return this.live().length===0&&Date.now()-this.lastActivity>NETCFG.ROOM_IDLE_MS;
};
Authority.prototype.close=function(){
  this._bcast('closed',{why:'The room was stood down.'});
};

if(typeof module!=='undefined'&&module.exports)
  module.exports={Authority:Authority,buildChart:buildChart,seedOf:seedOf};
