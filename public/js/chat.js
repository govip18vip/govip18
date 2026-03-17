/* chat.js v9.0
   新增：私密通话（群内不可见）· 6种变声 · 二维码分享 · 全局一次性阅读
   移除：截屏检测（实现不了） */
'use strict';

const WS_URL = location.protocol==='https:' ? `wss://${location.host}` : `ws://${location.host}`;
const RTC_CFG = {
  iceServers:[
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
    {urls:'turn:openrelay.metered.ca:80',   username:'openrelayproject',credential:'openrelayproject'},
    {urls:'turn:openrelay.metered.ca:443?transport=tcp',username:'openrelayproject',credential:'openrelayproject'},
  ],
  iceCandidatePoolSize:10, iceTransportPolicy:'all', bundlePolicy:'max-bundle', rtcpMuxPolicy:'require'
};
const MAX_FILE = 15*1024*1024;
const ICE_TO   = 15000;
const ICE_MAX  = 3;

/* ─── State ─── */
let ws=null, roomKey='', derivedKey='', myNick='', myId='', roomHash='';
let members={}, seenNonces=new Set();
let msgEls=new Map();
let autoDelete=0, pendingFile=null, replyTo=null;
let isVoice=false, typingT=null, isTyping=false;
let reconT=null, reconN=0;
let notifOn=false, unread=0, origTitle=document.title;
let schedMins=0;
let onceReadMode=false;     // ★ 全局一次性阅读
let currentEffect='none';   // ★ 当前变声效果
let currentQRKey='';        // ★ QR 当前密钥
let reactionTarget=null;
let pmTarget=null, pmNick='';
const pmHist=new Map();

/* Call */
let inCall=false, callType='audio', isPrivateCall=false;
let localStream=null, pcs={}, remoteStreams=new Map();
let callStart=0, callT=null, qualT=null;
let iceRC={}, iceTO={}, pendingCall=null, callMini=false;
const blobCache=new Map();

/* ─── Utils ─── */
const $ = id => document.getElementById(id);
const uid = () => (crypto.randomUUID?.().replace(/-/g,'').slice(0,16)) || (Math.random().toString(36).slice(2)+Date.now().toString(36));
const esc = s => { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; };
const fmtS = b => b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(1)+'MB';
const fmt2 = n => String(n).padStart(2,'0');
const fmtT = ts => new Date(ts).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'});

function getBlobURL(data, key) {
  if (blobCache.has(key)) return blobCache.get(key);
  try {
    const [h,b] = data.split(',');
    const mime  = h.match(/:(.*?);/)[1];
    const bin   = atob(b);
    const arr   = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr],{type:mime}));
    blobCache.set(key, url);
    return url;
  } catch(e){ return data; }
}
function freeBlob(k) { if(blobCache.has(k)){URL.revokeObjectURL(blobCache.get(k));blobCache.delete(k);} }

/* ─── Toast ─── */
let toastT=null;
function showToast(msg,dur=2500){clearTimeout(toastT);const t=$('toast');t.textContent=msg;t.classList.add('show');toastT=setTimeout(()=>t.classList.remove('show'),dur);}

/* ─── Input ─── */
$('iKey').addEventListener('input',()=>checkPwdStrength($('iKey').value));
function togglePwd(){const i=$('iKey');i.type=i.type==='password'?'text':'password';}

/* ─── 一次性阅读 ─── */
function toggleOnceRead(){
  const sw=$('togOnceRead');
  sw.classList.toggle('on');
  onceReadMode=sw.classList.contains('on');
  showToast(onceReadMode?'👁 偷窥保护已开启，消息需点击查看':'👁 偷窥保护已关闭');
}

/* ─── QR Code ─── */
function showQR(key) {
  currentQRKey = key;
  const link = buildLink(key);
  const box = $('qrBox');
  box.innerHTML = '';
  try {
    new QRCode(box, {
      text: link,
      width: 200, height: 200,
      colorDark: '#0a0a0a',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch(e) {
    // fallback if QRCode fails
    box.innerHTML = `<div style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#666;text-align:center;padding:10px">二维码生成失败，请复制链接</div>`;
  }
  // Display key hint
  $('qrKeyDisplay').textContent = '密钥: ' + key.slice(0,8) + '…';
  $('qrOverlay').classList.add('show');
}
function showQRLogin() {
  const k = $('iKey').value.trim();
  if (!k) { showToast('⚠️ 请先输入或生成密钥'); return; }
  showQR(k);
}
function showQRInRoom() { showQR(roomKey); }
function closeQR() { $('qrOverlay').classList.remove('show'); }

/* ─── Voice Effects ─── */
const EFFECTS = {
  none:  { icon:'🎤', name:'原声' },
  loli:  { icon:'🌸', name:'萝莉音' },
  uncle: { icon:'🎸', name:'大叔音' },
  geek:  { icon:'🤖', name:'极客音' },
  ghost: { icon:'👻', name:'幽灵音' },
  cave:  { icon:'🏔',  name:'山洞音' },
};

function openEffectPicker() {
  $('attachPanel').classList.remove('show');
  // 标记当前选中
  Object.keys(EFFECTS).forEach(k => {
    const el = $('ef-'+k);
    if (el) el.classList.toggle('active', k === currentEffect);
  });
  $('effectOverlay').classList.add('show');
}
function closeEffectPicker() { $('effectOverlay').classList.remove('show'); }

function setEffect(name) {
  currentEffect = name;
  const ef = EFFECTS[name] || EFFECTS.none;
  $('efIc').textContent = ef.icon;
  $('efTxt').textContent = ef.name;
  // 更新选中状态
  Object.keys(EFFECTS).forEach(k => {
    const el = $('ef-'+k);
    if (el) el.classList.toggle('active', k === name);
  });
  // 更新录音UI显示
  const label = $('recEffectLabel');
  if (label) label.textContent = name !== 'none' ? ef.icon + ' ' + ef.name : '';
  // 更新录音按钮图标
  const recIc = $('recIcon');
  if (recIc) recIc.textContent = ef.icon;
  showToast(`${ef.icon} ${ef.name}已选择`);
}

/* 应用变声效果到麦克风流 */
function applyVoiceEffect(stream, effect) {
  if (effect === 'none') return stream;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const dst = ctx.createMediaStreamDestination();

    if (effect === 'loli') {
      // 萝莉音：高通 + 高频提升 + 轻微失真
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 250;
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf'; shelf.frequency.value = 2500; shelf.gain.value = 12;
      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking'; peak.frequency.value = 1200; peak.gain.value = 6; peak.Q.value = 1.5;
      const gain = ctx.createGain(); gain.gain.value = 1.4;
      src.connect(hp); hp.connect(peak); peak.connect(shelf); shelf.connect(gain); gain.connect(dst);
    }
    else if (effect === 'uncle') {
      // 大叔音：低通 + 低频大幅提升 + 中频凹陷
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2200;
      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf'; bass.frequency.value = 250; bass.gain.value = 14;
      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking'; mid.frequency.value = 1000; mid.gain.value = -4; mid.Q.value = 1;
      const gain = ctx.createGain(); gain.gain.value = 0.9;
      src.connect(mid); mid.connect(bass); bass.connect(lp); lp.connect(gain); gain.connect(dst);
    }
    else if (effect === 'geek') {
      // 极客/机器人音：环形调制 (AM) = 金属质感
      const ringGain = ctx.createGain();
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = 40;
      const oscScaler = ctx.createGain(); oscScaler.gain.value = 0.6;
      const dcOffset = ctx.createGain(); dcOffset.gain.value = 0.4;
      // DC bias + oscillator → ring modulator
      const merger = ctx.createGain(); merger.gain.value = 1;
      osc.connect(oscScaler); oscScaler.connect(ringGain.gain);
      src.connect(ringGain);
      // 加点压缩让声音更结实
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20; comp.knee.value = 5; comp.ratio.value = 8;
      ringGain.connect(comp); comp.connect(dst);
      osc.start();
    }
    else if (effect === 'ghost') {
      // 幽灵音：深度混响模拟 + 低频共鸣
      const delay1 = ctx.createDelay(1.0); delay1.delayTime.value = 0.18;
      const delay2 = ctx.createDelay(1.0); delay2.delayTime.value = 0.35;
      const fb1 = ctx.createGain(); fb1.gain.value = 0.45;
      const fb2 = ctx.createGain(); fb2.gain.value = 0.3;
      const wet = ctx.createGain(); wet.gain.value = 0.7;
      const dry = ctx.createGain(); dry.gain.value = 0.3;
      const lp = ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value = 900;
      // Feedback loops
      src.connect(delay1); delay1.connect(fb1); fb1.connect(delay1);
      src.connect(delay2); delay2.connect(fb2); fb2.connect(delay2);
      delay1.connect(wet); delay2.connect(wet);
      wet.connect(lp); lp.connect(dst);
      src.connect(dry); dry.connect(dst);
    }
    else if (effect === 'cave') {
      // 山洞音：长延迟回声 + 低频共鸣
      const delay = ctx.createDelay(2.0); delay.delayTime.value = 0.5;
      const fb = ctx.createGain(); fb.gain.value = 0.55;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
      const wet = ctx.createGain(); wet.gain.value = 0.6;
      const dry = ctx.createGain(); dry.gain.value = 0.5;
      src.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay);
      delay.connect(wet); wet.connect(dst);
      src.connect(dry); dry.connect(dst);
    }
    else {
      src.connect(dst);
    }

    return dst.stream;
  } catch(e) {
    console.warn('Voice effect failed, using original stream:', e);
    return stream;
  }
}

/* ─── Ringtones ─── */
let ringCtx=null,ringInt=null,ringOn=false;
function startRing(){
  if(ringOn)return;ringOn=true;
  try{
    ringCtx=new(window.AudioContext||window.webkitAudioContext)();
    const burst=()=>{if(!ringOn)return;[0,220].forEach(d=>setTimeout(()=>{if(!ringOn)return;const n=ringCtx.currentTime;const o1=ringCtx.createOscillator(),o2=ringCtx.createOscillator(),g=ringCtx.createGain();o1.frequency.value=440;o2.frequency.value=480;o1.connect(g);o2.connect(g);g.connect(ringCtx.destination);g.gain.setValueAtTime(0,n);g.gain.linearRampToValueAtTime(.14,n+.05);g.gain.setValueAtTime(.14,n+.8);g.gain.linearRampToValueAtTime(0,n+1);o1.start(n);o1.stop(n+1);o2.start(n);o2.stop(n+1);},d));};
    burst();ringInt=setInterval(burst,3200);
    if(navigator.vibrate)navigator.vibrate([700,300,700,300,700]);
  }catch(e){}
}
function stopRing(){ringOn=false;clearInterval(ringInt);if(ringCtx){try{ringCtx.close()}catch(e){}ringCtx=null;}if(navigator.vibrate)navigator.vibrate(0);}
let dialCtx=null,dialInt=null,dialOn=false;
function startDial(){if(dialOn)return;dialOn=true;try{dialCtx=new(window.AudioContext||window.webkitAudioContext)();const b=()=>{if(!dialOn)return;const n=dialCtx.currentTime;const o=dialCtx.createOscillator(),g=dialCtx.createGain();o.frequency.value=425;o.connect(g);g.connect(dialCtx.destination);g.gain.setValueAtTime(0,n);g.gain.linearRampToValueAtTime(.07,n+.05);g.gain.setValueAtTime(.07,n+.9);g.gain.linearRampToValueAtTime(0,n+1);o.start(n);o.stop(n+1.1);};b();dialInt=setInterval(b,4000);}catch(e){}}
function stopDial(){dialOn=false;clearInterval(dialInt);if(dialCtx){try{dialCtx.close()}catch(e){}dialCtx=null;}}

/* ─── Notifications ─── */
function sendNotif(title,body){if(!notifOn||!document.hidden)return;try{new Notification(title,{body,icon:'🔐',tag:'gc',renotify:true});}catch(e){}}
function toggleNotif(){const t=$('togNotif');if(!t.classList.contains('on')){if('Notification' in window){Notification.requestPermission().then(p=>{if(p==='granted'){t.classList.add('on');notifOn=true;showToast('🔔 通知已开启');}else showToast('❌ 权限被拒绝');});}else showToast('不支持通知');}else{t.classList.remove('on');notifOn=false;}}

document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&$('sChat').classList.contains('active')&&$('togPL').classList.contains('on'))$('privacyLock').classList.add('show');
  else $('privacyLock').classList.remove('show');
  if(!document.hidden){unread=0;document.title=origTitle;}
});

