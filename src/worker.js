import {CYCLES,cycleFor,normalize,rank,AppError,assert,integer,cleanName,passwordValid,pinValid,scopeRange} from './rules.js';
import {authenticate,requireAdmin,login,passwordHash,randomHex,sha256,equal,rateLimit,sessionCookie,tokenFrom} from './auth.js';
import {importDataset} from './import-data.js';
import {syncFootball,sourceRaceData,testEspnSource} from './football.js';
import {stmt,all,first} from './db.js';
import {pushConfigured,pushSend,pushDiagnostics} from './services/onesignal.js';
const now=()=>Math.floor(Date.now()/1000);
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
async function audit(env,u,action,target){await stmt(env,'INSERT INTO audit(actor_id,action,target) VALUES(?,?,?)',u.id,action,String(target)).run();}
async function pushClaim(env,key){const r=await stmt(env,'INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)',key,'sending').run();return Number(r.meta?.changes||0)>0;}
async function pushDone(env,key,value='sent'){await stmt(env,'UPDATE meta SET value=? WHERE key=?',value,key).run();}
async function pushRelease(env,key){await stmt(env,"DELETE FROM meta WHERE key=? AND value='sending'",key).run();}
async function allActivePlayerIds(env){return (await all(env,'SELECT id FROM players WHERE active=1')).map(x=>x.id);}
async function roundFinished(env,n){const x=await first(env,"SELECT COUNT(*) AS total,SUM(CASE WHEN status IN('FINISHED','AWARDED') AND home_score IS NOT NULL AND away_score IS NOT NULL THEN 1 ELSE 0 END) AS done FROM fixtures WHERE round_no=?",n);return Number(x?.total||0)>=10&&Number(x?.done||0)===Number(x?.total||0);}
async function roundWinners(env,n){const rows=await all(env,'SELECT player_id,player_name,points FROM pick_scores WHERE round_no=? AND points IS NOT NULL',n);if(!rows.length)return null;const max=Math.max(...rows.map(x=>Number(x.points)));return {points:max,rows:rows.filter(x=>Number(x.points)===max)};}
async function cycleWinners(env,cycle){const c=scopeRange(String(cycle));const rows=rank(await all(env,`SELECT u.id,u.name,u.active,COALESCE(SUM(s.points),0) AS points FROM players u LEFT JOIN pick_scores s ON s.player_id=u.id AND s.round_no BETWEEN ? AND ? WHERE u.active=1 OR NOT EXISTS(SELECT 1 FROM meta m WHERE m.key='registration:request:'||u.id) GROUP BY u.id,u.name,u.active`,c.from,c.to));const win=rows.filter(x=>x.place===1);return win.length?{points:Number(win[0].points),rows:win}:null;}
async function pushEvent(env,key,ids,title,message){if(!ids.length){await stmt(env,"INSERT OR IGNORE INTO meta(key,value) VALUES(?,'none')",key).run();return;}if(!await pushClaim(env,key))return;try{await pushSend(env,ids,title,message,key);await pushDone(env,key);}catch(e){await pushRelease(env,key);throw e;}}
const matchStateKey=id=>'push:matchstate:'+String(id);
const scoreNo=v=>v===null||v===undefined||v===''?0:Number(v);
function pointsLabel(v){const n=Number(v||0);return n===1?'1 bod':(n>=2&&n<=4?n+' boda':n+' bodova');}
function matchScoreLine(f){return `${f.home_name} ${scoreNo(f.home_score)}:${scoreNo(f.away_score)} ${f.away_name}`;}
function selectedOutcome(f,teamId){const h=scoreNo(f.home_score),a=scoreNo(f.away_score),home=String(teamId)===String(f.home_id);if(h===a)return 'neriješeno';return (home?h>a:a>h)?'pobjeda':'poraz';}
async function matchPickers(env,f){return all(env,`SELECT s.player_id,s.team_id,s.team_name,s.is_double,s.base,s.points FROM pick_scores s JOIN players u ON u.id=s.player_id WHERE s.round_no=? AND s.team_id IN(?,?) AND u.active=1`,f.round_no,f.home_id,f.away_id);}
async function saveMatchPushState(env,key,state){await stmt(env,'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(state)).run();}
async function processMatchPush(env){
 const ts=now(),fixtures=await all(env,`SELECT f.id,f.round_no,f.home_id,f.away_id,f.kickoff,f.home_score,f.away_score,f.status,h.name AS home_name,a.name AS away_name FROM fixtures f JOIN teams h ON h.id=f.home_id JOIN teams a ON a.id=f.away_id WHERE f.kickoff IS NOT NULL AND f.kickoff<=? AND f.kickoff>=? AND f.status NOT IN('POSTPONED','SUSPENDED','CANCELLED') ORDER BY f.kickoff,f.id`,ts,ts-6*3600);
 for(const f of fixtures){
  const key=matchStateKey(f.id),row=await first(env,'SELECT value FROM meta WHERE key=?',key),current={h:scoreNo(f.home_score),a:scoreNo(f.away_score),status:String(f.status||'SCHEDULED').toUpperCase(),seq:0};
  if(!row){await saveMatchPushState(env,key,current);continue;}
  let prev;try{prev=JSON.parse(row.value||'{}');}catch{prev={};}
  prev={h:scoreNo(prev.h),a:scoreNo(prev.a),status:String(prev.status||'SCHEDULED').toUpperCase(),seq:Number(prev.seq||0)};
  const homeUp=current.h>prev.h,awayUp=current.a>prev.a,finalNow=['FINISHED','AWARDED'].includes(current.status),wasFinal=['FINISHED','AWARDED'].includes(prev.status);
  if(!homeUp&&!awayUp&&!(finalNow&&!wasFinal)){if(current.h!==prev.h||current.a!==prev.a||current.status!==prev.status)await saveMatchPushState(env,key,{...current,seq:prev.seq});continue;}
  const pickers=await matchPickers(env,f);let seq=prev.seq;
  if(homeUp){seq++;const own=pickers.filter(x=>String(x.team_id)===String(f.home_id)).map(x=>x.player_id),opp=pickers.filter(x=>String(x.team_id)===String(f.away_id)).map(x=>x.player_id);const line=matchScoreLine(f);await pushEvent(env,`push:matchgoal:${f.id}:${seq}:for-home`,own,'⚽ '+f.home_name+' je zabio!',line);await pushEvent(env,`push:matchgoal:${f.id}:${seq}:against-away`,opp,'🥅 '+f.away_name+' je primio gol',line);}
  if(awayUp){seq++;const own=pickers.filter(x=>String(x.team_id)===String(f.away_id)).map(x=>x.player_id),opp=pickers.filter(x=>String(x.team_id)===String(f.home_id)).map(x=>x.player_id);const line=matchScoreLine(f);await pushEvent(env,`push:matchgoal:${f.id}:${seq}:for-away`,own,'⚽ '+f.away_name+' je zabio!',line);await pushEvent(env,`push:matchgoal:${f.id}:${seq}:against-home`,opp,'🥅 '+f.home_name+' je primio gol',line);}
  if(finalNow&&!wasFinal){
   const groups=new Map();for(const x of pickers){const pts=Number(x.points??0),gkey=[x.team_id,pts].join('|');if(!groups.has(gkey))groups.set(gkey,{teamId:x.team_id,teamName:x.team_name,points:pts,ids:[]});groups.get(gkey).ids.push(x.player_id);}
   for(const g of groups.values()){const outcome=selectedOutcome(f,g.teamId),icon=outcome==='pobjeda'?'✅':outcome==='neriješeno'?'➖':'❌';await pushEvent(env,`push:matchfinal:${f.id}:${g.teamId}:${g.points}`,g.ids,`${icon} Kraj: ${g.teamName} – ${outcome}`,`${matchScoreLine(f)} · Osvojio si ${pointsLabel(g.points)}.`);}
  }
  await saveMatchPushState(env,key,{...current,seq});
 }
}
async function baselinePush(env){
 const statements=[];
 const rounds=await all(env,'SELECT number,deadline FROM rounds WHERE deadline IS NOT NULL AND deadline<=unixepoch()');
 for(const r of rounds)statements.push(stmt(env,"INSERT OR IGNORE INTO meta(key,value) VALUES(?,'baseline')",'push:lock:'+r.number));
 for(let n=1;n<=38;n++)if(await roundFinished(env,n))statements.push(stmt(env,"INSERT OR IGNORE INTO meta(key,value) VALUES(?,'baseline')",'push:winner:'+n));
 for(const [cycle,end] of [[1,10],[2,19],[3,28],[4,38]])if(await roundFinished(env,end))statements.push(stmt(env,"INSERT OR IGNORE INTO meta(key,value) VALUES(?,'baseline')",'push:cycle:'+cycle));
 statements.push(stmt(env,"INSERT INTO meta(key,value) VALUES('push_initialized','1') ON CONFLICT(key) DO UPDATE SET value='1'"));
 if(statements.length)await env.DB.batch(statements);
}
export async function processPush(env){
 if(!pushConfigured(env))return {ok:true,configured:false};
 const initialized=await first(env,"SELECT value FROM meta WHERE key='push_initialized'");if(!initialized){await baselinePush(env);return {ok:true,configured:true,baseline:true};}
 const allIds=await allActivePlayerIds(env),ts=now();
 await processMatchPush(env);
 const reminderRounds=await all(env,'SELECT number,deadline FROM rounds WHERE deadline>? AND deadline<=? ORDER BY deadline,number LIMIT 1',ts,ts+3*3600);
 for(const r of reminderRounds){const missing=(await all(env,'SELECT id FROM players WHERE active=1 AND id NOT IN(SELECT player_id FROM picks WHERE round_no=?)',r.number)).map(x=>x.id);await pushEvent(env,'push:reminder:'+r.number,missing,'⏰ Kolo '+r.number+' – odaberi pick','Još nisi spremio pick za '+r.number+'. kolo. Rok za odabir uskoro istječe.');}
 const locked=await all(env,"SELECT number FROM rounds WHERE deadline IS NOT NULL AND deadline<=unixepoch() AND NOT EXISTS(SELECT 1 FROM meta WHERE key='push:lock:'||rounds.number) ORDER BY number");
 for(const r of locked)await pushEvent(env,'push:lock:'+r.number,allIds,'🔒 '+r.number+'. kolo je zaključano','Odabiri su zaključani. Sada možeš vidjeti pickove ostalih igrača.');
 for(let n=1;n<=38;n++){
  if(!await roundFinished(env,n))continue;const key='push:winner:'+n;if(await first(env,'SELECT value FROM meta WHERE key=?',key))continue;const w=await roundWinners(env,n);if(!w)continue;const names=w.rows.map(x=>x.player_name),plural=names.length>1;await pushEvent(env,key,allIds,plural?'🏆 Pobjednici '+n+'. kola':'🏆 Pobjednik '+n+'. kola',(plural?names.join(', ')+' su pobjednici':names[0]+' je pobjednik')+' kola s '+w.points+' bodova.');
 }
 for(const [cycle,end] of [[1,10],[2,19],[3,28],[4,38]]){
  if(!await roundFinished(env,end))continue;const key='push:cycle:'+cycle;if(await first(env,'SELECT value FROM meta WHERE key=?',key))continue;const w=await cycleWinners(env,cycle);if(!w)continue;const names=w.rows.map(x=>x.name),plural=names.length>1;await pushEvent(env,key,allIds,plural?'🏆 Pobjednici '+cycle+'. kruga':'🏆 Pobjednik '+cycle+'. kruga',(plural?names.join(', ')+' su pobjednici':names[0]+' je pobjednik')+' '+cycle+'. kruga s '+w.points+' bodova.');
 }
 return {ok:true,configured:true};
}
const registrationRequestKey=id=>'registration:request:'+String(id);
const registrationSlotKey=id=>'registration:slot:'+String(id);
function parseRegistration(value,id=''){
 try{const x=JSON.parse(value||'{}');return {playerId:String(x.playerId||id),status:String(x.status||'pending'),eligibleCycle:x.eligibleCycle===null?null:Number(x.eligibleCycle||0)||null,requestedAt:Number(x.requestedAt||0)||null,approvedAt:Number(x.approvedAt||0)||null,rejectedAt:Number(x.rejectedAt||0)||null,activatedAt:Number(x.activatedAt||0)||null};}catch{return {playerId:String(id),status:'pending',eligibleCycle:null,requestedAt:null,approvedAt:null,rejectedAt:null,activatedAt:null};}
}
async function currentRegistrationCycle(env){
 const last=await first(env,'SELECT cycle FROM rounds WHERE deadline IS NOT NULL AND deadline<=unixepoch() ORDER BY number DESC LIMIT 1');
 return last?Number(last.cycle):1;
}
async function nextRegistrationCycle(env){const current=await currentRegistrationCycle(env);return current>=1&&current<4?current+1:null;}
async function registrationEligibleNow(env,cycle){
 if(cycle===1)return true;if(!Number.isInteger(Number(cycle))||Number(cycle)<2||Number(cycle)>4)return false;
 const prev=CYCLES.find(c=>c.id===Number(cycle)-1);return !!prev&&await roundFinished(env,prev.to);
}
async function registrationRequests(env){
 const rows=await all(env,"SELECT key,value FROM meta WHERE key LIKE 'registration:request:%' ORDER BY key");
 const players=await all(env,'SELECT id,name,active FROM players');const byId=new Map(players.map(p=>[p.id,p]));
 return rows.map(r=>{const id=String(r.key).slice('registration:request:'.length),req=parseRegistration(r.value,id),player=byId.get(id);return {...req,name:player?.name||'Nepoznat igrač',active:player?.active===1};}).filter(x=>byId.has(x.playerId));
}
async function activateApprovedRegistrations(env){
 const reqs=await registrationRequests(env),ts=now(),statements=[];let activated=0;
 for(const req of reqs){if(req.status!=='approved'||req.active||!req.eligibleCycle||!await registrationEligibleNow(env,req.eligibleCycle))continue;const next={...req,status:'active',activatedAt:ts};delete next.name;delete next.active;statements.push(stmt(env,'UPDATE players SET active=1 WHERE id=?',req.playerId),stmt(env,'DELETE FROM meta WHERE key=?',registrationSlotKey(req.playerId)),stmt(env,'UPDATE meta SET value=? WHERE key=?',JSON.stringify(next),registrationRequestKey(req.playerId)),stmt(env,"INSERT INTO audit(actor_id,action,target) VALUES(NULL,'registration-auto-activate',?)",req.playerId));activated++;}
 if(statements.length)await env.DB.batch(statements);return activated;
}
async function registrationState(env){
 const data=await env.DB.batch([
  stmt(env,"SELECT key,value FROM meta WHERE key IN('registration_open','max_players')"),
  stmt(env,'SELECT COUNT(*) AS n FROM players WHERE active=1'),
  stmt(env,"SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'registration:slot:%'"),
  stmt(env,"SELECT value FROM meta WHERE key LIKE 'registration:request:%'")
 ]);
 const settings=Object.fromEntries(data[0].results.map(x=>[x.key,x.value]));
 let maxPlayers=Number(settings.max_players??40);if(!Number.isInteger(maxPlayers)||maxPlayers<1||maxPlayers>200)maxPlayers=40;
 const activePlayers=Number(data[1].results?.[0]?.n||0),reservedPlayers=Number(data[2].results?.[0]?.n||0),occupiedPlayers=activePlayers+reservedPlayers,open=settings.registration_open===undefined?true:settings.registration_open==='1';
 const reqs=data[3].results.map((r,i)=>parseRegistration(r.value,String(i))),pendingPlayers=reqs.filter(x=>x.status==='pending').length,approvedWaiting=reqs.filter(x=>x.status==='approved').length;
 return {open,maxPlayers,activePlayers,reservedPlayers,occupiedPlayers,pendingPlayers,approvedWaiting,remaining:Math.max(0,maxPlayers-occupiedPlayers),full:occupiedPlayers>=maxPlayers};
}
async function loginPlayers(env){
 await activateApprovedRegistrations(env);
 const data=await env.DB.batch([stmt(env,'SELECT rowid AS source_order,id,name FROM players WHERE active=1 ORDER BY rowid'),stmt(env,"SELECT value FROM meta WHERE key='player_order'")]);
 let saved=[];try{saved=JSON.parse(data[1].results?.[0]?.value||'[]');if(!Array.isArray(saved))saved=[];}catch{saved=[];}
 const order=new Map(saved.map((name,i)=>[normalize(name),i]));
 const players=data[0].results.slice().sort((a,b)=>{const ai=order.has(normalize(a.name))?order.get(normalize(a.name)):Number.MAX_SAFE_INTEGER,bi=order.has(normalize(b.name))?order.get(normalize(b.name)):Number.MAX_SAFE_INTEGER;return ai-bi||Number(a.source_order||0)-Number(b.source_order||0);});
 return {ok:true,players:players.map(p=>({id:p.id,name:p.name})),registration:await registrationState(env)};
}
export async function bodyJson(request,max=24000){
 assert((request.headers.get('content-type')||'').includes('application/json'),'Potreban je JSON.',415);
 assert(Number(request.headers.get('content-length')||0)<=max,'Zahtjev je prevelik.',413);
 const reader=request.body?.getReader();assert(reader,'Prazan zahtjev.');let len=0;const chunks=[];
 while(true){const x=await reader.read();if(x.done)break;len+=x.value.length;if(len>max){await reader.cancel();throw new AppError(413,'Zahtjev je prevelik.');}chunks.push(x.value);}
 const bytes=new Uint8Array(len);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}
 try {const b=JSON.parse(new TextDecoder().decode(bytes));assert(b&&typeof b==='object'&&!Array.isArray(b),'Neispravan JSON.');return b;}catch(e){if(e instanceof AppError)throw e;throw new AppError(400,'Neispravan JSON.');}
}
async function bootstrap(env,u){
 const result=await env.DB.batch([
  stmt(env,'SELECT number,cycle,deadline FROM rounds ORDER BY number'),
  stmt(env,'SELECT id,name,base,color,api_id FROM teams ORDER BY name'),
  stmt(env,'SELECT cycle,paid FROM payments WHERE player_id=?',u.id),
  stmt(env,"SELECT key,value FROM meta WHERE key IN('picks_enabled','dataset_imported','last_sync','last_sync_error')")
 ]);
 const rounds=result[0].results.map(r=>({...r,locked:r.deadline===null||r.deadline<=now()}));
 const currentRound=rounds.find(r=>r.deadline!==null&&!r.locked)?.number||rounds.find(r=>r.deadline===null)?.number||38;
 const currentCycle=cycleFor(currentRound)||4,c=scopeRange(String(currentCycle));
 const bottom=await env.DB.batch([
  stmt(env,`SELECT p.id,p.name,COALESCE(SUM(s.points),0) AS points FROM players p LEFT JOIN pick_scores s ON s.player_id=p.id AND s.round_no BETWEEN ? AND ? WHERE p.active=1 GROUP BY p.id,p.name`,c.from,c.to),
  stmt(env,'SELECT COUNT(*) AS n FROM pick_scores WHERE round_no BETWEEN ? AND ? AND points IS NOT NULL',c.from,c.to)
 ]);
 const rows=bottom[0].results.map(x=>({...x,points:Number(x.points||0)})),hasScored=Number(bottom[1].results?.[0]?.n||0)>0,minPoints=rows.length?Math.min(...rows.map(x=>x.points)):null,mine=rows.find(x=>x.id===u.id);
 const wakeUp={active:!!(hasScored&&mine&&mine.points===minPoints),message:'Magarac jedan probudi se!',cycle:currentCycle,points:mine?.points??null};
 return {ok:true,user:{id:u.id,name:u.name,admin:u.is_admin===1},season:Number(env.SEASON||2026),cycles:CYCLES,rounds,teams:result[1].results,payments:result[2].results,settings:Object.fromEntries(result[3].results.map(x=>[x.key,x.value])),currentRound,wakeUp,serverTime:now()};
}
async function roundData(env,u,n){
 const r=await first(env,'SELECT * FROM rounds WHERE number=?',n);assert(r,'Kolo nije pronadjeno.',404);
 const locked=r.deadline===null||r.deadline<=now();
 const data=await env.DB.batch([
  stmt(env,'SELECT f.*,h.name AS home_name,a.name AS away_name FROM fixtures f JOIN teams h ON h.id=f.home_id JOIN teams a ON a.id=f.away_id WHERE round_no=? ORDER BY kickoff,f.id',n),
  stmt(env,'SELECT rowid AS source_order,id,name,active FROM players WHERE active=1 OR id IN(SELECT player_id FROM picks WHERE round_no=?) ORDER BY rowid',n),
  stmt(env,'SELECT player_id,team_id,team_name,is_double,base,points FROM pick_scores WHERE round_no=?',n),
  stmt(env,'SELECT t.id,t.name,t.base,t.color FROM teams t WHERE NOT EXISTS(SELECT 1 FROM picks p WHERE p.player_id=? AND p.cycle=? AND p.round_no<>? AND p.team_id=t.id) ORDER BY t.base,t.rowid',u.id,r.cycle,n),
  stmt(env,'SELECT COUNT(*) AS count FROM picks WHERE player_id=? AND cycle=? AND round_no<>? AND is_double=1',u.id,r.cycle,n),
  stmt(env,"SELECT value FROM meta WHERE key='player_order'")
 ]);
 const pmap=new Map(data[2].results.map(p=>[p.player_id,p]));
 let savedOrder=[];try{savedOrder=JSON.parse(data[5].results?.[0]?.value||'[]');if(!Array.isArray(savedOrder))savedOrder=[];}catch{savedOrder=[];}
 const orderMap=new Map(savedOrder.map((name,i)=>[normalize(name),i]));
 const sourcePlayers=data[1].results.slice().sort((a,b)=>{
  const ak=normalize(a.name),bk=normalize(b.name),ai=orderMap.has(ak)?orderMap.get(ak):Number.MAX_SAFE_INTEGER,bi=orderMap.has(bk)?orderMap.get(bk):Number.MAX_SAFE_INTEGER;
  return ai-bi||Number(a.source_order||0)-Number(b.source_order||0);
 });
 const players=sourcePlayers.filter(p=>locked||p.active===1).map(p=>{const pick=pmap.get(p.id);const visible=locked||p.id===u.id;return {id:p.id,name:p.name,chosen:!!pick,mine:p.id===u.id,pick:visible&&pick?pick:null};});
 return {ok:true,round:{...r,locked},fixtures:data[0].results,players,available:locked?[]:data[3].results,doubleAvailable:!locked&&data[4].results[0].count===0,myPick:pmap.get(u.id)||null,serverTime:now()};
}
async function resultsData(env,u,scope){
 const c=scopeRange(scope);
 const rows=await all(env,`SELECT u.id,u.name,u.active,COALESCE(SUM(s.points),0) AS points FROM players u
 LEFT JOIN pick_scores s ON s.player_id=u.id AND s.round_no BETWEEN ? AND ?
 WHERE u.active=1 OR NOT EXISTS(SELECT 1 FROM meta m WHERE m.key='registration:request:'||u.id)
 GROUP BY u.id,u.name,u.active`,c.from,c.to);
 const pays=await all(env,'SELECT player_id,cycle,paid FROM payments');
 const doubles=await all(env,'SELECT p.player_id,p.cycle,p.round_no FROM picks p JOIN rounds r ON r.number=p.round_no WHERE p.is_double=1 AND p.round_no BETWEEN ? AND ? AND(r.deadline<=unixepoch() OR p.player_id=?) ORDER BY p.round_no',c.from,c.to,u.id);
 const ranked=rank(rows.map(r=>({...r,payments:Object.fromEntries(pays.filter(p=>p.player_id===r.id).map(p=>[p.cycle,p.paid===null?null:!!p.paid])),doubles:doubles.filter(p=>p.player_id===r.id).map(p=>p.cycle),doubleRounds:doubles.filter(p=>p.player_id===r.id).map(p=>({cycle:p.cycle,round:p.round_no}))})));
 let cycleInfo=null;
 if(c.id){
  const endFixtures=await all(env,'SELECT status,home_score,away_score FROM fixtures WHERE round_no=?',c.to);
  const finished=endFixtures.length>=10&&endFixtures.every(f=>['FINISHED','AWARDED'].includes(String(f.status||'').toUpperCase())&&f.home_score!==null&&f.away_score!==null);
  cycleInfo={id:c.id,from:c.from,to:c.to,finished,winners:finished?ranked.filter(r=>r.place===1).map(r=>({id:r.id,name:r.name,points:r.points})):[]};
 }
 return {ok:true,scope:scope||'all',rows:ranked,cycleInfo};
}
async function adminPanel(env){
 await activateApprovedRegistrations(env);
 const race=await sourceRaceData(env);
 const data=await env.DB.batch([
  stmt(env,'SELECT id,name,active,is_admin FROM players ORDER BY name'),
  stmt(env,'SELECT player_id,cycle,paid FROM payments'),
  stmt(env,"SELECT key,value FROM meta WHERE key IN('picks_enabled','dataset_imported','last_sync','last_sync_error','last_sync_source','registration_open','max_players','api_backoff')"),
  stmt(env,'SELECT a.action,a.target,a.created_at,p.name AS actor FROM audit a LEFT JOIN players p ON p.id=a.actor_id ORDER BY a.id DESC LIMIT 30'),
  stmt(env,'SELECT p.player_id,p.round_no,p.team_id,p.is_double,t.name AS team_name FROM picks p JOIN teams t ON t.id=p.team_id ORDER BY p.round_no,p.player_id')
 ]);
 const settings=Object.fromEntries(data[2].results.map(x=>[x.key,x.value]));
 if(settings.registration_open===undefined)settings.registration_open='1';if(settings.max_players===undefined)settings.max_players='40';
 return {
  ok:true,
  players:data[0].results.map(p=>({...p,payments:Object.fromEntries(data[1].results.filter(x=>x.player_id===p.id).map(x=>[x.cycle,x.paid===null?null:!!x.paid]))})),
  registrations:await registrationRequests(env),
  registration:await registrationState(env),
  settings,
  audit:data[3].results,
  picks:data[4].results,
  sourceRace:race.rows,
  sourceRaceActive:race.active,
  sourceRaceEspnError:race.espnError,
  sourceRaceFootballError:race.footballError
 };
}
async function standings(env){
 const teams=await all(env,'SELECT id,name FROM teams ORDER BY name');
 const fixtures=await all(env,"SELECT * FROM fixtures WHERE status IN('FINISHED','AWARDED') AND home_score IS NOT NULL");
 const rows=teams.map(t=>({...t,played:0,wins:0,draws:0,losses:0,gf:0,ga:0,points:0})),map=new Map(rows.map(r=>[r.id,r]));
 for(const f of fixtures){const h=map.get(f.home_id),a=map.get(f.away_id);if(!h||!a)continue;h.played++;a.played++;h.gf+=f.home_score;h.ga+=f.away_score;a.gf+=f.away_score;a.ga+=f.home_score;if(f.home_score>f.away_score){h.wins++;a.losses++;h.points+=3;}else if(f.away_score>f.home_score){a.wins++;h.losses++;a.points+=3;}else{h.draws++;a.draws++;h.points++;a.points++;}}
 rows.sort((a,b)=>b.points-a.points||(b.gf-b.ga)-(a.gf-a.ga)||b.gf-a.gf||a.name.localeCompare(b.name));
 return {ok:true,rows:rows.map((r,i)=>({...r,place:i+1})),notice:'Iz spremljenih zavrsenih utakmica; sluzbeni dodatni kriteriji i kazne nisu primijenjeni.'};
}
export async function handle(request,env){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
 if(method==='OPTIONS')return new Response(null,{status:405});
 if(method!=='GET'){
  assert(request.headers.get('origin')===url.origin && request.headers.get('x-kzm-request')==='1','Zahtjev s druge stranice nije dopusten.',403);
 }
 assert(env.DB,'D1 baza nije povezana.',503);
 const project=await first(env,"SELECT value FROM meta WHERE key='project_id'");
 assert(!project||project.value===env.PROJECT_ID,'Pogresna baza za ovu instalaciju.',503);
 if(path==='/api/health'&&method==='GET')return json({ok:true,version:'1.1.0-live-fallback',database:'D1',separate:true});
 if(path==='/api/login-players'&&method==='GET')return json(await loginPlayers(env));
 if(path==='/api/setup'&&method==='POST'){
  const b=await bodyJson(request);await rateLimit(env,'setup',request.headers.get('CF-Connecting-IP')||'local',5);
  assert(env.BOOTSTRAP_KEY&&equal(String(b.key||''),env.BOOTSTRAP_KEY),'Neispravan kljuc za postavljanje.',403);
  const initialized=await first(env,"SELECT value FROM meta WHERE key='initialized'");assert(initialized.value==='0','Instalacija je vec postavljena.',409);
  const name=cleanName(b.name);passwordValid(b.password,true);const hash=await passwordHash(b.password,env.AUTH_PEPPER);
  await env.DB.batch([
   stmt(env,"INSERT INTO players(id,name,name_key,password_hash,salt,iterations,is_admin) SELECT 'owner',?,?,?,?,?,1 WHERE NOT EXISTS(SELECT 1 FROM players)",name,normalize(name),hash.password_hash,hash.salt,hash.iterations),
   stmt(env,"UPDATE meta SET value='1' WHERE key='initialized'"),
   stmt(env,"INSERT INTO meta(key,value) VALUES('project_id',?)",env.PROJECT_ID)
  ]);return json({ok:true},201);
 }
 if(path==='/api/login'&&method==='POST'){await activateApprovedRegistrations(env);const x=await login(request,env,await bodyJson(request));return json({ok:true,user:x.user},200,{'Set-Cookie':x.cookie});}
 if(path==='/api/register'&&method==='POST'){
  const b=await bodyJson(request);await rateLimit(env,'register-ip',request.headers.get('CF-Connecting-IP')||'local',8);
  const cfg=await registrationState(env);assert(cfg.open,'Registracija je trenutno zatvorena.',403);assert(!cfg.full,'Dosegnut je limit igraca ili zahtjeva na cekanju.',409);
  const name=cleanName(b.name);pinValid(b.password);const nameKey=normalize(name);assert(!(await first(env,'SELECT id FROM players WHERE name_key=?',nameKey)),'Igrac ili zahtjev s tim imenom vec postoji.',409);
  const hash=await passwordHash(b.password,env.AUTH_PEPPER),id=crypto.randomUUID(),eligibleCycle=await nextRegistrationCycle(env),ts=now();
  const requestData={playerId:id,status:'pending',eligibleCycle,requestedAt:ts,approvedAt:null,rejectedAt:null,activatedAt:null};
  await env.DB.batch([
   stmt(env,`INSERT INTO players(id,name,name_key,password_hash,salt,iterations,active)
    SELECT ?,?,?,?,?,?,0 WHERE (SELECT COUNT(*) FROM players WHERE active=1)+(SELECT COUNT(*) FROM meta WHERE key LIKE 'registration:slot:%') < ?`,id,name,nameKey,hash.password_hash,hash.salt,hash.iterations,cfg.maxPlayers),
   stmt(env,"INSERT INTO meta(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM players WHERE id=?)",registrationRequestKey(id),JSON.stringify(requestData),id),
   stmt(env,"INSERT INTO audit(actor_id,action,target) SELECT NULL,'self-register-pending',? WHERE EXISTS(SELECT 1 FROM players WHERE id=?)",id,id)
  ]);
  const created=await first(env,'SELECT id,name,active FROM players WHERE id=?',id);assert(created,'Dosegnut je limit igraca ili zahtjeva na cekanju.',409);
  return json({ok:true,player:{id:created.id,name:created.name},status:'pending',eligibleCycle,message:eligibleCycle?`Zahtjev je poslan. Administrator ga mora odobriti. Ako bude odobren, mozes igrati od ${eligibleCycle}. kruga.`:'Zahtjev je poslan. Administrator ga mora odobriti. Aktivacija je moguca tek u sljedecoj sezoni.'},201);
 }
 const u=await authenticate(request,env);
 if(path==='/api/push/config'&&method==='GET')return json({ok:true,configured:pushConfigured(env),appId:pushConfigured(env)?env.ONESIGNAL_APP_ID:null});
 if(path==='/api/logout'&&method==='POST'){await stmt(env,'DELETE FROM sessions WHERE token_hash=?',await sha256(tokenFrom(request))).run();return json({ok:true},200,{'Set-Cookie':sessionCookie('',request,0)});}
 if(path==='/api/bootstrap'&&method==='GET')return json(await bootstrap(env,u));
 if(path==='/api/live/pulse'&&method==='POST'){await bodyJson(request);try{const result=await syncFootball(env,false);if(pushConfigured(env)&&!result.skipped)try{await processPush(env);}catch{}return json(result);}catch(e){return json({ok:true,mode:'degraded',skipped:true,error:String(e.message||e).slice(0,300)});}}
 const roundMatch=path.match(/^\/api\/round\/(\d+)$/);
 if(roundMatch&&method==='GET')return json(await roundData(env,u,integer(Number(roundMatch[1]),1,38,'kolo')));
 if(path==='/api/pick'&&method==='POST'){
  const b=await bodyJson(request),n=integer(b.round,1,38,'kolo');assert(typeof b.double==='boolean','Neispravan DOUBLE.');
  const team=await first(env,'SELECT * FROM teams WHERE id=?',String(b.teamId));assert(team,'Ekipa ne postoji.');
  // UNIQUE constraints + database-time triggers arbitrate concurrent requests, not the browser.
  await env.DB.batch([
   stmt(env,`INSERT INTO picks(player_id,round_no,cycle,team_id,is_double,base) VALUES(?,?,?,?,?,?)
   ON CONFLICT(player_id,round_no) DO UPDATE SET team_id=excluded.team_id,is_double=excluded.is_double,base=excluded.base,imported_points=NULL,updated_at=unixepoch()`,u.id,n,cycleFor(n),team.id,b.double?1:0,team.base),
   stmt(env,"INSERT INTO audit(actor_id,action,target) VALUES(?,'pick',?)",u.id,String(n))
  ]);return json({ok:true});
 }
 if(path==='/api/results'&&method==='GET')return json(await resultsData(env,u,url.searchParams.get('scope')));
 if(path==='/api/stats'&&method==='GET'){const c=scopeRange(url.searchParams.get('scope'));return json({ok:true,rows:await all(env,'SELECT t.name,COUNT(*) AS count FROM picks p JOIN teams t ON t.id=p.team_id JOIN rounds r ON r.number=p.round_no WHERE p.round_no BETWEEN ? AND ? AND r.deadline<=unixepoch() GROUP BY t.id,t.name ORDER BY count DESC,t.name',c.from,c.to)});}
 if(path==='/api/mine'&&method==='GET')return json({ok:true,rows:await all(env,'SELECT round_no,cycle,team_name,is_double,base,points,home_score,away_score,match_status FROM pick_scores WHERE player_id=? ORDER BY round_no',u.id)});
 if(path==='/api/standings'&&method==='GET')return json(await standings(env));
 assert(path.startsWith('/api/admin/'),'Nepoznata adresa.',404);requireAdmin(u);
 if(path==='/api/admin/panel'&&method==='GET')return json(await adminPanel(env));
 if(path==='/api/admin/import-status'&&method==='GET'){const record=await env.DB.prepare("SELECT summary FROM import_history WHERE id='initial'").first();const f=await env.DB.prepare("SELECT value FROM meta WHERE key='import_fingerprint'").first();return json({ok:true,imported:!!record,fingerprint:f?.value||null,summary:record?JSON.parse(record.summary):null});}
 if(path==='/api/admin/import'&&method==='POST')return json(await importDataset(env,u,await bodyJson(request,1800000)));
 if(path==='/api/admin/sync'&&method==='POST'){await bodyJson(request);return json(await syncFootball(env,true));}
 if(path==='/api/admin/espn-test'&&method==='POST'){await bodyJson(request);return json(await testEspnSource());}
 if(path==='/api/admin/push-diagnostics'&&method==='GET')return json(await pushDiagnostics(env));
 if(path==='/api/admin/push-test-player'&&method==='POST'){const b=await bodyJson(request),target=await first(env,'SELECT id,name,active FROM players WHERE id=?',String(b.playerId||''));assert(target&&target.active,'Aktivni igrac nije pronadjen.',404);const sent=await pushSend(env,[target.id],'🔔 KZM test za '+target.name,'Ako vidis ovu poruku, tvoja KZM push pretplata radi.','push-test-player-'+target.id+'-'+Date.now());return json({ok:true,player:{id:target.id,name:target.name},messageId:sent.response?.id||null});}
 if(path==='/api/admin/push-test'&&method==='POST'){await bodyJson(request);assert(pushConfigured(env),'Push nije konfiguriran na ovom Workeru.',503);const sent=await pushSend(env,[u.id],'🔔 KZM test','Push obavijesti rade za tvoj KZM račun.','push-test-'+Date.now());return json({ok:true,messageId:sent.response?.id||null});}
 const registrationMatch=path.match(/^\/api\/admin\/registrations\/([a-zA-Z0-9-]+)$/);
 if(registrationMatch&&method==='POST'){
  const b=await bodyJson(request),action=String(b.action||'');assert(['approve','reject'].includes(action),'Neispravna odluka.');
  const target=await first(env,'SELECT id,name,active,is_admin FROM players WHERE id=?',registrationMatch[1]);assert(target&&!target.is_admin,'Zahtjev za registraciju ne postoji.',404);
  const row=await first(env,'SELECT value FROM meta WHERE key=?',registrationRequestKey(target.id));assert(row,'Zahtjev za registraciju ne postoji.',404);
  const req=parseRegistration(row.value,target.id),ts=now(),statements=[];
  if(action==='approve'){
   const hasSlot=!!(await first(env,'SELECT value FROM meta WHERE key=?',registrationSlotKey(target.id)));
   const eligible=!!req.eligibleCycle&&await registrationEligibleNow(env,req.eligibleCycle);
   if(!hasSlot){const cfg=await registrationState(env);assert(!cfg.full,'Dosegnut je limit igraca ili odobrenih mjesta.',409);if(!eligible)statements.push(stmt(env,"INSERT OR REPLACE INTO meta(key,value) VALUES(?,'1')",registrationSlotKey(target.id)));}
   const next={...req,status:eligible?'active':'approved',approvedAt:ts,rejectedAt:null,activatedAt:eligible?ts:null};
   statements.push(stmt(env,'UPDATE players SET active=? WHERE id=?',eligible?1:0,target.id));
   if(eligible)statements.push(stmt(env,'DELETE FROM meta WHERE key=?',registrationSlotKey(target.id)));
   statements.push(stmt(env,'UPDATE meta SET value=? WHERE key=?',JSON.stringify(next),registrationRequestKey(target.id)),stmt(env,"INSERT INTO audit(actor_id,action,target) VALUES(?,'registration-approve',?)",u.id,target.id));
   await env.DB.batch(statements);return json({ok:true,registration:{...next,name:target.name,active:eligible}});
  }
  const next={...req,status:'rejected',rejectedAt:ts,approvedAt:null,activatedAt:null};
  await env.DB.batch([stmt(env,'UPDATE players SET active=0 WHERE id=?',target.id),stmt(env,'DELETE FROM sessions WHERE player_id=?',target.id),stmt(env,'DELETE FROM meta WHERE key=?',registrationSlotKey(target.id)),stmt(env,'UPDATE meta SET value=? WHERE key=?',JSON.stringify(next),registrationRequestKey(target.id)),stmt(env,"INSERT INTO audit(actor_id,action,target) VALUES(?,'registration-reject',?)",u.id,target.id)]);
  return json({ok:true,registration:{...next,name:target.name,active:false}});
 }
 if(path==='/api/admin/players'&&method==='POST'){
  const b=await bodyJson(request),name=cleanName(b.name);pinValid(b.password);const cfg=await registrationState(env);assert(!cfg.full,'Dosegnut je limit igraca ili zahtjeva na cekanju.',409);
  const hash=await passwordHash(b.password,env.AUTH_PEPPER),id=crypto.randomUUID(),nameKey=normalize(name);
  await stmt(env,`INSERT INTO players(id,name,name_key,password_hash,salt,iterations)
   SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM players WHERE active=1)+(SELECT COUNT(*) FROM meta WHERE key LIKE 'registration:slot:%') < ?`,id,name,nameKey,hash.password_hash,hash.salt,hash.iterations,cfg.maxPlayers).run();
  const created=await first(env,'SELECT id FROM players WHERE id=?',id);assert(created,'Dosegnut je limit igraca ili zahtjeva na cekanju.',409);
  await stmt(env,"INSERT INTO audit(actor_id,action,target) VALUES(?,'player-add',?)",u.id,id).run();return json({ok:true,player:{id,name,active:1,is_admin:0,payments:{}}},201);
 }
 const pm=path.match(/^\/api\/admin\/players\/([a-zA-Z0-9-]+)\/(payment|active|password)$/);
 if(pm&&method==='POST'){
  const b=await bodyJson(request),target=await first(env,'SELECT id,name,is_admin,active FROM players WHERE id=?',pm[1]);assert(target,'Igrac ne postoji.',404);
  const statements=[];
  if(pm[2]==='payment') {integer(b.cycle,1,4,'krug');assert(b.paid===null||typeof b.paid==='boolean','Neispravan status placanja.');statements.push(stmt(env,'INSERT INTO payments(player_id,cycle,paid) VALUES(?,?,?) ON CONFLICT(player_id,cycle) DO UPDATE SET paid=excluded.paid,updated_at=unixepoch()',target.id,b.cycle,b.paid===null?null:Number(b.paid)));}
  if(pm[2]==='active'){
   assert(typeof b.active==='boolean','Neispravan status.');assert(!target.is_admin||b.active,'Administrator se ovdje ne moze deaktivirati.');
   const regRow=await first(env,'SELECT value FROM meta WHERE key=?',registrationRequestKey(target.id));const reg=regRow?parseRegistration(regRow.value,target.id):null;
   if(b.active&&!target.active){
    if(reg){assert(['approved','active'].includes(reg.status),'Registrirani igrač prvo mora dobiti administratorsko odobrenje.',409);assert(reg.eligibleCycle&&await registrationEligibleNow(env,reg.eligibleCycle),reg.eligibleCycle?`Igrač se može aktivirati tek od ${reg.eligibleCycle}. kruga.`:'Igrač se može aktivirati tek u sljedećoj sezoni.',409);const hasSlot=!!(await first(env,'SELECT value FROM meta WHERE key=?',registrationSlotKey(target.id)));if(!hasSlot){const cfg=await registrationState(env);assert(!cfg.full,'Dosegnut je limit igraca.',409);}}else{const cfg=await registrationState(env);assert(!cfg.full,'Dosegnut je limit igraca.',409);}
   }
   statements.push(stmt(env,'UPDATE players SET active=? WHERE id=?',Number(b.active),target.id));if(!b.active)statements.push(stmt(env,'DELETE FROM sessions WHERE player_id=?',target.id));
   if(reg&&b.active){const next={...reg,status:'active',activatedAt:reg.activatedAt||now()};statements.push(stmt(env,'DELETE FROM meta WHERE key=?',registrationSlotKey(target.id)),stmt(env,'UPDATE meta SET value=? WHERE key=?',JSON.stringify(next),registrationRequestKey(target.id)));}
  }
  if(pm[2]==='password'){pinValid(b.password);const h=await passwordHash(b.password,env.AUTH_PEPPER);statements.push(stmt(env,'UPDATE players SET password_hash=?,salt=?,iterations=? WHERE id=?',h.password_hash,h.salt,h.iterations,target.id),stmt(env,'DELETE FROM sessions WHERE player_id=?',target.id));}
  statements.push(stmt(env,'INSERT INTO audit(actor_id,action,target) VALUES(?,?,?)',u.id,'player-'+pm[2],target.id));await env.DB.batch(statements);
  return json({ok:true,relogin:pm[2]==='password'&&u.id===target.id});
 }
 if(path==='/api/admin/picks'&&method==='POST'){
  const b=await bodyJson(request),n=integer(Number(b.round),1,38,'kolo');assert(typeof b.double==='boolean','Neispravan DOUBLE.');
  const player=await first(env,'SELECT id,name,active FROM players WHERE id=?',String(b.playerId));assert(player,'Igrac ne postoji.',404);
  const regPending=!player.active&&await first(env,'SELECT value FROM meta WHERE key=?',registrationRequestKey(player.id));assert(!regPending,'Registrirani igrač još nije aktivan za igru.',409);
  const team=await first(env,'SELECT id,name,base FROM teams WHERE id=?',String(b.teamId));assert(team,'Ekipa ne postoji.',404);
  const importing=await first(env,"SELECT value FROM meta WHERE key='importing'");assert(importing?.value!=='1','Uvoz je trenutno u tijeku. Pokusaj ponovno nakon zavrsetka uvoza.',409);
  const before=await first(env,'SELECT p.team_id,p.is_double,t.name AS team_name FROM picks p JOIN teams t ON t.id=p.team_id WHERE p.player_id=? AND p.round_no=?',player.id,n);
  const target=JSON.stringify({playerId:player.id,player:player.name,round:n,before:before?{teamId:before.team_id,team:before.team_name,double:!!before.is_double}:null,after:{teamId:team.id,team:team.name,double:b.double}});
  await env.DB.batch([
   stmt(env,"UPDATE meta SET value='1' WHERE key='importing'"),
   stmt(env,`INSERT INTO picks(player_id,round_no,cycle,team_id,is_double,base,imported_points,updated_at) VALUES(?,?,?,?,?,?,NULL,unixepoch())
    ON CONFLICT(player_id,round_no) DO UPDATE SET cycle=excluded.cycle,team_id=excluded.team_id,is_double=excluded.is_double,base=excluded.base,imported_points=NULL,updated_at=unixepoch()`,player.id,n,cycleFor(n),team.id,b.double?1:0,team.base),
   stmt(env,"INSERT INTO audit(actor_id,action,target) VALUES(?,'admin-pick-correction',?)",u.id,target),
   stmt(env,"UPDATE meta SET value='0' WHERE key='importing'")
  ]);
  return json({ok:true,pick:{player_id:player.id,round_no:n,team_id:team.id,team_name:team.name,is_double:b.double?1:0}});
 }
 if(path==='/api/admin/picks/delete'&&method==='POST'){
  const b=await bodyJson(request),n=integer(Number(b.round),1,38,'kolo');
  const player=await first(env,'SELECT id,name FROM players WHERE id=?',String(b.playerId));assert(player,'Igrac ne postoji.',404);
  const before=await first(env,'SELECT p.team_id,p.is_double,t.name AS team_name FROM picks p JOIN teams t ON t.id=p.team_id WHERE p.player_id=? AND p.round_no=?',player.id,n);assert(before,'Pick ne postoji.',404);
  const target=JSON.stringify({playerId:player.id,player:player.name,round:n,before:{teamId:before.team_id,team:before.team_name,double:!!before.is_double},after:null});
  await env.DB.batch([
   stmt(env,'DELETE FROM picks WHERE player_id=? AND round_no=?',player.id,n),
   stmt(env,"INSERT INTO audit(actor_id,action,target) VALUES(?,'admin-pick-delete',?)",u.id,target)
  ]);
  return json({ok:true});
 }
 if(path==='/api/admin/settings'&&method==='POST'){
  const b=await bodyJson(request),statements=[];let changed=false;
  if(Object.hasOwn(b,'picksEnabled')){assert(typeof b.picksEnabled==='boolean','Neispravna postavka odabira.');statements.push(stmt(env,"INSERT INTO meta(key,value) VALUES('picks_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",b.picksEnabled?'1':'0'),stmt(env,"INSERT INTO audit(actor_id,action,target) VALUES(?,'picks-enabled',?)",u.id,String(b.picksEnabled)));changed=true;}
  if(Object.hasOwn(b,'registrationOpen')){assert(typeof b.registrationOpen==='boolean','Neispravna postavka registracije.');statements.push(stmt(env,"INSERT INTO meta(key,value) VALUES('registration_open',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",b.registrationOpen?'1':'0'),stmt(env,"INSERT INTO audit(actor_id,action,target) VALUES(?,'registration-open',?)",u.id,String(b.registrationOpen)));changed=true;}
  if(Object.hasOwn(b,'maxPlayers')){const maxPlayers=integer(Number(b.maxPlayers),1,200,'limit igraca'),cfg=await registrationState(env);assert(maxPlayers>=cfg.occupiedPlayers,'Limit ne moze biti manji od aktivnih igraca i zahtjeva koji cuvaju mjesto.');statements.push(stmt(env,"INSERT INTO meta(key,value) VALUES('max_players',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(maxPlayers)),stmt(env,"INSERT INTO audit(actor_id,action,target) VALUES(?,'max-players',?)",u.id,String(maxPlayers)));changed=true;}
  assert(changed,'Nema postavke za spremanje.');await env.DB.batch(statements);return json({ok:true,registration:await registrationState(env)});
 }
 if(path==='/api/admin/teams'&&method==='POST'){
  const b=await bodyJson(request),name=cleanName(b.name);integer(b.base,0,100,'osnovni bodovi');assert(/^#[0-9a-f]{6}$/i.test(b.color||''),'Neispravna boja.');
  const id=b.id?String(b.id):crypto.randomUUID();if(b.id)assert(await first(env,'SELECT id FROM teams WHERE id=?',id),'Klub ne postoji.');
  assert(b.apiId===null||Number.isInteger(b.apiId)&&b.apiId>0,'Neispravan API ID.');
  await stmt(env,'INSERT INTO teams(id,name,name_key,base,color,api_id) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,base=excluded.base,color=excluded.color,api_id=excluded.api_id',id,name,normalize(name),b.base,b.color,b.apiId).run();await audit(env,u,'team',id);return json({ok:true});
 }
 if(path==='/api/admin/teams'&&method==='GET')return json({ok:true,teams:await all(env,'SELECT * FROM teams ORDER BY name')});
 const rm=path.match(/^\/api\/admin\/rounds\/(\d+)\/(deadline|recalculate)$/);
 if(rm&&method==='POST'){
  const b=await bodyJson(request),n=integer(Number(rm[1]),1,38,'kolo');
  if(rm[2]==='deadline') {assert(b.deadline===null||Number.isInteger(b.deadline)&&b.deadline>0,'Neispravan rok.');const old=await first(env,'SELECT deadline FROM rounds WHERE number=?',n);assert(!(old.deadline&&old.deadline<=now()&&b.deadline>now())||b.confirmReopen===true,'Za ponovno otvaranje zakljucanog kola potrebna je posebna potvrda.');await stmt(env,'UPDATE rounds SET deadline=?,manual_deadline=1 WHERE number=?',b.deadline,n).run();}
  else {assert(b.confirm===true,'Potvrdi zamjenu uvezenih bodova novim izracunom.');await stmt(env,'UPDATE picks SET imported_points=NULL WHERE round_no=?',n).run();}
  await audit(env,u,'round-'+rm[2],n);return json({ok:true});
 }
 if(path==='/api/admin/fixtures'&&method==='POST'){
  const b=await bodyJson(request);integer(b.round,1,38,'kolo');assert(b.homeId!==b.awayId,'Klub ne moze igrati sam protiv sebe.');
  for(const id of [b.homeId,b.awayId])assert(await first(env,'SELECT id FROM teams WHERE id=?',String(id)),'Klub nije pronadjen.');
  assert(b.kickoff===null||Number.isInteger(b.kickoff)&&b.kickoff>0,'Neispravan pocetak utakmice.');
  assert((b.homeScore===null)===(b.awayScore===null),'Upisi oba gola ili nijedan.');if(b.homeScore!==null){integer(b.homeScore,0,99,'golovi');integer(b.awayScore,0,99,'golovi');}
  assert(['SCHEDULED','TIMED','IN_PLAY','PAUSED','FINISHED','POSTPONED','CANCELLED','SUSPENDED','AWARDED'].includes(b.status),'Neispravan status utakmice.');
  const id=b.id?String(b.id):crypto.randomUUID();if(b.id)assert(await first(env,'SELECT id FROM fixtures WHERE id=?',id),'Utakmica nije pronadjena.');
  const conflict=await first(env,'SELECT id FROM fixtures WHERE round_no=? AND id<>? AND(home_id IN(?,?) OR away_id IN(?,?))',b.round,id,b.homeId,b.awayId,b.homeId,b.awayId);
  assert(!conflict,'Klub vec ima utakmicu u ovom kolu. Dvostruko kolo zahtijeva dogovor pravila.');
  await stmt(env,'INSERT INTO fixtures(id,round_no,home_id,away_id,kickoff,home_score,away_score,status,manual_score) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET round_no=excluded.round_no,home_id=excluded.home_id,away_id=excluded.away_id,kickoff=excluded.kickoff,home_score=excluded.home_score,away_score=excluded.away_score,status=excluded.status,manual_score=1',id,b.round,b.homeId,b.awayId,b.kickoff,b.homeScore,b.awayScore,b.status).run();
  await audit(env,u,'fixture',id);return json({ok:true});
 }
 throw new AppError(404,'Nepoznata adresa.');
}
export default {
 async fetch(request,env){try{return await handle(request,env);}catch(e){let status=e.status||500,message=e.message||'';
 if(message.includes('one_double_per_cycle')||message.includes('picks.player_id, picks.cycle')&&!message.includes('team_id')){status=409;message='DOUBLE je vec iskoristen u ovom krugu.';}
 else if(message.includes('picks.player_id, picks.cycle, picks.team_id')){status=409;message='Tu ekipu si vec koristio u ovom krugu.';}
 else if(message.includes('ROUND_LOCKED')){status=423;message='Kolo je zakljucano ili nema postavljen rok.';}
 else if(message.includes('PICKS_DISABLED')){status=423;message='Odabiri su privremeno zaustavljeni.';}
 else if(message.includes('PLAYER_INACTIVE')){status=403;message='Racun je deaktiviran.';}
 else if(message.includes('UNIQUE constraint')){status=409;message='Zapis s tim nazivom ili oznakom vec postoji.';}
 else if(!e.status){message='Greska posluzitelja. Pokusaj ponovno; ako se ponavlja, provjeri konfiguraciju i D1.';}
 return json({ok:false,error:message},status);
 }},
 async scheduled(event,env,ctx){ctx.waitUntil((async()=>{
 await env.DB.batch([stmt(env,'DELETE FROM sessions WHERE expires_at<=unixepoch()'),stmt(env,'DELETE FROM rate_limits WHERE expires_at<=unixepoch()')]);
 try{await syncFootball(env,false);}catch{/* last_sync_error is persisted, no secrets in logs */}
 try{await activateApprovedRegistrations(env);}catch{/* odobrena registracija ce se ponovno provjeriti na sljedecem cron prolazu ili loginu */}
 if(pushConfigured(env))try{await processPush(env);}catch{/* push se ponavlja na sljedecem cron prolazu; kljucevi se ne ispisuju */}
 })());}
};
