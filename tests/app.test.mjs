import * as vm from 'node:vm';
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
check('Results identify the exact round where DOUBLE was used',async()=>{const x=await fresh();try{await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}});x.env.DB.sqlite.exec("UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1");const r=await x.call('/results?scope=1',{cookie:x.userCookie});assert.deepEqual(r.data.rows.find(p=>p.id===x.userId).doubleRounds,[{cycle:1,round:1,points:null,settled:false}]);}finally{x.env.DB.close();}});

check('Rank movement compares points strictly before the latest scoring round and preserves shared places',async()=>{const x=await fresh();try{
 const ids=['owner',x.userId];
 for(const name of ['Tie Player','Last Player']){
  const created=await x.call('/admin/players',{cookie:x.adminCookie,body:{name,password:USER_PASSWORD}});assert.equal(created.status,201);ids.push(created.data.player.id);
 }
 const insert=x.env.DB.sqlite.prepare('INSERT INTO picks(player_id,round_no,cycle,team_id,base,imported_points) VALUES(?,?,1,?,?,?)');
 for(const [i,id] of ids.entries())for(const [round,points] of [[1,[5,3,3,0][i]],[2,[0,4,2,5][i]],[3,null]])insert.run(id,round,'t'+round,round+1,points);
 let clock=Math.floor(Date.now()/1000);x.env.DB.sqlite.function('unixepoch',()=>clock);
 const deadline=clock+1;
 x.env.DB.sqlite.prepare('UPDATE rounds SET deadline=? WHERE number IN(1,3)').run(clock-1);
 x.env.DB.sqlite.prepare('UPDATE rounds SET deadline=? WHERE number=2').run(deadline);
 const get=async()=>{const r=await x.call('/results?scope=1',{cookie:x.userCookie});assert.equal(r.status,200);return r.data;};
 const places=data=>ids.map(id=>{const r=data.rows.find(p=>p.id===id);assert(!('previous_points' in r));assert(!('comparison_round' in r));return [r.points,r.place,r.previousPlace,r.placeChange];});
 let data=await get();
 assert.deepEqual(data.comparison,{round:1});
 assert.deepEqual(places(data),[[5,1,1,0],[3,2,1,-1],[3,2,1,-1],[0,4,1,-3]]);
 clock=deadline;
 data=await get();
 assert.deepEqual(data.comparison,{round:2});
 assert.deepEqual(places(data),[[5,2,1,-1],[7,1,2,1],[5,2,2,0],[5,2,4,2]]);
 x.env.DB.sqlite.prepare('UPDATE picks SET imported_points=2 WHERE player_id=? AND round_no=3').run(x.userId);
 data=await get();
 assert.deepEqual(data.comparison,{round:3});
 assert.deepEqual(places(data),[[5,2,2,0],[9,1,1,0],[5,2,2,0],[5,2,2,0]]);
}finally{x.env.DB.close();}});

check('Rank movement uses independent overall and cycle comparison periods',async()=>{const x=await fresh();try{
 const insert=x.env.DB.sqlite.prepare('INSERT INTO picks(player_id,round_no,cycle,team_id,base,imported_points) VALUES(?,?,?,?,2,?)');
 for(const [round,team,adminPoints,userPoints] of [[1,'t1',6,0],[11,'t1',0,4],[12,'t2',4,0]]){
  insert.run('owner',round,cycleFor(round),team,adminPoints);insert.run(x.userId,round,cycleFor(round),team,userPoints);
 }
 x.env.DB.sqlite.exec('UPDATE rounds SET deadline=unixepoch()-1 WHERE number IN(1,11,12)');
 const cases=[
  ['all',12,[[10,1,1,0],[4,2,2,0]]],
  ['1',1,[[6,1,1,0],[0,2,1,-1]]],
  ['2',12,[[4,1,2,1],[4,1,1,0]]],
  ['3',null,[[0,1,null,null],[0,1,null,null]]],
  ['4',null,[[0,1,null,null],[0,1,null,null]]]
 ];
 for(const [scope,round,expected] of cases){
  const r=await x.call('/results?scope='+scope,{cookie:x.userCookie});assert.equal(r.status,200);
  assert.deepEqual(r.data.comparison,round===null?null:{round},scope);
  assert.deepEqual(['owner',x.userId].map(id=>{const p=r.data.rows.find(p=>p.id===id);return [p.points,p.place,p.previousPlace,p.placeChange];}),expected,scope);
 }
}finally{x.env.DB.close();}});