/* ─── Emoji ─── */
const EMOJIS={'😊':['😀','😃','😄','😁','😆','🥹','😅','🤣','😊','😇','🙂','😉','😌','😍','🥰','😘','😋','😛','😝','😜','🤪','🤗','🤭','🤫','🤔','😐','😏','😒','🙄','😬','😔','😪','😴','😷','🤒','🥴','😵','🤯','🤠','🥳','😎','🤓','😕','😟','😮','😲','😳','🥺','😨','😰','😢','😭','😱'],'❤️':['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❤️‍🔥','💕','💞','💓','💗','💖','💘','💪','👍','👎','👊','✊','🤝','👏','🙌','🫶','🙏','✌️','👌','👋','🤟'],'🐾':['🐶','🐱','🐭','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🦆','🦅','🦉','🐴','🦄','🐝','🦋','🐌','🐞','🐢','🐙','🐬','🦈','🐳'],'🍔':['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🥭','🥝','🍅','🥑','🥦','🌽','🥕','🍔','🍟','🍕','🌭','🥪','🌮','🥗','🍿','🧁','🍰','🎂','🍫','☕','🍺','🥤']};
function buildEmoji(){const p=$('emojiPanel');let t='<div class="etabs">',g='';Object.keys(EMOJIS).forEach((c,i)=>{t+=`<div class="etab${i===0?' active':''}" onclick="switchEtab(${i})">${c}</div>`;g+=`<div class="egrid" id="eg${i}" style="${i>0?'display:none':''}">${EMOJIS[c].map(e=>`<div class="ei" onclick="insEmoji('${e}')">${e}</div>`).join('')}</div>`;});p.innerHTML=t+'</div>'+g;}
function switchEtab(i){document.querySelectorAll('.etab').forEach((t,j)=>t.classList.toggle('active',i===j));document.querySelectorAll('.egrid').forEach((g,j)=>g.style.display=i===j?'':'none');}
function insEmoji(e){$('iMsg').value+=e;$('iMsg').focus();$('btnSend').classList.remove('disabled');}
function toggleEmoji(){$('emojiPanel').classList.toggle('show');$('attachPanel').classList.remove('show');}

/* ─── Scheduled ─── */
function openSchedPicker(){$('attachPanel').classList.remove('show');$('schedOverlay').classList.add('show');}
function closeSchedPicker(){$('schedOverlay').classList.remove('show');}
function setSched(m){schedMins=m;closeSchedPicker();$('schedBar').style.display='flex';$('schedLabel').textContent=m>=60?(m/60+'小时后'):(m+'分钟后');showToast(`⏱ ${m}分钟后发送`);}
function cancelSched(){schedMins=0;$('schedBar').style.display='none';}

/* ─── Search ─── */
function openSearch(){$('searchPanel').classList.add('show');setTimeout(()=>$('searchInput').focus(),300);}
function closeSearch(){$('searchPanel').classList.remove('show');}
async function doSearch(){
  const kw=$('searchInput').value.trim();const box=$('searchResults');
  if(!kw){box.innerHTML='';return;}
  const results=await searchMsgs(kw);
  if(!results.length){box.innerHTML='<div class="search-empty">没有找到相关消息</div>';return;}
  box.innerHTML=results.map(m=>{const txt=(m.text||'').replace(new RegExp(`(${esc(kw)})`,'gi'),'<mark>$1</mark>');return`<div class="search-item" onclick="scrollToMsg('${m.id}');closeSearch()"><div class="si-nick">${esc(m.nick)}</div><div class="si-text">${txt}</div><div class="si-time">${fmtT(m.ts||0)}</div></div>`;}).join('');
}
function scrollToMsg(id){const el=document.getElementById('msg-'+id);if(!el)return;el.scrollIntoView({behavior:'smooth',block:'center'});el.style.outline='2px solid var(--g)';setTimeout(()=>el.style.outline='',1500);}

