import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import worker,{processPush} from '../src/worker.js';import {fresh,rawSnapshot,ADMIN_PASSWORD,USER_PASSWORD} from './helpers.mjs';
import {scorePick,cycleFor,rank,normalize} from '../src/rules.js';import {passwordHash} from '../src/auth.js';import {prepareSnapshot} from '../scripts/prepare-data.mjs';import {mapMatches,syncFootball,shouldPollFixture,testEspnSource} from '../src/football.js';
const tests=[];const check=(name,fn)=>test(name,fn);
check('Scoring preserves home/away/draw/double rules',()=>{assert.equal(scorePick(3,true,2,1),3);assert.equal(scorePick(3,true,1,1),0);assert.equal(scorePick(3,true,0,1),0);assert.equal(scorePick(3,false,1,2),4);assert.equal(scorePick(3,false,1,1),1);assert.equal(scorePick(3,false,2,1),0);assert.equal(scorePick(3,false,1,2,true),8);assert.equal(scorePick(3,false,null,null),null);});
check('All cycle boundaries and invalid rounds',()=>{for(const [n,c] of [[1,1],[10,1],[11,2],[19,2],[20,3],[28,3],[29,4],[38,4],[0,0],[39,0]])assert.equal(cycleFor(n),c);});
check('Equal scores share rank; unicode normalization is stable',()=>{assert.deepEqual(rank([{name:'B',points:3},{name:'A',points:3},{name:'C',points:1}]).map(x=>x.place),[1,1,3]);assert.equal(normalize('  Jerkic\u0301 '),normalize('Jerki\u0107'));});
check('Salted hashes differ; password and pepper matter',async()=>{const a=await passwordHash('password123','a'.repeat(64));const b=await passwordHash('password123','a'.repeat(64));assert.notEqual(a.password_hash,b.password_hash);assert.equal((await passwordHash('password123','a'.repeat(64),a.salt)).password_hash,a.password_hash);assert.notEqual((await passwordHash('wrong','a'.repeat(64),a.salt)).password_hash,a.password_hash);});
check('Setup is one time and health identifies new backend',async()=>{const x=await fresh(true);try{assert.equal((await x.call('/setup',{body:{key:x.env.BOOTSTRAP_KEY,name:'Again',password:ADMIN_PASSWORD}})).status,409);assert.equal((await x.call('/health')).data.database,'D1');}finally{x.env.DB.close();}});
check('Private endpoints require login',async()=>{const x=await fresh();try{for(const p of ['/bootstrap','/round/1','/results','/mine','/stats','/standings','/admin/panel'])assert.equal((await x.call(p)).status,401);}finally{x.env.DB.close();}});
check('Login player list is public and contains no credentials',async()=>{const x=await fresh();try{const r=await x.call('/login-players');assert.equal(r.status,200);assert(r.data.players.some(p=>p.name==='Demo Player'));assert(!/password|salt|hash/i.test(JSON.stringify(r.data)));}finally{x.env.DB.close();}});

check('Regular user cannot call admin methods',async()=>{const x=await fresh();try{assert.equal((await x.call('/admin/panel',{cookie:x.userCookie})).status,403);assert.equal((await x.call('/admin/settings',{cookie:x.userCookie,body:{picksEnabled:true}})).status,403);}finally{x.env.DB.close();}});
check('CSRF blocks foreign Origin and absent custom header',async()=>{const x=await fresh();try{assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:false},origin:'https://evil.test'})).status,403);assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:false},custom:false})).status,403);}finally{x.env.DB.close();}});
check('Save a pick, change same round and do not leak it to another user',async()=>{const x=await fresh();try{assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}})).status,200);let r=await x.call('/round/1',{cookie:x.adminCookie});assert.equal(r.data.players.find(p=>p.id===x.userId).chosen,true);assert.equal(r.data.players.find(p=>p.id===x.userId).pick,null);r=await x.call('/round/1',{cookie:x.userCookie});assert.equal(r.data.myPick.team_id,'t1');assert.equal(r.data.doubleAvailable,true);assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t2',double:false}})).status,200);}finally{x.env.DB.close();}});
check('Duplicate team and double are rejected across same cycle, allowed next cycle',async()=>{const x=await fresh();try{await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}});assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:2,teamId:'t1',double:false}})).status,409);assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:2,teamId:'t2',double:true}})).status,409);assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:11,teamId:'t1',double:true}})).status,200);}finally{x.env.DB.close();}});
check('Concurrent same-team requests cannot both succeed',async()=>{const x=await fresh();try{const r=await Promise.all([2,3].map(round=>x.call('/pick',{cookie:x.userCookie,body:{round,teamId:'t1',double:false}})));assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);}finally{x.env.DB.close();}});
check('Past deadline, null deadline and disabled picks fail closed',async()=>{const x=await fresh();try{for(const sql of ["UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1","UPDATE rounds SET deadline=NULL WHERE number=1"]){x.env.DB.sqlite.exec(sql);assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:false}})).status,423);}x.env.DB.sqlite.exec("UPDATE rounds SET deadline=unixepoch()+3600;UPDATE meta SET value='0' WHERE key='picks_enabled'");assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:false}})).status,423);}finally{x.env.DB.close();}});
check('Invalid round, boolean, unknown team are rejected',async()=>{const x=await fresh();try{for(const body of [{round:39,teamId:'t1',double:false},{round:1,teamId:'t1',double:'false'},{round:1,teamId:'bad',double:false}])assert.equal((await x.call('/pick',{cookie:x.userCookie,body})).status,400);}finally{x.env.DB.close();}});
check('Closed round reveals saved pick and computes points',async()=>{const x=await fresh();try{await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}});x.env.DB.sqlite.exec("UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1;UPDATE fixtures SET home_score=2,away_score=1,status='FINISHED' WHERE id='f1'");const r=await x.call('/round/1',{cookie:x.adminCookie});assert.equal(r.data.players.find(p=>p.id===x.userId).pick.points,4);const res=await x.call('/results?scope=1',{cookie:x.userCookie});assert.equal(res.data.rows.find(p=>p.id===x.userId).points,4);assert.equal((await x.call('/stats?scope=1',{cookie:x.userCookie})).data.rows[0].count,1);}finally{x.env.DB.close();}});
check('Results identify the exact round where DOUBLE was used',async()=>{const x=await fresh();try{await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}});x.env.DB.sqlite.exec("UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1");const r=await x.call('/results?scope=1',{cookie:x.userCookie});assert.deepEqual(r.data.rows.find(p=>p.id===x.userId).doubleRounds,[{cycle:1,round:1}]);}finally{x.env.DB.close();}});
check('Cycle winner is declared only after all ten matches of final round are finished',async()=>{const x=await fresh();try{let r=await x.call('/results?scope=1',{cookie:x.userCookie});assert.equal(r.data.cycleInfo.finished,false);const q=x.env.DB.sqlite.prepare("INSERT INTO fixtures(id,round_no,home_id,away_id,kickoff,home_score,away_score,status) VALUES(?,?,?,?,unixepoch()-100,1,0,'FINISHED')");for(let i=0;i<10;i++)q.run('end'+i,10,'t'+(i*2+1),'t'+(i*2+2));r=await x.call('/results?scope=1',{cookie:x.userCookie});assert.equal(r.data.cycleInfo.finished,true);assert(r.data.cycleInfo.winners.length>=1);}finally{x.env.DB.close();}});