check('Rank movement starts with published imported zero and follows live points without requiring settlement',async()=>{const x=await fresh();try{
 const insert=x.env.DB.sqlite.prepare('INSERT INTO picks(player_id,round_no,cycle,team_id,base) VALUES(?,?,1,?,?)');
 for(const [id,round,team,base] of [['owner',1,'t1',2],[x.userId,1,'t2',3],[x.userId,2,'t3',4],['owner',3,'t4',5],[x.userId,3,'t5',1]])insert.run(id,round,team,base);
 x.env.DB.sqlite.exec("UPDATE rounds SET deadline=unixepoch()-1 WHERE number IN(1,2);INSERT INTO fixtures(id,round_no,home_id,away_id,home_score,away_score,status) VALUES('f3',3,'t4','t5',2,0,'IN_PLAY')");
 const get=async()=>{const r=await x.call('/results',{cookie:x.userCookie});assert.equal(r.status,200);return r.data;};
 const places=data=>['owner',x.userId].map(id=>{const r=data.rows.find(p=>p.id===id);return [r.points,r.place,r.previousPlace,r.placeChange];});
 let data=await get();assert.equal(data.comparison,null);assert.deepEqual(places(data),[[0,1,null,null],[0,1,null,null]]);
 x.env.DB.sqlite.prepare('UPDATE picks SET imported_points=0 WHERE player_id=? AND round_no=2').run(x.userId);
 data=await get();assert.deepEqual(data.comparison,{round:2});assert.deepEqual(places(data),[[0,1,1,0],[0,1,1,0]]);
 x.env.DB.sqlite.prepare('UPDATE picks SET imported_points=5 WHERE player_id=? AND round_no=2').run(x.userId);
 data=await get();assert.deepEqual(data.comparison,{round:2});assert.deepEqual(places(data),[[0,2,1,-1],[5,1,1,0]]);
 x.env.DB.sqlite.exec('UPDATE rounds SET deadline=unixepoch()-1 WHERE number=3');
 data=await get();assert.deepEqual(data.comparison,{round:3});assert.deepEqual(places(data),[[5,1,2,1],[5,1,1,0]]);
 x.env.DB.sqlite.exec("UPDATE fixtures SET home_score=0,away_score=1 WHERE id='f3'");
 data=await get();assert.deepEqual(data.comparison,{round:3});assert.deepEqual(places(data),[[0,2,2,0],[7,1,1,0]]);
}finally{x.env.DB.close();}});

check('Rank movement excludes inactive players and unpublished scores without leaking pending DOUBLE choices',async()=>{const x=await fresh();try{
 const observer=await x.call('/admin/players',{cookie:x.adminCookie,body:{name:'Observer Player',password:USER_PASSWORD}});assert.equal(observer.status,201);
 const login=await x.call('/login',{body:{name:'Observer Player',password:USER_PASSWORD}});assert.equal(login.status,200);
 const inactive=await x.call('/admin/players',{cookie:x.adminCookie,body:{name:'Inactive Player',password:USER_PASSWORD}});assert.equal(inactive.status,201);
 const insert=x.env.DB.sqlite.prepare('INSERT INTO picks(player_id,round_no,cycle,team_id,base,is_double,imported_points) VALUES(?,?,?,?,2,?,?)');
 for(const [id,points] of [['owner',8],[x.userId,4]]){
  insert.run(id,1,1,'t1',0,points);insert.run(id,11,2,'t2',1,points*25);insert.run(id,20,3,'t3',1,points*50);
 }
 insert.run(inactive.data.player.id,1,1,'t1',0,99);insert.run(inactive.data.player.id,29,4,'t1',0,999);
 x.env.DB.sqlite.exec('UPDATE rounds SET deadline=unixepoch()-1 WHERE number IN(1,29);UPDATE rounds SET deadline=NULL WHERE number=20');
 assert.equal((await x.call(`/admin/players/${inactive.data.player.id}/active`,{cookie:x.adminCookie,body:{active:false}})).status,200);
 for(const [cookie,viewerId] of [[x.adminCookie,'owner'],[x.userCookie,x.userId],[login.cookie,observer.data.player.id]])for(const scope of ['all','2','3','4']){
  const r=await x.call('/results?scope='+scope,{cookie});assert.equal(r.status,200);assert.equal(r.data.rows.length,3);assert(!r.data.rows.some(p=>p.id===inactive.data.player.id));
  assert.deepEqual(r.data.comparison,scope==='all'?{round:1}:null);
  const expected=scope==='all'?[[8,1,1,0],[4,2,1,-1],[0,3,1,-2]]:[[0,1,null,null],[0,1,null,null],[0,1,null,null]];
  assert.deepEqual(['owner',x.userId,observer.data.player.id].map(id=>{const p=r.data.rows.find(p=>p.id===id);return [p.points,p.place,p.previousPlace,p.placeChange];}),expected);
  for(const id of ['owner',x.userId]){
   const own=id===viewerId;
   const pending=[{cycle:2,round:11,points:null,settled:false},{cycle:3,round:20,points:null,settled:false}].filter(p=>own&&(scope==='all'||String(p.cycle)===scope));
   const p=r.data.rows.find(p=>p.id===id);assert.deepEqual(p.doubleRounds,pending);assert.deepEqual(p.doubles,pending.map(p=>p.cycle));
  }
 }
}finally{x.env.DB.close();}});