/* ─── Reaction ─── */
function showReactionPicker(msgId,el){
  reactionTarget=msgId;const picker=$('reactionPicker');
  const r=el.getBoundingClientRect();const ar=$('app').getBoundingClientRect();
  picker.style.top=(r.top-ar.top-52)+'px';picker.style.left=Math.max(8,Math.min(r.left-ar.left,ar.width-220))+'px';
  picker.classList.add('show');setTimeout(()=>document.addEventListener('click',closeRP,{once:true}),50);
}
function closeRP(){$('reactionPicker').classList.remove('show');reactionTarget=null;}
function sendReaction(emoji){closeRP();if(!reactionTarget||!ws||ws.readyState!==WebSocket.OPEN)return;ws.send(encrypt({type:'reaction',msgId:reactionTarget,emoji,nick:myNick}));applyReaction(reactionTarget,emoji,myNick,true);}
function applyReaction(msgId,emoji,nick,isMe){
  const row=document.getElementById('msg-'+msgId);if(!row)return;
  let box=row.querySelector('.msg-reactions');
  if(!box){box=document.createElement('div');box.className='msg-reactions';const meta=row.querySelector('.msg-meta');if(meta)row.insertBefore(box,meta);}
  let chip=box.querySelector(`[data-emoji="${emoji}"]`);
  if(!chip){chip=document.createElement('div');chip.className='reaction-chip';chip.dataset.emoji=emoji;chip.dataset.count=0;chip.innerHTML=`${emoji}<span class="rc">0</span>`;box.appendChild(chip);}
  const cnt=parseInt(chip.dataset.count||0)+1;chip.dataset.count=cnt;chip.querySelector('.rc').textContent=cnt;
  if(isMe)chip.classList.add('mine');
  chip.style.transform='scale(1.15)';setTimeout(()=>chip.style.transform='',200);
}

/* ─── WebSocket ─── */
let pingInt=null;

function joinRoom(){
  myNick=$('iNick').value.trim().replace(/[<>'"&]/g,'')||'用户_'+Math.floor(Math.random()*1000);
  roomKey=$('iKey').value.trim();
  if(!roomKey){showToast('⚠️ 请输入密钥');return;}
  if(roomKey.length<4){showToast('⚠️ 密钥至少4位');return;}
  const salt=CryptoJS.SHA256('gchat9_'+roomKey).toString().slice(0,32);
  derivedKey=deriveKey(roomKey,salt);
  $('btnJoin').disabled=true;
  $('connStatus').innerHTML='🔄 正在连接…<br><span style="color:#555;font-size:10px">首次唤醒约需30秒</span>';
  connectWS();
}

function connectWS(){
  roomHash=CryptoJS.SHA256(derivedKey).toString().slice(0,16);
  try{ws=new WebSocket(`${WS_URL}?r=${roomHash}`);}catch(e){$('connStatus').innerHTML='❌ 网络异常';$('btnJoin').disabled=false;return;}

  ws.onopen=async()=>{
    reconN=0;clearTimeout(reconT);
    $('btnJoin').disabled=false;$('connStatus').textContent='';
    $('offlineBar').classList.remove('show');$('btnSend').classList.remove('disabled');
    $('netInd').classList.remove('weak','dead');
    ws.send(encrypt({type:'presence',action:'join',nick:myNick}));
    $('roomTitle').textContent=`🔒 ${roomHash.slice(0,6)}`;
    $('hdrSub').textContent='🔐 已加密';$('hdrSub').classList.add('enc');
    $('secInfo').textContent=`房间: ${roomHash}\n加密: AES-256-CBC+HMAC\n密钥: PBKDF2-SHA256`;
    fetch('/api/turn').then(r=>r.json()).then(d=>{if(d.iceServers)d.iceServers.forEach(s=>{if(!RTC_CFG.iceServers.find(x=>x.urls===s.urls))RTC_CFG.iceServers.push(s);});}).catch(()=>{});
    clearInterval(pingInt);
    pingInt=setInterval(()=>{if(ws&&ws.readyState===WebSocket.OPEN)try{ws.send(JSON.stringify({_ping:Date.now()}));}catch(e){}},20000);
    if(!$('sChat').classList.contains('active')){
      document.querySelectorAll('.screen').forEach(e=>e.classList.remove('active'));
      $('sChat').classList.add('active');$('iMsg').focus();
      await initDB(roomHash);await loadHistory();sysMsg('👋 已加入加密聊天室');
    }
  };

  ws.onmessage=async e=>{
    let env;try{env=JSON.parse(e.data);}catch(er){return;}
    if(env._pong)return;
    if(env._sys){
      if(env._sys==='welcome')myId=env._id;
      if(env._sys==='left'){if(members[env._id])sysMsg(`👋 ${members[env._id]} 已离开`);delete members[env._id];updateCnt();$('hdrSub').textContent='🔐 已加密';$('hdrSub').classList.remove('typing');$('hdrSub').classList.add('enc');if(pcs[env._id]){pcs[env._id].close();delete pcs[env._id];rmVideo(env._id);checkCallEnd();}}
      if(env._sys==='offline_done')sysMsg(`📬 ${env.count}条离线消息`);
      if(env._sys==='rate_limit')showToast('⚠️ 发送太快');
      return;
    }
    if(env._data&&env._from!==myId){
      const p=decrypt(env._data);if(!p)return;
      const sid=env._from;
      switch(p.type){
        case 'presence':
          if(p.action==='join'||p.action==='sync'){members[sid]=p.nick;updateCnt();if(p.action==='join'){sysMsg(`👋 ${p.nick} 加入了房间`);ws.send(encrypt({type:'presence',action:'sync',nick:myNick}));sendNotif('新成员',p.nick+' 加入了房间');if(inCall&&!isPrivateCall&&localStream)setTimeout(()=>makeOffer(sid),800);}}break;
        case 'chat':
          // ★ 私聊路由
          if(p.privateTo){if(p.privateTo===myId)recvPM(sid,p);}
          else{renderMsg(p,false);saveMsg({...p,_isMe:false});ws.send(encrypt({type:'receipt',msgId:p.id,status:'read'}));sendNotif(p.nick,p.text||'[媒体]');if(document.hidden){unread++;document.title=`(${unread}) ${origTitle}`;}}
          break;
        case 'receipt':updRcpt(p.msgId,p.status);break;
        case 'recall':doRecall(p.msgId);deleteMsg(p.msgId);break;
        case 'reaction':applyReaction(p.msgId,p.emoji,p.nick,false);break;
        case 'typing':handleTyping(sid,p.active);break;
        // ★ 通话邀请：检查 privateTo，不是给自己的直接忽略
        case 'call_invite':
          if(p.privateTo&&p.privateTo!==myId)break; // 私密通话，不是我的忽略
          onIncoming(p.nick,p.callType,sid,p.privateTo===myId);break;
        case 'call_accept':onCallAccept(sid,p.callType);break;
        case 'call_decline':onCallDecline(sid);break;
        case 'webrtc':if(!inCall)break;if(p.target&&p.target!==myId)break;handleRTC(sid,p.signal);break;
        case 'remote_clear':remoteClear(p.nick);break;
        case 'remote_delete':doDeleteMsg(p.msgId);break;
      }
    }
  };

  ws.onclose=()=>{
    $('btnSend').classList.add('disabled');$('netInd').classList.add('dead');clearInterval(pingInt);
    if($('sChat').classList.contains('active')){$('offlineBar').classList.add('show');$('hdrSub').textContent='重连中…';$('hdrSub').classList.remove('enc','typing');schedRecon();}
    else{$('connStatus').innerHTML='❌ 连接失败';$('btnJoin').disabled=false;}
  };
}

function schedRecon(){clearTimeout(reconT);if(reconN>=15){$('offlineBar').textContent='⚠ 请刷新页面';return;}const d=Math.min(1000*Math.pow(1.5,reconN),30000);reconN++;reconT=setTimeout(()=>{if(!ws||ws.readyState!==WebSocket.OPEN)connectWS();},d);}

function exitRoom(){
  if(inCall)hangupCall();stopRing();stopDial();closePM();closeSearch();closeQR();
  clearTimeout(reconT);clearInterval(pingInt);
  if($('togAutoClear').classList.contains('on')){clearAllMsgs();msgEls.forEach(e=>{if(e.timer)clearTimeout(e.timer);});msgEls.clear();}
  blobCache.forEach(u=>URL.revokeObjectURL(u));blobCache.clear();
  if(ws){ws.onclose=null;ws.close();ws=null;}
  members={};myId='';pendingFile=null;replyTo=null;db=null;seenNonces.clear();
  pmTarget=null;pmHist.clear();schedMins=0;
  $('msgBox').innerHTML='<div class="sys-msg">🔒 AES-256 端对端加密已启用</div>';
  $('btnSend').classList.add('disabled');$('schedBar').style.display='none';
  clearPrev();clearReply();$('attachPanel').classList.remove('show');$('emojiPanel').classList.remove('show');
  $('offlineBar').classList.remove('show');$('callBar').classList.remove('show');
  $('btnJoin').disabled=false;$('connStatus').textContent='';
  document.querySelectorAll('.screen').forEach(e=>e.classList.remove('active'));
  $('sLogin').classList.add('active');
}

/* ─── Members ─── */
function updateCnt(){$('onlineCnt').textContent=Object.keys(members).length+1;}

function openSheet(which){
  if(which==='members'){
    const list=$('memberList');list.innerHTML='';
    const me=document.createElement('div');me.className='m-me';
    me.innerHTML=`<div class="m-av online">🎤</div><div class="m-info"><div class="m-name">${esc(myNick)}</div><div class="m-status">🟢 你自己</div></div>`;
    list.appendChild(me);
    Object.entries(members).forEach(([sid,nick])=>{
      const d=document.createElement('div');d.className='member-item';
      d.innerHTML=`<div class="m-av online">👤</div><div class="m-info"><div class="m-name">${esc(nick)}</div><div class="m-status">🟢 在线</div></div><div class="m-acts">
        <div class="m-act pm" onclick="openPM('${sid}','${esc(nick)}');closeSheet()">💬 私聊</div>
        <div class="m-act call" onclick="openPM('${sid}','${esc(nick)}');closeSheet();setTimeout(()=>initPrivateCall('audio'),300)" title="私密语音">📞私</div>
        <div class="m-act call" onclick="openPM('${sid}','${esc(nick)}');closeSheet();setTimeout(()=>initPrivateCall('video'),300)" title="私密视频">📹私</div>
      </div>`;
      list.appendChild(d);
    });
    $('sheetMembers').classList.add('show');
  } else {
    $('sheetSettings').classList.add('show');
  }
  $('sheetOv').classList.add('show');
  $('attachPanel').classList.remove('show');$('emojiPanel').classList.remove('show');
}
function closeSheet(){$('sheetOv').classList.remove('show');$('sheetSettings').classList.remove('show');$('sheetMembers').classList.remove('show');}

function handleTyping(sid,active){const nm=members[sid]||'对方';if(active){$('hdrSub').textContent=nm+' 正在输入…';$('hdrSub').classList.add('typing');$('hdrSub').classList.remove('enc');}else{$('hdrSub').textContent='🔐 已加密';$('hdrSub').classList.remove('typing');$('hdrSub').classList.add('enc');}}

/* ─── Settings ─── */
document.querySelectorAll('#segAD button').forEach(b=>{b.onclick=()=>{document.querySelectorAll('#segAD button').forEach(x=>x.classList.remove('on'));b.classList.add('on');};});
function saveSettings(){const v=+document.querySelector('#segAD button.on').dataset.v;autoDelete=v;if(v>0){$('adBar').classList.add('show');$('adBarText').textContent=v<60?v+'秒':(v/60)+'分钟';}else $('adBar').classList.remove('show');closeSheet();showToast('✅ 已保存');}
function toggleNoCopy(){const t=$('togNoCopy');t.classList.toggle('on');$('msgBox').classList.toggle('no-copy',t.classList.contains('on'));}
async function doClearLocal(){await clearAllMsgs();$('msgBox').innerHTML='<div class="sys-msg">🔒 AES-256 端对端加密已启用</div>';msgEls.forEach(e=>{if(e.timer)clearTimeout(e.timer);});msgEls.clear();}
async function confirmClearLocal(){closeSheet();if(!confirm('⚠️ 确定清空？'))return;await doClearLocal();showToast('🗑 已清空');}
function confirmClearRemote(){closeSheet();if(!confirm('📡 确定远程擦除？'))return;if(!ws||ws.readyState!==WebSocket.OPEN)return showToast('❌ 未连接');ws.send(encrypt({type:'remote_clear',nick:myNick}));showToast('📡 已发送');}
async function confirmClearBoth(){closeSheet();if(!confirm('💣 确定双方清除？'))return;await doClearLocal();if(ws&&ws.readyState===WebSocket.OPEN)ws.send(encrypt({type:'remote_clear',nick:myNick}));showToast('💣 已清除');}
async function remoteClear(nick){await doClearLocal();sysMsg(`🗑 ${nick} 清除了聊天记录`);}

/* ─── Send ─── */
$('iMsg').addEventListener('input',()=>{
  if(!ws||ws.readyState!==WebSocket.OPEN)return;
  if(!isTyping){isTyping=true;ws.send(encrypt({type:'typing',active:true}));}
  clearTimeout(typingT);typingT=setTimeout(()=>{isTyping=false;ws.send(encrypt({type:'typing',active:false}));},2000);
  $('btnSend').classList.toggle('disabled',!$('iMsg').value.trim()&&!pendingFile);
});
$('iMsg').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});