check('Future picks do not influence results or club statistics',async()=>{const x=await fresh();try{await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}});x.env.DB.sqlite.exec("UPDATE picks SET imported_points=99");assert.equal((await x.call('/results',{cookie:x.adminCookie})).data.rows.find(p=>p.id===x.userId).points,0);assert.equal((await x.call('/stats',{cookie:x.adminCookie})).data.rows.length,0);}finally{x.env.DB.close();}});
check('Payments support true, false, null and preserve unrelated cycles',async()=>{const x=await fresh();try{for(const paid of [true,false,null]){const r=await x.call(`/admin/players/${x.userId}/payment`,{cookie:x.adminCookie,body:{cycle:3,paid}});assert.equal(r.status,200);assert.equal((await x.call('/admin/panel',{cookie:x.adminCookie})).data.players.find(p=>p.id===x.userId).payments[3],paid);}assert.equal(x.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM payments').get().n,1);}finally{x.env.DB.close();}});
check('Deactivation revokes sessions but preserves picks; admin cannot deactivate self',async()=>{const x=await fresh();try{await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:false}});assert.equal((await x.call(`/admin/players/${x.userId}/active`,{cookie:x.adminCookie,body:{active:false}})).status,200);assert.equal((await x.call('/bootstrap',{cookie:x.userCookie})).status,401);assert.equal(x.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM picks').get().n,1);assert.equal((await x.call('/admin/players/owner/active',{cookie:x.adminCookie,body:{active:false}})).status,400);}finally{x.env.DB.close();}});
check('Password change revokes old sessions and old password',async()=>{const x=await fresh();try{await x.call(`/admin/players/${x.userId}/password`,{cookie:x.adminCookie,body:{password:'A-new-password-2026'}});assert.equal((await x.call('/bootstrap',{cookie:x.userCookie})).status,401);assert.equal((await x.call('/login',{body:{name:'Demo Player',password:USER_PASSWORD}})).status,401);assert.equal((await x.call('/login',{body:{name:'Demo Player',password:'A-new-password-2026'}})).status,200);}finally{x.env.DB.close();}});
check('Logout invalidates server session',async()=>{const x=await fresh();try{assert.equal((await x.call('/logout',{cookie:x.userCookie,body:{}})).status,200);assert.equal((await x.call('/bootstrap',{cookie:x.userCookie})).status,401);}finally{x.env.DB.close();}});
check('Rate limit rejects repeated login attempts',async()=>{const x=await fresh(true);try{let r;for(let i=0;i<11;i++)r=await x.call('/login',{body:{name:'Nonexistent',password:'bad'}});assert.equal(r.status,429);}finally{x.env.DB.close();}});
check('Credentials never appear in normal API payloads',async()=>{const x=await fresh();try{for(const p of ['/bootstrap','/admin/panel','/results','/round/1']){const r=await x.call(p,{cookie:x.adminCookie});const t=JSON.stringify(r.data);assert(!t.includes('password_hash'));assert(!t.includes(ADMIN_PASSWORD));assert(!t.includes('salt'));}}finally{x.env.DB.close();}});
check('SQL injection in player names remains text',async()=>{const x=await fresh();try{const r=await x.call('/admin/players',{cookie:x.adminCookie,body:{name:"O'Brien'); DROP TABLE players;--",password:'new-password12'}});assert.equal(r.status,201);assert.equal(x.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM players').get().n,3);}finally{x.env.DB.close();}});
check('Bootstrap rounds include 4 and 5 plus all four cycles',async()=>{const x=await fresh();try{const r=await x.call('/bootstrap',{cookie:x.userCookie});assert.equal(r.data.rounds.length,38);assert.equal(r.data.cycles.length,4);for(const n of [4,5])assert.equal((await x.call('/round/'+n,{cookie:x.userCookie})).data.available.length,20);}finally{x.env.DB.close();}});
check('Deadline reopening needs explicit confirmation',async()=>{const x=await fresh();try{x.env.DB.sqlite.exec('UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1');const b={deadline:Math.floor(Date.now()/1000)+3600};assert.equal((await x.call('/admin/rounds/1/deadline',{cookie:x.adminCookie,body:b})).status,400);b.confirmReopen=true;assert.equal((await x.call('/admin/rounds/1/deadline',{cookie:x.adminCookie,body:b})).status,200);}finally{x.env.DB.close();}});
check('Prepared import preserves people, payments and historical scores atomically',async()=>{const x=await fresh(true);try{const prep=await prepareSnapshot(rawSnapshot(),{id:'owner',name:'Demo Admin'},x.env.AUTH_PEPPER);const r=await x.call('/admin/import',{cookie:x.adminCookie,body:prep.data});assert.equal(r.status,200);assert.equal(r.data.summary.picks,1);assert.equal(x.env.DB.sqlite.prepare('SELECT imported_points FROM picks').get().imported_points,4);assert.equal(x.env.DB.sqlite.prepare("SELECT value FROM meta WHERE key='picks_enabled'").get().value,'0');assert.equal((await x.call('/admin/import',{cookie:x.adminCookie,body:prep.data})).status,409);}finally{x.env.DB.close();}});
check('Invalid import changes nothing',async()=>{const x=await fresh(true);try{const prep=await prepareSnapshot(rawSnapshot(),{id:'owner',name:'Demo Admin'},x.env.AUTH_PEPPER);prep.data.picks[0].team_id='unknown';assert.equal((await x.call('/admin/import',{cookie:x.adminCookie,body:prep.data})).status,400);assert.equal(x.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM teams').get().n,0);assert.equal(x.env.DB.sqlite.prepare("SELECT value FROM meta WHERE key='dataset_imported'").get().value,'0');}finally{x.env.DB.close();}});
check('Import cannot overwrite a non-empty database',async()=>{const x=await fresh();try{const prep=await prepareSnapshot(rawSnapshot(),{id:'owner',name:'Demo Admin'},x.env.AUTH_PEPPER);assert.equal((await x.call('/admin/import',{cookie:x.adminCookie,body:prep.data})).status,409);assert.equal(x.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM teams').get().n,20);assert.equal(x.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM import_history').get().n,0);}finally{x.env.DB.close();}});
check('Source duplicate club selections are rejected rather than silently discarded',async()=>{const raw=rawSnapshot();raw.rounds[1].picks=[{...raw.rounds[0].picks[0],double:false}];await assert.rejects(()=>prepareSnapshot(raw,{id:'owner',name:'Demo Admin'},'p'.repeat(64)),/dvaput/);});
check('Source score reconciliation reports mismatches',async()=>{const raw=rawSnapshot();raw.totals={'Demo Player':50};const p=await prepareSnapshot(raw,{id:'owner',name:'Demo Admin'},'p'.repeat(64));assert(p.warnings.some(s=>s.includes('Razlika')));});
check('API mapping refuses unknown clubs and accepts explicit IDs',()=>{const m=[{id:1,matchday:1,homeTeam:{id:10,name:'Unmatched A'},awayTeam:{id:20,name:'Unmatched B'},utcDate:'2026-09-20T14:00:00Z',status:'TIMED',score:{fullTime:{home:null,away:null}}}];assert.throws(()=>mapMatches(m,[]),/Nepovezani/);assert.equal(mapMatches(m,[{id:'a',name:'A',api_id:10},{id:'b',name:'B',api_id:20}]).fixtures.length,1);});
check('Manual football results and closed deadlines survive sync',async()=>{const x=await fresh();const old=globalThis.fetch;try{x.env.FOOTBALL_DATA_API_KEY='mock-key';x.env.DB.sqlite.exec("UPDATE teams SET api_id=CAST(substr(id,2) AS INTEGER);UPDATE fixtures SET home_score=3,away_score=1,status='FINISHED',manual_score=1;UPDATE rounds SET deadline=unixepoch()-100 WHERE number=1;");const deadline=x.env.DB.sqlite.prepare('SELECT deadline FROM rounds WHERE number=1').get().deadline;
 globalThis.fetch=async()=>Response.json({matches:[{id:100,matchday:1,homeTeam:{id:1},awayTeam:{id:2},utcDate:new Date(Date.now()+8000000).toISOString(),status:'TIMED',score:{fullTime:{home:null,away:null}}}]});
 await syncFootball(x.env,true);const f=x.env.DB.sqlite.prepare("SELECT * FROM fixtures WHERE id='f1'").get();assert.equal(f.home_score,3);assert.equal(f.status,'FINISHED');assert.equal(x.env.DB.sqlite.prepare('SELECT deadline FROM rounds WHERE number=1').get().deadline,deadline);
 }finally{globalThis.fetch=old;x.env.DB.close();}});
check('Fixture editor validates both scores',async()=>{const x=await fresh();try{assert.equal((await x.call('/admin/fixtures',{cookie:x.adminCookie,body:{round:2,homeId:'t1',awayId:'t2',homeScore:1,awayScore:null,kickoff:null,status:'FINISHED'}})).status,400);}finally{x.env.DB.close();}});
check('Wrong project binding is rejected',async()=>{const x=await fresh();try{x.env.PROJECT_ID='wrong';assert.equal((await x.call('/bootstrap',{cookie:x.adminCookie})).status,503);}finally{x.env.DB.close();}});
check('Runtime has no Apps Script dependency and no shipped private credentials',()=>{for(const name of ['../public/app.js','../src/worker.js']){const s=fs.readFileSync(new URL(name,import.meta.url),'utf8');assert(!/google\.script\.run|script\.google\.com|kzm-push-bridge/.test(s));assert(!/const\s+ADMIN_PIN\s*=/.test(s));}});
check('Pick menu is ordered by base points then original imported/source order',async()=>{const x=await fresh();try{const r=await x.call('/round/1',{cookie:x.userCookie});const ids=r.data.available.map(t=>t.id);const bases=r.data.available.map(t=>Number(t.base));for(let i=1;i<bases.length;i++)assert(bases[i]>=bases[i-1]);assert.deepEqual(ids.slice(0,4),['t5','t10','t15','t20']);assert.deepEqual(ids.slice(4,8),['t1','t6','t11','t16']);}finally{x.env.DB.close();}});
check('Frontend locks a saved pick until PROMIJENI PICK and shows its fixture below',()=>{const s=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert(s.includes('SPREMLJENI PICK'));assert(s.includes('data-action="change-pick"'));assert(s.includes('PROMIJENI PICK'));assert(s.includes('TVOJA UTAKMICA'));assert(s.includes('state.editingPick'));});
check('Push client uses OneSignal v16, logged-in player external ID and same-origin service worker',()=>{const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),sw=fs.readFileSync(new URL('../public/OneSignalSDKWorker.js',import.meta.url),'utf8');assert(html.includes('OneSignalSDK.page.js'));assert(app.includes('os.login(state.boot.user.id)'));assert(app.includes("serviceWorkerPath:'OneSignalSDKWorker.js'"));assert(sw.includes('OneSignalSDK.sw.js'));});
check('Push cron baselines old events, sends one reminder and does not duplicate it',async()=>{const x=await fresh();const old=globalThis.fetch;let sent=[];try{x.env.ONESIGNAL_APP_ID='app-test';x.env.ONESIGNAL_API_KEY='key-test';globalThis.fetch=async(url,opts)=>{sent.push({url:String(url),body:JSON.parse(opts.body)});return Response.json({id:'msg-'+sent.length});};await (await import('../src/worker.js')).processPush(x.env);assert.equal(sent.length,0);x.env.DB.sqlite.exec("UPDATE rounds SET deadline=unixepoch()+1000 WHERE number=1");await (await import('../src/worker.js')).processPush(x.env);assert.equal(sent.length,1);assert.match(sent[0].body.headings.en,/Kolo 1/);assert(sent[0].body.include_aliases.external_id.includes(x.userId));await (await import('../src/worker.js')).processPush(x.env);assert.equal(sent.length,1);}finally{globalThis.fetch=old;x.env.DB.close();}});


check('OneSignal CSP allows the API script used by SDK sync and old logo preconnect is removed',()=>{const h=fs.readFileSync(new URL('../public/_headers',import.meta.url),'utf8'),html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');assert.match(h,/script-src[^;]*https:\/\/api\.onesignal\.com/);assert.match(h,/connect-src[^;]*https:\/\/api\.onesignal\.com/);assert(!html.includes('rel="preconnect" href="https://kzm-push-bridge.djerkic10.workers.dev"'));});
check('Push initialization has a timeout and logout never waits for OneSignal initialization',()=>{const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert(app.includes('OneSignal se nije učitao'));assert(app.includes('state.pushInit=null'));const logout=app.match(/function pushLogout\(\)\{[^}]+\}/)?.[0]||'';assert(!logout.includes('pushReady'));assert(app.includes("if(a==='logout'){pushLogout();b.disabled=true;try{await api('/logout',{});"));const pushBranch=app.indexOf("if(a==='push')"),logoutBranch=app.indexOf("if(a==='logout')");assert(logoutBranch>=0&&logoutBranch<pushBranch);});

check('Admin can correct a locked pick while normal player remains blocked',async()=>{const x=await fresh();try{
 await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}});
 x.env.DB.sqlite.exec("UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1;UPDATE meta SET value='0' WHERE key='picks_enabled'");
 assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t2',double:false}})).status,423);
 const r=await x.call('/admin/picks',{cookie:x.adminCookie,body:{playerId:x.userId,round:1,teamId:'t2',double:false}});
 assert.equal(r.status,200);assert.equal(r.data.pick.team_id,'t2');assert.equal(r.data.pick.is_double,0);
 const row=x.env.DB.sqlite.prepare('SELECT team_id,is_double,imported_points FROM picks WHERE player_id=? AND round_no=1').get(x.userId);assert.equal(row.team_id,'t2');assert.equal(row.is_double,0);assert.equal(row.imported_points,null);
 assert.equal(x.env.DB.sqlite.prepare("SELECT value FROM meta WHERE key='importing'").get().value,'0');
 assert.equal(x.env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='admin-pick-correction'").get().n,1);
}finally{x.env.DB.close();}});
check('Admin pick correction still enforces one team and one DOUBLE per cycle',async()=>{const x=await fresh();try{
 assert.equal((await x.call('/admin/picks',{cookie:x.adminCookie,body:{playerId:x.userId,round:1,teamId:'t1',double:true}})).status,200);
 assert.equal((await x.call('/admin/picks',{cookie:x.adminCookie,body:{playerId:x.userId,round:2,teamId:'t1',double:false}})).status,409);
 assert.equal((await x.call('/admin/picks',{cookie:x.adminCookie,body:{playerId:x.userId,round:2,teamId:'t2',double:true}})).status,409);
 assert.equal(x.env.DB.sqlite.prepare("SELECT value FROM meta WHERE key='importing'").get().value,'0');
}finally{x.env.DB.close();}});
check('Admin can delete an erroneous pick and frontend exposes correction controls',async()=>{const x=await fresh();try{
 await x.call('/admin/picks',{cookie:x.adminCookie,body:{playerId:x.userId,round:4,teamId:'t3',double:false}});
 assert.equal((await x.call('/admin/picks/delete',{cookie:x.adminCookie,body:{playerId:x.userId,round:4}})).status,200);
 assert.equal(x.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM picks WHERE player_id=? AND round_no=4').get(x.userId).n,0);
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert(app.includes('Ispravi pick igrača'));assert(app.includes('SPREMI ISPRAVAK PICKA'));assert(app.includes("api('/admin/picks'"));assert(app.includes("api('/admin/picks/delete'"));
}finally{x.env.DB.close();}});

check('Public registration creates only a pending request for the next cycle and cannot log in',async()=>{const x=await fresh();try{
 const cfg=await x.call('/login-players');assert.equal(cfg.status,200);assert.equal(cfg.data.registration.open,true);assert.equal(cfg.data.registration.maxPlayers,40);
 const r=await x.call('/register',{body:{name:'Novi Igrac',password:'4321'}});assert.equal(r.status,201);assert.equal(r.data.status,'pending');assert.equal(r.data.eligibleCycle,2);
 const row=x.env.DB.sqlite.prepare("SELECT id,active FROM players WHERE name_key='novi igrac'").get();assert.equal(row.active,0);
 assert.equal((await x.call('/login',{body:{name:'Novi Igrac',password:'4321'}})).status,401);
 const list=await x.call('/login-players');assert(!list.data.players.some(p=>p.name==='Novi Igrac'));assert.equal(list.data.registration.pendingPlayers,1);assert.equal(list.data.registration.occupiedPlayers,2);assert.equal(list.data.registration.reservedPlayers,0);
 const panel=await x.call('/admin/panel',{cookie:x.adminCookie});const req=panel.data.registrations.find(z=>z.playerId===row.id);assert.equal(req.status,'pending');assert.equal(req.eligibleCycle,2);
 const results=await x.call('/results?scope=1',{cookie:x.userCookie});assert(!results.data.rows.some(p=>p.id===row.id));
}finally{x.env.DB.close();}});

check('Admin approval is mandatory and approved player activates only after previous cycle is finished',async()=>{const x=await fresh();try{
 let r=await x.call('/register',{body:{name:'Ceka Krug',password:'4321'}});const id=r.data.player.id;
 r=await x.call(`/admin/registrations/${id}`,{cookie:x.adminCookie,body:{action:'approve'}});assert.equal(r.status,200);assert.equal(r.data.registration.status,'approved');assert.equal(r.data.registration.active,false);
 assert.equal((await x.call('/login',{body:{name:'Ceka Krug',password:'4321'}})).status,401);
 assert.equal((await x.call(`/admin/players/${id}/active`,{cookie:x.adminCookie,body:{active:true}})).status,409);
 const q=x.env.DB.sqlite.prepare("INSERT INTO fixtures(id,round_no,home_id,away_id,kickoff,home_score,away_score,status) VALUES(?,?,?,?,unixepoch()-100,1,0,'FINISHED')");for(let i=0;i<10;i++)q.run('c1end'+i,10,'t'+(i*2+1),'t'+(i*2+2));
 const list=await x.call('/login-players');assert(list.data.players.some(p=>p.name==='Ceka Krug'));
 const login=await x.call('/login',{body:{name:'Ceka Krug',password:'4321'}});assert.equal(login.status,200);assert(login.cookie);
 const req=(await x.call('/admin/panel',{cookie:x.adminCookie})).data.registrations.find(z=>z.playerId===id);assert.equal(req.status,'active');assert.equal(req.active,true);
}finally{x.env.DB.close();}});

check('Pending request does not consume player limit; approval reserves a slot and rejection frees it',async()=>{const x=await fresh();try{
 await x.call('/admin/settings',{cookie:x.adminCookie,body:{registrationOpen:true,maxPlayers:3}});
 const r=await x.call('/register',{body:{name:'Bot Kandidat',password:'4321'}});const id=r.data.player.id;let cfg=await x.call('/login-players');assert.equal(cfg.data.registration.full,false);assert.equal(cfg.data.registration.occupiedPlayers,2);assert.equal(cfg.data.registration.pendingPlayers,1);
 const approved=await x.call(`/admin/registrations/${id}`,{cookie:x.adminCookie,body:{action:'approve'}});assert.equal(approved.status,200);assert.equal(approved.data.registration.status,'approved');cfg=await x.call('/login-players');assert.equal(cfg.data.registration.full,true);assert.equal(cfg.data.registration.reservedPlayers,1);
 const rejected=await x.call(`/admin/registrations/${id}`,{cookie:x.adminCookie,body:{action:'reject'}});assert.equal(rejected.status,200);assert.equal(rejected.data.registration.status,'rejected');assert.equal((await x.call('/login',{body:{name:'Bot Kandidat',password:'4321'}})).status,401);
 cfg=await x.call('/login-players');assert.equal(cfg.data.registration.full,false);assert.equal(cfg.data.registration.occupiedPlayers,2);
}finally{x.env.DB.close();}});

check('Admin can close registration and player limit counts pending or approved reservations',async()=>{const x=await fresh();try{
 let r=await x.call('/admin/settings',{cookie:x.adminCookie,body:{registrationOpen:false,maxPlayers:2}});assert.equal(r.status,200);assert.equal(r.data.registration.open,false);assert.equal(r.data.registration.maxPlayers,2);
 r=await x.call('/register',{body:{name:'Blokiran Igrac',password:'4321'}});assert.equal(r.status,403);
 r=await x.call('/admin/players',{cookie:x.adminCookie,body:{name:'Preko Limita',password:'4321'}});assert.equal(r.status,409);
 r=await x.call('/admin/settings',{cookie:x.adminCookie,body:{registrationOpen:true,maxPlayers:3}});assert.equal(r.status,200);
 r=await x.call('/register',{body:{name:'Treći Igrac',password:'4321'}});assert.equal(r.status,201);const id=r.data.player.id;
 let cfg=await x.call('/login-players');assert.equal(cfg.data.registration.full,false);assert.equal(cfg.data.registration.activePlayers,2);assert.equal(cfg.data.registration.pendingPlayers,1);assert.equal(cfg.data.registration.occupiedPlayers,2);
 r=await x.call(`/admin/registrations/${id}`,{cookie:x.adminCookie,body:{action:'approve'}});assert.equal(r.status,200);cfg=await x.call('/login-players');assert.equal(cfg.data.registration.full,true);assert.equal(cfg.data.registration.approvedWaiting,1);assert.equal(cfg.data.registration.occupiedPlayers,3);
 assert.equal((await x.call('/admin/settings',{cookie:x.adminCookie,body:{maxPlayers:2}})).status,400);
}finally{x.env.DB.close();}});

check('Registration UI exposes approval queue and does not auto-login a new request',()=>{const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert(html.includes('id="registration-form"'));assert(html.includes('POŠALJI ZAHTJEV'));assert(html.includes('mora odobriti administrator'));assert(app.includes('Zahtjevi za registraciju'));assert(app.includes('data-reg-approve'));assert(app.includes("api('/register'"));assert(!app.includes("await api('/register',{name,password});await api('/login'"));});


check('Live polling window starts at kickoff and can recover from stale terminal status',()=>{
 const now=1_800_000_000;
 assert.equal(shouldPollFixture({api_id:99,manual_score:0,kickoff:now-60,status:'SCHEDULED'},now),true);
 assert.equal(shouldPollFixture({api_id:null,manual_score:0,kickoff:now-60,status:'SCHEDULED'},now),true);
 assert.equal(shouldPollFixture({api_id:99,manual_score:0,kickoff:now+1,status:'SCHEDULED'},now),false);
 assert.equal(shouldPollFixture({api_id:99,manual_score:0,kickoff:now-60,status:'FINISHED'},now),true);
 assert.equal(shouldPollFixture({api_id:99,manual_score:1,kickoff:now-60,status:'IN_PLAY'},now),false);
 assert.equal(shouldPollFixture({api_id:99,manual_score:0,kickoff:now-(4*60*60+1),status:'IN_PLAY'},now),false);
});

check('Automatic football sync makes zero API calls when no match has started',async()=>{const x=await fresh();const old=globalThis.fetch;let calls=0;try{
 x.env.FOOTBALL_DATA_API_KEY='mock-key';
 x.env.DB.sqlite.exec("UPDATE teams SET api_id=CAST(substr(id,2) AS INTEGER);UPDATE fixtures SET api_id=99,kickoff=unixepoch()+3600,status='SCHEDULED',manual_score=0 WHERE id='f1';");
 globalThis.fetch=async()=>{calls++;throw new Error('Football API must not be called before kickoff.');};
 const r=await syncFootball(x.env,false);assert.equal(r.skipped,true);assert.equal(r.mode,'idle');assert.equal(calls,0);
}finally{globalThis.fetch=old;x.env.DB.close();}});

check('Automatic football sync requests only started fixtures, compares ESPN, and stops after FINISHED',async()=>{const x=await fresh();const old=globalThis.fetch;const urls=[];try{
 x.env.FOOTBALL_DATA_API_KEY='mock-key';
 x.env.DB.sqlite.exec("UPDATE teams SET api_id=CAST(substr(id,2) AS INTEGER);UPDATE fixtures SET api_id=99,kickoff=unixepoch()-60,status='SCHEDULED',manual_score=0 WHERE id='f1';INSERT INTO fixtures(id,round_no,home_id,away_id,kickoff,status,api_id) VALUES('f2',2,'t3','t4',unixepoch()+3600,'SCHEDULED',100);");
 globalThis.fetch=async url=>{const u=String(url);urls.push(u);if(u.includes('site.api.espn.com'))return Response.json({events:[{competitions:[{competitors:[{homeAway:'home',score:'2',team:{displayName:'Klub 1'}},{homeAway:'away',score:'1',team:{displayName:'Klub 2'}}],status:{type:{name:'STATUS_FULL_TIME',state:'post',completed:true}}}]}]});return Response.json({matches:[{id:99,matchday:1,homeTeam:{id:1},awayTeam:{id:2},utcDate:new Date(Date.now()-60000).toISOString(),status:'FINISHED',score:{fullTime:{home:2,away:1}}}]});};
 let r=await syncFootball(x.env,false);assert.equal(r.mode,'live-active');assert.deepEqual(r.requestedIds,[99]);assert.equal(urls.length,2);assert(urls.some(u=>/\/v4\/matches\?ids=99/.test(u)));assert(urls.some(u=>u.includes('site.api.espn.com')));assert(!urls.join(' ').includes('ids=100'));
 const row=x.env.DB.sqlite.prepare("SELECT home_score,away_score,status FROM fixtures WHERE id='f1'").get();assert.equal(row.home_score,2);assert.equal(row.away_score,1);assert.equal(row.status,'FINISHED');
 const race=x.env.DB.sqlite.prepare("SELECT source,home_score,away_score FROM source_race WHERE fixture_id='f1' ORDER BY source").all();assert.deepEqual(race.map(z=>z.source),['ESPN','football-data.org']);assert(race.every(z=>z.home_score===2&&z.away_score===1));
 r=await syncFootball(x.env,false);assert.equal(r.skipped,true);assert(['idle','throttled'].includes(r.mode));assert.equal(urls.length,2);
}finally{globalThis.fetch=old;x.env.DB.close();}});


check('ESPN request uses browser-like headers so the live scoreboard is not rejected as a bot',async()=>{const x=await fresh();const old=globalThis.fetch;let seen;try{
 x.env.DB.sqlite.exec("UPDATE fixtures SET api_id=NULL,kickoff=unixepoch()-60,status='SCHEDULED',manual_score=0 WHERE id='f1';");
 globalThis.fetch=async(url,opts={})=>{seen={url:String(url),headers:new Headers(opts.headers||{})};return Response.json({events:[{competitions:[{competitors:[{homeAway:'home',score:'0',team:{displayName:'Klub 1'}},{homeAway:'away',score:'0',team:{displayName:'Klub 2'}}],status:{type:{name:'STATUS_IN_PROGRESS',state:'in',completed:false}}}]}]});};
 const r=await syncFootball(x.env,false);assert.equal(r.source,'ESPN');assert(seen.url.includes('site.api.espn.com'));assert.match(seen.headers.get('user-agent')||'',/Mozilla\/5\.0/);assert.equal(seen.headers.get('accept'),'application/json, text/plain, */*');assert.equal(seen.headers.get('referer'),'https://www.espn.com/');
}finally{globalThis.fetch=old;x.env.DB.close();}});



check('ESPN connectivity test performs one read-only request and reports event count',async()=>{const old=globalThis.fetch;let calls=0;try{
 globalThis.fetch=async(url,opts={})=>{calls++;assert(String(url).includes('site.api.espn.com'));const h=new Headers(opts.headers||{});assert.match(h.get('user-agent')||'',/Mozilla\/5\.0/);return Response.json({events:[{id:'one'},{id:'two'}]});};
 const r=await testEspnSource(1789830000);assert.equal(r.ok,true);assert.equal(r.source,'ESPN');assert.equal(r.events,2);assert.equal(calls,1);
}finally{globalThis.fetch=old;}});

check('Admin exposes a safe TEST ESPN endpoint and button without changing fixture results',async()=>{const x=await fresh();const old=globalThis.fetch;try{
 const before=x.env.DB.sqlite.prepare("SELECT home_score,away_score,status FROM fixtures WHERE id='f1'").get();
 globalThis.fetch=async url=>{assert(String(url).includes('site.api.espn.com'));return Response.json({events:[{id:'probe'}]});};
 assert.equal((await x.call('/admin/espn-test',{cookie:x.userCookie,body:{}})).status,403);
 const r=await x.call('/admin/espn-test',{cookie:x.adminCookie,body:{}});assert.equal(r.status,200);assert.equal(r.data.events,1);assert.equal(r.data.source,'ESPN');
 const after=x.env.DB.sqlite.prepare("SELECT home_score,away_score,status FROM fixtures WHERE id='f1'").get();assert.deepEqual(after,before);
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert(app.includes('TEST ESPN'));assert(app.includes("api('/admin/espn-test',{})"));
}finally{globalThis.fetch=old;x.env.DB.close();}});

check('Football-data backoff does not block ESPN live updates',async()=>{const x=await fresh();const old=globalThis.fetch;const urls=[];try{
 x.env.FOOTBALL_DATA_API_KEY='mock-key';
 x.env.DB.sqlite.exec("UPDATE fixtures SET api_id=99,kickoff=unixepoch()-60,status='SCHEDULED',manual_score=0 WHERE id='f1';INSERT INTO meta(key,value) VALUES('api_backoff',unixepoch()+3600) ON CONFLICT(key) DO UPDATE SET value=excluded.value;");
 globalThis.fetch=async url=>{const u=String(url);urls.push(u);assert(u.includes('site.api.espn.com'));return Response.json({events:[{competitions:[{competitors:[{homeAway:'home',score:'1',team:{displayName:'Klub 1'}},{homeAway:'away',score:'0',team:{displayName:'Klub 2'}}],status:{type:{name:'STATUS_IN_PROGRESS',state:'in',completed:false}}}]}]});};
 const r=await syncFootball(x.env,false);assert.equal(r.source,'ESPN');assert.equal(r.footballDataBackoff,true);assert.equal(urls.length,1);
 const row=x.env.DB.sqlite.prepare("SELECT home_score,away_score,status FROM fixtures WHERE id='f1'").get();assert.equal(row.home_score,1);assert.equal(row.away_score,0);assert.equal(row.status,'IN_PLAY');
}finally{globalThis.fetch=old;x.env.DB.close();}});

check('ESPN live fallback works even when a fixture has no football-data API id',async()=>{const x=await fresh();const old=globalThis.fetch;let calls=0;try{
 x.env.DB.sqlite.exec("UPDATE fixtures SET api_id=NULL,kickoff=unixepoch()-60,status='SCHEDULED',manual_score=0 WHERE id='f1';");
 globalThis.fetch=async url=>{calls++;assert(String(url).includes('site.api.espn.com'));return Response.json({events:[{competitions:[{competitors:[{homeAway:'home',score:'0',team:{displayName:'Klub 1'}},{homeAway:'away',score:'0',team:{displayName:'Klub 2'}}],status:{type:{name:'STATUS_IN_PROGRESS',state:'in',completed:false}}}]}]});};
 const r=await syncFootball(x.env,false);assert.equal(r.source,'ESPN');assert.deepEqual(r.requestedIds,[]);assert.equal(calls,1);
 const row=x.env.DB.sqlite.prepare("SELECT home_score,away_score,status FROM fixtures WHERE id='f1'").get();assert.equal(row.home_score,0);assert.equal(row.away_score,0);assert.equal(row.status,'IN_PLAY');
}finally{globalThis.fetch=old;x.env.DB.close();}});

check('Deploy switches Cloudflare cron to every minute without hardcoding project identifiers',()=>{
 const d=fs.readFileSync(new URL('../scripts/deploy.mjs',import.meta.url),'utf8');assert(d.includes("const wanted='* * * * *'"));assert(d.includes("saveJSON('wrangler.json',config)"));assert(!d.includes('kzm-novi-d9ad28'));
});

check('Frontend silently refreshes D1 every 20 seconds only while a match is in its live window',()=>{
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert(app.includes('function liveWindowOpen()'));assert(app.includes('setInterval(liveRefreshTick,20000)'));assert(app.includes("api('/live/pulse',{})"));assert(app.includes("load(state.view,true)"));assert(app.includes('ESPN radi neovisno o football-data rate limitu'));
});

check('Admin panel exposes source-race diagnostics and live fallback status',async()=>{const x=await fresh();try{
 const r=await x.call('/admin/panel',{cookie:x.adminCookie});assert.equal(r.status,200);assert(Array.isArray(r.data.sourceRace));assert.equal(typeof r.data.sourceRaceActive,'number');
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert(app.includes('Utrka izvora'));assert(app.includes('ESPN sada može ažurirati live rezultat u D1'));assert(app.includes('sourceRaceFootballError'));assert(app.includes('sourceRaceActive'));
}finally{x.env.DB.close();}});


check('Push follows the picked team for goals conceded goals and final points without duplicates',async()=>{const x=await fresh();const old=globalThis.fetch;const sent=[];try{
 x.env.ONESIGNAL_APP_ID='test-app';x.env.ONESIGNAL_API_KEY='test-key';
 await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}});
 x.env.DB.sqlite.exec("UPDATE rounds SET deadline=unixepoch()+86400 WHERE number<>1;UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1;UPDATE fixtures SET kickoff=unixepoch()-60,home_score=0,away_score=0,status='IN_PLAY' WHERE id='f1';");
 globalThis.fetch=async(url,opts={})=>{if(String(url).includes('api.onesignal.com')){sent.push(JSON.parse(opts.body));return Response.json({id:'push-'+sent.length});}throw new Error('Unexpected fetch '+url);};
 await processPush(x.env); // existing push types baseline
 await processPush(x.env); // match state baseline at 0:0
 assert.equal(sent.length,0);
 x.env.DB.sqlite.exec("UPDATE fixtures SET home_score=1,away_score=0,status='IN_PLAY' WHERE id='f1'");
 await processPush(x.env);assert.equal(sent.length,1);assert.match(sent[0].headings.en,/Klub 1 je zabio/);assert.match(sent[0].contents.en,/Klub 1 1:0 Klub 2/);assert.deepEqual(sent[0].include_aliases.external_id,[x.userId]);
 x.env.DB.sqlite.exec("UPDATE fixtures SET home_score=1,away_score=1,status='IN_PLAY' WHERE id='f1'");
 await processPush(x.env);assert.equal(sent.length,2);assert.match(sent[1].headings.en,/Klub 1 je primio gol/);assert.match(sent[1].contents.en,/1:1/);
 x.env.DB.sqlite.exec("UPDATE fixtures SET home_score=2,away_score=1,status='IN_PLAY' WHERE id='f1'");
 await processPush(x.env);assert.equal(sent.length,3);assert.match(sent[2].headings.en,/Klub 1 je zabio/);assert.match(sent[2].contents.en,/2:1/);
 x.env.DB.sqlite.exec("UPDATE fixtures SET status='FINISHED' WHERE id='f1'");
 await processPush(x.env);assert.equal(sent.length,4);assert.match(sent[3].headings.en,/Kraj: Klub 1.*pobjeda/);assert.match(sent[3].contents.en,/Osvojio si 4 boda/);
 await processPush(x.env);assert.equal(sent.length,4);
}finally{globalThis.fetch=old;x.env.DB.close();}});


check('Bootstrap marks every tied bottom player for wake-up message only after points exist',async()=>{const x=await fresh();try{
 x.env.DB.sqlite.exec("INSERT INTO picks(player_id,round_no,cycle,team_id,is_double,base) VALUES('owner',1,1,'t1',0,2);UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1;UPDATE fixtures SET home_score=1,away_score=0,status='FINISHED' WHERE id='f1'");
 const r=await x.call('/bootstrap',{cookie:x.userCookie});assert.equal(r.status,200);assert.equal(r.data.wakeUp.active,true);assert.equal(r.data.wakeUp.message,'Magarac jedan probudi se!');
 const a=await x.call('/bootstrap',{cookie:x.adminCookie});assert.equal(a.data.wakeUp.active,false);
}finally{x.env.DB.close();}});

check('Frontend calls live pulse as browser fallback and shows wake-up popup on every entry',()=>{const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');assert(app.includes("api('/live/pulse',{})"));assert(app.includes("showWakeUpPopup(state.boot.wakeUp.message"));assert(app.includes("Magarac jedan probudi se!"));assert(html.includes('wake-popup-host'));});
check('Admin can diagnose OneSignal subscriptions by player external ID without sending pushes',async()=>{const x=await fresh();const old=globalThis.fetch;try{x.env.ONESIGNAL_APP_ID='app-test';x.env.ONESIGNAL_API_KEY='key-test';globalThis.fetch=async url=>{const u=String(url);assert(u.includes('/users/by/external_id/'));if(u.endsWith('/'+x.userId))return Response.json({identity:{external_id:x.userId,onesignal_id:'os-user'},subscriptions:[{id:'sub-1',type:'ChromePush',enabled:true},{id:'sub-2',type:'Email',enabled:true}]});return new Response(JSON.stringify({errors:['not found']}),{status:404,headers:{'Content-Type':'application/json'}});};const r=await x.call('/admin/push-diagnostics',{cookie:x.adminCookie});assert.equal(r.status,200);const user=r.data.rows.find(v=>v.playerId===x.userId);assert.equal(user.enabledPush,1);assert.equal(user.totalPush,1);assert.equal(r.data.withEnabledPush,1);}finally{globalThis.fetch=old;x.env.DB.close();}});
check('Per-player push test reports missing valid OneSignal subscription instead of pretending success',async()=>{const x=await fresh();const old=globalThis.fetch;try{x.env.ONESIGNAL_APP_ID='app-test';x.env.ONESIGNAL_API_KEY='key-test';globalThis.fetch=async()=>Response.json({});const r=await x.call('/admin/push-test-player',{cookie:x.adminCookie,body:{playerId:x.userId}});assert.equal(r.status,409);assert.match(r.data.error,/nema aktivnu push pretplatu/i);}finally{globalThis.fetch=old;x.env.DB.close();}});
check('Frontend exposes admin push diagnostics and per-player test controls',()=>{const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert(app.includes('data-action="push-diagnostics"'));assert(app.includes('data-push-test-player'));assert(app.includes("api('/admin/push-diagnostics')"));assert(app.includes("api('/admin/push-test-player'"));});