check('DOUBLE outcome metadata uses each pick result and only settles final matches',async()=>{const x=await fresh();try{
 assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}})).status,200);
 assert.equal((await x.call('/pick',{cookie:x.userCookie,body:{round:2,teamId:'t3',double:false}})).status,200);
 x.env.DB.sqlite.exec("INSERT INTO fixtures(id,round_no,home_id,away_id,home_score,away_score,status) VALUES('f2',2,'t3','t4',1,0,'FINISHED');UPDATE rounds SET deadline=unixepoch()-1 WHERE number IN(1,2)");
 const cases=[
  ['home win','t1','t2','FINISHED',2,1,4,true],
  ['home loss','t1','t2','FINISHED',0,1,0,true],
  ['home draw','t1','t2','FINISHED',1,1,0,true],
  ['away win','t2','t1','FINISHED',1,2,6,true],
  ['away draw','t2','t1','FINISHED',1,1,2,true],
  ['awarded win','t1','t2','AWARDED',2,0,4,true],
  ['live lead','t1','t2','IN_PLAY',2,1,4,false],
  ['live zero','t1','t2','PAUSED',0,1,0,false],
  ['missing scores','t1','t2','FINISHED',null,null,null,false],
  ['postponed','t1','t2','POSTPONED',null,null,null,false],
  ['suspended','t1','t2','SUSPENDED',2,1,null,false]
 ];
 for(const [name,home,away,status,hs,as,points,settled] of cases){
  x.env.DB.sqlite.prepare("UPDATE fixtures SET home_id=?,away_id=?,status=?,home_score=?,away_score=? WHERE id='f1'").run(home,away,status,hs,as);
  const round=await x.call('/round/1',{cookie:x.userCookie}),mine=await x.call('/mine',{cookie:x.userCookie}),results=await x.call('/results?scope=1',{cookie:x.userCookie}),admin=await x.call('/admin/panel',{cookie:x.adminCookie});
  for(const response of [round,mine,results,admin])assert.equal(response.status,200,name);
  const standings=results.data.rows.find(p=>p.id===x.userId);
  const picks=[round.data.myPick,round.data.players.find(p=>p.id===x.userId).pick,mine.data.rows.find(p=>p.round_no===1),standings.doubleRounds[0],admin.data.picks.find(p=>p.player_id===x.userId&&p.round_no===1)];
  for(const pick of picks){assert.equal(pick.points,points,name);assert.equal(Boolean(pick.settled),settled,name);}
  assert.equal(standings.points,(points??0)+4,name+' preserves unrelated round points');
 }
}finally{x.env.DB.close();}});

check('DOUBLE imported zero and positive points settle without a fixture',async()=>{const x=await fresh();try{
 await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}});
 x.env.DB.sqlite.exec("DELETE FROM fixtures WHERE id='f1';UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1");
 for(const points of [null,0,10]){
  x.env.DB.sqlite.prepare('UPDATE picks SET imported_points=? WHERE player_id=? AND round_no=1').run(points,x.userId);
  const round=await x.call('/round/1',{cookie:x.userCookie}),mine=await x.call('/mine',{cookie:x.userCookie}),results=await x.call('/results?scope=1',{cookie:x.userCookie}),admin=await x.call('/admin/panel',{cookie:x.adminCookie});
  for(const response of [round,mine,results,admin])assert.equal(response.status,200);
  const picks=[round.data.myPick,mine.data.rows[0],results.data.rows.find(p=>p.id===x.userId).doubleRounds[0],admin.data.picks.find(p=>p.player_id===x.userId)];
  for(const pick of picks){assert.equal(pick.points,points);assert.equal(Boolean(pick.settled),points!==null);}
 }
}finally{x.env.DB.close();}});