function sendMsg(){
  if(!ws||ws.readyState!==WebSocket.OPEN){showToast('❌ 未连接');return;}
  const text=$('iMsg').value.trim();if(!text&&!pendingFile)return;
  const file=pendingFile;
  $('iMsg').value='';clearPrev();clearReply();$('attachPanel').classList.remove('show');$('emojiPanel').classList.remove('show');
  $('btnSend').classList.add('disabled');$('iMsg').focus();
  clearTimeout(typingT);if(isTyping){isTyping=false;ws.send(encrypt({type:'typing',active:false}));}
  if(schedMins>0){
    const m=schedMins;
    setTimeout(()=>{if(ws&&ws.readyState===WebSocket.OPEN)sendPayload({text,file});else showToast('❌ 定时发送失败');},m*60*1000);
    cancelSched();showToast(`⏱ ${m}分钟后发送`);
  } else {
    sendPayload({text,file});
  }
}

function sendPayload({text,file}){
  // ★ 如果开启了一次性阅读模式，标记消息
  const once = onceReadMode;
  const msg={type:'chat',id:uid(),nick:myNick,text,file,ad:autoDelete,once,ts:Date.now(),
    replyTo:replyTo?{id:replyTo.id,nick:replyTo.nick,text:replyTo.text}:null};
  ws.send(encrypt(msg));
  renderMsg(msg,true);saveMsg({...msg,_isMe:true});
}

function setReply(id,nick,text){replyTo={id,nick,text};$('replyBar').classList.add('show');$('rbName').textContent='回复 '+nick;$('rbText').textContent=text||'[媒体]';$('iMsg').focus();}
function clearReply(){replyTo=null;$('replyBar').classList.remove('show');}
function updRcpt(id,status){const e=msgEls.get(id);if(!e||!e.rcpt)return;e.rcpt.textContent='✓✓';e.rcpt.style.color=status==='read'?'var(--blue)':'#555';}

