import {createPushManager} from './js/push.js';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr=esc;
const state={boot:null,view:'round',round:1,cycle:1,scope:'1',roundData:null,admin:null,teams:null,passwordTarget:null,sequence:0,busy:false,loginPlayers:[],editingPick:null,pushDiagnostics:null,adminPickPlayerId:null,adminPickRound:null,registration:null,liveRefreshing:false};
const formatTime=s=>s?new Intl.DateTimeFormat('hr-HR',{timeZone:'Europe/Zagreb',dateStyle:'short',timeStyle:'short'}).format(new Date(s*1000)):'Nije postavljen';
const score=f=>f.home_score===null||f.away_score===null?'vs':`${f.home_score} : ${f.away_score}`;
const empty=msg=>`<div class="empty">${esc(msg)}</div>`;
const clubKey=name=>String(name||'').trim().toLowerCase().replace(/&/g,'and').replace(/\./g,'').replace(/\s+/g,' ');
const CLUB_IDS={
 'arsenal':57,'manchester city':65,'manchester utd':66,'manchester united':66,'aston villa':58,'liverpool':64,
 'bournemouth':1044,'afc bournemouth':1044,'sunderland':71,'brighton':397,'brighton and hove albion':397,
 'brentford':402,'chelsea':61,'fulham':63,'newcastle':67,'newcastle united':67,'everton':62,'leeds':341,
 'leeds united':341,'crystal palace':354,'nottingham forest':351,'tottenham':73,'tottenham hotspur':73,
 'coventry':1076,'coventry city':1076,'ipswich':349,'ipswich town':349,'hull':322,'hull city':322,
 'west ham':563,'west ham united':563,'wolves':76,'wolverhampton wanderers':76,'burnley':328
};
function teamByName(name){const key=clubKey(name);return (state.boot?.teams||[]).find(t=>clubKey(t.name)===key)||(state.teams||[]).find(t=>clubKey(t.name)===key)||null;}
function teamById(id){return (state.boot?.teams||[]).find(t=>t.id===id)||(state.teams||[]).find(t=>t.id===id)||null;}
function clubBadgeUrl(name){const t=teamByName(name);const id=Number(t?.api_id||CLUB_IDS[clubKey(name)]||0);return id?`https://crests.football-data.org/${id}.png`:'';}
function clubBadge(name,extra=''){const url=clubBadgeUrl(name);return url?`<img class="club-badge ${extra}" src="${attr(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`:'';}
function teamColor(name){return teamByName(name)?.color||'#37003C';}
function teamPill(name){return `<span class="team-pill" style="background:${attr(teamColor(name))}">${clubBadge(name)}${esc(name)}</span>`;}
const hero=(title,sub,badge='')=>`<div class="hero"><div><span class="eyebrow">KO ZADNJI MAGARAC / ${state.boot?.season||2026}-${Number(state.boot?.season||2026)+1}</span><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>${badge?`<span class="hero-badge">${esc(badge)}</span>`:''}</div>`;