check('DOUBLE table metadata stays private to its owner before the deadline',async()=>{const x=await fresh();try{
 await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}});
 x.env.DB.sqlite.exec("UPDATE picks SET imported_points=8;UPDATE fixtures SET home_score=2,away_score=1,status='FINISHED' WHERE id='f1'");
 const own=await x.call('/results?scope=1',{cookie:x.userCookie}),other=await x.call('/results?scope=1',{cookie:x.adminCookie});
 assert.deepEqual(own.data.rows.find(p=>p.id===x.userId).doubleRounds,[{cycle:1,round:1,points:null,settled:false}]);
 assert.deepEqual(own.data.rows.find(p=>p.id===x.userId).doubles,[1]);
 assert.deepEqual(other.data.rows.find(p=>p.id===x.userId).doubleRounds,[]);
 assert.deepEqual(other.data.rows.find(p=>p.id===x.userId).doubles,[]);
 assert.equal((await x.call('/round/1',{cookie:x.adminCookie})).data.players.find(p=>p.id===x.userId).pick,null);
 const myPick=(await x.call('/round/1',{cookie:x.userCookie})).data.myPick;assert.equal(myPick.points,null);assert.equal(Boolean(myPick.settled),false);
 const mine=(await x.call('/mine',{cookie:x.userCookie})).data.rows[0];assert.equal(mine.points,null);assert.equal(Boolean(mine.settled),false);
 x.env.DB.sqlite.exec('UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1');
 assert.deepEqual((await x.call('/results?scope=1',{cookie:x.adminCookie})).data.rows.find(p=>p.id===x.userId).doubleRounds,[{cycle:1,round:1,points:8,settled:true}]);
}finally{x.env.DB.close();}});

check('DOUBLE table markers are private until the deadline while past rounds stay public',async()=>{const x=await fresh();try{
 const created=await x.call('/admin/players',{cookie:x.adminCookie,body:{name:'Other Player',password:USER_PASSWORD}});assert.equal(created.status,201);
 const observer=await x.call('/login',{body:{name:'Other Player',password:USER_PASSWORD}});assert.equal(observer.status,200);
 for(const [cookie,round,teamId] of [[x.userCookie,1,'t1'],[x.userCookie,11,'t3'],[x.adminCookie,1,'t2'],[x.adminCookie,11,'t4']])assert.equal((await x.call('/pick',{cookie,body:{round,teamId,double:true}})).status,200);
 let clock=Math.floor(Date.now()/1000);const deadline=clock+1;
 x.env.DB.sqlite.function('unixepoch',()=>clock);
 x.env.DB.sqlite.prepare('UPDATE rounds SET deadline=? WHERE number=1').run(clock-100);
 x.env.DB.sqlite.prepare('UPDATE rounds SET deadline=? WHERE number=11').run(deadline);
 x.env.DB.sqlite.exec('UPDATE picks SET imported_points=CASE WHEN round_no=1 THEN 6 ELSE 8 END');
 const viewers=[[x.userCookie,x.userId],[observer.cookie,created.data.player.id],[x.adminCookie,'owner']];
 for(const [cookie,viewerId] of viewers){
  const all=await x.call('/results?scope=all',{cookie}),current=await x.call('/results?scope=2',{cookie});assert.equal(all.status,200);assert.equal(current.status,200);
  for(const id of [x.userId,'owner']){
   const past=all.data.rows.find(p=>p.id===id),pending=current.data.rows.find(p=>p.id===id);
   const privateDouble=id===viewerId?[{cycle:2,round:11,points:null,settled:false}]:[];
   assert.deepEqual(past.doubleRounds,[{cycle:1,round:1,points:6,settled:true},...privateDouble]);assert.deepEqual(past.doubles,id===viewerId?[1,2]:[1]);assert.equal(past.points,6);
   assert.deepEqual(pending.doubleRounds,privateDouble);assert.deepEqual(pending.doubles,id===viewerId?[2]:[]);assert.equal(pending.points,0);
  }
 }
 const privatePick=(await x.call('/round/11',{cookie:x.userCookie})).data.myPick;assert.equal(privatePick.is_double,1);
 const adminPicks=(await x.call('/admin/panel',{cookie:x.adminCookie})).data.picks;assert(adminPicks.some(p=>p.player_id===x.userId&&p.round_no===11&&p.is_double===1));
 clock=deadline;
 for(const [cookie] of viewers){
  const all=await x.call('/results?scope=all',{cookie}),current=await x.call('/results?scope=2',{cookie});assert.equal(all.status,200);assert.equal(current.status,200);
  for(const id of [x.userId,'owner']){
   const row=all.data.rows.find(p=>p.id===id),currentRow=current.data.rows.find(p=>p.id===id);
   assert.deepEqual(row.doubleRounds,[{cycle:1,round:1,points:6,settled:true},{cycle:2,round:11,points:8,settled:true}]);assert.deepEqual(row.doubles,[1,2]);assert.equal(row.points,14);
   assert.deepEqual(currentRow.doubleRounds,[{cycle:2,round:11,points:8,settled:true}]);assert.deepEqual(currentRow.doubles,[2]);
  }
 }
}finally{x.env.DB.close();}});