/* ─── PM ─── */
function openPM(tid,tnick){pmTarget=tid;pmNick=tnick;$('pmTitle').textContent=`💬 ${tnick}`;const box=$('pmMsgs');box.innerHTML='';(pmHist.get(tid)||[]).forEach(m=>renderPMRow(m));$('pmPanel').classList.add('show');setTimeout(()=>$('pmInput').focus(),300);}
function closePM(){$('pmPanel').classList.remove('show');pmTarget=null;}
function sendPM(){
  if(!pmTarget||!ws||ws.readyState!==WebSocket.OPEN)return;
  const text=$('pmInput').value.trim();if(!text)return;
  const msg={type:'chat',id:uid(),nick:myNick,text,privateTo:pmTarget,ts:Date.now()};
  ws.send(encrypt(msg));
  const m={me:true,nick:myNick,text,ts:msg.ts};
  if(!pmHist.has(pmTarget))pmHist.set(pmTarget,[]);pmHist.get(pmTarget).push(m);renderPMRow(m);
  $('pmInput').value='';
  const tag=document.createElement('div');tag.className='sys-msg';tag.style.color='var(--purple)';tag.textContent=`💬 你向 ${pmNick} 发了私信`;$('msgBox').appendChild(tag);$('msgBox').scrollTop=$('msgBox').scrollHeight;
}
function recvPM(fromId,msg){
  const nick=members[fromId]||'对方';const m={me:false,nick,text:msg.text,ts:msg.ts||Date.now()};
  if(!pmHist.has(fromId))pmHist.set(fromId,[]);pmHist.get(fromId).push(m);
  if(pmTarget===fromId){renderPMRow(m);}
  else{const tag=document.createElement('div');tag.className='sys-msg';tag.style.cssText='color:var(--purple);cursor:pointer';tag.textContent=`💬 ${nick} 给你发了私信`;tag.onclick=()=>openPM(fromId,nick);$('msgBox').appendChild(tag);$('msgBox').scrollTop=$('msgBox').scrollHeight;showToast(`💬 ${nick}：${msg.text.slice(0,20)}`);}
}
function renderPMRow(m){const box=$('pmMsgs');const row=document.createElement('div');row.className='pm-row '+(m.me?'me':'other');row.innerHTML=`${!m.me?`<div class="pm-nm">${esc(m.nick)}</div>`:''}<div class="pm-bubble">${esc(m.text).replace(/\n/g,'<br>')}</div><div class="pm-t">${fmtT(m.ts)}</div>`;box.appendChild(row);box.scrollTop=box.scrollHeight;}
$('pmInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendPM();}});

/* ─── Render Message ─── */
function renderMsg(msg,isMe,fromHistory=false){
  const row=document.createElement('div');row.className=`msg-row ${isMe?'me':'other'}`;row.id='msg-'+msg.id;
  const aId='act-'+msg.id;
  const sid=Object.entries(members).find(([k,v])=>v===msg.nick)?.[0]||'';

  // ★ 一次性阅读渲染：接收方看到模糊，自己看到正常
  const showOnce = msg.once && !isMe && !fromHistory;

  let inner='',media=null;
  if(showOnce){
    inner=`<div class="once-hint">👁 点击查看 · 仅可阅读一次</div><div class="once-blur" onclick="revealOnce(this,'${esc(msg.text||'')}',this.closest('.msg-row'))">${msg.text?'••••••••':'[媒体消息]'}</div>`;
  } else {
    if(msg.text)inner+=`<div>${esc(msg.text).replace(/\n/g,'<br>')}</div>`;
    if(msg.file){
      const f=msg.file;
      if(f.isVoice||f.type?.startsWith('audio/'))media=makeVoicePlayer(f,isMe,msg.id);
      else if(f.type?.startsWith('video/'))media=makeVideoPlayer(f,msg.id);
      else if(f.type?.startsWith('image/'))inner+=`<img src="${f.data}" onclick="openLB(this.src)" loading="lazy">`;
      else inner+=`<div class="mfile" onclick="dlData('${esc(f.name)}','${f.data}')"><div class="fi">📎</div><div class="fd"><div class="fn">${esc(f.name)}</div><div class="fs">${fmtS(f.size)}</div></div></div>`;
    }
    // ★ 发送方自己看到的一次性标记
    if(msg.once&&isMe) inner=`<div class="once-hint">👁 一次性消息</div>`+inner;
  }

  const actHtml=`<div class="msg-actions" id="${aId}">
    <div class="mab" onclick="setReply('${msg.id}','${esc(msg.nick)}','${esc((msg.text||'').slice(0,40))}');hideAct('${aId}')">↩ 回复</div>
    ${sid?`<div class="mab pm" onclick="openPM('${sid}','${esc(msg.nick)}');hideAct('${aId}')">💬 私聊</div>`:''}
    ${isMe?`<div class="mab danger" onclick="requestRecall('${msg.id}');hideAct('${aId}')">撤回</div>`:''}
    <div class="mab danger" onclick="delForBoth('${msg.id}');hideAct('${aId}')">🗑 双方删</div>
    <div class="mab" onclick="showReactionPicker('${msg.id}',this);hideAct('${aId}')">😊 回应</div>
  </div>`;

  const replyHtml=msg.replyTo?`<div class="reply-prev"><strong>${esc(msg.replyTo.nick)}</strong>: ${esc(msg.replyTo.text||'[媒体]')}</div>`:'';
  const namePart=!isMe?`<div class="msg-name" onclick="openPMFromMsg(this)" data-sid="${esc(sid)}" data-nick="${esc(msg.nick)}">${esc(msg.nick)}</div>`:'';
  const adTag=msg.ad>0?`<span style="color:var(--orange);margin-left:4px">🔥${msg.ad}s</span>`:'';
  const rcptId='rc-'+msg.id;
  const rcptHtml=isMe?`<span class="msg-rcpt" id="${rcptId}" style="color:#555">✓</span>`:'';

  row.innerHTML=`${actHtml}${namePart}<div class="msg-bubble" id="bub-${msg.id}">${replyHtml}<div class="mbi">${inner}</div>${msg.ad>0?`<div class="ad-countdown" style="animation-duration:${msg.ad}s"></div>`:''}</div><div class="msg-meta"><span class="msg-time">${fmtT(msg.ts||Date.now())}${adTag}</span>${rcptHtml}</div>`;

  if(media){const mbi=row.querySelector('.mbi');mbi.innerHTML='';mbi.appendChild(media);}

  let lpT;
  row.addEventListener('contextmenu',e=>{e.preventDefault();showAct(aId);});
  row.addEventListener('touchstart',()=>{lpT=setTimeout(()=>showAct(aId),500);},{passive:true});
  row.addEventListener('touchend',()=>clearTimeout(lpT));
  row.addEventListener('touchmove',()=>clearTimeout(lpT));

  $('msgBox').appendChild(row);
  if(!fromHistory)$('msgBox').scrollTop=$('msgBox').scrollHeight;

  const entry={el:row,timer:null,rcpt:isMe?$(rcptId):null,id:msg.id};msgEls.set(msg.id,entry);
  if(msg.ad>0&&!fromHistory){
    entry.timer=setTimeout(()=>{row.style.opacity='0';row.style.transform='translateY(-8px)';row.style.transition='all .4s';setTimeout(()=>{row.remove();msgEls.delete(msg.id);freeBlob(msg.id+'_v');freeBlob(msg.id+'_a');deleteMsg(msg.id);},400);},msg.ad*1000);
  }
}

/* ★ 一次性阅读：点击后显示，然后开始销毁倒计时 */
function revealOnce(el, text, row) {
  if (el.classList.contains('revealed')) return;
  el.textContent = text || '[媒体消息]';
  el.classList.add('revealed');
  el.onclick = null;
  // 10秒后自动消失
  setTimeout(() => {
    if (row) {
      row.style.opacity = '0';
      row.style.transform = 'translateY(-8px)';
      row.style.transition = 'all .5s';
      setTimeout(() => row.remove(), 500);
    }
  }, 10000);
  showToast('👁 消息已显示，将在10秒后销毁');
}

function openPMFromMsg(el){const sid=el.dataset.sid,nick=el.dataset.nick;if(!sid){showToast('无法获取用户');return;}openPM(sid,nick);}
function showAct(id){document.querySelectorAll('.msg-actions.show').forEach(e=>e.classList.remove('show'));$(id)&&$(id).classList.add('show');setTimeout(()=>$(id)&&$(id).classList.remove('show'),4000);}
function hideAct(id){$(id)&&$(id).classList.remove('show');}
function sysMsg(t){const d=document.createElement('div');d.className='sys-msg';d.textContent=t;$('msgBox').appendChild(d);$('msgBox').scrollTop=$('msgBox').scrollHeight;}
function requestRecall(id){ws.send(encrypt({type:'recall',msgId:id}));doRecall(id);deleteMsg(id);}
function doRecall(id){const e=msgEls.get(id);if(!e)return;if(e.timer)clearTimeout(e.timer);e.el.classList.add('msg-recalled');setTimeout(()=>{e.el.remove();msgEls.delete(id);},300);}
function delForBoth(id){if(!ws||ws.readyState!==WebSocket.OPEN)return;ws.send(encrypt({type:'remote_delete',msgId:id}));doDeleteMsg(id);}
function doDeleteMsg(id){const e=msgEls.get(id);if(!e)return;if(e.timer)clearTimeout(e.timer);freeBlob(id);e.el.classList.add('msg-recalled');setTimeout(()=>{e.el.remove();msgEls.delete(id);},300);deleteMsg(id);}

/* ─── Voice Recorder ─── */
function toggleVoiceMode(){isVoice=!isVoice;$('voiceToggle').textContent=isVoice?'⌨️':'🎤';$('iMsg').style.display=isVoice?'none':'';$('holdBtn').style.display=isVoice?'block':'none';}
let mRec,chunks=[],isRec=false,cancelRec=false,startY=0,recInt=null,recSec=0;
const hbtn=$('holdBtn');
const getPY=e=>e.touches?e.touches[0].clientY:e.clientY;
function onPD(e){if(e.type==='mousedown'&&e.button!==0)return;if(!ws||ws.readyState!==WebSocket.OPEN)return showToast('未连接');e.preventDefault();startY=getPY(e);hbtn.classList.add('active');startRec();}
function onPM(e){if(!isRec)return;e.preventDefault();if(startY-getPY(e)>60){cancelRec=true;$('recUI').classList.add('cancel');$('recTip').textContent='松开取消';}else{cancelRec=false;$('recUI').classList.remove('cancel');$('recTip').textContent='上滑取消';}}
function onPU(e){if(!isRec)return;e.preventDefault();hbtn.classList.remove('active');stopRec();}
hbtn.addEventListener('touchstart',onPD,{passive:false});hbtn.addEventListener('touchmove',onPM,{passive:false});
hbtn.addEventListener('touchend',onPU);hbtn.addEventListener('touchcancel',onPU);
hbtn.addEventListener('mousedown',onPD);document.addEventListener('mousemove',onPM);document.addEventListener('mouseup',onPU);

function bestMime(){for(const m of['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm','audio/mp4'])if(MediaRecorder.isTypeSupported(m))return m;return '';}

async function startRec(){
  try{
    const rawStream=await navigator.mediaDevices.getUserMedia({audio:true});
    // ★ 应用变声效果
    const stream = applyVoiceEffect(rawStream, currentEffect);
    const mime=bestMime();
    mRec=new MediaRecorder(stream,mime?{mimeType:mime}:{});
    const am=mRec.mimeType||'audio/webm';
    chunks=[];
    mRec.ondataavailable=e=>{if(e.data.size>0)chunks.push(e.data);};
    mRec.onstop=()=>{
      rawStream.getTracks().forEach(t=>t.stop());
      stream.getTracks().forEach(t=>t.stop());
      clearInterval(recInt);$('recUI').classList.remove('show');
      if(!cancelRec&&chunks.length>0&&recSec>=1){
        const ext=am.includes('ogg')?'ogg':am.includes('mp4')?'m4a':'webm';
        const f=new File(chunks,`voice.${ext}`,{type:am});
        readData(f).then(data=>sendPayload({text:'',file:{name:f.name,type:am,size:f.size,data,isVoice:true,durationHint:recSec,effect:currentEffect}}));
      }else if(recSec<1&&!cancelRec)showToast('录音太短');
      isRec=false;
    };
    mRec.start();isRec=true;cancelRec=false;recSec=0;
    const ef=EFFECTS[currentEffect]||EFFECTS.none;
    $('recIcon').textContent=ef.icon;
    $('recEffectLabel').textContent=currentEffect!=='none'?ef.name:'';
    $('recDur').textContent='0:00';$('recUI').classList.add('show');$('recUI').classList.remove('cancel');
    recInt=setInterval(()=>{recSec++;$('recDur').textContent=Math.floor(recSec/60)+':'+fmt2(recSec%60);},1000);
  }catch(e){showToast('无法访问麦克风');hbtn.classList.remove('active');}
}
function stopRec(){if(isRec&&mRec)mRec.stop();}

/* ─── Attachments ─── */
function toggleAttach(){$('attachPanel').classList.toggle('show');$('emojiPanel').classList.remove('show');}
function pickFile(accept){$('attachPanel').classList.remove('show');$('fileIn').accept=accept;$('fileIn').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;if(f.size>MAX_FILE)return showToast(`⚠️ 超过${fmtS(MAX_FILE)}`);pendingFile={name:f.name,type:f.type,size:f.size,data:await readData(f)};showPrev();$('btnSend').classList.remove('disabled');};$('fileIn').click();}
function readData(f){return new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(f);});}
function showPrev(){if(!pendingFile)return;const pb=$('prevBar');pb.classList.add('show');let th=`<div style="width:40px;height:40px;background:var(--bgm);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:20px">📎</div>`;if(pendingFile.type.startsWith('image/'))th=`<img src="${pendingFile.data}">`;else if(pendingFile.type.startsWith('video/'))th=`<video src="${pendingFile.data}"></video>`;pb.innerHTML=`${th}<div class="pi">${esc(pendingFile.name)}<br><span style="color:#555;font-size:10px">${fmtS(pendingFile.size)}</span></div><div class="px" onclick="clearPrev()">✕</div>`;}
function clearPrev(){pendingFile=null;$('prevBar').classList.remove('show');if(!$('iMsg').value.trim())$('btnSend').classList.add('disabled');}