async function api(path,body){
 const start=performance.now(),options={credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(25000)};
 if(body!==undefined){options.method='POST';options.headers={'Content-Type':'application/json','X-KZM-Request':'1'};options.body=JSON.stringify(body);}
 let response;try{response=await fetch('/api'+path,options);}catch(e){throw new Error('Veza nije odgovorila. Prije ponovnog spremanja osvjezi podatke i provjeri je li promjena spremljena.');}
 const data=await response.json().catch(()=>({error:'Posluzitelj nije vratio ispravan odgovor.'}));
 if(!response.ok||data.ok===false){if(response.status===401&&path!=='/login')showLogin();throw new Error(data.error||'Zahtjev nije uspio.');}
 const latency=$('#latency');if(latency)latency.textContent=`Zadnji zahtjev: ${Math.round(performance.now()-start)} ms`;
 return data;
}
function toast(s){const t=$('#toast');t.textContent=s;t.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('visible'),3500);}
function renderRegistrationEntry(){
 const box=$('#registration-box'),button=$('#registration-open-button'),status=$('#registration-status'),form=$('#registration-form');if(!box||!button||!status)return;
 const r=state.registration;if(!r){box.hidden=true;return;}box.hidden=false;
 const occupied=Number(r.occupiedPlayers??r.activePlayers??0),pending=Number(r.pendingPlayers||0)+Number(r.approvedWaiting||0);
 status.textContent=r.full?`Limit mjesta je popunjen (${occupied}/${r.maxPlayers}).`:r.open?`Registracija je otvorena · ${r.activePlayers} aktivnih${pending?` · ${pending} zahtjeva čeka`:''}. Svaki zahtjev mora odobriti administrator, a novi igrač ulazi tek od sljedećeg kruga.`:`Registracija je trenutno zatvorena · ${r.activePlayers} aktivnih igrača.`;
 button.disabled=!r.open||r.full;button.textContent=r.full?'LIMIT MJESTA POPUNJEN':r.open?'POŠALJI ZAHTJEV ZA IGRU':'REGISTRACIJA ZATVORENA';
 if((!r.open||r.full)&&form)form.hidden=true;
}
async function loadLoginPlayers(){
 const select=$('#login-form').elements.name;if(!select)return;
 try{
  const d=await api('/login-players');state.loginPlayers=d.players||[];state.registration=d.registration||null;
  const saved=localStorage.getItem('kzm_novi_name')||'';
  select.innerHTML='<option value="">Odaberi igrača</option>'+state.loginPlayers.map(p=>`<option value="${attr(p.name)}">${esc(p.name)}</option>`).join('');
  if(saved&&state.loginPlayers.some(p=>p.name===saved))select.value=saved;renderRegistrationEntry();
 }catch(e){select.innerHTML='<option value="">Ne mogu učitati igrače</option>';state.registration=null;renderRegistrationEntry();}
}
function showLogin(){state.boot=null;$('#loading').hidden=true;$('#app').hidden=true;$('#login').hidden=false;$('#login-form').elements.password.value='';const rf=$('#registration-form');if(rf){rf.hidden=true;rf.reset();}const re=$('#registration-error');if(re)re.textContent='';loadLoginPlayers();}
function setMenu(open){$('#nav').classList.toggle('open',open);const v=$('#veil');v.hidden=!open;v.classList.toggle('open',open);}
function nav(){
 const roundNow=state.boot.currentRound;
 $('#cycles').innerHTML=state.boot.cycles.map(c=>`<button data-cycle="${c.id}" class="${state.cycle===c.id?'active':''}">${c.id}. krug<small>Kola ${c.from}-${c.to}</small></button>`).join('');
 $('#rounds').innerHTML=state.boot.rounds.filter(r=>r.cycle===state.cycle).map(r=>`<button title="${r.locked?'Zakljucano':'Otvoreno'}" data-round="${r.number}" class="${state.round===r.number?'active':''}"><span class="round-status ${r.number===roundNow?'current':r.locked?'closed':'open'}"></span><span>${r.number}</span></button>`).join('');
 document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));
 const admin=!!state.boot.user.admin;$('#admin-nav').hidden=!admin;$('#admin-section').hidden=!admin;
 const notices=[];
 if(state.boot.settings.picks_enabled!=='1')notices.push('SPREMANJE ODABIRA JE TRENUTNO ZAUSTAVLJENO');
 const paid=state.boot.payments.find(p=>p.cycle===state.cycle)?.paid;if(paid===0)notices.push('CLANARINA / UPLATA ZA OVAJ KRUG NIJE OZNACENA KAO PLACENA');
 const box=$('#safety-banner');box.textContent=notices.join('  |  ');box.hidden=!notices.length;
}
const pushManager=createPushManager({
 api,
 getPlayerId:()=>state.boot?.user?.id||null,
 getButton:()=>$('#push-nav'),
 toast
});
const initPushUser=()=>pushManager.initUser();
const togglePush=()=>pushManager.toggle();
const pushLogout=()=>pushManager.logout();
async function enter(){state.boot=await api('/bootstrap');state.round=state.boot.currentRound;state.cycle=state.boot.rounds.find(r=>r.number===state.round)?.cycle||1;state.scope=String(state.cycle);state.editingPick=null;$('#user-name').textContent=state.boot.user.name;$('#drawer-user').textContent=state.boot.user.name;$('#loading').hidden=true;$('#login').hidden=true;$('#app').hidden=false;await load('round');if(state.boot.wakeUp?.active)setTimeout(()=>showWakeUpPopup(state.boot.wakeUp.message||'Magarac jedan probudi se!'),120);setTimeout(liveRefreshTick,1000);initPushUser();}
function scopeSelect(){return `<div class="scope-wrap"><label>Prikaži rezultat</label><select class="scope" aria-label="Odabir kruga" id="scope">${[1,2,3,4].map(c=>`<option value="${c}" ${state.scope===String(c)?'selected':''}>Krug ${c} · kola ${state.boot.cycles.find(x=>x.id===c)?.from||''}–${state.boot.cycles.find(x=>x.id===c)?.to||''}</option>`).join('')}<option value="all" ${state.scope==='all'?'selected':''}>Ukupna tablica · sva 4 kruga</option></select></div>`;}
async function load(view=state.view,silent=false){
 state.view=view;nav();setMenu(false);const seq=++state.sequence;if(!silent)$('#main').innerHTML='<div class="loading"><div class="spinner"></div>Ucitavam podatke...</div>';
 try{let data;
  if(view==='round'){data=await api('/round/'+state.round);if(seq!==state.sequence)return;state.roundData=data;renderRound(data);}
  if(view==='results'){data=await api('/results?scope='+state.scope);if(seq!==state.sequence)return;renderResults(data);}
  if(view==='mine'){data=await api('/mine');if(seq!==state.sequence)return;renderMine(data);}
  if(view==='stats'){data=await api('/stats?scope='+state.scope);if(seq!==state.sequence)return;renderStats(data);}
  if(view==='standings'){data=await api('/standings');if(seq!==state.sequence)return;renderStandings(data);}
  if(view==='admin'){data=await api('/admin/panel');if(seq!==state.sequence)return;state.admin=data;renderAdmin();}
  if(view==='system'){const x=await Promise.all([api('/admin/teams'),api('/round/'+state.round)]);if(seq!==state.sequence)return;state.teams=x[0].teams;state.roundData=x[1];renderSystem();}
 }catch(e){if(!silent&&seq===state.sequence)$('#main').innerHTML=`<div class="error" role="alert">${esc(e.message)}</div><button data-action="refresh">Pokusaj ponovno</button>`;}
}
function liveWindowOpen(){
 const now=Math.floor(Date.now()/1000);
 return (state.roundData?.fixtures||[]).some(f=>Number(f.manual_score)!==1&&Number(f.kickoff)>0&&Number(f.kickoff)<=now&&Number(f.kickoff)>=now-4*60*60);
}
async function liveRefreshTick(){
 if(document.visibilityState==='hidden'||!state.boot||state.busy||state.liveRefreshing)return;
 if(!['round','results','mine','stats','standings','admin'].includes(state.view))return;
 const adminRace=state.view==='admin'&&Number(state.admin?.sourceRaceActive||0)>0;
 state.liveRefreshing=true;
 try{
  if(adminRace||liveWindowOpen()){
   try{await api('/live/pulse',{});}catch(e){console.warn('KZM live pulse:',e?.message||e);}
  }
  await load(state.view,true);
 }finally{state.liveRefreshing=false;}
}
setInterval(liveRefreshTick,15000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')liveRefreshTick();});

function fixtureHtml(f,p){const mine=p&&(p.team_id===f.home_id||p.team_id===f.away_id);return `<div class="fixture ${mine?'my-fixture':''}"><div class="home">${esc(f.home_name)}${clubBadge(f.home_name,'fixture-badge')}</div><div class="score">${score(f)}<small>${f.kickoff?esc(formatTime(f.kickoff)):esc(f.status)}</small></div><div class="away">${clubBadge(f.away_name,'fixture-badge')}${esc(f.away_name)}</div></div>`;}
function pickSummary(p,d){if(!p)return '';const fx=d.fixtures.find(f=>f.home_id===p.team_id||f.away_id===p.team_id);return `<div class="selected-summary"><div class="selected-summary-top"><div><div class="small muted">TVOJ PICK</div>${teamPill(p.team_name)} ${p.is_double?'<span class="pill pink">x2 DOUBLE</span>':''}</div><div class="selected-points">${p.points??'-'}<small>BODOVA</small></div></div>${fx?`<div class="selected-match"><div class="selected-match-label">TVOJA UTAKMICA</div><div class="selected-match-teams"><div class="selected-match-team">${clubBadge(fx.home_name,'sm')}<strong>${esc(fx.home_name)}</strong></div><div class="selected-match-score">${score(fx)}</div><div class="selected-match-team">${clubBadge(fx.away_name,'sm')}<strong>${esc(fx.away_name)}</strong></div></div></div>`:''}</div>`;}
function savedOpenPick(p,d){if(!p)return '';const fx=d.fixtures.find(f=>f.home_id===p.team_id||f.away_id===p.team_id);return `<div class="selected-summary"><div class="selected-summary-top"><div><div class="small muted">SPREMLJENI PICK</div>${teamPill(p.team_name)} ${p.is_double?'<span class="pill pink">x2 DOUBLE</span>':''}</div><span class="pill green">SPREMLJENO</span></div>${fx?`<div class="selected-match"><div class="selected-match-label">TVOJA UTAKMICA</div><div class="selected-match-teams"><div class="selected-match-team">${clubBadge(fx.home_name,'sm')}<strong>${esc(fx.home_name)}</strong></div><div class="selected-match-score">${score(fx)}</div><div class="selected-match-team">${clubBadge(fx.away_name,'sm')}<strong>${esc(fx.away_name)}</strong></div></div></div>`:''}<button type="button" class="primary full" data-action="change-pick">PROMIJENI PICK</button></div>`;}
function roundPickStats(d){
 if(!d?.round?.locked)return [];
 const counts=new Map();
 for(const x of d.players||[]){if(!x.pick?.team_name)continue;const k=clubKey(x.pick.team_name);const cur=counts.get(k)||{name:x.pick.team_name,count:0};cur.count++;counts.set(k,cur);}
 return [...counts.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'hr'));
}
function renderRoundPickStats(d){
 if(!d?.round?.locked)return '';
 const rows=roundPickStats(d);if(!rows.length)return '';
 const max=Math.max(1,...rows.map(x=>x.count));const total=rows.reduce((n,x)=>n+x.count,0);
 return `<div class="card"><div class="card-head"><h2>Statistika odabira</h2><span class="pill">${total} pickova</span></div><p class="fine">Dostupno nakon zaključavanja kola.</p><div class="pick-stats-list">${rows.map(x=>`<div class="pick-stat-row"><div class="pick-stat-club">${clubBadge(x.name,'sm')}<span>${esc(x.name)}</span></div><div class="pick-stat-track"><span style="width:${Math.round(100*x.count/max)}%"></span></div><div class="pick-stat-count">${x.count}</div></div>`).join('')}</div></div>`;
}
function roundComplete(d){
 return !!(d?.round?.locked&&(d.fixtures||[]).length&&(d.fixtures||[]).every(f=>['FINISHED','AWARDED'].includes(String(f.status||'').toUpperCase())&&f.home_score!==null&&f.home_score!==undefined&&f.away_score!==null&&f.away_score!==undefined));
}
function roundTopScorers(d){
 if(!roundComplete(d))return null;
 const valid=(d.players||[]).filter(x=>x.chosen&&x.pick&&x.pick.points!==null&&x.pick.points!==undefined&&!Number.isNaN(Number(x.pick.points)));
 if(!valid.length)return null;
 const max=Math.max(...valid.map(x=>Number(x.pick.points)));return {points:max,names:valid.filter(x=>Number(x.pick.points)===max).map(x=>x.name)};
}
function renderRoundTopScorers(d){
 const top=roundTopScorers(d);if(!top||!top.names.length)return '';
 const label=top.names.length===1?'Pobjednik kola':'Pobjednici kola';
 return `<div class="round-top-scorer"><div class="round-top-scorer-icon">🏆</div><div class="round-top-scorer-main"><div class="round-top-scorer-label">${label}</div><div class="round-top-scorer-name">${esc(top.names.join(', '))}</div></div><div class="round-top-scorer-points">${esc(top.points)}<span>bodova</span></div></div>`;
}
function roundZeroScorers(d){
 if(!roundComplete(d))return [];
 return (d.players||[]).filter(x=>x.chosen&&x.pick&&Number(x.pick.points)===0).map(x=>x.name);
}
function renderRoundPenas(d){
 const names=roundZeroScorers(d);if(!names.length)return '';
 const label=names.length===1?'Pena kola':'Pene kola';
 return `<div class="card"><div class="card-head"><h2>🫏 ${label}</h2><span class="pill pink">0 bodova</span></div><div class="not-picked">${names.map(name=>`<span>${esc(name)}</span>`).join('')}</div></div>`;
}
function closeWakeUpPopup(){const host=$('#wake-popup-host');if(host)host.innerHTML='';}
function showWakeUpPopup(message){
 const host=$('#wake-popup-host');if(!host)return;
 host.innerHTML=`<div class="wake-popup-backdrop"><div class="wake-popup" role="dialog" aria-modal="true" aria-label="Upozorenje za zadnje mjesto"><div class="wake-popup-icon">🫏</div><div class="wake-popup-title">${esc(message||'Magarac jedan probudi se!')}</div><button class="wake-popup-btn" type="button" data-action="close-wake">Dobro, dobro...</button></div></div>`;
}
function closeWinnerPopup(){const host=$('#winner-popup-host');if(host)host.innerHTML='';}
function winnerPopup(title,message,key){
 try{if(localStorage.getItem(key)==='1')return;localStorage.setItem(key,'1');}catch{}
 const host=$('#winner-popup-host');if(!host)return;
 host.innerHTML=`<div class="winner-popup-backdrop"><div class="winner-popup" role="dialog" aria-modal="true" aria-label="${attr(title)}"><div class="winner-popup-trophy">🏆</div><div class="winner-popup-title">${esc(title)}</div><div class="winner-popup-message">${message}</div><button class="winner-popup-btn" type="button" data-action="close-winner">Bravo!</button></div></div>`;
}
function showRoundWinnerPopup(d){
 const top=roundTopScorers(d);if(!top||!top.names.length)return;
 const names=top.names.join(', '),plural=top.names.length>1;
 winnerPopup(`${plural?'Pobjednici':'Pobjednik'} ${d.round.number}. kola`,plural?`Čestitamo, <strong>${esc(names)}</strong> su pobjednici kola s <strong>${esc(top.points)} bodova</strong>!`:`Čestitamo, <strong>${esc(names)}</strong> je pobjednik kola s <strong>${esc(top.points)} bodova</strong>!`,`kzm_round_winner_${d.round.number}_${top.names.join('|')}_${top.points}`);
}
function renderCycleWinner(d){
 const c=d.cycleInfo;if(!c)return '';
 if(!c.finished)return `<div class="card"><div class="card-head"><h2>Krug ${c.id} je u tijeku</h2><span class="pill">NEMA POBJEDNIKA</span></div><p class="muted">Pobjednik će biti proglašen tek kada završe sve utakmice ${c.to}. kola, posljednjeg kola ovog kruga.</p></div>`;
 if(!c.winners?.length)return '';
 return `<div class="cycle-winner"><div class="cycle-winner-icon">🏆</div><div><div class="cycle-winner-kicker">Završen ${c.id}. krug</div><div class="cycle-winner-name">${c.winners.length>1?'Pobjednici':'Pobjednik'}: ${esc(c.winners.map(x=>x.name).join(', '))}</div></div><div class="cycle-winner-score">${esc(c.winners[0].points)}<span>bodova</span></div></div>`;
}
function showCycleWinnerPopup(d){
 const c=d.cycleInfo;if(!c?.finished||!c.winners?.length)return;
 const names=c.winners.map(x=>x.name),plural=names.length>1;
 winnerPopup(`${plural?'Pobjednici':'Pobjednik'} ${c.id}. kruga`,plural?`Čestitam, <strong>${esc(names.join(', '))}</strong>, vi niste magarci, pobijedili ste <strong>${c.id}. krug</strong>, POT je vaš!`:`Čestitam, <strong>${esc(names[0])}</strong>, ti nisi magarac, pobijedio si <strong>${c.id}. krug</strong>, POT je tvoj!`,`kzm_cycle_winner_${c.id}_${names.join('|')}_${c.winners[0].points}`);
}
function renderRound(d){
 const p=d.myPick,disabled=d.round.locked||state.boot.settings.picks_enabled!=='1';
 let pick='';
 if(!d.round.locked){
  if(p&&state.editingPick!==d.round.number){pick+=savedOpenPick(p,d);}
  else{
   if(disabled)pick+=`<p class="muted">Administrator još nije omogućio spremanje odabira.</p>`;
   const current=p?.team_id||'';const currentTeam=d.available.find(t=>t.id===current)||teamById(current);
   pick+=`<form id="pick-form"><input type="hidden" name="team" id="pick-team" value="${attr(current)}"><div class="team-picker-wrap"><button type="button" class="team-picker-button" data-action="team-picker" ${disabled?'disabled':''}><span class="team-picker-current" id="team-picker-current">${currentTeam?clubBadge(currentTeam.name,'sm')+`<span>${esc(currentTeam.name)}</span>`:'<span>Odaberi ekipu...</span>'}</span><span class="team-picker-arrow">&#9660;</span></button><div class="team-picker-menu" id="team-picker-menu">${d.available.map(t=>`<button type="button" class="team-picker-option ${current===t.id?'selected':''}" data-pick-team="${attr(t.id)}" data-pick-name="${attr(t.name)}"><span>${clubBadge(t.name,'sm')}</span><span class="name">${esc(t.name)}</span><span class="points">${t.base} b.</span></button>`).join('')}</div></div><label class="double-toggle"><input name="double" type="checkbox" ${p?.is_double?'checked':''} ${!d.doubleAvailable||disabled?'disabled':''}> DOUBLE - jednom po krugu</label><button class="primary full" ${disabled?'disabled':''}>SPREMI PICK</button>${p?'<button type="button" class="secondary full pick-cancel" data-action="cancel-pick-edit">ODUSTANI</button>':''}</form>`;
  }
 }else if(p){pick+=pickSummary(p,d);}
 else pick+='<p class="muted">Nema spremljenog odabira.</p>';

 const fixtures=d.fixtures.map(f=>fixtureHtml(f,p)).join('');
 const notPicked=d.players.filter(x=>!x.chosen);
 let right='';
 if(d.round.locked){
  const picksTable=d.players.map(x=>`<tr class="${x.mine?'me':''}"><td><strong>${esc(x.name)}</strong></td><td>${x.pick?teamPill(x.pick.team_name):'<span class="muted">Nije birao</span>'}</td><td>${x.pick?.is_double?'<span class="pink">x2 DOUBLE</span>':'-'}</td><td class="points right">${x.pick?.points??'-'}</td></tr>`).join('');
  right+=`<div class="card"><div class="card-head"><h2>Odabiri igrača</h2><span class="pill">${d.players.filter(x=>x.chosen).length} pickova</span></div><div class="table-wrap"><table><thead><tr><th>Igrač</th><th>Odabir</th><th>DOUBLE</th><th class="right">Bodovi</th></tr></thead><tbody>${picksTable}</tbody></table></div></div>`;
  right+=renderRoundTopScorers(d);
  right+=renderRoundPenas(d);
 }
 right+=`<div class="card"><div class="card-head"><h2>Nisu birali</h2><span class="pill pink">${notPicked.length}</span></div><div class="not-picked">${notPicked.map(x=>`<span>${esc(x.name)}</span>`).join('')||'<div class="green">Svi su odabrali ✓</div>'}</div></div>`;
 right+=renderRoundPickStats(d);

 $('#main').innerHTML=hero('Kolo '+d.round.number,'Rok: '+formatTime(d.round.deadline),d.round.locked?'ZAKLJUČANO':'OTVORENO')+`<div class="grid"><div><div class="card"><div class="card-head"><h2>Tvoj odabir</h2><span class="badge ${d.round.locked?'lock':'open'}">${d.round.locked?'ZAKLJUČANO':'OTVORENO'}</span></div>${pick}</div><div class="card"><div class="card-head"><h2>Raspored</h2><span class="pill">${d.fixtures.length} utakmica</span></div><div class="fixtures">${fixtures||empty('Raspored nije uvezen.')}</div></div></div><div>${right}</div></div>`;
 if(roundComplete(d))setTimeout(()=>showRoundWinnerPopup(d),80);
}