check('Missing deadline blocks editing but does not publish other players picks or DOUBLE markers',async()=>{const x=await fresh();try{
 await x.call('/pick',{cookie:x.userCookie,body:{round:1,teamId:'t1',double:true}});
 await x.call('/pick',{cookie:x.adminCookie,body:{round:1,teamId:'t2',double:true}});
 x.env.DB.sqlite.exec('UPDATE picks SET imported_points=8;UPDATE rounds SET deadline=NULL WHERE number=1');
 for(const [cookie,viewerId] of [[x.userCookie,x.userId],[x.adminCookie,'owner']]){
  const r=await x.call('/results?scope=1',{cookie});assert.equal(r.status,200);
  for(const id of [x.userId,'owner']){
   const row=r.data.rows.find(p=>p.id===id);assert.deepEqual(row.doubleRounds,id===viewerId?[{cycle:1,round:1,points:null,settled:false}]:[]);assert.deepEqual(row.doubles,id===viewerId?[1]:[]);assert.equal(row.points,0);
  }
  const round=await x.call('/round/1',{cookie});assert.equal(round.status,200);assert.equal(round.data.round.locked,true);assert.equal(round.data.round.revealed,false);assert.equal(round.data.doubleAvailable,false);
  for(const player of round.data.players){if(player.id===viewerId)assert.equal(player.pick.is_double,1);else assert.equal(player.pick,null);}
  assert.equal(round.data.myPick.is_double,1);assert.equal(round.data.myPick.points,null);
  assert.deepEqual((await x.call('/stats?scope=1',{cookie})).data.rows,[]);
 }
 const mine=(await x.call('/mine',{cookie:x.userCookie})).data.rows[0];assert.equal(mine.is_double,1);assert.equal(mine.points,null);
 const panel=await x.call('/admin/panel',{cookie:x.adminCookie});assert.equal(panel.data.picks.filter(p=>p.round_no===1&&p.is_double===1).length,2);
 x.env.DB.sqlite.exec('UPDATE rounds SET deadline=unixepoch()-1 WHERE number=1');
 const published=await x.call('/round/1',{cookie:x.userCookie});assert.equal(published.data.round.locked,true);assert.equal(published.data.round.revealed,true);assert(published.data.players.every(p=>p.pick?.is_double===1));
}finally{x.env.DB.close();}});
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
check('Push client uses OneSignal v16, logged-in player external ID and same-origin service worker',()=>{const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),push=fs.readFileSync(new URL('../public/js/push.js',import.meta.url),'utf8'),sw=fs.readFileSync(new URL('../public/OneSignalSDKWorker.js',import.meta.url),'utf8');assert(html.includes('OneSignalSDK.page.js'));assert(app.includes("getPlayerId:()=>state.boot?.user?.id||null"));assert(push.includes('os.login(playerId)'));assert(push.includes("serviceWorkerPath:'OneSignalSDKWorker.js'"));assert(sw.includes('OneSignalSDK.sw.js'));});
check('Per-player push test reads players from admin state and always defines playerId',()=>{const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert(app.includes("const playerId=String(b.dataset.pushTestPlayer||'')"));assert(app.includes("(state.admin?.players||[]).find"));assert(!app.includes("const p=players.find(x=>x.id===b.dataset.pushTestPlayer)"));});
check('Push cron baselines old events, sends one reminder and does not duplicate it',async()=>{const x=await fresh();const old=globalThis.fetch;let sent=[];try{x.env.ONESIGNAL_APP_ID='app-test';x.env.ONESIGNAL_API_KEY='key-test';globalThis.fetch=async(url,opts)=>{sent.push({url:String(url),body:JSON.parse(opts.body)});return Response.json({id:'msg-'+sent.length});};await (await import('../src/worker.js')).processPush(x.env);assert.equal(sent.length,0);x.env.DB.sqlite.exec("UPDATE rounds SET deadline=unixepoch()+1000 WHERE number=1");await (await import('../src/worker.js')).processPush(x.env);assert.equal(sent.length,1);assert.match(sent[0].body.headings.en,/Kolo 1/);assert(sent[0].body.include_aliases.external_id.includes(x.userId));await (await import('../src/worker.js')).processPush(x.env);assert.equal(sent.length,1);}finally{globalThis.fetch=old;x.env.DB.close();}});