/* ─── Voice Player ─── */
let audCtx=null;function getACtx(){if(!audCtx||audCtx.state==='closed')audCtx=new(window.AudioContext||window.webkitAudioContext)();if(audCtx.state==='suspended')audCtx.resume();return audCtx;}
let curAud=null;
function makeVoicePlayer(f,isMe,msgId){
  const pid='vp'+uid();const BARS=22;
  const seed=f.name.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const hs=Array.from({length:BARS},(_,i)=>Math.max(6,Math.min(26,Math.round(Math.abs(Math.sin((i+seed)*1.7)*18+Math.cos((i+seed)*.9)*10)))));
  const dur=f.durationHint||0;
  const w=document.createElement('div');w.className='voice-msg';
  // Show effect icon if recorded with effect
  const efLabel = f.effect && f.effect!=='none' ? ` <span style="font-size:11px">${(EFFECTS[f.effect]||EFFECTS.none).icon}</span>` : '';
  w.innerHTML=`<div class="vplay" id="${pid}b">▶</div><div class="vwav">${hs.map((h,i)=>`<div class="vb" id="${pid}w${i}" style="height:${h}px"></div>`).join('')}</div><div class="vdur" id="${pid}d">${dur>0?dur+"''":''}</div>${efLabel}`;
  let aud=null,raf=null,play=false;
  const getB=()=>w.querySelector('#'+pid+'b'),getD=()=>w.querySelector('#'+pid+'d'),getW=i=>w.querySelector('#'+pid+'w'+i);
  const rst=()=>{for(let i=0;i<BARS;i++){const b=getW(i);if(b)b.classList.remove('lit');}};
  function anim(a){cancelAnimationFrame(raf);function step(){if(!a||a.paused||a.ended){rst();return;}const p=a.duration>0?a.currentTime/a.duration:0;const l=Math.floor(p*BARS);for(let i=0;i<BARS;i++){const b=getW(i);if(b)b.classList.toggle('lit',i<=l);}if(a.duration>0)getD().textContent=Math.ceil(a.duration-a.currentTime)+"''";raf=requestAnimationFrame(step);}raf=requestAnimationFrame(step);}
  function build(){const u=getBlobURL(f.data,msgId+'_a');const a=new Audio();a.preload='metadata';a.src=u;a.onloadedmetadata=()=>{if(a.duration&&isFinite(a.duration))getD().textContent=Math.ceil(a.duration)+"''";};a.onended=()=>{play=false;getB().textContent='▶';rst();cancelAnimationFrame(raf);if(getD()&&a.duration)getD().textContent=Math.ceil(a.duration)+"''";};return a;}
  w.querySelector('#'+pid+'b').addEventListener('click',async()=>{try{getACtx();}catch(e){}if(!aud)aud=build();if(play){aud.pause();play=false;getB().textContent='▶';cancelAnimationFrame(raf);}else{if(curAud&&curAud!==aud&&!curAud.paused){curAud.pause();curAud.currentTime=0;}curAud=aud;try{await aud.play();play=true;getB().textContent='⏸';anim(aud);}catch(e){aud=build();curAud=aud;try{await aud.play();play=true;getB().textContent='⏸';anim(aud);}catch(e2){showToast('无法播放');}}}});
  return w;
}

/* ─── Video Player ─── */
function makeVideoPlayer(f,msgId){const c=document.createElement('div');c.className='video-box';c.innerHTML='<div class="video-loading"></div>';setTimeout(()=>{try{const u=getBlobURL(f.data,msgId+'_v');const v=document.createElement('video');v.controls=true;v.playsinline=true;v.preload='metadata';v.style.cssText='max-width:100%;max-height:260px;border-radius:8px;display:block;background:#000';let ok=false;v.onloadeddata=()=>{ok=true;c.innerHTML='';c.appendChild(v);let lt;v.addEventListener('touchstart',()=>{lt=setTimeout(()=>openLBVideo(u),600);},{passive:true});v.addEventListener('touchend',()=>clearTimeout(lt));v.addEventListener('touchmove',()=>clearTimeout(lt));};v.onerror=()=>{if(ok)return;c.innerHTML=`<div class="video-err"><div style="font-size:30px">📹</div><div style="font-size:12px;opacity:.7">视频加载失败</div><div class="video-err-dl" id="vdl${msgId}">📥 下载</div></div>`;c.querySelector('#vdl'+msgId)?.addEventListener('click',()=>dlData(f.name,f.data));};v.src=u;setTimeout(()=>{if(!ok&&c.querySelector('.video-loading')){c.innerHTML=`<div class="video-err"><div style="font-size:30px">⏳</div><div style="font-size:12px;opacity:.7">加载超时</div><div class="video-err-dl" id="vt${msgId}">📥 下载</div></div>`;c.querySelector('#vt'+msgId)?.addEventListener('click',()=>dlData(f.name,f.data));}},8000);}catch(e){c.innerHTML=`<div class="video-err"><div style="font-size:30px">❌</div><div style="font-size:12px;opacity:.7">无法播放</div></div>`;}},50);return c;}