function renderResults(d){
 const cycleBlock=renderCycleWinner(d);
 $('#main').innerHTML=hero('Tablica',state.scope==='all'?'Ukupni poredak cijele sezone':`Poredak ${state.scope}. kruga`)+scopeSelect()+cycleBlock+`<div class="card cycle-results-card"><div class="card-head"><h2>${state.scope==='all'?'Ukupna tablica':(d.cycleInfo?.finished?'Rezultat':'Trenutni poredak')+' '+state.scope+'. kruga'}</h2>${state.scope!=='all'?`<span class="pill ${d.cycleInfo?.finished?'green':''}">Kola ${d.cycleInfo?.from||''}–${d.cycleInfo?.to||''}</span>`:''}</div><div class="table-wrap"><table><thead><tr><th>#</th><th>Igrač</th><th>DOUBLE (kolo)</th><th>Uplata${state.scope==='all'?' K1 / K2 / K3 / K4':''}</th><th class="right">Bodovi</th></tr></thead><tbody>${d.rows.map(r=>`<tr class="${r.id===state.boot.user.id?'me':''}"><td><span class="pos ${d.cycleInfo?.finished&&r.place===1?'champ':''}">${r.place}</span></td><td><strong>${esc(r.name)}</strong>${r.active?'':' <span class="muted">(neaktivan)</span>'}</td><td>${(r.doubleRounds||[]).map(x=>`<span class="pink">Kolo ${x.round}</span>`).join(', ')||'<span class="muted">–</span>'}</td><td>${(state.scope==='all'?[1,2,3,4]:[Number(state.scope)]).map(c=>r.payments[c]===true?'<span class="green">DA</span>':r.payments[c]===false?'<span class="pink">NE</span>':'-').join(' / ')}</td><td class="points right"><strong>${r.points}</strong></td></tr>`).join('')}</tbody></table></div></div>`;
 if(d.cycleInfo?.finished)setTimeout(()=>showCycleWinnerPopup(d),80);
}
function renderMine(d){const rows=d.rows.filter(r=>state.scope==='all'||r.cycle===Number(state.scope));$('#main').innerHTML=hero('Moji odabiri','Pregled svih tvojih utakmica i odabira')+scopeSelect()+`<div class="card"><div class="table-wrap"><table><thead><tr><th>Kolo</th><th>Ekipa</th><th>DOUBLE</th><th>Rezultat</th><th class="right">Bodovi</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r.round_no}</td><td>${teamPill(r.team_name)}</td><td>${r.is_double?'<span class="pink">x2</span>':'-'}</td><td>${r.home_score===null?'-':r.home_score+' : '+r.away_score}</td><td class="points right">${r.points??'-'}</td></tr>`).join('')}</tbody></table></div>${rows.length?'':empty('Nema odabira za ovaj prikaz.')}</div>`;}
function renderStats(d){const max=Math.max(1,...d.rows.map(r=>r.count));$('#main').innerHTML=hero('Statistika','Koliko je puta koji klub biran')+scopeSelect()+`<div class="card"><div class="pick-stats-list">${d.rows.map(r=>`<div class="pick-stat-row"><div class="pick-stat-club">${clubBadge(r.name,'sm')}<span>${esc(r.name)}</span></div><div class="pick-stat-track"><span style="width:${Math.round(100*r.count/max)}%"></span></div><div class="pick-stat-count">${r.count}</div></div>`).join('')||empty('Jos nema odabira u zakljucanim kolima.')}</div></div>`;}
function renderStandings(d){$('#main').innerHTML=hero('Premier League uzivo','Poredak iz spremljenih zavrsenih utakmica')+`<div class="card"><div class="table-wrap"><table><thead><tr><th>#</th><th>Klub</th><th>Od.</th><th>P</th><th>N</th><th>I</th><th>Golovi</th><th>GR</th><th class="right">Bodovi</th></tr></thead><tbody>${d.rows.map(r=>`<tr><td><span class="pos">${r.place}</span></td><td><span class="club-inline">${clubBadge(r.name,'sm')}<strong>${esc(r.name)}</strong></span></td><td>${r.played}</td><td>${r.wins}</td><td>${r.draws}</td><td>${r.losses}</td><td>${r.gf}:${r.ga}</td><td>${r.gf-r.ga}</td><td class="points right">${r.points}</td></tr>`).join('')}</tbody></table></div><p class="fine">${esc(d.notice)}</p></div>`;}
function adminPickEntry(playerId,round){return (state.admin?.picks||[]).find(p=>p.player_id===playerId&&Number(p.round_no)===Number(round))||null;}
function syncAdminPickEditor(){
 const f=$('#admin-pick-form');if(!f||!state.admin)return;
 const players=state.admin.players||[];
 if(!state.adminPickPlayerId||!players.some(p=>p.id===state.adminPickPlayerId))state.adminPickPlayerId=players[0]?.id||'';
 if(!state.adminPickRound)state.adminPickRound=state.boot?.currentRound||1;
 f.elements.playerId.value=state.adminPickPlayerId;
 f.elements.round.value=String(state.adminPickRound);
 const p=adminPickEntry(state.adminPickPlayerId,state.adminPickRound);
 f.elements.teamId.value=p?.team_id||'';
 f.elements.double.checked=!!p?.is_double;
 const player=players.find(x=>x.id===state.adminPickPlayerId);
 const info=$('#admin-pick-current');
 if(info)info.innerHTML=p?`Trenutno: <strong>${esc(player?.name||'Igrač')}</strong> / ${state.adminPickRound}. kolo / ${teamPill(p.team_name)}${p.is_double?' <span class="pink">x2 DOUBLE</span>':''}`:`Trenutno: <strong>${esc(player?.name||'Igrač')}</strong> nema spremljen pick u ${state.adminPickRound}. kolu.`;
 const del=$('[data-action="admin-delete-pick"]');if(del)del.disabled=!p;
}
function raceClock(s){return s?new Intl.DateTimeFormat('hr-HR',{timeZone:'Europe/Zagreb',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(Number(s)*1000)):'-';}
function sourceRaceHtml(d){
 const rows=d.sourceRace||[];
 if(!rows.length)return `<div class="card"><div class="card-head"><h2>Utrka izvora</h2><span class="pill">TEST</span></div><p class="fine">ESPN je primarni live fallback dok utakmica traje, a football-data.org ostaje fallback i izvor punog rasporeda. Bilježenje počinje automatski kad utakmica krene.</p><div class="empty">Još nema zabilježenih live promjena.</div></div>`;
 const groups=new Map();
 for(const r of rows){
  if(r.home_score===null||r.away_score===null)continue;
  const key=`${r.fixture_id}|${r.home_score}:${r.away_score}`;
  let g=groups.get(key);if(!g){g={fixture_id:r.fixture_id,home_name:r.home_name,away_name:r.away_name,score:`${r.home_score}:${r.away_score}`,sources:{},first:Number(r.observed_at)||0};groups.set(key,g);}
  const t=Number(r.observed_at)||0;g.first=Math.min(g.first||t,t);
  if(!g.sources[r.source]||t<g.sources[r.source])g.sources[r.source]=t;
 }
 const list=[...groups.values()].sort((a,b)=>b.first-a.first).slice(0,24);
 const body=list.map(g=>{
  const e=g.sources.ESPN||null,f=g.sources['football-data.org']||null;
  let verdict='Čeka drugi izvor';
  if(e&&f){const delta=f-e;verdict=delta===0?'Isti ciklus':delta>0?`ESPN ranije ${delta} s`:`football-data.org ranije ${Math.abs(delta)} s`;}
  return `<tr><td><strong>${esc(g.home_name)} - ${esc(g.away_name)}</strong></td><td><strong>${esc(g.score)}</strong></td><td>${raceClock(e)}</td><td>${raceClock(f)}</td><td>${esc(verdict)}</td></tr>`;
 }).join('');
 return `<div class="card"><div class="card-head"><h2>Utrka izvora</h2><span class="pill ${Number(d.sourceRaceActive||0)>0?'green':''}">${Number(d.sourceRaceActive||0)>0?'LIVE TEST':'ČEKA UTAKMICU'}</span></div><p class="fine"><strong>ESPN sada može ažurirati live rezultat u D1.</strong> football-data.org se koristi kao fallback i za puni raspored. Tablica i dalje pokazuje kada je koji izvor prijavio promjenu. Admin ekran se osvježava svakih 20 sekundi dok utakmica traje.</p>${d.sourceRaceEspnError?`<div class="error">ESPN: ${esc(d.sourceRaceEspnError)}</div>`:''}${d.sourceRaceFootballError?`<div class="error">football-data.org: ${esc(d.sourceRaceFootballError)}</div>`:''}<div class="table-wrap"><table><thead><tr><th>Utakmica</th><th>Rezultat</th><th>ESPN</th><th>football-data.org</th><th>Brži izvor</th></tr></thead><tbody>${body||'<tr><td colspan="5">Čekam prvu promjenu rezultata.</td></tr>'}</tbody></table></div></div>`;
}

function registrationCycleText(c){return c?`${Number(c)}. krug`:'sljedeća sezona';}
function registrationRequestCard(d){
 const rows=(d.registrations||[]).filter(r=>r.status!=='active').sort((a,b)=>(Number(b.requestedAt||0)-Number(a.requestedAt||0))||String(a.name).localeCompare(String(b.name),'hr'));
 const pending=rows.filter(r=>r.status==='pending').length,approved=rows.filter(r=>r.status==='approved').length;
 const body=rows.map(r=>{
  const status=r.status==='pending'?'<span class="pill pink">ČEKA ODOBRENJE</span>':r.status==='approved'?`<span class="pill green">ODOBREN · ${esc(registrationCycleText(r.eligibleCycle))}</span>`:'<span class="pill">ODBIJEN</span>';
  const approveText=r.status==='rejected'?'PONOVNO ODOBRI':'ODOBRI';
  return `<tr><td><strong>${esc(r.name)}</strong></td><td>${status}</td><td>${esc(registrationCycleText(r.eligibleCycle))}</td><td>${r.requestedAt?formatTime(r.requestedAt):'-'}</td><td><div class="actions"><button class="small-btn" data-reg-approve="${attr(r.playerId)}" ${r.status==='approved'?'disabled':''}>${approveText}</button><button class="small-btn danger" data-reg-reject="${attr(r.playerId)}" ${r.status==='rejected'?'disabled':''}>ODBIJ</button></div></td></tr>`;
 }).join('');
 return `<div class="card"><div class="card-head"><h2>Zahtjevi za registraciju</h2><span class="pill ${pending?'pink':approved?'green':''}">${pending} čeka · ${approved} odobreno</span></div><p class="fine"><strong>Nitko tko se sam registrira ne može odmah igrati.</strong> Prvo moraš odobriti zahtjev. I nakon odobrenja igrač ostaje neaktivan do sljedećeg kruga; sustav ga automatski aktivira tek kada završi prethodni krug. Odbijeni zahtjev nema pristup igri.</p><div class="table-wrap"><table><thead><tr><th>Igrač</th><th>Status</th><th>Najraniji ulazak</th><th>Zahtjev</th><th>Odluka</th></tr></thead><tbody>${body||'<tr><td colspan="5">Nema zahtjeva na čekanju.</td></tr>'}</tbody></table></div></div>`;
}
function pushDiagnosticsHtml(){
 const rows=state.pushDiagnostics;
 const head=`<div class="card-head"><h2>Push obavijesti</h2><button class="small-btn" data-action="push-diagnostics">PROVJERI PRETPLATE</button></div>`;
 if(!rows)return `<div class="card">${head}<p class="fine">Provjera cita OneSignal stanje po KZM external ID-u. Ne salje obavijest i ne mijenja pretplate.</p><div class="empty">Klikni PROVJERI PRETPLATE da vidis tko stvarno ima aktivan push uredjaj povezan s KZM racunom.</div></div>`;
 const ok=rows.filter(x=>Number(x.enabledPush)>0).length;
 const body=rows.map(x=>{const good=Number(x.enabledPush)>0,status=x.error?`<span class="pill pink">GRESKA</span>`:good?`<span class="pill green">${x.enabledPush} AKTIVAN</span>`:`<span class="pill">NEMA AKTIVNOG</span>`;const note=x.error?esc(x.error):x.found?`${Number(x.totalPush||0)} push zapisa${x.types?.length?` · ${esc(x.types.join(', '))}`:''}`:'External ID nije pronadjen u OneSignalu';return `<tr><td><strong>${esc(x.name)}</strong></td><td>${status}<div class="fine">${note}</div></td><td>${good?`<button class="small-btn" data-push-test-player="${attr(x.playerId)}">TEST</button>`:'-'}</td></tr>`;}).join('');
 return `<div class="card">${head}<p class="fine"><strong>${ok}/${rows.length}</strong> aktivnih igraca trenutno ima barem jednu aktivnu OneSignal push pretplatu povezanu s KZM external ID-em.</p><div class="table-wrap"><table><thead><tr><th>Igrac</th><th>OneSignal</th><th>Test</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function renderAdmin(){
 const d=state.admin;
 const players=d.players||[],teams=(state.boot?.teams||[]).slice().sort((x,y)=>x.name.localeCompare(y.name,'hr'));
 const regByPlayer=new Map((d.registrations||[]).map(r=>[r.playerId,r])),pickPlayers=players.filter(p=>p.active||!regByPlayer.has(p.id));
 if(!state.adminPickPlayerId||!pickPlayers.some(p=>p.id===state.adminPickPlayerId))state.adminPickPlayerId=pickPlayers[0]?.id||'';
 if(!state.adminPickRound)state.adminPickRound=state.boot?.currentRound||1;
 const playerOptions=pickPlayers.map(p=>`<option value="${attr(p.id)}">${esc(p.name)}${p.active?'':' (neaktivan)'}</option>`).join('');
 const roundOptions=Array.from({length:38},(_,i)=>i+1).map(n=>`<option value="${n}">${n}. kolo</option>`).join('');
 const teamOptions='<option value="">Odaberi ekipu</option>'+teams.map(t=>`<option value="${attr(t.id)}">${esc(t.name)}</option>`).join('');
 const activePlayers=players.filter(p=>p.active).length,regState=d.registration||{},occupiedPlayers=Number(regState.occupiedPlayers??activePlayers),maxPlayers=Math.max(occupiedPlayers,Number(d.settings.max_players||40)),registrationOpen=d.settings.registration_open!=='0';
 const playerRows=players.map(p=>{const rr=regByPlayer.get(p.id),tag=rr&&!p.active?(rr.status==='pending'?' <span class="pill pink">ČEKA ODOBRENJE</span>':rr.status==='approved'?` <span class="pill green">ODOBREN ZA ${esc(registrationCycleText(rr.eligibleCycle))}</span>`:rr.status==='rejected'?' <span class="pill">ODBIJEN</span>':''):'';const activeButton=p.is_admin?'':rr&&!p.active?'':`<button class="small-btn ${p.active?'danger':''}" data-active="${esc(p.id)}">${p.active?'Deaktiviraj':'Aktiviraj'}</button>`;return `<tr class="${!p.active?'inactive':''}"><td><strong>${esc(p.name)}</strong>${p.is_admin?' <span class="pill">ADMIN</span>':''}${tag}</td>${[1,2,3,4].map(c=>`<td><button class="pay ${p.payments[c]===true?'yes':p.payments[c]===false?'no':'unknown'}" data-pay="${esc(p.id)}" data-pay-cycle="${c}">${p.payments[c]===true?'PLACENO':p.payments[c]===false?'NEPLACENO':'NIJE OZNACENO'}</button></td>`).join('')}<td><div class="actions"><button class="small-btn" data-password="${esc(p.id)}">PIN</button>${activeButton}</div></td></tr>`;}).join('');
 $('#main').innerHTML=hero('Admin postavke','Upravljanje igracima, pickovima i placanjima izravno u D1','SAMO ADMIN')+
 `<div class="card"><div class="card-head"><h2>Registracija i limit igrača</h2><span class="pill ${registrationOpen?'green':''}">${occupiedPlayers} / ${maxPlayers}</span></div>
  <form id="registration-settings-form" class="form-grid">
   <label>Registracija<select name="registrationOpen"><option value="1" ${registrationOpen?'selected':''}>OTVORENA</option><option value="0" ${!registrationOpen?'selected':''}>ZATVORENA</option></select></label>
   <label>Limit igrača<input name="maxPlayers" type="number" min="${occupiedPlayers}" max="200" value="${maxPlayers}" required></label>
   <div><label>&nbsp;</label><button class="primary full" type="submit">SPREMI REGISTRACIJU</button></div>
  </form><p class="fine">Limit uključuje aktivne igrače i odobrene igrače koji čekaju početak sljedećeg kruga. Neodobreni zahtjevi ne zauzimaju mjesto i nikad ne daju trenutačan pristup igri.</p></div>`+
 registrationRequestCard(d)+
 `<div class="card"><div class="card-head"><h2>Ispravi pick igrača</h2><span class="pill pink">ADMIN ISPRAVAK</span></div>
  <p class="fine">Za pogrešno spremljene pickove. Radi i nakon zaključavanja kola. Pravilo jedne ekipe i jednog DOUBLE-a po krugu i dalje vrijedi, a svaka promjena ulazi u zapis promjena.</p>
  <form id="admin-pick-form" class="form-grid">
   <label>Igrač<select name="playerId" required>${playerOptions}</select></label>
   <label>Kolo<select name="round" required>${roundOptions}</select></label>
   <label>Ekipa<select name="teamId" required>${teamOptions}</select></label>
   <label class="double-toggle"><input type="checkbox" name="double"> DOUBLE</label>
   <button class="primary" type="submit">SPREMI ISPRAVAK PICKA</button>
   <button class="danger" type="button" data-action="admin-delete-pick">OBRIŠI PICK</button>
  </form><div id="admin-pick-current" class="fine" style="margin-top:12px"></div></div>`+
 `<div class="card"><div class="card-head"><h2>Dodaj igraca</h2><span class="pill green">${players.filter(p=>p.active).length} aktivnih</span></div><form id="player-form" class="form-grid"><label>Ime i prezime<input name="name" required maxlength="80"></label><label>PIN<input name="password" type="password" inputmode="numeric" pattern="[0-9]*" required minlength="4" maxlength="12" autocomplete="new-password"></label><div><label>&nbsp;</label><button class="primary full">DODAJ IGRACA</button></div></form></div>`+
 `<div class="card"><div class="card-head"><h2>Igraci i placanja</h2><button data-action="refresh" class="small-btn">OSVJEZI</button></div><div class="admin-table-wrap"><table><thead><tr><th>Igrac</th>${[1,2,3,4].map(c=>`<th>Krug ${c}</th>`).join('')}<th>Akcije</th></tr></thead><tbody>${playerRows}</tbody></table></div></div>`+
 pushDiagnosticsHtml()+
 sourceRaceHtml(d)+
 `<div class="card"><div class="card-head"><h2>Sustav i raspored</h2><span class="pill">D1</span></div><div class="actions"><button class="secondary" data-view="system">KLUBOVI, ROKOVI I REZULTATI</button><button data-action="toggle-picks" class="${d.settings.picks_enabled==='1'?'danger':'primary'}">${d.settings.picks_enabled==='1'?'ZAUSTAVI ODABIRE':'OMOGUCI ODABIRE'}</button><button data-action="sync">RUČNO OSVJEŽI CIJELI RASPORED</button><button data-action="espn-test" class="secondary">TEST ESPN</button><button data-action="push-test" class="secondary">TEST PUSH</button></div><p class="fine"><strong>Auto live:</strong> svake minute i dodatno preko browser live-pulsea. ESPN radi neovisno o football-data rate limitu; football-data.org ostaje fallback i puni raspored.<br>Zadnji live dohvat: ${formatTime(Number(d.settings.last_sync)||null)}${d.settings.last_sync_source?` · izvor: <strong>${esc(d.settings.last_sync_source)}</strong>`:''}</p>${d.settings.last_sync_error?`<div class="error">${esc(d.settings.last_sync_error)}</div>`:''}<details><summary>Zapis zadnjih promjena</summary><div class="table-wrap"><table>${d.audit.map(a=>`<tr><td>${formatTime(a.created_at)}</td><td>${esc(a.actor||'Sustav')}</td><td>${esc(a.action)}</td></tr>`).join('')}</table></div></details></div>`;
 syncAdminPickEditor();
}

function renderSystem(){
 const d=state.roundData,ts=state.teams,opt=ts.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
 $('#main').innerHTML=hero('Uredjivanje lige','Klubovi, rokovi i rezultati - izravno u D1')+`<div class="actions" style="margin-bottom:16px"><button data-view="admin">Natrag na administraciju</button></div><div class="card"><div class="card-head"><h2>Kolo ${state.round}</h2><span class="pill">ROK</span></div><form id="deadline-form"><label>Rok<input name="deadline" type="datetime-local" value="${datetimeValue(d.round.deadline)}" required></label><label class="double-toggle"><input type="checkbox" name="reopen"> Potvrdjujem ponovno otvaranje ako je kolo zakljucano.</label><button class="primary">Spremi rok</button></form></div><div class="card"><div class="card-head"><h2>Utakmice kola ${state.round}</h2><span class="pill">${d.fixtures.length}</span></div><div class="table-wrap"><table>${d.fixtures.map(f=>`<tr><td><span class="club-inline">${clubBadge(f.home_name,'sm')}${esc(f.home_name)}</span> - <span class="club-inline">${clubBadge(f.away_name,'sm')}${esc(f.away_name)}</span></td><td>${score(f)}</td><td><button data-fixture="${esc(f.id)}">Uredi</button></td></tr>`).join('')}</table></div><h3 id="fixture-form-title">Nova utakmica</h3><form id="fixture-form" class="form-grid"><input type="hidden" name="id"><label>Domacin<select name="homeId" required>${opt}</select></label><label>Gost<select name="awayId" required>${opt}</select></label><label>Pocetak<input name="kickoff" type="datetime-local"></label><label>Golovi domacin<input name="homeScore" type="number" min="0" max="99"></label><label>Golovi gost<input name="awayScore" type="number" min="0" max="99"></label><label>Status<select name="status">${['SCHEDULED','TIMED','IN_PLAY','PAUSED','FINISHED','POSTPONED','CANCELLED','SUSPENDED','AWARDED'].map(s=>`<option>${s}</option>`).join('')}</select></label><button class="primary">Spremi utakmicu</button><button type="button" data-action="reset-fixture">Nova utakmica</button></form><p class="fine">Rucno spremljen rezultat ne prepisuje nogometni API.</p><button class="danger" data-action="recalculate">Preracunaj uvezene bodove OVOG kola</button></div><div class="card"><h2>Klubovi i osnovni bodovi</h2><div class="table-wrap"><table><thead><tr><th>Klub</th><th>Bodovi</th><th>API ID</th><th></th></tr></thead><tbody>${ts.map(t=>`<tr><td><span class="club-inline">${clubBadge(t.name,'sm')}<strong>${esc(t.name)}</strong></span></td><td>${t.base}</td><td>${t.api_id??'-'}</td><td><button data-team="${esc(t.id)}">Uredi</button></td></tr>`).join('')}</tbody></table></div><h3 id="team-form-title">Novi klub</h3><form id="team-form" class="form-grid"><input type="hidden" name="id"><label>Naziv<input name="name" required maxlength="80"></label><label>Osnovni bodovi<input name="base" type="number" min="0" max="100" required></label><label>API ID<input name="apiId" type="number" min="1"></label><label>Boja<input name="color" type="color" value="#37003c"></label><button class="primary">Spremi klub</button></form></div>`;
}

async function mutation(button,fn){if(state.busy)return;state.busy=true;if(button)button.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{state.busy=false;if(button)button.disabled=false;}}
$('#login-form').addEventListener('submit',e=>{e.preventDefault();const f=e.target;mutation(f.querySelector('button'),async()=>{$('#login-error').textContent='';try{await api('/login',{name:f.elements.name.value,password:f.elements.password.value});localStorage.setItem('kzm_novi_name',f.elements.name.value);f.elements.password.value='';await enter();}catch(x){$('#login-error').innerHTML=`<div class="error">${esc(x.message)}</div>`;}});});
$('#registration-form').addEventListener('submit',e=>{e.preventDefault();const f=e.target;mutation(f.querySelector('[type=submit]'),async()=>{const error=$('#registration-error');error.textContent='';const name=f.elements.name.value.trim(),password=f.elements.password.value;if(password!==f.elements.password2.value){error.innerHTML='<div class="error">PIN-ovi se ne podudaraju.</div>';return;}try{const d=await api('/register',{name,password});f.reset();f.hidden=true;await loadLoginPlayers();error.innerHTML=`<div class="fine"><strong>Zahtjev je poslan.</strong><br>${esc(d.message||'Administrator ga mora odobriti prije nego što možeš igrati.')}</div>`;toast('Zahtjev za registraciju je poslan administratoru.');}catch(x){error.innerHTML=`<div class="error">${esc(x.message)}</div>`;await loadLoginPlayers();}});});
$('#veil').addEventListener('click',()=>setMenu(false));
$('#winner-popup-host').addEventListener('click',e=>{if(e.target.classList.contains('winner-popup-backdrop')||e.target.closest('[data-action="close-winner"]'))closeWinnerPopup();});
$('#wake-popup-host').addEventListener('click',e=>{if(e.target.classList.contains('wake-popup-backdrop')||e.target.closest('[data-action="close-wake"]'))closeWakeUpPopup();});
(function initDrawerSwipe(){
 let sx=0,sy=0,tracking=false,mode='';
 document.addEventListener('touchstart',e=>{if(!e.touches||e.touches.length!==1)return;const t=e.touches[0],drawer=$('#nav'),open=drawer?.classList.contains('open');if(!open&&t.clientX<=28){tracking=true;mode='open';sx=t.clientX;sy=t.clientY;}else if(open){tracking=true;mode='close';sx=t.clientX;sy=t.clientY;}},{passive:true});
 document.addEventListener('touchend',e=>{if(!tracking||!e.changedTouches||!e.changedTouches.length){tracking=false;return;}const t=e.changedTouches[0],dx=t.clientX-sx,dy=Math.abs(t.clientY-sy);if(Math.abs(dx)>70&&Math.abs(dx)>dy*1.2){if(mode==='open'&&dx>0)setMenu(true);if(mode==='close'&&dx<0)setMenu(false);}tracking=false;mode='';},{passive:true});
})();
document.addEventListener('change',e=>{if(e.target.id==='scope'){state.scope=e.target.value;load();return;}const f=e.target.closest?.('#admin-pick-form');if(f&&(e.target.name==='playerId'||e.target.name==='round')){state.adminPickPlayerId=f.elements.playerId.value;state.adminPickRound=Number(f.elements.round.value);syncAdminPickEditor();}});
document.addEventListener('click',async e=>{
 const b=e.target.closest('button');
 if(!b){const menu=$('#team-picker-menu');if(menu&&!e.target.closest('.team-picker-wrap'))menu.classList.remove('open');return;}
 if(b.dataset.view){if(b.dataset.view==='results')state.scope=String(state.cycle);await load(b.dataset.view);return;}
 if(b.dataset.cycle){state.cycle=Number(b.dataset.cycle);state.round=state.boot.rounds.find(r=>r.cycle===state.cycle).number;load(state.view==='system'?'system':'round');return;}
 if(b.dataset.round){state.round=Number(b.dataset.round);load(state.view==='system'?'system':'round');return;}
 if(b.dataset.pickTeam){const hidden=$('#pick-team'),label=$('#team-picker-current'),menu=$('#team-picker-menu');hidden.value=b.dataset.pickTeam;label.innerHTML=clubBadge(b.dataset.pickName,'sm')+`<span>${esc(b.dataset.pickName)}</span>`;menu.querySelectorAll('.team-picker-option').forEach(x=>x.classList.toggle('selected',x===b));menu.classList.remove('open');return;}
 const a=b.dataset.action;
 if(a==='show-registration'){const f=$('#registration-form');if(f&&!b.disabled){f.hidden=false;f.elements.name.focus();}return;}
 if(a==='cancel-registration'){const f=$('#registration-form');if(f){f.reset();f.hidden=true;}const x=$('#registration-error');if(x)x.textContent='';return;}
 if(a==='menu'){setMenu(!$('#nav').classList.contains('open'));return;}
 if(a==='team-picker'){const menu=$('#team-picker-menu');if(menu)menu.classList.toggle('open');return;}
 if(a==='change-pick'){state.editingPick=state.round;renderRound(state.roundData);return;}
 if(a==='cancel-pick-edit'){state.editingPick=null;renderRound(state.roundData);return;}
 if(a==='logout'){pushLogout();b.disabled=true;try{await api('/logout',{});setMenu(false);showLogin();}catch(e){toast('Odjava nije uspjela: '+e.message);}finally{b.disabled=false;}return;}
 if(a==='push'){await mutation(b,async()=>{await togglePush();});return;}
 if(a==='home'){state.round=state.boot.currentRound;state.cycle=state.boot.rounds.find(r=>r.number===state.round)?.cycle||1;await load('round');return;}
 if(a==='refresh'){await load();return;}
 if(a==='close-dialog'){$('#password-dialog').close();return;}
 if(a==='reset-fixture'){$('#fixture-form').reset();$('#fixture-form').elements.id.value='';$('#fixture-form-title').textContent='Nova utakmica';return;}
 if(b.dataset.regApprove){const id=b.dataset.regApprove,r=(state.admin.registrations||[]).find(x=>x.playerId===id);if(!confirm(`Odobriti registraciju za ${r?.name||'ovog igrača'}? Igrač neće moći igrati prije ${registrationCycleText(r?.eligibleCycle)}.`))return;await mutation(b,async()=>{await api(`/admin/registrations/${id}`,{action:'approve'});state.admin=await api('/admin/panel');renderAdmin();toast('Registracija je odobrena. Aktivacija će biti tek od dopuštenog kruga.');});return;}
 if(b.dataset.regReject){const id=b.dataset.regReject,r=(state.admin.registrations||[]).find(x=>x.playerId===id);if(!confirm(`Odbiti registraciju za ${r?.name||'ovog igrača'}?`))return;await mutation(b,async()=>{await api(`/admin/registrations/${id}`,{action:'reject'});state.admin=await api('/admin/panel');renderAdmin();toast('Registracija je odbijena.');});return;}
 if(b.dataset.password){state.passwordTarget=state.admin.players.find(p=>p.id===b.dataset.password);$('#password-name').textContent=state.passwordTarget.name;$('#password-form').reset();$('#password-dialog').showModal();return;}
 if(b.dataset.fixture){const f=state.roundData.fixtures.find(x=>x.id===b.dataset.fixture),form=$('#fixture-form');for(const [k,v]of Object.entries({id:f.id,homeId:f.home_id,awayId:f.away_id,kickoff:datetimeValue(f.kickoff),homeScore:f.home_score??'',awayScore:f.away_score??'',status:f.status}))form.elements[k].value=v;$('#fixture-form-title').textContent='Uredi utakmicu';form.scrollIntoView({behavior:'smooth',block:'center'});return;}
 if(b.dataset.team){const t=state.teams.find(x=>x.id===b.dataset.team),f=$('#team-form');for(const [k,v]of Object.entries({id:t.id,name:t.name,base:t.base,color:t.color,apiId:t.api_id??''}))f.elements[k].value=v;$('#team-form-title').textContent='Uredi klub';f.scrollIntoView({behavior:'smooth',block:'center'});return;}
 if(a==='admin-delete-pick'){
  const f=$('#admin-pick-form');if(!f)return;const playerId=f.elements.playerId.value,round=Number(f.elements.round.value),player=state.admin.players.find(p=>p.id===playerId),existing=adminPickEntry(playerId,round);if(!existing){toast('Ovaj igrač nema pick u tom kolu.');return;}
  if(!confirm(`Obrisati pick ${player?.name||'igrača'} za ${round}. kolo (${existing.team_name}${existing.is_double?' + DOUBLE':''})?`))return;
  await mutation(b,async()=>{await api('/admin/picks/delete',{playerId,round});state.admin.picks=state.admin.picks.filter(p=>!(p.player_id===playerId&&Number(p.round_no)===round));renderAdmin();toast('Pick je obrisan.');});return;
 }
 await mutation(b,async()=>{
  if(b.dataset.pay){const p=state.admin.players.find(p=>p.id===b.dataset.pay),c=Number(b.dataset.payCycle),next=p.payments[c]===true?false:p.payments[c]===false?null:true;await api(`/admin/players/${p.id}/payment`,{cycle:c,paid:next});p.payments[c]=next;if(p.id===state.boot.user.id){const old=state.boot.payments.find(x=>x.cycle===c);if(old)old.paid=next===null?null:Number(next);else state.boot.payments.push({cycle:c,paid:next===null?null:Number(next)});nav();}renderAdmin();toast('Placanje spremljeno.');}
  if(b.dataset.active){const p=state.admin.players.find(p=>p.id===b.dataset.active),active=!p.active;if(!confirm(`${active?'Aktivirati':'Deaktivirati'} ${p.name}? Rezultati ostaju sacuvani.`))return;await api(`/admin/players/${p.id}/active`,{active});p.active=Number(active);renderAdmin();toast('Status spremljen.');}
  if(a==='toggle-picks'){const enabled=state.admin.settings.picks_enabled!=='1';if(!confirm(enabled?'Omoguciti odabire u produkcijskoj bazi?':'Zaustaviti spremanje odabira?'))return;await api('/admin/settings',{picksEnabled:enabled});state.admin.settings.picks_enabled=enabled?'1':'0';state.boot.settings.picks_enabled=enabled?'1':'0';nav();renderAdmin();toast('Postavka spremljena.');}
  if(a==='sync'){toast('Dohvacam nogometni API...');const d=await api('/admin/sync',{});toast(`Spremljeno: ${d.fixtures} utakmica.`);state.boot=await api('/bootstrap');load('admin');}
  if(a==='espn-test'){toast('Testiram ESPN iz Cloudflare Workera...');const d=await api('/admin/espn-test',{});toast(`ESPN radi · dohvaćeno događaja: ${d.events}.`);}
  if(a==='push-diagnostics'){toast('Provjeravam OneSignal pretplate...');const d=await api('/admin/push-diagnostics');state.pushDiagnostics=d.rows||[];renderAdmin();toast(`Aktivan push: ${d.withEnabledPush}/${d.activePlayers} igrača.`);}
  if(b.dataset.pushTestPlayer){const playerId=String(b.dataset.pushTestPlayer||'');const p=(state.admin?.players||[]).find(x=>String(x.id)===playerId);const d=await api('/admin/push-test-player',{playerId});toast(`Test push poslan: ${p?.name||d.player?.name||'igrač'}.`);}
  if(a==='push-test'){await api('/admin/push-test',{});toast('Test push je poslan na tvoj račun.');}
  if(a==='recalculate'){if(!confirm(`Zamijeniti sacuvane povijesne bodove kola ${state.round} novim izracunom iz rasporeda? Prvo napravi backup.`))return;await api(`/admin/rounds/${state.round}/recalculate`,{confirm:true});toast('Bodovi sada koriste novi izracun.');}
 });
});
document.addEventListener('submit',e=>{
 const f=e.target;if(f.getAttribute('id')==='login-form'||f.getAttribute('id')==='registration-form')return;if(!['pick-form','admin-pick-form','registration-settings-form','player-form','password-form','deadline-form','fixture-form','team-form'].includes(f.getAttribute('id')))return;e.preventDefault();const val=k=>f.elements[k].value;
 mutation(f.querySelector('[type=submit]')||f.querySelector('button'),async()=>{
  if(f.getAttribute('id')==='pick-form'){if(!val('team'))throw new Error('Odaberi ekipu.');await api('/pick',{round:state.round,teamId:val('team'),double:f.elements.double.checked});state.editingPick=null;toast('Pick je spremljen i zaključan. Za novu izmjenu prvo klikni PROMIJENI PICK.');await load('round');}
  if(f.getAttribute('id')==='admin-pick-form'){
   const playerId=val('playerId'),round=Number(val('round')),teamId=val('teamId');if(!teamId)throw new Error('Odaberi ekipu.');
   const d=await api('/admin/picks',{playerId,round,teamId,double:f.elements.double.checked});
   const i=state.admin.picks.findIndex(p=>p.player_id===playerId&&Number(p.round_no)===round);if(i>=0)state.admin.picks[i]=d.pick;else state.admin.picks.push(d.pick);
   state.adminPickPlayerId=playerId;state.adminPickRound=round;renderAdmin();toast('Pick igrača je ispravljen.');
  }
  if(f.getAttribute('id')==='registration-settings-form'){const d=await api('/admin/settings',{registrationOpen:val('registrationOpen')==='1',maxPlayers:Number(val('maxPlayers'))});state.admin.settings.registration_open=d.registration.open?'1':'0';state.admin.settings.max_players=String(d.registration.maxPlayers);state.admin.registration=d.registration;renderAdmin();toast('Registracija i limit igrača su spremljeni.');}
  if(f.getAttribute('id')==='player-form'){await api('/admin/players',{name:val('name'),password:val('password')});state.admin=await api('/admin/panel');renderAdmin();toast('Igrac dodan.');}
  if(f.getAttribute('id')==='password-form'){const d=await api(`/admin/players/${state.passwordTarget.id}/password`,{password:val('password')});$('#password-dialog').close();toast('PIN promijenjen.');if(d.relogin)showLogin();}
  if(f.getAttribute('id')==='deadline-form'){await api(`/admin/rounds/${state.round}/deadline`,{deadline:Math.floor(new Date(val('deadline')).getTime()/1000),confirmReopen:f.elements.reopen.checked});state.boot=await api('/bootstrap');toast('Rok spremljen.');await load('system');}
  if(f.getAttribute('id')==='fixture-form'){await api('/admin/fixtures',{id:val('id')||undefined,round:state.round,homeId:val('homeId'),awayId:val('awayId'),kickoff:val('kickoff')?Math.floor(new Date(val('kickoff')).getTime()/1000):null,homeScore:val('homeScore')===''?null:Number(val('homeScore')),awayScore:val('awayScore')===''?null:Number(val('awayScore')),status:val('status')});toast('Utakmica spremljena.');await load('system');}
  if(f.getAttribute('id')==='team-form'){await api('/admin/teams',{id:val('id')||undefined,name:val('name'),base:Number(val('base')),color:val('color'),apiId:val('apiId')===''?null:Number(val('apiId'))});toast('Klub spremljen.');await load('system');}
 });
});
enter().catch(e=>{showLogin();if(!/Prijavi|Sesija/i.test(e.message))$('#login-error').innerHTML=`<div class="error">${esc(e.message)}</div>`;});