check('OneSignal CSP allows the API script used by SDK sync and old logo preconnect is removed',()=>{const h=fs.readFileSync(new URL('../public/_headers',import.meta.url),'utf8'),html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');assert.match(h,/script-src[^;]*https:\/\/api\.onesignal\.com/);assert.match(h,/connect-src[^;]*https:\/\/api\.onesignal\.com/);assert(!html.includes('rel="preconnect" href="https://kzm-push-bridge.djerkic10.workers.dev"'));});
check('Push initialization has a timeout and logout never waits for OneSignal initialization',()=>{const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),push=fs.readFileSync(new URL('../public/js/push.js',import.meta.url),'utf8');assert(push.includes('OneSignal se nije učitao'));assert(push.includes('initPromise=null'));const logout=push.match(/function logout\(\)\{[\s\S]*?\n \}/)?.[0]||'';assert(!logout.includes('ready()'));assert(app.includes("if(a==='logout'){pushLogout();b.disabled=true;try{await api('/logout',{});"));const pushBranch=app.indexOf("if(a==='push')"),logoutBranch=app.indexOf("if(a==='logout')");assert(logoutBranch>=0&&logoutBranch<pushBranch);});

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

check('ESPN can finalize a match and close its live polling even when football-data is unavailable',async()=>{const x=await fresh();const old=globalThis.fetch;try{
 x.env.FOOTBALL_DATA_API_KEY='mock-key';
 x.env.DB.sqlite.exec("UPDATE fixtures SET api_id=99,kickoff=unixepoch()-60,status='IN_PLAY',home_score=1,away_score=1,manual_score=0 WHERE id='f1';INSERT INTO meta(key,value) VALUES('api_backoff',unixepoch()+3600) ON CONFLICT(key) DO UPDATE SET value=excluded.value;");
 globalThis.fetch=async url=>{assert(String(url).includes('site.api.espn.com'));return Response.json({events:[{competitions:[{competitors:[{homeAway:'home',score:'2',team:{displayName:'Klub 1'}},{homeAway:'away',score:'1',team:{displayName:'Klub 2'}}],status:{type:{name:'STATUS_END_PERIOD',state:'post'}}}]}]});};
 const r=await syncFootball(x.env,false);assert.equal(r.source,'ESPN');
 const row=x.env.DB.sqlite.prepare("SELECT home_score,away_score,status FROM fixtures WHERE id='f1'").get();assert.equal(row.home_score,2);assert.equal(row.away_score,1);assert.equal(row.status,'FINISHED');
 assert(x.env.DB.sqlite.prepare("SELECT value FROM meta WHERE key='live-terminal:f1'").get());
 const second=await syncFootball(x.env,false);assert.equal(second.skipped,true);assert.equal(second.mode,'idle');
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

check('Finished round labels every picked zero-point player as Pena kola or Pene kola with winner-style UI',()=>{
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert(app.includes('function roundZeroScorers(d)'));
 assert(app.includes("Number(x.pick.points)===0"));
 assert(app.includes("names.length===1?'Pena kola':'Pene kola'"));
 assert(app.includes('renderRoundPenas(d)'));
 assert(app.includes('<div class="round-top-scorer-icon">🫏</div>'));
 assert(app.includes('<div class="round-top-scorer-points">0<span>bodova</span></div>'));
});

check('Frontend auto refreshes visible data every 15 seconds and polls live sources only when needed',()=>{
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert(app.includes('function liveWindowOpen()'));assert(app.includes('setInterval(liveRefreshTick,15000)'));assert(app.includes("['round','results','mine','stats','standings','admin']"));assert(app.includes("if(adminRace||liveWindowOpen())"));assert(app.includes("api('/live/pulse',{})"));assert(app.includes("load(state.view,true)"));assert(app.includes('ESPN radi neovisno o football-data rate limitu'));
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

check('Push framework is modularized behind dedicated frontend and backend services',()=>{const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),worker=fs.readFileSync(new URL('../src/worker.js',import.meta.url),'utf8'),push=fs.readFileSync(new URL('../public/js/push.js',import.meta.url),'utf8'),oneSignal=fs.readFileSync(new URL('../src/services/onesignal.js',import.meta.url),'utf8');assert(app.includes("import {createPushManager} from './js/push.js'"));assert(worker.includes("from './services/onesignal.js'"));assert(worker.includes("from './db.js'"));assert(push.includes('export function createPushManager'));assert(oneSignal.includes('export async function pushSend'));});


check('Opposing club picks mark both sides only after the round is revealed',()=>{
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const start=app.indexOf('function opposingPickPlayerIds(d)');const end=app.indexOf('function renderRound(d)',start);
 assert(start>=0&&end>start);
 const classify=Function(app.slice(start,end)+'; return opposingPickPlayerIds')();
 const players=[{id:'a',pick:{team_id:'t1'}},{id:'b',pick:{team_id:'t2'}},{id:'c',pick:{team_id:'t1'}},{id:'d',pick:{team_id:'t3'}}];
 const fixtures=[{home_id:'t1',away_id:'t2'},{home_id:'t3',away_id:'t4'}];
 assert.deepEqual([...classify({round:{revealed:true},players,fixtures})].sort(),['a','b','c']);
 assert.deepEqual([...classify({round:{revealed:false},players,fixtures})],[]);
 assert.deepEqual([...classify({round:{revealed:true},players,fixtures:[]})],[]);
 assert(app.includes("opponents.has(x.id)?'opposing-pick':''"));
});

check('Opposing picks highlight only after revealing the round',()=>{
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const css=fs.readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
 const start=app.indexOf('function opposingPickPlayerIds(d){'),end=app.indexOf('function renderRound(d)',start);
 assert(start>=0&&end>start);
 const {runInNewContext}=vm;
 const fn=runInNewContext(app.slice(start,end)+';opposingPickPlayerIds');
 const d={round:{revealed:true},fixtures:[{home_id:'arsenal',away_id:'chelsea'},{home_id:'city',away_id:'villa'}],players:[
  {id:'a',pick:{team_id:'arsenal'}},{id:'b',pick:{team_id:'chelsea'}},{id:'c',pick:{team_id:'arsenal'}},
  {id:'d',pick:{team_id:'city'}},{id:'e',pick:{team_id:'other'}},{id:'f',pick:null}
 ]};
 assert.deepEqual([...fn(d)].sort(),['a','b','c']);
 d.round.revealed=false;
 assert.deepEqual([...fn(d)],[]);
 assert(app.includes('opposing-pick-label'));
 assert(css.includes('tr.me.opposing-pick td'));
});

check('Mobile tabs and overview cards use real logged-in data without altering scoring',()=>{
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const css=fs.readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
 for(const tab of ['round','results','mine','more'])assert(html.includes('data-mobile-tab="'+tab+'"'));
 assert(app.includes("function mobileRoundDashboard(d)"));
 assert(app.includes("table?.rows?.find(x=>x.id===state.boot.user.id)"));
 assert(app.includes("if(Number(d?.round?.number)!==Number(state.boot?.currentRound))return ''"));
 assert(app.includes("dashboard-deadline"));
 assert(app.includes("if(tab==='more'){setMenu("));
 assert(app.includes("state.scope='all';await load('results')"));
 assert(css.includes('@media(max-width:720px)'));
 assert(css.includes('.mobile-bottom-nav{position:fixed'));
 assert(css.includes(':root[data-theme="dark"] .mobile-bottom-nav'));
 assert(html.includes('/app.js?v=20261123-mobile1'));
});