/* ─── Lightbox ─── */
let lbType='img',lbData=null;
function openLB(src){$('lbImg').src=src;$('lbImg').style.display='block';$('lbVid').style.display='none';lbType='img';lbData=src;$('lb').classList.add('show');}
function openLBVideo(src){$('lbVid').src=src;$('lbVid').style.display='block';$('lbImg').style.display='none';lbType='vid';lbData=src;$('lb').classList.add('show');$('lbVid').play().catch(()=>{});}
function closeLB(){$('lb').classList.remove('show');if($('lbVid')){$('lbVid').pause();$('lbVid').src='';}}
function downloadLB(){if(lbType==='img')dlData('img_'+Date.now()+'.jpg',lbData);else if(lbData)dlData('vid_'+Date.now()+'.mp4',lbData);}
function dlData(name,data){try{const a=document.createElement('a');a.href=data;a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>a.remove(),100);}catch(e){showToast('请长按手动保存');}}

/* ─── Call ─── */
function onIncoming(name,type,sid,isPrivate){
  if(inCall){ws.send(encrypt({type:'call_decline',nick:myNick}));return;}
  pendingCall={type,sid,isPrivate};
  $('incomingName').textContent=name;
  $('incomingType').textContent=(isPrivate?'🔒 私密':'')+(type==='video'?'📹 视频通话':'📞 语音通话');
  $('incomingOverlay').classList.add('show');startRing();
  sendNotif('📞 来电',name+' 发起了'+(isPrivate?'私密':'')+(type==='video'?'视频':'语音')+'通话');
  pendingCall._t=setTimeout(()=>{dismissCall();sysMsg('📞 来电超时');},30000);
}
$('incAccept').addEventListener('click',async()=>{
  if(!pendingCall)return;clearTimeout(pendingCall._t);
  $('incomingOverlay').classList.remove('show');stopRing();
  try{
    isPrivateCall=pendingCall.isPrivate||false;
    await startCallUI(pendingCall.type);$('callWaiting').style.display='none';
    ws.send(encrypt({type:'call_accept',nick:myNick,callType:pendingCall.type}));
  }catch(e){showToast('接听失败');}
  pendingCall=null;
});
$('incReject').addEventListener('click',()=>{if(!pendingCall)return;clearTimeout(pendingCall._t);ws.send(encrypt({type:'call_decline',nick:myNick}));dismissCall();sysMsg('📞 已拒绝');});
function dismissCall(){$('incomingOverlay').classList.remove('show');stopRing();pendingCall=null;}

function minimizeCall(){callMini=true;$('sCall').classList.add('mini');if(callType==='audio')$('sCall').classList.add('amini');$('callBar').classList.add('show');updateBarTimer();}
function maximizeCall(){callMini=false;$('sCall').classList.remove('mini','amini');$('callBar').classList.remove('show');}
function updateBarTimer(){if(!inCall)return;if(callStart>0){const d=Math.floor((Date.now()-callStart)/1000);const t=fmt2(Math.floor(d/60))+':'+fmt2(d%60);$('callBarText').textContent=`📞 通话中 ${t}`;$('miniTimer').textContent=t;}if(callMini&&inCall)requestAnimationFrame(updateBarTimer);}
$('sCall').addEventListener('click',function(e){if(callMini&&!e.target.closest('.call-ctrl'))maximizeCall();});

/* ★ 群通话 */
async function initCall(type){
  $('attachPanel').classList.remove('show');
  if(!ws||ws.readyState!==WebSocket.OPEN)return showToast('未连接');
  if(!Object.keys(members).length)return showToast('房间只有你');
  isPrivateCall=false;
  ws.send(encrypt({type:'call_invite',nick:myNick,callType:type})); // 广播给所有人
  const row=document.createElement('div');row.className='msg-row me';
  row.innerHTML=`<div class="msg-bubble" style="background:var(--bgm);color:var(--text);border:1px solid var(--border)">发起了 ${type==='video'?'📹 群视频':'📞 群语音'}通话</div>`;
  $('msgBox').appendChild(row);$('msgBox').scrollTop=$('msgBox').scrollHeight;
  await startCallUI(type);$('callWaiting').style.display='flex';$('waitText').textContent='等待接听…';startDial();
}

/* ★ 私密通话 —— 仅发给 pmTarget，群内完全不知道 */
async function initPrivateCall(type){
  if(!pmTarget){showToast('请先打开私聊面板');return;}
  if(!ws||ws.readyState!==WebSocket.OPEN)return showToast('未连接');
  isPrivateCall=true;
  // ★ 关键：privateTo 字段，只有目标用户会处理，其他人会忽略
  ws.send(encrypt({type:'call_invite',nick:myNick,callType:type,privateTo:pmTarget}));
  // PM 面板里显示提示，群聊中不显示
  const tag=document.createElement('div');tag.className='pm-row me';
  tag.innerHTML=`<div class="pm-bubble" style="opacity:.7">发起了${type==='video'?'📹视频':'📞语音'}通话…</div>`;
  $('pmMsgs').appendChild(tag);$('pmMsgs').scrollTop=$('pmMsgs').scrollHeight;
  await startCallUI(type);
  $('callWaiting').style.display='flex';$('waitText').textContent='等待 '+pmNick+' 接听…';
  $('callPrivateTag').textContent='🔒 私密通话';
  startDial();
}

function onCallAccept(sid,type){if(!inCall)return;$('callWaiting').style.display='none';stopDial();if(localStream)setTimeout(()=>makeOffer(sid),300);else{const w=setInterval(()=>{if(localStream){clearInterval(w);makeOffer(sid);}},200);setTimeout(()=>clearInterval(w),10000);}}
function onCallDecline(sid){showToast(`${members[sid]||'对方'} 拒绝了通话`);stopDial();if(!Object.keys(pcs).length)hangupCall();}

async function startCallUI(type){
  inCall=true;callType=type;pcs={};remoteStreams.clear();iceRC={};iceTO={};
  $('sCall').classList.add('active');$('sCall').classList.remove('mini','amini');
  callMini=false;$('callBar').classList.remove('show');
  $('remoteVids').innerHTML='';setVG(0);
  $('callTimer').textContent='00:00';clearInterval(callT);callStart=0;
  $('pipLbl').textContent=myNick;$('callCnt').textContent='';$('callQuality').textContent='';$('callState').textContent='';
  $('callWaiting').style.display='none';
  $('callPrivateTag').textContent='加密通话';
  if(type==='audio'){$('localPip').classList.add('ao');$('localPip').querySelector('video').style.display='none';$('ccCam').style.opacity='.3';$('ccCam').style.pointerEvents='none';$('audioBg').style.display='flex';$('remoteVids').style.display='none';updateAudioUI();}
  else{$('localPip').classList.remove('ao');$('localPip').querySelector('video').style.display='block';$('ccCam').style.opacity='1';$('ccCam').style.pointerEvents='auto';$('audioBg').style.display='none';$('remoteVids').style.display='';}
  try{localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:type==='video'?{facingMode:'user',width:{ideal:640},height:{ideal:480}}:false});if(type==='video')$('localVid').srcObject=localStream;}catch(e){showToast('无法获取摄像头/麦克风');hangupCall();throw e;}
}

function getPC(tid){
  if(pcs[tid])return pcs[tid];const pc=new RTCPeerConnection(RTC_CFG);pcs[tid]=pc;iceRC[tid]=0;
  if(localStream)localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.onicecandidate=e=>{if(e.candidate&&ws&&ws.readyState===WebSocket.OPEN)ws.send(encrypt({type:'webrtc',signal:{type:'ice',candidate:e.candidate},target:tid}));};
  pc.ontrack=e=>{if(!e.streams||!e.streams.length)return;const s=e.streams[0];if(remoteStreams.has(tid)&&remoteStreams.get(tid)===s.id)return;remoteStreams.set(tid,s.id);addVideo(tid,s);stopDial();if(!callStart){callStart=Date.now();callT=setInterval(()=>{const d=Math.floor((Date.now()-callStart)/1000);$('callTimer').textContent=fmt2(Math.floor(d/60))+':'+fmt2(d%60);},1000);startQuality();}};
  pc.oniceconnectionstatechange=()=>{const s=pc.iceConnectionState;if(s==='checking')$('callState').textContent='连接中…';else if(s==='connected'||s==='completed'){$('callState').textContent='';clearTimeout(iceTO[tid]);}else if(s==='disconnected'){$('callState').textContent='不稳定…';clearTimeout(iceTO[tid]);iceTO[tid]=setTimeout(()=>{if(pc.iceConnectionState==='disconnected')iceRestart(tid,pc);},3000);}else if(s==='failed'){iceRestart(tid,pc);}else if(s==='closed'){rmVideo(tid);remoteStreams.delete(tid);delete pcs[tid];checkCallEnd();}};
  iceTO[tid]=setTimeout(()=>{if(pc.iceConnectionState!=='connected'&&pc.iceConnectionState!=='completed')iceRestart(tid,pc);},ICE_TO);
  return pc;
}
async function iceRestart(tid,pc){const n=(iceRC[tid]||0)+1;iceRC[tid]=n;if(n>ICE_MAX){rmVideo(tid);remoteStreams.delete(tid);pc.close();delete pcs[tid];checkCallEnd();return;}$('callState').textContent=`重连(${n}/${ICE_MAX})…`;try{const o=await pc.createOffer({iceRestart:true});await pc.setLocalDescription(o);ws.send(encrypt({type:'webrtc',signal:{type:'offer',sdp:o},target:tid}));}catch(e){rmVideo(tid);remoteStreams.delete(tid);pc.close();delete pcs[tid];checkCallEnd();}}
function startQuality(){clearInterval(qualT);qualT=setInterval(async()=>{for(const[id,pc]of Object.entries(pcs)){try{const s=await pc.getStats();s.forEach(r=>{if(r.type==='candidate-pair'&&r.state==='succeeded'){const q=$('callQuality');const rtt=r.currentRoundTripTime;if(rtt<.1){q.textContent='良好';q.className='call-quality good';}else if(rtt<.3){q.textContent='一般';q.className='call-quality fair';}else{q.textContent='较差';q.className='call-quality poor';}}});}catch(e){}}},3000);}
async function handleRTC(sid,sig){if(!inCall)return;const pc=getPC(sid);try{if(sig.type==='offer'){if(pc.signalingState==='have-local-offer'){if(myId<sid)await pc.setLocalDescription({type:'rollback'});else return;}await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));const a=await pc.createAnswer();await pc.setLocalDescription(a);ws.send(encrypt({type:'webrtc',signal:{type:'answer',sdp:a},target:sid}));}else if(sig.type==='answer'){if(pc.signalingState==='have-local-offer')await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));}else if(sig.type==='ice'&&sig.candidate){try{await pc.addIceCandidate(new RTCIceCandidate(sig.candidate));}catch(e){}}}catch(e){console.warn('RTC:',e);}}
async function makeOffer(tid){if(!inCall||!localStream)return;const pc=getPC(tid);try{const o=await pc.createOffer();await pc.setLocalDescription(o);ws.send(encrypt({type:'webrtc',signal:{type:'offer',sdp:o},target:tid}));}catch(e){console.warn('offer:',e);}}
function addVideo(uid,stream){$('callWaiting').style.display='none';const nm=members[uid]||'用户';let w=$('vid-'+uid);if(!w){w=document.createElement('div');w.id='vid-'+uid;w.className='vw';if(callType==='video')w.innerHTML=`<video autoplay playsinline></video><div class="vname">${esc(nm)}</div>`;else{w.innerHTML=`<div class="no-vid">👤</div><div class="vname">${esc(nm)}</div>`;updateAudioUI();}$('remoteVids').appendChild(w);setVG($('remoteVids').children.length);}if(callType==='video'){const v=w.querySelector('video');if(v&&v.srcObject!==stream){v.srcObject=stream;v.play().catch(()=>{});}}let a=w.querySelector('audio');if(!a){a=document.createElement('audio');a.autoplay=true;a.style.display='none';w.appendChild(a);}if(a.srcObject!==stream){a.srcObject=stream;a.play().catch(()=>{});}$('callCnt').textContent=($('remoteVids').children.length+1)+'人';}
function rmVideo(uid){const w=$('vid-'+uid);if(!w)return;const a=w.querySelector('audio');if(a)a.srcObject=null;const v=w.querySelector('video');if(v)v.srcObject=null;w.remove();const n=$('remoteVids').children.length;setVG(n);$('callCnt').textContent=n>0?(n+1)+'人':'';}
function setVG(n){$('remoteVids').dataset.c=String(n);}
function updateAudioUI(){const p=$('audioParts');p.innerHTML='';const me=document.createElement('div');me.className='au';me.innerHTML=`<div class="au-av speaking"><div class="pulse-ring"></div>🎤</div><div class="au-name">${esc(myNick)}(我)</div>`;p.appendChild(me);Object.entries(members).forEach(([s,n])=>{const u=document.createElement('div');u.className='au';u.innerHTML=`<div class="au-av">👤</div><div class="au-name">${esc(n)}</div>`;p.appendChild(u);});}
function checkCallEnd(){if(!Object.keys(pcs).length&&inCall){sysMsg('📞 通话已结束');hangupCall();}}
function hangupCall(){inCall=false;callMini=false;isPrivateCall=false;stopDial();stopRing();dismissCall();clearInterval(callT);clearInterval(qualT);Object.values(iceTO).forEach(clearTimeout);iceTO={};$('sCall').classList.remove('active','mini','amini');$('callBar').classList.remove('show');$('callWaiting').style.display='none';if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null;}for(const id in pcs)try{pcs[id].close();}catch(e){}pcs={};remoteStreams.clear();iceRC={};$('remoteVids').innerHTML='';setVG(0);$('ccMic').classList.remove('off');$('ccCam').classList.remove('off');$('ccCam').style.opacity='1';$('ccCam').style.pointerEvents='auto';}
function toggleMic(){if(localStream?.getAudioTracks()[0]){const t=localStream.getAudioTracks()[0];t.enabled=!t.enabled;$('ccMic').classList.toggle('off',!t.enabled);}}
function toggleCam(){if(localStream?.getVideoTracks()[0]){const t=localStream.getVideoTracks()[0];t.enabled=!t.enabled;$('ccCam').classList.toggle('off',!t.enabled);}}
async function flipCamera(){if(!localStream||callType!=='video'||!localStream.getVideoTracks()[0])return;const vt=localStream.getVideoTracks()[0];const facing=vt.getSettings().facingMode;try{const ns=await navigator.mediaDevices.getUserMedia({video:{facingMode:facing==='user'?'environment':'user',width:{ideal:640},height:{ideal:480}}});const nvt=ns.getVideoTracks()[0];localStream.removeTrack(vt);vt.stop();localStream.addTrack(nvt);$('localVid').srcObject=localStream;for(const pc of Object.values(pcs)){const s=pc.getSenders().find(s=>s.track?.kind==='video');if(s)await s.replaceTrack(nvt);}showToast('📷 已切换');}catch(e){showToast('切换失败');}}

/* PiP drag */
(()=>{const p=$('localPip');let sx=0,sy=0,drag=false;function s(e){drag=true;const t=e.touches?e.touches[0]:e;sx=t.clientX-p.offsetLeft;sy=t.clientY-p.offsetTop;p.style.transition='none';}function m(e){if(!drag)return;e.preventDefault();const t=e.touches?e.touches[0]:e;let x=t.clientX-sx,y=t.clientY-sy;const par=p.parentElement;x=Math.max(0,Math.min(x,par.clientWidth-p.offsetWidth));y=Math.max(0,Math.min(y,par.clientHeight-p.offsetHeight));p.style.left=x+'px';p.style.top=y+'px';p.style.right='auto';}function en(){drag=false;p.style.transition='';}p.addEventListener('mousedown',s);document.addEventListener('mousemove',m);document.addEventListener('mouseup',en);p.addEventListener('touchstart',s,{passive:true});p.addEventListener('touchmove',m,{passive:false});p.addEventListener('touchend',en);})();

/* ─── PWA ─── */
function setupPWA(){const mf={name:'GeekChat',short_name:'GChat',start_url:location.href,display:'standalone',background_color:'#0a0a0a',theme_color:'#0a0a0a',icons:[{src:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%230f0f0f" rx="20"/><text y=".9em" font-size="80">🔐</text></svg>',sizes:'any',type:'image/svg+xml'}]};const l=document.createElement('link');l.rel='manifest';l.href=URL.createObjectURL(new Blob([JSON.stringify(mf)],{type:'application/json'}));document.head.appendChild(l);let dp=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();dp=e;$('pwaBanner').classList.add('show');});window.installPWA=async()=>{if(!dp)return;dp.prompt();dp=null;$('pwaBanner').classList.remove('show');};}

/* ─── Init ─── */
setupPWA();
buildEmoji();
loadKeyFromHash();
if(window.visualViewport){window.visualViewport.addEventListener('resize',()=>{$('app').style.height=window.visualViewport.height+'px';});}
